const router = require('express').Router();
const { body } = require('express-validator');
const db = require('../db');
const rzpService = require('../payments/razorpay.service');
const webhook = require('../payments/webhook.handler');
const { ok, badRequest, notFound, serverError } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

function mapPaymentError(err) {
  const msg = String(err?.message || 'Internal server error');
  if (msg.includes('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env')) {
    return 'Razorpay is not configured on server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend .env and restart backend.';
  }
  if (/authentication failed/i.test(msg) || /invalid key/i.test(msg)) {
    return 'Razorpay authentication failed. Verify test key id/secret in backend .env.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
    return 'Payment gateway network error. Check internet and retry.';
  }
  return msg;
}

router.use('/webhook', webhook);

router.post(
  '/initiate',
  authenticate,
  [body('order_id').isUUID()],
  validate,
  async (req, res) => {
    const { order_id } = req.body;

    try {
      const { rows: [order] } = await db.query('SELECT * FROM orders WHERE id = $1', [order_id]);
      if (!order) return notFound(res, 'Order not found');
      if (order.customer_id !== req.user.id) return badRequest(res, 'Not your order');
      if (order.status !== 'pending_payment') {
        return badRequest(res, `Order is already in status: ${order.status}`);
      }

      const { rows: [user] } = await db.query(
        'SELECT name, email, phone FROM users WHERE id = $1',
        [req.user.id]
      );

      const paymentOrder = await rzpService.createPaymentOrder(order_id, order.grand_total, user);

      return ok(res, {
        ...paymentOrder,
        prefill: {
          name: user?.name || '',
          email: user?.email || '',
          contact: user?.phone || '',
        },
        description: `ForkFleet order — ${order.restaurant_count} restaurant${order.restaurant_count > 1 ? 's' : ''}`,
      });
    } catch (err) {
      logger.error('Payment initiate error', { error: err.message, orderId: order_id });
      return serverError(res, mapPaymentError(err));
    }
  }
);

router.post(
  '/verify',
  authenticate,
  [
    body('razorpay_order_id').notEmpty(),
    body('razorpay_payment_id').notEmpty(),
    body('razorpay_signature').notEmpty(),
  ],
  validate,
  async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const isValid = rzpService.verifyPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );
    if (!isValid) return badRequest(res, 'Payment verification failed — invalid signature');

    try {
      const result = await rzpService.confirmPayment({
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        method: req.body.method,
      });

      return ok(res, {
        order_id: result.orderId,
        status: 'confirmed',
        message: 'Payment successful — your order is confirmed!',
      });
    } catch (err) {
      logger.error('Payment confirm error', { error: err.message });
      if (err.statusCode === 404) return notFound(res, err.message);
      if (err.statusCode) return badRequest(res, err.message);
      return serverError(res);
    }
  }
);

router.post(
  '/retry',
  authenticate,
  [body('order_id').isUUID()],
  validate,
  async (req, res) => {
    const { order_id } = req.body;
    try {
      const { rows: [order] } = await db.query('SELECT * FROM orders WHERE id = $1', [order_id]);
      if (!order) return notFound(res, 'Order not found');
      if (order.customer_id !== req.user.id) return badRequest(res, 'Not your order');
      if (!['pending_payment', 'payment_failed'].includes(order.status)) {
        return badRequest(res, `Cannot retry payment for order in status: ${order.status}`);
      }

      const { rows: [user] } = await db.query(
        'SELECT name, email, phone FROM users WHERE id = $1',
        [req.user.id]
      );
      const paymentOrder = await rzpService.createPaymentOrder(order_id, order.grand_total, user);
      return ok(res, { ...paymentOrder, retry: true });
    } catch (err) {
      logger.error('Payment retry error', { error: err.message, orderId: order_id });
      return serverError(res, mapPaymentError(err));
    }
  }
);

router.post(
  '/refund',
  authenticate,
  authorize('admin'),
  [
    body('order_id').isUUID(),
    body('amount_paise').optional().isInt({ min: 1 }),
    body('reason').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      const refund = await rzpService.issueRefund(req.body.order_id, {
        amountPaise: req.body.amount_paise,
        notes: req.body.reason || 'Admin refund',
        reason: 'customer_request',
      });
      return ok(res, { refund_id: refund.id, amount: refund.amount, status: refund.status });
    } catch (err) {
      if (err.statusCode) return badRequest(res, err.message);
      logger.error('Refund error', { error: err.message, orderId: req.body.order_id });
      return serverError(res);
    }
  }
);

router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const { rows: [payment] } = await db.query(
      `SELECT p.id, p.razorpay_order_id, p.razorpay_payment_id,
              p.amount, p.currency, p.status, p.method,
              p.captured_at, p.failure_reason, p.created_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = $1
         AND (o.customer_id = $2 OR $3 = 'admin')`,
      [req.params.orderId, req.user.id, req.user.role]
    );
    if (!payment) return notFound(res, 'Payment not found');
    return ok(res, { payment });
  } catch {
    return serverError(res);
  }
});

module.exports = router;
