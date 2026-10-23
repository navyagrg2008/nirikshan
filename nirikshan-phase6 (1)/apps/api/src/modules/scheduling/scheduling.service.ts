import { Injectable } from '@nestjs/common';
import {
  addDays, haversineKm, isWorkingDay, istDay, istInstant, scoreCandidate, slotsForDay,
  type ScoreBreakdown, type SchedulingSettings, type Weights, type Slot,
} from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { CaseStateService } from '../applications/case-state.service';
import { isExclusionViolation, runNotes, type Note } from '../../common/pg';
import { conflict, notFound } from '../../common/errors';

export interface Plan {
  inspectorId: string | null; window: { start: Date; end: Date } | null; score: ScoreBreakdown | null;
  reasons: string[]; runnersUp: { inspectorId: string; total: number }[]; considered: number; slaDeadline: string;
  inputs: { distanceKm: number | null; loadRatio: number; areaProximity: number } | null;
}
export interface PlanInput {
  areaId: string; categoryId: string; instrumentId?: string; premises?: { lat: number; lng: number } | null;
  readyAt: Date; slaHours: number; now: Date; notBefore?: string | null; preferred?: { from: string; to: string | null } | null;
  /** Slots that must not be proposed again (the one the owner just asked to leave). */
  avoid?: { inspectorId: string; start: number }[];
}
export type ScheduleOutcome = { mode: 'AUTO'; visitId: string; inspectorId: string; start: Date; end: Date } | { mode: 'REVIEW'; proposalId: string; reasons: string[] };

export const fmtDay = (d: Date) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(d);
const fmtHM = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
export const fmtWindow = (s: Date, e: Date) => `${fmtDay(s)}, ${fmtHM(s)} to ${fmtHM(e)}`;

@Injectable()
export class SchedulingService {
  constructor(private db: DbService, private crypto: CryptoService, private state: CaseStateService, private audit: AuditService, private notif: NotificationService) {}

  async settings(tx: Tx): Promise<SchedulingSettings> {
    const r = (await tx.query('SELECT weights, auto_threshold, day_start_hour, day_end_hour, slot_hours, working_days, max_failed_attempts, horizon_days FROM scheduling_settings WHERE id')).rows[0];
    return { weights: r.weights as Weights, autoThreshold: Number(r.auto_threshold), dayStartHour: r.day_start_hour, dayEndHour: r.day_end_hour, slotHours: r.slot_hours, workingDays: r.working_days, maxFailedAttempts: r.max_failed_attempts, horizonDays: r.horizon_days };
  }
  async holidays(tx: Tx, areaId: string, from: string, to: string): Promise<Set<string>> {
    const r = await tx.query(
      `WITH RECURSIVE up AS (SELECT id, parent_id FROM areas WHERE id=$1 UNION SELECT a.id, a.parent_id FROM areas a JOIN up ON a.id=up.parent_id)
       SELECT to_char(holiday_date,'YYYY-MM-DD') AS d FROM holiday_calendar WHERE holiday_date BETWEEN $2::date AND $3::date AND (area_id IS NULL OR area_id IN (SELECT id FROM up))`, [areaId, from, to]);
    return new Set(r.rows.map((x) => x.d as string));
  }

  /** Read-only: who could take this case, when, and how well they score. Must run with a role that can see all visits (SYSTEM). */
  async plan(tx: Tx, i: PlanInput, cfg?: SchedulingSettings): Promise<Plan> {
    const s = cfg ?? await this.settings(tx);
    const today = istDay(i.now); const tomorrow = addDays(today, 1);
    const startDay = i.notBefore && i.notBefore > tomorrow ? i.notBefore : tomorrow; const endDay = addDays(startDay, s.horizonDays);
    // The clock runs from the later of "ready" and the first day we are allowed to book (a holiday or an owner's own date restarts it).
    const slaDeadline = istDay(new Date(Math.max(i.readyAt.getTime(), i.notBefore ? istInstant(i.notBefore, 0).getTime() : 0) + i.slaHours * 3_600_000));
    const empty: Plan = { inspectorId: null, window: null, score: null, reasons: ['NO_CANDIDATE'], runnersUp: [], considered: 0, slaDeadline, inputs: null };

    const cands = (await tx.query(
      `WITH RECURSIVE up AS (SELECT id, parent_id, 0 AS depth FROM areas WHERE id=$1 UNION ALL SELECT a.id, a.parent_id, up.depth+1 FROM areas a JOIN up ON a.id=up.parent_id)
       SELECT u.id, p.daily_capacity, p.home_enc,
         (SELECT min(up.depth) FROM user_area_scopes sc JOIN up ON up.id=sc.area_id WHERE sc.user_id=u.id) AS depth,
         (SELECT count(*)::int FROM inspector_skills k2 WHERE k2.inspector_id=u.id AND (k2.certified_until IS NULL OR k2.certified_until >= $3::date)) AS skill_count
       FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id AND r.code='INSPECTOR' JOIN inspector_profiles p ON p.user_id=u.id
       WHERE u.account_status='ACTIVE' AND p.active
         AND EXISTS (SELECT 1 FROM inspector_skills k WHERE k.inspector_id=u.id AND k.category_id=$2 AND (k.certified_until IS NULL OR k.certified_until >= $3::date))`, [i.areaId, i.categoryId, today])).rows
      .filter((c) => c.depth !== null);
    if (!cands.length) return empty;
    const ids = cands.map((c) => c.id as string);
    const rangeStart = istInstant(startDay, 0); const rangeEnd = istInstant(endDay, 0);
    const visits = (await tx.query(
      `SELECT inspector_id, lower(scheduled_window) AS s, upper(scheduled_window) AS e FROM inspection_visits WHERE inspector_id = ANY($1::uuid[]) AND status IN ('SCHEDULED','IN_PROGRESS') AND scheduled_window && tstzrange($2::timestamptz,$3::timestamptz)`, [ids, rangeStart, rangeEnd])).rows as { inspector_id: string; s: Date; e: Date }[];
    const avail = (await tx.query(
      `SELECT inspector_id, kind, daily_capacity, lower(period) AS s, upper(period) AS e FROM inspector_availability WHERE inspector_id = ANY($1::uuid[]) AND period && tstzrange($2::timestamptz,$3::timestamptz)`, [ids, rangeStart, rangeEnd])).rows as { inspector_id: string; kind: string; daily_capacity: number | null; s: Date; e: Date }[];
    const stats = new Map<string, { done: number; ns: number }>();
    for (const r of (await tx.query(`SELECT inspector_id, count(*) FILTER (WHERE status='SUBMITTED')::int AS done, count(*) FILTER (WHERE status='NO_SHOW')::int AS ns FROM inspection_visits WHERE inspector_id = ANY($1::uuid[]) GROUP BY inspector_id`, [ids])).rows) stats.set(r.inspector_id, { done: r.done, ns: r.ns });
    let last: string | null = null;
    if (i.instrumentId) last = ((await tx.query(`SELECT v.inspector_id FROM inspection_visits v JOIN applications a ON a.id=v.application_id WHERE a.instrument_id=$1 AND v.status='SUBMITTED' ORDER BY v.created_at DESC LIMIT 1`, [i.instrumentId])).rows[0]?.inspector_id as string | undefined) ?? null;
    const holidays = await this.holidays(tx, i.areaId, startDay, endDay);

    // Days to try: owner's preferred days first (when given), then everything else in order.
    const all: string[] = []; for (let d = startDay; d < endDay; d = addDays(d, 1)) if (isWorkingDay(d, s, holidays)) all.push(d);
    const pf = i.preferred?.from; const pt = i.preferred?.to ?? pf;
    const preferred = pf ? all.filter((d) => d >= pf && d <= (pt as string)) : [];
    const order = [...preferred, ...all.filter((d) => !preferred.includes(d))];
    const slotsCache = new Map<string, Slot[]>(); const slots = (d: string) => { let x = slotsCache.get(d); if (!x) { x = slotsForDay(d, s); slotsCache.set(d, x); } return x; };
    const dayStart = (d: string) => istInstant(d, 0).getTime(); const dayEnd = (d: string) => istInstant(addDays(d, 1), 0).getTime();
    const avoid = new Set((i.avoid ?? []).map((a) => `${a.inspectorId}:${a.start}`));

    const freeSlot = (insp: { id: string; daily_capacity: number }, d: string): Slot | null => {
      const a = avail.filter((x) => x.inspector_id === insp.id && x.s.getTime() < dayEnd(d) && x.e.getTime() > dayStart(d));
      if (a.some((x) => x.kind === 'LEAVE' || x.kind === 'UNAVAILABLE')) return null;
      const cap = a.find((x) => x.kind === 'CAPACITY_OVERRIDE')?.daily_capacity ?? insp.daily_capacity;
      const mine = visits.filter((v) => v.inspector_id === insp.id && v.s.getTime() >= dayStart(d) && v.s.getTime() < dayEnd(d));
      if (mine.length >= cap) return null;
      return slots(d).find((sl) => !mine.some((v) => v.s < sl.end && v.e > sl.start) && !avoid.has(`${insp.id}:${sl.start.getTime()}`)) ?? null;
    };
    const horizonEnd = addDays(startDay, 7);
    const load = (insp: { id: string; daily_capacity: number }) => {
      const wd = all.filter((d) => d < horizonEnd).length || 1;
      const booked = visits.filter((v) => v.inspector_id === insp.id && v.s.getTime() < dayStart(horizonEnd)).length;
      return Math.min(1, booked / (insp.daily_capacity * wd));
    };

    for (const day of order) {
      const options: { insp: (typeof cands)[number]; slot: Slot; score: ScoreBreakdown; inputs: NonNullable<Plan['inputs']> }[] = [];
      for (const c of cands) {
        const slot = freeSlot(c, day); if (!slot) continue;
        const home = c.home_enc ? this.crypto.decJson<{ lat: number; lng: number }>(c.home_enc) : null;
        const km = home && i.premises ? haversineKm(home, i.premises) : null; const prox = [1, 0.75, 0.5, 0.25][c.depth as number] ?? 0; const lr = load(c);
        const st = stats.get(c.id) ?? { done: 0, ns: 0 };
        const score = scoreCandidate({ loadRatio: lr, distanceKm: km, areaProximity: prox, skillCount: c.skill_count, completedVisits: st.done, noShowVisits: st.ns, inspectedLastTime: last === c.id }, s.weights);
        options.push({ insp: c, slot, score, inputs: { distanceKm: km, loadRatio: Math.round(lr * 100) / 100, areaProximity: prox } });
      }
      if (!options.length) continue;
      options.sort((a, b) => b.score.total - a.score.total || String(a.insp.id).localeCompare(String(b.insp.id)));
      const best = options[0]!; const reasons: string[] = [];
      if (day > slaDeadline) reasons.push('OUTSIDE_SLA');
      if (best.score.total < s.autoThreshold) reasons.push('LOW_SCORE');
      if (pf && !preferred.includes(day)) reasons.push('OWNER_PREFERENCE_UNMET');
      return { inspectorId: best.insp.id, window: { start: best.slot.start, end: best.slot.end }, score: best.score, reasons, considered: cands.length, slaDeadline, inputs: best.inputs,
        runnersUp: options.slice(1, 4).map((o) => ({ inspectorId: o.insp.id as string, total: o.score.total })) };
    }
    return { ...empty, considered: cands.length };
  }

  /** Reasons that stop the engine from assigning on its own. OWNER_PREFERENCE_UNMET is only information. */
  static needsReview(p: Plan): boolean { return !p.inspectorId || p.reasons.some((r) => r === 'OUTSIDE_SLA' || r === 'LOW_SCORE' || r === 'NO_CANDIDATE'); }

  /**
   * Plan and act. AUTO: create the visit and move the case to SCHEDULED. REVIEW: store a proposal for an officer.
   * Runs as SYSTEM so it can see every inspector's calendar; the caller has already checked who may trigger it.
   */
  async schedule(tx: Tx, appId: string, now: Date, o: { avoid?: { inspectorId: string; start: number }[]; triggeredBy?: string | null } = {}): Promise<{ outcome: ScheduleOutcome; notes: Note[] }> {
    const a = (await tx.query(
      `SELECT a.id, a.application_no, a.status, a.area_id, a.business_id, a.instrument_id, a.rule_set_id, a.ready_at, a.not_before, a.preferred_window, a.applied_by, i.category_id, i.location_enc,
              to_char(lower(a.preferred_window) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS pf, to_char((upper(a.preferred_window) - interval '1 second') AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS pt,
              to_char(a.not_before,'YYYY-MM-DD') AS nb,
              COALESCE((SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='SCHEDULE'), 72) AS sla_hours,
              (SELECT owner_user_id FROM businesses WHERE id=a.business_id) AS owner_id
       FROM applications a JOIN instruments i ON i.id=a.instrument_id WHERE a.id=$1`, [appId])).rows[0];
    if (!a) throw notFound();
    if (a.status !== 'DOCUMENT_CHECKED' && a.status !== 'FAILED_ATTEMPT') throw conflict('ILLEGAL_TRANSITION', { from: a.status, action: 'assign' });
    const premises = a.location_enc ? this.crypto.decJson<{ lat: number; lng: number }>(a.location_enc) : null;
    const input: PlanInput = { areaId: a.area_id, categoryId: a.category_id, instrumentId: a.instrument_id, premises, readyAt: a.ready_at ?? now, slaHours: a.sla_hours, now, notBefore: a.nb, preferred: a.pf ? { from: a.pf, to: a.pt } : null, avoid: o.avoid };
    const notes: Note[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const plan = await this.plan(tx, input);
      const review = SchedulingService.needsReview(plan);
      if (!review && plan.inspectorId && plan.window) {
        await tx.query('SAVEPOINT sched');
        try {
          const visitId = await this.createVisit(tx, { appId, inspectorId: plan.inspectorId, start: plan.window.start, end: plan.window.end, breakdown: this.explain(plan, 'AUTO'), assignedBy: null, outOfJurisdiction: false, actor: 'SYSTEM', actorId: null, mode: 'AUTO', remark: `Auto-assigned (score ${plan.score!.total})`, triggeredBy: o.triggeredBy ?? null });
          await tx.query('RELEASE SAVEPOINT sched');
          notes.push(...this.visitNotes(a.application_no, a.owner_id, plan.inspectorId, plan.window.start, plan.window.end, appId, 'VISIT_SCHEDULED'));
          return { outcome: { mode: 'AUTO', visitId, inspectorId: plan.inspectorId, start: plan.window.start, end: plan.window.end }, notes };
        } catch (e) {
          await tx.query('ROLLBACK TO SAVEPOINT sched'); if (!isExclusionViolation(e)) throw e; // someone took the slot a moment ago: plan again
          input.avoid = [...(input.avoid ?? []), { inspectorId: plan.inspectorId, start: plan.window.start.getTime() }]; continue;
        }
      }
      await tx.query(`UPDATE schedule_proposals SET status='SUPERSEDED' WHERE application_id=$1 AND status='PENDING'`, [appId]);
      const pr = (await tx.query(
        `INSERT INTO schedule_proposals (application_id, inspector_id, proposed_window, score_breakdown, reasons) VALUES ($1,$2, CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE tstzrange($3::timestamptz,$4::timestamptz,'[)') END,$5,$6) RETURNING id`,
        [appId, plan.inspectorId, plan.window?.start ?? null, plan.window?.end ?? null, JSON.stringify(this.explain(plan, 'REVIEW')), plan.reasons])).rows[0];
      await tx.query(`UPDATE applications SET schedule_mode='REVIEW', updated_at=now() WHERE id=$1`, [appId]);
      await this.state.note(tx, appId, 'schedule.review_needed', null, `Needs an officer to confirm: ${plan.reasons.join(', ')}`, a.status);
      await this.audit.record(tx, { action: 'schedule.review_needed', entityType: 'application', entityId: appId, areaId: a.area_id, actorId: null, actorRole: 'SYSTEM', details: { reasons: plan.reasons, triggeredBy: o.triggeredBy ?? null } });
      notes.push(() => this.notif.notifyOfficersInArea(a.area_id, 'SCHEDULE_REVIEW_NEEDED', { appNo: a.application_no }, `/officer/cases/${appId}`));
      return { outcome: { mode: 'REVIEW', proposalId: pr.id, reasons: plan.reasons }, notes };
    }
    throw conflict('SLOT_CONTENTION'); // four collisions in a row: ask the caller to retry
  }

  private explain(p: Plan, mode: 'AUTO' | 'REVIEW') {
    return { mode, total: p.score?.total ?? null, parts: p.score?.parts ?? null, inputs: p.inputs, candidatesConsidered: p.considered, runnersUp: p.runnersUp, reasons: p.reasons, slaDeadline: p.slaDeadline };
  }

  /** Creates the visit row and moves the case to SCHEDULED. Shared by the engine and by officer assignment. */
  async createVisit(tx: Tx, v: { appId: string; inspectorId: string; start: Date; end: Date; breakdown: object | null; assignedBy: string | null; outOfJurisdiction: boolean; actor: 'SYSTEM' | 'OFFICER' | 'SENIOR_OFFICER'; actorId: string | null; mode: 'AUTO' | 'REVIEW'; remark: string; triggeredBy?: string | null }): Promise<string> {
    const r = (await tx.query(
      `INSERT INTO inspection_visits (application_id, inspector_id, scheduled_window, score_breakdown, assigned_by, out_of_jurisdiction) VALUES ($1,$2,tstzrange($3::timestamptz,$4::timestamptz,'[)'),$5,$6,$7) RETURNING id`,
      [v.appId, v.inspectorId, v.start, v.end, v.breakdown ? JSON.stringify(v.breakdown) : null, v.assignedBy, v.outOfJurisdiction])).rows[0];
    await tx.query(`UPDATE schedule_proposals SET status='ACCEPTED' WHERE application_id=$1 AND status='PENDING'`, [v.appId]);
    await this.state.transition(tx, v.appId, 'assign', v.actor, v.actorId, v.remark, { set: 'schedule_mode=$3::schedule_mode', params: [v.mode] });
    await this.audit.record(tx, { action: 'visit.scheduled', entityType: 'inspection_visit', entityId: r.id, actorId: v.actorId, actorRole: v.actor, details: { mode: v.mode, outOfJurisdiction: v.outOfJurisdiction, triggeredBy: v.triggeredBy ?? null } });
    return r.id as string;
  }

  visitNotes(appNo: string, ownerId: string | null, inspectorId: string, start: Date, end: Date, appId: string, event: 'VISIT_SCHEDULED' | 'VISIT_RESCHEDULED'): Note[] {
    const when = fmtWindow(start, end); const out: Note[] = [];
    if (ownerId) out.push(() => this.notif.notifyUser(ownerId, event, { appNo, when }, `/owner/applications/${appId}`));
    out.push(() => this.notif.notifyUser(inspectorId, 'VISIT_ASSIGNED', { appNo, when }, '/inspector/dashboard'));
    return out;
  }

  /** Convenience for callers that start from a request, not an open transaction. */
  async scheduleNow(appId: string, now: Date, o: { avoid?: { inspectorId: string; start: number }[]; triggeredBy?: string | null } = {}): Promise<ScheduleOutcome> {
    const { outcome, notes } = await this.db.system((tx) => this.schedule(tx, appId, now, o));
    await runNotes(notes); return outcome;
  }
}
