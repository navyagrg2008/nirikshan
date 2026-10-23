-- Phase 4: inspection, decision, certificate.

CREATE TABLE inspection_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  min_trials int NOT NULL DEFAULT 3,
  geofence_radius_m int NOT NULL DEFAULT 200,
  start_early_minutes int NOT NULL DEFAULT 60,        -- an inspector may start this long before the window opens
  start_late_minutes int NOT NULL DEFAULT 240,        -- and this long after it closes
  required_evidence text[] NOT NULL DEFAULT '{DISPLAY,SEAL}',
  dual_approval_categories text[] NOT NULL DEFAULT '{WEIGHBRIDGE}',   -- category codes that need a second approver
  draft_days int NOT NULL DEFAULT 7
);
INSERT INTO inspection_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE inspection_visits
  ADD COLUMN started_at timestamptz,
  ADD COLUMN arrival_lat numeric(9,6),
  ADD COLUMN arrival_lon numeric(9,6),
  ADD COLUMN arrival_accuracy_m numeric(8,1),
  ADD COLUMN arrival_distance_m numeric(10,1),
  ADD COLUMN checklist_template_id uuid REFERENCES checklist_templates(id),
  ADD COLUMN overall_verdict verdict,
  ADD COLUMN reject_reason_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN inspector_note text,
  ADD COLUMN test_sheet_sha256 bytea,
  ADD COLUMN summary jsonb;                           -- snapshot for the inspector's history (application no., category, instrument no., outcome)
-- A sticker serial is physical; it can be used on one submitted inspection only.
CREATE UNIQUE INDEX inspection_visits_sticker_uq ON inspection_visits (lower(sticker_serial)) WHERE sticker_serial IS NOT NULL AND status = 'SUBMITTED';

ALTER TABLE test_measurements ADD COLUMN error_unit text NOT NULL DEFAULT 'g';
ALTER TABLE evidence
  ADD COLUMN geo_lat numeric(9,6), ADD COLUMN geo_lon numeric(9,6),
  ADD COLUMN size_bytes int, ADD COLUMN sha256 bytea, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX evidence_visit_idx ON evidence (visit_id);
CREATE INDEX checklist_responses_visit_idx ON checklist_responses (visit_id);
CREATE INDEX test_measurements_visit_idx ON test_measurements (visit_id);
ALTER TABLE inspection_drafts ADD COLUMN version int NOT NULL DEFAULT 1;

ALTER TABLE decisions
  ADD COLUMN status text NOT NULL DEFAULT 'FINAL' CHECK (status IN ('PENDING_SECOND','FINAL','VOIDED')),
  ADD COLUMN marginal boolean NOT NULL DEFAULT false,
  ADD COLUMN second_decided_at timestamptz,
  ADD COLUMN second_remarks text;
CREATE INDEX decisions_app_idx ON decisions (application_id, created_at);
-- Only one decision may be waiting for a second approver per case.
CREATE UNIQUE INDEX decisions_one_pending ON decisions (application_id) WHERE status = 'PENDING_SECOND';

ALTER TABLE certificates
  ADD COLUMN validity_months int NOT NULL DEFAULT 12,
  ADD COLUMN pdf_sha256 bytea,                        -- hash of the stored file; `fingerprint` is the hash of the canonical content (see ADR 0005)
  ADD COLUMN content jsonb,                           -- canonical content the PDF and the fingerprint are made from
  ADD COLUMN visit_id uuid REFERENCES inspection_visits(id),
  ADD COLUMN decision_id uuid REFERENCES decisions(id),
  ADD COLUMN sticker_serial text;
CREATE UNIQUE INDEX certificates_one_valid_per_application ON certificates (application_id) WHERE status IN ('VALID','SUSPENDED') AND replaces_certificate_id IS NULL;
ALTER TABLE certificate_status_history ADD COLUMN reason_text text;

-- Next certificate number for a division and year. The row lock serialises issuing, so two officers never get the same number.
CREATE OR REPLACE FUNCTION next_cert_seq(p_div uuid, p_year int) RETURNS int LANGUAGE sql VOLATILE AS $$
  INSERT INTO cert_sequences (division_id, year, last_seq) VALUES (p_div, p_year, 1)
  ON CONFLICT (division_id, year) DO UPDATE SET last_seq = cert_sequences.last_seq + 1
  RETURNING last_seq $$;

-- ---------------------------------------------------------------- row-level security
CREATE OR REPLACE FUNCTION visit_mine(p_visit uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM inspection_visits v WHERE v.id = p_visit AND v.inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid) $$;
CREATE OR REPLACE FUNCTION visit_in_my_areas(p_visit uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM inspection_visits v JOIN applications a ON a.id = v.application_id WHERE v.id = p_visit AND a.area_id = ANY (app_area_ids())) $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checklist_responses','test_measurements','evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL USING (app_role() = 'INSPECTOR' AND visit_mine(visit_id))$f$, t || '_inspector', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND visit_in_my_areas(visit_id))$f$, t || '_staff', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT USING (app_role() = 'ADMIN')$f$, t || '_admin', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL USING (app_role() = 'SYSTEM')$f$, t || '_system', t);
  END LOOP;
END $$;

-- Drafts are private to the inspector: no officer or admin policy exists on purpose.
ALTER TABLE inspection_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY drafts_owner ON inspection_drafts FOR ALL USING (app_role() = 'INSPECTOR' AND inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND visit_mine(visit_id));
CREATE POLICY drafts_system ON inspection_drafts FOR ALL USING (app_role() = 'SYSTEM');
GRANT DELETE ON inspection_drafts TO nirikshan_app;

-- Submitted inspection data cannot be edited or removed by the application role (amendments are new rows elsewhere, never overwrites).
REVOKE UPDATE, DELETE ON checklist_responses, test_measurements FROM nirikshan_app;
REVOKE DELETE ON evidence FROM nirikshan_app;

ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY decisions_staff ON decisions FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND app_in_my_areas(application_id));
CREATE POLICY decisions_admin ON decisions FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY decisions_system ON decisions FOR ALL USING (app_role() = 'SYSTEM');
REVOKE DELETE ON decisions FROM nirikshan_app;

ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY certs_owner ON certificates FOR SELECT USING (app_role() IN ('OWNER','TRADER') AND app_in_my_businesses(application_id));
CREATE POLICY certs_staff ON certificates FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND app_in_my_areas(application_id));
CREATE POLICY certs_admin ON certificates FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY certs_system ON certificates FOR ALL USING (app_role() = 'SYSTEM');
REVOKE DELETE ON certificates FROM nirikshan_app;

CREATE OR REPLACE FUNCTION cert_visible_to_me(p_cert uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM certificates c WHERE c.id = p_cert AND (
    (app_role() IN ('OWNER','TRADER') AND app_in_my_businesses(c.application_id)) OR
    (app_role() IN ('OFFICER','SENIOR_OFFICER') AND app_in_my_areas(c.application_id)) OR app_role() IN ('ADMIN','SYSTEM'))) $$;
ALTER TABLE certificate_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY certhist_read ON certificate_status_history FOR SELECT USING (cert_visible_to_me(certificate_id));
CREATE POLICY certhist_write ON certificate_status_history FOR INSERT WITH CHECK (app_role() IN ('OFFICER','SENIOR_OFFICER','ADMIN','SYSTEM') AND cert_visible_to_me(certificate_id));
REVOKE UPDATE, DELETE ON certificate_status_history FROM nirikshan_app;

GRANT SELECT, INSERT, UPDATE ON inspection_settings TO nirikshan_app;

-- An inspector may move a case along (start the visit, submit) only while the visit is assigned to them and open.
CREATE POLICY applications_inspector_upd ON applications FOR UPDATE USING (app_role() = 'INSPECTOR' AND app_visit_open_for_me(applications.id));
CREATE POLICY history_inspector_ins ON case_status_history FOR INSERT WITH CHECK (app_role() = 'INSPECTOR' AND app_visit_open_for_me(application_id));
