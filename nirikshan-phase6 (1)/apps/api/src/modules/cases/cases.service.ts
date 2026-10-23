import { Injectable } from '@nestjs/common';
import { addDays, documentCheckBlockers, istDay, istInstant, slaState, type DocState } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { SchedulingService, fmtWindow, type ScheduleOutcome } from '../scheduling/scheduling.service';
import { ApplicationsService } from '../applications/applications.service';
import { CaseStateService } from '../applications/case-state.service';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { isExclusionViolation, runNotes, type Note } from '../../common/pg';
import type { SessionUser } from '../../common/request-context';

type Officer = 'OFFICER' | 'SENIOR_OFFICER';
const OPEN_VISIT = `('SCHEDULED','IN_PROGRESS')`;
const CLOCKED = ['APPLIED', 'DOCUMENT_CHECKED', 'FAILED_ATTEMPT'];

@Injectable()
export class CasesService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notif: NotificationService, private sched: SchedulingService,
    private apps: ApplicationsService, private state: CaseStateService) {}
  private actor(u: SessionUser): Officer { return u.role as Officer; }

  // ------------------------------------------------------------------ queue
  /** Which clock a case is on: document check runs from the application, scheduling from the moment the case became ready. */
  private clock(r: { status: string; created_at: Date; ready_at: Date | null; doc_hours: number | null; sched_hours: number | null }) {
    if (r.status === 'APPLIED') return { step: 'DOCUMENT_CHECK', startedAt: r.created_at, hours: r.doc_hours ?? 24 };
    if (r.status === 'DOCUMENT_CHECKED' || r.status === 'FAILED_ATTEMPT') return { step: 'SCHEDULE', startedAt: r.ready_at ?? r.created_at, hours: r.sched_hours ?? 72 };
    return null;
  }

  /**
   * Case list. Paging and totals are done in the database so a large registry stays fast and no case is hidden behind an arbitrary cap.
   * The "overdue / at risk" filter depends on the clock rules above, so it only looks at the few statuses that have a clock, then filters here.
   */
  async list(user: SessionUser, q: { status?: string; q?: string; sla?: 'OVERDUE' | 'AT_RISK'; cursor?: string; limit: number }, now = new Date()) {
    let statuses = q.status ? q.status.split(',').filter(Boolean) : null; const off = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) || 0 : 0;
    if (q.sla) statuses = statuses ? statuses.filter((x) => CLOCKED.includes(x)) : [...CLOCKED];
    const where = `WHERE ($1::text[] IS NULL OR a.status::text = ANY($1)) AND ($2::text IS NULL OR a.application_no ILIKE '%' || $2 || '%')`;
    const select = (paging: string) => `SELECT a.id, a.application_no, a.status, a.type, a.created_at, a.ready_at, a.schedule_mode, to_char(a.due_date,'YYYY-MM-DD') AS due, a.failed_attempts, i.instrument_no, c.name_en AS category, ar.name_en AS area_name,
              (SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='DOCUMENT_CHECK') AS doc_hours,
              (SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='SCHEDULE') AS sched_hours,
              EXISTS (SELECT 1 FROM schedule_proposals p WHERE p.application_id=a.id AND p.status='PENDING') AS has_proposal,
              EXISTS (SELECT 1 FROM reschedule_requests r WHERE r.application_id=a.id AND r.status='OPEN') AS has_request,
              (SELECT lower(v.scheduled_window) FROM inspection_visits v WHERE v.application_id=a.id AND v.status IN ${OPEN_VISIT} ORDER BY v.created_at DESC LIMIT 1) AS visit_at
       FROM (SELECT * FROM applications a ${where} ORDER BY a.created_at, a.id ${paging}) a
       JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas ar ON ar.id=a.area_id
       ORDER BY a.created_at, a.id`;
    const { rows, total } = await this.db.forUser(async (tx) => {
      if (q.sla) return { rows: (await tx.query(select('LIMIT 2000'), [statuses, q.q ?? null])).rows, total: 0 };
      const rows = (await tx.query(select('LIMIT $3 OFFSET $4'), [statuses, q.q ?? null, q.limit, off])).rows;
      const total = Number((await tx.query(`SELECT count(*)::int AS n FROM applications a ${where}`, [statuses, q.q ?? null])).rows[0].n);
      return { rows, total };
    });
    let items = rows.map((r) => {
      const ck = this.clock(r); const sla = ck ? slaState(ck.startedAt, ck.hours, now) : null;
      return { id: r.id as string, applicationNo: r.application_no as string, status: r.status as string, type: r.type as string, dueDate: r.due as string | null, createdAt: r.created_at as Date,
        instrument: { instrumentNo: r.instrument_no as string, category: r.category as string }, area: r.area_name as string, scheduleMode: r.schedule_mode as string | null, failedAttempts: r.failed_attempts as number,
        needsReview: r.has_proposal as boolean, rescheduleRequested: r.has_request as boolean, visitAt: (r.visit_at as Date | null) ?? null,
        sla: ck && sla ? { step: ck.step, dueAt: sla.dueAt, state: sla.state } : null };
    });
    if (q.sla) {
      items = items.filter((i) => i.sla?.state === q.sla || (q.sla === 'AT_RISK' && i.sla?.state === 'OVERDUE'));
      const page = items.slice(off, off + q.limit);
      return { items: page, total: items.length, nextCursor: off + q.limit < items.length ? Buffer.from(String(off + q.limit)).toString('base64url') : null };
    }
    return { items, total, nextCursor: off + q.limit < total ? Buffer.from(String(off + q.limit)).toString('base64url') : null };
  }

  /** Queue counts for the dashboard: totals by status come from one grouped query; deadlines only look at cases that have a clock. */
  async summary(user: SessionUser, now = new Date()) {
    const { by, clocked, review, resched } = await this.db.forUser(async (tx) => ({
      by: (await tx.query(`SELECT status::text AS status, count(*)::int AS n FROM applications GROUP BY status`)).rows,
      clocked: (await tx.query(`SELECT a.status::text AS status, a.created_at, a.ready_at,
          (SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='DOCUMENT_CHECK') AS doc_hours,
          (SELECT max_hours FROM workflow_slas w WHERE w.rule_set_id=a.rule_set_id AND w.step='SCHEDULE') AS sched_hours
        FROM applications a WHERE a.status::text = ANY($1)`, [CLOCKED])).rows,
      review: Number((await tx.query(`SELECT count(DISTINCT p.application_id)::int AS n FROM schedule_proposals p JOIN applications a ON a.id=p.application_id WHERE p.status='PENDING'`)).rows[0].n),
      resched: Number((await tx.query(`SELECT count(DISTINCT r.application_id)::int AS n FROM reschedule_requests r JOIN applications a ON a.id=r.application_id WHERE r.status='OPEN'`)).rows[0].n),
    }));
    const counts: Record<string, number> = {}; for (const r of by) counts[r.status as string] = r.n as number;
    let overdue = 0; let atRisk = 0;
    for (const r of clocked) { const ck = this.clock(r); if (!ck) continue; const st = slaState(ck.startedAt, ck.hours, now).state; if (st === 'OVERDUE') overdue++; else if (st === 'AT_RISK') atRisk++; }
    return { counts, overdue, atRisk, needsReview: review, rescheduleRequests: resched };
  }

  detail(user: SessionUser, id: string) { return this.db.forUser((tx) => this.apps.detail(tx, id, 'STAFF')); }

  // ------------------------------------------------------------------ document check
  async reviewDocument(user: SessionUser, appId: string, docId: string, input: { status: 'ACCEPTED' | 'FLAGGED'; comment?: string; reasonCode?: string }) {
    const notes: Note[] = [];
    const out = await this.db.forUser(async (tx) => {
      const app = await this.state.lock(tx, appId);
      if (app.status !== 'APPLIED') throw conflict('DOCUMENTS_LOCKED');
      const d = (await tx.query('SELECT id, scan, superseded FROM application_documents WHERE id=$1 AND application_id=$2 FOR UPDATE', [docId, appId])).rows[0];
      if (!d) throw notFound();
      if (d.superseded) throw conflict('DOCUMENT_SUPERSEDED');
      if (d.scan !== 'CLEAN') throw conflict('DOCUMENT_NOT_SCANNED');
      await tx.query(`UPDATE application_documents SET review=$2::doc_review_status, review_comment=$3, reason_code=$4, reviewed_by=$5, reviewed_at=now() WHERE id=$1`,
        [docId, input.status, input.status === 'FLAGGED' ? input.comment ?? null : null, input.status === 'FLAGGED' ? input.reasonCode ?? null : null, user.userId]);
      await this.state.note(tx, appId, input.status === 'FLAGGED' ? 'document.flagged' : 'document.accepted', user.userId, input.comment ?? input.reasonCode ?? 'Accepted', app.status);
      await this.audit.record(tx, { action: `document.${input.status.toLowerCase()}`, entityType: 'application_document', entityId: docId, areaId: app.area_id, details: { reasonCode: input.reasonCode ?? null } });
      if (input.status === 'FLAGGED') notes.push(() => this.notifyOwner(appId, 'DOCUMENTS_FLAGGED', { appNo: app.application_no }));
      return { ok: true };
    });
    await runNotes(notes); return out;
  }

  private async ownerOf(appId: string): Promise<string | null> {
    return this.db.system(async (tx) => ((await tx.query('SELECT b.owner_user_id FROM applications a JOIN businesses b ON b.id=a.business_id WHERE a.id=$1', [appId])).rows[0]?.owner_user_id as string | undefined) ?? null);
  }
  private async notifyOwner(appId: string, event: string, vars: Record<string, string>) {
    const id = await this.ownerOf(appId); if (id) await this.notif.notifyUser(id, event, vars, `/owner/applications/${appId}`);
  }

  /** All required documents present, scanned clean and accepted -> case becomes DOCUMENT_CHECKED and the engine runs. */
  async documentCheckComplete(user: SessionUser, appId: string, now = new Date()): Promise<{ status: string; scheduling: ScheduleOutcome | { mode: 'ERROR' } }> {
    const notes: Note[] = [];
    await this.db.forUser(async (tx) => {
      const app = await this.state.lock(tx, appId);
      const req = (await tx.query(`SELECT d.id FROM applications a JOIN document_types d ON a.type = ANY(d.required_for) WHERE a.id=$1`, [appId])).rows.map((r) => r.id as string);
      const cur = (await tx.query('SELECT document_type_id, scan, review FROM application_documents WHERE application_id=$1 AND NOT superseded', [appId])).rows
        .map((r) => ({ typeId: r.document_type_id, scan: r.scan, review: r.review }) as DocState);
      const blockers = documentCheckBlockers(req, cur);
      if (app.status === 'APPLIED' && blockers.length) throw unprocessable('DOCUMENTS_INCOMPLETE', { blockers });
      await this.state.transition(tx, appId, 'documentCheckComplete', this.actor(user), user.userId, undefined, { set: 'doc_checked_at=now(), doc_checked_by=$3', params: [user.userId] });
      notes.push(() => this.notifyOwner(appId, 'DOCUMENTS_CHECKED', { appNo: app.application_no }));
    });
    await runNotes(notes);
    return { status: 'DOCUMENT_CHECKED', scheduling: await this.runEngine(appId, now, user.userId) };
  }

  private async runEngine(appId: string, now: Date, by: string, avoid?: { inspectorId: string; start: number }[]): Promise<ScheduleOutcome | { mode: 'ERROR' }> {
    try { return await this.sched.scheduleNow(appId, now, { triggeredBy: by, avoid }); } catch { return { mode: 'ERROR' }; }
  }
  /** Officer asks the engine to try again (for example after an inspector's leave was entered). */
  async rerun(user: SessionUser, appId: string, now = new Date()) {
    await this.db.forUser((tx) => this.state.lock(tx, appId)); // scope check
    return this.runEngine(appId, now, user.userId);
  }

  // ------------------------------------------------------------------ assignment
  /** Read-only checks done with system rights (the officer cannot see other areas' inspector rows). Returns whether the assignment leaves the officer's own jurisdiction. */
  private async checkAssignment(areaId: string, categoryId: string, inspectorId: string, start: Date, end: Date, reason: string | undefined, now: Date): Promise<{ outOfJurisdiction: boolean }> {
    if (!(end > start) || end.getTime() - start.getTime() > 8 * 3_600_000) throw unprocessable('INVALID_WINDOW');
    if (istDay(start) !== istDay(new Date(end.getTime() - 1))) throw unprocessable('WINDOW_MUST_BE_ONE_DAY');
    if (start <= now) throw unprocessable('WINDOW_IN_PAST');
    return this.db.system(async (tx) => {
      const insp = (await tx.query(
        `SELECT p.active, EXISTS (SELECT 1 FROM inspector_skills k WHERE k.inspector_id=p.user_id AND k.category_id=$2 AND (k.certified_until IS NULL OR k.certified_until >= $3::date)) AS skilled,
                EXISTS (WITH RECURSIVE up AS (SELECT id, parent_id FROM areas WHERE id=$4 UNION SELECT a.id, a.parent_id FROM areas a JOIN up ON a.id=up.parent_id)
                        SELECT 1 FROM user_area_scopes s WHERE s.user_id=p.user_id AND s.area_id IN (SELECT id FROM up)) AS in_area
         FROM inspector_profiles p JOIN users u ON u.id=p.user_id AND u.account_status='ACTIVE' WHERE p.user_id=$1`, [inspectorId, categoryId, istDay(start), areaId])).rows[0];
      if (!insp || !insp.active) throw unprocessable('INSPECTOR_NOT_AVAILABLE');
      if (!insp.skilled) throw unprocessable('NO_SKILL'); // an uncertified inspector can never be assigned, reason or not
      const out = !insp.in_area;
      if (out && !reason) throw unprocessable('OUT_OF_JURISDICTION_REASON_REQUIRED');
      const hol = await this.sched.holidays(tx, areaId, istDay(start), istDay(start));
      if (hol.has(istDay(start))) throw unprocessable('HOLIDAY');
      const away = await tx.query(`SELECT 1 FROM inspector_availability WHERE inspector_id=$1 AND kind IN ('LEAVE','UNAVAILABLE') AND period && tstzrange($2::timestamptz,$3::timestamptz)`, [inspectorId, start, end]);
      if (away.rowCount) throw conflict('INSPECTOR_UNAVAILABLE');
      return { outOfJurisdiction: out };
    });
  }

  private async assignTx(tx: Tx, user: SessionUser, appId: string, a: { inspectorId: string; start: Date; end: Date; outOfJurisdiction: boolean; reason?: string; remark: string; breakdown?: object | null }, notes: Note[]) {
    const app = await this.state.lock(tx, appId);
    const own = (await tx.query('SELECT b.owner_user_id FROM businesses b WHERE b.id=$1', [app.business_id])).rows[0]?.owner_user_id as string | undefined;
    await tx.query('SAVEPOINT assign');
    try {
      const visitId = await this.sched.createVisit(tx, { appId, inspectorId: a.inspectorId, start: a.start, end: a.end, breakdown: a.breakdown ?? { mode: 'MANUAL' }, assignedBy: user.userId, outOfJurisdiction: a.outOfJurisdiction, actor: this.actor(user), actorId: user.userId, mode: 'REVIEW', remark: a.remark });
      await tx.query('RELEASE SAVEPOINT assign');
      if (a.outOfJurisdiction) await this.audit.record(tx, { action: 'visit.out_of_jurisdiction', entityType: 'inspection_visit', entityId: visitId, areaId: app.area_id, details: { reason: a.reason } });
      return { visitId, appNo: app.application_no, ownerId: own ?? null, notes };
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT assign'); if (isExclusionViolation(e)) throw conflict('SLOT_TAKEN'); throw e;
    }
  }

  async assign(user: SessionUser, appId: string, input: { inspectorId: string; windowStart: string; windowEnd: string; outOfJurisdictionReason?: string }, now = new Date()) {
    const start = new Date(input.windowStart); const end = new Date(input.windowEnd);
    const meta = await this.db.forUser(async (tx) => { const app = await this.state.lock(tx, appId); const i = (await tx.query('SELECT category_id FROM instruments WHERE id=$1', [app.instrument_id])).rows[0]; return { areaId: app.area_id, categoryId: i.category_id as string }; });
    const chk = await this.checkAssignment(meta.areaId, meta.categoryId, input.inspectorId, start, end, input.outOfJurisdictionReason, now);
    const notes: Note[] = [];
    const r = await this.db.forUser(async (tx) => {
      const x = await this.assignTx(tx, user, appId, { inspectorId: input.inspectorId, start, end, outOfJurisdiction: chk.outOfJurisdiction, reason: input.outOfJurisdictionReason, remark: 'Assigned by officer' }, notes);
      notes.push(...this.sched.visitNotes(x.appNo, x.ownerId, input.inspectorId, start, end, appId, 'VISIT_SCHEDULED'));
      return { visitId: x.visitId };
    });
    await runNotes(notes); return r;
  }

  /** Officer accepts the engine's proposal as it stands (it is re-checked, because the world may have moved since). */
  async acceptProposal(user: SessionUser, appId: string, now = new Date()) {
    const p = await this.db.forUser(async (tx) => (await tx.query(`SELECT inspector_id, lower(proposed_window) AS s, upper(proposed_window) AS e FROM schedule_proposals WHERE application_id=$1 AND status='PENDING'`, [appId])).rows[0]);
    if (!p || !p.inspector_id || !p.s) throw conflict('NO_PROPOSAL');
    return this.assign(user, appId, { inspectorId: p.inspector_id, windowStart: p.s.toISOString(), windowEnd: p.e.toISOString() }, now);
  }

  // ------------------------------------------------------------------ rescheduling
  /** Frees the current visit and returns the case to the queue. Runs inside the caller's transaction. */
  private async releaseVisit(tx: Tx, user: SessionUser | null, appId: string, reason: string, notBefore?: string): Promise<{ inspectorId: string; start: number } | null> {
    const v = (await tx.query(`SELECT id, inspector_id, lower(scheduled_window) AS s FROM inspection_visits WHERE application_id=$1 AND status='SCHEDULED' FOR UPDATE`, [appId])).rows[0];
    if (!v) throw conflict('NO_OPEN_VISIT');
    await tx.query(`UPDATE inspection_visits SET status='SUPERSEDED', version=version+1 WHERE id=$1`, [v.id]);
    await this.state.transition(tx, appId, 'reschedule', user ? this.actor(user) : 'SYSTEM', user?.userId ?? null, reason, notBefore ? { set: 'not_before=$3::date', params: [notBefore] } : undefined);
    return { inspectorId: v.inspector_id as string, start: (v.s as Date).getTime() };
  }

  async rescheduleVisit(user: SessionUser, appId: string, input: { reason: string; inspectorId?: string; windowStart?: string; windowEnd?: string; outOfJurisdictionReason?: string }, now = new Date()) {
    const notes: Note[] = []; let freed: { inspectorId: string; start: number } | null = null; 
    if (input.windowStart && input.windowEnd) {
      const start = new Date(input.windowStart); const end = new Date(input.windowEnd);
      const meta = await this.db.forUser(async (tx) => { const app = await this.state.lock(tx, appId); const i = (await tx.query('SELECT category_id FROM instruments WHERE id=$1', [app.instrument_id])).rows[0]; const cur = (await tx.query(`SELECT inspector_id FROM inspection_visits WHERE application_id=$1 AND status='SCHEDULED'`, [appId])).rows[0]; return { areaId: app.area_id, categoryId: i.category_id as string, current: cur?.inspector_id as string | undefined }; });
      const inspectorId = input.inspectorId ?? meta.current; if (!inspectorId) throw conflict('NO_OPEN_VISIT');
      const chk = await this.checkAssignment(meta.areaId, meta.categoryId, inspectorId, start, end, input.outOfJurisdictionReason, now);
      await this.db.forUser(async (tx) => {
        freed = await this.releaseVisit(tx, user, appId, input.reason);
        const x = await this.assignTx(tx, user, appId, { inspectorId, start, end, outOfJurisdiction: chk.outOfJurisdiction, reason: input.outOfJurisdictionReason, remark: `Rescheduled: ${input.reason}` }, notes);
        await tx.query(`UPDATE reschedule_requests SET status='APPROVED', decided_by=$2, decided_at=now() WHERE application_id=$1 AND status='OPEN'`, [appId, user.userId]);
        notes.push(...this.sched.visitNotes(x.appNo, x.ownerId, inspectorId, start, end, appId, 'VISIT_RESCHEDULED'));
      });
      await runNotes(notes); return { mode: 'MANUAL' as const, inspectorId, start, end };
    }
    await this.db.forUser(async (tx) => {
      freed = await this.releaseVisit(tx, user, appId, input.reason);
      await tx.query(`UPDATE reschedule_requests SET status='CLOSED' WHERE application_id=$1 AND status='OPEN'`, [appId]);
    });
    const out = await this.runEngine(appId, now, user.userId, freed ? [freed] : undefined);
    if (out.mode === 'AUTO') await runNotes(await this.rescheduleNotes(appId, out.start, out.end, out.inspectorId));
    return out;
  }
  private async rescheduleNotes(appId: string, start: Date, end: Date, inspectorId: string): Promise<Note[]> {
    const r = await this.db.system(async (tx) => (await tx.query('SELECT a.application_no, b.owner_user_id FROM applications a JOIN businesses b ON b.id=a.business_id WHERE a.id=$1', [appId])).rows[0]);
    return this.sched.visitNotes(r.application_no, r.owner_user_id, inspectorId, start, end, appId, 'VISIT_RESCHEDULED');
  }

  async decideRequest(user: SessionUser, appId: string, input: { outcome: 'APPROVED' | 'REJECTED'; reason?: string }, now = new Date()) {
    const req = await this.db.forUser(async (tx) => (await tx.query(`SELECT id, reason, to_char(preferred_from,'YYYY-MM-DD') AS pf, to_char(preferred_to,'YYYY-MM-DD') AS pt FROM reschedule_requests WHERE application_id=$1 AND status='OPEN'`, [appId])).rows[0]);
    if (!req) throw conflict('NO_OPEN_REQUEST');
    if (input.outcome === 'REJECTED') {
      await this.db.forUser(async (tx) => {
        await tx.query(`UPDATE reschedule_requests SET status='REJECTED', decided_by=$2, decision_note=$3, decided_at=now() WHERE id=$1`, [req.id, user.userId, input.reason]);
        const app = await this.state.lock(tx, appId);
        await this.state.note(tx, appId, 'reschedule.rejected', user.userId, input.reason!, app.status);
        await this.audit.record(tx, { action: 'reschedule.rejected', entityType: 'application', entityId: appId, areaId: app.area_id });
      });
      const no = (await this.db.system(async (tx) => (await tx.query('SELECT application_no FROM applications WHERE id=$1', [appId])).rows[0].application_no)) as string;
      await runNotes([() => this.notifyOwner(appId, 'RESCHEDULE_DECIDED', { appNo: no, outcome: 'declined' })]);
      return { outcome: 'REJECTED' as const };
    }
    // Approved: free the visit and let the engine find a slot, trying the owner's preferred days first.
    let freed: { inspectorId: string; start: number } | null = null;
    await this.db.forUser(async (tx) => {
      freed = await this.releaseVisit(tx, user, appId, `Owner request: ${req.reason}`);
      await tx.query(`UPDATE reschedule_requests SET status='APPROVED', decided_by=$2, decided_at=now() WHERE id=$1`, [req.id, user.userId]);
      await tx.query(`UPDATE applications SET preferred_window = tstzrange($2::timestamptz,$3::timestamptz,'[)') WHERE id=$1`, [appId, istInstant(req.pf, 0), istInstant(addDays(req.pt ?? req.pf, 1), 0)]);
      await tx.query(`UPDATE applications SET not_before=$2::date WHERE id=$1`, [appId, req.pf]);
    });
    const out = await this.runEngine(appId, now, user.userId, freed ? [freed] : undefined);
    const appNo = (await this.db.system(async (tx) => (await tx.query('SELECT application_no FROM applications WHERE id=$1', [appId])).rows[0].application_no)) as string;
    await runNotes([() => this.notifyOwner(appId, 'RESCHEDULE_DECIDED', { appNo, outcome: 'approved' })]);
    if (out.mode === 'AUTO') await runNotes(await this.rescheduleNotes(appId, out.start, out.end, out.inspectorId));
    return { outcome: 'APPROVED' as const, scheduling: out };
  }

  // ------------------------------------------------------------------ bulk reschedule (holiday declared, strike, weather)
  async bulkPreview(user: SessionUser, input: { areaId: string; date: string }) {
    if (!user.areaIds.includes(input.areaId)) throw forbidden('AREA_OUT_OF_SCOPE');
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `WITH RECURSIVE sub AS (SELECT id FROM areas WHERE id=$1 UNION SELECT a.id FROM areas a JOIN sub ON a.parent_id=sub.id)
       SELECT v.id AS visit_id, a.id, a.application_no, lower(v.scheduled_window) AS s, u.display_name_masked AS inspector
       FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN users u ON u.id=v.inspector_id
       WHERE a.area_id IN (SELECT id FROM sub) AND v.status='SCHEDULED' AND v.scheduled_window && tstzrange($2::timestamptz,$3::timestamptz) ORDER BY v.scheduled_window`,
      [input.areaId, istInstant(input.date, 0), istInstant(addDays(input.date, 1), 0)])).rows);
    return { count: rows.length, items: rows.map((r) => ({ applicationId: r.id, applicationNo: r.application_no, start: r.s, inspector: r.inspector })) };
  }

  async bulkCommit(user: SessionUser, input: { areaId: string; date: string; reason: string; notBefore?: string }, now = new Date()) {
    const pv = await this.bulkPreview(user, input);
    const notBefore = input.notBefore ?? addDays(input.date, 1); let moved = 0; const results: { applicationId: string; mode: string }[] = [];
    for (const it of pv.items) {
      let freed: { inspectorId: string; start: number } | null = null;
      try {
        await this.db.forUser(async (tx) => {
          freed = await this.releaseVisit(tx, user, it.applicationId, input.reason, notBefore);
          await tx.query(`UPDATE reschedule_requests SET status='CLOSED' WHERE application_id=$1 AND status='OPEN'`, [it.applicationId]);
        });
      } catch { results.push({ applicationId: it.applicationId, mode: 'SKIPPED' }); continue; }
      moved++;
      const out = await this.runEngine(it.applicationId, now, user.userId, freed ? [freed] : undefined);
      if (out.mode === 'AUTO') await runNotes(await this.rescheduleNotes(it.applicationId, out.start, out.end, out.inspectorId));
      results.push({ applicationId: it.applicationId, mode: out.mode });
    }
    await this.db.forUser((tx) => this.audit.record(tx, { action: 'schedule.bulk_reschedule', entityType: 'area', entityId: input.areaId, areaId: input.areaId, details: { date: input.date, moved, reason: input.reason } }));
    return { moved, results };
  }

  // ------------------------------------------------------------------ no-show
  async noShow(user: SessionUser, appId: string, note: string | undefined, now = new Date()) {
    const notes: Note[] = []; let exhausted = false; let freed: { inspectorId: string; start: number } | null = null;
    const max = await this.db.system((tx) => this.sched.settings(tx)).then((s) => s.maxFailedAttempts);
    await this.db.forUser(async (tx) => {
      const v = (await tx.query(`SELECT id, inspector_id, lower(scheduled_window) AS s FROM inspection_visits WHERE application_id=$1 AND status='SCHEDULED' FOR UPDATE`, [appId])).rows[0];
      if (!v) throw conflict('NO_OPEN_VISIT');
      await tx.query(`UPDATE inspection_visits SET status='NO_SHOW', version=version+1 WHERE id=$1`, [v.id]);
      freed = { inspectorId: v.inspector_id, start: (v.s as Date).getTime() };
      const t = await this.state.transition(tx, appId, 'noShow', this.actor(user), user.userId, note, { set: 'failed_attempts = failed_attempts + 1' });
      const n = (await tx.query('SELECT failed_attempts FROM applications WHERE id=$1', [appId])).rows[0].failed_attempts as number;
      exhausted = n >= max;
      if (exhausted) notes.push(() => this.notif.notifyOfficersInArea(t.row.area_id, 'ATTEMPTS_EXHAUSTED', { appNo: t.row.application_no }, `/officer/cases/${appId}`));
      else notes.push(() => this.notifyOwner(appId, 'VISIT_NOSHOW', { appNo: t.row.application_no }));
    });
    await runNotes(notes);
    if (exhausted) return { status: 'FAILED_ATTEMPT', attemptsExhausted: true };
    const out = await this.runEngine(appId, now, user.userId, freed ? [freed] : undefined);
    if (out.mode === 'AUTO') await runNotes(await this.rescheduleNotes(appId, out.start, out.end, out.inspectorId));
    return { status: 'FAILED_ATTEMPT', attemptsExhausted: false, scheduling: out };
  }

  // ------------------------------------------------------------------ calendar and inspectors
  async calendar(user: SessionUser, from: string, to: string) {
    const [visits, leave, hol] = await Promise.all([
      this.db.forUser(async (tx) => (await tx.query(
        `SELECT v.id, v.status, v.application_id, a.application_no, v.inspector_id, u.display_name_masked AS inspector, lower(v.scheduled_window) AS s, upper(v.scheduled_window) AS e, a.schedule_mode, v.out_of_jurisdiction, c.name_en AS category
         FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN users u ON u.id=v.inspector_id JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id
         WHERE v.status IN ('SCHEDULED','IN_PROGRESS','SUBMITTED') AND v.scheduled_window && tstzrange($1::timestamptz,$2::timestamptz) ORDER BY v.scheduled_window`, [istInstant(from, 0), istInstant(addDays(to, 1), 0)])).rows),
      this.db.forUser(async (tx) => (await tx.query(
        `SELECT av.id, av.inspector_id, av.kind, av.daily_capacity, av.reason, lower(av.period) AS s, upper(av.period) AS e FROM inspector_availability av WHERE av.period && tstzrange($1::timestamptz,$2::timestamptz)`, [istInstant(from, 0), istInstant(addDays(to, 1), 0)])).rows),
      this.db.system(async (tx) => (await tx.query(`SELECT to_char(holiday_date,'YYYY-MM-DD') AS d, name FROM holiday_calendar WHERE holiday_date BETWEEN $1::date AND $2::date ORDER BY holiday_date`, [from, to])).rows),
    ]);
    void user;
    return {
      visits: visits.map((r) => ({ id: r.id, status: r.status, applicationId: r.application_id, applicationNo: r.application_no, inspectorId: r.inspector_id, inspector: r.inspector, start: r.s, end: r.e, mode: r.schedule_mode, outOfJurisdiction: r.out_of_jurisdiction, category: r.category })),
      availability: leave.map((r) => ({ id: r.id, inspectorId: r.inspector_id, kind: r.kind, dailyCapacity: r.daily_capacity, reason: r.reason, start: r.s, end: r.e })),
      holidays: hol,
    };
  }

  async inspectors(user: SessionUser, now = new Date()) {
    const rows = await this.db.system(async (tx) => (await tx.query(
      `SELECT u.id, u.display_name_masked, p.daily_capacity, p.active,
         (SELECT array_agg(c.name_en ORDER BY c.name_en) FROM inspector_skills k JOIN categories c ON c.id=k.category_id WHERE k.inspector_id=u.id AND (k.certified_until IS NULL OR k.certified_until >= $2::date)) AS skills,
         (SELECT count(*)::int FROM inspection_visits v WHERE v.inspector_id=u.id AND v.status='SCHEDULED' AND v.scheduled_window && tstzrange($3::timestamptz,$4::timestamptz)) AS today,
         (SELECT count(*)::int FROM inspection_visits v WHERE v.inspector_id=u.id AND v.status='SCHEDULED' AND lower(v.scheduled_window) >= $3::timestamptz AND lower(v.scheduled_window) < $5::timestamptz) AS next7
       FROM inspector_profiles p JOIN users u ON u.id=p.user_id
       WHERE EXISTS (SELECT 1 FROM user_area_scopes s WHERE s.user_id=u.id AND s.area_id = ANY($1::uuid[])) ORDER BY u.display_name_masked`,
      [user.areaIds, istDay(now), istInstant(istDay(now), 0), istInstant(addDays(istDay(now), 1), 0), istInstant(addDays(istDay(now), 7), 0)])).rows);
    return rows.map((r) => ({ id: r.id as string, name: r.display_name_masked as string, dailyCapacity: r.daily_capacity as number, active: r.active as boolean, skills: (r.skills as string[] | null) ?? [], today: r.today as number, next7Days: r.next7 as number }));
  }

  private async inspectorInScope(user: SessionUser, inspectorId: string) {
    const ok = await this.db.system(async (tx) => (await tx.query('SELECT 1 FROM user_area_scopes WHERE user_id=$1 AND area_id = ANY($2::uuid[])', [inspectorId, user.areaIds])).rowCount);
    if (!ok) throw notFound();
  }

  async addAvailability(user: SessionUser, inspectorId: string, input: { kind: 'LEAVE' | 'UNAVAILABLE' | 'CAPACITY_OVERRIDE'; from: string; to: string; dailyCapacity?: number; reason: string }, now = new Date()) {
    await this.inspectorInScope(user, inspectorId);
    const start = istInstant(input.from, 0); const end = istInstant(addDays(input.to, 1), 0);
    const id = await this.db.forUser(async (tx) => {
      const r = (await tx.query('INSERT INTO inspector_availability (inspector_id, period, kind, daily_capacity, reason) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), $4,$5,$6) RETURNING id',
        [inspectorId, start, end, input.kind, input.kind === 'CAPACITY_OVERRIDE' ? input.dailyCapacity : null, input.reason])).rows[0];
      await this.audit.record(tx, { action: 'inspector.availability_added', entityType: 'inspector', entityId: inspectorId, details: { kind: input.kind, from: input.from, to: input.to } });
      return r.id as string;
    });
    // Leave or unavailability hands existing visits back to the queue and lets the engine replace them.
    const affected: { applicationId: string; mode: string }[] = [];
    if (input.kind !== 'CAPACITY_OVERRIDE') {
      const vs = await this.db.system(async (tx) => (await tx.query(`SELECT a.id FROM inspection_visits v JOIN applications a ON a.id=v.application_id WHERE v.inspector_id=$1 AND v.status='SCHEDULED' AND v.scheduled_window && tstzrange($2::timestamptz,$3::timestamptz)`, [inspectorId, start, end])).rows);
      for (const v of vs) {
        let freed: { inspectorId: string; start: number } | null = null;
        try { await this.db.system(async (tx) => { freed = await this.releaseVisit(tx, null, v.id, `Inspector unavailable: ${input.reason}`); }); } catch { continue; }
        const out = await this.runEngine(v.id, now, user.userId, freed ? [freed] : undefined);
        if (out.mode === 'AUTO') await runNotes(await this.rescheduleNotes(v.id, out.start, out.end, out.inspectorId));
        affected.push({ applicationId: v.id, mode: out.mode });
      }
    }
    return { id, affected };
  }

  async removeAvailability(user: SessionUser, availabilityId: string) {
    return this.db.forUser(async (tx) => {
      const r = await tx.query('DELETE FROM inspector_availability WHERE id=$1 RETURNING inspector_id', [availabilityId]);
      if (!r.rowCount) throw notFound();
      await this.audit.record(tx, { action: 'inspector.availability_removed', entityType: 'inspector', entityId: r.rows[0].inspector_id });
      return { ok: true };
    });
  }

  /** One inspector's day, with premises addresses. Addresses are personal data, so every view is audited. */
  async routeSheet(user: SessionUser, inspectorId: string, date: string) {
    await this.inspectorInScope(user, inspectorId);
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT v.id, a.application_no, lower(v.scheduled_window) AS s, upper(v.scheduled_window) AS e, c.name_en AS category, i.instrument_no, i.address_enc, a.access_hours, a.contact_person_enc, ar.name_en AS area_name
       FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas ar ON ar.id=a.area_id
       WHERE v.inspector_id=$1 AND v.status='SCHEDULED' AND v.scheduled_window && tstzrange($2::timestamptz,$3::timestamptz) ORDER BY v.scheduled_window`,
      [inspectorId, istInstant(date, 0), istInstant(addDays(date, 1), 0)])).rows);
    await this.db.forUser((tx) => this.audit.record(tx, { action: 'route_sheet.viewed', entityType: 'inspector', entityId: inspectorId, details: { date, stops: rows.length } }));
    return { date, stops: rows.map((r, n) => ({ order: n + 1, applicationNo: r.application_no, start: r.s, end: r.e, when: fmtWindow(r.s, r.e), category: r.category, instrumentNo: r.instrument_no, area: r.area_name,
      address: r.address_enc ? this.crypto.decStr(r.address_enc) : null, accessHours: r.access_hours ?? null, contact: r.contact_person_enc ? this.crypto.decJson<{ name: string; phone?: string }>(r.contact_person_enc) : null })) };
  }

  // ------------------------------------------------------------------ inspector's own list
  async myVisits(user: SessionUser) {
    return this.db.forUser(async (tx) => (await tx.query(
      `SELECT v.id, v.status, lower(v.scheduled_window) AS s, upper(v.scheduled_window) AS e, a.application_no, a.type, c.name_en AS category, i.instrument_no, ar.name_en AS area_name
       FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas ar ON ar.id=a.area_id
       WHERE v.status IN ('SCHEDULED','IN_PROGRESS') ORDER BY v.scheduled_window`)).rows
      .map((r) => ({ id: r.id, status: r.status, start: r.s, end: r.e, applicationNo: r.application_no, type: r.type, category: r.category, instrumentNo: r.instrument_no, area: r.area_name })));
  }
}
