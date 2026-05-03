const Redis = require('ioredis');
const logger = require('../utils/logger');

const config = {
  host:     process.env.REDIS_HOST || 'localhost',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => {
    const delay = Math.min(times * 100, 3000);
    logger.warn(`Redis reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
};

// Primary client — commands
const redis = new Redis(config);

// Subscriber client — SUBSCRIBE/PSUBSCRIBE cannot share a connection with commands
const redisSub = new Redis(config);

redis.on('connect',  () => logger.info('Redis connected'));
redis.on('error',    (e) => logger.error('Redis error', { error: e.message }));
redisSub.on('error', (e) => logger.error('Redis subscriber error', { error: e.message }));

// ── Key factories ─────────────────────────────────────────────────────────────
const keys = {
  cart:         (userId)  => `cart:${userId}`,
  orderStatus:  (orderId) => `order:status:${orderId}`,
  subOrderStatus: (subId) => `suborder:status:${subId}`,
  riderLocation:(riderId) => `rider:loc:${riderId}`,
  rateLimitOtp: (phone)   => `rl:otp:${phone}`,
};

const CART_TTL = parseInt(process.env.REDIS_CART_TTL) || 3600;

// ── Cart helpers ──────────────────────────────────────────────────────────────

const getCart = async (userId) => {
  const raw = await redis.get(keys.cart(userId));
  return raw ? JSON.parse(raw) : { items: {}, updatedAt: null };
};

const setCart = async (userId, cart) => {
  await redis.setex(keys.cart(userId), CART_TTL, JSON.stringify({
    ...cart,
    updatedAt: new Date().toISOString(),
  }));
};

const clearCart = async (userId) => {
  await redis.del(keys.cart(userId));
};

// ── Order status cache ────────────────────────────────────────────────────────

const setOrderStatus = async (orderId, status) => {
  await redis.setex(keys.orderStatus(orderId), 86400, JSON.stringify(status));
};

const getOrderStatus = async (orderId) => {
  const raw = await redis.get(keys.orderStatus(orderId));
  return raw ? JSON.parse(raw) : null;
};

// ── Real-time pub/sub for order events ────────────────────────────────────────

const publishOrderEvent = async (orderId, event) => {
  await redis.publish(`order:${orderId}`, JSON.stringify(event));
};

module.exports = {
  redis,
  redisSub,
  keys,
  getCart,
  setCart,
  clearCart,
  setOrderStatus,
  getOrderStatus,
  publishOrderEvent,
};
