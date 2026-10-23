# 1. Deploy and roll back

**Not yet proven on a real server.** The Dockerfiles and `infra/docker-compose.yml` were never run (no Docker in the build environment). Do the first deploy on a staging copy and fix what breaks before relying on this page.

## Before you start
1. Tests green on the commit: `pnpm -r typecheck`, API `npx jest --runInBand`, shared tests, web `next build`.
2. Fresh backup exists and is under 24 h old (runbook 2).
3. Read the new migration files (`apps/api/src/db/migrations/NNN_*.sql`). Migrations only go forward. If one drops or rewrites data, take a manual backup first.
4. Production settings present (the API refuses to start otherwise): `ROOT_KEYS`, `COOKIE_SECURE=true`, `STORAGE_PROVIDER=s3` (not local), `SCAN_PROVIDER=clamav`, `CAPTCHA_PROVIDER` + `CAPTCHA_SECRET`, `ALLOWED_ORIGINS` and `PUBLIC_BASE_URL` as https, `TRUST_PROXY=1` (one nginx in front). Web build needs `NEXT_PUBLIC_TURNSTILE_SITEKEY` at **build time** if Turnstile is used.

## Steps
1. Turn the maintenance banner on if users will notice (runbook 6).
2. Build images: `docker build -f infra/Dockerfile.api -t nirikshan-api:<version> .` and the same for web.
3. Run migrations once, from one place: `npm run migrate` in `apps/api` with the production `DATABASE_URL`. It is safe to re-run; applied files are skipped.
4. Start the new API, then the new web. Start API **before** web so the web never points at an old API with new screens.
5. Check: `GET /api/v1/health/live` and `/api/v1/health/ready` return 200; open `/login`, `/validate`; sign in as an admin and open Admin > System; the ten jobs are listed.
6. Turn the banner off.

## Roll back
- **Code only (no new migration):** start the previous image tags for API and web. Done.
- **With a migration:** the old code usually still runs against the new columns because migrations here only add. If the migration broke something, restore the pre-deploy backup into a scratch database, check it (runbook 2), then switch `DATABASE_URL`. This loses everything written after the backup, so tell the office first.
- After any rollback: Admin > System > Jobs, and run `audit-verify` by hand to confirm the chain is intact.

## Tell
Office head (before and after). If rolled back, write down why in the incident log.
