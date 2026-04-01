const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { redisSub, redis } = require('../db/redis');
const logger = require('../utils/logger');

/**
 * Attach Socket.IO to the HTTP server and wire up real-time order tracking.
 *
 * Clients connect with:
 *   const socket = io('http://localhost:4000', { auth: { token: '<JWT>' } });
 *   socket.emit('track_order', { order_id: 'xxx' });
 *
 * Server emits back:
 *   socket.on('order_update', (event) => { ... })
 */
function setupWebSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  // ── Auth middleware ───────────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info('WebSocket connected', { userId: socket.user.id, socketId: socket.id });

    // Client subscribes to a specific order's updates
    socket.on('track_order', async ({ order_id }) => {
      if (!order_id) return;

      // Put socket in a room named after the order
      socket.join(`order:${order_id}`);

      // Send cached status immediately if available
      const cached = await redis.get(`order:status:${order_id}`);
      if (cached) {
        socket.emit('order_update', { ...JSON.parse(cached), source: 'cache' });
      }

      logger.info('Client tracking order', { userId: socket.user.id, order_id });
    });

    // Restaurant owner / rider subscribes to their own queue
    socket.on('join_restaurant', ({ restaurant_id }) => {
      if (socket.user.role === 'restaurant_owner' || socket.user.role === 'admin') {
        socket.join(`restaurant:${restaurant_id}`);
      }
    });

    socket.on('join_rider', ({ rider_id }) => {
      if (socket.user.role === 'rider' || socket.user.role === 'admin') {
        socket.join(`rider:${rider_id}`);
      }
    });

    socket.on('disconnect', () => {
      logger.info('WebSocket disconnected', { userId: socket.user.id });
    });
  });

  // ── Redis subscriber — broadcast published events to rooms ────────────────
  redisSub.psubscribe('order:*', (err) => {
    if (err) logger.error('Redis psubscribe failed', { error: err.message });
    else logger.info('Redis order channel subscribed');
  });

  redisSub.on('pmessage', (_pattern, channel, message) => {
    try {
      const orderId = channel.replace('order:', '');
      const event   = JSON.parse(message);

      // Broadcast to all sockets in this order's room
      io.to(`order:${orderId}`).emit('order_update', event);

      // Also notify restaurant rooms if relevant
      if (event.restaurantId) {
        io.to(`restaurant:${event.restaurantId}`).emit('order_update', event);
      }
    } catch (err) {
      logger.error('WebSocket broadcast error', { error: err.message });
    }
  });

  return io;
}

module.exports = { setupWebSocket };
