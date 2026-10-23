# ADR 0006: Background jobs: BullMQ on Redis, one lock per job, every handler takes "now"
Expiry, reminders, deadline checks and clean-up must run on time, run once, and be provable.

- **Scheduler**: BullMQ repeatable jobs on the Redis we already run. Cron times are in Indian time. The scheduler starts with the API; it can be switched off on a server that should not run jobs.
- **Once only**: each run takes a Redis lock (`nrk:joblock:{name}`). If two servers fire together, one runs and the other records "skipped".
- **Visible**: every run is written to `job_runs` (status, trigger, result, error). Three failed tries alert all admins. Admins can run a job by hand (needs re-authentication) from System.
- **Testable**: every handler takes `now`, so tests move the clock instead of waiting. Reminders are de-duplicated in `job_dedupe`, so a re-run never sends twice.
- **Safe**: jobs work through a system database role that has an explicit policy for each table and action it touches. Nothing is deleted without a retention rule.
Why not cron or the database's own scheduler? Redis is already required, BullMQ gives retries and a history, and keeping logic in the application keeps it under the same tests and audit trail.
Not covered: behaviour with many servers over a long period. Reports are not a job (made while you wait).
