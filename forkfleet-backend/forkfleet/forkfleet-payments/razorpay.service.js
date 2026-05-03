/**
 * ForkFleet — Razorpay Payment Service
 *
 * Handles:
 *   1. Creating Razorpay orders (before customer pays)
 *   2. Verifying payment signatures (after customer pays)
 *   3. Capturing payments manually if needed
 *   4. Split payouts to restaurants via Razorpay Route
 *   5. Refunds (full, partial, per-sub-order)
 *   6. Webhook signature validation
 */

const Razorpay  = require('razorpay');
const crypto    = require('crypto');
const db        = require('../db');
const { publishOrderEvent } = require('../db/redis');
const logger    = require('../utils/logger');

// ── Singleton client ──────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env');
    }
    _client = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _client;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_COMMISSION_PCT = parseFloat(process.env.PLATFORM_COMMISSION_PCT || '15') / 100;
const CURRENCY = 'INR';

// ════════════════════════════════════════════════════════════════════════════
// 1. CREATE RAZORPAY ORDER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a Razorpay order for a ForkFleet order.
 * Call this right after the DB order is created (still pending_payment).
 *
 * @param {string} orderId        - ForkFleet order UUID
 * @param {number} grandTotalPaise - Total in paise (₹1 = 100 paise)
 * @param {object} customerInfo   - { name, email, phone }
 * @returns {object} Razorpay order object + our payment record id
 */
async function createPaymentOrder(orderId, grandTotalPaise, customerInfo = {}) {
  const rzp = getClient();

  // Create Razorpay order
  const rzpOrder = await rzp.orders.create({
    amount:   grandTotalPaise,
    currency: CURRENCY,
    receipt:  orderId,            // maps back to our order
    notes: {
      forkfleet_order_id: orderId,
      customer_name:      customerInfo.name  || '',
      customer_email:     customerInfo.email || '',
    },
    partial_payment: false,
  });

  // Persist payment record in our DB
  const { rows: [payment] } = await db.query(
    `INSERT INTO payments
       (order_id, razorpay_order_id, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [orderId, rzpOrder.id, grandTotalPaise, CURRENCY]
  );

  logger.info('Razorpay order created', {
    orderId,
    rzpOrderId: rzpOrder.id,
    amount:     grandTotalPaise,
  });

  return {
    payment_id:        payment.id,
    razorpay_order_id: rzpOrder.id,
    amount:            rzpOrder.amount,
    currency:          rzpOrder.currency,
    // Send to frontend for Razorpay checkout widget
    key_id:            process.env.RAZORPAY_KEY_ID,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. VERIFY PAYMENT SIGNATURE  (client → server after customer pays)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Verify the HMAC-SHA256 signature Razorpay returns after a successful payment.
 * MUST be called before marking any order as paid.
 *
 * @param {string} razorpay_order_id
 * @param {string} razorpay_payment_id
 * @param {string} razorpay_signature   - from Razorpay checkout response
 * @returns {boolean}
 */
function verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature) {
  const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  // Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(razorpay_signature, 'hex')
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. CAPTURE PAYMENT  (only needed if auth_and_capture = false)
// ════════════════════════════════════════════════════════════════════════════

async function capturePayment(razorpay_payment_id, amountPaise) {
  const rzp = getClient();
  return rzp.payments.capture(razorpay_payment_id, amountPaise, CURRENCY);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. CONFIRM PAYMENT  (called after verifySignature passes)
//    Updates DB + triggers restaurant payouts
// ════════════════════════════════════════════════════════════════════════════

/**
 * Atomically:
 *  - Update payments record → captured
 *  - Advance order → confirmed
 *  - Create restaurant_payout records
 *  - Trigger Razorpay Route transfers (if configured)
 *  - Publish WebSocket event
 */
async function confirmPayment({ razorpay_order_id, razorpay_payment_id, razorpay_signature, method }) {
  return db.withTransaction(async (client) => {
    // 1. Load payment + order
    const { rows: [payment] } = await client.query(
      `SELECT p.*, o.id AS order_id, o.restaurant_count
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.razorpay_order_id = $1`,
      [razorpay_order_id]
    );
    if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
    if (payment.status === 'captured') {
      return { alreadyCaptured: true, orderId: payment.order_id };
    }

    // 2. Update payment record
    await client.query(
      `UPDATE payments
       SET status              = 'captured',
           razorpay_payment_id = $1,
           razorpay_signature  = $2,
           method              = $3,
           captured_at         = NOW(),
           updated_at          = NOW()
       WHERE id = $4`,
      [razorpay_payment_id, razorpay_signature, method || null, payment.id]
    );

    // 3. Advance order status
    await client.query(
      `UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`,
      [payment.order_id]
    );

    // 4. Load sub-orders and create payout records
    const { rows: subOrders } = await client.query(
      `SELECT so.id, so.restaurant_id, so.subtotal,
              r.name AS restaurant_name,
              r.razorpay_account_id  -- linked bank account for Route transfers
       FROM sub_orders so
       JOIN restaurants r ON r.id = so.restaurant_id
       WHERE so.order_id = $1`,
      [payment.order_id]
    );

    const payoutRecords = [];
    for (const sub of subOrders) {
      const commissionAmt = Math.round(sub.subtotal * PLATFORM_COMMISSION_PCT);
      const netAmount     = sub.subtotal - commissionAmt;

      const { rows: [payout] } = await client.query(
        `INSERT INTO restaurant_payouts
           (sub_order_id, restaurant_id, payment_id,
            amount, commission_pct, commission_amt, net_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        [
          sub.id, sub.restaurant_id, payment.id,
          sub.subtotal,
          PLATFORM_COMMISSION_PCT * 100,
          commissionAmt,
          netAmount,
        ]
      );
      payoutRecords.push({
        payoutId:       payout.id,
        restaurantId:   sub.restaurant_id,
        restaurantName: sub.restaurant_name,
        accountId:      sub.razorpay_account_id,
        netAmount,
        subOrderId:     sub.id,
      });
    }

    logger.info('Payment confirmed', {
      orderId:   payment.order_id,
      paymentId: razorpay_payment_id,
      amount:    payment.amount,
    });

    // 5. Trigger Route transfers asynchronously (don't block the response)
    setImmediate(async () => {
      for (const p of payoutRecords) {
        await triggerRouteTransfer(p).catch(err =>
          logger.error('Route transfer failed', { payoutId: p.payoutId, error: err.message })
        );
      }
    });

    // 6. Publish WebSocket event
    await publishOrderEvent(payment.order_id, {
      event:   'payment_confirmed',
      orderId: payment.order_id,
    });

    return {
      orderId:    payment.order_id,
      payoutCount: payoutRecords.length,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. RAZORPAY ROUTE — Split transfer to restaurant bank accounts
// ════════════════════════════════════════════════════════════════════════════

/**
 * Transfer the restaurant's net share via Razorpay Route.
 * Requires the restaurant to have a linked account (onboarding step).
 *
 * @param {object} payout - { payoutId, restaurantId, accountId, netAmount, subOrderId }
 */
async function triggerRouteTransfer({ payoutId, restaurantId, accountId, netAmount, subOrderId }) {
  if (!accountId) {
    logger.warn('No Razorpay linked account — skipping Route transfer', { restaurantId });
    return null;
  }

  const rzp = getClient();

  const transfer = await rzp.transfers.create({
    account:  accountId,
    amount:   netAmount,
    currency: CURRENCY,
    notes: {
      forkfleet_payout_id:   payoutId,
      forkfleet_sub_order_id: subOrderId,
      restaurant_id:          restaurantId,
    },
    on_hold: 0,   // 0 = release immediately; 1 = hold for manual release
  });

  await db.query(
    `UPDATE restaurant_payouts
     SET razorpay_transfer_id = $1,
         status               = 'processing',
         updated_at           = NOW()
     WHERE id = $2`,
    [transfer.id, payoutId]
  );

  logger.info('Route transfer created', {
    payoutId,
    transferId: transfer.id,
    netAmount,
    restaurantId,
  });

  return transfer;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. REFUNDS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Issue a full or partial refund for an order.
 *
 * @param {string} orderId       - ForkFleet order UUID
 * @param {object} opts
 *   @param {number}  [opts.amountPaise]  - omit for full refund
 *   @param {string}  [opts.reason]       - 'duplicate'|'fraudulent'|'customer_request'
 *   @param {string}  [opts.notes]        - free-text reason
 * @returns {object} Razorpay refund object
 */
async function issueRefund(orderId, opts = {}) {
  const { rows: [payment] } = await db.query(
    `SELECT * FROM payments WHERE order_id = $1 AND status = 'captured'`,
    [orderId]
  );
  if (!payment) throw Object.assign(new Error('No captured payment found for this order'), { statusCode: 400 });

  const rzp = getClient();

  const refundAmount = opts.amountPaise || payment.amount;

  const refund = await rzp.payments.refund(payment.razorpay_payment_id, {
    amount: refundAmount,
    speed:  'normal',       // 'normal' (5-7 days) or 'optimum' (instant if supported)
    notes: {
      reason:              opts.notes  || opts.reason || 'Customer request',
      forkfleet_order_id:  orderId,
    },
    receipt: `refund_${orderId.slice(0, 8)}`,
  });

  // Update payment status
  const isFullRefund = refundAmount >= payment.amount;
  await db.query(
    `UPDATE payments
     SET status     = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [isFullRefund ? 'refunded' : 'partially_refunded', payment.id]
  );

  // Update order status
  await db.query(
    `UPDATE orders SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
    [orderId]
  );

  logger.info('Refund issued', {
    orderId,
    refundId:  refund.id,
    amount:    refundAmount,
    fullRefund: isFullRefund,
  });

  return refund;
}

// ════════════════════════════════════════════════════════════════════════════
// 7. RESTAURANT LINKED ACCOUNT ONBOARDING (Razorpay Route prerequisite)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a Razorpay linked account for a restaurant so Route transfers work.
 * Call this during restaurant onboarding.
 *
 * @param {object} restaurant - { id, name, email, phone, panNumber, bankAccount }
 */
async function createLinkedAccount(restaurant) {
  const rzp = getClient();

  const account = await rzp.accounts.create({
    email:        restaurant.email,
    profile: {
      category:     'food_and_beverage',
      subcategory:  'restaurant',
      addresses: {
        registered: {
          street1: restaurant.address,
          city:    restaurant.city,
          state:   'DL',
          postal_code: restaurant.pincode,
          country: 'IN',
        },
      },
    },
    legal_info: {
      pan: restaurant.panNumber,
    },
    legal_business_name: restaurant.name,
    business_type:       'individual',
  });

  // Attach bank account for settlement
  const bankAccount = await rzp.accounts.createBankAccount(account.id, {
    ifsc_code:           restaurant.bankAccount.ifsc,
    beneficiary_name:    restaurant.bankAccount.beneficiaryName,
    account_number:      restaurant.bankAccount.accountNumber,
    account_type:        'route',
  });

  // Save the account ID to our restaurants table
  await db.query(
    `UPDATE restaurants SET razorpay_account_id = $1 WHERE id = $2`,
    [account.id, restaurant.id]
  );

  logger.info('Razorpay linked account created', {
    restaurantId: restaurant.id,
    accountId:    account.id,
  });

  return { accountId: account.id, bankAccountId: bankAccount.id };
}

// ════════════════════════════════════════════════════════════════════════════
// 8. WEBHOOK SIGNATURE VALIDATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a Razorpay webhook payload.
 * Call this before processing any webhook event.
 *
 * @param {string|Buffer} rawBody  - raw request body (not JSON-parsed)
 * @param {string} signature       - x-razorpay-signature header
 * @returns {boolean}
 */
function validateWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = {
  createPaymentOrder,
  verifyPaymentSignature,
  capturePayment,
  confirmPayment,
  issueRefund,
  createLinkedAccount,
  triggerRouteTransfer,
  validateWebhookSignature,
};
