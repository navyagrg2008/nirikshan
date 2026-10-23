# Load test against the performance targets

Script: `apps/web/e2e/load-test.mjs` (signs in once per role in a real browser, then autocannon hits the API directly). Data: `scripts/seed-volume.sql`. Run 2026-10-22.

## Conditions (read these before the numbers)
- **One shared machine: 2 CPU cores, 8 GB.** The load generator, API, web server, PostgreSQL and Redis all ran on it. Real servers will be faster per request; they will also be reached over a network.
- Development password hashing setting (`ARGON_MEMORY_KIB=1024`); sign-in speed is **not** measured here.
- Data: **40,004 instruments, 40,002 applications, 12,001 certificates**, spread over 16 areas, mixed statuses. Two businesses: the demo owner holds 300 instruments, the other business about 39,700 (the officer screens see all of it). Notifications, visits and the audit trail are small. A real registry will have different shape and more related rows; treat these as a first estimate, not a promise.
- "Connections" are **back-to-back clients with no think time**. 10 connections hammering without pause is roughly what 100 or more real people produce; 50 connections is a stress test, not a pilot load.
- autocannon reports 97.5th percentile, not 95th. **p97.5 is at least as high as p95**, so a p97.5 under the target proves the p95 is under it. Where p97.5 is over the target, the p95 may or may not be.
- Default rate limit was raised for the test (`RATE_LIMIT_DEFAULT_PER_MIN=1000000`), otherwise the 600 per minute per address limit stops a single test machine. Dashboard cache was **off** (default).
- Zero failed requests (non-2xx) in every run, except 4 timeouts on the officer dashboard at 50 connections.

## Targets (SRS): read p95 < 300 ms · write p95 < 600 ms · dashboard < 2 s

| Request | 10 connections: p50 / **p97.5** (ms) | 50 connections: p50 / **p97.5** (ms) | Target | Verdict |
|---|---|---|---|---|
| Public rules | 17 / 35 | 99 / 180 | 300 | met |
| Public notices | 10 / 19 | 50 / 75 | 300 | met |
| Public stats | 5 / 12 | 24 / 44 | 300 | met |
| Owner: my instruments | 38 / 60 | 208 / 289 | 300 | met (50: close) |
| Owner: my applications | 31 / 53 | 156 / 206 | 300 | met |
| Owner: my certificates | 55 / 91 | 275 / **380** | 300 | met at 10, **missed at 50** |
| Owner: notifications | 16 / 27 | 81 / 134 | 300 | met |
| Officer: case list | 78 / 120 | 381 / **496** | 300 | met at 10, **missed at 50** |
| Officer: schedule calendar | 233 / **327** | 1027 / **1229** | 300 | **missed at both** (by 27 ms at 10) |
| Officer dashboard | 1595 / 1911 | 6814 / **9748** (4 timeouts) | 2000 | met at 10 (barely), **missed at 50** |
| Admin dashboard | 393 / 1195 | 7023 / **8429** | 2000 | met at 10, **missed at 50** |
| Owner: save draft (write, encrypted) | 18 / 39 | 108 / 558 | 600 | met (50: close) |
| Owner: mark notifications read (write) | 14 / 24 | 68 / 103 | 600 | met |

One person on an otherwise idle machine (warm): officer dashboard about 0.4 s, case list 0.04 to 0.17 s, owner lists 0.03 to 0.13 s.

### With `DASHBOARD_CACHE_SECONDS=30` (ADR 0010), 50 connections, dashboards only
Admin dashboard p50 35 / p97.5 **81 ms**. Officer dashboard p50 52 ms, p97.5 3.2 s (the first burst, when every request arrives before anything is cached and each one computes the dashboard; no stampede protection yet). Officer schedule calendar was not helped (not cached): p97.5 1.5 s.

## What the load test found and what was done
Before any change, with this same data and 10 connections: officer dashboard **8.5 s**, officer case list **4.7 s**, owner certificates **1.4 s**, owner applications **1.1 s**, admin dashboard 1.9 s.
1. Row-level security helper functions ran once per row. Fixed in migration 006 (ADR 0008).
2. The officer case list loaded the 2,000 oldest cases, then paged in memory, and the dashboard summary re-ran that 50 times. Rewritten to page and count in the database. (It also meant newer cases could be invisible at scale.)
3. Missing indexes: second ownership column on instruments, certificate creation date, application creation order.
4. Optional dashboard cache and configurable default rate limit (ADR 0010).

## Not shown
- A realistic mix of users over time (a soak test with think time, logins, uploads, PDF generation, report exports). Only single-endpoint hammering was done.
- Sign-in, file upload, certificate PDF and report export speed. Reports are made while you wait (50,000 rows for CSV); their time at this data size was not measured.
- Behaviour with a separate database host, a connection pool limit, or more than one API process. The Redis lock for jobs across two servers was not exercised either.
- The officer schedule calendar is the slowest read and is not yet tuned.
- Memory growth over hours.
- Network effects: nginx, TLS, a CDN, mobile networks.

## Verdict
For a pilot-sized load (a handful of officers and tens of owners at any moment) every target except the officer schedule calendar (p97.5 327 ms against 300) is met on a small shared machine, with the dashboards the closest to the limit. It is **not** shown that the targets hold under 50 constant simultaneous users on this hardware. Before the pilot: run this test again on the real server, turn on the 30-second dashboard cache, and look at the schedule calendar query.
