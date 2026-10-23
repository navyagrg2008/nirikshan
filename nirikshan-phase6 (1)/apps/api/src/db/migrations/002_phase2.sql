-- Phase 2: foundation additions (local credentials, invites, registration documents, instrument extras, RLS for businesses).

-- ---------------------------------------------------------------- users
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN display_name_masked text;          -- first letter + ****** for lists; full name stays encrypted

CREATE TABLE local_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL,                     -- argon2id
  totp_secret_enc bytea,
  totp_confirmed_at timestamptz,
  recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb,   -- sha256 hashes only
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_invites_user_idx ON staff_invites (user_id);

CREATE TABLE account_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('TRADE_LICENCE','GST_CERTIFICATE','ID_PROOF')),
  object_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 bytea NOT NULL,
  scan scan_status NOT NULL DEFAULT 'CLEAN',
  review doc_review_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_documents_user_idx ON account_documents (user_id);

CREATE TABLE contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_enc bytea NOT NULL,
  contact_enc bytea NOT NULL,
  message_enc bytea NOT NULL,
  ip_hash bytea,
  status request_status NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- businesses
ALTER TABLE businesses ADD COLUMN is_managed_customer boolean NOT NULL DEFAULT false;  -- customer record created by a trader
ALTER TABLE businesses ADD COLUMN pincode_enc bytea;
CREATE INDEX businesses_owner_idx ON businesses (owner_user_id);

-- ---------------------------------------------------------------- instruments
CREATE SEQUENCE instrument_no_seq START 1;
ALTER TABLE instruments ADD COLUMN instrument_no text NOT NULL DEFAULT ('NRK-INS-' || lpad(nextval('instrument_no_seq')::text, 8, '0'));
ALTER TABLE instruments ADD CONSTRAINT instruments_no_key UNIQUE (instrument_no);
ALTER TABLE instruments ADD COLUMN address_enc bytea;
ALTER TABLE instruments ADD COLUMN created_by uuid REFERENCES users(id);

CREATE TABLE instrument_duplicate_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  area_id uuid NOT NULL REFERENCES areas(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  payload_enc bytea NOT NULL,
  existing_instrument_id uuid REFERENCES instruments(id),
  status request_status NOT NULL DEFAULT 'OPEN',
  decided_by uuid REFERENCES users(id),
  reason text,
  resulting_instrument_id uuid REFERENCES instruments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX instrument_dup_req_idx ON instrument_duplicate_requests (status, area_id);

-- one wizard draft per user
CREATE UNIQUE INDEX instrument_drafts_user_key ON instrument_drafts (user_id);

-- ---------------------------------------------------------------- user search / helper indexes
CREATE INDEX users_status_idx ON users (account_status, created_at);
CREATE INDEX audit_events_action_idx ON audit_events (action, occurred_at);

-- ---------------------------------------------------------------- Row-Level Security for businesses and drafts
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY businesses_owner ON businesses FOR ALL
  USING (app_role() IN ('OWNER','TRADER') AND (owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid OR id = ANY (app_business_ids())));
CREATE POLICY businesses_staff ON businesses FOR SELECT
  USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY businesses_admin ON businesses FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY businesses_system ON businesses FOR ALL USING (app_role() = 'SYSTEM');
-- inspectors read the business of an instrument only through the visit flow (Phase 4)

ALTER TABLE instrument_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY drafts_self ON instrument_drafts FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE instrument_duplicate_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY dup_owner ON instrument_duplicate_requests FOR ALL
  USING (app_role() IN ('OWNER','TRADER') AND business_id = ANY (app_business_ids()));
CREATE POLICY dup_staff ON instrument_duplicate_requests FOR ALL
  USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY dup_admin ON instrument_duplicate_requests FOR ALL USING (app_role() = 'ADMIN');

-- instruments: the SYSTEM context (jobs, bulk commit under a user is NOT system) can read for stats
CREATE POLICY instruments_system_read ON instruments FOR SELECT USING (app_role() = 'SYSTEM');

-- ---------------------------------------------------------------- audit chain verification
-- Returns the id of the first event whose link or hash is wrong, or NULL when the chain is intact.
CREATE OR REPLACE FUNCTION audit_verify_chain() RETURNS TABLE (checked bigint, first_bad_id bigint) AS $$
  WITH ordered AS (
    SELECT id, prev_hash, hash,
           lag(hash) OVER (ORDER BY id) AS expected_prev,
           digest(prev_hash || convert_to(jsonb_build_object(
             'occurred_at', occurred_at, 'actor_id', actor_id, 'actor_role', actor_role,
             'action', action, 'entity_type', entity_type, 'entity_id', entity_id,
             'area_id', area_id, 'request_id', request_id, 'details', details)::text, 'UTF8'), 'sha256') AS recomputed
    FROM audit_events
  )
  SELECT count(*)::bigint,
         min(id) FILTER (WHERE hash <> recomputed OR prev_hash <> COALESCE(expected_prev, '\x00'::bytea))
  FROM ordered;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- grants for the unprivileged app role
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO nirikshan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM nirikshan_app;
GRANT DELETE ON instrument_drafts, otp_challenges, staff_invites, user_roles, user_area_scopes, holiday_calendar, notification_preferences TO nirikshan_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nirikshan_app;
GRANT EXECUTE ON FUNCTION audit_verify_chain() TO nirikshan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO nirikshan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO nirikshan_app;

-- ---------------------------------------------------------------- base roles (permissions are synced from code at migrate time)
INSERT INTO roles (code, name) VALUES
  ('OWNER','Instrument owner'), ('TRADER','Manufacturer, dealer or repairer'), ('INSPECTOR','Field inspector'),
  ('OFFICER','Verification officer'), ('SENIOR_OFFICER','Senior officer'), ('ADMIN','System administrator')
ON CONFLICT (code) DO NOTHING;
