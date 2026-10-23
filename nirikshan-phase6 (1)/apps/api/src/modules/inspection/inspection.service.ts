import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  allowedRecommendations, computeTrial, distanceMeters, evaluateChecklist, overallVerdict, type ChecklistItem, type MpeInput, type TrialResult, type Verdict,
} from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { StorageService } from '../../infra/storage';
import { ScanService, sniffMime } from '../../infra/scan';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { CaseStateService } from '../applications/case-state.service';
import { AppError, conflict, notFound, unprocessable } from '../../common/errors';
import { isUniqueViolation, runNotes, type Note } from '../../common/pg';
import type { SessionUser } from '../../common/request-context';
import { renderTestSheet } from '../certificates/pdf';

export interface InspectionSettings { minTrials: number; geofenceRadiusM: number; startEarlyMin: number; startLateMin: number; requiredEvidence: string[]; draftDays: number; dualApprovalCategories: string[] }
const IMAGE_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const MAX_EVIDENCE = 30;

@Injectable()
export class InspectionService {
  constructor(private db: DbService, private crypto: CryptoService, private storage: StorageService, private scan: ScanService, private audit: AuditService,
    private notif: NotificationService, private state: CaseStateService) {}

  async settings(tx: Tx): Promise<InspectionSettings> {
    const r = (await tx.query('SELECT * FROM inspection_settings')).rows[0];
    return { minTrials: r.min_trials, geofenceRadiusM: r.geofence_radius_m, startEarlyMin: r.start_early_minutes, startLateMin: r.start_late_minutes, requiredEvidence: r.required_evidence, draftDays: r.draft_days, dualApprovalCategories: r.dual_approval_categories };
  }

  /** The permissible error and the interval that apply to this instrument under the rule version pinned when the owner applied. Never "latest". */
  async mpeFor(tx: Tx, ruleSetId: string, inst: { category_id: string; capacity_band_id: string; accuracy_class_id: string }): Promise<MpeInput & { id: string; ruleVersion: number }> {
    const r = (await tx.query(
      `SELECT m.id, m.value, m.unit, m.direction, m.marginal_pct, rs.version FROM mpe_rules m JOIN rule_sets rs ON rs.id=m.rule_set_id
       WHERE m.rule_set_id=$1 AND m.category_id=$2 AND m.capacity_band_id=$3 AND m.accuracy_class_id=$4`, [ruleSetId, inst.category_id, inst.capacity_band_id, inst.accuracy_class_id])).rows[0];
    if (!r) throw unprocessable('NO_MPE_RULE');
    return { id: r.id, value: String(r.value), unit: r.unit, direction: r.direction, marginalPct: String(r.marginal_pct), ruleVersion: r.version };
  }
  async intervalFor(tx: Tx, ruleSetId: string, inst: { category_id: string; capacity_band_id: string }) {
    const r = (await tx.query('SELECT months, marginal_months, grace_days, application_window_days FROM interval_rules WHERE rule_set_id=$1 AND category_id=$2 AND capacity_band_id=$3', [ruleSetId, inst.category_id, inst.capacity_band_id])).rows[0];
    if (!r) throw unprocessable('NO_INTERVAL_RULE');
    return { months: r.months as number, marginalMonths: (r.marginal_months as number | null) ?? null, graceDays: r.grace_days as number, applicationWindowDays: r.application_window_days as number };
  }
  async template(tx: Tx, categoryId: string, today: string) {
    const r = (await tx.query(`SELECT id, version, items FROM checklist_templates WHERE category_id=$1 AND status='PUBLISHED' AND effective_from <= $2::date ORDER BY version DESC LIMIT 1`, [categoryId, today])).rows[0];
    if (!r) throw unprocessable('NO_CHECKLIST_TEMPLATE');
    return { id: r.id as string, version: r.version as number, items: r.items as ChecklistItem[] };
  }

  private async lockVisit(tx: Tx, user: SessionUser, visitId: string, statuses: string[]) {
    const v = (await tx.query(
      `SELECT v.*, lower(v.scheduled_window) AS w_start, upper(v.scheduled_window) AS w_end FROM inspection_visits v WHERE v.id=$1 AND v.inspector_id=$2 FOR UPDATE`, [visitId, user.userId])).rows[0];
    if (!v) throw notFound();
    if (!statuses.includes(v.status)) throw conflict('VISIT_NOT_OPEN', { status: v.status });
    return v;
  }
  private async caseFacts(tx: Tx, appId: string) {
    const a = (await tx.query(
      `SELECT a.id, a.application_no, a.type, a.status, a.area_id, a.business_id, a.rule_set_id, a.access_hours, i.id AS instrument_id, i.instrument_no, i.serial_no, i.make, i.model, i.capacity, i.capacity_unit, i.display_count,
              i.category_id, i.capacity_band_id, i.accuracy_class_id, i.location_enc, i.address_enc, c.name_en AS category, c.code AS category_code, ac.code AS class_code, ar.name_en AS area_name, b.owner_user_id
       FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN accuracy_classes ac ON ac.id=i.accuracy_class_id
       JOIN areas ar ON ar.id=a.area_id JOIN businesses b ON b.id=a.business_id WHERE a.id=$1`, [appId])).rows[0];
    if (!a) throw notFound(); return a;
  }
  private today() { return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); }

  // ------------------------------------------------------------------ reading
  async myVisits(user: SessionUser) {
    return this.db.forUser(async (tx) => (await tx.query(
      `SELECT v.id, v.status, lower(v.scheduled_window) AS s, upper(v.scheduled_window) AS e, a.application_no, a.type, c.name_en AS category, c.name_hi AS category_hi, i.instrument_no, ar.name_en AS area_name,
              (SELECT updated_at FROM inspection_drafts d WHERE d.visit_id=v.id AND d.expires_at > now()) AS draft_at
       FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas ar ON ar.id=a.area_id
       WHERE v.status IN ('SCHEDULED','IN_PROGRESS') ORDER BY v.scheduled_window`)).rows
      .map((r) => ({ id: r.id, status: r.status, start: r.s, end: r.e, applicationNo: r.application_no, type: r.type, category: r.category, categoryHi: r.category_hi, instrumentNo: r.instrument_no, area: r.area_name, draftSavedAt: r.draft_at })));
  }

  async history(user: SessionUser) {
    return this.db.forUser(async (tx) => (await tx.query(
      `SELECT id, status, submitted_at, recommendation, overall_verdict, summary, lower(scheduled_window) AS s FROM inspection_visits WHERE status IN ('SUBMITTED','NO_SHOW','SUPERSEDED') ORDER BY COALESCE(submitted_at, lower(scheduled_window)) DESC LIMIT 100`)).rows
      .map((r) => ({ id: r.id, status: r.status, submittedAt: r.submitted_at, scheduledAt: r.s, recommendation: r.recommendation, overall: r.overall_verdict, summary: r.summary })));
  }

  async detail(user: SessionUser, visitId: string) {
    return this.db.forUser(async (tx) => {
      const v = (await tx.query(`SELECT v.*, lower(v.scheduled_window) AS w_start, upper(v.scheduled_window) AS w_end FROM inspection_visits v WHERE v.id=$1`, [visitId])).rows[0];
      if (!v) throw notFound();
      const set = await this.settings(tx); const base = { id: v.id as string, status: v.status as string, window: { start: v.w_start, end: v.w_end } };
      if (v.status === 'SUBMITTED' || v.status === 'NO_SHOW' || v.status === 'SUPERSEDED') {
        const trials = (await tx.query('SELECT * FROM test_measurements WHERE visit_id=$1 ORDER BY trial_no', [visitId])).rows.map(trialRow);
        const checklist = (await tx.query('SELECT item_code, answer, remark FROM checklist_responses WHERE visit_id=$1', [visitId])).rows;
        const evidence = (await tx.query('SELECT id, kind, captured_at, geo_lat IS NOT NULL AS geo FROM evidence WHERE visit_id=$1 ORDER BY captured_at', [visitId])).rows;
        return { ...base, readOnly: true, summary: v.summary, recommendation: v.recommendation, overall: v.overall_verdict, stickerSerial: v.sticker_serial, note: v.inspector_note, rejectReasonCodes: v.reject_reason_codes, submittedAt: v.submitted_at,
          trials, checklist, evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, capturedAt: e.captured_at, geoTagged: e.geo })), hasTestSheet: !!v.test_sheet_key };
      }
      const a = await this.caseFacts(tx, v.application_id);
      const mpe = await this.mpeFor(tx, a.rule_set_id, a); const tpl = await this.template(tx, a.category_id, this.today());
      const interval = await this.intervalFor(tx, a.rule_set_id, a);
      const rs = (await tx.query('SELECT version, effective_from FROM rule_sets WHERE id=$1', [a.rule_set_id])).rows[0];
      const reasons = (await tx.query(`SELECT code, text_en, text_hi FROM reason_codes WHERE applies_to='REJECT' ORDER BY code`)).rows;
      const address = this.crypto.decStr(a.address_enc);
      await this.audit.record(tx, { action: 'visit.address_viewed', entityType: 'inspection_visit', entityId: visitId, areaId: a.area_id });
      const draft = (await tx.query('SELECT payload_enc, updated_at, version FROM inspection_drafts WHERE visit_id=$1 AND inspector_id=$2 AND expires_at > now()', [visitId, user.userId])).rows[0];
      const evidence = (await tx.query('SELECT id, kind, captured_at, geo_lat IS NOT NULL AS geo, scan FROM evidence WHERE visit_id=$1 ORDER BY captured_at', [visitId])).rows;
      return {
        ...base, readOnly: false, applicationNo: a.application_no, applicationId: a.id, type: a.type, accessHours: a.access_hours,
        instrument: { instrumentNo: a.instrument_no, category: a.category, categoryCode: a.category_code, make: a.make, model: a.model, serialNo: a.serial_no, capacity: `${trimZeros(a.capacity)} ${a.capacity_unit}`, capacityUnit: a.capacity_unit, accuracyClass: a.class_code, displayCount: a.display_count },
        area: a.area_name, address, hasPremisesPoint: !!a.location_enc, arrival: v.arrived_at ? { at: v.arrived_at, distanceM: v.arrival_distance_m == null ? null : Number(v.arrival_distance_m), geofenceOk: v.geofence_ok } : null,
        checklist: { templateId: tpl.id, version: tpl.version, items: tpl.items },
        mpe: { value: mpe.value, unit: mpe.unit, direction: mpe.direction, marginalPct: mpe.marginalPct }, interval,
        rules: { version: rs.version, effectiveFrom: rs.effective_from, fetchedAt: new Date().toISOString() },
        rejectReasons: reasons.map((r) => ({ code: r.code, textEn: r.text_en, textHi: r.text_hi })),
        settings: { minTrials: set.minTrials, requiredEvidence: set.requiredEvidence, geofenceRadiusM: set.geofenceRadiusM, draftDays: set.draftDays },
        draft: draft ? { data: this.crypto.decJson(draft.payload_enc, `draft:${visitId}`), savedAt: draft.updated_at, version: draft.version } : null,
        evidence: evidence.map((e) => ({ id: e.id, kind: e.kind, capturedAt: e.captured_at, geoTagged: e.geo, scan: e.scan })),
      };
    });
  }

  // ------------------------------------------------------------------ step 1: arrive
  async arrive(user: SessionUser, visitId: string, input: { lat: number; lon: number; accuracyM?: number; justification?: string }, now = new Date()) {
    const notes: Note[] = [];
    const out = await this.db.forUser(async (tx) => {
      const v = await this.lockVisit(tx, user, visitId, ['SCHEDULED', 'IN_PROGRESS']);
      if (v.status === 'IN_PROGRESS') throw conflict('ALREADY_STARTED');
      const set = await this.settings(tx);
      const opens = new Date(new Date(v.w_start).getTime() - set.startEarlyMin * 60_000); const closes = new Date(new Date(v.w_end).getTime() + set.startLateMin * 60_000);
      if (now < opens || now > closes) throw conflict('OUTSIDE_VISIT_WINDOW', { opensAt: opens.toISOString(), closesAt: closes.toISOString() });
      const a = await this.caseFacts(tx, v.application_id);
      const premises = a.location_enc ? this.crypto.decJson<{ lat: number; lng: number }>(a.location_enc) : null;
      let dist: number | null = null; let ok: boolean | null = null;
      if (premises) { dist = Math.round(distanceMeters({ lat: input.lat, lng: input.lon }, premises) * 10) / 10; ok = dist <= set.geofenceRadiusM; }
      if (ok === false && !input.justification) throw unprocessable('JUSTIFICATION_REQUIRED', { distanceM: Math.round(dist!), radiusM: set.geofenceRadiusM });
      await this.state.transition(tx, v.application_id, 'startVisit', 'INSPECTOR', user.userId, ok === false ? 'Started outside the geofence with a written reason' : 'Visit started');
      await tx.query(
        `UPDATE inspection_visits SET status='IN_PROGRESS', started_at=$2, arrived_at=$2, arrival_lat=$3, arrival_lon=$4, arrival_accuracy_m=$5, arrival_distance_m=$6, geofence_ok=$7, geofence_justification=$8, version=version+1 WHERE id=$1`,
        [visitId, now, input.lat, input.lon, input.accuracyM ?? null, dist, ok, input.justification ?? null]);
      await this.audit.record(tx, { action: 'visit.started', entityType: 'inspection_visit', entityId: visitId, areaId: a.area_id, details: { geofenceOk: ok, distanceM: dist == null ? null : Math.round(dist), accuracyM: input.accuracyM ?? null } });
      return { status: 'IN_PROGRESS', geofenceOk: ok, distanceM: dist == null ? null : Math.round(dist), radiusM: set.geofenceRadiusM };
    });
    await runNotes(notes); return out;
  }

  // ------------------------------------------------------------------ step 3: server-side verdicts
  calc(trials: { reference: string; observed: string }[], capacityUnit: string, mpe: MpeInput): TrialResult[] {
    try { return trials.map((t, i) => computeTrial(i + 1, t.reference, t.observed, capacityUnit, mpe)); }
    catch (e) { throw unprocessable((e as Error).message || 'INVALID_TRIAL'); }
  }
  async computeTrials(user: SessionUser, visitId: string, trials: { reference: string; observed: string }[]) {
    return this.db.forUser(async (tx) => {
      const v = (await tx.query('SELECT application_id, status FROM inspection_visits WHERE id=$1 AND inspector_id=$2', [visitId, user.userId])).rows[0];
      if (!v) throw notFound(); if (v.status !== 'IN_PROGRESS') throw conflict('VISIT_NOT_OPEN', { status: v.status });
      const a = await this.caseFacts(tx, v.application_id); const mpe = await this.mpeFor(tx, a.rule_set_id, a);
      const rows = this.calc(trials, a.capacity_unit, mpe); const overall = overallVerdict(rows.map((r) => r.verdict));
      return { trials: rows, overall, ...allowedRecommendations(overall, []) };
    });
  }

  // ------------------------------------------------------------------ drafts (private to the inspector, encrypted, expire)
  async saveDraft(user: SessionUser, visitId: string, payload: unknown) {
    return this.db.forUser(async (tx) => {
      const v = await this.lockVisit(tx, user, visitId, ['IN_PROGRESS']);
      const enc = this.crypto.encJson(payload, `draft:${visitId}`);
      const set = await this.settings(tx);
      const r = (await tx.query(
        `INSERT INTO inspection_drafts (visit_id, inspector_id, payload_enc, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))
         ON CONFLICT (visit_id, inspector_id) DO UPDATE SET payload_enc=EXCLUDED.payload_enc, updated_at=now(), expires_at=EXCLUDED.expires_at, version=inspection_drafts.version+1 RETURNING updated_at, version`, [visitId, user.userId, enc, set.draftDays])).rows[0];
      void v; return { savedAt: r.updated_at, version: r.version };
    });
  }
  /** Draft-expiry job: drafts older than the retention window are deleted (the visit itself is untouched). */
  async purgeExpiredDrafts(): Promise<number> {
    return this.db.system(async (tx) => (await tx.query('DELETE FROM inspection_drafts WHERE expires_at < now()')).rowCount ?? 0);
  }

  // ------------------------------------------------------------------ step 4: evidence
  async uploadEvidence(user: SessionUser, visitId: string, kind: string, geo: { lat?: number; lon?: number }, file: { buffer: Buffer }) {
    if (geo.lat == null || geo.lon == null) throw unprocessable('GEO_REQUIRED');
    const mime = sniffMime(file.buffer); const ext = mime ? IMAGE_MIME[mime] : undefined;
    if (!mime || !ext) throw unprocessable('UNSUPPORTED_FILE_TYPE');
    if (file.buffer.length > 5 * 1024 * 1024) throw unprocessable('FILE_TOO_LARGE', { maxMb: 5 });
    await this.db.forUser(async (tx) => {
      await this.lockVisit(tx, user, visitId, ['IN_PROGRESS']);
      const n = (await tx.query('SELECT count(*)::int AS n FROM evidence WHERE visit_id=$1', [visitId])).rows[0].n as number;
      if (n >= MAX_EVIDENCE) throw unprocessable('TOO_MANY_EVIDENCE', { max: MAX_EVIDENCE });
    });
    const verdict = await this.scan.scan(file.buffer);
    if (verdict === 'INFECTED') { await this.audit.recordStandalone({ action: 'evidence.rejected_infected', entityType: 'inspection_visit', entityId: visitId, actorId: user.userId, actorRole: user.role }); throw unprocessable('FILE_INFECTED'); }
    if (verdict !== 'CLEAN') throw new AppError(503, 'SCAN_UNAVAILABLE');
    const key = `inspections/${visitId}/${randomUUID()}.${ext}`;
    await this.storage.put(key, file.buffer, { contentType: mime });
    return this.db.forUser(async (tx) => {
      const v = await this.lockVisit(tx, user, visitId, ['IN_PROGRESS']);
      const r = (await tx.query(
        `INSERT INTO evidence (visit_id, kind, object_key, mime_type, captured_at, scan, geo_lat, geo_lon, size_bytes, sha256) VALUES ($1,$2,$3,$4,now(),'CLEAN',$5,$6,$7,$8) RETURNING id, captured_at`,
        [visitId, kind, key, mime, geo.lat, geo.lon, file.buffer.length, createHash('sha256').update(file.buffer).digest()])).rows[0];
      await this.audit.record(tx, { action: 'evidence.uploaded', entityType: 'inspection_visit', entityId: visitId, details: { kind, evidenceId: r.id } });
      void v; return { id: r.id as string, kind, capturedAt: r.captured_at, geoTagged: true, scan: 'CLEAN' };
    });
  }
  async evidenceLink(_user: SessionUser, evidenceId: string) {
    return this.db.forUser(async (tx) => {
      const e = (await tx.query('SELECT e.object_key, e.mime_type, e.visit_id FROM evidence e WHERE e.id=$1', [evidenceId])).rows[0];
      if (!e) throw notFound();
      await this.audit.record(tx, { action: 'evidence.link_issued', entityType: 'evidence', entityId: evidenceId });
      return { url: await this.storage.signedUrl(e.object_key, e.mime_type, 120), expiresInSec: 120 };
    });
  }
  async testSheetLink(_user: SessionUser, visitId: string) {
    return this.db.forUser(async (tx) => {
      const v = (await tx.query('SELECT test_sheet_key FROM inspection_visits WHERE id=$1', [visitId])).rows[0];
      if (!v?.test_sheet_key) throw notFound();
      await this.audit.record(tx, { action: 'test_sheet.link_issued', entityType: 'inspection_visit', entityId: visitId });
      return { url: await this.storage.signedUrl(v.test_sheet_key, 'application/pdf', 120), expiresInSec: 120 };
    });
  }

  // ------------------------------------------------------------------ step 5: submit
  async submit(user: SessionUser, visitId: string, input: { checklist: Record<string, { answer: 'YES' | 'NO' | 'NA'; remark?: string }>; trials: { reference: string; observed: string }[]; recommendation: 'RECOMMEND_APPROVE' | 'RECOMMEND_REJECT' | 'RE_INSPECT'; rejectReasonCodes: string[]; note?: string; stickerSerial?: string }) {
    const notes: Note[] = [];
    const out = await this.db.forUser(async (tx) => {
      const v = await this.lockVisit(tx, user, visitId, ['IN_PROGRESS']);
      if (!v.arrived_at) throw unprocessable('ARRIVAL_MISSING');
      const a = await this.caseFacts(tx, v.application_id); const set = await this.settings(tx);
      const mpe = await this.mpeFor(tx, a.rule_set_id, a); const tpl = await this.template(tx, a.category_id, this.today());
      const errors: Record<string, unknown> = {};
      const known = new Set(tpl.items.map((i) => i.code));
      const unknown = Object.keys(input.checklist).filter((k) => !known.has(k)); if (unknown.length) throw unprocessable('UNKNOWN_CHECKLIST_ITEM', { items: unknown });
      const ev = evaluateChecklist(tpl.items, input.checklist);
      if (ev.missing.length) errors.missing = ev.missing; if (ev.invalidNA.length) errors.notApplicableNotAllowed = ev.invalidNA; if (ev.needRemark.length) errors.remarkRequired = ev.needRemark;
      if (Object.keys(errors).length) throw unprocessable('CHECKLIST_INCOMPLETE', errors);
      if (input.trials.length < set.minTrials) throw unprocessable('TRIALS_MISSING', { have: input.trials.length, need: set.minTrials });
      const trials = this.calc(input.trials, a.capacity_unit, mpe); const overall = overallVerdict(trials.map((t) => t.verdict)) as Verdict;
      const allowed = allowedRecommendations(overall, ev.failedCritical);
      if (!allowed.allowed.includes(input.recommendation)) throw unprocessable('RECOMMENDATION_NOT_ALLOWED', { allowed: allowed.allowed, suggested: allowed.suggested });
      if (input.recommendation === 'RECOMMEND_REJECT') {
        if (!input.rejectReasonCodes.length) throw unprocessable('REASON_CODE_REQUIRED');
        const ok = (await tx.query(`SELECT code FROM reason_codes WHERE applies_to='REJECT' AND code = ANY($1::text[])`, [input.rejectReasonCodes])).rows.length;
        if (ok !== new Set(input.rejectReasonCodes).size) throw unprocessable('INVALID_REASON_CODE');
      }
      if (input.recommendation === 'RECOMMEND_APPROVE' && !input.stickerSerial) throw unprocessable('STICKER_REQUIRED');
      const evi = (await tx.query(`SELECT kind, scan FROM evidence WHERE visit_id=$1`, [visitId])).rows as { kind: string; scan: string }[];
      const kinds = new Set(evi.filter((e) => e.scan === 'CLEAN').map((e) => e.kind));
      const need = [...set.requiredEvidence]; if (ev.failedCritical.some((c) => c === 'TAMPER' || c === 'MAGNETIC')) need.push('TAMPER');
      const missingEv = need.filter((k) => !kinds.has(k)); if (missingEv.length) throw unprocessable('EVIDENCE_MISSING', { kinds: missingEv });

      await this.state.transition(tx, v.application_id, 'submit', 'INSPECTOR', user.userId, `Inspection submitted (${overall})`);
      for (const it of tpl.items) { const r = input.checklist[it.code]; if (r) await tx.query('INSERT INTO checklist_responses (visit_id, template_id, item_code, answer, remark) VALUES ($1,$2,$3,$4,$5)', [visitId, tpl.id, it.code, r.answer, r.remark ?? null]); }
      for (const t of trials) await tx.query(
        `INSERT INTO test_measurements (visit_id, trial_no, reference_value, observed_value, unit, error_value, error_pct, mpe_value, verdict, mpe_rule_id, error_unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::verdict,$10,$11)`,
        [visitId, t.trialNo, t.reference, t.observed, t.unit, t.errorValue, t.errorPct, t.mpeValue, t.verdict, mpe.id, t.errorUnit]);
      const insp = this.crypto.decStr((await tx.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [user.userId])).rows[0]?.full_name_enc) ?? 'Inspector';
      const submittedAt = new Date();
      const sheet = await renderTestSheet({
        applicationNo: a.application_no, instrumentNo: a.instrument_no, category: a.category, makeModel: [a.make, a.model].filter(Boolean).join(' '), serialNo: a.serial_no,
        capacity: `${trimZeros(a.capacity)} ${a.capacity_unit}`, accuracyClass: a.class_code, inspector: insp, visitedAt: submittedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        arrival: v.geofence_ok === false ? `Arrived ${Math.round(Number(v.arrival_distance_m))} m from premises (reason recorded)` : v.geofence_ok ? 'Arrived inside the premises geofence' : 'No premises point to compare', ruleVersion: mpe.ruleVersion,
        overall, recommendation: input.recommendation, stickerSerial: input.stickerSerial ?? '',
        checklist: tpl.items.filter((i) => input.checklist[i.code]).map((i) => ({ text: i.textEn, answer: input.checklist[i.code]!.answer, remark: input.checklist[i.code]!.remark })),
        trials: trials.map((t) => ({ no: t.trialNo, reference: t.reference, observed: t.observed, unit: t.unit, error: t.errorValue, errorUnit: t.errorUnit, pct: t.errorPct, mpe: t.mpeValue, verdict: t.verdict })),
        evidence: [...kinds], note: input.note,
      });
      const sheetKey = `inspections/${visitId}/test-sheet.pdf`; await this.storage.put(sheetKey, sheet, { contentType: 'application/pdf' });
      const summary = { applicationNo: a.application_no, category: a.category, instrumentNo: a.instrument_no, area: a.area_name, overall, recommendation: input.recommendation, stickerSerial: input.stickerSerial ?? null };
      try {
        await tx.query(
          `UPDATE inspection_visits SET status='SUBMITTED', submitted_at=$2, recommendation=$3::recommendation, overall_verdict=$4::verdict, sticker_serial=$5, reject_reason_codes=$6, inspector_note=$7,
             checklist_template_id=$8, test_sheet_key=$9, test_sheet_sha256=$10, summary=$11, version=version+1 WHERE id=$1`,
          [visitId, submittedAt, input.recommendation, overall, input.stickerSerial ?? null, input.recommendation === 'RECOMMEND_REJECT' ? input.rejectReasonCodes : [], input.note ?? null, tpl.id, sheetKey, createHash('sha256').update(sheet).digest(), JSON.stringify(summary)]);
      } catch (e) { if (isUniqueViolation(e, 'inspection_visits_sticker_uq')) throw conflict('STICKER_IN_USE'); throw e; }
      await tx.query('DELETE FROM inspection_drafts WHERE visit_id=$1', [visitId]);
      await this.audit.record(tx, { action: 'visit.submitted', entityType: 'inspection_visit', entityId: visitId, areaId: a.area_id, details: { overall, recommendation: input.recommendation, trials: trials.length } });
      notes.push(() => this.notif.notifyOfficersInArea(a.area_id, 'INSPECTION_SUBMITTED', { appNo: a.application_no }, `/officer/cases/${a.id}`));
      notes.push(() => this.notif.notifyUser(a.owner_user_id, 'INSPECTION_DONE', { appNo: a.application_no }, `/owner/applications/${a.id}`));
      return { status: 'SUBMITTED', overall, recommendation: input.recommendation, trials, hasTestSheet: true };
    });
    await runNotes(notes); return out;
  }
}

export const trimZeros = (n: string | number) => String(n).includes('.') ? String(n).replace(/0+$/, '').replace(/\.$/, '') : String(n);
export function trialRow(r: Record<string, unknown>) {
  return { trialNo: r.trial_no, reference: String(r.reference_value), observed: String(r.observed_value), unit: r.unit, errorValue: String(r.error_value), errorUnit: r.error_unit, errorPct: String(r.error_pct), mpeValue: String(r.mpe_value), verdict: r.verdict };
}
