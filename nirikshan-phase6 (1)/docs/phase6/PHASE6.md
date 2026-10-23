# Phase 6: Testing and pilot readiness. What was built, what was proven, what was not

Exit criterion: **pilot sign-off checklist complete.** It is **not** complete, and the build team cannot complete it alone. `pilot-signoff-checklist.md` lists every line with an owner. The most important blocker: **there is no real SMS sender**, so owners cannot receive a login or registration code in production.

## Built
- **Security test suites** (48 new tests): every-route authorisation sweep for all 6 roles, an automatic IDOR matrix, session and CSRF abuse, hostile input, upload abuse, rate limits, header and secret-leak checks, production start-up checks. See `security-tests.md`.
- **Browser sweep for every role** (`apps/web/e2e/sweep-roles.mjs`): every page, light, dark, Hindi, 375 px, with axe and console/CSP/server-error capture.
- **Load test** (`apps/web/e2e/load-test.mjs`, `scripts/seed-volume.sql`) and **backup restore drill** (`scripts/restore-drill.sh`), plus `scripts/dev-stack.sh` to bring the local stack up.
- **Documents:** UAT scripts for 7 roles (`UAT-scripts.md`), pen-test plan, restore-drill result, load-test result, browser and accessibility results, pilot sign-off checklist; 8 runbooks (`docs/runbooks`); user manuals in English and Hindi (`docs/manuals`); training plan (`docs/training`); ADRs 0008 to 0010.
- **Product changes the testing forced** (all with tests passing):
  - Web security policy now uses a per-request nonce for scripts (ADR 0009). Pages that need data (`/`, `/rules`, `/notices`) are filled on the server.
  - `Cache-Control: no-store` on API responses by default; production refuses to start without a CAPTCHA provider or with non-https origins.
  - Migration 006: row-level-security helpers evaluated once per query, new indexes (ADR 0008).
  - Officer case list and dashboard summary rewritten to page and count in the database.
  - `RATE_LIMIT_DEFAULT_PER_MIN` and `DASHBOARD_CACHE_SECONDS` settings (ADR 0010).
  - Fixes: dashboard trend showed zeros between midnight and 05:30 India time; tables not keyboard-scrollable; phone pages scrolling sideways on admin screens; duplicate import buttons; 21 vulnerable dependency versions upgraded (nodemailer 7 to 10, csv-parse 5 to 7, plus overrides for postcss, uuid, js-yaml).

## Proof (all run 2026-10-22 on the final code unless noted)
| Check | Result |
|---|---|
| API tests, 15 suites together | **247 pass** (199 from earlier phases + 48 new) |
| Shared package tests | 45 pass |
| Type checks (API, web, shared), API build, web production build | clean |
| Browser sweep, every role and page, fresh database, default settings | **222 of 222 pass**; axe serious/critical = 0 in light, dark, Hindi, 375 px |
| Flow runs after the changes: Phase 3 / 4 / 5 | 50 / 69 / 56 pass |
| Lighthouse mobile, 10 public pages | Perf 93 to 99, A11y 100, Best practice 96, SEO 100; JS 126 to 134 KB |
| Dependency audit (`pnpm audit`, prod and dev) | no known vulnerabilities |
| Restore drill | 74 tables and 138,015 rows match; audit chain intact; tampering detected |
| Load test, 40k instruments / 40k applications / 12k certificates, 10 back-to-back clients | reads p97.5 ≤ 120 ms except schedule calendar 327 ms; dashboards ≤ 1.9 s; writes ≤ 39 ms |

## Not proven. Please read this part.
1. **Pilot sign-off is not complete.** Items A1 to A12 in the checklist (SMS, hosting, TLS, secrets, CAPTCHA, ClamAV, backups on the real server, independent pen test, real rules, Hindi review, retention, legal text, second admin) are open. UAT and training have not been run; the scripts and plan exist.
2. **Load targets are not met at 50 constant users.** Officer schedule calendar misses 300 ms even at 10 clients (327 ms). At 50 clients: certificates list 380 ms, case list 496 ms, calendar 1.2 s, dashboards 8 to 10 s (4 timeouts). The test machine had 2 shared cores. The cache (off by default) fixes the admin dashboard but not the officer dashboard's first burst. Details in `load-test.md`.
3. **Public LCP target missed on `/report`** (2.7 s against 2.5 s, slow-4G and slow-CPU simulation in a sandbox). `/notices` layout shift was 0.03 to 0.11 between runs. Desktop and signed-in Lighthouse not run.
4. **No real devices or other browsers.** Chromium only. No screen reader. No Safari or Firefox. No printed-page check.
5. **No independent penetration test.** Our tests are the application's own; they cannot find what the author did not think of.
6. **Docker images, nginx, TLS, ClamAV never run** (no Docker here). `infra/` is still untested. No image scan.
7. **Backups:** only the daily-dump restore is shown. No point-in-time recovery, no restored-file check, no restore on another server, no timed RTO. The RPO/RTO in runbook 2 are proposals.
8. **Production SMS sender missing** (checklist A1). E-mail goes through SMTP; the nodemailer upgrade is covered by type-checks and the test suite but no message was sent to a real mail server.
9. **Runbooks were written, not rehearsed.** The lost-admin path and key rotation were not practised on any system; two column names in runbook 8 must be confirmed on the real database.
10. **Hindi manual and Hindi screens are drafts** that need a native reader. The Hindi manual covers owners and public only; officer, inspector and admin screens are English by design.
11. **Inspector offline behaviour** is untested: the system is online-only; what the inspector sees when the network drops mid-visit was not verified (UAT step INS-5 asks a tester to report it).
12. **Dashboard cache** with the setting turned on has no automated test.
13. **Migration 006 was also applied by hand** to the development database during tuning; on a fresh database it ran through the normal runner (checked after a full reset).

## Deviations from the brief or earlier phases
- Web `style-src` keeps `'unsafe-inline'` (scripts are strict). The brief asked for a strict nonce policy; styles are the exception (ADR 0009).
- All web pages are rendered on request (no static pages) because a nonce cannot be pre-built.
- Load test numbers are p97.5, because the tool does not report p95 (conservative direction).
- Rule tables are still demonstration values (A8).
- The scheduling test now allows cases to fall to officer review near weekends; it was asserting something that depends on the day it runs (the engine's service-deadline rule is working as designed).

## Deferred
Re-encryption after key rotation; stampede protection for the dashboard cache; tuning the officer schedule calendar query; production SMS channel; background report queue for large exports (from Phase 5); a soak test with realistic think time; desktop and signed-in Lighthouse.

## Open questions for you
1. Which SMS provider, and who registers the sender ID and message templates (India needs approved templates)?
2. Which CAPTCHA: Cloudflare Turnstile or hCaptcha?
3. Where will it be hosted, and who runs KMS and backups, with or without point-in-time recovery? What RPO and RTO will the office accept?
4. Who supplies the real permissible-error and interval tables, and who checks them?
5. Who reviews the Hindi, and which official terms must be used?
6. Retention periods for accounts, drafts, logs, documents and the audit trail?
7. Do the Lighthouse targets apply to signed-in areas too, or only to public pages as measured?
8. Who is the independent tester, and when is the pen-test window?
9. How many real pilot users, in which divisions, and for how long?
