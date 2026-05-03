-- ============================================================
--  ForkFleet — Migration 002: Payments & Webhook Idempotency
--  Run after 001_init.sql
--  psql -U postgres -d forkfleet -f migrations/002_payments.sql
-- ============================================================

-- Add Razorpay linked account column to restaurants
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS razorpay_account_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS pan_number           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_account_number  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS bank_ifsc            VARCHAR(15),
  ADD COLUMN IF NOT EXISTS bank_beneficiary     VARCHAR(150);

-- Add transfer ID column to restaurant_payouts
ALTER TABLE restaurant_payouts
  ADD COLUMN IF NOT EXISTS razorpay_transfer_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_payouts_transfer
  ON restaurant_payouts(razorpay_transfer_id)
  WHERE razorpay_transfer_id IS NOT NULL;

-- ── Webhook idempotency log ───────────────────────────────────────────────────
-- Prevents duplicate processing if Razorpay delivers the same event twice.

CREATE TABLE IF NOT EXISTS webhook_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  razorpay_event_id   VARCHAR(100) UNIQUE NOT NULL,
  event_type          VARCHAR(100) NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}',
  status              VARCHAR(20) NOT NULL DEFAULT 'processed',
  -- 'processed' | 'failed' | 'skipped'
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_rzp_id
  ON webhook_events(razorpay_event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_type
  ON webhook_events(event_type, created_at DESC);

-- Auto-purge webhook log after 90 days (keeps table lean)
-- Run this as a cron job or pg_cron task:
-- DELETE FROM webhook_events WHERE created_at < NOW() - INTERVAL '90 days';

-- ── Payment method analytics view ────────────────────────────────────────────
-- Useful for the analytics dashboard.

CREATE OR REPLACE VIEW payment_method_stats AS
SELECT
  method,
  COUNT(*)                       AS payment_count,
  SUM(amount)                    AS total_paise,
  ROUND(AVG(amount))             AS avg_paise,
  COUNT(*) FILTER (WHERE status = 'captured') AS successful,
  COUNT(*) FILTER (WHERE status = 'failed')   AS failed,
  DATE_TRUNC('day', created_at)  AS day
FROM payments
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY method, DATE_TRUNC('day', created_at)
ORDER BY day DESC, payment_count DESC;

-- ── Restaurant payout summary view ───────────────────────────────────────────

CREATE OR REPLACE VIEW restaurant_payout_summary AS
SELECT
  r.id   AS restaurant_id,
  r.name AS restaurant_name,
  COUNT(rp.id)                                           AS total_payouts,
  COALESCE(SUM(rp.amount), 0)                            AS gross_paise,
  COALESCE(SUM(rp.commission_amt), 0)                    AS commission_paise,
  COALESCE(SUM(rp.net_amount), 0)                        AS net_paise,
  COALESCE(SUM(rp.net_amount) FILTER (WHERE rp.status='paid'), 0)    AS paid_paise,
  COALESCE(SUM(rp.net_amount) FILTER (WHERE rp.status='pending'), 0) AS pending_paise
FROM restaurants r
LEFT JOIN restaurant_payouts rp ON rp.restaurant_id = r.id
GROUP BY r.id, r.name;

COMMENT ON TABLE webhook_events IS
  'Idempotency log for Razorpay webhook events. Prevents double-processing on retries.';
