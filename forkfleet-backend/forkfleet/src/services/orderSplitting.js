/**
 * OrderSplittingService
 *
 * Responsibilities:
 *  1. Validate cart items are still available and priced correctly
 *  2. Create the parent order + sub-orders + line items atomically in one transaction
 *  3. Create a Razorpay order for the grand total
 *  4. Return order + payment details to the caller
 */

const db = require('../db');
const { getCart, clearCart, publishOrderEvent } = require('../db/redis');
const logger = require('../utils/logger');

const DELIVERY_FEE = parseFloat(process.env.DELIVERY_FEE_PER_RESTAURANT || 30);
const TAX_RATE     = parseFloat(process.env.TAX_RATE || 0.05);
const COMMISSION   = 0.15; // 15% platform commission on restaurant payout

class OrderSplittingService {
  /**
   * Create a full multi-restaurant order from a user's cart.
   *
   * @param {string} userId
   * @param {object} opts  { delivery_address_id, instructions }
   * @returns {{ order, subOrders, razorpayOrder }}
   */
  async createOrder(userId, opts = {}) {
    const cart = await getCart(userId);
    const cartItems = Object.values(cart.items || {});

    if (!cartItems.length) throw Object.assign(new Error('Cart is empty'), { statusCode: 400 });

    // ── Step 1: Re-validate every item against live DB ────────────────────────
    const itemIds = cartItems.map(i => i.menu_item_id);
    const { rows: dbItems } = await db.query(
      `SELECT mi.id, mi.name, mi.price, mi.is_available,
              mi.restaurant_id,
              r.name AS restaurant_name, r.is_open, r.is_active, r.avg_prep_minutes
       FROM menu_items mi JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE mi.id = ANY($1)`,
      [itemIds]
    );

    const dbItemMap = {};
    dbItems.forEach(i => { dbItemMap[i.id] = i; });

    for (const ci of cartItems) {
      const db = dbItemMap[ci.menu_item_id];
      if (!db)                        throw Object.assign(new Error(`Item "${ci.name}" no longer exists`), { statusCode: 400 });
      if (!db.is_available)           throw Object.assign(new Error(`"${db.name}" is currently unavailable`), { statusCode: 400 });
      if (!db.is_open || !db.is_active) throw Object.assign(new Error(`${db.restaurant_name} is currently closed`), { statusCode: 400 });
    }

    // ── Step 2: Group by restaurant and compute totals ────────────────────────
    const restGroups = {};
    for (const ci of cartItems) {
      const dbi = dbItemMap[ci.menu_item_id];
      if (!restGroups[dbi.restaurant_id]) {
        restGroups[dbi.restaurant_id] = {
          restaurant_id: dbi.restaurant_id,
          restaurant_name: dbi.restaurant_name,
          avg_prep_minutes: dbi.avg_prep_minutes,
          items: [],
          subtotalPaise: 0,
        };
      }
      const pricePaise = Math.round(parseFloat(dbi.price) * 100);
      restGroups[dbi.restaurant_id].items.push({
        menu_item_id: dbi.id,
        name: dbi.name,
        price_paise: pricePaise,
        quantity: ci.quantity,
        line_total_paise: pricePaise * ci.quantity,
      });
      restGroups[dbi.restaurant_id].subtotalPaise += pricePaise * ci.quantity;
    }

    const restaurantCount  = Object.keys(restGroups).length;
    const itemsTotalPaise  = Object.values(restGroups).reduce((s, r) => s + r.subtotalPaise, 0);
    const deliveryPaise    = Math.round(restaurantCount * DELIVERY_FEE * 100);
    const taxPaise         = Math.round(itemsTotalPaise * TAX_RATE);
    const grandTotalPaise  = itemsTotalPaise + deliveryPaise + taxPaise;

    // ── Step 3: Fetch delivery address ────────────────────────────────────────
    let deliveryAddr = null;
    if (opts.delivery_address_id) {
      const { rows } = await db.query(
        'SELECT * FROM user_addresses WHERE id=$1 AND user_id=$2',
        [opts.delivery_address_id, userId]
      );
      if (!rows.length) throw Object.assign(new Error('Delivery address not found'), { statusCode: 400 });
      deliveryAddr = rows[0];
    }

    // ── Step 4: Atomic DB transaction ─────────────────────────────────────────
    const { order, subOrders } = await db.withTransaction(async (client) => {
      // 4a. Parent order
      const { rows: [order] } = await client.query(
        `INSERT INTO orders
           (customer_id, delivery_address_id, delivery_address,
            status, items_total, delivery_fee, tax_amount, grand_total,
            restaurant_count, instructions)
         VALUES ($1,$2,$3,'pending_payment',$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          userId,
          opts.delivery_address_id || null,
          deliveryAddr ? JSON.stringify(deliveryAddr) : '{}',
          itemsTotalPaise,
          deliveryPaise,
          taxPaise,
          grandTotalPaise,
          restaurantCount,
          opts.instructions || null,
        ]
      );

      // 4b. One sub-order per restaurant + line items
      const subOrders = [];
      for (const group of Object.values(restGroups)) {
        const commissionAmt = Math.round(group.subtotalPaise * COMMISSION);
        const payoutAmt     = group.subtotalPaise - commissionAmt;

        const { rows: [sub] } = await client.query(
          `INSERT INTO sub_orders
             (order_id, restaurant_id, status, subtotal, payout_amount)
           VALUES ($1,$2,'confirmed',$3,$4)
           RETURNING *`,
          [order.id, group.restaurant_id, group.subtotalPaise, payoutAmt]
        );

        // Line items
        for (const item of group.items) {
          await client.query(
            `INSERT INTO order_items (sub_order_id, menu_item_id, name, price, quantity, line_total)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [sub.id, item.menu_item_id, item.name, item.price_paise, item.quantity, item.line_total_paise]
          );
        }

        // Delivery job pickup sequence entry
        subOrders.push({
          ...sub,
          restaurant_name: group.restaurant_name,
          avg_prep_minutes: group.avg_prep_minutes,
          items: group.items,
        });
      }

      // 4c. Delivery job (pending rider assignment)
      await client.query(
        `INSERT INTO delivery_jobs (order_id, pickup_sequence, dropoff_address, status)
         VALUES ($1,$2,$3,'pending_assignment')`,
        [
          order.id,
          JSON.stringify(subOrders.map(s => ({
            sub_order_id: s.id,
            restaurant_id: s.restaurant_id,
            restaurant_name: s.restaurant_name,
          }))),
          JSON.stringify(deliveryAddr || {}),
        ]
      );

      return { order, subOrders };
    });

    // ── Step 5: Create Razorpay order ─────────────────────────────────────────
    let razorpayOrder = null;
    try {
      razorpayOrder = await createRazorpayOrder(order.id, grandTotalPaise);
      await db.query(
        `INSERT INTO payments (order_id, razorpay_order_id, amount, status)
         VALUES ($1,$2,$3,'pending')`,
        [order.id, razorpayOrder.id, grandTotalPaise]
      );
    } catch (err) {
      logger.error('Razorpay order creation failed', { orderId: order.id, error: err.message });
      // Don't fail the order — allow retry via /orders/:id/retry-payment
    }

    // ── Step 6: Clear cart ────────────────────────────────────────────────────
    await clearCart(userId);

    // ── Step 7: Publish event for WebSocket broadcast ─────────────────────────
    await publishOrderEvent(order.id, {
      event: 'order_created',
      orderId: order.id,
      restaurantCount,
      subOrders: subOrders.map(s => ({ id: s.id, restaurant_id: s.restaurant_id, status: s.status })),
    });

    logger.info('Order created', {
      orderId: order.id,
      userId,
      restaurantCount,
      grandTotal: grandTotalPaise,
    });

    return { order, subOrders, razorpayOrder };
  }

  /**
   * Update a sub-order's status and check if all sub-orders are complete
   * to advance the parent order status.
   */
  async updateSubOrderStatus(subOrderId, newStatus, actorId) {
    return db.withTransaction(async (client) => {
      // Fetch sub-order
      const { rows: [sub] } = await client.query(
        'SELECT * FROM sub_orders WHERE id = $1', [subOrderId]
      );
      if (!sub) throw Object.assign(new Error('Sub-order not found'), { statusCode: 404 });

      // Timestamp fields
      const tsField = {
        preparing: null,
        ready: 'ready_at',
        picked_up: 'picked_up_at',
      }[newStatus];

      const tsClause = tsField ? `, ${tsField} = NOW()` : '';
      await client.query(
        `UPDATE sub_orders SET status = $1${tsClause}, updated_at = NOW() WHERE id = $2`,
        [newStatus, subOrderId]
      );

      // Check all sub-orders for this parent order
      const { rows: allSubs } = await client.query(
        'SELECT status FROM sub_orders WHERE order_id = $1', [sub.order_id]
      );

      // Determine parent order status
      const statuses = allSubs.map(s => s.id === subOrderId ? newStatus : s.status);
      let parentStatus = null;

      if (statuses.every(s => s === 'ready'))     parentStatus = 'ready_for_pickup';
      if (statuses.every(s => s === 'picked_up')) parentStatus = 'picked_up';

      if (parentStatus) {
        await client.query(
          'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
          [parentStatus, sub.order_id]
        );
      }

      // Publish real-time event
      await publishOrderEvent(sub.order_id, {
        event: 'sub_order_status_updated',
        subOrderId,
        status: newStatus,
        parentStatus,
        restaurantId: sub.restaurant_id,
      });

      return { subOrderId, status: newStatus, parentOrderStatus: parentStatus };
    });
  }
}

// ── Razorpay helper ───────────────────────────────────────────────────────────
// (Separated so it can be easily mocked in tests)

async function createRazorpayOrder(orderId, amountPaise) {
  // Lazily initialise — avoids crash if RAZORPAY keys are missing in dev
  const Razorpay = require('razorpay');
  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  return razorpay.orders.create({
    amount:   amountPaise,
    currency: 'INR',
    receipt:  orderId,
    notes:    { orderId },
  });
}

module.exports = new OrderSplittingService();
