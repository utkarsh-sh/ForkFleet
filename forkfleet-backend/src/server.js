
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const { createServer } = require('http');
const { setupWebSocket } = require('./websocket');

const app = express();
const httpServer = createServer(app);


app.use(helmet({ contentSecurityPolicy: false }));
const allowedOrigin = process.env.CORS_ORIGIN || process.env.CLIENT_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(morgan('dev'));

const projectRoot = path.resolve(__dirname, '..', '..');
const mainAppFile = path.join(projectRoot, 'forkfleet.html');
const riderAppFile = path.join(projectRoot, 'forkfleet-rider', 'forkfleet-rider-v2.html');
if (fs.existsSync(mainAppFile)) {
  app.use(express.static(projectRoot));
  app.get('/', (req, res) => res.sendFile(mainAppFile));
  if (fs.existsSync(riderAppFile)) {
    app.get('/forkfleet-rider-v2.html', (req, res) => res.sendFile(riderAppFile));
    app.get('/rider', (req, res) => res.sendFile(riderAppFile));
  }
}


app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

const authRoutes       = require('./routes/auth');
const restaurantRoutes = require('./routes/restaurants');
const cartRoutes       = require('./routes/cart');
const orderRoutes      = require('./routes/orders');
const paymentRoutes    = require('./routes/payments');
const riderRoutes      = require('./routes/riders');

app.use('/api/v1/auth',        authRoutes);
app.use('/api/v1/restaurants',  restaurantRoutes);
app.use('/api/v1/cart',         cartRoutes);
app.use('/api/v1/orders',       orderRoutes);
app.use('/api/v1/payments',     paymentRoutes);                // ← FIX: was missing
app.use('/api/v1/riders',       riderRoutes);                  // ← FIX: was missing

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    routes: ['auth', 'restaurants', 'cart', 'orders', 'payments', 'riders']
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
});

const io = setupWebSocket(httpServer);
app.set('io', io);

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, () => {
    console.log(`🚀 ForkFleet API running on http://localhost:${PORT}`);
    if (fs.existsSync(mainAppFile)) console.log(`🌐 ForkFleet app: http://localhost:${PORT}/forkfleet.html`);
    if (fs.existsSync(riderAppFile)) console.log(`🛵 ForkFleet rider app: http://localhost:${PORT}/forkfleet-rider-v2.html`);
    console.log(`📡 WebSocket ready`);
    console.log(`💳 Payment webhook: /api/v1/payments/webhook`);
    console.log(`🛵 Rider routes: /api/v1/riders`);
  });
}

module.exports = { app, httpServer };
