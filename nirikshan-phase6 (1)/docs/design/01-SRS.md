# Software Requirements Specification — Nirikshan

Version 1.0 (Phase 1) · Status: for review

## 1. Purpose and scope

Nirikshan lets legal metrology stakeholders digitise the full verification life of a weighing or measuring instrument:
registration, application, document check, scheduling, field inspection, decision, certificate, public validation,
renewal, enforcement and de-registration.

**In scope:** one responsive web application (Next.js) with five interfaces (Public, Owner/Trader, Officer, Inspector, Admin),
a NestJS API, PostgreSQL/PostGIS, Keycloak auth, private object storage, notifications (SMS, email, in-app), digitally
signed QR certificates.

**Out of scope (by design):** native apps, offline mode, counter/cashier module, **any payment or fee processing**,
integration with third-party calibration labs, handling of real citizen data in dev/test.

## 2. Stakeholders and users

| Stakeholder | Interest |
|---|---|
| Instrument owner (shopkeeper, petrol pump, weighbridge operator) | Get verified quickly, never miss a renewal, display a valid certificate |
| Trader (manufacturer / dealer / repairer) | Manage many instruments, bulk registration and application, repair-to-verification flow |
| Field inspector | Clear daily route, fast mobile data entry, instant pass/fail from the server |
| Verification officer / supervisor | Control queue, decisions, certificates, enforcement within jurisdiction |
| Senior officer | Handles referred cases |
| Admin | Rules, master data, users, audit, privacy requests |
| Public / consumer | Check that a certificate is genuine; report tampering |

## 3. Assumptions and constraints

- Online only. Drafts autosave to the server; no service-worker data cache.
- Server computes every measurement result, verdict, due date and validity. Browser only displays.
- Rules are versioned and effective-dated; a case is pinned to the rule version in force at application time.
- Audit log is append-only and hash-chained. No hard deletes in business tables.
- Seed and test data is synthetic only.
- Accessibility target WCAG 2.2 AA; languages English and Hindi.
- Privacy aligned with India DPDP Act 2023: minimum data, masking, encryption at rest, consent records, data-principal rights.

## 4. Functional requirements

Priority: **M** must, **S** should. Phase = delivery phase (2 to 5). Phase 6 verifies everything.

### 4.1 Authentication, accounts, consent (AUTH)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-AUTH-01 | Login with mobile or email + password via Keycloak (Authorization Code + PKCE); OTP login option | M | 2 |
| FR-AUTH-02 | BFF pattern: tokens never reach browser JS; opaque `__Host-` session cookie | M | 2 |
| FR-AUTH-03 | Mobile and email OTP (6 digits, CSPRNG, hashed, 5 min expiry, 5 attempts, resend throttle) | M | 2 |
| FR-AUTH-04 | Mandatory TOTP MFA for Officer, Inspector, Admin; recovery codes; forced enrolment on first login | M | 2 |
| FR-AUTH-05 | 5-step self-registration (identity, role, business, address with map, documents) with consent screen | M | 2 |
| FR-AUTH-06 | Account lifecycle PENDING_VERIFICATION > ACTIVE / REJECTED / SUSPENDED / DEACTIVATED; pending users cannot use owner APIs | M | 2 |
| FR-AUTH-07 | Staff accounts by single-use signed invite (24 h), forced password set and MFA enrolment | M | 2 |
| FR-AUTH-08 | Idle timeout 15 min staff / 30 min owner, absolute 8 h, timeout warning dialog 2 min before | M | 2 |
| FR-AUTH-09 | Active sessions list with revoke, logout everywhere | S | 2 |
| FR-AUTH-10 | Step-up re-authentication (within 5 min) for decisions, revoke/suspend, rule publish, key ops, exports | M | 4 |
| FR-AUTH-11 | Officer approves/rejects owner accounts within own area, with reason | M | 2 |
| FR-AUTH-12 | Minimum age 18; no children's data | M | 2 |

### 4.2 Public interface (PUB)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-PUB-01 | Landing page with certificate search, QR scan (camera + photo-upload fallback), quick actions, how-it-works, public stats, latest notices | M | 2 (shell) / 4 (validate) |
| FR-PUB-02 | `/validate` by certificate no., QR, or mobile + serial; states VALID, EXPIRING (<=30 d), EXPIRED, REVOKED, SUSPENDED, NOT_FOUND | M | 4 |
| FR-PUB-03 | Malformed or wrong input always returns NOT_FOUND; never reveal which part was wrong | M | 4 |
| FR-PUB-04 | Result shows masked holder, category, capacity, class, ward/zone, verified on, valid till, days left, issuing office, signature and QR checks | M | 4 |
| FR-PUB-05 | Verified Seal animation for VALID only; disabled under reduced motion | S | 4 |
| FR-PUB-06 | Download public copy of certificate (no full name, no address) | M | 4 |
| FR-PUB-07 | Report tampering (photo, description, optional contact) creates a tamper case for officers | M | 4 |
| FR-PUB-08 | Public directory search with masked results; capped pagination; no export; no wildcard-only queries | M | 4 |
| FR-PUB-09 | Public MPE rules page with filters, print, rule version and effective date | M | 2 |
| FR-PUB-10 | Notices, Help/FAQ, contact form, privacy, terms, accessibility pages | M | 2 |
| FR-PUB-11 | Rate limit per IP/device, CAPTCHA after repeated misses, constant-time responses, hashed-IP lookup log | M | 4 |
| FR-PUB-12 | Validation stays available when the portal is degraded (read model + Redis cache) | S | 4 |

### 4.3 Instrument registry (INS)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-INS-01 | Create instrument via 6-step wizard with server-side draft autosave | M | 2 |
| FR-INS-02 | Category, capacity band and class from master data; drive applicable rules | M | 2 |
| FR-INS-03 | Location with browser geolocation or map picker; auto-map to Circle/Zone/Division; flag out-of-area | M | 2 |
| FR-INS-04 | Duplicate `(serial, make, category)` triggers warning; officer override to proceed | M | 2 |
| FR-INS-05 | Attachments: invoice, photo, existing sticker; virus-scan status shown | M | 2 |
| FR-INS-06 | Declaration with OTP confirm | M | 2 |
| FR-INS-07 | Edit allowed fields; category and capacity locked after first verification | M | 2 |
| FR-INS-08 | Instruments list: filters, saved views, search, CSV export of own data | M | 2 |
| FR-INS-09 | Trader bulk registration (template, CSV/XLSX upload, row-level validation report, error file, partial accept) | M | 2 |
| FR-INS-10 | Instrument history timeline (verifications, certificates, transfers), downloadable | M | 2 |
| FR-INS-11 | Ownership transfer (new owner, sale document, officer approval) | S | 5 |
| FR-INS-12 | Change of address: same-jurisdiction auto-approves, cross-jurisdiction needs officer | S | 5 |
| FR-INS-13 | De-registration (reason + document, officer approval) | M | 5 |

### 4.4 Master data and rules (MD)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-MD-01 | Admin CRUD for Category, SubCategory, AccuracyClass, CapacityBand, DocumentType, ReasonCode, HolidayCalendar | M | 2 |
| FR-MD-02 | Area hierarchy (Division > Zone > Circle > Ward) with polygon editor on a map | M | 2 |
| FR-MD-03 | ChecklistTemplate builder per category | M | 4 |
| FR-MD-04 | NotificationTemplate editor (EN/HI) | M | 3 |
| FR-MD-05 | MPE rules, interval rules, workflow SLAs: versioned, effective-dated, draft > review (second admin) > publish | M | 4 (seed) / 5 (admin UI) |
| FR-MD-06 | Overlapping effective ranges for the same key cannot be published (DB constraint + app check) | M | 5 |
| FR-MD-07 | Diff view between rule versions; published versions immutable | S | 5 |
| FR-MD-08 | Seed minimal synthetic rules in Phase 2 so the system is usable before the admin UI exists | M | 2 |

### 4.5 Application and document check (APP)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-APP-01 | Apply for verification (New, Re-verification, Renewal, Re-test) with pre-check panel | M | 3 |
| FR-APP-02 | Pre-check: registered, documents valid, no open application, slots available, rule exists | M | 3 |
| FR-APP-03 | Server returns due date and apply-by date; no fee shown | M | 3 |
| FR-APP-04 | Trader batch apply for same area + category; one case per instrument | M | 3 |
| FR-APP-05 | One open application per instrument enforced by partial unique index | M | 3 |
| FR-APP-06 | Document upload per required type, replace/version, virus-scan state, officer comment per document | M | 3 |
| FR-APP-07 | Officer document check drawer: accept/flag each document, mark "Document check complete" | M | 3 |
| FR-APP-08 | Owner tracking: stepper, timeline with actor/time/remark, live updates (SSE or polling) | M | 3 |
| FR-APP-09 | Owner actions with status guards: reschedule request (before INSPECTION_IN_PROGRESS), cancel (only while APPLIED), grievance | M | 3 |
| FR-APP-10 | Case status change and audit event written in one DB transaction; illegal transitions return 409 | M | 3 |
| FR-APP-11 | Application expiry sweeper (no action in window) | S | 5 |

### 4.6 Scheduling (SCH)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-SCH-01 | Trigger on DOCUMENT_CHECKED; filter inspectors by active, jurisdiction polygon, capacity, holidays/leave, skill | M | 3 |
| FR-SCH-02 | Score by workload 35, distance 25, specialisation 15, success rate 10, no-repeat 15 (weights configurable); store score breakdown | M | 3 |
| FR-SCH-03 | Modes AUTO and REVIEW; propose date within SLA window | M | 3 |
| FR-SCH-04 | Officer calendar day/week/area; drag to reschedule with reason; audit entry | M | 3 |
| FR-SCH-05 | Bulk reschedule by area (bandh, weather, festival) with affected-owner preview | S | 3 |
| FR-SCH-06 | Mark inspector unavailable; visits return to queue | M | 3 |
| FR-SCH-07 | Owner no-show produces FAILED_ATTEMPT and releases slot | M | 3 |
| FR-SCH-08 | Printable route sheet | S | 3 |
| FR-SCH-09 | Out-of-jurisdiction assignment is explicit and audited | S | 3 |

### 4.7 Inspection (INSP)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-INSP-01 | Five-step mobile flow: Arrive, Checklist, Test, Evidence and decision, Review and submit | M | 4 |
| FR-INSP-02 | Arrive: one-tap geolocation + timestamp + optional photo; geofence check; outside radius needs justification | M | 4 |
| FR-INSP-03 | Checklist driven by category template | M | 4 |
| FR-INSP-04 | Test: trials entered; **server** returns error, MPE, % error, PASS/FAIL per row; out-of-limit auto-recommends REJECT with reason codes | M | 4 |
| FR-INSP-05 | Evidence photos geo-tagged; optional audio note; sticker serial | M | 4 |
| FR-INSP-06 | Autosave draft to server after each field; private to inspector; expires after 7 days; restore on reopen | M | 4 |
| FR-INSP-07 | Connection lost shows blocking banner; no offline queue | M | 4 |
| FR-INSP-08 | Idempotent submit; after submit read-only; signed test sheet PDF generated | M | 4 |
| FR-INSP-09 | Owner name masked to inspector until Arrive is captured | M | 4 |
| FR-INSP-10 | Inspector dashboard: route by SLA risk then distance, progress ring, unsubmitted drafts, rule-version banner | M | 4 |

### 4.8 Decision and certificate (CERT)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-CERT-01 | Decision panel: APPROVE, REJECT (reason code + remarks), REFER; step-up auth to confirm | M | 4 |
| FR-CERT-02 | Approve blocked, with explicit reasons, if documents incomplete, inspection data missing, MPE failed or evidence absent | M | 4 |
| FR-CERT-03 | Validity auto from interval rule; shorter for marginal pass; editable only within rule limits | M | 4 |
| FR-CERT-04 | Dual approval above configured threshold | S | 5 |
| FR-CERT-05 | Certificate number `NRK/CERT/{DIV}/{YYYY}/{seq}`, DB sequence per division+year, never reused | M | 4 |
| FR-CERT-06 | PDF from versioned EN/HI template, signed with department key; SHA-256 fingerprint stored | M | 4 |
| FR-CERT-07 | QR payload `/v/{certNo}.{sig}` with HMAC from KMS key; constant-time compare; `key_id` stored per certificate | M | 4 |
| FR-CERT-08 | `public_certificate_index` updated in the same transaction as issue/status change | M | 4 |
| FR-CERT-09 | Revoke and suspend with reason, step-up auth, public-safe reason text | M | 4 |
| FR-CERT-10 | Re-issue with new number linked `REPLACES` old | S | 5 |
| FR-CERT-11 | Owner certificate view: QR, MPE applied, signature status, download, copy link, share, printable A4/A5 copy | M | 4 |
| FR-CERT-12 | Send for re-inspection creates new visit and keeps the original sheet | M | 4 |

### 4.9 Lifecycle, enforcement, reporting (LIFE)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-LIFE-01 | Renewal reminders at 60/30/15/7/1 days; create DUE_FOR_RENEWAL | M | 5 |
| FR-LIFE-02 | Expiry sweeper marks certificates and instruments EXPIRED | M | 5 |
| FR-LIFE-03 | Enforcement: expired list, verification drives, bulk notice letters (PDF + SMS/email), drive tracking | M | 5 |
| FR-LIFE-04 | Trader service jobs: Reported > Technician assigned > Repaired > Ready; repair invoice auto-creates application | S | 5 |
| FR-LIFE-05 | Grievance register with SLA tracking | M | 5 |
| FR-LIFE-06 | Officer dashboard: queues, SLA breaches, workload, failure rates, cycle-time trend, map | M | 5 |
| FR-LIFE-07 | Admin dashboard: applications/day, median cycle time, rejection rate, renewal compliance, adoption, failed jobs | M | 5 |
| FR-LIFE-08 | Report library (CSV/XLSX/PDF, role-scoped, async for large) | M | 5 |
| FR-LIFE-09 | Data migration tool for legacy registry (validation report, dry run, rollback) | M | 5 |

### 4.10 Notifications (NOT)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-NOT-01 | Provider-abstracted SMS, email, in-app; dev provider = console/Mailpit | M | 2 (OTP) / 3 (events) |
| FR-NOT-02 | Event matrix per `03-process-flows.md` section 10 | M | 3 to 5 |
| FR-NOT-03 | Templates in EN/HI; per-user channel preferences (security notices cannot be disabled) | M | 3 |
| FR-NOT-04 | No sensitive data in SMS/email bodies (application no. + secure link only) | M | 3 |
| FR-NOT-05 | `message_log` with hashed/masked recipient; dedupe and quiet hours for non-critical SMS | M | 3 |
| FR-NOT-06 | In-app bell, drawer, unread count, mark all read, deep links | M | 3 |

### 4.11 Privacy and audit (PRIV)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-PRIV-01 | Consent records versioned; withdrawal supported | M | 2 |
| FR-PRIV-02 | Owner "My data": download, request correction, request erasure/deactivation with legal-retention explanation | M | 5 |
| FR-PRIV-03 | Admin privacy console: data-subject requests with SLA, retention job status, breach checklist | M | 5 |
| FR-PRIV-04 | Audit events for logins, MFA, transitions, decisions, staff document views, exports, rule publish, role change, break-glass, DSRs | M | 2 onward |
| FR-PRIV-05 | Audit verify-chain button + nightly verifier | M | 5 |
| FR-PRIV-06 | Admin PII access is break-glass: step-up + mandatory reason + audit | M | 5 |

### 4.12 Cross-cutting UI (UI)

| ID | Requirement | Pri | Phase |
|---|---|---|---|
| FR-UI-01 | Design system tokens (light/dark/system), Instrument Sans + Noto Sans Devanagari, 4px grid | M | 2 |
| FR-UI-02 | Component library in `packages/ui` with Storybook | M | 2 onward |
| FR-UI-03 | Every list has skeleton, empty, error, no-permission states; filters in URL | M | 2 onward |
| FR-UI-04 | Command palette (Ctrl/Cmd+K), notification centre, session-timeout dialog, maintenance banner | S | 3 |
| FR-UI-05 | Motion spec honoured; `prefers-reduced-motion` respected | M | 2 onward |
| FR-UI-06 | Print styles for certificates, route sheets, notices | M | 4 |

## 5. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-PERF-01 | Public LCP on mid-range phone, 4G | < 2.5 s |
| NFR-PERF-02 | Public JS per route | < 170 KB gz |
| NFR-PERF-03 | API p95 read / write | < 300 ms / < 600 ms |
| NFR-PERF-04 | Dashboards at expected volume | < 2 s |
| NFR-A11Y-01 | WCAG 2.2 AA, axe serious/critical violations | 0 |
| NFR-A11Y-02 | Lighthouse (public pages) | >= 90 all four |
| NFR-SEC-01 | OWASP ASVS L2, OWASP Top 10 mitigations | pass pen-test plan |
| NFR-SEC-02 | TLS 1.2+ (prefer 1.3), HSTS, strict nonce CSP, secure cookies | required |
| NFR-SEC-03 | Field-level AES-256-GCM encryption for mobile, email, address, DOB, ID refs, premises geo | required |
| NFR-SEC-04 | Uploads: MIME allow-list + magic bytes, size cap, ClamAV, random keys, EXIF GPS stripped on public copies | required |
| NFR-SEC-05 | IDOR automated tests for every endpoint; 404 (not 403) outside scope | required |
| NFR-REL-01 | Idempotent POSTs, optimistic locking, transactional state changes | required |
| NFR-REL-02 | Daily encrypted backups + PITR, quarterly restore drill, documented RPO/RTO | required |
| NFR-OBS-01 | Structured logs with PII redaction, request-id, OpenTelemetry, PII-scrubbed error tracking | required |
| NFR-I18N-01 | EN/HI for UI, notifications and PDFs; i18n-ready for more | required |
| NFR-TEST-01 | Unit coverage ~100% for rules engine, state machine, scoring, crypto helpers; integration, E2E per role, security and visual tests | required |

## 6. Phase acceptance criteria

| Phase | Done when |
|---|---|
| 1 | All documents in this package reviewed and signed off; open questions answered |
| 2 | A new owner registers, is approved by an officer, logs in (staff with MFA), and registers an instrument; public shell, rules page and master data work; draft autosave works |
| 3 | Owner applies; officer completes document check; an inspector is auto-assigned; owner sees stepper and timeline update live; officer calendar works |
| 4 | Full golden path: register > apply > schedule > inspect > approve > certificate PDF with QR > public validation shows VALID; tamper report and revoke work |
| 5 | Renewals, expiry, enforcement, de-registration, rules admin, dashboards, reports and migration work; Admin portal complete |
| 6 | UAT signed off; no open critical/high security findings; performance targets met; training material delivered |

## 7. Traceability summary

Every FR maps to a page in `05-sitemap.md` (route) and an API group in section 3 of that file, a table in `04-database-design.md`,
and a phase in `06-roadmap.md`. Phase 2 starts by turning FR-AUTH, FR-INS, FR-MD and FR-UI into tickets.
