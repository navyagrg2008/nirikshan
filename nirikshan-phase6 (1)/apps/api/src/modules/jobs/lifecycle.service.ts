import { Injectable, Logger } from '@nestjs/common';
import { istDay } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { StorageService } from '../../infra/storage';
import { NotificationService } from '../notifications/notification.service';
import { CaseStateService } from '../applications/case-state.service';
import { InspectionService } from '../inspection/inspection.service';
import { SettingsService } from '../system/settings.service';
import { AuditService } from '../audit/audit.service';
import { RulesService } from '../rules/rules.service';

type Result = Record<string, unknown>;
const HOUR = 3600_000;
const dstr = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

/** Once-only guard: true the first time a key is seen. A retried or double-run job therefore never repeats a send. */
export async function firstTime(tx: Tx, key: string): Promise<boolean> {
  return ((await tx.query('INSERT INTO job_dedupe (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key', [key])).rowCount ?? 0) > 0;
}

export interface SlaRow { appId: string; applicationNo: string; areaId: string; step: 'DOCUMENT_CHECK' | 'SCHEDULE' | 'DECISION'; startedAt: Date; dueAt: Date; state: 'BREACHED' | 'AT_RISK' }

/** The handlers behind the scheduled jobs. Every handler takes `now`, so tests can travel in time, and is safe to run twice. */
@Injectable()
export class LifecycleService {
  private log = new Logger('Lifecycle');
  constructor(private db: DbService, private notif: NotificationService, private state: CaseStateService, private insp: InspectionService, private settings: SettingsService, private audit: AuditService, private storage: StorageService, private rules: RulesService) {}

  // ------------------------------------------------------------------ renewal reminders and DUE_FOR_RENEWAL
  async renewalScan(now = new Date()): Promise<Result> {
    const cfg = await this.settings.get('lifecycle'); const today = istDay(now);
    const days = [...cfg.reminderDays].sort((a, b) => b - a); const horizon = Math.max(cfg.dueForRenewalDays, days[0] ?? 0);
    const sends: (() => Promise<void>)[] = []; let reminded = 0; let skippedOpen = 0; let due = 0;
    await this.db.system(async (tx) => {
      const rows = (await tx.query(
        `SELECT c.id, c.cert_no, c.valid_till, c.instrument_id, (c.valid_till - $1::date) AS days_left, i.instrument_no, i.status AS istatus, b.owner_user_id,
                EXISTS (SELECT 1 FROM applications a WHERE a.instrument_id=c.instrument_id AND a.status NOT IN ('REJECTED','CERTIFICATE_ISSUED','CANCELLED','APPLICATION_EXPIRED')) AS open_app
         FROM certificates c JOIN instruments i ON i.id=c.instrument_id JOIN businesses b ON b.id=i.business_id
         WHERE c.status='VALID' AND c.valid_till >= $1::date AND c.valid_till <= $1::date + $2::int ORDER BY c.valid_till`, [today, horizon])).rows;
      for (const r of rows) {
        const left = Number(r.days_left);
        if (left <= cfg.dueForRenewalDays && r.istatus === 'ACTIVE') { await tx.query(`UPDATE instruments SET status='DUE_FOR_RENEWAL', version=version+1, updated_at=now() WHERE id=$1`, [r.instrument_id]); due++; }
        // Send only for the smallest threshold that has been crossed; mark the bigger ones as used so a late run does not send three at once.
        const crossed = days.filter((t) => left <= t); if (!crossed.length) continue;
        const target = crossed[crossed.length - 1]!; let fresh = false;
        for (const t of crossed) { const first = await firstTime(tx, `renewal:${r.id}:${t}`); if (t === target) fresh = first; }
        if (!fresh) continue;
        if (r.open_app) { skippedOpen++; continue; }
        reminded++;
        sends.push(() => this.notif.notifyUser(r.owner_user_id, 'RENEWAL_REMINDER', { certNo: r.cert_no, days: String(left), validTill: dstr(r.valid_till) }, `/owner/certificates/${r.id}`));
      }
    });
    for (const s of sends) await s();
    return { today, reminded, skippedBecauseApplicationOpen: skippedOpen, markedDueForRenewal: due };
  }

  // ------------------------------------------------------------------ expiry
  async expirySweeper(now = new Date()): Promise<Result> {
    const today = istDay(now); const sends: (() => Promise<void>)[] = []; let expired = 0;
    await this.db.system(async (tx) => {
      const rows = (await tx.query(
        `UPDATE certificates c SET status='EXPIRED' WHERE c.status='VALID' AND c.valid_till < $1::date RETURNING c.id, c.cert_no, c.instrument_id, c.valid_till, c.application_id`, [today])).rows;
      for (const r of rows) {
        expired++;
        await tx.query(`INSERT INTO certificate_status_history (certificate_id, from_status, to_status, public_reason, internal_reason, actor_id) VALUES ($1,'VALID','EXPIRED','Validity period ended','Expired by the daily sweeper',NULL)`, [r.id]);
        await tx.query(`UPDATE public_certificate_index SET status='EXPIRED', updated_at=now() WHERE cert_no=$1`, [r.cert_no]);
        // A renewal may already have been issued; only mark the instrument EXPIRED when nothing else is in force.
        const other = (await tx.query(`SELECT 1 FROM certificates WHERE instrument_id=$1 AND status='VALID' AND valid_till >= $2::date LIMIT 1`, [r.instrument_id, today])).rowCount;
        if (!other) await tx.query(`UPDATE instruments SET status='EXPIRED', version=version+1, updated_at=now() WHERE id=$1 AND status IN ('ACTIVE','DUE_FOR_RENEWAL')`, [r.instrument_id]);
        await this.audit.record(tx, { action: 'certificate.expired', entityType: 'certificate', entityId: r.id, actorId: null, actorRole: 'SYSTEM', details: { certNo: r.cert_no } });
        const owner = (await tx.query(`SELECT b.owner_user_id FROM instruments i JOIN businesses b ON b.id=i.business_id WHERE i.id=$1`, [r.instrument_id])).rows[0]?.owner_user_id;
        if (owner) sends.push(() => this.notif.notifyUser(owner, 'CERTIFICATE_EXPIRED', { certNo: r.cert_no, validTill: dstr(r.valid_till) }, `/owner/certificates/${r.id}`));
      }
    });
    for (const s of sends) await s();
    return { today, expired };
  }

  // ------------------------------------------------------------------ applications that never got their documents in
  async applicationExpiry(now = new Date()): Promise<Result> {
    const cfg = await this.settings.get('lifecycle'); const sends: (() => Promise<void>)[] = []; let expired = 0;
    await this.db.system(async (tx) => {
      const rows = (await tx.query(
        `SELECT a.id, a.application_no, b.owner_user_id FROM applications a JOIN businesses b ON b.id=a.business_id
         WHERE a.status='APPLIED' AND a.created_at < $1::timestamptz - make_interval(days => $2) ORDER BY a.created_at`, [now, cfg.applicationExpiryDays])).rows;
      for (const r of rows) {
        await this.state.transition(tx, r.id, 'expire', 'SYSTEM', null, `Documents were not completed within ${cfg.applicationExpiryDays} days`);
        expired++; sends.push(() => this.notif.notifyUser(r.owner_user_id, 'APPLICATION_EXPIRED', { appNo: r.application_no }, `/owner/applications/${r.id}`));
      }
    });
    for (const s of sends) await s();
    return { expired, afterDays: cfg.applicationExpiryDays };
  }

  // ------------------------------------------------------------------ visit reminders
  async visitReminders(now = new Date()): Promise<Result> {
    const cfg = await this.settings.get('lifecycle'); const sends: (() => Promise<void>)[] = []; let sent = 0;
    await this.db.system(async (tx) => {
      const rows = (await tx.query(
        `SELECT v.id, v.inspector_id, lower(v.scheduled_window) AS s, a.application_no, a.id AS app_id, b.owner_user_id
         FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN businesses b ON b.id=a.business_id
         WHERE v.status='SCHEDULED' AND lower(v.scheduled_window) > $1::timestamptz AND lower(v.scheduled_window) <= $1::timestamptz + make_interval(hours => $2)`, [now, cfg.visitReminderHours])).rows;
      for (const r of rows) {
        if (!(await firstTime(tx, `visit-reminder:${r.id}:${new Date(r.s).toISOString()}`))) continue;   // a moved visit is reminded again
        const when = new Date(r.s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        sent++;
        sends.push(() => this.notif.notifyUser(r.owner_user_id, 'VISIT_REMINDER', { appNo: r.application_no, when }, `/owner/applications/${r.app_id}`));
        sends.push(() => this.notif.notifyUser(r.inspector_id, 'VISIT_REMINDER', { appNo: r.application_no, when }, `/inspector/visits/${r.id}`));
      }
    });
    for (const s of sends) await s();
    return { visitsReminded: sent };
  }

  // ------------------------------------------------------------------ deadlines
  /** Cases that are past, or inside the last quarter of, the deadline for their current step. */
  async slaScan(tx: Tx, now = new Date(), areaIds?: string[]): Promise<SlaRow[]> {
    const rows = (await tx.query(
      `SELECT a.id, a.application_no, a.area_id, a.status, a.created_at, a.ready_at, v.submitted_at,
              COALESCE((SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='DOCUMENT_CHECK'), 48) AS doc_h,
              COALESCE((SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='SCHEDULE'), 72) AS sch_h,
              COALESCE((SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='DECISION'), 72) AS dec_h
       FROM applications a
       LEFT JOIN LATERAL (SELECT submitted_at FROM inspection_visits x WHERE x.application_id=a.id AND x.status='SUBMITTED' ORDER BY x.submitted_at DESC LIMIT 1) v ON true
       WHERE a.status IN ('APPLIED','DOCUMENT_CHECKED','FAILED_ATTEMPT','INSPECTED','REFERRED') ${areaIds ? 'AND a.area_id = ANY($1::uuid[])' : ''}`, areaIds ? [areaIds] : [])).rows;
    const out: SlaRow[] = [];
    for (const r of rows) {
      let step: SlaRow['step']; let start: Date; let hours: number;
      if (r.status === 'APPLIED') { step = 'DOCUMENT_CHECK'; start = r.created_at; hours = r.doc_h; }
      else if (r.status === 'DOCUMENT_CHECKED' || r.status === 'FAILED_ATTEMPT') { step = 'SCHEDULE'; start = r.ready_at ?? r.created_at; hours = r.sch_h; }
      else { step = 'DECISION'; start = r.submitted_at ?? r.created_at; hours = r.dec_h; }
      const due = new Date(new Date(start).getTime() + hours * HOUR); const left = due.getTime() - now.getTime();
      if (left < 0) out.push({ appId: r.id, applicationNo: r.application_no, areaId: r.area_id, step, startedAt: new Date(start), dueAt: due, state: 'BREACHED' });
      else if (left < hours * HOUR * 0.25) out.push({ appId: r.id, applicationNo: r.application_no, areaId: r.area_id, step, startedAt: new Date(start), dueAt: due, state: 'AT_RISK' });
    }
    return out;
  }
  async slaMonitor(now = new Date()): Promise<Result> {
    const sends: (() => Promise<void>)[] = []; let breaches = 0;
    await this.db.system(async (tx) => {
      for (const r of (await this.slaScan(tx, now)).filter((x) => x.state === 'BREACHED')) {
        if (!(await firstTime(tx, `sla:${r.appId}:${r.step}`))) continue;
        breaches++; sends.push(() => this.notif.notifyOfficersInArea(r.areaId, 'SLA_BREACH', { appNo: r.applicationNo, step: r.step.replace('_', ' ').toLowerCase() }, `/officer/cases/${r.appId}`));
      }
    });
    for (const s of sends) await s();
    return { newBreaches: breaches };
  }
  async slaDigest(now = new Date()): Promise<Result> {
    const day = istDay(now); const sends: (() => Promise<void>)[] = []; let areas = 0;
    await this.db.system(async (tx) => {
      const by = new Map<string, { overdue: number; atRisk: number }>();
      for (const r of await this.slaScan(tx, now)) { const e = by.get(r.areaId) ?? { overdue: 0, atRisk: 0 }; if (r.state === 'BREACHED') e.overdue++; else e.atRisk++; by.set(r.areaId, e); }
      for (const [area, c] of by) { if (!(await firstTime(tx, `sla-digest:${area}:${day}`))) continue; areas++; sends.push(() => this.notif.notifyOfficersInArea(area, 'SLA_DIGEST', { overdue: String(c.overdue), atRisk: String(c.atRisk) }, '/officer/dashboard')); }
    });
    for (const s of sends) await s();
    return { day, areasNotified: areas };
  }

  // ------------------------------------------------------------------ audit chain, stats, retention
  async auditVerify(): Promise<Result> {
    const r = await this.audit.verifyChain();
    if (!r.intact) await this.notif.notifyRole('ADMIN', 'AUDIT_CHAIN_BROKEN', { id: String(r.firstBadId) }, '/admin/audit');
    return { ...r };
  }
  async publicStats(now = new Date()): Promise<Result> {
    return this.db.system(async (tx) => {
      const reg = (await tx.query(`SELECT count(*)::bigint AS n FROM instruments WHERE status <> 'DEREGISTERED'`)).rows[0].n;
      const ver = (await tx.query(`SELECT count(*)::bigint AS n FROM instruments WHERE first_verified_at IS NOT NULL`)).rows[0].n;
      const div = (await tx.query(`WITH RECURSIVE up AS (SELECT i.area_id AS id, a.parent_id, a.level FROM instruments i JOIN areas a ON a.id=i.area_id UNION ALL SELECT a.id, a.parent_id, a.level FROM areas a JOIN up ON a.id = up.parent_id) SELECT count(DISTINCT id)::int AS n FROM up WHERE level='DIVISION'`)).rows[0].n;
      await tx.query('INSERT INTO public_stats_aggregate (as_of, instruments_registered, instruments_verified, districts_covered) VALUES ($1,$2,$3,$4)', [now, reg, ver, div]);
      await tx.query(`DELETE FROM public_stats_aggregate WHERE id IN (SELECT id FROM public_stats_aggregate ORDER BY as_of DESC OFFSET 200)`);
      return { registered: Number(reg), verified: Number(ver), divisions: div };
    });
  }
  async retention(now = new Date()): Promise<Result> {
    const out: Result = {};
    await this.db.system(async (tx) => {
      out.instrumentDrafts = (await tx.query('DELETE FROM instrument_drafts WHERE expires_at < $1', [now])).rowCount;
      out.otpChallenges = (await tx.query(`DELETE FROM otp_challenges WHERE expires_at < $1::timestamptz - interval '1 day'`, [now])).rowCount;
      out.staffInvites = (await tx.query(`DELETE FROM staff_invites WHERE expires_at < $1::timestamptz - interval '7 days' AND used_at IS NULL`, [now])).rowCount;
      out.lookupLog = (await tx.query(`DELETE FROM public_lookup_log WHERE created_at < $1::timestamptz - interval '90 days'`, [now])).rowCount;
      out.jobRuns = (await tx.query(`DELETE FROM job_runs WHERE started_at < $1::timestamptz - interval '180 days'`, [now])).rowCount;
      out.dedupeKeys = (await tx.query(`DELETE FROM job_dedupe WHERE created_at < $1::timestamptz - interval '400 days'`, [now])).rowCount;
      out.readNotifications = (await tx.query(`DELETE FROM in_app_notifications WHERE read_at IS NOT NULL AND created_at < $1::timestamptz - interval '365 days'`, [now])).rowCount;
    });
    out.inspectionDrafts = await this.insp.purgeExpiredDrafts();
    out.rulesRetired = await this.rules.retireEnded(now);
    this.log.log(`retention ${JSON.stringify(out)}`);
    return out;
  }
}
