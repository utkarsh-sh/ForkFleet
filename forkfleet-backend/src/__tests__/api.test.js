/**
 * ForkFleet — Integration Tests
 * Run: npm test
 *
 * These tests cover the full happy path + critical failure cases
 * for auth, cart, and the multi-restaurant order splitting flow.
 */

const request = require('supertest');
const { app } = require('../server');
const db = require('../db');
const { redis } = require('../db/redis');

// ── Test state shared across tests ────────────────────────────────────────────
let accessToken = '';
let userId = '';
let restaurantId1 = '';
let restaurantId2 = '';
let menuItemId1 = '';
let menuItemId2 = '';
let orderId = '';

const testPhone = `+9199${Date.now().toString().slice(-8)}`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const api = (path) => `/api/v1${path}`;
const auth = () => ({ Authorization: `Bearer ${accessToken}` });

afterAll(async () => {
  // Clean up test data
  if (userId) {
    await db.query('DELETE FROM orders WHERE customer_id = $1', [userId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  }
  await redis.quit();
  const { pool } = require('../db');
  await pool.end();
});

// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════

describe('Auth', () => {
  test('POST /auth/register — creates new user', async () => {
    const res = await request(app)
      .post(api('/auth/register'))
      .send({ phone: testPhone, name: 'Test User', password: 'testpass123' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.phone).toBe(testPhone);

    accessToken = res.body.data.accessToken;
    userId = res.body.data.user.id;
  });

  test('POST /auth/register — duplicate phone rejected', async () => {
    const res = await request(app)
      .post(api('/auth/register'))
      .send({ phone: testPhone, name: 'Dup User', password: 'testpass123' });
    expect(res.status).toBe(400);
  });

  test('POST /auth/login — valid credentials', async () => {
    const res = await request(app)
      .post(api('/auth/login'))
      .send({ phone: testPhone, password: 'testpass123' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    accessToken = res.body.data.accessToken; // refresh token
  });

  test('POST /auth/login — wrong password rejected', async () => {
    const res = await request(app)
      .post(api('/auth/login'))
      .send({ phone: testPhone, password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  test('GET protected route without token — 401', async () => {
    const res = await request(app).get(api('/cart'));
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════
// RESTAURANTS
// ════════════════════════════════════════════════════════════

describe('Restaurants', () => {
  beforeAll(async () => {
    // Seed two restaurants + menu items directly for test isolation
    const ownerRes = await db.query(
      `INSERT INTO users (phone, name, role, password_hash)
       VALUES ('+91880${Date.now().toString().slice(-7)}','Test Owner','restaurant_owner','x')
       RETURNING id`
    );
    const ownerId = ownerRes.rows[0].id;

    const r1 = await db.query(
      `INSERT INTO restaurants (owner_id, name, cuisine_tags, address, city, pincode, latitude, longitude, phone)
       VALUES ($1,'Test Restaurant A','{"north-indian"}','1 Test St','Delhi','110001',28.63,77.21,'+910000000001')
       RETURNING id`,
      [ownerId]
    );
    restaurantId1 = r1.rows[0].id;

    const r2 = await db.query(
      `INSERT INTO restaurants (owner_id, name, cuisine_tags, address, city, pincode, latitude, longitude, phone)
       VALUES ($1,'Test Restaurant B','{"chinese"}','2 Test Ave','Delhi','110001',28.64,77.22,'+910000000002')
       RETURNING id`,
      [ownerId]
    );
    restaurantId2 = r2.rows[0].id;

    const m1 = await db.query(
      `INSERT INTO menu_items (restaurant_id, name, description, price, is_veg) VALUES ($1,'Test Item A','Desc',150,true) RETURNING id`,
      [restaurantId1]
    );
    menuItemId1 = m1.rows[0].id;

    const m2 = await db.query(
      `INSERT INTO menu_items (restaurant_id, name, description, price, is_veg) VALUES ($1,'Test Item B','Desc',200,false) RETURNING id`,
      [restaurantId2]
    );
    menuItemId2 = m2.rows[0].id;
  });

  test('GET /restaurants — returns list', async () => {
    const res = await request(app).get(api('/restaurants'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.restaurants)).toBe(true);
  });

  test('GET /restaurants?city=Delhi — filters by city', async () => {
    const res = await request(app).get(api('/restaurants?city=Delhi'));
    expect(res.status).toBe(200);
    res.body.data.restaurants.forEach(r => {
      expect(r.city.toLowerCase()).toContain('delhi');
    });
  });

  test('GET /restaurants/:id — returns restaurant detail', async () => {
    const res = await request(app).get(api(`/restaurants/${restaurantId1}`));
    expect(res.status).toBe(200);
    expect(res.body.data.restaurant.id).toBe(restaurantId1);
  });

  test('GET /restaurants/:id/menu — returns categorised menu', async () => {
    const res = await request(app).get(api(`/restaurants/${restaurantId1}/menu`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.menu)).toBe(true);
  });

  test('GET /restaurants/nonexistent-id — 404', async () => {
    const res = await request(app).get(api('/restaurants/00000000-0000-0000-0000-000000000000'));
    expect(res.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════
// CART
// ════════════════════════════════════════════════════════════

describe('Cart', () => {
  beforeEach(async () => {
    // Clear cart before each cart test
    await request(app).delete(api('/cart')).set(auth());
  });

  test('GET /cart — returns empty cart for new user', async () => {
    const res = await request(app).get(api('/cart')).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.cart.totalItems).toBe(0);
  });

  test('POST /cart/items — adds item from restaurant 1', async () => {
    const res = await request(app)
      .post(api('/cart/items'))
      .set(auth())
      .send({ menu_item_id: menuItemId1, quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.cart.totalItems).toBe(2);
    expect(res.body.data.cart.restaurantCount).toBe(1);
  });

  test('POST /cart/items — adds item from restaurant 2 (multi-restaurant)', async () => {
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId1, quantity: 1 });

    const res = await request(app)
      .post(api('/cart/items'))
      .set(auth())
      .send({ menu_item_id: menuItemId2, quantity: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data.cart.restaurantCount).toBe(2);
    // Delivery fee should be 2 × ₹30 = ₹60
    expect(res.body.data.cart.deliveryFee).toBe(60);
  });

  test('PATCH /cart/items/:id — updates quantity', async () => {
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId1, quantity: 3 });

    const res = await request(app)
      .patch(api(`/cart/items/${menuItemId1}`))
      .set(auth())
      .send({ quantity: 1 });

    expect(res.status).toBe(200);
    const item = res.body.data.cart.restaurants
      .flatMap(r => r.items)
      .find(i => i.menu_item_id === menuItemId1);
    expect(item.quantity).toBe(1);
  });

  test('PATCH /cart/items/:id with quantity 0 — removes item', async () => {
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId1, quantity: 1 });
    const res = await request(app)
      .patch(api(`/cart/items/${menuItemId1}`))
      .set(auth()).send({ quantity: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.cart.totalItems).toBe(0);
  });

  test('POST /cart/items — invalid UUID rejected', async () => {
    const res = await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: 'not-a-uuid', quantity: 1 });
    expect(res.status).toBe(400);
  });

  test('Cart totals are computed correctly', async () => {
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId1, quantity: 2 }); // 2 × ₹150 = ₹300
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId2, quantity: 1 }); // 1 × ₹200 = ₹200

    const res = await request(app).get(api('/cart')).set(auth());
    const cart = res.body.data.cart;

    expect(cart.itemsTotal).toBe(500);           // 300 + 200
    expect(cart.deliveryFee).toBe(60);           // 2 restaurants × ₹30
    expect(cart.taxAmount).toBeCloseTo(25, 0);   // 5% of 500
    expect(cart.grandTotal).toBeCloseTo(585, 0); // 500 + 60 + 25
  });
});

// ════════════════════════════════════════════════════════════
// ORDERS — Multi-restaurant split
// ════════════════════════════════════════════════════════════

describe('Orders — multi-restaurant split', () => {
  beforeAll(async () => {
    // Add items from both restaurants to cart
    await request(app).delete(api('/cart')).set(auth());
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId1, quantity: 2 });
    await request(app).post(api('/cart/items')).set(auth())
      .send({ menu_item_id: menuItemId2, quantity: 1 });
  });

  test('POST /orders — creates order with 2 sub-orders', async () => {
    const res = await request(app)
      .post(api('/orders'))
      .set(auth())
      .send({ instructions: 'No spice please' });

    expect(res.status).toBe(201);
    expect(res.body.data.order).toBeTruthy();
    expect(res.body.data.subOrders).toHaveLength(2);
    expect(res.body.data.order.status).toBe('pending_payment');
    expect(res.body.data.order.restaurant_count).toBe(2);

    orderId = res.body.data.order.id;

    // Each sub-order should map to a different restaurant
    const restIds = res.body.data.subOrders.map(s => s.restaurant_id);
    expect(new Set(restIds).size).toBe(2);
  });

  test('Cart is cleared after order placement', async () => {
    const res = await request(app).get(api('/cart')).set(auth());
    expect(res.body.data.cart.totalItems).toBe(0);
  });

  test('GET /orders — lists the new order', async () => {
    const res = await request(app).get(api('/orders')).set(auth());
    expect(res.status).toBe(200);
    const found = res.body.data.orders.find(o => o.id === orderId);
    expect(found).toBeTruthy();
    expect(found.sub_orders).toHaveLength(2);
  });

  test('GET /orders/:id — full order detail with sub-orders + items', async () => {
    const res = await request(app).get(api(`/orders/${orderId}`)).set(auth());
    expect(res.status).toBe(200);
    const order = res.body.data.order;
    expect(order.sub_orders).toHaveLength(2);
    order.sub_orders.forEach(so => {
      expect(so.items).toBeTruthy();
      expect(so.items.length).toBeGreaterThan(0);
    });
  });

  test('PATCH sub-order status — preparing', async () => {
    const orderDetail = await request(app).get(api(`/orders/${orderId}`)).set(auth());
    const subId = orderDetail.body.data.order.sub_orders[0].id;

    // Need restaurant owner token — promote test user temporarily
    await db.query(`UPDATE users SET role='restaurant_owner' WHERE id=$1`, [userId]);
    const loginRes = await request(app).post(api('/auth/login'))
      .send({ phone: testPhone, password: 'testpass123' });
    const ownerToken = loginRes.body.data.accessToken;

    const res = await request(app)
      .patch(api(`/orders/${orderId}/sub-orders/${subId}/status`))
      .set({ Authorization: `Bearer ${ownerToken}` })
      .send({ status: 'preparing' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('preparing');

    // Restore role
    await db.query(`UPDATE users SET role='customer' WHERE id=$1`, [userId]);
  });

  test('POST /orders/:id/cancel — cancels the order', async () => {
    // Re-login to refresh token with customer role
    const loginRes = await request(app).post(api('/auth/login'))
      .send({ phone: testPhone, password: 'testpass123' });
    accessToken = loginRes.body.data.accessToken;

    const res = await request(app)
      .post(api(`/orders/${orderId}/cancel`))
      .set(auth())
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(200);
  });

  test('POST /orders — empty cart returns 400', async () => {
    await request(app).delete(api('/cart')).set(auth());
    const res = await request(app).post(api('/orders')).set(auth()).send({});
    expect(res.status).toBe(400);
  });
});
