# 8. Lost admin access

There should always be **two admins** (the demo has two). If one loses a phone: the other opens Admin > Users, finds them, and uses **Reset MFA** (and **Force password reset** if the password is also lost), which asks for re-authentication and signs the person out everywhere. They sign in and enrol a new authenticator.

If **both** are locked out (last resort, needs server access and two people present):
1. A database owner clears the authenticator for one admin: `UPDATE users SET totp_secret_enc = NULL, mfa_enrolled = false WHERE id = '<id>';` (check that these two column names match your database first) then the admin signs in with the existing password (or the other admin forces a password reset once one is available).
2. Record who did this, why, and who watched, in the incident log.
3. That admin signs in, enrols a new authenticator, and creates the second admin.
This path was not rehearsed. Practise it once on staging.
