const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body } = require('express-validator');
const db = require('../db');
const { ok, created, badRequest, unauthorized, serverError } = require('../utils/response');
const { validate } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// ── Token helpers ─────────────────────────────────────────────────────────────

const signAccess = (user) =>
  jwt.sign(
    { sub: user.id, phone: user.phone, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

const signRefresh = (userId) =>
  jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });

// ── POST /auth/register ───────────────────────────────────────────────────────

router.post(
  '/register',
  [
    body('phone').isMobilePhone().withMessage('Valid phone number required'),
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2–100 chars'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 chars'),
    body('email').optional().isEmail().normalizeEmail(),
  ],
  validate,
  async (req, res) => {
    const { phone, name, email, password } = req.body;
    try {
      const exists = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (exists.rows.length) return badRequest(res, 'Phone number already registered');

      const hash = await bcrypt.hash(password, 12);
      const { rows } = await db.query(
        `INSERT INTO users (phone, name, email, password_hash, role)
         VALUES ($1,$2,$3,$4,'customer') RETURNING id, phone, name, email, role`,
        [phone, name, email || null, hash]
      );
      const user = rows[0];
      const accessToken  = signAccess(user);
      const refreshToken = signRefresh(user.id);

      // Persist refresh token hash
      const rHash = await bcrypt.hash(refreshToken, 8);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await db.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
        [user.id, rHash, expiresAt]
      );

      logger.info('New user registered', { userId: user.id, phone });
      return created(res, { user: { id: user.id, name: user.name, phone: user.phone, role: user.role }, accessToken, refreshToken });
    } catch (err) {
      logger.error('Register error', { error: err.message });
      return serverError(res);
    }
  }
);

// ── POST /auth/login ──────────────────────────────────────────────────────────

router.post(
  '/login',
  [
    body('phone').isMobilePhone().withMessage('Valid phone required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  validate,
  async (req, res) => {
    const { phone, password } = req.body;
    try {
      const { rows } = await db.query(
        'SELECT id, phone, name, email, role, password_hash, is_active FROM users WHERE phone = $1',
        [phone]
      );
      const user = rows[0];
      if (!user) return unauthorized(res, 'Invalid credentials');
      if (!user.is_active) return unauthorized(res, 'Account suspended');

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return unauthorized(res, 'Invalid credentials');

      const accessToken  = signAccess(user);
      const refreshToken = signRefresh(user.id);

      const rHash = await bcrypt.hash(refreshToken, 8);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await db.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
        [user.id, rHash, expiresAt]
      );

      return ok(res, {
        user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      logger.error('Login error', { error: err.message });
      return serverError(res);
    }
  }
);

// ── POST /auth/refresh ────────────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return badRequest(res, 'Refresh token required');

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const { rows } = await db.query(
      `SELECT rt.token_hash, u.id, u.phone, u.role, u.is_active
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.user_id = $1 AND rt.expires_at > NOW()
       ORDER BY rt.created_at DESC LIMIT 5`,
      [payload.sub]
    );

    let matched = null;
    for (const row of rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) { matched = row; break; }
    }
    if (!matched || !matched.is_active) return unauthorized(res, 'Invalid or expired refresh token');

    const newAccess  = signAccess(matched);
    const newRefresh = signRefresh(matched.id);
    const rHash = await bcrypt.hash(newRefresh, 8);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
      [matched.id, rHash, expiresAt]);

    return ok(res, { accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    return unauthorized(res, 'Invalid refresh token');
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────

router.post('/logout', authenticate, async (req, res) => {
  // Invalidate all refresh tokens for this user (simple but effective)
  await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);
  return ok(res, { message: 'Logged out successfully' });
});

module.exports = router;
