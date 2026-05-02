/**
 * ForkFleet — server.js integration patch for Razorpay
 *
 * Apply these changes to src/server.js in the order shown.
 * Lines marked ✅ EXISTING are already in your server.js.
 * Lines marked ➕ ADD are new.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Body parsing (CRITICAL ORDER)
// The webhook MUST receive raw bytes — place it BEFORE express.json()
// ─────────────────────────────────────────────────────────────────────────────

// ✅ EXISTING  (somewhere in server.js)
// app.use(express.json({ limit: '1mb' }));

// ➕ ADD — REPLACE the express.json() line with these two lines:

app.use(
  '/api/v1/payments/webhook',
  express.raw({ type: 'application/json' })   // raw bytes for HMAC verification
);
app.use(express.json({ limit: '1mb' }));       // JSON for all other routes


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Mount payment routes
// ─────────────────────────────────────────────────────────────────────────────

// ✅ EXISTING routes block (in server.js)
// app.use(`${API}/auth`,        authLimiter, require('./routes/auth'));
// app.use(`${API}/restaurants`, require('./routes/restaurants'));
// app.use(`${API}/cart`,        require('./routes/cart'));
// app.use(`${API}/orders`,      require('./routes/orders'));
// app.use(`${API}/riders`,      require('./routes/riders'));

// ➕ ADD — payments route
app.use(`${API}/payments`, require('./routes/payments'));


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Required .env variables (add to your .env file)
// ─────────────────────────────────────────────────────────────────────────────

/*
# ── Razorpay ─────────────────────────────────────────────────────────────────
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx          # from Razorpay dashboard
RAZORPAY_KEY_SECRET=your_razorpay_key_secret   # never expose to frontend
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret    # set in Razorpay dashboard webhooks

PLATFORM_COMMISSION_PCT=15                     # % taken from each restaurant order
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Razorpay Dashboard setup checklist
// ─────────────────────────────────────────────────────────────────────────────

/*
1. Create account at dashboard.razorpay.com
2. Generate API Keys → Settings → API Keys
   - Copy Key ID → RAZORPAY_KEY_ID
   - Copy Key Secret → RAZORPAY_KEY_SECRET

3. Configure Webhook → Settings → Webhooks → Add New
   URL:    https://yourdomain.com/api/v1/payments/webhook
   Secret: (generate a random string) → RAZORPAY_WEBHOOK_SECRET
   Events to subscribe:
     ✅ payment.captured
     ✅ payment.failed
     ✅ refund.processed
     ✅ transfer.settled
     ✅ order.paid

4. Enable Razorpay Route → Products → Route
   - Required for split payouts to restaurant bank accounts
   - Each restaurant must be onboarded as a linked account
   - Use POST /api/v1/payments/onboard-restaurant (call rzpService.createLinkedAccount)

5. Test with Razorpay test cards:
   Visa success:   4111 1111 1111 1111  CVV: 111  Exp: any future
   Rupay success:  6070 6000 0000 0003  CVV: 111
   UPI success:    success@razorpay
   Failed payment: 4000 0000 0000 0002
*/


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Full payment flow (sequence)
// ─────────────────────────────────────────────────────────────────────────────

/*
Customer places order
        │
        ▼
POST /api/v1/orders          ← creates order (status: pending_payment) + sub_orders
        │
        ▼
POST /api/v1/payments/initiate  ← creates Razorpay order, returns key_id + rzp_order_id
        │
        ▼
  [Razorpay checkout widget opens in browser]
        │
    Customer pays (UPI / card / netbanking)
        │
        ├─── SUCCESS ──────────────────────────────────────────────────────────
        │         Razorpay calls handler({ razorpay_order_id, payment_id, signature })
        │         POST /api/v1/payments/verify
        │           └─ verifySignature() → HMAC check
        │           └─ confirmPayment() → DB transaction:
        │               orders → confirmed
        │               payments → captured
        │               restaurant_payouts created (pending)
        │           └─ triggerRouteTransfer() → Razorpay Route split (async)
        │           └─ publishOrderEvent() → WebSocket → all clients
        │
        ├─── WEBHOOK (parallel, from Razorpay servers) ────────────────────────
        │         POST /api/v1/payments/webhook
        │           └─ validateWebhookSignature() → HMAC
        │           └─ idempotency check (webhook_events table)
        │           └─ handlePaymentCaptured() (same as verify, idempotent)
        │           └─ handleTransferSettled() → payout marked paid
        │
        └─── FAILURE ──────────────────────────────────────────────────────────
                  rzp.on('payment.failed') fires
                  POST /api/v1/payments/retry → fresh Razorpay order
                  Order stays in pending_payment, customer retries
*/

module.exports = {}; // placeholder — this file is documentation only
