# Pilot sign-off checklist

Exit criterion for Phase 6. Nothing here is ticked by the developers; **each line needs a named person, a date and evidence**. "Status" below is what the build team can say today.

Legend: ✅ done and shown · 🟡 partly done · ❌ not done · ⛔ blocks the pilot

## A. Must be true before any real user
| # | Item | Owner | Status today | Evidence to attach |
|---|---|---|---|---|
| A1 | **SMS provider chosen and connected, sender and message templates approved** (owners sign in and register by mobile OTP) | Office head + IT | ⛔ ❌ SMS returns 503 in production | A real OTP received on a phone; delivery report |
| A2 | Production hosting, TLS certificate (1.2+), HSTS, nginx in front, `TRUST_PROXY=1` | IT | ❌ images and nginx config never run | Browser padlock; `curl -I` showing headers; two clients get separate rate limits |
| A3 | Production secrets in a secrets manager: `ROOT_KEYS` (two people hold an offline copy), database, storage, CAPTCHA, SMTP/SMS | IT | ❌ | Screenshot of secret names (not values); sealed key envelope log |
| A4 | CAPTCHA provider chosen (Turnstile or hCaptcha), site key built into the web image | IT | ❌ | Public validate shows the challenge after repeated use |
| A5 | Object storage with versioning; ClamAV running; an EICAR test file is refused | IT | ❌ built-in scanner only tested | Upload test result |
| A6 | Daily encrypted backup running; one restore drill on a copy of the **real** server data; written RPO/RTO accepted by the office head | IT | 🟡 drill proven on dev (see `restore-drill.md`); PITR not set up | Drill log with times |
| A7 | Independent penetration test done; no open Critical or High | Office head | ❌ plan written (`pen-test-plan.md`) | Report and retest note |
| A8 | Real rule tables (permissible errors, intervals, fees do **not** exist) loaded, reviewed and published by two admins | Legal metrology head | ❌ demonstration values only | Published rule version and the signed-off source circular |
| A9 | Hindi text reviewed by a native reader from the office (screens, notifications, letters) | Office head | ❌ draft only | Marked-up review |
| A10 | Retention periods decided (accounts, drafts, logs, documents, audit) and entered in Admin > Privacy | Data protection contact | ❌ defaults only | Signed decision |
| A11 | Privacy notice, terms and the consent wording approved by legal | Legal | ❌ draft text | Approval |
| A12 | At least two admins exist and have both done the "lost admin access" drill | IT | ❌ | Drill record |

## B. Training and UAT
| # | Item | Status | Evidence |
|---|---|---|---|
| B1 | Training sessions held per `training/training-plan.md`; each trainee passes their role's first 8 UAT steps unaided | ❌ | Attendance and result sheet |
| B2 | UAT scripts run by real users: public, owner, trader, officer, senior officer, inspector, admin (`phase6/UAT-scripts.md`). No blocker failures; every must-fix has an owner and date | ❌ | Filled sheets with signatures |
| B3 | UAT includes at least one person using a screen reader, and one inspector on a real phone in the field | ❌ | Notes |
| B4 | User manuals handed out (EN and HI); help desk knows runbook 4 | ❌ | Handout list |

## C. Proof the build team can already show
| # | Item | Status | Where |
|---|---|---|---|
| C1 | 247 API tests and 45 shared tests pass, including all-route authorisation sweep and IDOR matrix | ✅ | `phase6/security-tests.md` |
| C2 | Every role opens every page: no console, CSP or server errors; axe serious/critical = 0 in light, dark, Hindi and 375 px | ✅ (see result table) | `phase6/e2e-and-a11y.md` |
| C3 | Lighthouse ≥ 90 on all four categories for public pages; JS < 170 KB | ✅ | same |
| C4 | Public LCP < 2.5 s | 🟡 `/report` measured 2.7 s on a slow-4G, slow-CPU profile | same |
| C5 | Load test meets read p95 < 300 ms, write < 600 ms, dashboards < 2 s | 🟡 see `phase6/load-test.md` for the exact conditions and the cases that miss | `phase6/load-test.md` |
| C6 | Dependency audit clean | ✅ `pnpm audit`: none (2026-10-22). Repeat at each release | |
| C7 | Container image scan | ❌ no Docker here | |

## D. Pilot operation
| # | Item | Status |
|---|---|---|
| D1 | Pilot scope written: which divisions, how many inspectors, how many owners, start and end dates, success measures | ❌ |
| D2 | Old records for pilot area imported through Admin > Migration (dry run first) | ❌ |
| D3 | Help desk phone/e-mail and hours published at `/help` | ❌ |
| D4 | Go/no-go meeting held; exit criteria for ending the pilot agreed (for example: 30 days, no Critical bug open, 90% of visits completed in-system) | ❌ |
| D5 | Rollback plan: what happens to cases already in the system if the pilot is stopped | ❌ |

## Sign-off
Office head ________ · IT lead ________ · Data protection contact ________ · Date ________
