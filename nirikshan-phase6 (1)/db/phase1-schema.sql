-- Nirikshan core schema (Phase 1 design). PostgreSQL 16 + PostGIS.
-- Conventions: snake_case, UUID primary keys (app generates UUID v7; gen_random_uuid() is the fallback default),
-- created_at/updated_at, soft delete via status, `version` for optimistic locking.
-- There are NO payment, fee, invoice, receipt or settlement tables by design.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- enums
CREATE TYPE account_status AS ENUM ('INVITED','PENDING_VERIFICATION','ACTIVE','REJECTED','SUSPENDED','DEACTIVATED');
CREATE TYPE area_level AS ENUM ('DIVISION','ZONE','CIRCLE','WARD');
CREATE TYPE business_type AS ENUM ('OWNER','MANUFACTURER','DEALER','REPAIRER');
CREATE TYPE instrument_status AS ENUM ('REGISTERED','ACTIVE','DUE_FOR_RENEWAL','EXPIRED','DEREGISTERED');
CREATE TYPE application_status AS ENUM ('APPLIED','DOCUMENT_CHECKED','SCHEDULED','INSPECTION_IN_PROGRESS','FAILED_ATTEMPT','INSPECTED','REFERRED','APPROVED','REJECTED','CERTIFICATE_ISSUED','CANCELLED','APPLICATION_EXPIRED');
CREATE TYPE verification_type AS ENUM ('NEW','RE_VERIFICATION','RENEWAL','RE_TEST');
CREATE TYPE certificate_status AS ENUM ('VALID','SUSPENDED','REVOKED','EXPIRED','REPLACED');
CREATE TYPE rule_status AS ENUM ('DRAFT','IN_REVIEW','PUBLISHED','RETIRED');
CREATE TYPE verdict AS ENUM ('PASS','MARGINAL_PASS','FAIL');
CREATE TYPE recommendation AS ENUM ('RECOMMEND_APPROVE','RECOMMEND_REJECT','RE_INSPECT');
CREATE TYPE decision_type AS ENUM ('APPROVE','REJECT','REFER');
CREATE TYPE doc_review_status AS ENUM ('PENDING','ACCEPTED','FLAGGED');
CREATE TYPE scan_status AS ENUM ('PENDING','CLEAN','INFECTED','FAILED');
CREATE TYPE schedule_mode AS ENUM ('AUTO','REVIEW');
CREATE TYPE request_status AS ENUM ('OPEN','IN_PROGRESS','APPROVED','REJECTED','CLOSED');
CREATE TYPE channel AS ENUM ('SMS','EMAIL','IN_APP');

-- ---------------------------------------------------------------- identity and access
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,                       -- OWNER, TRADER, INSPECTOR, OFFICER, SENIOR_OFFICER, ADMIN
  name text NOT NULL
);
CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,                       -- e.g. instrument.create
  description text
);
CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id),
  permission_id uuid NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES areas(id),
  level area_level NOT NULL,
  code text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_hi text,
  boundary geometry(MultiPolygon, 4326),
  status text NOT NULL DEFAULT 'ACTIVE',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX areas_boundary_gix ON areas USING gist (boundary);
CREATE INDEX areas_parent_idx ON areas (parent_id);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_sub text NOT NULL UNIQUE,
  account_status account_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  mobile_enc bytea,                                -- AES-256-GCM envelope encrypted
  mobile_bidx bytea UNIQUE,                        -- HMAC blind index for lookup
  email_enc bytea,
  email_bidx bytea UNIQUE,
  mobile_verified_at timestamptz,
  email_verified_at timestamptz,
  preferred_lang text NOT NULL DEFAULT 'en' CHECK (preferred_lang IN ('en','hi')),
  mfa_enrolled boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE user_area_scopes (                    -- jurisdiction for officers and inspectors
  user_id uuid NOT NULL REFERENCES users(id),
  area_id uuid NOT NULL REFERENCES areas(id),
  PRIMARY KEY (user_id, area_id)
);
CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  full_name_enc bytea NOT NULL,
  dob_enc bytea,
  address_enc bytea,
  id_doc_type text,                                -- type + last 4 only, never the full number
  id_last4 text CHECK (id_last4 ~ '^[0-9A-Za-z]{4}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  policy_version text NOT NULL,
  purpose text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);
CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  type business_type NOT NULL,
  firm_name_enc bytea NOT NULL,
  firm_name_masked text NOT NULL,                  -- e.g. 'M/s ****** Store' for public views
  trade_licence_enc bytea,
  gstin_enc bytea,
  address_enc bytea,
  premises_geo_enc bytea,                          -- encrypted lat/lon
  area_id uuid NOT NULL REFERENCES areas(id),
  status text NOT NULL DEFAULT 'ACTIVE',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_area_idx ON businesses (area_id, status);
CREATE TABLE account_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('APPROVED','REJECTED')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- master data
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_hi text,
  is_automatic boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE sub_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  code text NOT NULL,
  name_en text NOT NULL,
  name_hi text,
  UNIQUE (category_id, code)
);
CREATE TABLE accuracy_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL
);
CREATE TABLE capacity_bands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  min_capacity numeric(18,4) NOT NULL,
  max_capacity numeric(18,4) NOT NULL,
  unit text NOT NULL,
  CHECK (max_capacity > min_capacity)
);
CREATE TABLE document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_hi text,
  required_for verification_type[] NOT NULL DEFAULT '{}',
  max_size_mb int NOT NULL DEFAULT 10
);
CREATE TABLE reason_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  applies_to text NOT NULL,                        -- REJECT, REVOKE, SUSPEND, FLAG_DOCUMENT, GEOFENCE ...
  text_en text NOT NULL,
  text_hi text,
  public_safe boolean NOT NULL DEFAULT false
);
CREATE TABLE holiday_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id uuid REFERENCES areas(id),               -- null = all areas
  holiday_date date NOT NULL,
  name text NOT NULL,
  UNIQUE (area_id, holiday_date)
);
CREATE TABLE checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  version int NOT NULL,
  items jsonb NOT NULL,
  status rule_status NOT NULL DEFAULT 'DRAFT',
  effective_from date,
  UNIQUE (category_id, version)
);
CREATE TABLE notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_code text NOT NULL,
  channel channel NOT NULL,
  lang text NOT NULL CHECK (lang IN ('en','hi')),
  subject text,
  body text NOT NULL,
  version int NOT NULL DEFAULT 1,
  UNIQUE (event_code, channel, lang, version)
);

-- ---------------------------------------------------------------- rules (versioned, effective-dated)
CREATE TABLE rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL UNIQUE,
  status rule_status NOT NULL DEFAULT 'DRAFT',
  effective_from date NOT NULL,
  effective_to date,
  authored_by uuid REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  published_at timestamptz,
  note text,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (reviewed_by IS NULL OR reviewed_by <> authored_by)  -- second admin must review
);
CREATE TABLE mpe_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  capacity_band_id uuid NOT NULL REFERENCES capacity_bands(id),
  accuracy_class_id uuid NOT NULL REFERENCES accuracy_classes(id),
  direction text NOT NULL CHECK (direction IN ('PLUS_MINUS','PLUS','MINUS')),
  value numeric(18,6) NOT NULL,
  unit text NOT NULL,
  marginal_pct numeric(5,2) NOT NULL DEFAULT 80 CHECK (marginal_pct BETWEEN 0 AND 100)
);
CREATE INDEX mpe_rules_lookup_idx ON mpe_rules (rule_set_id, category_id, capacity_band_id, accuracy_class_id);
CREATE TABLE interval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  capacity_band_id uuid NOT NULL REFERENCES capacity_bands(id),
  months int NOT NULL CHECK (months > 0),
  marginal_months int CHECK (marginal_months IS NULL OR marginal_months <= months),
  grace_days int NOT NULL DEFAULT 0,
  application_window_days int NOT NULL DEFAULT 30
);
CREATE INDEX interval_rules_lookup_idx ON interval_rules (rule_set_id, category_id, capacity_band_id);
CREATE TABLE workflow_slas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),
  step text NOT NULL,                              -- DOCUMENT_CHECK, SCHEDULE, DECISION ...
  max_hours int NOT NULL CHECK (max_hours > 0),
  UNIQUE (rule_set_id, step)
);
-- Overlap protection: no two PUBLISHED rule sets may have overlapping effective ranges.
ALTER TABLE rule_sets ADD CONSTRAINT rule_sets_no_overlap
  EXCLUDE USING gist (daterange(effective_from, effective_to, '[)') WITH &&)
  WHERE (status = 'PUBLISHED');

-- ---------------------------------------------------------------- instruments
CREATE TABLE instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  on_behalf_of_business_id uuid REFERENCES businesses(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  sub_category_id uuid REFERENCES sub_categories(id),
  capacity_band_id uuid NOT NULL REFERENCES capacity_bands(id),
  accuracy_class_id uuid NOT NULL REFERENCES accuracy_classes(id),
  capacity numeric(18,4) NOT NULL,
  capacity_unit text NOT NULL,
  serial_no text NOT NULL,
  make text NOT NULL,
  model text,
  manufacture_year int,
  load_cell_serial text,
  display_count int,
  area_id uuid NOT NULL REFERENCES areas(id),
  location geometry(Point, 4326),
  location_enc bytea,                              -- encrypted exact premises coordinates
  out_of_area boolean NOT NULL DEFAULT false,
  duplicate_override_by uuid REFERENCES users(id),
  status instrument_status NOT NULL DEFAULT 'REGISTERED',
  first_verified_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Duplicate (serial, make, category) is a warning flow; unique only among non-deregistered, non-overridden rows.
CREATE UNIQUE INDEX instruments_active_unique ON instruments (lower(serial_no), lower(make), category_id)
  WHERE status <> 'DEREGISTERED' AND duplicate_override_by IS NULL;
CREATE INDEX instruments_scope_idx ON instruments (status, area_id, created_at);
CREATE INDEX instruments_business_idx ON instruments (business_id, status);
CREATE INDEX instruments_location_gix ON instruments USING gist (location);

CREATE TABLE instrument_ownership_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  from_business_id uuid REFERENCES businesses(id),
  to_business_id uuid NOT NULL REFERENCES businesses(id),
  effective_at timestamptz NOT NULL DEFAULT now(),
  transfer_id uuid
);
CREATE TABLE ownership_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  from_business_id uuid NOT NULL REFERENCES businesses(id),
  to_business_id uuid NOT NULL REFERENCES businesses(id),
  sale_document_key text,
  status request_status NOT NULL DEFAULT 'OPEN',
  decided_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE instrument_drafts (                   -- wizard autosave, expires after 7 days
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  payload_enc bytea NOT NULL,
  step int NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- applications (cases)
CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_no text NOT NULL UNIQUE,
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  area_id uuid NOT NULL REFERENCES areas(id),
  type verification_type NOT NULL,
  status application_status NOT NULL DEFAULT 'APPLIED',
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),   -- pinned at application time, never "latest"
  due_date date,
  apply_by_date date,
  preferred_window tstzrange,
  access_hours text,
  contact_person_enc bytea,
  linked_application_id uuid REFERENCES applications(id), -- reapply after reject, or re-inspection chain
  schedule_mode schedule_mode,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One open application per instrument.
CREATE UNIQUE INDEX applications_one_open_per_instrument ON applications (instrument_id)
  WHERE status NOT IN ('REJECTED','CANCELLED','APPLICATION_EXPIRED','CERTIFICATE_ISSUED');
CREATE INDEX applications_queue_idx ON applications (status, area_id, created_at);
CREATE INDEX applications_business_idx ON applications (business_id, status);

CREATE TABLE application_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  document_type_id uuid NOT NULL REFERENCES document_types(id),
  object_key text NOT NULL,                        -- random key in private bucket
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 bytea,
  doc_version int NOT NULL DEFAULT 1,
  scan scan_status NOT NULL DEFAULT 'PENDING',
  review doc_review_status NOT NULL DEFAULT 'PENDING',
  review_comment text,
  reviewed_by uuid REFERENCES users(id),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_documents_app_idx ON application_documents (application_id);

CREATE TABLE case_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  from_status application_status,
  to_status application_status NOT NULL,
  action text NOT NULL,
  actor_id uuid REFERENCES users(id),              -- null = system
  remark text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_status_history_app_idx ON case_status_history (application_id, created_at);

-- ---------------------------------------------------------------- scheduling and inspection
CREATE TABLE inspector_skills (
  inspector_id uuid NOT NULL REFERENCES users(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  certified_until date,
  PRIMARY KEY (inspector_id, category_id)
);
CREATE TABLE inspector_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspector_id uuid NOT NULL REFERENCES users(id),
  period tstzrange NOT NULL,
  kind text NOT NULL CHECK (kind IN ('LEAVE','UNAVAILABLE','CAPACITY_OVERRIDE')),
  daily_capacity int,
  reason text
);
CREATE INDEX inspector_availability_idx ON inspector_availability USING gist (inspector_id, period);

CREATE TABLE inspection_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  inspector_id uuid NOT NULL REFERENCES users(id),
  scheduled_window tstzrange NOT NULL,
  score_breakdown jsonb,                           -- workload, distance, specialisation, success, no-repeat
  assigned_by uuid REFERENCES users(id),           -- null = system AUTO
  out_of_jurisdiction boolean NOT NULL DEFAULT false,
  arrived_at timestamptz,
  arrival_location geometry(Point, 4326),
  geofence_ok boolean,
  geofence_justification text,
  submitted_at timestamptz,
  recommendation recommendation,
  sticker_serial text,
  test_sheet_key text,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','IN_PROGRESS','SUBMITTED','NO_SHOW','CANCELLED','SUPERSEDED')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspection_visits_inspector_idx ON inspection_visits (inspector_id, status);
CREATE INDEX inspection_visits_window_idx ON inspection_visits USING gist (inspector_id, scheduled_window);

CREATE TABLE checklist_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES inspection_visits(id),
  template_id uuid NOT NULL REFERENCES checklist_templates(id),
  item_code text NOT NULL,
  answer text NOT NULL,
  remark text,
  UNIQUE (visit_id, item_code)
);
CREATE TABLE test_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES inspection_visits(id),
  trial_no int NOT NULL,
  reference_value numeric(18,6) NOT NULL,          -- test load or reference
  observed_value numeric(18,6) NOT NULL,
  unit text NOT NULL,
  error_value numeric(18,6) NOT NULL,              -- computed by server only
  error_pct numeric(12,6) NOT NULL,                -- computed by server only
  mpe_value numeric(18,6) NOT NULL,                -- from pinned rule
  verdict verdict NOT NULL,                        -- computed by server only
  mpe_rule_id uuid NOT NULL REFERENCES mpe_rules(id),
  UNIQUE (visit_id, trial_no)
);
CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES inspection_visits(id),
  kind text NOT NULL CHECK (kind IN ('DISPLAY','TEST_WEIGHTS','SEAL','TAMPER','AUDIO','OTHER')),
  object_key text NOT NULL,
  mime_type text NOT NULL,
  geo geometry(Point, 4326),                       -- server-side geotag, EXIF GPS stripped from public copies
  captured_at timestamptz NOT NULL,
  scan scan_status NOT NULL DEFAULT 'PENDING'
);
CREATE TABLE inspection_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES inspection_visits(id),
  inspector_id uuid NOT NULL REFERENCES users(id),
  payload_enc bytea NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id, inspector_id)
);

-- ---------------------------------------------------------------- decisions and certificates
CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  visit_id uuid REFERENCES inspection_visits(id),
  decision decision_type NOT NULL,
  reason_code_id uuid REFERENCES reason_codes(id),
  remarks text,
  validity_months int,
  decided_by uuid NOT NULL REFERENCES users(id),
  second_approver_id uuid REFERENCES users(id),
  reauth_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'REJECT' OR (reason_code_id IS NOT NULL AND remarks IS NOT NULL)),
  CHECK (second_approver_id IS NULL OR second_approver_id <> decided_by)
);
CREATE SEQUENCE certificate_seq_global;            -- per division+year numbering uses cert_sequences below
CREATE TABLE cert_sequences (
  division_id uuid NOT NULL REFERENCES areas(id),
  year int NOT NULL,
  last_seq int NOT NULL DEFAULT 0,
  PRIMARY KEY (division_id, year)
);
CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_no text NOT NULL UNIQUE,                    -- NRK/CERT/{DIV}/{YYYY}/{seq}; never reused
  application_id uuid NOT NULL REFERENCES applications(id),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  division_id uuid NOT NULL REFERENCES areas(id),
  status certificate_status NOT NULL DEFAULT 'VALID',
  verified_on date NOT NULL,
  valid_till date NOT NULL,
  marginal boolean NOT NULL DEFAULT false,
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id),
  pdf_key text NOT NULL,
  fingerprint bytea NOT NULL,                      -- SHA-256 of the PDF
  key_id text NOT NULL,                            -- KMS key used for the QR HMAC / PDF signature
  replaces_certificate_id uuid REFERENCES certificates(id),
  issued_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_till > verified_on)
);
CREATE INDEX certificates_instrument_idx ON certificates (instrument_id, status);
CREATE INDEX certificates_expiry_idx ON certificates (status, valid_till);
CREATE TABLE certificate_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id uuid NOT NULL REFERENCES certificates(id),
  from_status certificate_status,
  to_status certificate_status NOT NULL,
  reason_code_id uuid REFERENCES reason_codes(id),
  public_reason text,                              -- public-safe text only
  internal_reason text,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Public read model, updated in the same transaction as certificate changes. Contains NO PII.
CREATE TABLE public_certificate_index (
  cert_no text PRIMARY KEY REFERENCES certificates(cert_no),
  holder_masked text NOT NULL,
  category_name text NOT NULL,
  capacity_text text NOT NULL,
  class_code text NOT NULL,
  area_label text NOT NULL,                        -- ward/zone only
  status certificate_status NOT NULL,
  verified_on date NOT NULL,
  valid_till date NOT NULL,
  issuing_office text NOT NULL,
  public_reason text,
  district_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_cert_search_idx ON public_certificate_index (district_code, category_name, status);
CREATE TABLE public_stats_aggregate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of timestamptz NOT NULL DEFAULT now(),
  instruments_registered bigint NOT NULL,
  instruments_verified bigint NOT NULL,
  districts_covered int NOT NULL
);
CREATE TABLE public_lookup_log (                   -- retained 90 days
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash bytea NOT NULL,
  device_hash bytea,
  mode text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- lifecycle, services, complaints
CREATE TABLE service_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_business_id uuid NOT NULL REFERENCES businesses(id),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  stage text NOT NULL DEFAULT 'REPORTED' CHECK (stage IN ('REPORTED','TECHNICIAN_ASSIGNED','REPAIRED','READY_FOR_VERIFICATION')),
  repair_document_key text,
  resulting_application_id uuid REFERENCES applications(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grievances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raised_by uuid NOT NULL REFERENCES users(id),
  application_id uuid REFERENCES applications(id),
  subject text NOT NULL,
  body text NOT NULL,
  status request_status NOT NULL DEFAULT 'OPEN',
  due_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tamper_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_no text,
  description text NOT NULL,
  photo_key text,
  contact_enc bytea,
  ip_hash bytea,
  status request_status NOT NULL DEFAULT 'OPEN',
  assigned_area_id uuid REFERENCES areas(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE enforcement_drives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id uuid NOT NULL REFERENCES areas(id),
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','NOTICES_SENT','IN_PROGRESS','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE enforcement_drive_items (
  drive_id uuid NOT NULL REFERENCES enforcement_drives(id),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  stage text NOT NULL DEFAULT 'LISTED' CHECK (stage IN ('LISTED','NOTIFIED','APPLIED','VERIFIED','ESCALATED')),
  PRIMARY KEY (drive_id, instrument_id)
);
CREATE TABLE notices (                             -- public circulars, gazette notices
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_en text NOT NULL,
  title_hi text,
  tag text,
  pdf_key text,
  published_at timestamptz,
  created_by uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  event_code text NOT NULL,
  channel channel NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, event_code, channel)
);
CREATE TABLE in_app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  event_code text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  deep_link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX in_app_notifications_user_idx ON in_app_notifications (user_id, read_at, created_at DESC);
CREATE TABLE message_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_code text NOT NULL,
  channel channel NOT NULL,
  recipient_masked text NOT NULL,
  recipient_hash bytea NOT NULL,
  template_id uuid REFERENCES notification_templates(id),
  status text NOT NULL,
  provider_ref text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_log_dedupe_idx ON message_log (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_hash bytea NOT NULL,
  purpose text NOT NULL,
  code_hash bytea NOT NULL,                        -- OTP stored hashed only
  attempts int NOT NULL DEFAULT 0 CHECK (attempts <= 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

-- ---------------------------------------------------------------- privacy
CREATE TABLE data_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('ACCESS','CORRECTION','ERASURE','DEACTIVATION')),
  status request_status NOT NULL DEFAULT 'OPEN',
  details text,
  due_at timestamptz NOT NULL,
  handled_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- ---------------------------------------------------------------- idempotency
CREATE TABLE idempotency_keys (
  key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  request_hash bytea NOT NULL,
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------- audit (append-only, hash-chained)
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  area_id uuid,
  request_id text,
  ip_hash bytea,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,      -- never contains PII or secrets
  prev_hash bytea NOT NULL,
  hash bytea NOT NULL
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at);

-- hash = SHA-256(prev_hash || canonical JSON of the event). The chain is serialised with an advisory lock.
CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger AS $$
DECLARE
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  SELECT hash INTO last_hash FROM audit_events ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, '\x00'::bytea);
  NEW.hash := digest(
    NEW.prev_hash || convert_to(jsonb_build_object(
      'occurred_at', NEW.occurred_at, 'actor_id', NEW.actor_id, 'actor_role', NEW.actor_role,
      'action', NEW.action, 'entity_type', NEW.entity_type, 'entity_id', NEW.entity_id,
      'area_id', NEW.area_id, 'request_id', NEW.request_id, 'details', NEW.details
    )::text, 'UTF8'), 'sha256');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_chain_trg BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Published certificates are immutable except status; the cert number is never changed.
CREATE OR REPLACE FUNCTION certificates_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.cert_no <> OLD.cert_no OR NEW.fingerprint <> OLD.fingerprint OR NEW.verified_on <> OLD.verified_on
     OR NEW.instrument_id <> OLD.instrument_id THEN
    RAISE EXCEPTION 'certificate fields are immutable; only status may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER certificates_guard_trg BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION certificates_guard();

-- Published rule sets are immutable (corrections = new version).
CREATE OR REPLACE FUNCTION rules_immutable() RETURNS trigger AS $$
DECLARE
  parent_status rule_status;
BEGIN
  SELECT status INTO parent_status FROM rule_sets WHERE id = COALESCE(NEW.rule_set_id, OLD.rule_set_id);
  IF parent_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'published rule sets are immutable; create a new version';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mpe_rules_immutable BEFORE UPDATE OR DELETE ON mpe_rules
  FOR EACH ROW EXECUTE FUNCTION rules_immutable();
CREATE TRIGGER interval_rules_immutable BEFORE UPDATE OR DELETE ON interval_rules
  FOR EACH ROW EXECUTE FUNCTION rules_immutable();

-- ---------------------------------------------------------------- Row-Level Security (second layer)
-- The API sets, per transaction: SET LOCAL app.user_id, app.role, app.business_ids, app.area_ids.
CREATE OR REPLACE FUNCTION app_area_ids() RETURNS uuid[] AS $$
  SELECT COALESCE(NULLIF(current_setting('app.area_ids', true), ''), '{}')::uuid[];
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION app_business_ids() RETURNS uuid[] AS $$
  SELECT COALESCE(NULLIF(current_setting('app.business_ids', true), ''), '{}')::uuid[];
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION app_role() RETURNS text AS $$
  SELECT COALESCE(current_setting('app.role', true), '');
$$ LANGUAGE sql STABLE;

ALTER TABLE instruments ENABLE ROW LEVEL SECURITY;
CREATE POLICY instruments_owner ON instruments FOR ALL
  USING (app_role() IN ('OWNER','TRADER') AND (business_id = ANY (app_business_ids()) OR on_behalf_of_business_id = ANY (app_business_ids())));
CREATE POLICY instruments_staff ON instruments FOR ALL
  USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY instruments_admin ON instruments FOR ALL
  USING (app_role() = 'ADMIN');

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY applications_owner ON applications FOR ALL
  USING (app_role() IN ('OWNER','TRADER') AND business_id = ANY (app_business_ids()));
CREATE POLICY applications_staff ON applications FOR ALL
  USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY applications_inspector ON applications FOR SELECT
  USING (app_role() = 'INSPECTOR' AND EXISTS (
    SELECT 1 FROM inspection_visits v
    WHERE v.application_id = applications.id
      AND v.inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      AND v.status IN ('SCHEDULED','IN_PROGRESS')));
CREATE POLICY applications_admin ON applications FOR ALL
  USING (app_role() = 'ADMIN');

ALTER TABLE inspection_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY visits_inspector ON inspection_visits FOR ALL
  USING (app_role() = 'INSPECTOR' AND inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY visits_staff ON inspection_visits FOR ALL
  USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
    SELECT 1 FROM applications a WHERE a.id = inspection_visits.application_id AND a.area_id = ANY (app_area_ids())));
CREATE POLICY visits_admin ON inspection_visits FOR ALL
  USING (app_role() = 'ADMIN');

-- ---------------------------------------------------------------- database roles (grants)
-- nirikshan_app: used by the API. INSERT only on audit_events; no DDL; no BYPASSRLS.
-- nirikshan_public: used by the public read path. SELECT only on public_certificate_index, public_stats_aggregate, notices, rule tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nirikshan_app') THEN
    CREATE ROLE nirikshan_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nirikshan_public') THEN
    CREATE ROLE nirikshan_public NOLOGIN;
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO nirikshan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM nirikshan_app;
GRANT SELECT ON public_certificate_index, public_stats_aggregate, notices TO nirikshan_public;
GRANT INSERT ON public_lookup_log, tamper_reports TO nirikshan_public;
