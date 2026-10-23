# 4. Incident and data breach

## First 15 minutes (any suspected problem)
1. **Write the time down** and who noticed. Keep one running log.
2. **Contain**: turn on the maintenance banner (runbook 6). If an account is involved, suspend it from Admin > Users. If staff accounts are involved, suspend them all first, restore later.
3. **Preserve**: do not delete logs or rows. Take a database backup now (runbook 2). Save `api.log` and nginx logs.
4. **Tell**: office head and the named security contact. Do not post details in open chat.

## Common situations
| Sign | Likely meaning | First move |
|---|---|---|
| "Audit chain break" alert | Audit rows changed or lost | Runbook 7. Treat as serious until explained |
| Many failed sign-ins for one account | Password guessing | The account locks itself; check the sign-in list in Admin > Audit; ask the user |
| Many failed sign-ins across many accounts from few addresses | Credential stuffing | Check rate-limit hits in the log; block the addresses at nginx |
| Spike in public tamper reports or searches | Bot | Confirm CAPTCHA is configured (`CAPTCHA_PROVIDER` not `none`); block addresses |
| A person says their data was seen by someone else | Possible exposure | Open the audit trail for that record (Admin > Audit, filter by the record); who looked, when |
| Certificate shown valid that should not be | Wrong status or leaked signing key | Re-check the certificate in Admin > Certificates; if the QR key leaked, runbook 3 |
| Server or database compromised | Worst case | Contain, preserve, rotate every secret, restore from a known-good backup into a new host |

## Data breach (personal data)
1. Decide scope with the data protection contact: which people, which fields (names and addresses are encrypted at rest; masked in most screens), which period (use the audit trail).
2. The law decides whether and when the regulator and the people must be told. **This system does not decide that.** Get the legal view the same day.
3. If notifying owners: use the notification service from Admin, in English and Hindi, plain words: what happened, what data, what we did, what they should do, who to contact.
4. After: fix the cause, write the timeline, add a test that would have caught it.

## After any incident
Write: timeline, cause, what was exposed, what was changed, what will stop it recurring. File it with the pilot sign-off pack.
