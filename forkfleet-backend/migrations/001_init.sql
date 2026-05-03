-- ============================================================
--  ForkFleet — Master Migration
--  Run:  psql -U postgres -d forkfleet -f migrations/001_init.sql
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for fuzzy search

-- ── ENUMS ────────────────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('customer', 'restaurant_owner', 'rider', 'admin');
CREATE TYPE order_status AS ENUM (
  'pending_payment', 'payment_failed',
  'confirmed', 'preparing', 'ready_for_pickup',
  'rider_assigned', 'picked_up', 'out_for_delivery',
  'delivered', 'cancelled', 'refunded'
);
CREATE TYPE sub_order_status AS ENUM (
  'confirmed', 'preparing', 'ready', 'picked_up', 'cancelled'
);
CREATE TYPE payment_status AS ENUM (
  'pending', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'
);
CREATE TYPE rider_status AS ENUM ('offline', 'available', 'on_delivery');
CREATE TYPE payout_status AS ENUM ('pending', 'processing', 'paid', 'failed');

-- ── USERS ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         VARCHAR(15) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE,
  name          VARCHAR(100),
  role          user_role NOT NULL DEFAULT 'customer',
  password_hash VARCHAR(255),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_addresses (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        VARCHAR(50) NOT NULL DEFAULT 'Home',  -- Home / Work / Other
  address_line VARCHAR(255) NOT NULL,
  landmark     VARCHAR(100),
  city         VARCHAR(100) NOT NULL,
  pincode      VARCHAR(10) NOT NULL,
  latitude     DECIMAL(10,8),
  longitude    DECIMAL(11,8),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ── RESTAURANTS ──────────────────────────────────────────────────────────────

CREATE TABLE restaurants (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id         UUID NOT NULL REFERENCES users(id),
  name             VARCHAR(150) NOT NULL,
  description      TEXT,
  cuisine_tags     TEXT[] NOT NULL DEFAULT '{}',
  address          VARCHAR(255) NOT NULL,
  city             VARCHAR(100) NOT NULL,
  pincode          VARCHAR(10) NOT NULL,
  latitude         DECIMAL(10,8) NOT NULL,
  longitude        DECIMAL(11,8) NOT NULL,
  phone            VARCHAR(15) NOT NULL,
  email            VARCHAR(255),
  razorpay_account_id VARCHAR(100),
  image_url        VARCHAR(500),
  avg_rating       DECIMAL(3,2) NOT NULL DEFAULT 0.00,
  total_ratings    INTEGER NOT NULL DEFAULT 0,
  avg_prep_minutes INTEGER NOT NULL DEFAULT 30,
  is_open          BOOLEAN NOT NULL DEFAULT true,
  is_active        BOOLEAN NOT NULL DEFAULT true,  -- admin-controlled
  opens_at         TIME NOT NULL DEFAULT '09:00',
  closes_at        TIME NOT NULL DEFAULT '23:00',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_restaurants_city ON restaurants(city);
CREATE INDEX idx_restaurants_location ON restaurants(latitude, longitude);
CREATE INDEX idx_restaurants_tags ON restaurants USING GIN(cuisine_tags);
CREATE INDEX idx_restaurants_name_trgm ON restaurants USING GIN(name gin_trgm_ops);

-- ── MENU ─────────────────────────────────────────────────────────────────────

CREATE TABLE menu_categories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id   UUID REFERENCES menu_categories(id) ON DELETE SET NULL,
  name          VARCHAR(150) NOT NULL,
  description   TEXT,
  price         DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  is_veg        BOOLEAN NOT NULL DEFAULT true,
  is_available  BOOLEAN NOT NULL DEFAULT true,
  image_url     VARCHAR(500),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX idx_menu_items_name_trgm ON menu_items USING GIN(name gin_trgm_ops);

-- ── ORDERS  (THE CORE) ───────────────────────────────────────────────────────

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id         UUID NOT NULL REFERENCES users(id),
  delivery_address_id UUID REFERENCES user_addresses(id),

  -- Denormalised delivery address snapshot (in case address changes later)
  delivery_address    JSONB NOT NULL DEFAULT '{}',

  status              order_status NOT NULL DEFAULT 'pending_payment',

  -- Financials (all in INR paise — multiply ₹ by 100)
  items_total         INTEGER NOT NULL DEFAULT 0,   -- sum of (price × qty)
  delivery_fee        INTEGER NOT NULL DEFAULT 0,   -- ₹30 × n restaurants
  tax_amount          INTEGER NOT NULL DEFAULT 0,   -- 5% of items_total
  grand_total         INTEGER NOT NULL DEFAULT 0,   -- items + delivery + tax

  restaurant_count    INTEGER NOT NULL DEFAULT 1,
  instructions        TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status   ON orders(status);
CREATE INDEX idx_orders_created  ON orders(created_at DESC);

-- Sub-orders: one per restaurant in the parent order
CREATE TABLE sub_orders (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  status        sub_order_status NOT NULL DEFAULT 'confirmed',
  subtotal      INTEGER NOT NULL DEFAULT 0,  -- items total for this restaurant
  payout_amount INTEGER NOT NULL DEFAULT 0,  -- after platform commission
  instructions  TEXT,
  confirmed_at  TIMESTAMPTZ,
  ready_at      TIMESTAMPTZ,
  picked_up_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sub_orders_order      ON sub_orders(order_id);
CREATE INDEX idx_sub_orders_restaurant ON sub_orders(restaurant_id);
CREATE INDEX idx_sub_orders_status     ON sub_orders(status);

-- Line items — belong to a sub_order (not directly to order)
CREATE TABLE order_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sub_order_id  UUID NOT NULL REFERENCES sub_orders(id) ON DELETE CASCADE,
  menu_item_id  UUID NOT NULL REFERENCES menu_items(id),
  -- Snapshot price at time of order (menu price may change later)
  name          VARCHAR(150) NOT NULL,
  price         INTEGER NOT NULL,  -- in paise
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  line_total    INTEGER NOT NULL,  -- price × quantity
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_sub_order ON order_items(sub_order_id);

-- ── PAYMENTS ─────────────────────────────────────────────────────────────────

CREATE TABLE payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id              UUID NOT NULL REFERENCES orders(id),
  razorpay_order_id     VARCHAR(100) UNIQUE,  -- order_id from Razorpay
  razorpay_payment_id   VARCHAR(100) UNIQUE,  -- payment_id after capture
  razorpay_signature    VARCHAR(255),         -- webhook signature for verification
  amount                INTEGER NOT NULL,     -- in paise
  currency              VARCHAR(3) NOT NULL DEFAULT 'INR',
  status                payment_status NOT NULL DEFAULT 'pending',
  method                VARCHAR(50),          -- card / upi / netbanking / wallet
  failure_reason        TEXT,
  captured_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_order    ON payments(order_id);
CREATE INDEX idx_payments_rzp_ord  ON payments(razorpay_order_id);

-- Restaurant payouts (split settlement)
CREATE TABLE restaurant_payouts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sub_order_id    UUID NOT NULL REFERENCES sub_orders(id),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id),
  payment_id      UUID NOT NULL REFERENCES payments(id),
  amount          INTEGER NOT NULL,  -- in paise
  commission_pct  DECIMAL(5,2) NOT NULL DEFAULT 15.00,
  commission_amt  INTEGER NOT NULL,
  net_amount      INTEGER NOT NULL,
  razorpay_transfer_id VARCHAR(100) UNIQUE,
  status          payout_status NOT NULL DEFAULT 'pending',
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payment webhook event idempotency tracker
CREATE TABLE webhook_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  razorpay_event_id VARCHAR(120) UNIQUE NOT NULL,
  event_type        VARCHAR(80) NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  status            VARCHAR(30) NOT NULL DEFAULT 'processed',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── DELIVERY ─────────────────────────────────────────────────────────────────

CREATE TABLE riders (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL UNIQUE REFERENCES users(id),
  vehicle_type VARCHAR(50) NOT NULL DEFAULT 'motorcycle',
  license_no   VARCHAR(50),
  status       rider_status NOT NULL DEFAULT 'offline',
  latitude     DECIMAL(10,8),
  longitude    DECIMAL(11,8),
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_riders_status   ON riders(status);
CREATE INDEX idx_riders_location ON riders(latitude, longitude) WHERE status = 'available';

CREATE TABLE delivery_jobs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id         UUID NOT NULL REFERENCES orders(id),
  rider_id         UUID REFERENCES riders(id),
  -- Ordered list of pickup stops (one per restaurant)
  pickup_sequence  JSONB NOT NULL DEFAULT '[]',
  -- e.g. [{ sub_order_id, restaurant_id, restaurant_name, address, latitude, longitude }]
  dropoff_address  JSONB NOT NULL DEFAULT '{}',
  status           VARCHAR(50) NOT NULL DEFAULT 'pending_assignment',
  -- pending_assignment → assigned → collecting → out_for_delivery → delivered
  assigned_at      TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  estimated_mins   INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delivery_jobs_order ON delivery_jobs(order_id);
CREATE INDEX idx_delivery_jobs_rider ON delivery_jobs(rider_id);

-- ── REVIEWS ──────────────────────────────────────────────────────────────────

CREATE TABLE reviews (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID NOT NULL REFERENCES orders(id),
  customer_id   UUID NOT NULL REFERENCES users(id),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id),
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, restaurant_id)  -- one review per restaurant per order
);

CREATE INDEX idx_reviews_restaurant ON reviews(restaurant_id);

-- ── TRIGGERS — auto-update updated_at ────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_upd       BEFORE UPDATE ON users       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_restaurants_upd BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_menu_items_upd  BEFORE UPDATE ON menu_items  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_upd      BEFORE UPDATE ON orders      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sub_orders_upd  BEFORE UPDATE ON sub_orders  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payments_upd    BEFORE UPDATE ON payments    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_delivery_upd    BEFORE UPDATE ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── TRIGGER — keep avg_rating on restaurants up to date ──────────────────────

CREATE OR REPLACE FUNCTION update_restaurant_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE restaurants
  SET
    avg_rating   = (SELECT ROUND(AVG(rating)::NUMERIC, 2) FROM reviews WHERE restaurant_id = NEW.restaurant_id),
    total_ratings = (SELECT COUNT(*) FROM reviews WHERE restaurant_id = NEW.restaurant_id)
  WHERE id = NEW.restaurant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reviews_rating
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_restaurant_rating();
