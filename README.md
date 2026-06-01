<div align="center">

<img src="https://img.shields.io/badge/version-2.0.0-E8522A?style=for-the-badge&labelColor=12110f" alt="version"/>
<img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=12110f" alt="node"/>
<img src="https://img.shields.io/badge/PostgreSQL-15-4169E1?style=for-the-badge&logo=postgresql&logoColor=white&labelColor=12110f" alt="postgres"/>
<img src="https://img.shields.io/badge/Redis-7-DC382D?style=for-the-badge&logo=redis&logoColor=white&labelColor=12110f" alt="redis"/>
<img src="https://img.shields.io/badge/Razorpay-Integrated-0E6CF2?style=for-the-badge&labelColor=12110f" alt="razorpay"/>
<img src="https://img.shields.io/badge/license-MIT-2ECC71?style=for-the-badge&labelColor=12110f" alt="license"/>

<br/><br/>

```
  ______         _     ______ _           _   
 |  ____|       | |   |  ____| |         | |  
 | |__ ___  _ __| | __| |__  | | ___  ___| |_ 
 |  __/ _ \| '__| |/ /|  __| | |/ _ \/ _ \ __|
 | | | (_) | |  |   < | |   | |  __/  __/ |_ 
 |_|  \___/|_|  |_|\_\|_|   |_|\___|\___|\__|
```

### **Order from any restaurant. One cart. One payment. One delivery.**

*The multi-restaurant food ordering platform that lets customers mix dishes from different kitchens — biryani, pizza, dim sum — all in a single checkout.*

<br/>

[🚀 Live Demo](#-quick-start) · [📖 API Docs](#-api-reference) · [🏗️ Architecture](#️-architecture) · [🤝 Contributing](#-contributing)

</div>

---

## 📋 Table of Contents

- [Why ForkFleet?](#-why-forkfleet)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Architecture](#️-architecture)
- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Running the Project](#-running-the-project)
- [Environment Variables](#-environment-variables)
- [API Reference](#-api-reference)
- [Database Schema](#-database-schema)
- [Payment Integration](#-payment-integration)
- [Testing](#-testing)
- [Build & Deployment](#-build--deployment)
- [Contributing](#-contributing)
- [Coding Conventions](#-coding-conventions)
- [Known Issues & Roadmap](#-known-issues--roadmap)
- [License](#-license)

---

## 🔥 Why ForkFleet?

Every major food delivery app — Zomato, Swiggy — forces you into **one restaurant per order**. Browse a second restaurant and your cart gets wiped.

ForkFleet solves this with a purpose-built **Order Splitting Engine** that atomically:

- Accepts **one payment** from the customer
- Splits the order into **per-restaurant sub-orders**
- Notifies **multiple kitchens in parallel**
- Assigns **one rider** for sequential or hub pickup
- Settles **individual payouts** to each restaurant via Razorpay Route

> Think of it as a food court — but in your pocket.

---

## ✨ Features

### 🛒 Customer App
| Feature | Description |
|---|---|
| **Multi-Restaurant Cart** | Add items from any number of restaurants into one cart |
| **GPS Location** | Auto-detects location via browser Geolocation API + Nominatim reverse geocoding |
| **Near Me Filter** | Haversine distance calculation shows restaurants within 8km |
| **Unified Checkout** | One payment for all restaurants via Razorpay |
| **Live Order Tracking** | Real-time status updates via WebSocket |
| **Auth System** | Sign in / register with localStorage persistence |

### 🍳 Restaurant Dashboard
| Feature | Description |
|---|---|
| **Live Order Queue** | Kanban board: New → Preparing → Ready |
| **Kitchen Checklist** | Item-by-item prep tracking with progress bar |
| **Menu Management** | Add, edit, delete items; toggle availability live |
| **Revenue Analytics** | Daily/weekly/monthly charts with earnings breakdown |
| **Multi-Account Login** | Per-restaurant login with session persistence |

### 🛵 Rider PWA
| Feature | Description |
|---|---|
| **Online/Offline Toggle** | Go live to start receiving orders |
| **Smart Job Cards** | Multi-stop cards with auto-decline countdown (30s) |
| **Sequential Pickup Map** | Animated canvas map showing route |
| **Items Checklist** | Verify items before marking collected |
| **OTP Delivery** | 4-digit OTP confirmation for secure handoff |
| **Earnings Tracker** | Real-time daily/weekly earnings dashboard |

### ⚙️ Backend API
| Feature | Description |
|---|---|
| **Order Splitting Engine** | Atomic PostgreSQL transaction splits one order into N sub-orders |
| **Razorpay Integration** | Full payment flow with signature verification + Route payouts |
| **WebSocket Events** | Socket.IO + Redis pub/sub for real-time updates |
| **JWT Authentication** | Access + refresh token rotation |
| **Rate Limiting** | Per-IP and per-user request throttling |
| **Webhook Idempotency** | Duplicate webhook prevention via `webhook_events` table |

---

## 🛠 Tech Stack

```
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND           BACKEND            DATA              INFRA│
│                                                             │
│  Vanilla JS         Node.js 18+        PostgreSQL 15     Docker│
│  HTML5 + CSS3       Express 4          Redis 7          Nginx │
│  Socket.IO Client   Socket.IO Server   pg (node-postgres)    │
│  Razorpay SDK       JWT (jsonwebtoken) Redis GEORADIUS       │
│  Nominatim API      bcrypt             Razorpay Route   GitHub│
│  Geolocation API    Winston (logging)  13 tables + views Actions│
│                     Helmet + CORS      Atomic transactions    │
└─────────────────────────────────────────────────────────────┘
```

### Full Dependency List

**Backend (`forkfleet-backend/package.json`)**

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.18 | HTTP server & routing |
| `pg` | ^8.11 | PostgreSQL client |
| `ioredis` | ^5.3 | Redis client |
| `socket.io` | ^4.7 | Real-time WebSocket server |
| `jsonwebtoken` | ^9.0 | JWT auth tokens |
| `bcrypt` | ^5.1 | Password hashing |
| `razorpay` | ^2.9 | Payment gateway SDK |
| `express-validator` | ^7.0 | Request validation |
| `express-rate-limit` | ^7.1 | API rate limiting |
| `helmet` | ^7.1 | Security headers |
| `cors` | ^2.8 | Cross-origin requests |
| `winston` | ^3.11 | Structured logging |
| `compression` | ^1.7 | Response compression |
| `morgan` | ^1.10 | HTTP request logging |
| `dotenv` | ^16.3 | Environment config |

---

## 📁 Project Structure

```
ForkFleet/
│
├── forkfleet-backend/              # Node.js REST API + WebSocket server
│   ├── src/
│   │   ├── server.js               # Express app entry point
│   │   ├── db/
│   │   │   ├── index.js            # PostgreSQL pool + withTransaction()
│   │   │   └── redis.js            # Redis client + cart helpers + pub/sub
│   │   ├── routes/
│   │   │   ├── auth.js             # POST /register, /login, /refresh, /logout
│   │   │   ├── restaurants.js      # GET /list, /search, owner CRUD
│   │   │   ├── cart.js             # Redis-backed cart operations
│   │   │   ├── orders.js           # Checkout, history, cancel, webhook
│   │   │   ├── payments.js         # Razorpay initiate, verify, refund
│   │   │   └── riders.js           # Status, location, job accept/advance
│   │   ├── payments/
│   │   │   ├── razorpay.service.js # Core payment logic + Route transfers
│   │   │   └── webhook.handler.js  # Idempotent Razorpay webhook processor
│   │   ├── services/
│   │   │   └── orderSplitting.js   # ⚡ Atomic multi-restaurant split engine
│   │   ├── middleware/
│   │   │   ├── auth.js             # JWT authenticate + role authorize
│   │   │   └── errorHandler.js     # Global error + validation handler
│   │   ├── websocket/
│   │   │   └── index.js            # Socket.IO + Redis pub/sub bridge
│   │   └── utils/
│   │       ├── logger.js           # Winston structured logger
│   │       └── response.js         # Consistent JSON response helpers
│   ├── migrations/
│   │   ├── 001_init.sql            # 13 tables, indexes, triggers
│   │   ├── 002_payments.sql        # Webhook events, payout views
│   │   ├── run.js                  # Migration runner
│   │   └── seed.js                 # 3 restaurants + test user
│   └── package.json
│
├── forkfleet-payments/             # Standalone payment module docs
│   ├── razorpay.service.js
│   ├── webhook.handler.js
│   ├── payments.routes.js
│   ├── SERVER_PATCH.js             # Integration guide for server.js
│   ├── checkout.html               # Frontend checkout widget
│   └── 002_payments.sql
│
├── forkfleet-rider/                # Rider PWA source
│
├── forkfleet-dashboard-v2.html    # Restaurant owner dashboard
├── forkfleet.html                  # Customer-facing app
├── vercel.json                     # Vercel deployment config
└── README.md
```

---

## 🏗️ Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                │
│                                                                      │
│   ┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐  │
│   │  Customer App │   │ Restaurant Dashboard│   │   Rider PWA      │  │
│   │  (HTML/JS)   │   │    (HTML/JS)       │   │  (HTML/JS/PWA)  │  │
│   └──────┬───────┘   └────────┬──────────┘   └───────┬──────────┘  │
└──────────│─────────────────────│────────────────────────│────────────┘
           │  REST + WebSocket   │  REST + WebSocket      │  REST + WS
           ▼                     ▼                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        API LAYER  :4000                              │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │              Express.js + Socket.IO Server                  │    │
│   │                                                             │    │
│   │  /auth  /cart  /orders  /payments  /restaurants  /riders   │    │
│   └───────────────────────────┬────────────────────────────────┘    │
└───────────────────────────────│──────────────────────────────────────┘
                                │
              ┌─────────────────┼────────────────────┐
              ▼                 ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────────┐
│  PostgreSQL 15  │  │    Redis 7       │  │   Razorpay API       │
│                 │  │                  │  │                      │
│  • 13 tables   │  │  • Cart (TTL)   │  │  • Payment orders    │
│  • ACID txns   │  │  • Pub/Sub      │  │  • Route transfers   │
│  • Row locks   │  │  • GEORADIUS    │  │  • Webhook events    │
│  • Triggers    │  │  • Sessions     │  │  • Refunds           │
└─────────────────┘  └─────────────────┘  └──────────────────────┘
```

### Order Splitting Flow

```
Customer clicks "Place Order"
         │
         ▼
POST /api/v1/orders
         │
         ▼
┌────────────────────────────────────────────────┐
│           orderSplitting.js                    │
│                                                │
│  1. Re-validate all cart items (price + stock) │
│  2. Group items by restaurant_id               │
│  3. Compute: subtotal + ₹30/rest + 5% GST      │
│  4. BEGIN TRANSACTION ──────────────────────►  │
│     │  INSERT INTO orders (parent)             │
│     │  INSERT INTO sub_orders (per restaurant) │
│     │  INSERT INTO order_items (each item)     │
│     │  INSERT INTO delivery_jobs               │
│     └► COMMIT                                  │
│  5. Create Razorpay payment order              │
│  6. Clear Redis cart                           │
│  7. publishOrderEvent → WebSocket broadcast    │
└────────────────────────────────────────────────┘
         │
         ▼
  Return { razorpay_order_id, key_id } to client
         │
         ▼
   Razorpay checkout modal opens
         │
    Customer pays
         │
    ┌────┴──────────────────┐
    │                       │
    ▼                       ▼
POST /payments/verify   POST /payments/webhook
(client-side)           (Razorpay servers)
    │                       │
    ▼                       ▼
verifySignature()       validateWebhookSignature()
    │                       │ idempotency check
    ▼                       ▼
confirmPayment() ←──── handlePaymentCaptured()
    │
    ▼
triggerRouteTransfer() → Razorpay splits to restaurants
    │
    ▼
publishOrderEvent() → WebSocket → all 3 clients update live
```

### Real-Time Event Flow

```
Restaurant accepts order
        │
        ▼
PATCH /api/v1/orders/:id/sub-orders/:subId/status
        │
        ▼
  DB update: sub_order.status = 'preparing'
        │
        ▼
  redis.publish('order:FF-20481', { event: 'sub_order_status_updated', ... })
        │
        ▼
  Socket.IO server (psubscribe 'order:*')
        │
        ├──► Customer room:  order:FF-20481  → tracking screen updates
        ├──► Restaurant room: restaurant:1   → kitchen board updates
        └──► Rider room:     rider:assigned  → pickup alert fires
```

---

## 🚀 Quick Start

### Try it in 60 seconds (Frontend only)

```bash
# Clone the repo
git clone https://github.com/utkarsh-sh/ForkFleet.git
cd ForkFleet

# Open any app directly in Chrome — no server needed for frontend
# Customer App:
start forkfleet.html                    # Windows
open forkfleet.html                     # macOS

# Restaurant Dashboard:
start forkfleet-dashboard-v2.html

# Rider App:
start forkfleet-rider/index.html
```

**Demo credentials:**
| App | Login | Password |
|---|---|---|
| Customer App | `+919800000001` | `password123` |
| Restaurant Dashboard | `owner@bukhara.com` | `demo1234` |
| Rider App | `+919876543210` | `rider1234` |

**Demo OTP (delivery confirmation):** `2847`

---

## 💻 Installation

### Prerequisites

| Tool | Version | Download |
|---|---|---|
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| PostgreSQL | 15 | [postgresql.org](https://postgresql.org) |
| Redis | 7 | [redis.io](https://redis.io) *(Windows: [Memurai](https://www.memurai.com))* |
| Git | Any | [git-scm.com](https://git-scm.com) |

### Step-by-Step Setup

```bash
# 1. Clone
git clone https://github.com/utkarsh-sh/ForkFleet.git
cd ForkFleet/forkfleet-backend

# 2. Install dependencies
npm install

# 3. Create database
psql -U postgres -c "CREATE DATABASE forkfleet;"

# 4. Run migrations
psql -U postgres -d forkfleet -f migrations/001_init.sql
psql -U postgres -d forkfleet -f migrations/002_payments.sql

# 5. Seed sample data (3 restaurants + test user)
node migrations/seed.js

# 6. Configure environment
cp .env.example .env
# Edit .env with your values (see Environment Variables section)
```

---

## 🏃 Running the Project

### Development

```bash
# Start backend API server
cd forkfleet-backend
node src/server.js

# Verify it's running
curl http://localhost:4000/health
# Expected: {"status":"ok","db":"ok","redis":"ok"}
```

### Production

```bash
# With PM2 (recommended)
npm install -g pm2
pm2 start src/server.js --name forkfleet-api
pm2 save
pm2 startup

# Health check
pm2 status
pm2 logs forkfleet-api
```

### Docker (Coming in v3.0)

```bash
# Build and start all services
docker-compose up -d

# Services started:
# - API server     → localhost:4000
# - PostgreSQL     → localhost:5432
# - Redis          → localhost:6379
# - Nginx          → localhost:80
```

---

## 🔐 Environment Variables

Create `forkfleet-backend/.env` from `.env.example`:

```env
# ── Server ────────────────────────────────────────
NODE_ENV=development
PORT=4000
API_VERSION=v1

# ── PostgreSQL ─────────────────────────────────────
DB_HOST=localhost
DB_PORT=5432
DB_NAME=forkfleet
DB_USER=postgres
DB_PASSWORD=your_password_here
DB_POOL_MIN=2
DB_POOL_MAX=10

# ── Redis ──────────────────────────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_CART_TTL=3600          # Cart expires in 1 hour

# ── JWT ────────────────────────────────────────────
JWT_SECRET=change_this_to_a_long_random_string
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=different_long_random_string
JWT_REFRESH_EXPIRES_IN=30d

# ── Razorpay ───────────────────────────────────────
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_razorpay_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# ── Business Rules ─────────────────────────────────
DELIVERY_FEE_PER_RESTAURANT=30    # ₹30 per restaurant in cart
TAX_RATE=0.05                     # 5% GST
MAX_RESTAURANTS_PER_ORDER=5
MAX_ITEMS_PER_ORDER=50
PLATFORM_COMMISSION_PCT=15        # 15% deducted from restaurant payout

# ── Logging ────────────────────────────────────────
LOG_LEVEL=info
```

> ⚠️ **Never commit `.env` to git.** It's already in `.gitignore`.

---

## 📡 API Reference

### Base URL
```
http://localhost:4000/api/v1
```

### Authentication
All protected endpoints require:
```
Authorization: Bearer <access_token>
```

---

### Auth Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | ❌ | Register new customer |
| `POST` | `/auth/login` | ❌ | Login, get JWT tokens |
| `POST` | `/auth/refresh` | ❌ | Refresh access token |
| `POST` | `/auth/logout` | ✅ | Revoke refresh token |

<details>
<summary><b>POST /auth/register</b></summary>

```json
// Request
{
  "name": "Arjun Mehta",
  "phone": "+919800000001",
  "password": "password123",
  "email": "arjun@example.com"
}

// Response 201
{
  "success": true,
  "data": {
    "user": { "id": "uuid", "name": "Arjun Mehta", "phone": "+919800000001" },
    "access_token": "eyJ...",
    "refresh_token": "eyJ..."
  }
}
```
</details>

<details>
<summary><b>POST /auth/login</b></summary>

```json
// Request
{ "phone": "+919800000001", "password": "password123" }

// Response 200
{
  "success": true,
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "user": { "id": "uuid", "name": "Arjun Mehta", "role": "customer" }
  }
}
```
</details>

---

### Restaurant Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/restaurants` | ❌ | List all restaurants |
| `GET` | `/restaurants/search?q=biryani` | ❌ | Full-text search |
| `GET` | `/restaurants/:id/menu` | ❌ | Get restaurant menu |
| `POST` | `/restaurants` | ✅ owner | Create restaurant |
| `PATCH` | `/restaurants/:id` | ✅ owner | Update restaurant |

---

### Cart Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/cart` | ✅ | Get current cart |
| `POST` | `/cart/items` | ✅ | Add item to cart |
| `PATCH` | `/cart/items/:itemId` | ✅ | Update quantity |
| `DELETE` | `/cart/items/:itemId` | ✅ | Remove item |
| `DELETE` | `/cart` | ✅ | Clear entire cart |

<details>
<summary><b>POST /cart/items</b></summary>

```json
// Request
{
  "menu_item_id": "uuid",
  "quantity": 2
}

// Response 200
{
  "success": true,
  "data": {
    "cart": {
      "items": [...],
      "restaurant_count": 2,
      "subtotal": 64000,
      "delivery_fee": 6000,
      "tax": 3200,
      "grand_total": 73200
    }
  }
}
```
</details>

---

### Order Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/orders` | ✅ | Place order (triggers split) |
| `GET` | `/orders` | ✅ | Order history |
| `GET` | `/orders/:id` | ✅ | Order detail + sub-orders |
| `PATCH` | `/orders/:id/sub-orders/:subId/status` | ✅ owner | Update sub-order status |
| `POST` | `/orders/:id/cancel` | ✅ | Cancel order |

<details>
<summary><b>POST /orders (Place Order)</b></summary>

```json
// Request
{
  "delivery_address_id": "uuid",   // optional
  "instructions": "Ring the bell"  // optional
}

// Response 201
{
  "success": true,
  "data": {
    "order_id": "uuid",
    "sub_orders": [
      { "id": "uuid", "restaurant_id": "uuid", "subtotal": 58000 },
      { "id": "uuid", "restaurant_id": "uuid", "subtotal": 32000 }
    ],
    "grand_total": 96500,
    "razorpay_order_id": "order_xxxxxx",
    "key_id": "rzp_test_xxxxxx"
  }
}
```
</details>

---

### Payment Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/payments/initiate` | ✅ | Create Razorpay order |
| `POST` | `/payments/verify` | ✅ | Verify payment signature |
| `POST` | `/payments/retry` | ✅ | Retry failed payment |
| `POST` | `/payments/refund` | ✅ admin | Issue refund |
| `GET` | `/payments/:orderId` | ✅ | Payment status |
| `GET` | `/payments/payouts/:restId` | ✅ owner | Restaurant earnings |
| `POST` | `/payments/webhook` | ❌ | Razorpay webhook (raw body) |

---

### Rider Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `PATCH` | `/riders/me/status` | ✅ rider | Toggle online/offline |
| `PATCH` | `/riders/location` | ✅ rider | Update GPS coordinates |
| `GET` | `/riders/jobs/available` | ✅ rider | List pending jobs |
| `POST` | `/riders/jobs/:id/accept` | ✅ rider | Accept delivery job |
| `PATCH` | `/riders/jobs/:id/stop` | ✅ rider | Advance stop (arrived/collected/dropped) |
| `GET` | `/riders/me/earnings` | ✅ rider | Earnings summary |

---

### WebSocket Events

Connect via Socket.IO:
```js
const socket = io('http://localhost:4000', {
  auth: { token: 'your_jwt_token' }
});

// Subscribe to an order
socket.emit('track_order', { order_id: 'FF-20481' });

// Listen for updates
socket.on('order_update', (event) => {
  console.log(event.event);  // 'payment_confirmed', 'sub_order_status_updated', etc.
});
```

| Event | Direction | Description |
|---|---|---|
| `order_created` | Server → Client | New order placed |
| `payment_confirmed` | Server → Client | Payment captured |
| `sub_order_status_updated` | Server → Client | Kitchen status change |
| `rider_assigned` | Server → Client | Rider accepted job |
| `rider_location_updated` | Server → Client | GPS update every 5s |
| `order_cancelled` | Server → Client | Order cancelled |
| `refund_processed` | Server → Client | Refund issued |

---

## 🗄️ Database Schema

```
users ──────────────────────────────────────────────────┐
  id (UUID PK), name, phone, email, password_hash, role │
  └── refresh_tokens (user_id FK)                       │
                                                         │
restaurants ──────────────────────────────────────────┐  │
  id (UUID PK), owner_id (FK→users), name, cuisine_tags│  │
  latitude, longitude, razorpay_account_id             │  │
  └── menu_categories (restaurant_id FK)               │  │
      └── menu_items (category_id FK)                  │  │
                                                         │  │
orders ←──────────────────────────────────────────────────┘
  id (UUID PK), customer_id (FK→users), status
  grand_total (paise), restaurant_count
  └── sub_orders (order_id FK, restaurant_id FK)
      ├── order_items (sub_order_id FK, menu_item_id FK)
      └── delivery_jobs (order_id FK, rider_id FK)

payments (order_id FK)
  razorpay_order_id, razorpay_payment_id, amount (paise)
  status, method, captured_at

restaurant_payouts (sub_order_id FK, payment_id FK)
  amount, commission_pct, commission_amt, net_amount
  razorpay_transfer_id, status, settled_at

webhook_events (idempotency table)
  razorpay_event_id (UNIQUE), event_type, status
```

> 💡 **All monetary values are stored in paise** (₹1 = 100 paise) to avoid floating-point errors. This is the industry standard used by Stripe, Razorpay, and all major payment processors.

---

## 💳 Payment Integration

### Setup Razorpay

1. Create account at [dashboard.razorpay.com](https://dashboard.razorpay.com)
2. Go to **Settings → API Keys → Generate Key**
3. Copy Key ID and Secret to `.env`
4. Go to **Settings → Webhooks → Add New**:
   - URL: `https://yourdomain.com/api/v1/payments/webhook`
   - Secret: (generate random string → `RAZORPAY_WEBHOOK_SECRET`)
   - Subscribe to: `payment.captured`, `payment.failed`, `refund.processed`, `transfer.settled`
5. Enable **Razorpay Route** (Products → Route) for split payouts

### Payment Flow

```
1. POST /orders          → creates order (status: pending_payment)
2. POST /payments/initiate → creates Razorpay order, returns key_id
3. [Razorpay modal opens in browser]
4. Customer pays
5. POST /payments/verify → verifies HMAC signature → confirms in DB
6. Razorpay transfers split automatically to restaurants via Route
7. POST /payments/webhook → handles async events (idempotent)
```

### Test Cards

| Card | Number | CVV | Expiry |
|---|---|---|---|
| Visa (success) | `4111 1111 1111 1111` | `111` | Any future |
| Rupay (success) | `6070 6000 0000 0003` | `111` | Any future |
| Card (failure) | `4000 0000 0000 0002` | Any | Any future |
| UPI (success) | `success@razorpay` | — | — |
| UPI (failure) | `failure@razorpay` | — | — |

---

## 🧪 Testing

```bash
cd forkfleet-backend

# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npx jest src/__tests__/api.test.js

# Test individual API endpoints manually
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"+919800000001","password":"password123"}'

# Test health check
curl http://localhost:4000/health
```

### Test Coverage Areas

- [ ] Auth: register, login, token refresh, logout
- [ ] Cart: add items from multiple restaurants, compute totals
- [ ] Orders: place order, verify split into sub-orders
- [ ] Payments: initiate, verify signature, webhook processing
- [ ] Riders: status toggle, job accept, OTP confirm

---

## 🏗️ Build & Deployment

### Vercel (Frontend)

The repo includes `vercel.json` for frontend deployment:

```bash
npm install -g vercel
vercel --prod
```

### Manual Server Deployment

```bash
# 1. Clone on server
git clone https://github.com/utkarsh-sh/ForkFleet.git
cd ForkFleet/forkfleet-backend

# 2. Install production deps
npm install --omit=dev

# 3. Set NODE_ENV
export NODE_ENV=production

# 4. Run migrations
psql -U postgres -d forkfleet -f migrations/001_init.sql
psql -U postgres -d forkfleet -f migrations/002_payments.sql

# 5. Start with PM2
npm install -g pm2
pm2 start src/server.js --name forkfleet --env production
pm2 save && pm2 startup
```

### Docker (v3.0 Roadmap)

```bash
# Coming soon
docker-compose up -d
```

---

## 🤝 Contributing

We love contributions! Here's how to get involved:

### Getting Started

```bash
# 1. Fork the repo on GitHub
# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/ForkFleet.git
cd ForkFleet

# 3. Create a feature branch
git checkout -b feature/your-feature-name

# 4. Make your changes
# 5. Commit with conventional commits (see below)
git commit -m "feat: add restaurant search by cuisine"

# 6. Push and open a PR
git push origin feature/your-feature-name
```

### Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use for |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `style:` | Formatting, no logic change |
| `refactor:` | Code restructure, no feature/fix |
| `test:` | Adding or fixing tests |
| `chore:` | Build process, tooling |

### PR Checklist

- [ ] Code follows the style guide below
- [ ] All existing tests pass (`npm test`)
- [ ] New tests added for new features
- [ ] `.env.example` updated if new env vars added
- [ ] README updated if API changes
- [ ] No secrets or credentials committed

### Reporting Bugs

Open a [GitHub Issue](https://github.com/utkarsh-sh/ForkFleet/issues) with:
- Steps to reproduce
- Expected vs actual behaviour
- Node.js version, OS
- Relevant logs

---

## 📐 Coding Conventions

### JavaScript Style

```js
// ✅ Good — async/await with proper error handling
async function getOrder(orderId) {
  const { rows: [order] } = await db.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );
  if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  return order;
}

// ✅ Good — parameterised queries ALWAYS (prevent SQL injection)
await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

// ❌ Bad — string concatenation in SQL
await db.query(`SELECT * FROM users WHERE phone = '${phone}'`);

// ✅ Good — paise for money, never floats
const totalPaise = Math.round(subtotalPaise * 1.05);  // add 5% GST

// ❌ Bad — floating point money
const total = subtotal * 1.05;
```

### File Naming

```
routes/        → kebab-case.js     (order-history.js)
services/      → camelCase.js      (orderSplitting.js)
middleware/    → camelCase.js      (errorHandler.js)
migrations/    → 001_snake_case.sql
```

### Database Conventions

- Table names: `snake_case`, plural (`orders`, `sub_orders`)
- Column names: `snake_case` (`created_at`, `grand_total`)
- All timestamps: `TIMESTAMPTZ` (timezone-aware)
- All money: `INTEGER` in paise
- All IDs: `UUID` using `uuid_generate_v4()`
- Always use parameterised queries (`$1`, `$2`)

### API Response Format

```js
// Always use utils/response.js helpers:
return ok(res, { order });          // 200
return created(res, { order });     // 201
return badRequest(res, 'message');  // 400
return notFound(res, 'message');    // 404
return serverError(res);            // 500
```

### Environment Variables

- Never hardcode credentials
- All secrets via `.env`
- Validate on startup — crash fast if missing
- Document every variable in `.env.example`

---

## 🐛 Known Issues & Roadmap

### Known Issues

| Issue | Status | Workaround |
|---|---|---|
| Rider GPS on Windows Chrome requires HTTPS | Open | Use `localhost` (exempt) |
| Nominatim rate-limited on high traffic | Open | Falls back to coordinates |
| Socket.IO needs JWT refresh on token expiry | In Progress | Re-login to reconnect |
| No email/SMS OTP — demo uses static `2847` | By Design | Integrate Twilio for production |

### Roadmap

#### v2.1 — Polish (Next)
- [ ] Docker + Nginx deployment config
- [ ] GitHub Actions CI/CD pipeline
- [ ] Email/SMS OTP via Twilio
- [ ] Push notifications via Firebase

#### v3.0 — Scale
- [ ] Microservices split (order-service, payment-service, delivery-service)
- [ ] ML-based delivery route optimisation
- [ ] Real-time demand prediction
- [ ] Multi-city / multi-region PostgreSQL
- [ ] Restaurant self-onboarding portal

#### v4.0 — Platform
- [ ] White-label B2B offering
- [ ] Native iOS/Android apps (React Native)
- [ ] Loyalty points system
- [ ] Group ordering / bill splitting

---

## 📊 Revenue Model

| Stream | Rate | Trigger |
|---|---|---|
| Platform Commission | 15% | Deducted from every restaurant payout |
| Delivery Fee | ₹30 per restaurant | Charged to customer at checkout |
| GST | 5% | Collected on order total |
| Restaurant SaaS | TBD | Advanced analytics, priority listing |

**Unit Economics Example:** ₹820 order (2 restaurants) → ₹123 commission + ₹60 delivery = **₹183 gross platform revenue** per order.

---


<div align="center">

Built with ❤️ in India 🇮🇳

**ForkFleet** — *One order. Any restaurant. One checkout.*

[⭐ Star this repo](https://github.com/utkarsh-sh/ForkFleet) if you found it useful!

</div>
