# 2. Backup and restore

## What is backed up
- **PostgreSQL**: everything that matters (users, instruments, applications, certificates, audit trail, settings). Personal fields are already encrypted inside the database; a backup copy is encrypted again on top.
- **File storage** (documents, photos, test sheets): bucket versioning on, plus a daily copy to a second location. Files are not in the database.
- **Not backed up on purpose**: Redis (sessions, counters, queue). Losing it signs users out.
- **Keys** are not in either backup. `ROOT_KEYS` lives in the secrets manager; keep an offline sealed copy held by two people. **A database backup without the keys is unreadable for personal fields.**

## Targets (agree with the office; these are proposals)
| | Target | How it is met |
|---|---|---|
| RPO (data you can lose) | 15 minutes | Daily full dump **plus** continuous WAL archiving (point-in-time recovery) |
| RTO (time to be back) | 4 hours | Restore into a standby, point the API at it |
Only the daily dump is proven (see `docs/phase6/restore-drill.md`). **WAL archiving and PITR were not set up here** and need the real server.

## Daily (automatic) and daily check (human, 2 minutes)
- Automatic: `pg_dump --format=custom --no-owner --file=nrk-YYYYMMDD.dump $DATABASE_URL`, encrypt (for example `age` or the storage provider's server-side encryption with a separate key), copy off the machine.
- Check each morning: file exists, size is within 20% of yesterday, copy succeeded. An empty or tiny file means the backup failed: treat as an incident.

## Restore (always into a scratch database first)
1. `createdb nrk_restore`
2. `pg_restore --no-owner --dbname=nrk_restore nrk-YYYYMMDD.dump`
3. Check counts against the live system for the main tables (users, instruments, applications, certificates, audit_log).
4. Check the audit chain: point a throwaway API at `nrk_restore` and run the `audit-verify` job, or run the verify query from `docs/phase6/restore-drill.md`.
5. Only if step 3 and 4 are good and a switch is really needed: stop the API, point `DATABASE_URL` at the restored database, start the API, sign in, open a certificate, validate it publicly.
6. Restore files from the versioned bucket if documents are missing.

## Quarterly drill
Do steps 1 to 4 on the newest dump, write the date, who, counts and chain result in the drill log. A backup that was never restored is a guess.

## Tell
Office head if a daily backup is missing, or on any real restore.
