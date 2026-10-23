# ADR 0001: Local authentication now, Keycloak behind the same seam later
Status: accepted for Phase 2 (needs your confirmation)

The brief names Keycloak. Phase 2 ships a built-in login (argon2id passwords, OTP, TOTP for staff, server-side opaque sessions in Redis) behind `AuthService` and `SessionService`. Keycloak is **not integrated or tested**.

Why: every rule that matters (lockout, step-up, session limits, CSRF, audit) had to be proven end to end, and that is hard to do against an IdP we cannot run in the build sandbox. The browser never sees tokens either way (BFF), so swapping the identity source later changes login and user provisioning only, not the guards, RLS or screens. `users.keycloak_sub` already exists (`local:<uuid>` today).
Cost of switching later: about one phase of work for OIDC login, staff provisioning and MFA hand-over. If Keycloak is mandatory for the pilot, say so before Phase 3.
