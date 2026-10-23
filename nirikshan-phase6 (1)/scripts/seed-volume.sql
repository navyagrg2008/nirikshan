-- Synthetic volume for load tests: +40,000 instruments, +40,000 applications (mixed statuses), about +12,000 certificates.
-- Clones one existing application, its certificate and instrument, so run the Phase 3/4 browser flows (or any issue-a-certificate flow) first. SYNTHETIC DATA ONLY. Never run on a real system.
-- The demo owner's business keeps 300 of the new instruments (a big trader); the rest go to the other businesses.
-- Usage: psql -h 127.0.0.1 -p 5545 -U postgres -d nrk_dev -f scripts/seed-volume.sql
\set ON_ERROR_STOP on
BEGIN;
-- Templates: the first application that already has a certificate, and its instrument.
CREATE TEMP TABLE t_cert AS SELECT * FROM certificates ORDER BY created_at LIMIT 1;
CREATE TEMP TABLE t_app AS SELECT * FROM applications WHERE id=(SELECT application_id FROM t_cert);
CREATE TEMP TABLE t_ins AS SELECT * FROM instruments WHERE id=(SELECT instrument_id FROM t_app);
CREATE TEMP TABLE biz AS SELECT id, row_number() OVER (ORDER BY id) rn FROM businesses WHERE id <> (SELECT business_id FROM t_ins);
CREATE TEMP TABLE ar AS SELECT id, row_number() OVER (ORDER BY id) rn FROM areas;
CREATE TEMP TABLE newins AS SELECT gen_random_uuid() id, n FROM generate_series(1,40000) n;
INSERT INTO instruments (id, business_id, category_id, capacity_band_id, accuracy_class_id, capacity, capacity_unit, serial_no, make, area_id, status, address_enc, created_by)
 SELECT ni.id, CASE WHEN ni.n <= 300 OR (SELECT count(*) FROM biz) = 0 THEN t.business_id ELSE (SELECT id FROM biz WHERE rn = 1 + ni.n % (SELECT count(*) FROM biz)) END,
        t.category_id, t.capacity_band_id, t.accuracy_class_id, t.capacity, t.capacity_unit, 'LT-'||ni.n, 'LoadMake', (SELECT id FROM ar WHERE rn = 1 + ni.n % (SELECT count(*) FROM ar)), 'REGISTERED', t.address_enc, t.created_by
 FROM newins ni, t_ins t;
CREATE TEMP TABLE newapp AS SELECT gen_random_uuid() id, ni.id ins, ni.n,
  (ARRAY['APPLIED','DOCUMENT_CHECKED','SCHEDULED','INSPECTED','CERTIFICATE_ISSUED','CERTIFICATE_ISSUED','CERTIFICATE_ISSUED','CANCELLED','REJECTED','APPROVED'])[1 + ni.n % 10] st FROM newins ni;
INSERT INTO applications (id, application_no, instrument_id, business_id, area_id, type, status, rule_set_id, due_date, created_at, applied_by)
 SELECT na.id, 'LT-APP-'||na.n, na.ins, i.business_id, i.area_id, t.type, na.st::application_status, t.rule_set_id, current_date + (na.n % 60), now() - ((na.n % 120) || ' days')::interval, t.applied_by
 FROM newapp na JOIN instruments i ON i.id = na.ins, t_app t;
INSERT INTO certificates (id, cert_no, application_id, instrument_id, division_id, status, verified_on, valid_till, rule_set_id, pdf_key, fingerprint, key_id, issued_by, validity_months)
 SELECT gen_random_uuid(), 'LT-C-'||na.n, na.id, na.ins, t.division_id,
  (ARRAY['VALID','VALID','VALID','EXPIRED','SUSPENDED'])[1 + na.n % 5]::certificate_status,
  current_date - 300 + (na.n % 250), current_date - 300 + (na.n % 250) + 365, t.rule_set_id, 'x/'||na.n||'.pdf', gen_random_bytes(32), t.key_id, t.issued_by, 12
 FROM newapp na, t_cert t WHERE na.st = 'CERTIFICATE_ISSUED';
COMMIT;
ANALYZE;
SELECT (SELECT count(*) FROM instruments) instruments, (SELECT count(*) FROM applications) applications, (SELECT count(*) FROM certificates) certificates;
