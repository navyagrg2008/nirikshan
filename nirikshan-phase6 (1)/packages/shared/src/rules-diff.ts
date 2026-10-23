/** Content of one rule set, as the admin screens and the API both see it. */
export interface MpeRow { categoryId: string; capacityBandId: string; accuracyClassId: string; direction: 'PLUS_MINUS' | 'PLUS' | 'MINUS'; value: string; unit: string; marginalPct: string }
export interface IntervalRow { categoryId: string; capacityBandId: string; months: number; marginalMonths: number | null; graceDays: number; applicationWindowDays: number }
export interface SlaRow { step: string; maxHours: number }
export interface RuleContent { mpe: MpeRow[]; intervals: IntervalRow[]; slas: SlaRow[] }

export interface Change<T> { key: string; from: T; to: T; fields: string[] }
export interface Section<T> { added: T[]; removed: T[]; changed: Change<T>[] }
export interface RuleDiff { mpe: Section<MpeRow>; intervals: Section<IntervalRow>; slas: Section<SlaRow>; counts: { added: number; removed: number; changed: number } }

export const mpeKey = (r: Pick<MpeRow, 'categoryId' | 'capacityBandId' | 'accuracyClassId'>) => `${r.categoryId}|${r.capacityBandId}|${r.accuracyClassId}`;
export const intervalKey = (r: Pick<IntervalRow, 'categoryId' | 'capacityBandId'>) => `${r.categoryId}|${r.capacityBandId}`;
export const slaKey = (r: Pick<SlaRow, 'step'>) => r.step;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = typeof a === 'string' ? Number(a) : a; const nb = typeof b === 'string' ? Number(b) : b;
  return typeof na === 'number' && typeof nb === 'number' && !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}
function section<T extends object>(from: T[], to: T[], key: (r: T) => string, fields: (keyof T & string)[]): Section<T> {
  const f = new Map(from.map((r) => [key(r), r])); const t = new Map(to.map((r) => [key(r), r]));
  const out: Section<T> = { added: [], removed: [], changed: [] };
  for (const [k, r] of t) { const o = f.get(k); if (!o) { out.added.push(r); continue; } const diff = fields.filter((x) => !same(o[x], r[x])); if (diff.length) out.changed.push({ key: k, from: o, to: r, fields: diff }); }
  for (const [k, r] of f) if (!t.has(k)) out.removed.push(r);
  return out;
}
/** What changes if `to` replaces `from`. Numbers compare by value, so "5" and "5.000000" are the same. */
export function diffRules(from: RuleContent, to: RuleContent): RuleDiff {
  const mpe = section(from.mpe, to.mpe, mpeKey, ['direction', 'value', 'unit', 'marginalPct']);
  const intervals = section(from.intervals, to.intervals, intervalKey, ['months', 'marginalMonths', 'graceDays', 'applicationWindowDays']);
  const slas = section(from.slas, to.slas, slaKey, ['maxHours']);
  const all = [mpe, intervals, slas] as Section<object>[];
  return { mpe, intervals, slas, counts: { added: all.reduce((n, s) => n + s.added.length, 0), removed: all.reduce((n, s) => n + s.removed.length, 0), changed: all.reduce((n, s) => n + s.changed.length, 0) } };
}

/** Combinations the old rule set answered for and the new one does not: publishing would leave those instruments without a rule. */
export function missingCoverage(base: RuleContent, next: RuleContent): { mpe: string[]; intervals: string[]; slas: string[] } {
  const miss = <T,>(a: T[], b: T[], k: (r: T) => string) => { const have = new Set(b.map(k)); return a.map(k).filter((x) => !have.has(x)); };
  return { mpe: miss(base.mpe, next.mpe, mpeKey), intervals: miss(base.intervals, next.intervals, intervalKey), slas: miss(base.slas, next.slas, slaKey) };
}

/** Whether two [from, to) date ranges overlap. `to` null means open-ended. Dates are YYYY-MM-DD. */
export function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  return aFrom < (bTo ?? '9999-12-31') && bFrom < (aTo ?? '9999-12-31');
}
