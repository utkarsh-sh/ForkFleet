const router = require('express').Router();
const { body } = require('express-validator');
const db = require('../db');
const { publishOrderEvent } = require('../db/redis');
const orderSplitter = require('../services/orderSplitting');
const { ok, created, badRequest, notFound, forbidden, serverError } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ── POST /orders — place order from cart ─────────────────────────────────────

router.post(
  '/',
  authenticate,
  [
    body('delivery_address_id').optional().isUUID(),
    body('instructions').optional().isString().isLength({ max: 300 }),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await orderSplitter.createOrder(req.user.id, {
        delivery_address_id: req.body.delivery_address_id,
        instructions: req.body.instructions,
      });

      return created(res, {
        order:         result.order,
        subOrders:     result.subOrders,
        payment: result.razorpayOrder ? {
          razorpay_order_id: result.razorpayOrder.id,
          amount:            result.razorpayOrder.amount,
          currency:          result.razorpayOrder.currency,
          key_id:            process.env.RAZORPAY_KEY_ID,
        } : null,
      });
    } catch (err) {
      if (err.statusCode) return badRequest(res, err.message);
      logger.error('Create order error', { error: err.message, userId: req.user.id });
      return serverError(res);
    }
  }
);

// ── GET /orders — customer order history ─────────────────────────────────────

router.get('/', authenticate, async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const offset = (Math.max(1, +page) - 1) * Math.min(20, +limit);

  try {
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.grand_total, o.restaurant_count,
              o.created_at, o.delivered_at,
              json_agg(json_build_object(
                'sub_order_id', so.id,
                'restaurant_id', so.restaurant_id,
                'restaurant_name', r.name,
                'status', so.status,
                'subtotal', so.subtotal
              )) AS sub_orders
       FROM orders o
       JOIN sub_orders so ON so.order_id = o.id
       JOIN restaurants r ON r.id = so.restaurant_id
       WHERE o.customer_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, Math.min(20, +limit), offset]
    );
    return ok(res, { orders: rows });
  } catch (err) {
    return serverError(res);
  }
});

// ── GET /orders/:id — order detail ───────────────────────────────────────────

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*,
        json_agg(DISTINCT jsonb_build_object(
          'id', so.id, 'restaurant_id', so.restaurant_id,
          'restaurant_name', r.name, 'status', so.status,
          'subtotal', so.subtotal, 'ready_at', so.ready_at, 'picked_up_at', so.picked_up_at,
          'items', (
            SELECT json_agg(jsonb_build_object(
              'name', oi.name, 'quantity', oi.quantity,
              'price', oi.price, 'line_total', oi.line_total
            )) FROM order_items oi WHERE oi.sub_order_id = so.id
          )
        )) AS sub_orders,
        row_to_json(dj.*) AS delivery_job,
        row_to_json(p.*) AS payment
       FROM orders o
       LEFT JOIN sub_orders so ON so.order_id = o.id
       LEFT JOIN restaurants r ON r.id = so.restaurant_id
       LEFT JOIN delivery_jobs dj ON dj.order_id = o.id
       LEFT JOIN payments p ON p.order_id = o.id
       WHERE o.id = $1
       GROUP BY o.id, dj.id, p.id`,
      [req.params.id]
    );

    if (!rows.length) return notFound(res, 'Order not found');
    const order = rows[0];

    // Customers can only see their own orders
    if (req.user.role === 'customer' && order.customer_id !== req.user.id) {
      return forbidden(res);
    }

    return ok(res, { order });
  } catch (err) {
    logger.error('Get order error', { error: err.message });
    return serverError(res);
  }
});

// ── PATCH /orders/:id/sub-orders/:subId/status (restaurant updates) ───────────

router.patch(
  '/:id/sub-orders/:subId/status',
  authenticate,
  authorize('restaurant_owner', 'rider', 'admin'),
  [body('status').isIn(['preparing', 'ready', 'picked_up', 'cancelled'])],
  validate,
  async (req, res) => {
    try {
      const result = await orderSplitter.updateSubOrderStatus(
        req.params.subId,
        req.body.status,
        req.user.id
      );
      return ok(res, result);
    } catch (err) {
      if (err.statusCode) return badRequest(res, err.message);
      return serverError(res);
    }
  }
);

// ── POST /orders/:id/cancel ───────────────────────────────────────────────────

router.post(
  '/:id/cancel',
  authenticate,
  [body('reason').optional().isString().isLength({ max: 200 })],
  validate,
  async (req, res) => {
    try {
      const { rows } = await db.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
      if (!rows.length) return notFound(res);
      const order = rows[0];

      if (order.customer_id !== req.user.id && req.user.role !== 'admin') return forbidden(res);

      const cancellableStatuses = ['pending_payment', 'confirmed', 'preparing'];
      if (!cancellableStatuses.includes(order.status)) {
        return badRequest(res, `Cannot cancel order in status: ${order.status}`);
      }

      await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE orders SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1 WHERE id=$2`,
          [req.body.reason || null, order.id]
        );
        await client.query(
          `UPDATE sub_orders SET status='cancelled' WHERE order_id=$1`, [order.id]
        );
      });

      await publishOrderEvent(order.id, { event: 'order_cancelled', orderId: order.id });
      return ok(res, { message: 'Order cancelled' });
    } catch (err) {
      return serverError(res);
    }
  }
);

module.exports = router;
