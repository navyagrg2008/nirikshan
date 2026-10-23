/**
 * Phase 4 pure functions: decimal-safe test calculation, checklist evaluation, approval guards, certificate numbers.
 * The API is the only place that calls these to produce a result; the web app calls the API and never calculates a verdict itself.
 * Numbers are handled as BigInt scaled by 1e6 (the database columns are numeric(18,6)), so there is no floating point anywhere.
 */

const SCALE = 1_000_000n;
const DEC_RE = /^-?\d{1,12}(\.\d{1,6})?$/;

export function isDecimalString(v: unknown): v is string { return typeof v === 'string' && DEC_RE.test(v.trim()); }
export function toScaled(v: string): bigint {
  const s = v.trim();
  if (!DEC_RE.test(s)) throw new Error('INVALID_DECIMAL');
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = s.replace('-', '').split('.');
  const n = BigInt(i) * SCALE + BigInt(f.padEnd(6, '0'));
  return neg ? -n : n;
}
export function fromScaled(n: bigint): string {
  const neg = n < 0n; const a = neg ? -n : n;
  const s = `${a / SCALE}.${(a % SCALE).toString().padStart(6, '0')}`;
  return (neg && a !== 0n ? '-' : '') + s;
}
const abs = (n: bigint) => (n < 0n ? -n : n);
/** a * b / c with half-away-from-zero rounding. */
function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  const num = a * b; const neg = (num < 0n) !== (c < 0n);
  const n = abs(num); const d = abs(c);
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

/** Test values are entered in the instrument's capacity unit; the permissible error is stated in a smaller unit. */
const FACTORS: Record<string, number> = { 'kg>g': 1000, 't>kg': 1000, 'L>mL': 1000, 'g>mg': 1000 };
export function unitFactor(from: string, to: string): bigint {
  if (from === to) return 1n;
  const f = FACTORS[`${from}>${to}`];
  if (!f) throw new Error('UNIT_MISMATCH');
  return BigInt(f);
}

export type Verdict = 'PASS' | 'MARGINAL_PASS' | 'FAIL';
export type MpeDirection = 'PLUS_MINUS' | 'PLUS' | 'MINUS';
export interface MpeInput { value: string; unit: string; direction: MpeDirection; marginalPct: string }
export interface TrialResult {
  trialNo: number; reference: string; observed: string; unit: string;
  errorValue: string; errorUnit: string; errorPct: string; mpeValue: string; verdict: Verdict;
}

/**
 * error = observed - reference (reported in the MPE unit); %error = error / reference * 100.
 * PLUS_MINUS: |error| <= MPE. PLUS: 0 <= error <= MPE. MINUS: -MPE <= error <= 0.
 * Marginal pass: inside the limit but at or above `marginalPct` percent of it.
 */
export function computeTrial(trialNo: number, reference: string, observed: string, capacityUnit: string, mpe: MpeInput): TrialResult {
  const ref = toScaled(reference); const obs = toScaled(observed);
  if (ref <= 0n) throw new Error('REFERENCE_MUST_BE_POSITIVE');
  if (obs < 0n) throw new Error('OBSERVED_MUST_NOT_BE_NEGATIVE');
  const factor = unitFactor(capacityUnit, mpe.unit);
  const err = (obs - ref) * factor;                       // scaled, in MPE unit
  const lim = toScaled(mpe.value);
  const pct = mulDiv(obs - ref, 100n * SCALE, ref);       // scaled percent of reference
  let within: boolean;
  if (mpe.direction === 'PLUS_MINUS') within = abs(err) <= lim;
  else if (mpe.direction === 'PLUS') within = err >= 0n && err <= lim;
  else within = err <= 0n && err >= -lim;
  let verdict: Verdict = 'FAIL';
  if (within) {
    // |err| * 100 >= marginalPct * lim. Both sides carry the scale squared, so the comparison is exact with no division.
    verdict = abs(err) * 100n * SCALE >= toScaled(mpe.marginalPct) * lim ? 'MARGINAL_PASS' : 'PASS';
  }
  return { trialNo, reference: fromScaled(ref), observed: fromScaled(obs), unit: capacityUnit, errorValue: fromScaled(err), errorUnit: mpe.unit, errorPct: fromScaled(pct), mpeValue: fromScaled(lim), verdict };
}

export function overallVerdict(v: Verdict[]): Verdict | null {
  if (!v.length) return null;
  if (v.includes('FAIL')) return 'FAIL';
  return v.includes('MARGINAL_PASS') ? 'MARGINAL_PASS' : 'PASS';
}

// ---------------------------------------------------------------------------------------------- validity
export function addMonthsISO(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months; const ny = y + Math.floor(total / 12); const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export interface IntervalInput { months: number; marginalMonths: number | null }
/** Officers may shorten the validity but never extend it beyond the rule. A marginal pass is capped at the marginal interval. */
export function validityRange(overall: Verdict, rule: IntervalInput): { min: number; max: number; default: number } {
  const max = overall === 'MARGINAL_PASS' && rule.marginalMonths ? rule.marginalMonths : rule.months;
  return { min: 1, max, default: max };
}

// ---------------------------------------------------------------------------------------------- checklist
export interface ChecklistItem { code: string; textEn: string; textHi?: string; critical: boolean; required: boolean; pass: 'YES' | 'NO'; hintEn?: string; onlyAutomatic?: boolean }
export type ChecklistAnswer = { answer: 'YES' | 'NO' | 'NA'; remark?: string };
export interface ChecklistEvaluation { missing: string[]; needRemark: string[]; failed: string[]; failedCritical: string[]; invalidNA: string[] }
export function evaluateChecklist(items: ChecklistItem[], answers: Record<string, ChecklistAnswer | undefined>): ChecklistEvaluation {
  const out: ChecklistEvaluation = { missing: [], needRemark: [], failed: [], failedCritical: [], invalidNA: [] };
  for (const it of items) {
    const a = answers[it.code];
    if (!a) { if (it.required) out.missing.push(it.code); continue; }
    if (a.answer === 'NA') { if (it.critical || it.required) out.invalidNA.push(it.code); continue; }
    if (a.answer !== it.pass) {
      out.failed.push(it.code); if (it.critical) out.failedCritical.push(it.code);
      if (!a.remark || a.remark.trim().length < 3) out.needRemark.push(it.code);
    }
  }
  return out;
}

export type Recommendation = 'RECOMMEND_APPROVE' | 'RECOMMEND_REJECT' | 'RE_INSPECT';
/** The server decides what the inspector may recommend. Approve is closed when any trial fails or a critical checklist item fails. */
export function allowedRecommendations(overall: Verdict | null, failedCritical: string[]): { allowed: Recommendation[]; suggested: Recommendation | null } {
  if (overall === 'FAIL' || failedCritical.length) return { allowed: ['RECOMMEND_REJECT', 'RE_INSPECT'], suggested: 'RECOMMEND_REJECT' };
  return { allowed: ['RECOMMEND_APPROVE', 'RECOMMEND_REJECT', 'RE_INSPECT'], suggested: overall ? 'RECOMMEND_APPROVE' : null };
}

// ---------------------------------------------------------------------------------------------- geofence
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000; const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------------------------- approval guards
export interface ApprovalFacts {
  documentsComplete: boolean; visitSubmitted: boolean; trialCount: number; minTrials: number;
  overall: Verdict | null; recommendation: Recommendation | null; evidenceKinds: string[]; requiredEvidence: string[];
  evidenceInfected: boolean; checklistFailedCritical: string[]; hasStickerSerial: boolean;
}
export type Blocker = 'DOCUMENTS_INCOMPLETE' | 'INSPECTION_MISSING' | 'TRIALS_MISSING' | 'MPE_FAILED' | 'EVIDENCE_MISSING' | 'EVIDENCE_UNSAFE'
  | 'CRITICAL_ITEM_FAILED' | 'INSPECTOR_RECOMMENDED_AGAINST' | 'STICKER_MISSING';
/** Why an approval is blocked. An empty list means the case may be approved. Each code has a translated sentence in the web app. */
export function approvalBlockers(f: ApprovalFacts): { code: Blocker; detail?: string }[] {
  const b: { code: Blocker; detail?: string }[] = [];
  if (!f.documentsComplete) b.push({ code: 'DOCUMENTS_INCOMPLETE' });
  if (!f.visitSubmitted) { b.push({ code: 'INSPECTION_MISSING' }); return b; }
  if (f.trialCount < f.minTrials) b.push({ code: 'TRIALS_MISSING', detail: `${f.trialCount}/${f.minTrials}` });
  if (f.overall === 'FAIL') b.push({ code: 'MPE_FAILED' });
  const missing = f.requiredEvidence.filter((k) => !f.evidenceKinds.includes(k));
  if (missing.length) b.push({ code: 'EVIDENCE_MISSING', detail: missing.join(',') });
  if (f.evidenceInfected) b.push({ code: 'EVIDENCE_UNSAFE' });
  if (f.checklistFailedCritical.length) b.push({ code: 'CRITICAL_ITEM_FAILED', detail: f.checklistFailedCritical.join(',') });
  if (f.recommendation && f.recommendation !== 'RECOMMEND_APPROVE') b.push({ code: 'INSPECTOR_RECOMMENDED_AGAINST', detail: f.recommendation });
  if (!f.hasStickerSerial) b.push({ code: 'STICKER_MISSING' });
  return b;
}

// ---------------------------------------------------------------------------------------------- certificate number and QR token
export function divisionCode(areaCode: string): string { return areaCode.replace(/^DIV-?/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'GEN'; }
export function formatCertNo(div: string, year: number, seq: number): string { return `NRK/CERT/${div}/${year}/${String(seq).padStart(6, '0')}`; }
export const CERT_NO_RE = /^NRK\/CERT\/[A-Z0-9]{1,6}\/\d{4}\/\d{6,}$/;
/** The number contains slashes, so the QR link carries a path-safe form of it. */
export const certNoToSlug = (n: string) => n.replace(/\//g, '-');
export function slugToCertNo(s: string): string | null {
  const m = /^NRK-CERT-([A-Z0-9]{1,6})-(\d{4})-(\d{6,})$/.exec(s);
  return m ? `NRK/CERT/${m[1]}/${m[2]}/${m[3]}` : null;
}
/** `/v/{slug}.{sig}`; sig is 22 URL-safe characters. */
export function parseQrToken(token: string): { certNo: string; sig: string } | null {
  const i = token.lastIndexOf('.'); if (i < 0) return null;
  const certNo = slugToCertNo(token.slice(0, i)); const sig = token.slice(i + 1);
  if (!certNo || !/^[A-Za-z0-9_-]{22}$/.test(sig)) return null;
  return { certNo, sig };
}
