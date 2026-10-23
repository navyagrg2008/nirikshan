import { Inject, Injectable } from '@nestjs/common';
import { istDay } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';
import { ENV, type AppEnv } from '../../config/env';
import { LifecycleService } from '../jobs/lifecycle.service';
import { JobsService } from '../jobs/jobs.service';
import { OfficerService } from '../officer/officer.service';
import { SettingsService } from '../system/settings.service';
import type { SessionUser } from '../../common/request-context';

const OPEN = `('REJECTED','CANCELLED','APPLICATION_EXPIRED','CERTIFICATE_ISSUED')`;
const num = (v: unknown) => Number(v ?? 0);

@Injectable()
export class DashboardService {
  constructor(private db: DbService, private life: LifecycleService, private jobs: JobsService, private officer: OfficerService, private settings: SettingsService, private redis: RedisService, @Inject(ENV) private env: AppEnv) {}

  /** Optional short cache (DASHBOARD_CACHE_SECONDS, off by default). Each person gets their own copy, so nobody sees numbers outside their scope. Every dashboard shows when it was made. */
  private async cached<T>(key: string, make: () => Promise<T>): Promise<T> {
    const ttl = this.env.DASHBOARD_CACHE_SECONDS; if (!ttl) return make();
    const hit = await this.redis.getJson<T>(key); if (hit) return hit;
    const v = await make(); await this.redis.setJson(key, v, ttl); return v;
  }
  officerView(u: SessionUser, now?: Date) { return now ? this.officerFresh(u, now) : this.cached(`dash:officer:${u.userId}`, () => this.officerFresh(u)); }
  adminView(u: SessionUser, now?: Date) { return now ? this.adminFresh(u, now) : this.cached(`dash:admin:${u.userId}`, () => this.adminFresh(u)); }

  /** Weekly counts for the last 8 weeks. Weeks start on Monday in India time, in both the database and the labels, so the two always agree whatever the hour. */
  private async trend(tx: Tx) {
    const WEEK = `to_char(date_trunc('week', X AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD')`;
    const SINCE = `(date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') - interval '7 weeks') AT TIME ZONE 'Asia/Kolkata'`;
    const apps = (await tx.query(`SELECT ${WEEK.replace('X', 'created_at')} AS w, count(*)::int AS n FROM applications WHERE created_at >= ${SINCE} GROUP BY 1`)).rows;
    const certs = (await tx.query(`SELECT ${WEEK.replace('X', 'c.created_at')} AS w, count(*)::int AS n FROM certificates c WHERE c.created_at >= ${SINCE} GROUP BY 1`)).rows;
    const ist = new Date(Date.now() + 5.5 * 3600_000); ist.setUTCHours(0, 0, 0, 0); ist.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7) - 49);
    const weeks: string[] = []; for (let i = 0; i < 8; i++) weeks.push(new Date(ist.getTime() + i * 7 * 86400_000).toISOString().slice(0, 10));
    const at = (rows: { w: string; n: number }[], w: string) => rows.find((r) => r.w === w)?.n ?? 0;
    return weeks.map((w) => ({ week: w, applications: at(apps, w), certificates: at(certs, w) }));
  }

  /** Everything is read through the officer's own database view, so the numbers are for their areas only. */
  private async officerFresh(u: SessionUser, now = new Date()) {
    const [accounts, duplicates] = [(await this.officer.pendingAccounts(u)).length, (await this.officer.duplicates(u)).length];
    return this.db.forUser(async (tx) => {
      const one = async (sql: string, args: unknown[] = []) => num((await tx.query(sql, args)).rows[0]?.n);
      const reqs = (await tx.query(`SELECT kind, count(*)::int AS n FROM instrument_requests WHERE status='OPEN' GROUP BY kind`)).rows;
      const pipeline = (await tx.query(`SELECT status, count(*)::int AS n FROM applications WHERE status NOT IN ${OPEN} GROUP BY status ORDER BY n DESC`)).rows;
      const sla = await this.life.slaScan(tx, now, u.areaIds);
      return {
        generatedAt: now.toISOString(),
        queues: {
          accounts, duplicates, transfers: num(reqs.find((r) => r.kind === 'TRANSFER')?.n) + num(reqs.find((r) => r.kind === 'ADDRESS_CHANGE')?.n),
          deregistrations: num(reqs.find((r) => r.kind === 'DEREGISTER')?.n),
          grievances: await one(`SELECT count(*) n FROM grievances WHERE status IN ('OPEN','IN_PROGRESS')`), tamperReports: await one(`SELECT count(*) n FROM tamper_reports WHERE status IN ('OPEN','IN_PROGRESS')`),
        },
        work: {
          documentsToCheck: await one(`SELECT count(*) n FROM applications WHERE status='APPLIED'`), toSchedule: await one(`SELECT count(*) n FROM applications WHERE status IN ('DOCUMENT_CHECKED','FAILED_ATTEMPT')`),
          decisionsWaiting: await one(`SELECT count(*) n FROM applications WHERE status IN ('INSPECTED','REFERRED')`),
          visitsNext7Days: await one(`SELECT count(*) n FROM inspection_visits WHERE status='SCHEDULED' AND lower(scheduled_window) BETWEEN now() AND now() + interval '7 days'`),
        },
        deadlines: { breached: sla.filter((r) => r.state === 'BREACHED').length, atRisk: sla.filter((r) => r.state === 'AT_RISK').length },
        compliance: {
          expiringIn30Days: await one(`SELECT count(*) n FROM certificates c JOIN instruments i ON i.id=c.instrument_id WHERE c.status='VALID' AND c.valid_till BETWEEN current_date AND current_date + 30`),
          expiredNotInDrive: await one(`SELECT count(*) n FROM instruments i WHERE i.status='EXPIRED' AND NOT EXISTS (SELECT 1 FROM enforcement_drive_items di JOIN enforcement_drives d ON d.id=di.drive_id WHERE di.instrument_id=i.id AND d.status<>'CLOSED')`),
          activeDrives: await one(`SELECT count(*) n FROM enforcement_drives WHERE status <> 'CLOSED'`),
        },
        pipeline: pipeline.map((r) => ({ status: r.status as string, count: r.n as number })),
        trend: await this.trend(tx),
      };
    });
  }

  private async adminFresh(u: SessionUser, now = new Date()) {
    const mon = await this.jobs.monitor(); const maint = await this.settings.get('maintenance');
    return this.db.forUser(async (tx) => {
      const rows = async (sql: string) => (await tx.query(sql)).rows;
      const one = async (sql: string) => num((await tx.query(sql)).rows[0]?.n);
      const people = await rows(`SELECT r.code AS role, u.account_status AS status, count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id GROUP BY 1, 2 ORDER BY 1, 2`);
      const verify = mon.jobs.find((j) => j.name === 'audit-verify')?.last as { status: string; startedAt: Date; result: { intact?: boolean; checked?: number } | null } | null | undefined;
      const rule = (await rows(`SELECT version, status, effective_from::text AS f, effective_to::text AS t FROM rule_sets WHERE status IN ('PUBLISHED','DRAFT','IN_REVIEW') ORDER BY (status='PUBLISHED') DESC, effective_from DESC`));
      const inForce = rule.find((r) => r.status === 'PUBLISHED' && r.f <= istDay(now) && (!r.t || r.t > istDay(now)));
      return {
        generatedAt: now.toISOString(),
        people: people.map((r) => ({ role: r.role as string, status: r.status as string, count: r.n as number })),
        registry: {
          instruments: (await rows(`SELECT status, count(*)::int AS n FROM instruments GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ status: r.status as string, count: r.n as number })),
          openApplications: await one(`SELECT count(*) n FROM applications WHERE status NOT IN ${OPEN}`), certificatesInForce: await one(`SELECT count(*) n FROM certificates WHERE status='VALID' AND valid_till >= current_date`),
          certificatesIssuedLast30Days: await one(`SELECT count(*) n FROM certificates WHERE created_at > now() - interval '30 days'`),
        },
        backlogByArea: (await rows(`SELECT ar.name_en AS area, count(*)::int AS n FROM applications a JOIN areas ar ON ar.id=a.area_id WHERE a.status NOT IN ${OPEN} GROUP BY ar.name_en ORDER BY n DESC LIMIT 6`)).map((r) => ({ area: r.area as string, open: r.n as number })),
        health: { schedulerOn: mon.schedulerOn, jobsFailedLast24h: mon.failedLast24h, auditChain: verify ? { status: verify.status, checkedAt: verify.startedAt, intact: verify.result?.intact ?? null, entries: verify.result?.checked ?? null } : null, maintenanceBannerOn: maint.enabled },
        privacy: { openRequests: await one(`SELECT count(*) n FROM data_subject_requests WHERE status IN ('OPEN','IN_PROGRESS')`), overdueRequests: await one(`SELECT count(*) n FROM data_subject_requests WHERE status IN ('OPEN','IN_PROGRESS') AND due_at < now()`) },
        rules: { inForce: inForce ? { version: inForce.version as number, from: inForce.f as string } : null, pending: rule.filter((r) => r.status !== 'PUBLISHED').map((r) => ({ version: r.version as number, status: r.status as string })) },
        complaints: { grievancesOpen: await one(`SELECT count(*) n FROM grievances WHERE status IN ('OPEN','IN_PROGRESS')`), tamperOpen: await one(`SELECT count(*) n FROM tamper_reports WHERE status IN ('OPEN','IN_PROGRESS')`) },
        trend: await this.trend(tx),
      };
    });
  }
}
