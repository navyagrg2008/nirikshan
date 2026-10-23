# ADR 0008: Evaluate row-level-security helpers once per query

Date 2026-10-22 · Status: accepted

## Context
Every table has row-level security. The policies called small helper functions (`app_role()`, `app_area_ids()`, `app_business_ids()`) and, for certificates, visits and decisions, a function that looked up the application row by id. PostgreSQL ran each call **once per row**. With 40,000 applications a plain count took about 220 ms for an officer; a 20-query dashboard took 1.7 s for one user and 7.7 s with ten users.

## Decision
1. Wrap each helper in `(SELECT ...)` inside every policy (migration 006), so it is evaluated once per query. Array results are cast so `= ANY ((SELECT ...)::uuid[])` stays an array test.
2. Replace `app_in_my_areas(application_id)` and `app_in_my_businesses(application_id)` with `application_id IN (SELECT app_apps_in_my_areas())` and the businesses version. The new functions are `SECURITY DEFINER` and return the matching application ids once per query.
3. The migration rewrites the policies by reading them from `pg_policies`, and skips ones already rewritten, so it can be re-run.

## Why not the alternatives
- Caching the user's scope in a temporary table per transaction: more moving parts, same effect.
- Removing row-level security for officers and filtering in code only: loses the second line of defence (see ADR 0003 and the IDOR tests).
- Joining to `applications` inside the policy instead of using a function: can make two tables' policies call each other and PostgreSQL refuses that ("infinite recursion"); `SECURITY DEFINER` avoids it, as before.

## Consequences
Same rules, same results: the 247 tests (including the all-roles route sweep and IDOR matrix) pass unchanged. Officer count queries went from about 220 ms to a few ms. Any new policy must use the wrapped form; `docs/phase6/security-tests.md` and this ADR are the reminder. A future migration that adds a policy with a bare `app_role()` will work but be slow at volume.
