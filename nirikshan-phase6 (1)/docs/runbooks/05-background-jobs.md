# 5. Background jobs

Admin > System > Jobs lists the ten jobs, the last run, its result and a **Run now** button. All times India time.

| Job | When | If it did not run |
|---|---|---|
| expiry-sweeper | nightly | Certificates past their end date stay "valid". Run now. Safe to repeat |
| renewal-scan | morning | Owners miss reminders. Run now; it does not send the same reminder twice |
| application-expiry | nightly | Old applications stay open. Run now |
| visit-reminders | evening | Owners/inspectors miss reminders. Run now only before the visit time |
| sla-monitor, sla-digest | hourly / 08:00 | Officers not warned. Run now |
| audit-verify | nightly | Chain not checked. Run now, then read the result (runbook 7 if broken) |
| enforcement-sync | nightly | Drive progress stale. Run now |
| public-stats | hourly | Home page counts stale. Run now |
| retention | nightly | Old drafts/codes/logs pile up. Run now; deletes only past-retention data |

## A job failed
Three automatic tries, then admins get a **JOB_FAILED** notification with the error.
1. Open Admin > System > Jobs, read the error.
2. Database or Redis down? Fix that first (check `/api/v1/health/ready`).
3. Click **Run now** once. If it fails again, do not keep clicking: copy the error and the run id, check the API log for that time.
4. Safe to run twice? Yes, every job is written to be repeatable, and a Redis lock stops two servers running the same job at once. (The lock across two servers was tested with a unit test only, not with two live servers.)

## Jobs not running at all
Redis down or the API was not started with the scheduler. Check `redis-cli ping`, restart the API, confirm the jobs show a "next run" time.
