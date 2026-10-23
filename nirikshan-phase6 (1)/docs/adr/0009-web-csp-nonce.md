# ADR 0009: Per-request nonce for the web security policy

Date 2026-10-22 · Status: accepted

## Context
The web app sent a fixed Content-Security-Policy that had to allow inline scripts, because Next.js adds small inline scripts to every page. That weakens the main protection against injected script.

## Decision
`apps/web/middleware.ts` makes a random nonce for each page request and sends `script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` only in development). Next reads the nonce and stamps its own scripts. The root layout is `force-dynamic` so every page is rendered per request (a nonce cannot be baked into a pre-built page). The Turnstile host is allowed in `connect-src` and `frame-src` only when `NEXT_PUBLIC_TURNSTILE_SITEKEY` is set at build time.

## Consequences
- Scripts are strict. **Styles are not**: `style-src` keeps `'unsafe-inline'` because the UI uses inline style attributes. Accepted deviation from a fully strict policy.
- No page is served from a static cache. Public pages that need data (`/`, `/rules`, `/notices`) fetch it on the server so the first HTML is complete (this also fixed their load time).
- Every role was walked through every page in a browser with the policy active; no violations were reported.
- A CDN in front must not cache HTML (the nonce differs per response).
