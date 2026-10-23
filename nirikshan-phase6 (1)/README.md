# Nirikshan: online verification for legal metrology (Phase 6)

Demonstration system. All data is synthetic. No payments or fees anywhere.

## Run it locally (needs Node 22, pnpm 10, PostgreSQL 16, Redis 7)
```bash
cp .env.example .env            # then export the variables, or use your process manager
pnpm install
pnpm --filter @nirikshan/shared build
pnpm migrate && pnpm seed       # seed prints demo logins and authenticator secrets ONCE
pnpm dev:api                    # http://localhost:4000/api/docs (Swagger, non-production)
pnpm dev:web                    # http://localhost:3000
```
In development, OTP messages are printed in the API log (look for `[dev SMS]`). Without PostGIS the migrations use a point/polygon fallback (development and test only).

## Test
```bash
pnpm --filter @nirikshan/shared test
pnpm --filter @nirikshan/api test     # starts a throwaway Postgres and Redis if TEST_DATABASE_URL / TEST_REDIS_URL are not set
pnpm typecheck && pnpm build
```
`apps/web/e2e/smoke.mjs` (Phase 2) and `smoke-phase3.mjs`, `smoke-phase4.mjs` and `smoke-phase5.mjs` are the browser flow runs described in the phase notes. `sweep-roles.mjs` (Phase 6) opens every page for every role with axe, dark mode, Hindi and 375 px, and fails on console, CSP or server errors. `load-test.mjs` is the load test. All read demo logins from `/var/tmp/seed-out.txt`. Demo officer, owner and two inspectors are seeded; the second inspector exists so the scheduling engine has a choice.

## Phase 6 helpers
```bash
scripts/dev-stack.sh up|down|reset      # local Postgres 5545, Redis 6381, API 4000, web 3000 with demo data
psql -h 127.0.0.1 -p 5545 -U postgres -d nrk_dev -f scripts/seed-volume.sql   # +40k instruments/applications for load tests (synthetic)
scripts/restore-drill.sh                # dump, encrypt, restore into a scratch database, compare, verify the audit chain
```
New settings: `RATE_LIMIT_DEFAULT_PER_MIN` (default 600) and `DASHBOARD_CACHE_SECONDS` (default 0). Production start-up now also requires a CAPTCHA provider and https origins.

## Layout
`apps/api` NestJS API · `apps/web` Next.js app · `packages/shared` schemas, permissions, state machine · `docs/design` Phase 1 design · `docs/adr` decisions · `docs/phase2` to `docs/phase6` each phase's honest status · `docs/runbooks` operations · `docs/manuals` user manuals (EN, HI) · `docs/training` training plan · `infra` Docker, nginx (untested).

Start with `docs/phase6/PHASE6.md`. The pilot gate is `docs/phase6/pilot-signoff-checklist.md`.
