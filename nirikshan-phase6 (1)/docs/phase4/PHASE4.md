# Phase 4: Inspection and Certificate. What was built, what was proven, what was not

Exit criterion: **inspector completes the visit on a phone, officer decides, a certificate with a QR code is issued, and anyone can check it.** Proven end to end in a real browser (see Proof).

## Built
**Inspector workspace** (phone first): today's visits with a draft marker; a five-step visit: arrive (browser location, geofence against the premises point when one exists, written reason if outside), checklist (template per category and version, remark required for any answer that is not the passing one, critical items cannot be marked not applicable), test readings (reference and instrument reading; the **server** works out the error, percent error and the PASS, MARGINAL PASS or FAIL result and the screen only shows it), photos (camera or file, tagged with location, malware-scanned, required kinds from settings), recommendation and review. The draft saves by itself, encrypted, private to the inspector, and comes back after a reload. Submit is idempotent and the server recomputes everything; a test sheet PDF is stored with the case. Past visits open read-only.
**Calculation**: decimal-safe (integers scaled by one million, no floating point). Permitted error is stored per category, capacity band and accuracy class in the rule set in force on the day (pinned per case). Directions plus-minus, plus only and minus only. Marginal band is a rule-set percentage of the limit.
**Officer**: decisions list with deadline state and second-approver state; case page "Inspection" panel with readings, checklist, photos (each view audited), arrival data, rule version, and a list of **every reason approval is blocked** (documents incomplete, no inspection, too few readings, reading out of limit, required photo missing, photo failed scan, critical item failed, inspector recommended against, no sticker serial). Approve, reject (reason code and explanation the owner sees), refer to senior officer, send back for another inspection, second approval. All of them ask for password re-entry if the last sign-in check is older than 5 minutes.
**Dual approval**: configurable per category (default weighbridge). The first approval is recorded as pending; a different officer confirms (certificate issues) or declines (first approval is voided).
**Certificate**: number `NRK/CERT/{division}/{year}/{6-digit sequence}` from a locked counter; validity chosen by the officer but never longer than the rule (marginal pass is capped at the marginal interval); PDF with QR; public read model. Suspend, revoke (instrument goes back to REGISTERED), reinstate and re-issue (new number, old one marked replaced, same validity dates). Each needs a reason, a staff-only note, re-authentication and is audited and notified.
**Owner**: certificates list with tabs, detail with QR code and PDF download (short-lived audited link), history, status banners on the application page.
**Public**: `/validate` (number, optional camera QR scan where the browser supports it) and `/v/{token}` QR landing page. Uniform not-found, constant-time padding, rate limit 30 per minute, human check after repeated misses, nothing but masked holder, category, capacity, dates, status and a public-safe reason is shown. English and Hindi.
**Admin**: signing key status and the full certificate register.
**Database**: migration 004 (inspection settings, visit/measurement/evidence columns, decisions, certificates, status history, public index, lookup log; sticker uniqueness; one valid certificate per application; submitted data cannot be updated or deleted; row-level policies for inspector, officer area and owner). See `docs/adr/0005-certificate-fingerprint-and-qr.md`.

## Proof
| Check | Result |
|---|---|
| Shared package tests (adds calculation incl. boundaries, direction rules, unit conversion, checklist, recommendation guard, validity range, cert number and QR token parsing) | 42 pass |
| API tests: 84 from earlier phases plus 41 new (calculation and pinned rules, arrive and geofence, window, drafts, evidence, submit validation, approve blockers, reject, refer, dual approval, self-approval refused, reinspect, concurrent decisions, certificate lifecycle, public validation, uniform responses, CAPTCHA gate, RLS isolation, QR signature and key rotation) | 125 pass |
| Browser run on a 375 px phone viewport and desktop (Playwright, live API and web): arrive, checklist, draft restore after reload, readings with a failing then passing result, photos, submit, officer decision (rule-limit refusal, approval), certificate, owner QR and PDF, public QR check (valid, damaged signature, unknown number, home box), Hindi, suspend and reinstate seen on the public page, admin key page | 69 checks pass |
| axe (WCAG 2.2 AA rules) on 23 views and dialogs, including dark mode and Hindi | 0 serious or critical |
| Phase 3 browser run repeated after the changes | 50 pass |
| Type checks, web production build | clean |

## Not proven. Please read this part.
- **Certificate PDF is English only.** Standard Times fonts, no Devanagari. The web pages are bilingual. The PDF carries the holder's full name, so it is reachable only by owner, officer and admin through short audited links.
- **No digital (PAdES) signature.** The QR carries a keyed code (see ADR 0005). Root keys come from server settings as a stand-in for a key service.
- **Permitted error is a flat value** per category, band and class (synthetic placeholders), not load-dependent. The department must supply real tables.
- **PostGIS paths untested** (numeric latitude and longitude used). The geofence depends on the instrument's encrypted premises point; most demo instruments have none, so the "outside geofence" screen was proven in API tests only, not in the browser.
- **Evidence is photos only.** No audio note, no photo deletion before submit. The photo's location comes from the browser, which can be faked; it is recorded, not trusted.
- **Re-authentication expiry** (the 5 minute rule) is enforced by the server, but my tests only show the dialog path when it appeared; the expiry itself is not tested at API level.
- **Dual approval and re-issue** are covered by API tests, not by the browser run.
- **QR camera scan** was not run (headless browser has no camera or barcode detector); only the "not available" fallback was seen. The human check widget (Turnstile) loads only if a site key is set and was never run against the real service.
- **Draft expiry job** exists as a method but has no schedule yet. Two devices editing one draft: last write wins.
- **SMS and email** are still dev outbox. Hindi wording unreviewed. Officer and admin screens are English only (as in earlier phases).
- **Accessibility**: automated rules only; no screen-reader or keyboard-only pass.
- No load test. Certificate numbers are gap-free per division and year only while transactions commit.

## Deviations from the brief
1. **Fingerprint** is over canonical certificate content, not the PDF (circularity, see ADR 0005). The PDF hash is stored separately.
2. Certificate prefix is `NRK/CERT/...` instead of `OVS/CERT/...` (project name).
3. QR link uses the number with `-` instead of `/` so it fits a URL path.
4. Hindi certificate PDF deferred. Source Serif 4 not embedded (standard fonts).
5. Trial values are entered in the instrument's capacity unit and converted to the rule's unit on the server.
6. "Request clarification" officer action not built (refer and send-back cover it).
7. Revoke returns the instrument to REGISTERED; re-issue keeps the old validity dates.
8. Dual approval is per category via settings, default weighbridge only.
9. Owner screens for rejected cases show the officer's explanation in the history, not a separate page.

## Deferred
Public search by mobile and serial, tamper reports, enforcement, reports and exports, renewal and expiry sweepers and reminders (Phase 5); admin settings screen for inspection settings; scheduled draft purge; offline mode (out of scope).

## Open questions
1. Real permitted-error tables and marginal-band percentage per category.
2. Which categories need two approvers, and the approval deadline in hours.
3. Is an offline-verifiable certificate (public-key signature, PAdES) required? It changes ADR 0005.
4. Hindi certificate wording and font; official certificate layout.
5. May the certificate show the holder's full name (it does today) or should it follow the masked form used publicly?
6. Which human-check provider (Turnstile or hCaptcha) will be used.
