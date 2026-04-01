const router = require('express').Router();
const { body } = require('express-validator');
const { getCart, setCart, clearCart } = require('../db/redis');
const { query: dbQuery } = require('../db');
const { ok, badRequest, notFound } = require('../utils/response');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');

const MAX_RESTAURANTS = parseInt(process.env.MAX_RESTAURANTS_PER_ORDER) || 5;
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS_PER_ORDER) || 50;

// All cart routes require auth
router.use(authenticate);

// ── GET /cart ─────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const cart = await getCart(req.user.id);
  return ok(res, { cart: enrichCart(cart) });
});

// ── POST /cart/items ──────────────────────────────────────────────────────────

router.post(
  '/items',
  [
    body('menu_item_id').isUUID(),
    body('quantity').isInt({ min: 1, max: 20 }),
  ],
  validate,
  async (req, res) => {
    const { menu_item_id, quantity } = req.body;

    // Fetch item + restaurant info from DB
    const { rows } = await dbQuery(
      `SELECT mi.id, mi.name, mi.price, mi.is_veg, mi.is_available,
              mi.restaurant_id,
              r.name AS restaurant_name, r.is_open, r.is_active
       FROM menu_items mi JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE mi.id = $1`,
      [menu_item_id]
    );

    const item = rows[0];
    if (!item) return notFound(res, 'Menu item not found');
    if (!item.is_available) return badRequest(res, 'Item is currently unavailable');
    if (!item.is_open || !item.is_active) return badRequest(res, `${item.restaurant_name} is currently closed`);

    const cart = await getCart(req.user.id);

    // Enforce max restaurants
    const restIds = new Set(Object.values(cart.items).map(i => i.restaurant_id));
    if (!restIds.has(item.restaurant_id) && restIds.size >= MAX_RESTAURANTS) {
      return badRequest(res, `You can order from at most ${MAX_RESTAURANTS} restaurants in one order`);
    }

    // Enforce max total items
    const totalQty = Object.values(cart.items).reduce((s, i) => s + i.quantity, 0);
    if (totalQty + quantity > MAX_ITEMS) {
      return badRequest(res, `Cart cannot exceed ${MAX_ITEMS} items`);
    }

    // Upsert
    if (cart.items[menu_item_id]) {
      cart.items[menu_item_id].quantity += quantity;
    } else {
      cart.items[menu_item_id] = {
        menu_item_id: item.id,
        name: item.name,
        price: parseFloat(item.price),
        is_veg: item.is_veg,
        quantity,
        restaurant_id: item.restaurant_id,
        restaurant_name: item.restaurant_name,
      };
    }

    await setCart(req.user.id, cart);
    return ok(res, { cart: enrichCart(cart) });
  }
);

// ── PATCH /cart/items/:menuItemId ─────────────────────────────────────────────

router.patch(
  '/items/:menuItemId',
  [body('quantity').isInt({ min: 0, max: 20 })],
  validate,
  async (req, res) => {
    const { menuItemId } = req.params;
    const { quantity } = req.body;
    const cart = await getCart(req.user.id);

    if (!cart.items[menuItemId]) return notFound(res, 'Item not in cart');

    if (quantity === 0) {
      delete cart.items[menuItemId];
    } else {
      cart.items[menuItemId].quantity = quantity;
    }

    await setCart(req.user.id, cart);
    return ok(res, { cart: enrichCart(cart) });
  }
);

// ── DELETE /cart ──────────────────────────────────────────────────────────────

router.delete('/', async (req, res) => {
  await clearCart(req.user.id);
  return ok(res, { message: 'Cart cleared' });
});

// ── Helper: compute totals ────────────────────────────────────────────────────

function enrichCart(cart) {
  const items = Object.values(cart.items || {});
  const byRestaurant = {};

  items.forEach(i => {
    if (!byRestaurant[i.restaurant_id]) {
      byRestaurant[i.restaurant_id] = {
        restaurant_id: i.restaurant_id,
        restaurant_name: i.restaurant_name,
        items: [],
        subtotal: 0,
      };
    }
    byRestaurant[i.restaurant_id].items.push(i);
    byRestaurant[i.restaurant_id].subtotal += i.price * i.quantity;
  });

  const restaurantCount = Object.keys(byRestaurant).length;
  const itemsTotal      = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const deliveryFee     = restaurantCount * parseFloat(process.env.DELIVERY_FEE_PER_RESTAURANT || 30);
  const taxAmount       = parseFloat((itemsTotal * parseFloat(process.env.TAX_RATE || 0.05)).toFixed(2));
  const grandTotal      = parseFloat((itemsTotal + deliveryFee + taxAmount).toFixed(2));

  return {
    restaurants: Object.values(byRestaurant),
    restaurantCount,
    itemsTotal,
    deliveryFee,
    taxAmount,
    grandTotal,
    totalItems: items.reduce((s, i) => s + i.quantity, 0),
    updatedAt: cart.updatedAt,
  };
}

module.exports = router;
