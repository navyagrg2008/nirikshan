import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { addDays, computeDueDates, istDay, istInstant, allowedActions, type ApplicationState } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { StorageService } from '../../infra/storage';
import { ScanService, ALLOWED_UPLOADS, sniffMime } from '../../infra/scan';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CaseStateService } from './case-state.service';
import { AppError, conflict, notFound, unprocessable } from '../../common/errors';
import { isUniqueViolation, runNotes, type Note } from '../../common/pg';
import type { SessionUser } from '../../common/request-context';

export type Audience = 'OWNER' | 'STAFF';
type CreateInput = { instrumentId: string; type: 'NEW' | 'RE_VERIFICATION' | 'RENEWAL' | 'RE_TEST'; preferredFrom?: string; preferredTo?: string; accessHours?: string; contactPerson?: { name: string; phone?: string } };

const STEPS = ['applied', 'documents', 'scheduling', 'visit', 'decision', 'certificate'] as const;
const CURRENT: Record<string, number> = { APPLIED: 1, DOCUMENT_CHECKED: 2, FAILED_ATTEMPT: 2, SCHEDULED: 3, INSPECTION_IN_PROGRESS: 3, INSPECTED: 4, REFERRED: 4, APPROVED: 5, CERTIFICATE_ISSUED: 6 };
const OWNER_HIDDEN_PREFIX = 'schedule.';
/** Remarks the officer writes for the owner to read (why a case was rejected or needs another inspection). Every other remark stays staff-only. */
const OWNER_VISIBLE_REMARK = ['reject', 'reinspect'];

@Injectable()
export class ApplicationsService {
  constructor(private db: DbService, private crypto: CryptoService, private storage: StorageService, private scan: ScanService, private audit: AuditService,
    private notif: NotificationService, private sched: SchedulingService, private state: CaseStateService) {}

  // ------------------------------------------------------------------ rules and pre-check
  async activeRules(tx: Tx, today: string): Promise<{ id: string; version: number } | null> {
    const r = (await tx.query(`SELECT id, version FROM rule_sets WHERE status='PUBLISHED' AND effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date) ORDER BY effective_from DESC LIMIT 1`, [today])).rows[0];
    return r ?? null;
  }
  async requiredDocs(tx: Tx, type: string) {
    return (await tx.query(`SELECT id, code, name_en, name_hi, max_size_mb, $1::verification_type = ANY(required_for) AS required FROM document_types ORDER BY (NOT ($1::verification_type = ANY(required_for))), name_en`, [type])).rows
      .map((d) => ({ id: d.id as string, code: d.code as string, nameEn: d.name_en as string, nameHi: (d.name_hi as string | null) ?? null, maxSizeMb: d.max_size_mb as number, required: d.required as boolean }));
  }

  /** Everything the apply screen needs, plus the reasons the server will refuse. Final validation happens again on create. */
  async precheck(user: SessionUser, instrumentId: string, type: CreateInput['type'], now = new Date()) {
    const today = istDay(now);
    const base = await this.db.forUser(async (tx) => {
      const i = (await tx.query(
        `SELECT i.id, i.business_id, i.area_id, i.category_id, i.capacity_band_id, i.status, i.first_verified_at, i.created_at, i.instrument_no,
                (SELECT id FROM applications a WHERE a.instrument_id=i.id AND a.status NOT IN ('REJECTED','CANCELLED','APPLICATION_EXPIRED','CERTIFICATE_ISSUED') LIMIT 1) AS open_app
         FROM instruments i WHERE i.id=$1`, [instrumentId])).rows[0];
      if (!i || !user.businessIds.includes(i.business_id)) throw notFound();
      return i;
    });
    const sys = await this.db.system(async (tx) => {
      const rules = await this.activeRules(tx, today);
      const iv = rules ? (await tx.query('SELECT months, grace_days, application_window_days FROM interval_rules WHERE rule_set_id=$1 AND category_id=$2 AND capacity_band_id=$3', [rules.id, base.category_id, base.capacity_band_id])).rows[0] : null;
      const slaHours = rules ? Number((await tx.query(`SELECT COALESCE(sum(max_hours),0) AS h FROM workflow_slas WHERE rule_set_id=$1`, [rules.id])).rows[0].h) || 168 : 168;
      const docs = await this.requiredDocs(tx, type);
      const plan = rules ? await this.sched.plan(tx, { areaId: base.area_id, categoryId: base.category_id, instrumentId, readyAt: now, slaHours: 72, now }) : null;
      return { rules, iv, slaHours, docs, plan };
    });
    const blockers: string[] = []; const warnings: string[] = [];
    if (base.status === 'DEREGISTERED') blockers.push('INSTRUMENT_DEREGISTERED');
    if (base.open_app) blockers.push('OPEN_APPLICATION_EXISTS');
    if (type === 'NEW' && base.first_verified_at) blockers.push('ALREADY_VERIFIED');
    if (type !== 'NEW' && type !== 'RE_TEST' && !base.first_verified_at) blockers.push('NOT_YET_VERIFIED');
    if (type === 'RE_TEST' && !base.first_verified_at) blockers.push('NOT_YET_VERIFIED');
    if (!sys.rules) blockers.push('NO_ACTIVE_RULES');
    const due = computeDueDates({
      type, today, registeredOn: istDay(base.created_at), firstVerifiedOn: base.first_verified_at ? istDay(base.first_verified_at) : null, validUntil: null,
      intervalMonths: sys.iv?.months ?? 12, windowDays: sys.iv?.application_window_days ?? 30, graceDays: sys.iv?.grace_days ?? 0, totalSlaHours: sys.slaHours });
    if (due.overdue) warnings.push('OVERDUE'); else if (due.applyByPassed) warnings.push('APPLY_BY_PASSED');
    if (sys.rules && !sys.plan?.inspectorId) warnings.push('NO_SLOTS_IN_HORIZON'); // informational: the case is queued for an officer instead
    return { instrumentId, instrumentNo: base.instrument_no as string, type, eligible: blockers.length === 0, blockers, warnings, due, requiredDocuments: sys.docs, openApplicationId: (base.open_app as string | null) ?? null,
      firstAvailableDay: sys.plan?.window ? istDay(sys.plan.window.start) : null, ruleVersion: sys.rules?.version ?? null };
  }

  // ------------------------------------------------------------------ create
  async create(user: SessionUser, input: CreateInput, now = new Date()): Promise<{ id: string; applicationNo: string; dueDate: string }> {
    const pc = await this.precheck(user, input.instrumentId, input.type, now);
    if (pc.blockers.length) throw conflict(pc.blockers.includes('OPEN_APPLICATION_EXISTS') ? 'OPEN_APPLICATION_EXISTS' : 'NOT_ELIGIBLE', { blockers: pc.blockers, openApplicationId: pc.openApplicationId });
    if (input.preferredFrom && input.preferredTo && input.preferredTo < input.preferredFrom) throw unprocessable('INVALID_PREFERRED_WINDOW');
    if (input.preferredFrom && input.preferredFrom < istDay(now)) throw unprocessable('PREFERRED_IN_PAST');
    const notes: Note[] = [];
    try {
      const out = await this.db.forUser(async (tx) => {
        const i = (await tx.query('SELECT business_id, area_id FROM instruments WHERE id=$1', [input.instrumentId])).rows[0];
        if (!i || !user.businessIds.includes(i.business_id)) throw notFound();
        const rules = await this.activeRules(tx, istDay(now)); // pinned now; later rule changes never touch this case
        if (!rules) throw conflict('NO_ACTIVE_RULES');
        const win = input.preferredFrom ? [istInstant(input.preferredFrom, 0), istInstant(addDays(input.preferredTo ?? input.preferredFrom, 1), 0)] : [null, null];
        const r = (await tx.query(
          `INSERT INTO applications (application_no, instrument_id, business_id, area_id, type, rule_set_id, due_date, apply_by_date, preferred_window, access_hours, contact_person_enc, applied_by)
           VALUES ('NRK-APP-' || lpad(nextval('application_no_seq')::text, 8, '0'), $1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE tstzrange($8::timestamptz,$9::timestamptz,'[)') END,$10,$11,$12) RETURNING id, application_no`,
          [input.instrumentId, i.business_id, i.area_id, input.type, rules.id, pc.due.dueDate, pc.due.applyByDate, win[0], win[1], input.accessHours ?? null, input.contactPerson ? this.crypto.encJson(input.contactPerson) : null, user.userId])).rows[0];
        await tx.query(`INSERT INTO case_status_history (application_id, from_status, to_status, action, actor_id, remark) VALUES ($1,NULL,'APPLIED','apply',$2,NULL)`, [r.id, user.userId]);
        await this.audit.record(tx, { action: 'application.created', entityType: 'application', entityId: r.id, areaId: i.area_id, details: { type: input.type, ruleVersion: rules.version } });
        notes.push(() => this.notif.notifyUser(user.userId, 'APPLICATION_RECEIVED', { appNo: r.application_no }, `/owner/applications/${r.id}`));
        notes.push(() => this.notif.notifyOfficersInArea(i.area_id, 'APPLICATION_NEW', { appNo: r.application_no }, `/officer/cases/${r.id}`));
        return { id: r.id as string, applicationNo: r.application_no as string, dueDate: pc.due.dueDate };
      });
      await runNotes(notes); return out;
    } catch (e) {
      if (isUniqueViolation(e, 'applications_one_open_per_instrument')) throw conflict('OPEN_APPLICATION_EXISTS');
      throw e;
    }
  }

  /** Traders only. Same area and same category so one visit plan fits; every instrument still gets its own case. */
  async createBatch(user: SessionUser, input: Omit<CreateInput, 'instrumentId'> & { instrumentIds: string[] }) {
    const ids = [...new Set(input.instrumentIds)];
    const meta = await this.db.forUser(async (tx) => (await tx.query('SELECT id, area_id, category_id, business_id FROM instruments WHERE id = ANY($1::uuid[])', [ids])).rows);
    const mine = meta.filter((m) => user.businessIds.includes(m.business_id));
    if (mine.length !== ids.length) throw notFound();
    if (new Set(mine.map((m) => m.area_id)).size > 1 || new Set(mine.map((m) => m.category_id)).size > 1) throw unprocessable('BATCH_MIXED', { hint: 'SAME_AREA_AND_CATEGORY' });
    const created: { instrumentId: string; id: string; applicationNo: string }[] = []; const failed: { instrumentId: string; code: string }[] = [];
    for (const instrumentId of ids) {
      try { const r = await this.create(user, { ...input, instrumentId }); created.push({ instrumentId, id: r.id, applicationNo: r.applicationNo }); }
      catch (e) { failed.push({ instrumentId, code: e instanceof AppError ? e.code : 'ERROR' }); }
    }
    return { created, failed };
  }

  // ------------------------------------------------------------------ read
  async list(user: SessionUser, q: { status?: string; cursor?: string; limit: number }) {
    const cur = q.cursor ? Buffer.from(q.cursor, 'base64url').toString().split('|') : null;
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT a.id, a.application_no, a.status, a.type, a.due_date, a.created_at, i.instrument_no, i.serial_no, c.name_en AS category,
              (SELECT lower(v.scheduled_window) FROM inspection_visits v WHERE v.application_id=a.id AND v.status='SCHEDULED' ORDER BY v.created_at DESC LIMIT 1) AS visit_at
       FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id
       WHERE ($1::text IS NULL OR a.status::text=$1) AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
       ORDER BY a.created_at DESC, a.id DESC LIMIT $4`, [q.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, q.limit + 1])).rows);
    const page = rows.slice(0, q.limit); const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, applicationNo: r.application_no, status: r.status, type: r.type, dueDate: r.due_date ? istDay(r.due_date) : null, createdAt: r.created_at,
        instrument: { instrumentNo: r.instrument_no, serialNo: r.serial_no, category: r.category }, visitAt: r.visit_at ?? null })),
      nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  async etag(tx: Tx, id: string): Promise<string> {
    const r = (await tx.query('SELECT version, updated_at FROM applications WHERE id=$1', [id])).rows[0]; if (!r) throw notFound();
    return `"${r.version}-${r.updated_at.getTime()}"`;
  }

  async detail(tx: Tx, id: string, audience: Audience) {
    const a = (await tx.query(
      `SELECT a.*, i.instrument_no, i.serial_no, i.make, i.category_id, c.name_en AS category, ar.name_en AS area_name, to_char(a.due_date,'YYYY-MM-DD') AS due, to_char(a.apply_by_date,'YYYY-MM-DD') AS apply_by,
              lower(a.preferred_window) AS pw_s, upper(a.preferred_window) AS pw_e
       FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas ar ON ar.id=a.area_id WHERE a.id=$1`, [id])).rows[0];
    if (!a) throw notFound();
    const types = await this.requiredDocs(tx, a.type);
    const docs = (await tx.query(
      `SELECT d.id, d.document_type_id, d.doc_version, d.scan, d.review, d.review_comment, d.reason_code, d.mime_type, d.size_bytes, d.created_at, d.superseded, d.reviewed_at
       FROM application_documents d WHERE d.application_id=$1 ORDER BY d.document_type_id, d.doc_version DESC`, [id])).rows;
    const current = (t: string) => docs.find((d) => d.document_type_id === t && !d.superseded);
    const documents = types.filter((t) => t.required || current(t.id)).map((t) => {
      const d = current(t.id);
      return { ...t, current: d ? { id: d.id, version: d.doc_version, scan: d.scan, review: d.review, comment: d.review === 'FLAGGED' ? d.review_comment : null, reasonCode: d.review === 'FLAGGED' ? d.reason_code : null, mimeType: d.mime_type, sizeBytes: Number(d.size_bytes), uploadedAt: d.created_at } : null,
        ...(audience === 'STAFF' ? { history: docs.filter((x) => x.document_type_id === t.id).map((x) => ({ id: x.id, version: x.doc_version, review: x.review, superseded: x.superseded, uploadedAt: x.created_at })) } : {}) };
    });
    const documentsComplete = types.filter((t) => t.required).every((t) => { const d = current(t.id); return d && d.scan === 'CLEAN'; });
    const v = (await tx.query(
      `SELECT id, inspector_id, status, lower(scheduled_window) AS s, upper(scheduled_window) AS e, score_breakdown, out_of_jurisdiction, assigned_by FROM inspection_visits WHERE application_id=$1 AND status IN ('SCHEDULED','IN_PROGRESS','SUBMITTED') ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    const rr = (await tx.query(`SELECT id, reason, to_char(preferred_from,'YYYY-MM-DD') AS pf, to_char(preferred_to,'YYYY-MM-DD') AS pt, status, decision_note, created_at FROM reschedule_requests WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    const hist = (await tx.query(`SELECT h.action, h.from_status, h.to_status, h.created_at, h.remark, h.actor_id FROM case_status_history h WHERE h.application_id=$1 ORDER BY h.created_at, h.id`, [id])).rows;
    const status = a.status as ApplicationState;
    const terminal = ['REJECTED', 'CANCELLED', 'APPLICATION_EXPIRED'].includes(status);
    const actor: 'OWNER' | 'OFFICER' = audience === 'OWNER' ? 'OWNER' : 'OFFICER';
    const base = {
      id: a.id, applicationNo: a.application_no, status, type: a.type, version: a.version, dueDate: a.due, applyByDate: a.apply_by, createdAt: a.created_at, failedAttempts: a.failed_attempts, cancelReason: a.cancel_reason ?? null,
      instrument: { id: a.instrument_id, instrumentNo: a.instrument_no, serialNo: a.serial_no, make: a.make, category: a.category }, area: { id: a.area_id, name: a.area_name },
      preferred: a.pw_s ? { from: istDay(a.pw_s), to: istDay(new Date(a.pw_e.getTime() - 1000)) } : null, accessHours: a.access_hours ?? null,
      stepper: { steps: STEPS, current: CURRENT[status] ?? 0, terminal },
      documents, documentsComplete,
      visit: v ? { id: v.id, status: v.status, start: v.s, end: v.e } : null,
      waitingForOfficer: a.schedule_mode === 'REVIEW' && status === 'DOCUMENT_CHECKED',
      rescheduleRequest: rr ? { id: rr.id, reason: rr.reason, preferredFrom: rr.pf, preferredTo: rr.pt, status: rr.status, note: rr.decision_note, createdAt: rr.created_at } : null,
      timeline: hist.filter((h) => audience === 'STAFF' || !h.action.startsWith(OWNER_HIDDEN_PREFIX)).map((h) => ({ action: h.action, from: h.from_status, to: h.to_status, at: h.created_at, ...(audience === 'STAFF' || OWNER_VISIBLE_REMARK.includes(h.action) ? { remark: h.remark } : {}) })),
      allowed: {
        cancel: allowedActions(status, actor).includes('cancel'),
        uploadDocuments: status === 'APPLIED' && audience === 'OWNER',
        requestReschedule: audience === 'OWNER' && status === 'SCHEDULED' && !(rr && rr.status === 'OPEN'),
      },
    };
    if (audience === 'OWNER') return base;
    const proposal = (await tx.query(`SELECT p.id, p.inspector_id, p.reasons, p.score_breakdown, lower(p.proposed_window) AS s, upper(p.proposed_window) AS e FROM schedule_proposals p WHERE p.application_id=$1 AND p.status='PENDING'`, [id])).rows[0];
    const sla = (await tx.query(`SELECT step, max_hours FROM workflow_slas WHERE rule_set_id=$1 AND step IN ('DOCUMENT_CHECK','SCHEDULE')`, [a.rule_set_id])).rows;
    return { ...base, ruleSetId: a.rule_set_id, readyAt: a.ready_at, scheduleMode: a.schedule_mode,
      visit: v ? { ...base.visit, inspectorId: v.inspector_id, breakdown: v.score_breakdown, outOfJurisdiction: v.out_of_jurisdiction, assignedBy: v.assigned_by } : null,
      proposal: proposal ? { id: proposal.id, inspectorId: proposal.inspector_id, reasons: proposal.reasons, breakdown: proposal.score_breakdown, start: proposal.s, end: proposal.e } : null,
      slaHours: Object.fromEntries(sla.map((s) => [s.step, s.max_hours])) };
  }

  async getForOwner(user: SessionUser, id: string, ifNoneMatch?: string) {
    return this.db.forUser(async (tx) => {
      const etag = await this.etag(tx, id);
      if (ifNoneMatch && ifNoneMatch === etag) return { notModified: true as const, etag };
      return { notModified: false as const, etag, body: await this.detail(tx, id, 'OWNER') };
    });
  }

  // ------------------------------------------------------------------ documents
  async upload(user: SessionUser, appId: string, documentTypeId: string, file: { buffer: Buffer; originalname: string }) {
    const mime = sniffMime(file.buffer); const allowed = mime ? ALLOWED_UPLOADS[mime] : null;
    if (!mime || !allowed) throw unprocessable('UNSUPPORTED_FILE_TYPE');
    const dt = await this.db.system(async (tx) => (await tx.query('SELECT id, max_size_mb FROM document_types WHERE id=$1', [documentTypeId])).rows[0]);
    if (!dt) throw unprocessable('UNKNOWN_DOCUMENT_TYPE');
    if (file.buffer.length > Math.min(allowed.max, dt.max_size_mb * 1024 * 1024)) throw unprocessable('FILE_TOO_LARGE', { maxMb: Math.min(allowed.max / 1048576, dt.max_size_mb) });
    // Check access and status before spending a scan on the file.
    await this.db.forUser(async (tx) => { const r = await this.state.lock(tx, appId); if (r.status !== 'APPLIED') throw conflict('DOCUMENTS_LOCKED'); });
    const verdict = await this.scan.scan(file.buffer);
    if (verdict === 'INFECTED') { await this.audit.recordStandalone({ action: 'document.rejected_infected', entityType: 'application', entityId: appId, actorId: user.userId, actorRole: user.role }); throw unprocessable('FILE_INFECTED'); }
    if (verdict !== 'CLEAN') throw new AppError(503, 'SCAN_UNAVAILABLE');
    const key = `applications/${appId}/${randomUUID()}.${allowed.ext}`;
    await this.storage.put(key, file.buffer, { contentType: mime });
    const notes: Note[] = [];
    const out = await this.db.forUser(async (tx) => {
      const app = await this.state.lock(tx, appId);
      if (app.status !== 'APPLIED') throw conflict('DOCUMENTS_LOCKED');
      const prev = (await tx.query('SELECT id, doc_version, review FROM application_documents WHERE application_id=$1 AND document_type_id=$2 AND NOT superseded FOR UPDATE', [appId, documentTypeId])).rows[0];
      if (prev) await tx.query('UPDATE application_documents SET superseded=true WHERE id=$1', [prev.id]);
      const r = (await tx.query(
        `INSERT INTO application_documents (application_id, document_type_id, object_key, mime_type, size_bytes, sha256, doc_version, scan, review, uploaded_by, original_name_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CLEAN','PENDING',$8,$9) RETURNING id, doc_version`,
        [appId, documentTypeId, key, mime, file.buffer.length, createHash('sha256').update(file.buffer).digest(), (prev?.doc_version ?? 0) + 1, user.userId, this.crypto.encrypt(file.originalname.slice(0, 200))])).rows[0];
      await tx.query('UPDATE applications SET updated_at=now() WHERE id=$1', [appId]);
      await this.audit.record(tx, { action: 'document.uploaded', entityType: 'application', entityId: appId, areaId: app.area_id, details: { documentTypeId, version: r.doc_version, mime } });
      if (prev?.review === 'FLAGGED') notes.push(() => this.notif.notifyOfficersInArea(app.area_id, 'DOCUMENT_UPLOADED', { appNo: app.application_no }, `/officer/cases/${appId}`));
      return { id: r.id as string, version: r.doc_version as number, scan: 'CLEAN', review: 'PENDING' };
    });
    await runNotes(notes); return out;
  }

  /** Short-lived link. The same call serves owner and officer; row-level security decides who can see the row. Every issue is audited. */
  async documentLink(user: SessionUser, appId: string, docId: string) {
    return this.db.forUser(async (tx) => {
      const d = (await tx.query('SELECT d.object_key, d.mime_type, a.area_id FROM application_documents d JOIN applications a ON a.id=d.application_id WHERE d.id=$1 AND d.application_id=$2', [docId, appId])).rows[0];
      if (!d) throw notFound();
      await this.audit.record(tx, { action: 'document.link_issued', entityType: 'application_document', entityId: docId, areaId: d.area_id });
      return { url: await this.storage.signedUrl(d.object_key, d.mime_type, 120), expiresInSec: 120 };
    });
  }

  // ------------------------------------------------------------------ owner actions
  async cancel(user: SessionUser, appId: string, reason: string) {
    const notes: Note[] = [];
    await this.db.forUser(async (tx) => {
      const t = await this.state.transition(tx, appId, 'cancel', user.role, user.userId, reason, { set: 'cancel_reason=$3', params: [reason] });
      await tx.query(`UPDATE reschedule_requests SET status='CLOSED' WHERE application_id=$1 AND status='OPEN'`, [appId]);
      notes.push(() => this.notif.notifyUser(user.userId, 'APPLICATION_CANCELLED', { appNo: t.row.application_no }, `/owner/applications/${appId}`));
    });
    await runNotes(notes); return { ok: true };
  }

  async requestReschedule(user: SessionUser, appId: string, input: { reason: string; preferredFrom: string; preferredTo?: string }, now = new Date()) {
    if (input.preferredFrom <= istDay(now)) throw unprocessable('PREFERRED_MUST_BE_FUTURE');
    if (input.preferredTo && input.preferredTo < input.preferredFrom) throw unprocessable('INVALID_PREFERRED_WINDOW');
    const notes: Note[] = [];
    try {
      const out = await this.db.forUser(async (tx) => {
        const app = await this.state.lock(tx, appId);
        if (app.status !== 'SCHEDULED') throw conflict('ILLEGAL_TRANSITION', { from: app.status, action: 'requestReschedule' });
        const r = (await tx.query('INSERT INTO reschedule_requests (application_id, requested_by, reason, preferred_from, preferred_to) VALUES ($1,$2,$3,$4,$5) RETURNING id', [appId, user.userId, input.reason, input.preferredFrom, input.preferredTo ?? null])).rows[0];
        await this.state.note(tx, appId, 'reschedule.requested', user.userId, input.reason, app.status);
        await this.audit.record(tx, { action: 'reschedule.requested', entityType: 'application', entityId: appId, areaId: app.area_id });
        notes.push(() => this.notif.notifyOfficersInArea(app.area_id, 'RESCHEDULE_REQUESTED', { appNo: app.application_no }, `/officer/cases/${appId}`));
        return { id: r.id as string };
      });
      await runNotes(notes); return out;
    } catch (e) { if (isUniqueViolation(e, 'reschedule_one_open')) throw conflict('RESCHEDULE_ALREADY_REQUESTED'); throw e; }
  }
}
