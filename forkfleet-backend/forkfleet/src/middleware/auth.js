const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../utils/response');

/**
 * Verify Bearer JWT. Attaches req.user = { id, phone, role } on success.
 */
const authenticate = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return unauthorized(res, 'No token provided');
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, phone: payload.phone, role: payload.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return unauthorized(res, 'Token expired');
    return unauthorized(res, 'Invalid token');
  }
};

/**
 * Factory: restrict to specific roles.
 * Usage: authorize('admin') or authorize('restaurant_owner', 'admin')
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return unauthorized(res);
  if (!roles.includes(req.user.role)) {
    return forbidden(res, 'Insufficient permissions');
  }
  next();
};

/**
 * Optional auth — attaches req.user if token present, otherwise continues.
 */
const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      req.user = { id: payload.sub, phone: payload.phone, role: payload.role };
    } catch (_) {}
  }
  next();
};

module.exports = { authenticate, authorize, optionalAuth };
