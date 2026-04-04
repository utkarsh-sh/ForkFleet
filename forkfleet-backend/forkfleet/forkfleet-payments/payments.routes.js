/**
 * ForkFleet — Payment API Routes
 *
 * Add to src/server.js:
 *   // RAW body for webhook MUST come before express.json()
 *   app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
 *   app.use('/api/v1/payments', require('./routes/payments'));
 */

const router     = require('express').Router();
const { body }   = require('express-validator');
const db         = require('../db');
const rzpService = require('../payments/razorpay.service');
const webhook    = require('../payments/webhook.handler');
const { ok, created, badRequest, notFound, serverError } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const logger     = require('../utils/logger');

// ── Mount webhook (raw body, no auth) ────────────────────────────────────────
router.use('/webhook', webhook);

// ══════════════════════════════════════════════════════════════════════════════
// POST /payments/initiate
// Call after POST /orders to get Razorpay checkout details.
// ══════════════════════════════════════════════════════════════════════════════

router.post(
  '/initiate',
  authenticate,
  [body('order_id').isUUID()],
  validate,
  async (req, res) => {
    const { order_id } = req.body;

    try {
      // Fetch order + verify ownership
      const { rows: [order] } = await db.query(
        'SELECT * FROM orders WHERE id = $1', [order_id]
      );
      if (!order)                           return notFound(res, 'Order not found');
      if (order.customer_id !== req.user.id) return badRequest(res, 'Not your order');
      if (order.status !== 'pending_payment') {
        return badRequest(res, `Order is already in status: ${order.status}`);
      }

      // Fetch customer info for Razorpay prefill
      const { rows: [user] } = await db.query(
        'SELECT name, email, phone FROM users WHERE id=$1', [req.user.id]
      );

      const paymentOrder = await rzpService.createPaymentOrder(
        order_id,
        order.grand_total,
        user
      );

      return ok(res, {
        ...paymentOrder,
        // Prefill for Razorpay checkout widget
        prefill: {
          name:    user.name  || '',
          email:   user.email || '',
          contact: user.phone || '',
        },
        description: `ForkFleet order — ${order.restaurant_count} restaurant${order.restaurant_count > 1 ? 's' : ''}`,
      });
    } catch (err) {
      logger.error('Payment initiate error', { error: err.message, orderId: order_id });
      return serverError(res);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// POST /payments/verify
// Called by frontend after customer completes Razorpay checkout.
// Verifies signature, confirms payment in DB.
// ══════════════════════════════════════════════════════════════════════════════

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

    // 1. Verify HMAC signature — reject if tampered
    const isValid = rzpService.verifyPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!isValid) {
      logger.warn('Payment signature verification FAILED', {
        userId: req.user.id,
        razorpay_order_id,
        razorpay_payment_id,
      });
      return badRequest(res, 'Payment verification failed — invalid signature');
    }

    try {
      // 2. Confirm in DB + trigger payouts
      const result = await rzpService.confirmPayment({
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        method: req.body.method,
      });

      logger.info('Payment verified by client', {
        userId:  req.user.id,
        orderId: result.orderId,
      });

      return ok(res, {
        order_id:    result.orderId,
        status:      'confirmed',
        message:     'Payment successful — your order is confirmed!',
      });
    } catch (err) {
      logger.error('Payment confirm error', { error: err.message });
      return serverError(res);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// POST /payments/retry
// Let customer retry a failed payment (creates a fresh Razorpay order).
// ══════════════════════════════════════════════════════════════════════════════

router.post(
  '/retry',
  authenticate,
  [body('order_id').isUUID()],
  validate,
  async (req, res) => {
    const { order_id } = req.body;

    try {
      const { rows: [order] } = await db.query(
        'SELECT * FROM orders WHERE id=$1', [order_id]
      );
      if (!order)                            return notFound(res);
      if (order.customer_id !== req.user.id) return badRequest(res, 'Not your order');
      if (!['pending_payment', 'payment_failed'].includes(order.status)) {
        return badRequest(res, `Cannot retry payment for order in status: ${order.status}`);
      }

      const { rows: [user] } = await db.query(
        'SELECT name, email, phone FROM users WHERE id=$1', [req.user.id]
      );

      // Create a fresh Razorpay order (the old one may have expired)
      const paymentOrder = await rzpService.createPaymentOrder(
        order_id,
        order.grand_total,
        user
      );

      return ok(res, { ...paymentOrder, retry: true });
    } catch (err) {
      return serverError(res);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// POST /payments/refund  (admin or automated cancellation flow)
// ══════════════════════════════════════════════════════════════════════════════

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
    const { order_id, amount_paise, reason } = req.body;

    try {
      const refund = await rzpService.issueRefund(order_id, {
        amountPaise: amount_paise,
        notes:       reason || 'Admin refund',
        reason:      'customer_request',
      });

      return ok(res, {
        refund_id:   refund.id,
        amount:      refund.amount,
        status:      refund.status,
      });
    } catch (err) {
      if (err.statusCode) return badRequest(res, err.message);
      logger.error('Refund error', { error: err.message, orderId: order_id });
      return serverError(res);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// GET /payments/:orderId — payment status for an order
// ══════════════════════════════════════════════════════════════════════════════

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
  } catch (err) {
    return serverError(res);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /payments/payouts/:restaurantId — restaurant earnings (owner only)
// ══════════════════════════════════════════════════════════════════════════════

router.get(
  '/payouts/:restaurantId',
  authenticate,
  authorize('restaurant_owner', 'admin'),
  async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const offset = (Math.max(1, +page) - 1) * Math.min(50, +limit);

    try {
      const { rows } = await db.query(
        `SELECT rp.id, rp.amount, rp.commission_pct, rp.commission_amt,
                rp.net_amount, rp.status, rp.settled_at, rp.created_at,
                so.id AS sub_order_id, o.id AS order_id
         FROM restaurant_payouts rp
         JOIN sub_orders so ON so.id = rp.sub_order_id
         JOIN orders o ON o.id = so.order_id
         WHERE rp.restaurant_id = $1
         ORDER BY rp.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.params.restaurantId, Math.min(50, +limit), offset]
      );

      const { rows: [totals] } = await db.query(
        `SELECT
           COALESCE(SUM(net_amount) FILTER (WHERE status='paid'), 0)        AS total_paid,
           COALESCE(SUM(net_amount) FILTER (WHERE status='pending'), 0)     AS total_pending,
           COUNT(*) FILTER (WHERE status='paid')                            AS paid_count
         FROM restaurant_payouts WHERE restaurant_id=$1`,
        [req.params.restaurantId]
      );

      return ok(res, { payouts: rows, summary: totals });
    } catch (err) {
      return serverError(res);
    }
  }
);

module.exports = router;
