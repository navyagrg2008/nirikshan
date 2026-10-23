# Phase 2: Foundation. What was built, what was proven, what was not

## Built
**API (NestJS)**: registration with mobile OTP and document upload; officer approval; password and OTP login; staff TOTP MFA with recovery codes; staff invites; sessions (idle and absolute limits, list and revoke); step-up re-authentication; CSRF; rate limits; idempotency; instrument registry (server draft, duplicate detection and officer override, capacity-band checks, out-of-area flag, optimistic locking, field locks, CSV export, trader bulk upload and on-behalf customers); master data admin; in-app notifications and EN/HI templates; public stats, rules, notices, contact form; hash-chained audit trail; Row-Level Security as a second authorization layer; field-level encryption.
**Web (Next.js 15, Tailwind 4)**: public shell (home, rules, notices, help, privacy, terms, accessibility), login with OTP/MFA/forced password change, forgot password, 5-step registration, pending page, staff invite acceptance, owner/trader (dashboard, instruments list, 6-step wizard with autosaved draft, detail and edit, bulk upload, alerts, settings), officer (dashboard, queue for accounts and duplicates), admin (dashboard, users and invites, master data, audit and chain verification), inspector placeholder. English and Hindi, light and dark, session timeout warning, step-up dialog.

## Proof
| Check | Result |
|---|---|
| Shared package tests (passwords, masking, schemas, permissions, state machine) | 17 pass |
| API tests: crypto (6), auth and sessions (23), instruments, IDOR, RLS, uploads (18), master data and public (10) | 57 pass |
| Browser run against a live API and web (Playwright): register, officer MFA login and approval, document link, owner wizard, edit, admin audit verify with step-up, sign-out | 38 checks pass |
| Automated accessibility (axe, WCAG 2.2 AA rules) on 20 views, light and dark home | 0 serious or critical |
| Type checks, web production build | clean |

## Not proven. Please read this part.
- **Keycloak is not integrated** (ADR 0001). Login is built in.
- **PostGIS code paths are untested.** The sandbox cannot install PostGIS; tests ran on a point/polygon fallback. Area containment checks use the division comparison there. Run the suite in CI against `postgis/postgis` before trusting geo logic.
- **Docker files, nginx config, CI workflow are untested** (no Docker or GitHub here).
- **S3, ClamAV and SMTP providers are untested.** Local storage and the built-in scanner (EICAR and PDF-script markers) are tested. SMS has no gateway: dev prints to the log; production refuses to start with it.
- **Accessibility**: automated rules only. No screen-reader pass, no keyboard-only audit by a person, Hindi copy not reviewed by a native reviewer.
- **Hindi coverage is partial**: navigation, home, login, registration labels, instruments headings and errors. Staff screens and long pages are English.
- No web unit tests and no load tests.

## Deviations from the brief
1. `packages/ui` was not created; components live in `apps/web/components`.
2. Owner MFA setup UI is not built (API endpoints exist). Staff MFA is mandatory and done.
3. Authenticator enrolment shows the setup key and an `otpauth` link, not a QR image.
4. Master data screen edits via a JSON box, not per-entity forms.
5. Cookie-based sessions with a Next.js rewrite proxy stand in for a full BFF service.
6. `tsx` cannot run the API (no decorator metadata); `pnpm dev` compiles with tsc in watch mode instead.

## Deferred to later phases
Instrument transfer and de-registration, polygon editor for areas, XLSX bulk upload, Storybook, BullMQ jobs (retention runs on demand), KMS adapter, applications, scheduling, inspection, certificates.

## Open questions for you
1. Must Keycloak be in the pilot, or is built-in login acceptable? (ADR 0001)
2. Which SMS gateway and DLT template route will the department use?
3. Is the privacy notice text approved? The one here is a draft.
4. Confirm area hierarchy: Division > Zone > Circle > Ward.
5. Phase 1 open questions were answered with defaults; the list is in `docs/design/01-SRS.md`.
