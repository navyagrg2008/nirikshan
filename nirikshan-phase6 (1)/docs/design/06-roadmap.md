# Roadmap: Phases 2 to 6

Phase 1 (this package) is requirements and design. Each later phase ends with a working build, tests and a zip.

| Phase | Name | Sprints | Exit criterion |
|---|---|---|---|
| 1 | Requirements and design | outside sprints | This package reviewed and open questions answered |
| 2 | Foundation | 1-2 | Users can log in and register an instrument |
| 3 | Application and scheduling | 3-4 | Owner applies and an inspector is assigned |
| 4 | Inspection and certificate | 5-6 | Full core flow: register to certificate and public validation |
| 5 | Lifecycle and admin | 7-8 | Whole system including Admin portal |
| 6 | Testing and pilot | 9 | Ready for pilot |

## Phase 2: Foundation (Sprints 1-2)
- Monorepo (pnpm), docker-compose (Postgres+PostGIS, Redis, Keycloak, MinIO, Mailpit, ClamAV), CI.
- Design system tokens, core components, EN/HI i18n, light/dark.
- Keycloak realm, BFF login, OTP, 5-step registration with consent, officer account approval, staff invite.
- Roles, RBAC, jurisdiction and ownership scope, RLS, audit trail, field encryption helpers.
- Public shell: landing, rules, notices, help, legal pages.
- Master data admin, instrument registry (6-step wizard, server drafts, duplicate warning, bulk register for traders).
- **Exit:** register, log in, approve account, register instrument. Unit and RLS tests green.

## Phase 3: Application and scheduling (Sprints 3-4)
- Application with pre-check, server-calculated due dates, rule version pinning.
- Document upload (signed URLs, virus scan), officer document check, case state machine.
- Owner tracking (stepper, timeline, live updates), reschedule request, cancel.
- Scheduling engine (filter, score, breakdown), AUTO/REVIEW, officer calendar, bulk reschedule.
- Notification engine and templates (SMS/email/in-app).
- **Exit:** owner applies, officer checks documents, inspector is assigned, everyone is notified.

## Phase 4: Inspection and certificate (Sprints 5-6)
- Inspector workspace: arrive with geofence, checklist, trials with server verdicts, evidence, autosave drafts.
- Officer decision with step-up auth, dual approval threshold.
- Certificate: numbering, PDF (EN/HI), fingerprint, QR, KMS signing, owner copy and print copy.
- Public validation, Verified Seal, directory, tamper reports, anti-abuse.
- **Exit:** register to certificate to validation works end to end; Playwright golden path passes.

## Phase 5: Lifecycle and admin (Sprints 7-8)
- Renewal reminders (60/30/15/7/1), expiry sweeper, DUE_FOR_RENEWAL, enforcement drives and notices.
- Transfer, change address, de-registration, repair jobs.
- Admin portal: users, rules (draft > review > publish, diff, overlap block), audit viewer, system, privacy.
- Dashboards (officer, admin), reports library, data migration tool, retention jobs.
- **Exit:** every page in the sitemap works.

## Phase 6: Testing and pilot (Sprint 9)
- UAT scripts per role, E2E for every role, axe a11y sweep, Lighthouse.
- Security: IDOR suite, auth bypass, rate-limit and upload abuse tests, pen-test plan, dependency and image scans.
- Performance: load test against NFR targets.
- Training material, user manuals (EN/HI), runbooks, backup restore drill, pilot checklist.
- **Exit:** pilot sign-off checklist complete.

## Risks
| Risk | Mitigation |
|---|---|
| SMS delivery needs DLT template registration in India | Start registration in Phase 2; console provider meanwhile |
| Legacy data quality | Validation report in migration tool; dry-run before import |
| Rules differ by state | Rules are data, effective-dated and versioned; no code change |
| Inspector connectivity in the field | Server drafts, blocking banner, restore on return |
| Key management | KMS shim behind one interface; real KMS before pilot |

## Open questions (answers needed before Phase 2)
1. State/department name, logo and division codes for certificate numbers (`NRK/CERT/{DIV}/{YYYY}/{seq}`).
2. SMS provider and DLT sender/template IDs; email sender domain.
3. CAPTCHA choice: Cloudflare Turnstile or hCaptcha.
4. Hosting: AWS region and whether KMS/Secrets Manager are available for the pilot.
5. Initial categories, capacity bands, accuracy classes and the real MPE/interval tables (seed data stays synthetic until supplied).
6. Dual-approval threshold, SLA hours, application validity window, marginal-pass percentage (defaults: 80-100% of MPE).
7. Geofence radius for inspector arrival (default 100 m).
8. Legal-retention periods for certificates and audit data.
9. Hindi translation review owner.
10. Is Senior Officer a separate role in your department, or a flag on Officer?
