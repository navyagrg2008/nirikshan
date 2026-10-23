# ADR 0010: Configurable default rate limit and optional dashboard cache

Date 2026-10-22 · Status: accepted

## Context
Load testing hit the built-in default limit (600 requests a minute per address) almost at once, which is correct behaviour but was not adjustable. Dashboards run about 20 queries each; fifty people opening them at the same moment saturates a small server.

## Decision
- `RATE_LIMIT_DEFAULT_PER_MIN` (default 600) sets the limit for routes that have none of their own. Routes with their own limits (sign-in, OTP, public validate, tamper reports) are unchanged. Raise it only on a test stack.
- `DASHBOARD_CACHE_SECONDS` (default **0 = off**, max 300) keeps each person's officer or admin dashboard in Redis for that many seconds. The key includes the user id, so nobody can receive another person's numbers. Every dashboard already shows when it was generated.

## Consequences
- With 30 s caching, 50 constant requests to the admin dashboard dropped from p97.5 8.4 s to 81 ms. The first burst after expiry still computes the dashboard once per waiting request (no stampede protection); that only matters when many officers open it in the same second.
- Dashboard numbers may be up to the cache time old. Queue lists and case pages are never cached.
- Not covered by an automated test with the cache turned on; the default (off) path is tested.
