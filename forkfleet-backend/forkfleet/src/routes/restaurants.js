const router = require('express').Router();
const { query: dbQuery } = require('../db');
const { ok, notFound, serverError } = require('../utils/response');
const { optionalAuth, authenticate, authorize } = require('../middleware/auth');
const { body, query, param } = require('express-validator');
const { validate } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// ── GET /restaurants ──────────────────────────────────────────────────────────
// Public. Supports: ?city= &cuisine= &search= &open_now=true &page= &limit=

router.get('/', optionalAuth, async (req, res) => {
  const {
    city, cuisine, search,
    open_now, page = 1, limit = 20,
    lat, lng, radius_km = 10,
  } = req.query;

  const offset = (Math.max(1, +page) - 1) * Math.min(50, +limit);
  const params = [];
  const conditions = ['r.is_active = true'];

  if (city) { params.push(`%${city}%`); conditions.push(`r.city ILIKE $${params.length}`); }
  if (cuisine) { params.push(`{${cuisine}}`); conditions.push(`r.cuisine_tags && $${params.length}::text[]`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(r.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.name ILIKE $${params.length}))`); }
  if (open_now === 'true') conditions.push(`r.is_open = true AND CURRENT_TIME BETWEEN r.opens_at AND r.closes_at`);

  const where = conditions.join(' AND ');
  params.push(Math.min(50, +limit), offset);

  try {
    const { rows } = await dbQuery(
      `SELECT r.id, r.name, r.description, r.cuisine_tags, r.address, r.city,
              r.avg_rating, r.total_ratings, r.avg_prep_minutes,
              r.image_url, r.is_open, r.opens_at, r.closes_at,
              r.latitude, r.longitude
       FROM restaurants r
       WHERE ${where}
       ORDER BY r.avg_rating DESC, r.total_ratings DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countRes = await dbQuery(
      `SELECT COUNT(*) FROM restaurants r WHERE ${where}`,
      params.slice(0, -2)
    );

    return ok(res, {
      restaurants: rows,
      pagination: {
        total: parseInt(countRes.rows[0].count),
        page: +page,
        limit: Math.min(50, +limit),
      },
    });
  } catch (err) {
    logger.error('List restaurants error', { error: err.message });
    return serverError(res);
  }
});

// ── GET /restaurants/:id ──────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT r.*, u.name AS owner_name
       FROM restaurants r JOIN users u ON u.id = r.owner_id
       WHERE r.id = $1 AND r.is_active = true`,
      [req.params.id]
    );
    if (!rows.length) return notFound(res, 'Restaurant not found');
    return ok(res, { restaurant: rows[0] });
  } catch (err) {
    return serverError(res);
  }
});

// ── GET /restaurants/:id/menu ─────────────────────────────────────────────────

router.get('/:id/menu', async (req, res) => {
  try {
    // Categories
    const cats = await dbQuery(
      `SELECT id, name, sort_order FROM menu_categories
       WHERE restaurant_id = $1 AND is_active = true ORDER BY sort_order`,
      [req.params.id]
    );

    // Items
    const items = await dbQuery(
      `SELECT id, category_id, name, description, price, is_veg, is_available, image_url, sort_order
       FROM menu_items
       WHERE restaurant_id = $1 AND is_available = true
       ORDER BY sort_order`,
      [req.params.id]
    );

    // Group items under their category
    const catMap = {};
    cats.rows.forEach(c => { catMap[c.id] = { ...c, items: [] }; });
    const uncategorised = { id: null, name: 'Other', items: [] };

    items.rows.forEach(item => {
      const cat = catMap[item.category_id];
      (cat || uncategorised).items.push(item);
    });

    const menu = Object.values(catMap);
    if (uncategorised.items.length) menu.push(uncategorised);

    return ok(res, { menu });
  } catch (err) {
    return serverError(res);
  }
});

// ── POST /restaurants (owner/admin only) ─────────────────────────────────────

router.post(
  '/',
  authenticate,
  authorize('restaurant_owner', 'admin'),
  [
    body('name').trim().notEmpty(),
    body('address').trim().notEmpty(),
    body('city').trim().notEmpty(),
    body('pincode').trim().notEmpty(),
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
    body('phone').isMobilePhone(),
  ],
  validate,
  async (req, res) => {
    const { name, description, cuisine_tags = [], address, city, pincode, latitude, longitude, phone, email } = req.body;
    try {
      const { rows } = await dbQuery(
        `INSERT INTO restaurants (owner_id, name, description, cuisine_tags, address, city, pincode, latitude, longitude, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.user.id, name, description, cuisine_tags, address, city, pincode, latitude, longitude, phone, email]
      );
      return ok(res, { restaurant: rows[0] }, 201);
    } catch (err) {
      return serverError(res);
    }
  }
);

// ── POST /restaurants/:id/menu-items ─────────────────────────────────────────

router.post(
  '/:id/menu-items',
  authenticate,
  authorize('restaurant_owner', 'admin'),
  [
    body('name').trim().notEmpty(),
    body('price').isFloat({ min: 0 }),
    body('is_veg').isBoolean(),
  ],
  validate,
  async (req, res) => {
    const { name, description, price, is_veg, category_id, image_url } = req.body;

    // Ensure requester owns this restaurant
    const ownership = await dbQuery('SELECT id FROM restaurants WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
    if (!ownership.rows.length && req.user.role !== 'admin') {
      const { forbidden } = require('../utils/response');
      return forbidden(res, 'You do not own this restaurant');
    }

    const { rows } = await dbQuery(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, is_veg, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, category_id || null, name, description, Math.round(price * 100) / 100, is_veg, image_url]
    );
    return ok(res, { item: rows[0] }, 201);
  }
);

module.exports = router;
