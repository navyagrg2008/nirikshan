# Browser testing and accessibility: coverage and results

Tools: Playwright (Chromium) against the running API and web build, axe-core (WCAG 2.0/2.1/2.2 A and AA rules), Lighthouse 12. Synthetic data only. Scripts are in `apps/web/e2e/`.

## 1. Every role, every page (`sweep-roles.mjs`)
Each role signs in for real (staff with a 6-digit code) and opens **every page it may use**, including pages that need an id (instrument, application, certificate, case, visit, inspector route sheet). A page fails on any of: console error, security-policy (CSP) violation, uncaught script error, 5xx response, axe serious/critical violation, bounce back to the login page, or sideways scrolling at 375 px.

| Group | Pages | Modes |
|---|---|---|
| Public (15 routes) | home, validate, a QR route, search, report, rules, notices, help, privacy, terms, accessibility, login, register, forgot password, invite | light, dark, Hindi light, Hindi dark, 375 px |
| Owner | 16 | light, dark (first 6), Hindi (first 8), 375 px |
| Officer | 13 | light, dark, 375 px (English only by design) |
| Senior officer | 10 | same |
| Inspector | 4 | same |
| Admin | 10 | same |

**Result (2026-10-22, fresh database, default settings, final code): 222 of 222 checks pass.** Public 75, owner 47, officer 33, senior officer 27, inspector 13, admin 27 (each count includes the sign-in check).
Real problems the sweep found along the way, all fixed: wide tables not reachable by keyboard (axe `scrollable-region-focusable`, 14 tables), hidden screen-reader labels inside tables making three admin pages scroll sideways on a phone, and the import screen showing Import and Discard twice for the file just checked. The public pages also showed no console or CSP errors under the new nonce policy.

## 2. Flow runs (earlier phases, repeated this phase)
| Run | Checks | Result |
|---|---|---|
| Phase 3: apply, upload, officer document check, automatic assignment, notifications | 50 | pass |
| Phase 4: inspector stepper at phone size, officer decision, certificate, public QR check, suspend/reinstate | 69 | pass |
| Phase 5: public search and tamper report, owner requests and grievance and my data, officer queues and reports and enforcement, admin system/rules/privacy/migration | 56 | pass |
These were re-run after the security policy change and the performance changes to confirm nothing broke.

## 3. Lighthouse (public pages, mobile preset: slow 4G, 4x slower CPU)
Chromium in a shared two-core sandbox; scores move a few points between runs.

| Page | Perf | A11y | Best practice | SEO | LCP | CLS | JS (transferred) |
|---|---|---|---|---|---|---|---|
| `/` | 99 | 100 | 96 | 100 | 1.7 s | 0.001 | 127 KB |
| `/validate` | 97 | 100 | 96 | 100 | 2.3 s | 0.002 | 132 KB |
| `/search` | 99 | 100 | 96 | 100 | 1.8 s | 0.008 | 134 KB |
| `/report` | 93 | 100 | 96 | 100 | **2.7 s** | 0.001 | 134 KB |
| `/rules` | 96 | 100 | 96 | 100 | 2.2 s | 0.008 | 127 KB |
| `/notices` | 96 | 100 | 96 | 100 | 1.3 s | **0.11** | 127 KB |
| `/help` | 97 | 100 | 96 | 100 | 2.3 s | 0.001 | 127 KB |
| `/login` | 98 | 100 | 96 | 100 | 1.0 s | 0.002 | 130 KB |
| `/register` | 98 | 100 | 96 | 100 | 1.9 s | 0.004 | 131 KB |
| `/privacy` | 99 | 100 | 96 | 100 | 0.8 s | 0.001 | 126 KB |

Targets: all four categories 90 or more (**met on every page**), JS under 170 KB per route (**met**), LCP under 2.5 s (**missed on `/report`: 2.7 s in this run; it was 2.6 s and 2.7 s in earlier runs**), layout shift under 0.1 (`/notices` was 0.03 to 0.11 across runs).
What changed this phase: `/`, `/rules`, `/notices` now get their data in the first HTML from the server instead of after the page loads. That fixed `/rules` (layout shift 0.14 to 0.008, LCP 2.9 s to 2.2 s).
Desktop preset was not run. Signed-in screens were not measured with Lighthouse (the target in the SRS names public pages).

## 4. Not covered
- Safari, Firefox and real phones. Only Chromium was used, with a phone-sized window, not a phone.
- Screen readers (NVDA, TalkBack, VoiceOver). axe finds about a third of accessibility problems; the UAT run must include a person using a screen reader.
- Hindi text quality (axe cannot judge it) and printed pages (certificate print stylesheet).
- Colour contrast in dark mode on screens not listed above.
