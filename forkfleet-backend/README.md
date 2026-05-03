# ForkFleet Backend API

Multi-restaurant food ordering platform — one cart, any restaurant, one checkout.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 18+ | Async I/O handles parallel kitchen notifications |
| Framework | Express 4 | Minimal, battle-tested, easy to extend |
| Database | PostgreSQL 15 | ACID transactions for atomic order splitting |
| Cache / Sessions | Redis 7 | Cart sessions, real-time pub/sub |
| Real-time | Socket.IO | Order tracking without polling |
| Payments | Razorpay | Best-in-class India payment gateway |
| Auth | JWT (access + refresh) | Stateless, scalable |

---

## Project structure

```
forkfleet/
├── src/
│   ├── server.js            ← Express app + HTTP server entry point
│   ├── routes/
│   │   ├── auth.js          ← Register, login, refresh, logout
│   │   ├── restaurants.js   ← List, search, menu, CRUD (owner)
│   │   ├── cart.js          ← Redis-backed per-user cart
│   │   └── orders.js        ← Checkout, status, history, Razorpay webhook
│   ├── services/
│   │   └── orderSplitting.js ← Core: splits cart → sub-orders atomically
│   ├── middleware/
│   │   ├── auth.js          ← JWT authenticate + authorize
│   │   └── errorHandler.js  ← Global error + validation middleware
│   ├── db/
│   │   ├── index.js         ← PostgreSQL pool + withTransaction helper
│   │   └── redis.js         ← Redis client, cart helpers, pub/sub
│   ├── websocket/
│   │   └── index.js         ← Socket.IO setup + Redis pub/sub bridge
│   └── utils/
│       ├── logger.js        ← Winston structured logging
│       └── response.js      ← Consistent JSON response helpers
├── migrations/
│   ├── 001_init.sql         ← Full schema (tables, indexes, triggers)
│   ├── run.js               ← Migration runner
│   └── seed.js              ← Sample restaurants + menu items
└── .env.example             ← All environment variables documented
```

---

## Quick start

### 1. Prerequisites

```bash
# PostgreSQL 15+
brew install postgresql@15   # macOS
sudo apt install postgresql  # Ubuntu

# Redis 7+
brew install redis           # macOS
sudo apt install redis       # Ubuntu

# Node.js 18+
node --version  # should be v18 or higher
```

### 2. Database setup

```bash
psql -U postgres -c "CREATE DATABASE forkfleet;"
```

### 3. Install and configure

```bash
cd forkfleet
npm install
cp .env.example .env
# Edit .env — set DB_PASSWORD, JWT_SECRET, RAZORPAY keys
```

### 4. Run migrations + seed

```bash
npm run migrate   # creates all tables, indexes, triggers
npm run seed      # adds 3 sample restaurants + menu items
```

### 5. Start the server

```bash
npm run dev       # development with nodemon
npm start         # production
```

Server starts on `http://localhost:4000`

---

## API Reference

All endpoints are prefixed with `/api/v1`.

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Login, get tokens |
| POST | `/auth/refresh` | — | Refresh access token |
| POST | `/auth/logout` | ✓ | Invalidate refresh tokens |

**Register**
```json
POST /api/v1/auth/register
{
  "phone": "+919876543210",
  "name": "Arjun Mehta",
  "password": "securepass123",
  "email": "arjun@example.com"   // optional
}
```

**Response**
```json
{
  "success": true,
  "data": {
    "user": { "id": "uuid", "name": "Arjun Mehta", "phone": "+919876543210", "role": "customer" },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  }
}
```

---

### Restaurants

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/restaurants` | — | List + filter restaurants |
| GET | `/restaurants/:id` | — | Restaurant detail |
| GET | `/restaurants/:id/menu` | — | Full menu by category |
| POST | `/restaurants` | owner | Create restaurant |
| POST | `/restaurants/:id/menu-items` | owner | Add menu item |

**List with filters**
```
GET /api/v1/restaurants?city=Delhi&cuisine=north-indian&open_now=true&page=1&limit=20
```

---

### Cart (Redis-backed, expires in 1 hour)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/cart` | ✓ | Get cart with computed totals |
| POST | `/cart/items` | ✓ | Add item (any restaurant) |
| PATCH | `/cart/items/:menuItemId` | ✓ | Update quantity (0 = remove) |
| DELETE | `/cart` | ✓ | Clear entire cart |

**Add item**
```json
POST /api/v1/cart/items
Authorization: Bearer <token>
{
  "menu_item_id": "uuid-of-menu-item",
  "quantity": 2
}
```

**Cart response**
```json
{
  "success": true,
  "data": {
    "cart": {
      "restaurants": [
        {
          "restaurant_id": "uuid",
          "restaurant_name": "Bukhara Tandoor",
          "subtotal": 640,
          "items": [{ "menu_item_id": "...", "name": "Butter Chicken", "price": 320, "quantity": 2 }]
        },
        {
          "restaurant_id": "uuid2",
          "restaurant_name": "Dragon Palace",
          "subtotal": 180,
          "items": [{ "menu_item_id": "...", "name": "Veg Fried Rice", "price": 180, "quantity": 1 }]
        }
      ],
      "restaurantCount": 2,
      "itemsTotal": 820,
      "deliveryFee": 60,
      "taxAmount": 41,
      "grandTotal": 921,
      "totalItems": 3
    }
  }
}
```

---

### Orders

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/orders` | ✓ customer | Place order from cart |
| GET | `/orders` | ✓ | Order history |
| GET | `/orders/:id` | ✓ | Full order detail |
| PATCH | `/orders/:id/sub-orders/:subId/status` | ✓ owner/rider | Update kitchen status |
| POST | `/orders/:id/cancel` | ✓ | Cancel order |
| POST | `/orders/webhook/razorpay` | webhook | Razorpay payment events |

**Place order**
```json
POST /api/v1/orders
Authorization: Bearer <token>
{
  "delivery_address_id": "uuid",   // optional
  "instructions": "Extra napkins"  // optional
}
```

**Order response**
```json
{
  "success": true,
  "data": {
    "order": {
      "id": "uuid",
      "status": "pending_payment",
      "restaurant_count": 2,
      "items_total": 82000,
      "delivery_fee": 6000,
      "tax_amount": 4100,
      "grand_total": 92100
    },
    "subOrders": [
      { "id": "sub-uuid-1", "restaurant_id": "...", "status": "confirmed", "subtotal": 64000 },
      { "id": "sub-uuid-2", "restaurant_id": "...", "status": "confirmed", "subtotal": 18000 }
    ],
    "payment": {
      "razorpay_order_id": "order_xxx",
      "amount": 92100,
      "currency": "INR",
      "key_id": "rzp_test_xxx"
    }
  }
}
```

> All monetary values are in **paise** (₹1 = 100 paise) to avoid float precision issues.

---

### Real-time tracking (WebSocket)

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000', {
  auth: { token: accessToken }
});

// Subscribe to order updates
socket.emit('track_order', { order_id: 'your-order-uuid' });

// Receive live updates
socket.on('order_update', (event) => {
  console.log(event);
  // { event: 'sub_order_status_updated', subOrderId, status: 'ready', restaurantId }
  // { event: 'payment_confirmed', orderId }
  // { event: 'order_cancelled', orderId }
});
```

---

## Order splitting — how it works

```
Customer cart (2 restaurants)
        │
        ▼
POST /orders
        │
        ├─ Validate all items against live DB (price, availability, open status)
        ├─ Group items by restaurant_id
        ├─ Compute: items_total + delivery_fee (₹30×n) + tax (5%)
        │
        └─ BEGIN TRANSACTION ──────────────────────────────────────────────────
              INSERT orders (parent)
              INSERT sub_orders × 2      (one per restaurant, status=confirmed)
              INSERT order_items × n     (line items under each sub_order)
              INSERT delivery_jobs       (pickup_sequence = [rest1, rest2])
           COMMIT ──────────────────────────────────────────────────────────────
        │
        ├─ Create Razorpay order (grand_total paise)
        ├─ Clear Redis cart
        └─ Publish order_created event → WebSocket → customer screen
```

When the Razorpay webhook fires `payment.captured`:
- Payment record updated → `captured`
- Parent order → `confirmed`
- `restaurant_payouts` rows created for each sub-order (85% net after 15% commission)
- Each restaurant's dashboard receives a WebSocket push

---

## Running tests

```bash
npm test
```

Tests cover: auth flow, cart operations, multi-restaurant order creation, sub-order status updates, cancellation, and error cases.

---

## Health check

```
GET /health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "db": "ok",
  "redis": "ok",
  "timestamp": "2026-03-27T10:00:00.000Z"
}
```

---

## Production checklist

- [ ] Set strong `JWT_SECRET` (64+ random chars)
- [ ] Set real `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
- [ ] Set `RAZORPAY_WEBHOOK_SECRET` and register webhook URL in Razorpay dashboard
- [ ] Set `NODE_ENV=production`
- [ ] Configure PostgreSQL with connection pooling (PgBouncer recommended at scale)
- [ ] Configure Redis with `requirepass` and TLS
- [ ] Set up PM2 or Docker for process management
- [ ] Add Nginx reverse proxy with SSL termination
- [ ] Set `CLIENT_ORIGIN` to your actual frontend domain
- [ ] Configure log aggregation (Datadog, Logtail, or CloudWatch)
- [ ] Set up DB backups (pg_dump on cron or AWS RDS automated backups)
