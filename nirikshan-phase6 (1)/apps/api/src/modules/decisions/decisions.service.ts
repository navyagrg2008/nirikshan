import { Injectable } from '@nestjs/common';
import { approvalBlockers, documentCheckBlockers, evaluateChecklist, findTransition, validityRange, type ApprovalFacts, type ChecklistItem, type DocState, type Verdict } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CaseStateService } from '../applications/case-state.service';
import { InspectionService, trialRow, trimZeros } from '../inspection/inspection.service';
import { CertificatesService } from '../certificates/certificates.service';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { runNotes, type Note } from '../../common/pg';
import type { SessionUser } from '../../common/request-context';

type DecisionInput = { decision: 'APPROVE'; applicationId: string; validityMonths?: number; remarks?: string } | { decision: 'REJECT'; applicationId: string; reasonCode: string; remarks: string } | { decision: 'REFER'; applicationId: string; remarks: string };
const DECISION_SLA_HOURS = 72;

@Injectable()
export class DecisionsService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notif: NotificationService, private state: CaseStateService,
    private sched: SchedulingService, private insp: InspectionService, private certs: CertificatesService) {}

  // ------------------------------------------------------------------ the officer's queue
  async pending(user: SessionUser, now = new Date()) {
    return this.db.forUser(async (tx) => {
      const rows = (await tx.query(
        `SELECT a.id, a.application_no, a.status, a.type, c.name_en AS category, i.instrument_no, ar.name_en AS area_name,
                v.id AS visit_id, v.submitted_at, v.overall_verdict, v.recommendation, d.id AS pending_decision, d.decided_by AS first_by
         FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas ar ON ar.id=a.area_id
         LEFT JOIN LATERAL (SELECT * FROM inspection_visits x WHERE x.application_id=a.id AND x.status='SUBMITTED' ORDER BY x.submitted_at DESC LIMIT 1) v ON true
         LEFT JOIN decisions d ON d.application_id=a.id AND d.status='PENDING_SECOND'
         WHERE a.status IN ('INSPECTED','REFERRED') ORDER BY v.submitted_at NULLS LAST`)).rows;
      return rows.map((r) => {
        const due = r.submitted_at ? new Date(new Date(r.submitted_at).getTime() + DECISION_SLA_HOURS * 3600_000) : null;
        const mins = due ? Math.round((due.getTime() - now.getTime()) / 60_000) : null;
        return { id: r.id, applicationNo: r.application_no, status: r.status, type: r.type, category: r.category, instrumentNo: r.instrument_no, area: r.area_name, submittedAt: r.submitted_at, overall: r.overall_verdict, recommendation: r.recommendation,
          sla: due ? { dueAt: due, state: mins! < 0 ? 'BREACHED' : mins! < 12 * 60 ? 'AT_RISK' : 'ON_TRACK' } : null,
          waitingForSecondApprover: !!r.pending_decision, pendingDecisionId: r.pending_decision ?? null, firstApproverIsMe: r.first_by === user.userId,
          canAct: r.status === 'REFERRED' ? user.role === 'SENIOR_OFFICER' : true };
      });
    });
  }

  // ------------------------------------------------------------------ everything the officer needs to decide
  async facts(tx: Tx, appId: string): Promise<{ app: Record<string, any>; visit: Record<string, any> | null; f: ApprovalFacts; items: ChecklistItem[]; range: ReturnType<typeof validityRange> | null; dual: boolean }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const app = (await tx.query(
      `SELECT a.id, a.application_no, a.status, a.type, a.area_id, a.rule_set_id, a.business_id, i.category_id, i.capacity_band_id, i.accuracy_class_id, c.code AS category_code, b.owner_user_id
       FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN businesses b ON b.id=a.business_id WHERE a.id=$1`, [appId])).rows[0];
    if (!app) throw notFound();
    const set = await this.insp.settings(tx);
    const types = (await tx.query(`SELECT d.id FROM document_types d WHERE $1::verification_type = ANY(d.required_for)`, [app.type])).rows.map((r) => r.id as string);
    const docs = (await tx.query('SELECT document_type_id, scan, review FROM application_documents WHERE application_id=$1 AND NOT superseded', [appId])).rows.map((r) => ({ typeId: r.document_type_id, scan: r.scan, review: r.review }) as DocState);
    const visit = (await tx.query(`SELECT * FROM inspection_visits WHERE application_id=$1 AND status='SUBMITTED' ORDER BY submitted_at DESC LIMIT 1`, [appId])).rows[0] ?? null;
    let items: ChecklistItem[] = []; let failedCritical: string[] = []; let evidenceKinds: string[] = []; let infected = false; let trialCount = 0;
    if (visit) {
      if (visit.checklist_template_id) {
        items = (await tx.query('SELECT items FROM checklist_templates WHERE id=$1', [visit.checklist_template_id])).rows[0].items as ChecklistItem[];
        const ans: Record<string, { answer: 'YES' | 'NO' | 'NA'; remark?: string }> = {};
        for (const r of (await tx.query('SELECT item_code, answer, remark FROM checklist_responses WHERE visit_id=$1', [visit.id])).rows) ans[r.item_code] = { answer: r.answer, remark: r.remark ?? undefined };
        failedCritical = evaluateChecklist(items, ans).failedCritical;
      }
      const ev = (await tx.query('SELECT kind, scan FROM evidence WHERE visit_id=$1', [visit.id])).rows;
      evidenceKinds = ev.filter((e) => e.scan === 'CLEAN').map((e) => e.kind); infected = ev.some((e) => e.scan === 'INFECTED');
      trialCount = (await tx.query('SELECT count(*)::int AS n FROM test_measurements WHERE visit_id=$1', [visit.id])).rows[0].n;
    }
    const f: ApprovalFacts = {
      documentsComplete: documentCheckBlockers(types, docs).length === 0, visitSubmitted: !!visit, trialCount, minTrials: set.minTrials, overall: (visit?.overall_verdict as Verdict | null) ?? null,
      recommendation: visit?.recommendation ?? null, evidenceKinds, requiredEvidence: set.requiredEvidence, evidenceInfected: infected, checklistFailedCritical: failedCritical, hasStickerSerial: !!visit?.sticker_serial,
    };
    let range = null as ReturnType<typeof validityRange> | null;
    if (visit?.overall_verdict && visit.overall_verdict !== 'FAIL') range = validityRange(visit.overall_verdict, await this.insp.intervalFor(tx, app.rule_set_id, app));
    return { app, visit, f, items, range, dual: set.dualApprovalCategories.includes(app.category_code) };
  }

  /** The officer's "Inspection" tab: every visit with the inspector's data, the rules that applied, and why an approval would be blocked. */
  async caseInspection(user: SessionUser, appId: string) {
    return this.db.forUser(async (tx) => {
      const x = await this.facts(tx, appId);
      const inst = (await tx.query('SELECT i.category_id, i.capacity_band_id, i.accuracy_class_id, i.capacity_unit FROM applications a JOIN instruments i ON i.id=a.instrument_id WHERE a.id=$1', [appId])).rows[0];
      const rs = (await tx.query('SELECT version, effective_from FROM rule_sets WHERE id=$1', [x.app.rule_set_id])).rows[0];
      const mpe = await this.insp.mpeFor(tx, x.app.rule_set_id, inst).catch(() => null); const interval = await this.insp.intervalFor(tx, x.app.rule_set_id, inst).catch(() => null);
      const visits = (await tx.query(
        `SELECT v.*, lower(v.scheduled_window) AS w_start, upper(v.scheduled_window) AS w_end FROM inspection_visits v WHERE v.application_id=$1 ORDER BY v.created_at DESC`, [appId])).rows;
      const out = [];
      for (const v of visits) {
        const name = this.crypto.decStr((await tx.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [v.inspector_id])).rows[0]?.full_name_enc) ?? 'Inspector';
        const submitted = v.status === 'SUBMITTED';
        let checklist: unknown[] = []; let trials: unknown[] = []; let evidence: unknown[] = [];
        if (submitted) {
          const items = v.checklist_template_id ? ((await tx.query('SELECT items FROM checklist_templates WHERE id=$1', [v.checklist_template_id])).rows[0].items as ChecklistItem[]) : [];
          const ans = (await tx.query('SELECT item_code, answer, remark FROM checklist_responses WHERE visit_id=$1', [v.id])).rows;
          checklist = ans.map((r) => { const it = items.find((i) => i.code === r.item_code); return { code: r.item_code, textEn: it?.textEn ?? r.item_code, textHi: it?.textHi ?? null, critical: !!it?.critical, answer: r.answer, remark: r.remark, failed: !!it && r.answer !== 'NA' && r.answer !== it.pass }; });
          trials = (await tx.query('SELECT * FROM test_measurements WHERE visit_id=$1 ORDER BY trial_no', [v.id])).rows.map(trialRow);
          evidence = (await tx.query('SELECT id, kind, captured_at, geo_lat IS NOT NULL AS geo FROM evidence WHERE visit_id=$1 ORDER BY captured_at', [v.id])).rows.map((e) => ({ id: e.id, kind: e.kind, capturedAt: e.captured_at, geoTagged: e.geo }));
        }
        out.push({ id: v.id, status: v.status, inspector: name, window: { start: v.w_start, end: v.w_end }, submittedAt: v.submitted_at, startedAt: v.started_at, recommendation: v.recommendation, overall: v.overall_verdict, stickerSerial: v.sticker_serial, note: v.inspector_note,
          rejectReasonCodes: v.reject_reason_codes, arrival: v.arrived_at ? { at: v.arrived_at, distanceM: v.arrival_distance_m == null ? null : Number(v.arrival_distance_m), geofenceOk: v.geofence_ok, justification: v.geofence_justification } : null, checklist, trials, evidence, hasTestSheet: !!v.test_sheet_key });
      }
      const decisions = (await tx.query('SELECT d.id, d.decision, d.status, d.remarks, d.validity_months, d.decided_by, d.second_approver_id, d.created_at, d.second_decided_at, d.second_remarks, rc.code AS reason_code FROM decisions d LEFT JOIN reason_codes rc ON rc.id=d.reason_code_id WHERE d.application_id=$1 ORDER BY d.created_at DESC', [appId])).rows;
      const blockers = approvalBlockers(x.f);
      return {
        visits: out, rules: { version: rs.version, effectiveFrom: rs.effective_from, mpe: mpe && { value: mpe.value, unit: mpe.unit, direction: mpe.direction, marginalPct: mpe.marginalPct }, interval },
        approval: { blockers, canApprove: blockers.length === 0, validity: x.range, requiresSecondApprover: x.dual, pendingDecision: decisions.find((d) => d.status === 'PENDING_SECOND')?.id ?? null },
        decisions: decisions.map((d) => ({ id: d.id, decision: d.decision, status: d.status, remarks: d.remarks, validityMonths: d.validity_months, reasonCode: d.reason_code, decidedBy: d.decided_by, secondApprover: d.second_approver_id, at: d.created_at, secondAt: d.second_decided_at, secondRemarks: d.second_remarks })),
        allowed: { approve: !!findTransition(x.app.status, 'approve', user.role), reject: !!findTransition(x.app.status, 'reject', user.role), refer: !!findTransition(x.app.status, 'refer', user.role), reinspect: !!findTransition(x.app.status, 'reinspect', user.role) },
      };
    });
  }

  // ------------------------------------------------------------------ decide
  async decide(user: SessionUser, input: DecisionInput, now = new Date()) {
    const notes: Note[] = []; let reschedule = false; void reschedule;
    const out = await this.db.forUser(async (tx) => {
      const locked = await this.state.lock(tx, input.applicationId);
      const action = input.decision === 'APPROVE' ? 'approve' : input.decision === 'REJECT' ? 'reject' : 'refer';
      if (!findTransition(locked.status, action, user.role)) throw conflict('ILLEGAL_TRANSITION', { from: locked.status, action });
      const pend = (await tx.query(`SELECT id FROM decisions WHERE application_id=$1 AND status='PENDING_SECOND'`, [input.applicationId])).rows[0];
      if (pend) throw conflict('DECISION_PENDING_SECOND', { decisionId: pend.id });
      const x = await this.facts(tx, input.applicationId); const reauth = new Date(user.authAt);
      if (!x.visit) throw unprocessable('APPROVAL_BLOCKED', { blockers: [{ code: 'INSPECTION_MISSING' }] });

      if (input.decision === 'REFER') {
        const d = (await tx.query(`INSERT INTO decisions (application_id, visit_id, decision, remarks, decided_by, reauth_at, status) VALUES ($1,$2,'REFER',$3,$4,$5,'FINAL') RETURNING id`, [input.applicationId, x.visit.id, input.remarks, user.userId, reauth])).rows[0];
        await this.state.transition(tx, input.applicationId, 'refer', user.role, user.userId, input.remarks);
        await this.audit.record(tx, { action: 'decision.referred', entityType: 'application', entityId: input.applicationId, areaId: locked.area_id, details: { decisionId: d.id } });
        notes.push(() => this.notif.notifyOfficersInArea(locked.area_id, 'DECISION_REFERRED', { appNo: locked.application_no }, `/officer/cases/${input.applicationId}`, ['SENIOR_OFFICER']));
        return { status: 'REFERRED', decisionId: d.id as string };
      }

      if (input.decision === 'REJECT') {
        const rc = (await tx.query(`SELECT id, text_en FROM reason_codes WHERE code=$1 AND applies_to='REJECT'`, [input.reasonCode])).rows[0];
        if (!rc) throw unprocessable('INVALID_REASON_CODE');
        const d = (await tx.query(`INSERT INTO decisions (application_id, visit_id, decision, reason_code_id, remarks, decided_by, reauth_at, status) VALUES ($1,$2,'REJECT',$3,$4,$5,$6,'FINAL') RETURNING id`, [input.applicationId, x.visit.id, rc.id, input.remarks, user.userId, reauth])).rows[0];
        await this.state.transition(tx, input.applicationId, 'reject', user.role, user.userId, `${rc.text_en}. ${input.remarks}`);
        await this.audit.record(tx, { action: 'decision.rejected', entityType: 'application', entityId: input.applicationId, areaId: locked.area_id, details: { decisionId: d.id, reasonCode: input.reasonCode } });
        notes.push(() => this.notif.notifyUser(x.app.owner_user_id, 'APPLICATION_REJECTED', { appNo: locked.application_no, reason: rc.text_en }, `/owner/applications/${input.applicationId}`));
        return { status: 'REJECTED', decisionId: d.id as string };
      }

      // APPROVE: every blocker is reported together, so the officer fixes the list in one go.
      const blockers = approvalBlockers(x.f); if (blockers.length) throw unprocessable('APPROVAL_BLOCKED', { blockers });
      const range = x.range!; const months = input.validityMonths ?? range.default;
      if (months < range.min || months > range.max) throw unprocessable('VALIDITY_OUT_OF_RANGE', { min: range.min, max: range.max });
      const overall = x.visit.overall_verdict as Verdict;
      if (x.dual) {
        const d = (await tx.query(`INSERT INTO decisions (application_id, visit_id, decision, remarks, validity_months, decided_by, reauth_at, status, marginal) VALUES ($1,$2,'APPROVE',$3,$4,$5,$6,'PENDING_SECOND',$7) RETURNING id`,
          [input.applicationId, x.visit.id, input.remarks ?? null, months, user.userId, reauth, overall === 'MARGINAL_PASS'])).rows[0];
        await this.state.note(tx, input.applicationId, 'decision.first_approval', user.userId, 'First approval recorded; waiting for a second approver', locked.status);
        await this.audit.record(tx, { action: 'decision.first_approval', entityType: 'application', entityId: input.applicationId, areaId: locked.area_id, details: { decisionId: d.id, months } });
        notes.push(() => this.notif.notifyOfficersInArea(locked.area_id, 'SECOND_APPROVAL_NEEDED', { appNo: locked.application_no }, `/officer/cases/${input.applicationId}`, ['OFFICER', 'SENIOR_OFFICER'], user.userId));
        return { status: 'PENDING_SECOND', decisionId: d.id as string };
      }
      return this.finalApprove(tx, user, input.applicationId, x, months, input.remarks ?? null, null, notes, now);
    });
    await runNotes(notes); return out;
  }

  private async finalApprove(tx: Tx, user: SessionUser, appId: string, x: Awaited<ReturnType<DecisionsService['facts']>>, months: number, remarks: string | null, existingDecision: { id: string } | null, notes: Note[], now: Date) {
    const overall = x.visit!.overall_verdict as Verdict; let decisionId: string;
    if (existingDecision) decisionId = existingDecision.id;
    else decisionId = (await tx.query(`INSERT INTO decisions (application_id, visit_id, decision, remarks, validity_months, decided_by, reauth_at, status, marginal) VALUES ($1,$2,'APPROVE',$3,$4,$5,$6,'FINAL',$7) RETURNING id`,
      [appId, x.visit!.id, remarks, months, user.userId, new Date(user.authAt), overall === 'MARGINAL_PASS'])).rows[0].id;
    await this.state.transition(tx, appId, 'approve', user.role, user.userId, `Approved for ${months} months${overall === 'MARGINAL_PASS' ? ' (marginal pass)' : ''}`);
    await this.audit.record(tx, { action: 'decision.approved', entityType: 'application', entityId: appId, areaId: x.app.area_id, details: { decisionId, months, overall } });
    const cert = await this.certs.issue(tx, user, { appId, visitId: x.visit!.id, decisionId, validityMonths: months, overall }, notes, now);
    return { status: 'CERTIFICATE_ISSUED', decisionId, certificate: cert };
  }

  async secondApproval(user: SessionUser, decisionId: string, input: { action: 'CONFIRM' | 'DECLINE'; remarks?: string }, now = new Date()) {
    const notes: Note[] = [];
    const out = await this.db.forUser(async (tx) => {
      const d = (await tx.query(`SELECT * FROM decisions WHERE id=$1 FOR UPDATE`, [decisionId])).rows[0];
      if (!d) throw notFound(); if (d.status !== 'PENDING_SECOND') throw conflict('NOT_PENDING_SECOND');
      if (d.decided_by === user.userId) throw forbidden('SELF_APPROVAL_FORBIDDEN');
      const locked = await this.state.lock(tx, d.application_id);
      if (input.action === 'DECLINE') {
        await tx.query(`UPDATE decisions SET status='VOIDED', second_approver_id=$2, second_decided_at=now(), second_remarks=$3 WHERE id=$1`, [decisionId, user.userId, input.remarks]);
        await this.state.note(tx, d.application_id, 'decision.second_declined', user.userId, `Second approver declined: ${input.remarks}`, locked.status);
        await this.audit.record(tx, { action: 'decision.second_declined', entityType: 'application', entityId: d.application_id, areaId: locked.area_id, details: { decisionId } });
        return { status: 'RETURNED_TO_QUEUE' };
      }
      if (!findTransition(locked.status, 'approve', user.role)) throw conflict('ILLEGAL_TRANSITION', { from: locked.status, action: 'approve' });
      const x = await this.facts(tx, d.application_id); const blockers = approvalBlockers(x.f); if (blockers.length) throw unprocessable('APPROVAL_BLOCKED', { blockers });
      if (d.validity_months < x.range!.min || d.validity_months > x.range!.max) throw unprocessable('VALIDITY_OUT_OF_RANGE', { min: x.range!.min, max: x.range!.max });
      await tx.query(`UPDATE decisions SET status='FINAL', second_approver_id=$2, second_decided_at=now(), second_remarks=$3 WHERE id=$1`, [decisionId, user.userId, input.remarks ?? null]);
      return this.finalApprove(tx, user, d.application_id, x, d.validity_months, d.remarks, { id: decisionId }, notes, now);
    });
    await runNotes(notes); return out;
  }

  /** Send the case back for another inspection. The submitted sheet stays on record; the engine books a new visit. */
  async reinspect(user: SessionUser, appId: string, remarks: string, now = new Date()) {
    const notes: Note[] = [];
    const info = await this.db.forUser(async (tx) => {
      const pend = (await tx.query(`SELECT id FROM decisions WHERE application_id=$1 AND status='PENDING_SECOND'`, [appId])).rows[0];
      if (pend) throw conflict('DECISION_PENDING_SECOND', { decisionId: pend.id });
      const t = await this.state.transition(tx, appId, 'reinspect', user.role, user.userId, remarks);
      const owner = (await tx.query('SELECT b.owner_user_id FROM businesses b WHERE b.id=$1', [t.row.business_id])).rows[0].owner_user_id as string;
      notes.push(() => this.notif.notifyUser(owner, 'REINSPECTION_NEEDED', { appNo: t.row.application_no }, `/owner/applications/${appId}`));
      return { appNo: t.row.application_no };
    });
    await runNotes(notes); void info;
    return { status: 'DOCUMENT_CHECKED', scheduling: await this.sched.scheduleNow(appId, now, { triggeredBy: user.userId }) };
  }
}
void trimZeros;
