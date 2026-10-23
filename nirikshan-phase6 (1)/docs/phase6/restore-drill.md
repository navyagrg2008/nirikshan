# Backup restore drill: result

Script: `scripts/restore-drill.sh` (read it; it is short). Run on the development database after it held about 138,000 rows (including the synthetic load-test volume). Date: 2026-10-22.

| Step | Result |
|---|---|
| `pg_dump --format=custom` | 1.1 s, 6.7 MB after encryption (AES-256, key kept apart from the file) |
| Decrypt, `pg_restore` into a scratch database | 1.9 s, no warnings |
| Row counts, source vs restored, **all 74 tables** | **match** (138,015 rows) |
| Audit hash chain on the source | 96 rows checked, intact |
| Audit hash chain on the restored copy | 96 rows checked, **intact** |
| Deliberately change one audit row in a throwaway copy, run the chain check | **detected**, first bad row reported |
| Scratch databases and files | removed by the script |

## What this proves
That a custom-format dump of this schema restores completely and keeps the audit chain valid, and that the chain check really does notice tampering. Time numbers are for a small database on a shared two-core machine; they are not a promise for production size.

## What it does not prove
- **Point-in-time recovery (PITR).** No WAL archiving exists in this environment, so the 15-minute RPO in runbook 2 is a target, not something shown. Only "restore last night's dump" is shown.
- **Restore of uploaded files.** Files live in object storage, not in the database. Not exercised.
- **Restore on a different server**, with real roles and permissions. The dump uses `--no-owner`; the `nirikshan_app` role and its grants come from the migrations and must exist on the target (run migrations on an empty database, or restore into one that already has the roles).
- **Restore with the production key.** Personal fields stay encrypted in the dump; the restored copy was read only for counts and the chain. Opening a restored record through the API with the real key set was not done.
- **Timing at production size.** Unknown.

## Next drill (quarterly)
Run the script against a copy of production data (not the live database), add: open three records through a throwaway API instance, restore one object-storage file, and record the wall-clock time from "decision to restore" to "API answering". That last number is the real RTO.
