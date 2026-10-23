# Final Sitemap (including Admin)

Five interfaces, one codebase, one login. After login the user is redirected by role.
Phase column = when the page is built (see `06-roadmap.md`). "Shell" = layout, "States" = every page also gets loading, empty, error and no-permission states plus EN/HI strings.

## 1. Public (`/`, no login)

| Route | Purpose | Phase |
|---|---|---|
| `/` | Landing: certificate search, scan QR, quick actions, how it works, public stats, latest notices | 2 (shell), 4 (live search) |
| `/validate` | Certificate validation (Certificate no. / Scan QR / Mobile + serial); Verified Seal | 4 |
| `/v/{certNo}.{sig}` | QR landing, same result as `/validate` | 4 |
| `/search` | Public directory, masked results only | 4 |
| `/rules` | Permissible error limits and intervals, with rule version and effective date | 2 |
| `/notices` | Circulars, gazette notices, holidays | 2 |
| `/help` | FAQ, manuals, contact form, grievance link | 2 |
| `/privacy`, `/terms`, `/accessibility` | Plain-language pages | 2 |
| `/login` | Mobile/email + password, OTP option, forgot password | 2 |
| `/register` | 5-step registration + consent | 2 |
| `/register/pending` | Account pending verification | 2 |
| `/invite/{token}` | Staff invite: set password, enrol MFA | 2 |

## 2. Owner / Trader (`/owner`)

| Route | Purpose | Phase |
|---|---|---|
| `/owner/dashboard` | Stat cards, needs attention, open applications | 3 |
| `/owner/instruments` | List, filters, CSV export; trader bulk register | 2 |
| `/owner/instruments/new` | 6-step registration wizard with server draft | 2 |
| `/owner/instruments/:id` | Instrument detail | 2 |
| `/owner/instruments/:id/edit` | Edit, transfer, change address, de-register | 2 (edit), 5 (de-register) |
| `/owner/instruments/:id/history` | Timeline of verifications and certificates | 4 |
| `/owner/instruments/:id/apply` | Pre-check and application form | 3 |
| `/owner/applications` | Application list | 3 |
| `/owner/applications/:id` | Stepper, timeline, reschedule, cancel | 3 |
| `/owner/applications/:id/documents` | Document upload and review comments | 3 |
| `/owner/certificates` | Valid / Expiring / Expired / Revoked tabs | 4 |
| `/owner/certificates/:id` | Certificate view, QR, PDF, share, renew | 4 |
| `/owner/certificates/:id/print` | A4/A5 shop-display copy | 4 |
| `/owner/services` | Trader repair job board | 5 |
| `/owner/notices` | Alerts, reminders, preferences | 3 |
| `/owner/settings` | Profile, language, notifications, security, my data | 2 (security), 5 (my data) |

## 3. Officer (`/officer`)

| Route | Purpose | Phase |
|---|---|---|
| `/officer/dashboard` | Queue bar, SLA, workload, map, exceptions | 5 (full), 3 (queue bar) |
| `/officer/queue` | Cases; tabs: Account approvals, Duplicate overrides, Transfers, De-registration, Grievances, Tamper reports | 2 (accounts), 3 (cases) |
| `/officer/schedule` | Calendar, proposals with score breakdown, AUTO/REVIEW, bulk reschedule | 3 |
| `/officer/cases/:id` | Case file tabs: Application, Documents, Inspection, History, Rules applied | 3, 4 |
| `/officer/decisions` | Pending list and decision panel (re-auth) | 4 |
| `/officer/certificates` | Register, issue, revoke, suspend, re-issue | 4 |
| `/officer/inspectors` | Workload, skills, availability, reassign | 3 |
| `/officer/enforcement` | Expired list, drives, notice letters | 5 |
| `/officer/reports` | Report library | 5 |

## 4. Inspector (`/inspector`, mobile-first)

| Route | Purpose | Phase |
|---|---|---|
| `/inspector/dashboard` | Today's route, progress ring, drafts | 4 |
| `/inspector/visits` | Assigned visits | 4 |
| `/inspector/visits/:id` | 5-step visit: Arrive, Checklist, Test, Evidence, Submit | 4 |
| `/inspector/visits/:id/draft` | Draft recovery | 4 |
| `/inspector/history` | Completed visits | 4 |

## 5. Admin (`/admin`) — new, not in the source brief

| Route | Purpose | Phase |
|---|---|---|
| `/admin/dashboard` | Applications/day, cycle time, rejection rate, renewal compliance, failed jobs, alerts | 5 |
| `/admin/users` | Users, roles, staff invites, suspend/reactivate, MFA status, account approvals, session revoke | 2 (invite, list), 5 (full) |
| `/admin/masterdata` | Category, class, capacity band, areas + polygon editor, checklists, reason codes, document types, holidays, notification templates | 2 |
| `/admin/rules` | MPE, interval, SLA rules; draft > review > publish; diff; overlap block | 5 |
| `/admin/certificates` | Revoke/suspend, key rotation status, template preview | 4 (template), 5 |
| `/admin/audit` | Search, verify hash chain, export | 5 |
| `/admin/reports` | Global reports | 5 |
| `/admin/system` | Feature flags, SLA config, rate limits, maintenance banner, job monitor | 5 |
| `/admin/privacy` | Data-subject requests, consent records, retention jobs, breach checklist | 5 |
| `/admin/migration` | Legacy data import with validation report | 5 |

## 6. System routes

`/403`, `/404`, `/500` (no internal details), `/maintenance`, `/api/docs` (admin only), `/api/v1/health/live`, `/api/v1/health/ready`.

## 7. Navigation per role

- **Owner:** Dashboard, Instruments, Applications, Certificates, Services (trader only), Notices.
- **Officer:** Dashboard, Queue, Schedule, Decisions, Certificates, Inspectors, Enforcement, Reports.
- **Inspector:** Today, Visits, History.
- **Admin:** Dashboard, Users, Master data, Rules, Certificates, Audit, Reports, System, Privacy, Migration.

## 8. API to page map (main links)

| Page | Main API calls |
|---|---|
| `/validate` | `GET /public/validate`, `GET /public/validate/qr/:payload`, `POST /public/tamper-reports` |
| `/register` | `POST /auth/otp/send`, `/auth/otp/verify`, `/auth/register` |
| `/owner/instruments/new` | `GET /catalog/*`, `POST /instruments`, `POST /uploads/sign`, `/uploads/confirm` |
| `/owner/instruments/:id/apply` | `POST /instruments/:id/applications` |
| `/officer/queue` | `GET /applications`, `POST /applications/:id/document-check` |
| `/officer/schedule` | `GET /schedule/proposals/:caseId`, `POST /schedule/assign`, `GET /schedule/calendar` |
| `/inspector/visits/:id` | `GET /inspections/:id`, `PUT /inspections/:id/draft`, `POST /inspections/:id/arrive`, `/trials`, `/submit` |
| `/officer/decisions` | `POST /decisions`, `POST /certificates/:id/issue` |
| `/admin/rules` | `GET|POST /admin/rules/...` |
| `/admin/audit` | `GET /admin/audit`, `POST /admin/audit/verify-chain` |
