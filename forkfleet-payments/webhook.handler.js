/**
 * ForkFleet — Razorpay Webhook Handler
 *
 * Mount at:  POST /api/v1/payments/webhook
 *
 * IMPORTANT: This route must receive the RAW body (not JSON-parsed).
 * In server.js add BEFORE express.json():
 *   app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
 *
 * Events handled:
 *   payment.captured        → confirm order, trigger Route splits
 *   payment.failed          → mark payment failed, notify customer
 *   refund.processed        → mark payout settled
 *   transfer.settled        → mark restaurant payout as paid
 *   order.paid              → idempotency guard (secondary confirmation)
 */

const router  = require('express').Router();
const db      = require('../db');
const { publishOrderEvent } = require('../db/redis');
const rzpService = require('./razorpay.service');
const logger  = require('../utils/logger');

// ── Idempotency guard ─────────────────────────────────────────────────────────
// Razorpay may deliver the same webhook more than once.
// Track processed event IDs in DB to avoid double-processing.

async function isEventProcessed(eventId) {
  const { rows } = await db.query(
    'SELECT 1 FROM webhook_events WHERE razorpay_event_id = $1', [eventId]
  );
  return rows.length > 0;
}

async function markEventProcessed(eventId, event, status) {
  await db.query(
    `INSERT INTO webhook_events (razorpay_event_id, event_type, payload, status)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [eventId, event, '{}', status]
  );
}

// ── Main webhook handler ──────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  // 1. Validate signature immediately
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    logger.warn('Webhook missing signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }

  const isValid = rzpService.validateWebhookSignature(req.body, signature);
  if (!isValid) {
    logger.warn('Webhook signature validation FAILED', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // 2. Parse body
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = payload.event;
  const eventId   = payload.id || payload.event; // Razorpay event IDs

  logger.info('Webhook received', { event: eventType, eventId });

  // 3. Idempotency check
  if (await isEventProcessed(eventId)) {
    logger.info('Duplicate webhook — already processed', { eventId });
    return res.status(200).json({ status: 'already_processed' });
  }

  // 4. Dispatch to handler
  try {
    switch (eventType) {
      case 'payment.captured':
        await handlePaymentCaptured(payload.payload.payment.entity);
        break;
      case 'payment.failed':
        await handlePaymentFailed(payload.payload.payment.entity);
        break;
      case 'refund.processed':
        await handleRefundProcessed(payload.payload.refund.entity);
        break;
      case 'transfer.settled':
        await handleTransferSettled(payload.payload.transfer.entity);
        break;
      case 'order.paid':
        // Secondary confirmation — usually already handled by payment.captured
        logger.info('order.paid webhook (secondary)', {
          orderId: payload.payload.order?.entity?.receipt,
        });
        break;
      default:
        logger.info('Unhandled webhook event type', { eventType });
    }

    await markEventProcessed(eventId, eventType, 'processed');
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error('Webhook handler error', { eventType, eventId, error: err.message, stack: err.stack });
    await markEventProcessed(eventId, eventType, 'failed').catch(() => {});
    // Always return 200 to prevent Razorpay retrying a broken event
    return res.status(200).json({ status: 'error', message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// ── payment.captured ──────────────────────────────────────────────────────────

async function handlePaymentCaptured(payment) {
  const { order_id: rzpOrderId, id: rzpPaymentId, method } = payment;

  logger.info('Processing payment.captured', { rzpOrderId, rzpPaymentId });

  const result = await rzpService.confirmPayment({
    razorpay_order_id:  rzpOrderId,
    razorpay_payment_id: rzpPaymentId,
    razorpay_signature:  null,  // Webhook doesn't carry a payment signature
    method,
  });

  if (result.alreadyCaptured) {
    logger.info('Payment already captured — skipping', { rzpOrderId });
    return;
  }

  logger.info('Payment capture processed', {
    orderId:     result.orderId,
    payoutCount: result.payoutCount,
  });
}

// ── payment.failed ────────────────────────────────────────────────────────────

async function handlePaymentFailed(payment) {
  const { order_id: rzpOrderId, id: rzpPaymentId, error_code, error_description } = payment;

  logger.warn('Payment failed', { rzpOrderId, rzpPaymentId, error_code, error_description });

  await db.query(
    `UPDATE payments
     SET status         = 'failed',
         failure_reason = $1,
         updated_at     = NOW()
     WHERE razorpay_order_id = $2`,
    [`${error_code}: ${error_description}`, rzpOrderId]
  );

  // Get order ID for WebSocket notification
  const { rows: [p] } = await db.query(
    'SELECT order_id FROM payments WHERE razorpay_order_id = $1',
    [rzpOrderId]
  );

  if (p) {
    // Keep order in pending_payment — let customer retry
    await publishOrderEvent(p.order_id, {
      event:   'payment_failed',
      orderId: p.order_id,
      reason:  error_description,
    });
  }
}

// ── refund.processed ──────────────────────────────────────────────────────────

async function handleRefundProcessed(refund) {
  const { payment_id: rzpPaymentId, id: refundId, amount } = refund;

  logger.info('Refund processed', { refundId, rzpPaymentId, amount });

  // Fetch our payment
  const { rows: [payment] } = await db.query(
    `SELECT p.*, o.id AS order_id
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.razorpay_payment_id = $1`,
    [rzpPaymentId]
  );
  if (!payment) return;

  const isFullRefund = amount >= payment.amount;

  await db.query(
    `UPDATE payments
     SET status = $1, updated_at = NOW()
     WHERE razorpay_payment_id = $2`,
    [isFullRefund ? 'refunded' : 'partially_refunded', rzpPaymentId]
  );

  await publishOrderEvent(payment.order_id, {
    event:        'refund_processed',
    orderId:      payment.order_id,
    refundId,
    amountPaise:  amount,
    fullRefund:   isFullRefund,
  });
}

// ── transfer.settled ──────────────────────────────────────────────────────────

async function handleTransferSettled(transfer) {
  const { id: transferId, amount } = transfer;

  logger.info('Restaurant payout settled', { transferId, amount });

  await db.query(
    `UPDATE restaurant_payouts
     SET status      = 'paid',
         settled_at  = NOW()
     WHERE razorpay_transfer_id = $1`,
    [transferId]
  );
}

module.exports = router;
