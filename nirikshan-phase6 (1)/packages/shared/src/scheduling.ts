/**
 * Pure scheduling and date rules. No database, no clock: everything a test needs is passed in.
 * Days are 'YYYY-MM-DD' strings in India Standard Time (UTC+05:30, no daylight saving).
 */
export const IST_OFFSET_MIN = 330;

export interface SchedulingSettings {
  weights: Weights; autoThreshold: number; dayStartHour: number; dayEndHour: number; slotHours: number; workingDays: number[]; maxFailedAttempts: number; horizonDays: number;
}
export interface Weights { workload: number; distance: number; specialisation: number; success: number; noRepeat: number }
export const DEFAULT_WEIGHTS: Weights = { workload: 35, distance: 25, specialisation: 15, success: 10, noRepeat: 15 };

const MS_DAY = 86_400_000;
const parseDay = (d: string) => { const [y, m, dd] = d.split('-').map(Number) as [number, number, number]; return Date.UTC(y, m - 1, dd); };
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string { return fmtDay(parseDay(day) + n * MS_DAY); }
export function daysBetween(from: string, to: string): number { return Math.round((parseDay(to) - parseDay(from)) / MS_DAY); }
/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function isoWeekday(day: string): number { const w = new Date(parseDay(day)).getUTCDay(); return w === 0 ? 7 : w; }
/** Today's date in IST for a given instant. */
export function istDay(at: Date): string { return fmtDay(at.getTime() + IST_OFFSET_MIN * 60_000); }
/** The UTC instant of a given IST wall-clock hour on a given IST day. */
export function istInstant(day: string, hour: number): Date { return new Date(parseDay(day) + hour * 3_600_000 - IST_OFFSET_MIN * 60_000); }
/** The IST day an instant falls on. */
export const dayOf = istDay;

export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months; const ny = Math.floor(total / 12); const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return fmtDay(Date.UTC(ny, nm, Math.min(d, last)));
}

export interface Slot { start: Date; end: Date; index: number }
/** The bookable slots of a working day, e.g. 10-12, 12-14, 14-16, 16-18. */
export function slotsForDay(day: string, s: Pick<SchedulingSettings, 'dayStartHour' | 'dayEndHour' | 'slotHours'>): Slot[] {
  const out: Slot[] = [];
  for (let h = s.dayStartHour, i = 0; h + s.slotHours <= s.dayEndHour; h += s.slotHours, i++) out.push({ start: istInstant(day, h), end: istInstant(day, h + s.slotHours), index: i });
  return out;
}
export function isWorkingDay(day: string, s: Pick<SchedulingSettings, 'workingDays'>, holidays: ReadonlySet<string>): boolean {
  return s.workingDays.includes(isoWeekday(day)) && !holidays.has(day);
}

// ------------------------------------------------------------------ scoring
export interface ScoreInput {
  /** Visits already booked in the planning horizon divided by capacity over the same days, 0 (free) to 1 (full). */
  loadRatio: number;
  /** Straight-line km between the inspector's base and the premises; null when either location is unknown. */
  distanceKm: number | null;
  /** Fallback when coordinates are missing: 1 same ward, 0.75 same circle, 0.5 same zone, 0.25 same division, 0 otherwise. */
  areaProximity: number;
  /** Number of categories the inspector is certified for (fewer means more specialised). */
  skillCount: number;
  completedVisits: number; noShowVisits: number;
  /** The same inspector did the previous visit on this instrument (we prefer a fresh pair of eyes). */
  inspectedLastTime: boolean;
}
export interface ScorePart { raw: number; weight: number; points: number }
export interface ScoreBreakdown { total: number; parts: Record<keyof Weights, ScorePart> }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 1 at 0 km, 0 at 40 km or more. */
export const distanceFactor = (km: number) => clamp01(1 - km / 40);

export function scoreCandidate(i: ScoreInput, w: Weights = DEFAULT_WEIGHTS): ScoreBreakdown {
  const raw: Record<keyof Weights, number> = {
    workload: clamp01(1 - i.loadRatio),
    distance: i.distanceKm === null ? clamp01(i.areaProximity) : distanceFactor(i.distanceKm),
    specialisation: i.skillCount <= 0 ? 0 : clamp01(1 / i.skillCount) * 0.5 + 0.5, // certified at all = 0.5, a narrow specialist approaches 1
    success: i.completedVisits + i.noShowVisits === 0 ? 0.5 : clamp01(i.completedVisits / (i.completedVisits + i.noShowVisits)),
    noRepeat: i.inspectedLastTime ? 0 : 1,
  };
  const sum = w.workload + w.distance + w.specialisation + w.success + w.noRepeat || 1;
  const parts = {} as Record<keyof Weights, ScorePart>; let total = 0;
  for (const k of Object.keys(raw) as (keyof Weights)[]) {
    const points = (raw[k] * w[k] * 100) / sum; // normalised so the maximum possible total is always 100
    parts[k] = { raw: round(raw[k]), weight: w[k], points: round(points) }; total += points;
  }
  return { total: round(total), parts };
}
const round = (n: number) => Math.round(n * 100) / 100;

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371; const rad = (d: number) => (d * Math.PI) / 180; const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return round(2 * R * Math.asin(Math.sqrt(x)));
}

// ------------------------------------------------------------------ due dates
export interface DueInput {
  type: 'NEW' | 'RE_VERIFICATION' | 'RENEWAL' | 'RE_TEST';
  today: string; registeredOn: string; firstVerifiedOn: string | null; validUntil: string | null;
  intervalMonths: number; windowDays: number; graceDays: number;
  /** Sum of the document-check, scheduling and decision SLAs in hours. */
  totalSlaHours: number;
}
export interface DueResult { dueDate: string; applyByDate: string; graceEndsOn: string; applyByPassed: boolean; overdue: boolean }
/**
 * Server-side due dates. dueDate is when verification should be complete; applyByDate is the last day to apply so that
 * the published SLAs still allow completion by then. Nothing here is a fee or a penalty amount.
 */
export function computeDueDates(i: DueInput): DueResult {
  let due: string;
  if (i.type === 'NEW') due = addDays(i.registeredOn, i.windowDays);
  else if (i.type === 'RE_TEST') due = addDays(i.today, i.windowDays);
  else if (i.validUntil) due = i.validUntil;
  else if (i.firstVerifiedOn) due = addMonths(i.firstVerifiedOn, i.intervalMonths);
  else due = addDays(i.today, i.windowDays);
  const applyBy = addDays(due, -Math.ceil(i.totalSlaHours / 24));
  return { dueDate: due, applyByDate: applyBy, graceEndsOn: addDays(due, i.graceDays), applyByPassed: i.today > applyBy, overdue: i.today > due };
}

// ------------------------------------------------------------------ SLA
export type SlaState = 'OK' | 'AT_RISK' | 'OVERDUE';
/** At risk once 75% of the allowed time has gone. */
export function slaState(startedAt: Date, maxHours: number, now: Date): { dueAt: Date; state: SlaState } {
  const dueAt = new Date(startedAt.getTime() + maxHours * 3_600_000); const used = (now.getTime() - startedAt.getTime()) / (maxHours * 3_600_000);
  return { dueAt, state: used >= 1 ? 'OVERDUE' : used >= 0.75 ? 'AT_RISK' : 'OK' };
}

// ------------------------------------------------------------------ document completeness
export interface DocState { typeId: string; review: 'PENDING' | 'ACCEPTED' | 'FLAGGED'; scan: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED' }
/** Why a case cannot be marked "document check complete" yet. Empty means it can. */
export function documentCheckBlockers(requiredTypeIds: string[], current: DocState[]): string[] {
  const out: string[] = [];
  for (const t of requiredTypeIds) {
    const d = current.find((x) => x.typeId === t);
    if (!d) out.push(`MISSING:${t}`); else if (d.scan !== 'CLEAN') out.push(`NOT_SCANNED:${t}`); else if (d.review !== 'ACCEPTED') out.push(`NOT_ACCEPTED:${t}`);
  }
  for (const d of current) if (!requiredTypeIds.includes(d.typeId) && d.review === 'FLAGGED') out.push(`FLAGGED:${d.typeId}`);
  return out;
}
