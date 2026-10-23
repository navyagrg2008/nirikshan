# Phase 3: Application and Scheduling. What was built, what was proven, what was not

Exit criterion: **owner applies, officer checks documents, inspector is assigned, everyone is notified.** Proven end to end in a real browser (see Proof).

## Built
**Application (owner and trader)**: pre-check (`GET /instruments/:id/precheck`) with blockers, warnings, server-calculated due and apply-by dates, required documents and earliest free day; apply (one open case per instrument, rule version pinned at that moment, number `NRK-APP-########`, idempotent); trader batch apply (same area and category); document upload (real file type by content, size per type, malware scan, versions, locked after the officer finishes); tracking page (stepper, history, documents with the officer's comment, visit window, refreshes every 20 s using `ETag`/304); cancel (only before document check is done); reschedule request.
**Officer**: case queue with deadline state (on time, close, past) and summary counts; case page (document view through an audited short-lived link, accept or flag with a comment, "document check complete"); automatic scheduling after the check; score breakdown; accept the engine's proposal, or choose inspector and time (out-of-jurisdiction needs a recorded reason; an inspector without the category skill can never be chosen); move a visit; mark a visit not completed (3 tries, then it waits for an officer); decide owner reschedule requests; week calendar with holidays and leave; bulk reschedule for a lost day (preview first, step-up to confirm); inspector list with load; leave, unavailability and daily-limit entry (existing visits are re-booked automatically); printable route sheet (audited).
**Inspector**: list of own visits (database policy shows only assigned, open visits).
**Notifications**: 14 events, English and Hindi templates; messages carry only the application number and a link.
**Database**: migration 003 (cases, documents versions, reschedule requests, proposals, inspector profiles, scheduling settings, double-booking constraint, row-level policies). Policies that look across tables use `SECURITY DEFINER` helpers, because `applications` and `inspection_visits` otherwise reference each other and PostgreSQL refuses to plan queries.
See `docs/adr/0004-scheduling-engine.md`.

## Proof
| Check | Result |
|---|---|
| Shared package tests (adds due dates, scoring, SLA, document completeness, slots) | 28 pass |
| API tests: 57 from Phase 2 plus 27 new (apply, documents, scan, versions, auto and review scheduling, capacity, holidays, leave, double booking race, jurisdiction, no-show, reschedule, bulk, RLS, audit chain) | 84 pass |
| Browser run (Playwright, live API and web): apply, upload, officer flag, owner page updates by itself, replace, officer check, automatic assignment, score breakdown, notifications, inspector sees visit, reschedule request and approval, calendar, leave, route sheet, bulk preview, Hindi, dark, 375 px | 50 checks pass |
| axe (WCAG 2.2 AA rules) on 25 views and dialogs | 0 serious or critical |
| Migration 003 applied on a Phase 2 database (upgrade path) and on a fresh one | works |
| Type checks, web production build | clean |

## Not proven. Please read this part.
- **PostGIS paths still untested** (point fallback only). Distance score uses area proximity unless both coordinates exist.
- **Concurrency** is tested with two parallel requests for one slot, not under load.
- **Definer helper functions** assume the migration owner is not subject to RLS (true for a normal owner without FORCE ROW LEVEL SECURITY). Check this in your real database.
- **SMS and email** are still dev outbox only. Notification content and the Hindi wording have not been reviewed by a person.
- **Accessibility**: automated rules only, no screen-reader or keyboard-only pass. The calendar is a list per day, not a drag-and-drop grid.
- Phase 2 browser smoke was not re-run after small shared-component changes (danger button colour, unread alert style). Phase 3 smoke covers those components in dark mode.
- No load test of the scheduling engine with many inspectors.

## Deviations from the brief
1. "Slots available" in the pre-check is a **warning**, not a blocker: the case is then queued for an officer.
2. "Documents valid" is checked by the officer at document check, not at pre-check.
3. Rescheduling uses dialogs and a week list, not drag and drop.
4. Live updates use polling (20 s, ETag), not server-sent events.
5. Deadlines are measured in clock hours, not working hours.
6. Inspector no-show is recorded by an officer until the Phase 4 inspector workspace exists.
7. Route sheet is a browser-printable page, not a generated PDF.
8. Area choice for bulk reschedule lists all areas; the server refuses areas outside the officer's scope.
9. Admin can read a case but the case list is for officers only.

## Deferred
Grievance, application expiry sweeper (state exists, job does not), inspection checklist and test sheet, decision and certificate (Phase 4), scheduling settings screen (settings live in `scheduling_settings`; defaults seeded), admin case list.

## Open questions for you
1. Is a 3-visit attempt limit right? (setting `max_failed_attempts`)
2. Working days Monday to Saturday, visits 10:00 to 18:00 in 2-hour slots, 4 per inspector per day: confirm or give real values.
3. Auto-assign threshold 50 and weights 35/25/15/10/15: confirm or tune after you see real cases.
4. SLA hours (document check 48, scheduling 72, decision 72) are placeholders.
5. Should owners see the inspector's name before the visit?
