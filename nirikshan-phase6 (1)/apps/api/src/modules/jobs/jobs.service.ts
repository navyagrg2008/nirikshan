import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { AppEnv, ENV } from '../../config/env';
import { DbService } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';
import { NotificationService } from '../notifications/notification.service';
import { LifecycleService, firstTime } from './lifecycle.service';
import { EnforcementService } from '../enforcement/enforcement.service';

export interface JobDef { name: string; description: string; cron: string; run: (now: Date) => Promise<Record<string, unknown>> }
export type RunOutcome = { status: 'OK' | 'FAILED' | 'SKIPPED'; result?: Record<string, unknown>; error?: string; runId: number };

/**
 * Scheduled work. Each job is a plain function (see LifecycleService) wrapped here with a run log, a lock so two servers never run
 * the same job at once, and BullMQ for the schedule, retries with back-off and a restart-safe queue. Under test the scheduler is off
 * and tests call `run` directly.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Jobs');
  private defs = new Map<string, JobDef>();
  private queue?: Queue; private worker?: Worker; private conn?: Redis;

  constructor(@Inject(ENV) private env: AppEnv, private db: DbService, private redis: RedisService, private notif: NotificationService, private life: LifecycleService, private enf: EnforcementService) {
    const L = life;
    // Cron times are Asia/Kolkata.
    this.add({ name: 'expiry-sweeper', description: 'Mark certificates past their end date as expired; instrument becomes expired; tell the owner', cron: '10 0 * * *', run: (n) => L.expirySweeper(n) });
    this.add({ name: 'renewal-scan', description: 'Renewal reminders at 60/30/15/7/1 days and DUE_FOR_RENEWAL status', cron: '0 6 * * *', run: (n) => L.renewalScan(n) });
    this.add({ name: 'application-expiry', description: 'Close applications whose documents were never completed', cron: '0 1 * * *', run: (n) => L.applicationExpiry(n) });
    this.add({ name: 'visit-reminders', description: 'Remind owner and inspector about visits in the next 24 hours', cron: '5 * * * *', run: (n) => L.visitReminders(n) });
    this.add({ name: 'sla-monitor', description: 'Tell officers when a case passes its deadline', cron: '15 * * * *', run: (n) => L.slaMonitor(n) });
    this.add({ name: 'sla-digest', description: 'Daily deadline summary for officers', cron: '0 8 * * *', run: (n) => L.slaDigest(n) });
    this.add({ name: 'audit-verify', description: 'Check the audit trail hash chain; alert admins on any break', cron: '0 3 * * *', run: () => L.auditVerify() });
    this.add({ name: 'enforcement-sync', description: 'Update enforcement drive progress when owners apply or get verified', cron: '30 6 * * *', run: async () => ({ ...(await this.enf.sync()) }) });
    this.add({ name: 'public-stats', description: 'Refresh the public counts shown on the home page', cron: '30 * * * *', run: (n) => L.publicStats(n) });
    this.add({ name: 'retention', description: 'Delete drafts, expired codes and old logs past their retention period', cron: '30 2 * * *', run: (n) => L.retention(n) });
  }
  add(d: JobDef) { this.defs.set(d.name, d); }
  list() { return [...this.defs.values()].map(({ name, description, cron }) => ({ name, description, cron })); }
  has(name: string) { return this.defs.has(name); }

  async onModuleInit() {
    const on = this.env.JOBS_ENABLED ? this.env.JOBS_ENABLED === 'true' : this.env.NODE_ENV !== 'test';
    if (!on) return;
    this.conn = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue('nrk-jobs', { connection: this.conn, prefix: 'nrk' });
    for (const d of this.defs.values()) {
      await this.queue.upsertJobScheduler(d.name, { pattern: d.cron, tz: 'Asia/Kolkata' }, { name: d.name, data: {}, opts: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 50, removeOnFail: 100 } });
    }
    this.worker = new Worker('nrk-jobs', async (job) => {
      const o = await this.run(job.name, { trigger: 'SCHEDULE', attempt: job.attemptsMade + 1 });
      if (o.status === 'FAILED') throw new Error(o.error ?? 'job failed');   // BullMQ then retries with back-off
    }, { connection: this.conn.duplicate({ maxRetriesPerRequest: null }), prefix: 'nrk', concurrency: 1 });
    this.worker.on('error', (e) => this.log.warn(`worker: ${e.message}`));
    this.log.log(`scheduler on: ${this.defs.size} jobs`);
  }
  async onModuleDestroy() { await this.worker?.close().catch(() => undefined); await this.queue?.close().catch(() => undefined); this.conn?.disconnect(); }

  /** Run one job now, record it, and never throw (the outcome says what happened). */
  async run(name: string, o: { trigger?: 'SCHEDULE' | 'MANUAL' | 'TEST'; now?: Date; userId?: string; attempt?: number } = {}): Promise<RunOutcome> {
    const d = this.defs.get(name); if (!d) throw new Error(`Unknown job ${name}`);
    const trigger = o.trigger ?? 'TEST'; const lock = `nrk:joblock:${name}`;
    const got = await this.redis.client.set(lock, '1', 'EX', 900, 'NX');
    const runId = await this.db.system(async (tx) => Number((await tx.query(`INSERT INTO job_runs (job, trigger, status, attempt, started_by, finished_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, trigger, got ? 'RUNNING' : 'SKIPPED', o.attempt ?? 1, o.userId ?? null, got ? null : new Date()])).rows[0].id));
    if (!got) return { status: 'SKIPPED', runId, error: 'already running' };
    try {
      const result = await d.run(o.now ?? new Date());
      await this.db.system((tx) => tx.query(`UPDATE job_runs SET status='OK', finished_at=now(), result=$2::jsonb WHERE id=$1`, [runId, JSON.stringify(result)]));
      return { status: 'OK', result, runId };
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      await this.db.system((tx) => tx.query(`UPDATE job_runs SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1`, [runId, error]));
      // One alert per job per day; the run log has every attempt.
      const alert = await this.db.system((tx) => firstTime(tx, `job-failed:${name}:${new Date().toISOString().slice(0, 10)}`));
      if (alert && (o.attempt ?? 1) >= 3) await this.notif.notifyRole('ADMIN', 'JOB_FAILED', { job: name, error }, '/admin/system').catch(() => undefined);
      return { status: 'FAILED', error, runId };
    } finally { await this.redis.client.del(lock).catch(() => undefined); }
  }

  /** Latest run per job plus recent history, for the admin job monitor. */
  async monitor() {
    return this.db.system(async (tx) => {
      const last = (await tx.query(`SELECT DISTINCT ON (job) job, id, status, trigger, started_at, finished_at, result, error FROM job_runs ORDER BY job, started_at DESC`)).rows;
      const recent = (await tx.query(`SELECT id, job, trigger, status, attempt, started_at, finished_at, result, error FROM job_runs ORDER BY started_at DESC LIMIT 60`)).rows;
      const failed24 = Number((await tx.query(`SELECT count(*) AS n FROM job_runs WHERE status='FAILED' AND started_at > now() - interval '24 hours'`)).rows[0].n);
      return {
        schedulerOn: !!this.worker, failedLast24h: failed24,
        jobs: this.list().map((j) => { const l = last.find((x) => x.job === j.name); return { ...j, last: l ? { id: Number(l.id), status: l.status, trigger: l.trigger, startedAt: l.started_at, finishedAt: l.finished_at, result: l.result, error: l.error } : null }; }),
        recent: recent.map((r) => ({ id: Number(r.id), job: r.job, trigger: r.trigger, status: r.status, attempt: r.attempt, startedAt: r.started_at, finishedAt: r.finished_at, result: r.result, error: r.error })),
      };
    });
  }
}
