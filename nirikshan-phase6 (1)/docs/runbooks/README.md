# Runbooks

Short, step-by-step. Written for the person on call at 2 a.m. Each one says **when**, **steps**, **how to check it worked**, **who to tell**.

| # | Runbook | Use it when |
|---|---|---|
| 1 | [Deploy and roll back](01-deploy-and-rollback.md) | Releasing a version, or a release goes wrong |
| 2 | [Backup and restore](02-backup-and-restore.md) | Daily backup check, quarterly drill, data loss |
| 3 | [Key rotation](03-key-rotation.md) | Yearly rotation, or a key may have leaked |
| 4 | [Incident and data breach](04-incident-and-breach.md) | Anything that looks like a security problem |
| 5 | [Background jobs](05-background-jobs.md) | A job failed, did not run, or ran twice |
| 6 | [Maintenance banner and feature switches](06-maintenance-banner.md) | Planned downtime, or turning a public feature off |
| 7 | [Audit chain break](07-audit-chain-break.md) | Admins got an "audit chain break" alert |
| 8 | [Lost admin access](08-lost-admin-access.md) | The only admin lost their phone or password |

Environment facts all runbooks rely on: times are India time (Asia/Kolkata); the API and web are separate processes behind nginx; PostgreSQL holds all data; Redis holds sessions, rate-limit counters, OTP counters and the job queue (Redis is **not** a source of truth: losing it signs everyone out and clears counters, nothing else).
