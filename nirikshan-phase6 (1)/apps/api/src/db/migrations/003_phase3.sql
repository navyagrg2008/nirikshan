-- Phase 3: applications, document check, scheduling.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SEQUENCE IF NOT EXISTS application_no_seq START 100001;

ALTER TABLE applications
  ADD COLUMN cancel_reason text,
  ADD COLUMN ready_at timestamptz,                 -- when the case last became DOCUMENT_CHECKED (starts the SCHEDULE SLA clock)
  ADD COLUMN doc_checked_at timestamptz,
  ADD COLUMN doc_checked_by uuid REFERENCES users(id),
  ADD COLUMN failed_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN not_before date,                      -- set by bulk reschedule: do not schedule earlier than this day
  ADD COLUMN applied_by uuid REFERENCES users(id);

ALTER TABLE application_documents
  ADD COLUMN superseded boolean NOT NULL DEFAULT false,
  ADD COLUMN original_name_enc bytea,
  ADD COLUMN reason_code text,
  ADD COLUMN reviewed_at timestamptz;
CREATE UNIQUE INDEX application_documents_version_uq ON application_documents (application_id, document_type_id, doc_version);
DROP INDEX IF EXISTS application_documents_app_idx;
CREATE INDEX application_documents_app_idx ON application_documents (application_id) WHERE NOT superseded;

CREATE INDEX applications_area_status_idx ON applications (area_id, status);

CREATE TABLE reschedule_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  preferred_from date NOT NULL,
  preferred_to date,
  status request_status NOT NULL DEFAULT 'OPEN',
  decided_by uuid REFERENCES users(id),
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reschedule_one_open ON reschedule_requests (application_id) WHERE status = 'OPEN';

-- A proposal the engine could not auto-assign (REVIEW mode) or an officer should confirm.
CREATE TABLE schedule_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id),
  inspector_id uuid REFERENCES users(id),          -- null when no candidate was found
  proposed_window tstzrange,
  score_breakdown jsonb,
  reasons text[] NOT NULL DEFAULT '{}',            -- why review is needed: LOW_SCORE, OUTSIDE_SLA, NO_CANDIDATE, OWNER_PREFERENCE_UNMET
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','SUPERSEDED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX schedule_proposals_one_pending ON schedule_proposals (application_id) WHERE status = 'PENDING';

CREATE TABLE inspector_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  daily_capacity int NOT NULL DEFAULT 4 CHECK (daily_capacity BETWEEN 1 AND 12),
  home_enc bytea,                                  -- encrypted {lat,lng}; used only for the distance score
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE scheduling_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  weights jsonb NOT NULL DEFAULT '{"workload":35,"distance":25,"specialisation":15,"success":10,"noRepeat":15}',
  auto_threshold numeric NOT NULL DEFAULT 50,      -- below this the engine proposes and an officer confirms (REVIEW)
  day_start_hour int NOT NULL DEFAULT 10,
  day_end_hour int NOT NULL DEFAULT 18,
  slot_hours int NOT NULL DEFAULT 2,
  working_days int[] NOT NULL DEFAULT '{1,2,3,4,5,6}',   -- ISO weekday, Monday = 1
  max_failed_attempts int NOT NULL DEFAULT 3,
  horizon_days int NOT NULL DEFAULT 21
);
INSERT INTO scheduling_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- No inspector can hold two overlapping live visits, even under concurrent requests.
ALTER TABLE inspection_visits ADD CONSTRAINT inspection_visits_no_overlap
  EXCLUDE USING gist (inspector_id WITH =, scheduled_window WITH &&) WHERE (status IN ('SCHEDULED','IN_PROGRESS'));
CREATE INDEX IF NOT EXISTS inspection_visits_inspector_idx ON inspection_visits (inspector_id, status);
CREATE INDEX inspection_visits_app_idx ON inspection_visits (application_id);
CREATE INDEX IF NOT EXISTS inspector_availability_idx ON inspector_availability USING gist (inspector_id, period);

-- ---------------------------------------------------------------- Row-Level Security
CREATE POLICY applications_system ON applications FOR ALL USING (app_role() = 'SYSTEM');
CREATE POLICY visits_system ON inspection_visits FOR ALL USING (app_role() = 'SYSTEM');

ALTER TABLE application_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY appdocs_owner ON application_documents FOR ALL USING (app_role() IN ('OWNER','TRADER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = application_documents.application_id AND a.business_id = ANY (app_business_ids())));
CREATE POLICY appdocs_staff ON application_documents FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = application_documents.application_id AND a.area_id = ANY (app_area_ids())));
CREATE POLICY appdocs_admin ON application_documents FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY appdocs_system ON application_documents FOR ALL USING (app_role() = 'SYSTEM');

ALTER TABLE case_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY history_owner ON case_status_history FOR ALL USING (app_role() IN ('OWNER','TRADER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = case_status_history.application_id AND a.business_id = ANY (app_business_ids())));
CREATE POLICY history_staff ON case_status_history FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = case_status_history.application_id AND a.area_id = ANY (app_area_ids())));
CREATE POLICY history_inspector ON case_status_history FOR SELECT USING (app_role() = 'INSPECTOR' AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = case_status_history.application_id));   -- applications RLS already limits this to assigned open visits
CREATE POLICY history_admin ON case_status_history FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY history_system ON case_status_history FOR ALL USING (app_role() = 'SYSTEM');
-- History is append-only for the application role.
REVOKE UPDATE, DELETE ON case_status_history FROM nirikshan_app;

ALTER TABLE reschedule_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY resched_owner ON reschedule_requests FOR ALL USING (app_role() IN ('OWNER','TRADER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = reschedule_requests.application_id AND a.business_id = ANY (app_business_ids())));
CREATE POLICY resched_staff ON reschedule_requests FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = reschedule_requests.application_id AND a.area_id = ANY (app_area_ids())));
CREATE POLICY resched_admin ON reschedule_requests FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY resched_system ON reschedule_requests FOR ALL USING (app_role() = 'SYSTEM');

ALTER TABLE schedule_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposals_staff ON schedule_proposals FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
  SELECT 1 FROM applications a WHERE a.id = schedule_proposals.application_id AND a.area_id = ANY (app_area_ids())));
CREATE POLICY proposals_admin ON schedule_proposals FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY proposals_system ON schedule_proposals FOR ALL USING (app_role() = 'SYSTEM');

ALTER TABLE inspector_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY avail_self ON inspector_availability FOR SELECT USING (app_role() = 'INSPECTOR' AND inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY avail_staff ON inspector_availability FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
  SELECT 1 FROM user_area_scopes s WHERE s.user_id = inspector_availability.inspector_id AND s.area_id = ANY (app_area_ids())));
CREATE POLICY avail_admin ON inspector_availability FOR SELECT USING (app_role() = 'ADMIN');
CREATE POLICY avail_system ON inspector_availability FOR ALL USING (app_role() = 'SYSTEM');
GRANT DELETE ON inspector_availability TO nirikshan_app;

ALTER TABLE inspector_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self ON inspector_profiles FOR SELECT USING (app_role() = 'INSPECTOR' AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY profiles_staff ON inspector_profiles FOR SELECT USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND EXISTS (
  SELECT 1 FROM user_area_scopes s WHERE s.user_id = inspector_profiles.user_id AND s.area_id = ANY (app_area_ids())));
CREATE POLICY profiles_admin ON inspector_profiles FOR ALL USING (app_role() = 'ADMIN');
CREATE POLICY profiles_system ON inspector_profiles FOR ALL USING (app_role() = 'SYSTEM');

-- Policies that look at other protected tables go through SECURITY DEFINER helpers. Without them,
-- applications -> inspection_visits -> applications is a policy cycle and PostgreSQL refuses to plan any query on either table.
CREATE OR REPLACE FUNCTION app_visit_open_for_me(p_app uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM inspection_visits v WHERE v.application_id = p_app AND v.status IN ('SCHEDULED','IN_PROGRESS')
    AND v.inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid) $$;
CREATE OR REPLACE FUNCTION app_in_my_areas(p_app uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM applications a WHERE a.id = p_app AND a.area_id = ANY (app_area_ids())) $$;
CREATE OR REPLACE FUNCTION instrument_visit_open_for_me(p_inst uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM applications a JOIN inspection_visits v ON v.application_id = a.id WHERE a.instrument_id = p_inst AND v.status IN ('SCHEDULED','IN_PROGRESS')
    AND v.inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid) $$;
CREATE OR REPLACE FUNCTION business_visit_open_for_me(p_biz uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM applications a JOIN inspection_visits v ON v.application_id = a.id WHERE a.business_id = p_biz AND v.status IN ('SCHEDULED','IN_PROGRESS')
    AND v.inspector_id = NULLIF(current_setting('app.user_id', true), '')::uuid) $$;

CREATE OR REPLACE FUNCTION app_in_my_businesses(p_app uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM applications a WHERE a.id = p_app AND a.business_id = ANY (app_business_ids())) $$;
CREATE POLICY visits_owner ON inspection_visits FOR SELECT USING (app_role() IN ('OWNER','TRADER') AND app_in_my_businesses(inspection_visits.application_id));

DROP POLICY applications_inspector ON applications;
CREATE POLICY applications_inspector ON applications FOR SELECT USING (app_role() = 'INSPECTOR' AND app_visit_open_for_me(applications.id));
DROP POLICY visits_staff ON inspection_visits;
CREATE POLICY visits_staff ON inspection_visits FOR ALL USING (app_role() IN ('OFFICER','SENIOR_OFFICER') AND app_in_my_areas(inspection_visits.application_id));

-- An inspector can read only the instrument and business of a visit that is assigned to them and still open.
CREATE POLICY instruments_inspector ON instruments FOR SELECT USING (app_role() = 'INSPECTOR' AND instrument_visit_open_for_me(instruments.id));
CREATE POLICY businesses_inspector ON businesses FOR SELECT USING (app_role() = 'INSPECTOR' AND business_visit_open_for_me(businesses.id));

