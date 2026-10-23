# Phase 5: Lifecycle and admin. What was built, what was proven, what was not

Exit criterion: **every page in the sitemap works.** Every page now exists and builds, and most were opened and used in a real browser. Several deeper flows are covered by API tests only (see "Not proven").

## Built
**Background jobs** (ADR 0006): BullMQ scheduler with a Redis lock per job, a run log, and failure alerts to admins after three tries. Ten jobs: certificate expiry, renewal reminders (60/30/15/7/1 days, editable), application expiry, visit reminders, deadline monitor, daily deadline digest, audit-trail check (alerts admins on a break), public counts, retention clean-up, enforcement progress. Every job takes "now" as input so tests can move the clock. Admins can see each job's last run and run one by hand.
**Requests on an instrument**: change of owner, change of address, de-registration. One open request per instrument; the owner can withdraw. The officer approves or rejects (a reason is required to reject). Approval applies the change in one step: owner and public index for a transfer, area for an address change, and for de-registration the instrument is closed and any valid certificate is withdrawn. Ownership history is kept.
**Repair jobs** (traders): reported, technician assigned, repaired, sent for re-verification. The last step opens a re-verification application for the owner.
**Grievances**: owner or trader raises one, gets a reference and a 7-day reply date; the officer replies and keeps it open or closes it.
**Public**: `/search` (masked owner names, needs a filter, bot check after repeat use) and `/report` (tamper report with optional photo, reference number, status lookup that shows only "received" or "closed"). Both can be switched off by an admin.
**Enforcement**: list of lapsed instruments not already in a drive, drives for one area, notices sent through the notification service, printable letters (PDF), escalate, close. Progress moves on its own when the owner applies or is verified again.
**Rules** (ADR 0007): new draft is a copy of the version in force; edit values, see exactly what changed and what rule combinations would go missing, a different admin must review, publish needs re-authentication, overlaps are caught before publishing. Published versions never change; cases keep the version they were decided under.
**Privacy**: owners ask for a copy of their data, a correction, erasure, or to close the account. Admins carry it out (erasure keeps the records the law needs, and says which), see consent records, retention schedule and last clean-up, and tick through a breach checklist.
**Migration of old records**: CSV template, dry-run check with a problem list, import in one transaction. Each owner gets an invited account and claims it by registering with the same mobile number. Imported instruments get no certificate.
**Reports**: 13 reports (11 for officers, 2 admin only), preview, CSV, Excel and PDF, formula-safe CSV, every export audited. **Dashboards**: officer (queues, work, deadlines, compliance, open applications by stage, 8-week trend) and admin (health, people, registry, other, busiest areas, trend).
**System settings**: notice banner (English and Hindi), four feature switches, reminder and deadline settings. The banner appears on every page.
**Shell**: new navigation entries, "Report tampering" in the footer, certificate Print button and a Renew link.
**Database**: migration 005 (jobs, settings, requests, ownership history, grievance and tamper columns, enforcement columns, rule review columns and immutability, data requests, legacy import columns, row-level rules for every new table).

## Proof
| Check | Result |
|---|---|
| Shared package tests (adds rule comparison and overlap checks) | 45 pass |
| API tests, all 12 suites run together (Phase 5 added suites for jobs, requests, enforcement and complaints, rules, privacy and migration, and reports) | **199 pass** |
| Phase 5 browser run (Playwright, live API and web, synthetic data): public search and tamper report, owner address change and de-registration request, grievance, data request, officer approve/reject/reply/close, status visible to the public, reports with CSV download, admin banner on then off (seen on a public page), job run by hand, rules draft open and discard, data request carried out and downloaded, import check, trader repair board | **56 pass** |
| axe (WCAG 2.2 AA rules) on 24 views including dark mode, Hindi, and 375 px | 0 serious or critical |
| Phase 3 browser run repeated | 50 pass |
| Phase 4 browser run repeated | 69 pass |
| Type checks, API build, web production build | clean |

A bug found by the browser run and fixed: a tamper report with no certificate number had no area, so no officer could see it. Unassigned reports are now visible to every officer and senior officers and admins are notified (test added).
A bug found earlier by the tests and fixed: alerts to a whole role (audit chain break, failed job) never reached anyone because of a wrong column name.

## Not proven. Please read this part.
- **Scheduler timing.** Job handlers are tested with a moved clock, and the scheduler starts and one job was run by hand in the browser. I did not wait for a real 02:30 or 06:30 run, and the lock across two servers was not tried.
- **Browser coverage is partial.** In a browser I ran: address change, de-registration (rejected), grievance, tamper report, data request, banner, job run, report and CSV, rules draft open and discard, import check and discard. **Not run in a browser** (API tests only): ownership transfer, repair job moves, starting a drive and sending notices, escalate, rules review and publish, import commit and claiming an invited account, Excel and PDF reports, erasure.
- **Rules editor can change and remove rows, not add new ones** (copy a version, edit, remove). A removed row is caught by the missing-rule check, but to restore it the draft must be discarded.
- **Reports are made while you wait**, with row limits (preview 200, files 50,000, PDF 1,500). Large exports could be slow. No background report queue.
- **Letters and report PDFs are English only** (standard fonts). Web screens for owners and public are bilingual; officer and admin screens are English only.
- **Print** uses the browser's print with a print stylesheet; I did not check the printed page.
- **Transfers have no consent step** for the new owner. The officer decides alone.
- **Imported old instruments have no certificate**, so renewal reminders start only after their first re-verification here. Lapsed ones appear in the enforcement list.
- **Deadlines are constants in code**: 72 hours for officer decisions (the rule set has a value, but the monitor does not read it yet) and 7 days for grievance replies.
- **Not built**: officer map, backup health check, notification dispatcher job (messages are still sent inline), virus-scan callback job.
- Still true from earlier phases: SMS and email go to the dev outbox, the human-check widget loads only with a site key, camera QR scan not run, PostGIS paths untested, Hindi wording unreviewed, automated accessibility rules only (no screen reader or keyboard-only pass), no load test.

## Deviations from the brief
1. No separate "edit instrument" page: the request panel and the existing inline edit are on the instrument page.
2. Certificate print is a Print button and print stylesheet on the certificate page, not a separate print route.
3. One generic `instrument_requests` table for all three request kinds; the older `ownership_transfers` table is also written on a transfer.
4. Erasure is pseudonymisation that keeps statutory records, not deletion.
5. Enforcement progress is refreshed when read and by a daily job.
6. A second demo admin ("Demo Admin Two") was added so the two-person rule review can be shown.
7. Notice banner is checked every 60 seconds, so a change takes up to a minute to appear.
8. Renew link goes to the existing apply page, which already chooses renewal for a verified instrument.

## Deferred
Officer map, real report queue with e-mailed files, Hindi letters and PDFs, recipient consent on transfers, notification dispatcher, backup check, rule rows added in the editor (Phase 6 hardening list).

## Open questions
1. Must the new owner agree to a transfer?
2. Reply deadline for grievances (7 days assumed) and for data requests (30 days assumed).
3. Which records must be kept after an erasure request, and for how long? The list in the system is my reading, not legal advice.
4. Should lapsed instruments be enforced against from the day after expiry, or after a grace period?
5. Who should receive tamper reports that name no certificate (today: every officer, with senior officers and admins alerted)?
6. Is Excel needed for every report, or are CSV and PDF enough?
7. Real notice wording for enforcement letters, in English and Hindi.
