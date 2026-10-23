import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { istDay, diffRules, missingCoverage, rangesOverlap, ruleDraftSchema, ruleReviewSchema, type RuleContent } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { AppError, conflict, notFound, unprocessable } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

type Draft = z.infer<typeof ruleDraftSchema>;
const dstr = (d: Date | string | null) => (d ? (typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`) : null);
const tomorrow = (now: Date) => istDay(new Date(now.getTime() + 86400_000));

@Injectable()
export class RulesService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notif: NotificationService) {}

  private async content(tx: Tx, id: string): Promise<RuleContent> {
    const mpe = (await tx.query('SELECT category_id, capacity_band_id, accuracy_class_id, direction, value::text, unit, marginal_pct::text FROM mpe_rules WHERE rule_set_id=$1 ORDER BY category_id, capacity_band_id, accuracy_class_id', [id])).rows;
    const iv = (await tx.query('SELECT category_id, capacity_band_id, months, marginal_months, grace_days, application_window_days FROM interval_rules WHERE rule_set_id=$1 ORDER BY category_id, capacity_band_id', [id])).rows;
    const sl = (await tx.query('SELECT step, max_hours FROM workflow_slas WHERE rule_set_id=$1 ORDER BY step', [id])).rows;
    return {
      mpe: mpe.map((r) => ({ categoryId: r.category_id, capacityBandId: r.capacity_band_id, accuracyClassId: r.accuracy_class_id, direction: r.direction, value: r.value, unit: r.unit, marginalPct: r.marginal_pct })),
      intervals: iv.map((r) => ({ categoryId: r.category_id, capacityBandId: r.capacity_band_id, months: r.months, marginalMonths: r.marginal_months, graceDays: r.grace_days, applicationWindowDays: r.application_window_days })),
      slas: sl.map((r) => ({ step: r.step, maxHours: r.max_hours })),
    };
  }
  private async meta(tx: Tx, id: string, lock = false) {
    const r = (await tx.query(`SELECT rs.*, (SELECT count(*)::int FROM applications a WHERE a.rule_set_id=rs.id) AS pinned FROM rule_sets rs WHERE rs.id=$1 ${lock ? 'FOR UPDATE OF rs' : ''}`, [id])).rows[0];
    if (!r) throw notFound(); return r;
  }
  private async names(tx: Tx) {
    const cat = (await tx.query('SELECT id, name_en FROM categories')).rows; const cls = (await tx.query('SELECT id, code FROM accuracy_classes')).rows; const band = (await tx.query('SELECT id, category_id, min_capacity::text AS mn, max_capacity::text AS mx, unit FROM capacity_bands')).rows;
    return { categories: Object.fromEntries(cat.map((r) => [r.id, r.name_en])), classes: Object.fromEntries(cls.map((r) => [r.id, r.code])), bands: Object.fromEntries(band.map((r) => [r.id, { categoryId: r.category_id, label: `${Number(r.mn)}-${Number(r.mx)} ${r.unit}` }])) };
  }
  private async person(id: string | null) {
    if (!id) return null; const r = await this.db.system(async (tx) => (await tx.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [id])).rows[0]); return r ? this.crypto.decStr(r.full_name_enc) : null;
  }
  private shape = async (r: Record<string, any>) => ({ id: r.id as string, version: r.version as number, status: r.status as string, effectiveFrom: dstr(r.effective_from)!, effectiveTo: dstr(r.effective_to), note: r.note as string | null, reviewRemark: r.review_remark as string | null,
    authoredBy: await this.person(r.authored_by), authoredById: r.authored_by as string | null, reviewedBy: await this.person(r.reviewed_by), reviewedById: r.reviewed_by as string | null, publishedAt: r.published_at as Date | null, submittedAt: r.submitted_at as Date | null, pinnedCases: (r.pinned as number) ?? 0 });

  async list() {
    const rows = await this.db.forUser(async (tx) => (await tx.query(`SELECT rs.*, (SELECT count(*)::int FROM applications a WHERE a.rule_set_id=rs.id) AS pinned,
      (SELECT count(*)::int FROM mpe_rules m WHERE m.rule_set_id=rs.id) AS mpe_n, (SELECT count(*)::int FROM interval_rules m WHERE m.rule_set_id=rs.id) AS iv_n FROM rule_sets rs ORDER BY rs.version DESC`)).rows);
    return { items: await Promise.all(rows.map(async (r) => ({ ...(await this.shape(r)), mpeRows: r.mpe_n as number, intervalRows: r.iv_n as number }))) };
  }

  /** `against` defaults to the rule set in force today, so the screen shows what would change. */
  async detail(user: SessionUser, id: string, against?: string, now = new Date()) {
    return this.db.forUser(async (tx) => {
      const m = await this.meta(tx, id); const content = await this.content(tx, id);
      const baseId = against ?? (await tx.query(`SELECT id FROM rule_sets WHERE status IN ('PUBLISHED','RETIRED') AND id <> $2 AND effective_from <= $1::date ORDER BY effective_from DESC LIMIT 1`, [istDay(now), id])).rows[0]?.id as string | undefined;
      const base = baseId ? await this.content(tx, baseId) : null; const baseMeta = baseId ? await this.meta(tx, baseId) : null;
      return { ...(await this.shape(m)), content, names: await this.names(tx), diff: base ? diffRules(base, content) : null, comparedWith: baseMeta ? { id: baseId, version: baseMeta.version as number } : null,
        coverageGaps: base ? missingCoverage(base, content) : null, canEdit: m.status === 'DRAFT' };
    });
  }

  /** New draft: a copy of `copyFromId` (default: the rule set in force) so only the changes have to be typed. */
  async create(user: SessionUser, copyFromId: string | undefined, effectiveFrom: string, now = new Date()) {
    if (effectiveFrom < tomorrow(now)) throw unprocessable('EFFECTIVE_DATE_IN_PAST');
    return this.db.forUser(async (tx) => {
      if ((await tx.query(`SELECT 1 FROM rule_sets WHERE status IN ('DRAFT','IN_REVIEW')`)).rowCount) throw conflict('DRAFT_ALREADY_EXISTS');   // one change in flight at a time keeps reviews simple
      const src = copyFromId ?? (await tx.query(`SELECT id FROM rule_sets WHERE status IN ('PUBLISHED','RETIRED') ORDER BY effective_from DESC LIMIT 1`)).rows[0]?.id;
      const id = (await tx.query(`INSERT INTO rule_sets (version, status, effective_from, authored_by, note) VALUES ((SELECT COALESCE(max(version),0)+1 FROM rule_sets),'DRAFT',$1,$2,$3) RETURNING id`, [effectiveFrom, user.userId, src ? 'Copied from an earlier version' : null])).rows[0].id as string;
      if (src) {
        await tx.query(`INSERT INTO mpe_rules (rule_set_id, category_id, capacity_band_id, accuracy_class_id, direction, value, unit, marginal_pct) SELECT $1, category_id, capacity_band_id, accuracy_class_id, direction, value, unit, marginal_pct FROM mpe_rules WHERE rule_set_id=$2`, [id, src]);
        await tx.query(`INSERT INTO interval_rules (rule_set_id, category_id, capacity_band_id, months, marginal_months, grace_days, application_window_days) SELECT $1, category_id, capacity_band_id, months, marginal_months, grace_days, application_window_days FROM interval_rules WHERE rule_set_id=$2`, [id, src]);
        await tx.query(`INSERT INTO workflow_slas (rule_set_id, step, max_hours) SELECT $1, step, max_hours FROM workflow_slas WHERE rule_set_id=$2`, [id, src]);
      }
      await this.audit.record(tx, { action: 'rules.draft_created', entityType: 'rule_set', entityId: id, details: { copiedFrom: src ?? null } });
      return { id };
    });
  }

  async saveDraft(user: SessionUser, id: string, d: Draft, now = new Date()) {
    if (d.effectiveFrom < tomorrow(now)) throw unprocessable('EFFECTIVE_DATE_IN_PAST');
    const dup = (keys: string[]) => keys.length !== new Set(keys).size;
    if (dup(d.mpe.map((r) => `${r.categoryId}|${r.capacityBandId}|${r.accuracyClassId}`)) || dup(d.intervals.map((r) => `${r.categoryId}|${r.capacityBandId}`)) || dup(d.slas.map((r) => r.step))) throw unprocessable('DUPLICATE_ROWS');
    return this.db.forUser(async (tx) => {
      const m = await this.meta(tx, id, true); if (m.status !== 'DRAFT') throw conflict('NOT_A_DRAFT');
      // Every row must point at real master data, and the band must belong to the category.
      const bad = (await tx.query(
        `SELECT count(*)::int AS n FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(cat, band, cls)
         WHERE NOT EXISTS (SELECT 1 FROM capacity_bands b WHERE b.id=t.band AND b.category_id=t.cat) OR (t.cls IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accuracy_classes c WHERE c.id=t.cls))`,
        [[...d.mpe.map((r) => r.categoryId), ...d.intervals.map((r) => r.categoryId)], [...d.mpe.map((r) => r.capacityBandId), ...d.intervals.map((r) => r.capacityBandId)], [...d.mpe.map((r) => r.accuracyClassId), ...d.intervals.map(() => null)]])).rows[0].n as number;
      if (bad) throw unprocessable('INVALID_REFERENCE', { rows: bad });
      await tx.query('DELETE FROM mpe_rules WHERE rule_set_id=$1', [id]); await tx.query('DELETE FROM interval_rules WHERE rule_set_id=$1', [id]); await tx.query('DELETE FROM workflow_slas WHERE rule_set_id=$1', [id]);
      for (const r of d.mpe) await tx.query('INSERT INTO mpe_rules (rule_set_id, category_id, capacity_band_id, accuracy_class_id, direction, value, unit, marginal_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, r.categoryId, r.capacityBandId, r.accuracyClassId, r.direction, r.value, r.unit, r.marginalPct]);
      for (const r of d.intervals) await tx.query('INSERT INTO interval_rules (rule_set_id, category_id, capacity_band_id, months, marginal_months, grace_days, application_window_days) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, r.categoryId, r.capacityBandId, r.months, r.marginalMonths, r.graceDays, r.applicationWindowDays]);
      for (const r of d.slas) await tx.query('INSERT INTO workflow_slas (rule_set_id, step, max_hours) VALUES ($1,$2,$3)', [id, r.step, r.maxHours]);
      await tx.query('UPDATE rule_sets SET effective_from=$2, effective_to=$3, note=COALESCE($4, note), authored_by=COALESCE(authored_by,$5) WHERE id=$1', [id, d.effectiveFrom, d.effectiveTo ?? null, d.note ?? null, user.userId]);
      await this.audit.record(tx, { action: 'rules.draft_saved', entityType: 'rule_set', entityId: id, details: { mpe: d.mpe.length, intervals: d.intervals.length, slas: d.slas.length } });
      return { id, saved: true };
    });
  }

  async discard(user: SessionUser, id: string) {
    return this.db.forUser(async (tx) => {
      const m = await this.meta(tx, id, true); if (m.status !== 'DRAFT' && m.status !== 'IN_REVIEW') throw conflict('CANNOT_DISCARD');
      for (const t of ['mpe_rules', 'interval_rules', 'workflow_slas']) await tx.query(`DELETE FROM ${t} WHERE rule_set_id=$1`, [id]);
      await tx.query('DELETE FROM rule_sets WHERE id=$1', [id]);
      await this.audit.record(tx, { action: 'rules.draft_discarded', entityType: 'rule_set', entityId: id, details: { version: m.version } });
      return { ok: true };
    });
  }

  async requestReview(user: SessionUser, id: string) {
    const out = await this.db.forUser(async (tx) => {
      const m = await this.meta(tx, id, true); if (m.status !== 'DRAFT') throw conflict('NOT_A_DRAFT');
      const c = await this.content(tx, id); if (!c.mpe.length || !c.intervals.length || !c.slas.length) throw unprocessable('RULES_INCOMPLETE');
      const base = (await tx.query(`SELECT id FROM rule_sets WHERE status IN ('PUBLISHED','RETIRED') ORDER BY effective_from DESC LIMIT 1`)).rows[0]?.id as string | undefined;
      if (base) { const gaps = missingCoverage(await this.content(tx, base), c); if (gaps.mpe.length || gaps.intervals.length || gaps.slas.length) throw unprocessable('COVERAGE_GAPS', { gaps }); }
      await tx.query(`UPDATE rule_sets SET status='IN_REVIEW', submitted_at=now(), reviewed_by=NULL, reviewed_at=NULL, review_remark=NULL, authored_by=$2 WHERE id=$1`, [id, user.userId]);
      await this.audit.record(tx, { action: 'rules.review_requested', entityType: 'rule_set', entityId: id, details: { version: m.version } });
      return { id, status: 'IN_REVIEW', version: m.version as number };
    });
    await this.notif.notifyRole('ADMIN', 'RULESET_REVIEW_REQUESTED', { version: String(out.version) }, `/admin/rules?open=${id}`);
    return { id: out.id, status: out.status };
  }

  async review(user: SessionUser, id: string, input: z.infer<typeof ruleReviewSchema>) {
    return this.db.forUser(async (tx) => {
      const m = await this.meta(tx, id, true); if (m.status !== 'IN_REVIEW') throw conflict('NOT_IN_REVIEW');
      if (m.authored_by === user.userId) throw new AppError(403, 'REVIEWER_MUST_DIFFER');
      if (input.outcome === 'RETURN') await tx.query(`UPDATE rule_sets SET status='DRAFT', review_remark=$2, reviewed_by=NULL WHERE id=$1`, [id, input.remark ?? null]);
      else await tx.query(`UPDATE rule_sets SET reviewed_by=$2, reviewed_at=now(), review_remark=$3 WHERE id=$1`, [id, user.userId, input.remark ?? null]);
      await this.audit.record(tx, { action: input.outcome === 'APPROVE' ? 'rules.review_approved' : 'rules.review_returned', entityType: 'rule_set', entityId: id, details: { version: m.version } });
      return { id, status: input.outcome === 'APPROVE' ? 'IN_REVIEW' : 'DRAFT', approved: input.outcome === 'APPROVE' };
    });
  }

  /** Read-only: what publishing would do. The same check runs again inside publish. */
  async preflight(user: SessionUser, id: string, now = new Date()) {
    return this.db.forUser((tx) => this.overlapPlan(tx, id, now));
  }
  private async overlapPlan(tx: Tx, id: string, now: Date) {
    const m = await this.meta(tx, id);
    const from = dstr(m.effective_from)!; const to = dstr(m.effective_to);
    const others = (await tx.query(`SELECT id, version, effective_from, effective_to FROM rule_sets WHERE status='PUBLISHED' AND id <> $1`, [id])).rows;
    const closes: { id: string; version: number; newEffectiveTo: string }[] = []; const blocks: { id: string; version: number; effectiveFrom: string; effectiveTo: string | null }[] = [];
    for (const o of others) {
      const of = dstr(o.effective_from)!; const ot = dstr(o.effective_to);
      if (!rangesOverlap(from, to, of, ot)) continue;
      // An open-ended set that began earlier is simply closed on the day the new one starts. Anything else is a real clash.
      if (ot === null && of < from) closes.push({ id: o.id, version: o.version, newEffectiveTo: from }); else blocks.push({ id: o.id, version: o.version, effectiveFrom: of, effectiveTo: ot });
    }
    return { from, to, closes, blocks, inPast: from < tomorrow(now), publishable: m.status === 'IN_REVIEW' && !!m.reviewed_by && !blocks.length && from >= tomorrow(now) };
  }

  async publish(user: SessionUser, id: string, now = new Date()) {
    const out = await this.db.forUser(async (tx) => {
      const m = await this.meta(tx, id, true);
      if (m.status !== 'IN_REVIEW') throw conflict('NOT_IN_REVIEW'); if (!m.reviewed_by) throw conflict('REVIEW_REQUIRED');
      const plan = await this.overlapPlan(tx, id, now);
      if (plan.inPast) throw unprocessable('EFFECTIVE_DATE_IN_PAST');
      if (plan.blocks.length) throw conflict('RULE_OVERLAP', { overlaps: plan.blocks });
      for (const c of plan.closes) await tx.query('UPDATE rule_sets SET effective_to=$2 WHERE id=$1', [c.id, c.newEffectiveTo]);
      try { await tx.query(`UPDATE rule_sets SET status='PUBLISHED', published_at=now() WHERE id=$1`, [id]); }
      catch (e) { if ((e as { code?: string }).code === '23P01') throw conflict('RULE_OVERLAP'); throw e; }   // the database refuses overlaps even if two admins publish at once
      await this.audit.record(tx, { action: 'rules.published', entityType: 'rule_set', entityId: id, details: { version: m.version, effectiveFrom: plan.from, closed: plan.closes.map((c) => c.version) } });
      return { id, version: m.version as number, from: plan.from, closed: plan.closes };
    });
    await this.notif.notifyRole('ADMIN', 'RULESET_PUBLISHED', { version: String(out.version), from: out.from }, `/admin/rules?open=${id}`);
    return { id: out.id, status: 'PUBLISHED', version: out.version, effectiveFrom: out.from, closedVersions: out.closed.map((c) => c.version) };
  }

  /** Move published sets whose end date has passed to RETIRED. They stay readable for pinned cases. */
  async retireEnded(now = new Date()): Promise<number> {
    return this.db.system(async (tx) => (await tx.query(`UPDATE rule_sets SET status='RETIRED' WHERE status='PUBLISHED' AND effective_to IS NOT NULL AND effective_to <= $1::date`, [istDay(now)])).rowCount ?? 0);
  }
}
