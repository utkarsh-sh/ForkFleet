const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../db');
const { publishOrderEvent } = require('../db/redis');
const logger = require('../utils/logger');

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env');
    }
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return client;
}

const PLATFORM_COMMISSION_PCT = parseFloat(process.env.PLATFORM_COMMISSION_PCT || '15') / 100;
const CURRENCY = 'INR';

async function createPaymentOrder(orderId, grandTotalPaise, customerInfo = {}) {
  const rzp = getClient();
  const rzpOrder = await rzp.orders.create({
    amount: grandTotalPaise,
    currency: CURRENCY,
    receipt: orderId,
    notes: {
      forkfleet_order_id: orderId,
      customer_name: customerInfo.name || '',
      customer_email: customerInfo.email || '',
    },
    partial_payment: false,
  });

  const { rows: [payment] } = await db.query(
    `INSERT INTO payments (order_id, razorpay_order_id, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [orderId, rzpOrder.id, grandTotalPaise, CURRENCY]
  );

  return {
    payment_id: payment.id,
    razorpay_order_id: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    key_id: process.env.RAZORPAY_KEY_ID,
  };
}

function verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature) {
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(String(razorpay_signature || ''), 'hex');

    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

async function confirmPayment({ razorpay_order_id, razorpay_payment_id, razorpay_signature, method }) {
  return db.withTransaction(async (trx) => {
    const { rows: [payment] } = await trx.query(
      `SELECT p.*, o.id AS order_id
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE p.razorpay_order_id = $1`,
      [razorpay_order_id]
    );
    if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
    if (payment.status === 'captured') return { alreadyCaptured: true, orderId: payment.order_id };

    await trx.query(
      `UPDATE payments
       SET status = 'captured',
           razorpay_payment_id = $1,
           razorpay_signature = $2,
           method = $3,
           captured_at = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [razorpay_payment_id, razorpay_signature, method || null, payment.id]
    );

    await trx.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [payment.order_id]);

    const { rows: subOrders } = await trx.query(
      `SELECT so.id, so.restaurant_id, so.subtotal, r.name AS restaurant_name, r.razorpay_account_id
       FROM sub_orders so
       JOIN restaurants r ON r.id = so.restaurant_id
       WHERE so.order_id = $1`,
      [payment.order_id]
    );

    const payoutRecords = [];
    for (const sub of subOrders) {
      const commissionAmt = Math.round(sub.subtotal * PLATFORM_COMMISSION_PCT);
      const netAmount = sub.subtotal - commissionAmt;
      const { rows: [payout] } = await trx.query(
        `INSERT INTO restaurant_payouts
          (sub_order_id, restaurant_id, payment_id, amount, commission_pct, commission_amt, net_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id`,
        [sub.id, sub.restaurant_id, payment.id, sub.subtotal, PLATFORM_COMMISSION_PCT * 100, commissionAmt, netAmount]
      );

      payoutRecords.push({
        payoutId: payout.id,
        restaurantId: sub.restaurant_id,
        restaurantName: sub.restaurant_name,
        accountId: sub.razorpay_account_id,
        netAmount,
        subOrderId: sub.id,
      });
    }

    setImmediate(async () => {
      for (const payout of payoutRecords) {
        await triggerRouteTransfer(payout).catch((err) => {
          logger.error('Route transfer failed', { payoutId: payout.payoutId, error: err.message });
        });
      }
    });

    await publishOrderEvent(payment.order_id, { event: 'payment_confirmed', orderId: payment.order_id });
    return { orderId: payment.order_id, payoutCount: payoutRecords.length };
  });
}

async function triggerRouteTransfer({ payoutId, restaurantId, accountId, netAmount, subOrderId }) {
  if (!accountId) return null;
  const rzp = getClient();
  const transfer = await rzp.transfers.create({
    account: accountId,
    amount: netAmount,
    currency: CURRENCY,
    notes: {
      forkfleet_payout_id: payoutId,
      forkfleet_sub_order_id: subOrderId,
      restaurant_id: restaurantId,
    },
    on_hold: 0,
  });

  await db.query(
    `UPDATE restaurant_payouts
     SET razorpay_transfer_id = $1,
         status = 'processing'
     WHERE id = $2`,
    [transfer.id, payoutId]
  );

  return transfer;
}

async function issueRefund(orderId, opts = {}) {
  const { rows: [payment] } = await db.query(
    'SELECT * FROM payments WHERE order_id = $1 AND status = \'captured\'',
    [orderId]
  );
  if (!payment) throw Object.assign(new Error('No captured payment found for this order'), { statusCode: 400 });

  const rzp = getClient();
  const refundAmount = opts.amountPaise || payment.amount;
  const refund = await rzp.payments.refund(payment.razorpay_payment_id, {
    amount: refundAmount,
    speed: 'normal',
    notes: { reason: opts.notes || opts.reason || 'Customer request', forkfleet_order_id: orderId },
    receipt: `refund_${orderId.slice(0, 8)}`,
  });

  const isFullRefund = refundAmount >= payment.amount;
  await db.query('UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2', [
    isFullRefund ? 'refunded' : 'partially_refunded',
    payment.id,
  ]);
  await db.query('UPDATE orders SET status = \'refunded\', updated_at = NOW() WHERE id = $1', [orderId]);
  return refund;
}

function validateWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

module.exports = {
  createPaymentOrder,
  verifyPaymentSignature,
  confirmPayment,
  issueRefund,
  triggerRouteTransfer,
  validateWebhookSignature,
};
