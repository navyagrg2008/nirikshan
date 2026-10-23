# 7. Audit chain break

The audit trail is a chain: each row stores a fingerprint of the one before it. The `audit-verify` job checks it nightly. A break means a row was changed, removed, or inserted out of order.

1. Do not "fix" anything. Do not run Run now repeatedly.
2. Read the alert: it names the first row where the chain stops matching.
3. Take a backup immediately (runbook 2) and save the API and database logs for the day.
4. Compare with the last good backup: restore it into a scratch database (runbook 2) and look at the same row there.
   - Same in backup, different live: a live change after the backup. Find who has database write access and what ran.
   - Missing in both: it never existed or was removed earlier; widen the search to older backups.
5. Treat as a security incident (runbook 4) until a cause is found. Possible innocent cause: a manual database fix. Possible bad cause: tampering.
6. Record the finding. The chain is **not repaired** by editing rows; a documented note is added and the chain continues from the next row.

The `audit_events` table refuses updates and deletes through a database trigger, so normal application code cannot change it. A database owner or superuser can switch the trigger off or edit rows directly, which is why step 4 matters. Nothing here stops a superuser; limit who has that access and log it.
