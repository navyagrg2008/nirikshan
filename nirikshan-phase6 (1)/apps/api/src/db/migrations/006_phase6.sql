-- Phase 6: indexes found missing by the load test with realistic volume.
-- Owner and trader screens filter on business_id OR on_behalf_of_business_id; only the first had an index.
CREATE INDEX IF NOT EXISTS instruments_on_behalf_idx ON instruments (on_behalf_of_business_id) WHERE on_behalf_of_business_id IS NOT NULL;

-- Row-level security policies called app_role(), app_area_ids(), app_business_ids() and friends once per row.
-- Wrapping each call in (SELECT ...) makes PostgreSQL evaluate it once per query (an InitPlan) instead.
-- Same rule, same results; at 40,000 rows a count for an officer fell from about 220 ms to a few ms (see docs/phase6/load-test.md).
-- Safe to re-run: a call that is already wrapped is left alone.
DO $$
DECLARE p record; q text; w text; stmt text;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' LOOP
    q := p.qual; w := p.with_check;
    -- The array helpers need a cast so that "= ANY ((SELECT ...))" is read as an array, not as a set of rows.
    IF q IS NOT NULL THEN
      q := regexp_replace(q, '(?<!SELECT )\m(app_(?:area_ids|business_ids))\(\)', '(SELECT \1())::uuid[]', 'g');
      q := regexp_replace(q, '(?<!SELECT )\m(app_(?:role|user_id))\(\)', '(SELECT \1())', 'g');
    END IF;
    IF w IS NOT NULL THEN
      w := regexp_replace(w, '(?<!SELECT )\m(app_(?:area_ids|business_ids))\(\)', '(SELECT \1())::uuid[]', 'g');
      w := regexp_replace(w, '(?<!SELECT )\m(app_(?:role|user_id))\(\)', '(SELECT \1())', 'g');
    END IF;
    IF q IS DISTINCT FROM p.qual OR w IS DISTINCT FROM p.with_check THEN
      stmt := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
      IF q IS NOT NULL THEN stmt := stmt || ' USING (' || q || ')'; END IF;
      IF w IS NOT NULL THEN stmt := stmt || ' WITH CHECK (' || w || ')'; END IF;
      EXECUTE stmt;
    END IF;
  END LOOP;
END $$;

-- Dashboard trend charts group certificates by creation week.
CREATE INDEX IF NOT EXISTS certificates_created_idx ON certificates (created_at);

-- Certificates, visits and decisions asked "is this application in my areas / businesses?" once per row, through a function that looks the
-- application up each time. These two functions return the matching application ids once per query instead (hashed by PostgreSQL).
-- They are SECURITY DEFINER for the same reason the old ones were: it avoids a loop between the policies of the two tables.
CREATE OR REPLACE FUNCTION app_apps_in_my_areas() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT a.id FROM applications a WHERE a.area_id = ANY (app_area_ids()) $$;
CREATE OR REPLACE FUNCTION app_apps_in_my_businesses() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT a.id FROM applications a WHERE a.business_id = ANY (app_business_ids()) $$;
REVOKE ALL ON FUNCTION app_apps_in_my_areas(), app_apps_in_my_businesses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_apps_in_my_areas(), app_apps_in_my_businesses() TO nirikshan_app;
DO $$
DECLARE p record; q text; w text; stmt text;
BEGIN
  FOR p IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND (qual ~ 'app_in_my_(areas|businesses)\(' OR with_check ~ 'app_in_my_(areas|businesses)\(') LOOP
    q := p.qual; w := p.with_check;
    IF q IS NOT NULL THEN q := regexp_replace(regexp_replace(q, 'app_in_my_areas\(([a-z_]+)\)', '\1 IN (SELECT app_apps_in_my_areas())', 'g'), 'app_in_my_businesses\(([a-z_]+)\)', '\1 IN (SELECT app_apps_in_my_businesses())', 'g'); END IF;
    IF w IS NOT NULL THEN w := regexp_replace(regexp_replace(w, 'app_in_my_areas\(([a-z_]+)\)', '\1 IN (SELECT app_apps_in_my_areas())', 'g'), 'app_in_my_businesses\(([a-z_]+)\)', '\1 IN (SELECT app_apps_in_my_businesses())', 'g'); END IF;
    stmt := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF q IS NOT NULL THEN stmt := stmt || ' USING (' || q || ')'; END IF;
    IF w IS NOT NULL THEN stmt := stmt || ' WITH CHECK (' || w || ')'; END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

-- The officer case list pages by (created_at, id); without this index PostgreSQL sorts every application to return 25.
CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at, id);
