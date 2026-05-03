const router = require('express').Router();
const db = require('../db');
const { publishOrderEvent } = require('../db/redis');
const rzpService = require('./razorpay.service');
const logger = require('../utils/logger');

async function isEventProcessed(eventId) {
  const { rows } = await db.query('SELECT 1 FROM webhook_events WHERE razorpay_event_id = $1', [eventId]);
  return rows.length > 0;
}

async function markEventProcessed(eventId, eventType, status) {
  await db.query(
    `INSERT INTO webhook_events (razorpay_event_id, event_type, payload, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (razorpay_event_id) DO NOTHING`,
    [eventId, eventType, '{}', status]
  );
}

router.post('/', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  const isValid = rzpService.validateWebhookSignature(req.body, signature);
  if (!isValid) return res.status(400).json({ error: 'Invalid signature' });

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = payload.event;
  const eventId = payload.id || `${eventType}:${payload?.payload?.payment?.entity?.id || Date.now()}`;

  if (await isEventProcessed(eventId)) return res.status(200).json({ status: 'already_processed' });

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
      default:
        logger.info('Unhandled webhook event type', { eventType });
    }

    await markEventProcessed(eventId, eventType, 'processed');
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error('Webhook processing error', { eventType, eventId, error: err.message });
    await markEventProcessed(eventId, eventType, 'failed').catch(() => {});
    return res.status(200).json({ status: 'error', message: err.message });
  }
});

async function handlePaymentCaptured(payment) {
  await rzpService.confirmPayment({
    razorpay_order_id: payment.order_id,
    razorpay_payment_id: payment.id,
    razorpay_signature: null,
    method: payment.method,
  });
}

async function handlePaymentFailed(payment) {
  await db.query(
    `UPDATE payments
     SET status = 'failed',
         failure_reason = $1,
         updated_at = NOW()
     WHERE razorpay_order_id = $2`,
    [`${payment.error_code || 'unknown'}: ${payment.error_description || 'Payment failed'}`, payment.order_id]
  );

  const { rows: [row] } = await db.query('SELECT order_id FROM payments WHERE razorpay_order_id = $1', [payment.order_id]);
  if (row) {
    await db.query('UPDATE orders SET status = \'payment_failed\', updated_at = NOW() WHERE id = $1', [row.order_id]);
    await publishOrderEvent(row.order_id, {
      event: 'payment_failed',
      orderId: row.order_id,
      reason: payment.error_description || 'Payment failed',
    });
  }
}

async function handleRefundProcessed(refund) {
  const { rows: [payment] } = await db.query(
    `SELECT p.*, o.id AS order_id
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     WHERE p.razorpay_payment_id = $1`,
    [refund.payment_id]
  );
  if (!payment) return;

  const isFullRefund = refund.amount >= payment.amount;
  await db.query(
    `UPDATE payments
     SET status = $1,
         updated_at = NOW()
     WHERE razorpay_payment_id = $2`,
    [isFullRefund ? 'refunded' : 'partially_refunded', refund.payment_id]
  );

  await publishOrderEvent(payment.order_id, {
    event: 'refund_processed',
    orderId: payment.order_id,
    refundId: refund.id,
    amountPaise: refund.amount,
    fullRefund: isFullRefund,
  });
}

async function handleTransferSettled(transfer) {
  await db.query(
    `UPDATE restaurant_payouts
     SET status = 'paid',
         settled_at = NOW()
     WHERE razorpay_transfer_id = $1`,
    [transfer.id]
  );
}

module.exports = router;
