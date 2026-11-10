CREATE TABLE IF NOT EXISTS api_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL,
  phone_e164 text UNIQUE NOT NULL, email text UNIQUE, password_hash text NOT NULL,
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','restricted','blacklisted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES api_users(id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES api_users(id),
  payer_e164 text NOT NULL, recipient_e164 text NOT NULL,
  network text NOT NULL CHECK (network IN ('safaricom','airtel','telkom','jtl')),
  airtime_amount numeric(12,2) NOT NULL CHECK (airtime_amount > 0),
  discount_percent numeric(7,4) NOT NULL CHECK (discount_percent >= 0 AND discount_percent <= 100),
  amount_due numeric(12,2) NOT NULL CHECK (amount_due > 0),
  terms_version text NOT NULL DEFAULT 'v1', terms_accepted_at timestamptz NOT NULL DEFAULT now(),
  otp_hash text NOT NULL, otp_expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0, verified_at timestamptz,
  payment_status text NOT NULL DEFAULT 'otp_pending' CHECK (payment_status IN ('otp_pending','stk_dispatching','pending','paid','failed','uncertain')),
  fulfillment_status text NOT NULL DEFAULT 'not_started' CHECK (fulfillment_status IN ('not_started','processing','delivered','failed','uncertain')),
  checkout_request_id text UNIQUE, merchant_request_id text, mpesa_receipt text UNIQUE,
  provider_request_id text, failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_checkouts_user_idx ON api_checkouts(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS api_checkouts_status_idx ON api_checkouts(payment_status,fulfillment_status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS api_checkouts_provider_request_idx ON api_checkouts(provider_request_id) WHERE provider_request_id IS NOT NULL;

ALTER TABLE api_users ADD COLUMN IF NOT EXISTS admin_username text UNIQUE;
ALTER TABLE api_users ADD COLUMN IF NOT EXISTS admin_totp text;
ALTER TABLE api_users ADD COLUMN IF NOT EXISTS admin_last_step bigint NOT NULL DEFAULT -1;
ALTER TABLE api_sessions ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE api_checkouts ADD COLUMN IF NOT EXISTS otp_sent_at timestamptz;
ALTER TABLE api_checkouts ADD COLUMN IF NOT EXISTS payment_environment text;
ALTER TABLE api_checkouts ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE api_checkouts ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS api_provider_events (
  kind text NOT NULL, provider_ref text NOT NULL, event_key text NOT NULL,
  payload jsonb NOT NULL, environment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), next_attempt timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz, outcome text,
  PRIMARY KEY(kind, provider_ref, event_key, environment)
);
CREATE INDEX IF NOT EXISTS api_events_pending ON api_provider_events(next_attempt) WHERE handled_at IS NULL;
CREATE TABLE IF NOT EXISTS api_admin_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES api_users(id),
  checkout_id uuid NOT NULL REFERENCES api_checkouts(id),
  action text NOT NULL, detail text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
