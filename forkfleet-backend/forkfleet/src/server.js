require('dotenv').config();
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { setupWebSocket } = require('./websocket');
const { globalErrorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger = require('./utils/logger');

const app = express();
const server = http.createServer(app);

// ── Security & utilities ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || '*',
  credentials: true,
}));
app.use(compression());
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip: (req) => req.path === '/health',
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
// Razorpay webhook needs the raw body for signature verification
app.use('/api/v1/orders/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,  // stricter for auth endpoints
  message: { success: false, message: 'Too many auth attempts, please try again' },
});

app.use('/api/', apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
const API = `/api/${process.env.API_VERSION || 'v1'}`;

app.use(`${API}/auth`,        authLimiter, require('./routes/auth'));
app.use(`${API}/restaurants`, require('./routes/restaurants'));
app.use(`${API}/cart`,        require('./routes/cart'));
app.use(`${API}/orders`,      require('./routes/orders'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { pool } = require('./db');
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch {}

  const { redis } = require('./db/redis');
  let redisOk = false;
  try { await redis.ping(); redisOk = true; } catch {}

  const status = dbOk && redisOk ? 200 : 503;
  res.status(status).json({
    status: status === 200 ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    db: dbOk ? 'ok' : 'error',
    redis: redisOk ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
  });
});

// ── Error handling ────────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ── WebSocket setup ───────────────────────────────────────────────────────────
setupWebSocket(server);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 4000;
server.listen(PORT, () => {
  logger.info(`ForkFleet API running`, {
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    api: `http://localhost:${PORT}${API}`,
  });
});

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down`);
  server.close(async () => {
    const { pool } = require('./db');
    const { redis, redisSub } = require('./db/redis');
    await pool.end();
    await redis.quit();
    await redisSub.quit();
    logger.info('Server shutdown complete');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { logger.error('Uncaught exception', { error: err.message, stack: err.stack }); process.exit(1); });
process.on('unhandledRejection', (err) => { logger.error('Unhandled rejection', { error: err?.message }); });

module.exports = { app, server };
