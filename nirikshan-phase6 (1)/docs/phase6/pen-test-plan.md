# Penetration test plan

**Status: planned, not performed by an outside party.** What was done in-house is in `PHASE6.md` (automated security tests). That is not a substitute for an independent test.

## Scope
In: public site and API, owner/trader, officer, inspector, admin, file upload and download, QR validation, sign-in, session and MFA, password reset, background jobs' effects, the production proxy (nginx), TLS settings, storage bucket permissions, secrets handling, CI images and dependencies.
Out: the cloud provider's own platform, SMS/e-mail vendors' systems, denial-of-service at volume (agree a separate load window).

## Rules of engagement
Test environment only (a copy with synthetic data). Written approval from the office head. Test accounts for each role are provided; testers also try as an unauthenticated user and with accounts of other roles. Testing windows are agreed in writing; a named contact is reachable throughout. Anything that reveals real personal data is reported at once and stopped.

## Method
OWASP ASVS Level 2 as the checklist. OWASP Top 10 and API Top 10 as the attack list. Black-box first, then grey-box with source and roles.

## Must-cover list (what the in-house tests already try, to be repeated independently)
1. **Broken object access (IDOR)** on every route that takes an id, for every role pair, including files, certificates, visits, data requests, reports and exports.
2. **Authentication**: lockout, OTP abuse (cooldown, hourly caps), reset-password flow, MFA bypass, TOTP reuse, session fixation, session lifetime, logout everywhere.
3. **Authorisation**: role and permission gates, step-up (recent re-authentication) on sensitive actions, officer area scoping, separation of duties (draft author cannot approve own rules).
4. **CSRF and CORS**: token and origin checks on every state-changing request.
5. **Injection**: SQL, header, CSV/formula injection in exports, stored script in free text, template injection in letters.
6. **Uploads**: content type vs. content, oversize, polyglots, malware (EICAR at least; live ClamAV in production), path tricks, unauthenticated download.
7. **Rate limits and bots**: public validate, search, tamper report, OTP; CAPTCHA bypass.
8. **Transport and headers**: TLS 1.2+, HSTS, secure cookies (`__Host-`), CSP nonce policy (note: `style-src` still allows inline styles), clickjacking.
9. **Business logic**: certificate fraud (re-use of a number, edited QR, expired shown as valid), double-submit (idempotency), race on one-open-request rule, tampering with test readings (server must compute pass/fail).
10. **Privacy**: personal data in logs, errors, URLs, exports, notifications; masking on public pages; audit trail integrity (try to alter a row).
11. **Infrastructure**: open ports, default credentials, bucket policy, Redis and Postgres exposure, secrets in images or environment dumps.

## Deliverables
Findings with severity (Critical/High/Medium/Low), proof, affected route, fix advice. Retest after fixes. Summary the office head can read without technical help.

## Exit
Go-live needs: **no open Critical or High**. Medium has an owner and a date. Report and retest note filed with the pilot sign-off pack.

## In-house scans to keep running
- `pnpm audit` (dependencies) at each release; container image scan (for example Trivy) on both images at each build. Results: `PHASE6.md`.
