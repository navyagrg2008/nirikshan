-- Phase 5: lifecycle (jobs, renewal, expiry), requests, enforcement, complaints, admin, reports.

-- ---------------------------------------------------------------- background jobs and settings
CREATE TABLE job_runs (
  id bigserial PRIMARY KEY,
  job text NOT NULL,
  trigger text NOT NULL DEFAULT 'SCHEDULE' CHECK (trigger IN ('SCHEDULE','MANUAL','TEST')),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','OK','FAILED','SKIPPED')),
  attempt int NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result jsonb,
  error text,
  started_by uuid REFERENCES users(id)
);
CREATE INDEX job_runs_job_idx ON job_runs (job, started_at DESC);
-- A key that has been used once. Jobs insert before acting, so a retried or double-run job never repeats a send.
CREATE TABLE job_dedupe (
  key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES
  ('maintenance', '{"enabled":false,"level":"info","textEn":"","textHi":""}'),
  ('flags', '{"publicSearch":true,"tamperReports":true,"bulkRegister":true,"selfServiceDataRequests":true}'),
  ('lifecycle', '{"reminderDays":[60,30,15,7,1],"dueForRenewalDays":60,"applicationExpiryDays":30,"visitReminderHours":24,"unscheduledAlertHours":24}')
ON CONFLICT DO NOTHING;
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_runs_admin ON job_runs FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY job_runs_system ON job_runs FOR ALL USING (app_role() = 'SYSTEM');
ALTER TABLE job_dedupe ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_dedupe_system ON job_dedupe FOR ALL USING (app_role() = 'SYSTEM');
GRANT DELETE ON job_dedupe, job_runs TO nirikshan_app;
GRANT DELETE ON public_lookup_log, in_app_notifications, public_stats_aggregate TO nirikshan_app;
-- Jobs (role SYSTEM) change instrument status when a certificate nears or passes its end date.
CREATE POLICY instruments_system_upd ON instruments FOR UPDATE USING (app_role() = 'SYSTEM');

-- ============================================================ instrument requests (transfer, change of address, de-registration)
CREATE TABLE instrument_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  kind text NOT NULL CHECK (kind IN ('TRANSFER','ADDRESS_CHANGE','DEREGISTER')),
  status request_status NOT NULL DEFAULT 'OPEN',
  area_id uuid NOT NULL REFERENCES areas(id),                 -- instrument's area when asked; decides which officers see it
  requested_by uuid NOT NULL REFERENCES users(id),
  from_business_id uuid NOT NULL REFERENCES businesses(id),
  to_business_id uuid REFERENCES businesses(id),
  new_area_id uuid REFERENCES areas(id),
  reason_code text,
  details_enc bytea,                                          -- encrypted: note, new address, coordinates
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'TRANSFER' OR to_business_id IS NOT NULL),
  CHECK (kind <> 'ADDRESS_CHANGE' OR new_area_id IS NOT NULL)
);
CREATE UNIQUE INDEX instrument_requests_one_open ON instrument_requests (instrument_id) WHERE status = 'OPEN';
CREATE INDEX instrument_requests_queue_idx ON instrument_requests (status, kind, area_id, created_at);
ALTER TABLE instrument_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY instrument_requests_owner ON instrument_requests FOR ALL USING (app_role() IN ('OWNER','TRADER') AND from_business_id = ANY (app_business_ids()));
CREATE POLICY instrument_requests_recipient ON instrument_requests FOR SELECT USING (app_role() IN ('OWNER','TRADER') AND to_business_id = ANY (app_business_ids()));
CREATE POLICY instrument_requests_staff ON instrument_requests FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY instrument_requests_admin ON instrument_requests FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY instrument_requests_system ON instrument_requests FOR ALL USING (app_role() = 'SYSTEM');
-- Officers who approve a transfer write the ownership trail.
ALTER TABLE instrument_ownership_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY ownership_history_owner ON instrument_ownership_history FOR SELECT USING (app_role() IN ('OWNER','TRADER') AND (from_business_id = ANY (app_business_ids()) OR to_business_id = ANY (app_business_ids())));
CREATE POLICY ownership_history_staff ON instrument_ownership_history FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (SELECT 1 FROM instruments i WHERE i.id = instrument_id AND i.area_id = ANY (app_area_ids())));
CREATE POLICY ownership_history_admin ON instrument_ownership_history FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY ownership_history_system ON instrument_ownership_history FOR ALL USING (app_role() = 'SYSTEM');

-- ============================================================ repair jobs (trader board)
ALTER TABLE service_jobs ADD COLUMN issue text, ADD COLUMN technician_name text, ADD COLUMN notes text;
CREATE INDEX service_jobs_trader_idx ON service_jobs (trader_business_id, stage);
ALTER TABLE service_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_jobs_trader ON service_jobs FOR ALL USING (app_role() IN ('OWNER','TRADER') AND trader_business_id = ANY (app_business_ids()));
CREATE POLICY service_jobs_admin ON service_jobs FOR SELECT USING (app_role() = 'ADMIN');

-- ============================================================ grievances, tamper reports
CREATE SEQUENCE grievance_seq; CREATE SEQUENCE tamper_seq; CREATE SEQUENCE enforcement_notice_seq;
CREATE OR REPLACE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

ALTER TABLE grievances ADD COLUMN area_id uuid REFERENCES areas(id), ADD COLUMN response text, ADD COLUMN handled_by uuid REFERENCES users(id),
  ADD COLUMN ref_no text NOT NULL DEFAULT ('GRV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('grievance_seq')::text, 5, '0')), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX grievances_ref_idx ON grievances (ref_no);
CREATE INDEX grievances_queue_idx ON grievances (status, area_id, created_at);
ALTER TABLE grievances ENABLE ROW LEVEL SECURITY;
CREATE POLICY grievances_owner ON grievances FOR ALL USING (app_role() IN ('OWNER','TRADER') AND raised_by = app_uid());
CREATE POLICY grievances_staff ON grievances FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY grievances_admin ON grievances FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY grievances_system ON grievances FOR ALL USING (app_role() = 'SYSTEM');

ALTER TABLE tamper_reports ADD COLUMN resolution text, ADD COLUMN handled_by uuid REFERENCES users(id), ADD COLUMN resolved_at timestamptz,
  ADD COLUMN ref_no text NOT NULL DEFAULT ('TMP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('tamper_seq')::text, 5, '0')), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX tamper_reports_ref_idx ON tamper_reports (ref_no);
CREATE INDEX tamper_reports_queue_idx ON tamper_reports (status, assigned_area_id, created_at);
ALTER TABLE tamper_reports ENABLE ROW LEVEL SECURITY;
-- A report with no certificate number has no area yet; any officer may pick it up so it never sits unseen.
CREATE POLICY tamper_staff ON tamper_reports FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND (assigned_area_id IS NULL OR assigned_area_id = ANY (app_area_ids())));
CREATE POLICY tamper_admin ON tamper_reports FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY tamper_system ON tamper_reports FOR ALL USING (app_role() = 'SYSTEM');
-- nirikshan_public keeps its INSERT-only grant; give it an insert policy so the grant is usable if that role is ever used directly.
CREATE POLICY tamper_public_insert ON tamper_reports FOR INSERT WITH CHECK (true);

-- ============================================================ enforcement drives
ALTER TABLE enforcement_drive_items ADD COLUMN notice_no text, ADD COLUMN notified_at timestamptz, ADD COLUMN listed_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE enforcement_drives ADD COLUMN closed_at timestamptz;
ALTER TABLE enforcement_drives ENABLE ROW LEVEL SECURITY;
CREATE POLICY drives_staff ON enforcement_drives FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND area_id = ANY (app_area_ids()));
CREATE POLICY drives_admin ON enforcement_drives FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY drives_system ON enforcement_drives FOR ALL USING (app_role() = 'SYSTEM');
ALTER TABLE enforcement_drive_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY drive_items_staff ON enforcement_drive_items FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (SELECT 1 FROM enforcement_drives d WHERE d.id = drive_id AND d.area_id = ANY (app_area_ids())));
CREATE POLICY drive_items_admin ON enforcement_drive_items FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY drive_items_system ON enforcement_drive_items FOR ALL USING (app_role() = 'SYSTEM');

-- ============================================================ rule set lifecycle
ALTER TABLE rule_sets ADD COLUMN review_remark text, ADD COLUMN submitted_at timestamptz, ADD COLUMN reviewed_at timestamptz;
GRANT DELETE ON rule_sets, mpe_rules, interval_rules, workflow_slas TO nirikshan_app;
-- Retired sets stay frozen too: pinned cases keep calculating from them.
CREATE OR REPLACE FUNCTION rules_immutable() RETURNS trigger AS $$
DECLARE parent_status rule_status;
BEGIN
  SELECT status INTO parent_status FROM rule_sets WHERE id = COALESCE(NEW.rule_set_id, OLD.rule_set_id);
  IF parent_status IN ('PUBLISHED','RETIRED') THEN RAISE EXCEPTION 'published rule sets are immutable; create a new version'; END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================================ privacy: data-subject requests, legacy import
CREATE SEQUENCE dsr_seq;
ALTER TABLE data_subject_requests ADD COLUMN resolution text, ADD COLUMN export_key text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ref_no text NOT NULL DEFAULT ('DSR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('dsr_seq')::text, 5, '0'));
CREATE UNIQUE INDEX dsr_ref_idx ON data_subject_requests (ref_no);
CREATE UNIQUE INDEX dsr_one_open_per_kind ON data_subject_requests (user_id, kind) WHERE status IN ('OPEN','IN_PROGRESS');
ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY dsr_owner ON data_subject_requests FOR ALL USING (app_role() IN ('OWNER','TRADER') AND user_id = app_uid());
CREATE POLICY dsr_admin ON data_subject_requests FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY dsr_system ON data_subject_requests FOR ALL USING (app_role() = 'SYSTEM');
GRANT DELETE ON in_app_notifications, notification_preferences, account_documents TO nirikshan_app;

ALTER TABLE users ADD COLUMN legacy_import_id uuid;
ALTER TABLE instruments ADD COLUMN legacy_ref text, ADD COLUMN legacy_valid_till date, ADD COLUMN migration_job_id uuid;
CREATE UNIQUE INDEX instruments_legacy_ref_idx ON instruments (legacy_ref) WHERE legacy_ref IS NOT NULL;
CREATE TABLE migration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES users(id),
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'VALIDATED' CHECK (status IN ('VALIDATED','COMMITTED','FAILED','DISCARDED')),
  total int NOT NULL, valid int NOT NULL, invalid int NOT NULL,
  report jsonb NOT NULL DEFAULT '[]',                  -- row-level problems (capped), no personal data beyond the row number and field
  rows_enc bytea,                                      -- encrypted normalised valid rows, removed after commit or discard
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
ALTER TABLE migration_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY migration_admin ON migration_jobs FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY migration_system ON migration_jobs FOR ALL USING (app_role() = 'SYSTEM');
GRANT DELETE ON app_settings TO nirikshan_app;
CREATE POLICY instruments_system_ins ON instruments FOR INSERT WITH CHECK (app_role() = 'SYSTEM');
