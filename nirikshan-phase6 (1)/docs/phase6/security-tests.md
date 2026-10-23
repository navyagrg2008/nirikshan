# Security testing: what exists and what it found

Automated, runs with `npx jest --runInBand` in `apps/api` (Postgres and Redis are started for the tests).

| Suite | Tests | What it does |
|---|---|---|
| `phase6.security` | 11 | Builds the list of **every route** from the running app. Every non-public route must declare a role or permission gate (a short reviewed list may be open to any signed-in user). Anonymous calls get 401 everywhere. For each of the 6 roles, routes they may not use must return 403 and routes they may use must never return a 5xx. Error bodies never show stack traces, SQL or file paths |
| `phase6.abuse` | 26 | **IDOR matrix** built automatically from the routes an owner may call with an id; a different owner and a trader must get 404 / 422 / 400 / 428 or an empty list, never someone else's data (real ids created through the API). Signed file links cannot be altered. Forged cookies, session fixation, replay after logout, half-finished staff sign-in, wrong origin and missing CSRF token, account lockout while rotating IPs, privilege fields in a request body. SQL-looking text in every GET query string, odd JSON bodies, stored script text. Uploads: not an image, a test virus (EICAR) behind an image header, oversize, extra files, bad CSV. Rate limits on public validate, tamper reports and OTP. Security headers, no cross-origin grant, `no-store` on signed-in responses, no secret or encrypted field names in any response, masked public data, and request logs containing no password, query string, OTP or session id |
| `phase6.config` | 11 | Production start-up refuses: no `ROOT_KEYS`, dev key, insecure cookies, local file storage, built-in virus scanner, missing CAPTCHA, non-https origins |

Whole API suite: **247 tests, all pass** (2026-10-22). Shared package: 45 pass.

## Found and fixed during Phase 6
| Finding | Severity | Fix |
|---|---|---|
| API responses had no `Cache-Control`, so a shared browser or proxy could keep signed-in data | Medium | `no-store` by default; public catalogue routes override it |
| Production start-up accepted `CAPTCHA_PROVIDER=none`, and http origins | Medium | Refused in production, with tests |
| Web page security policy (CSP) was static and allowed inline scripts | Medium | Per-request nonce with `strict-dynamic`, no `unsafe-inline` for scripts |
| Dashboard 8-week trend showed all zeros between about midnight and 05:30 India time (week labels shifted by a day) | Low (wrong numbers, no data exposure) | Weeks now computed in India time on both sides. Found because the suite was run at 1 a.m. |
| Officer case list showed only the 2,000 **oldest** cases; newer cases were invisible at scale | Medium (work could be missed) | Paging and totals now done in the database |
| Dashboard summary re-ran a 2,000-row query up to 50 times | Performance | One grouped query |
| Row-level security helpers were evaluated once per row | Performance | Evaluated once per query (migration 006) |
| 21 known-vulnerable dependency versions (6 high: nodemailer, postcss) | High (as listed by the advisory database) | Upgraded; `pnpm audit` now reports none, including dev dependencies |
| Wide tables could not be scrolled with a keyboard (axe) | Accessibility | Scroll boxes are now focusable regions |
| Hidden screen-reader labels inside tables made phone pages scroll sideways | Accessibility | Boxes are positioned so the labels stay inside |

## Open (not fixed)
- **No real SMS sender.** In production an SMS OTP returns 503. Owners register and sign in by mobile OTP, so **this blocks the pilot** until a provider and the sender templates are chosen.
- **`TRUST_PROXY` must be 1 behind nginx**, otherwise every user shares nginx's address and the per-address limits punish everyone. Set it and verify with two different clients.
- **Default limit of 600 requests per minute per address** is per IP, not per user. Offices behind one shared address can reach it. `RATE_LIMIT_DEFAULT_PER_MIN` now exists to tune it.
- **`style-src` still allows inline styles** (UI library and Next need them). Scripts are strict; styles are not.
- **Virus scanning** was tested with the built-in scanner only. The ClamAV path (required in production) was not run, because the build environment has no Docker.
- **Container images, nginx config and TLS settings were never built or run here.** No image scan was possible.
- **No independent penetration test.** `pen-test-plan.md` says what to ask for.
- **No re-encryption tool** after key rotation; old keys must be kept (runbook 3).
