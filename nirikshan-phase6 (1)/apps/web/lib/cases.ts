import type { Lang } from './i18n';

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'info';
const S: Record<string, [string, string, Tone]> = {
  APPLIED: ['Applied', 'आवेदन किया', 'info'], DOCUMENT_CHECKED: ['Documents checked', 'दस्तावेज़ जाँचे गए', 'info'], SCHEDULED: ['Visit scheduled', 'दौरा निर्धारित', 'ok'], INSPECTION_IN_PROGRESS: ['Inspection in progress', 'निरीक्षण जारी', 'info'],
  FAILED_ATTEMPT: ['Visit not completed', 'दौरा पूरा नहीं हुआ', 'warn'], INSPECTED: ['Inspected', 'निरीक्षण हो गया', 'info'], REFERRED: ['Referred', 'वरिष्ठ को भेजा', 'warn'], APPROVED: ['Approved', 'स्वीकृत', 'ok'],
  REJECTED: ['Rejected', 'अस्वीकृत', 'danger'], CERTIFICATE_ISSUED: ['Certificate issued', 'प्रमाणपत्र जारी', 'ok'], CANCELLED: ['Cancelled', 'रद्द', 'muted'], APPLICATION_EXPIRED: ['Expired', 'समाप्त', 'muted'],
};
export const statusLabel = (s: string, lang: Lang) => (S[s]?.[lang === 'hi' ? 1 : 0] ?? s);
export const statusTone2 = (s: string): Tone => S[s]?.[2] ?? 'muted';
export const STATUSES = Object.keys(S);

const T: Record<string, [string, string]> = { NEW: ['New verification', 'नया सत्यापन'], RE_VERIFICATION: ['Re-verification', 'पुनः सत्यापन'], RENEWAL: ['Renewal', 'नवीनीकरण'], RE_TEST: ['Re-test', 'पुनः परीक्षण'] };
export const typeLabel = (s: string, lang: Lang) => T[s]?.[lang === 'hi' ? 1 : 0] ?? s;

export const STEPS: Record<string, [string, string]> = { applied: ['Applied', 'आवेदन'], documents: ['Documents', 'दस्तावेज़'], scheduling: ['Scheduling', 'समय तय'], visit: ['Visit', 'दौरा'], decision: ['Decision', 'निर्णय'], certificate: ['Certificate', 'प्रमाणपत्र'] };

const A: Record<string, [string, string]> = {
  apply: ['Application submitted', 'आवेदन जमा हुआ'], documentCheckComplete: ['Documents checked', 'दस्तावेज़ जाँचे गए'], assign: ['Visit scheduled', 'दौरा निर्धारित हुआ'], reschedule: ['Visit moved', 'दौरा बदला गया'], noShow: ['Visit could not be completed', 'दौरा पूरा नहीं हुआ'],
  cancel: ['Application cancelled', 'आवेदन रद्द हुआ'], 'document.flagged': ['A document needs attention', 'एक दस्तावेज़ पर ध्यान दें'], 'document.accepted': ['A document was accepted', 'एक दस्तावेज़ स्वीकार हुआ'], 'reschedule.requested': ['Reschedule requested', 'पुनर्निर्धारण का अनुरोध'],
  'reschedule.rejected': ['Reschedule request declined', 'पुनर्निर्धारण अनुरोध अस्वीकृत'], 'schedule.review_needed': ['Waiting for officer to confirm visit time', 'अधिकारी द्वारा दौरे के समय की पुष्टि प्रतीक्षित'],
};
export const actionLabel = (s: string, lang: Lang) => A[s]?.[lang === 'hi' ? 1 : 0] ?? s;

const R: Record<string, string> = {
  NO_CANDIDATE: 'No inspector is free in the booking window', OUTSIDE_SLA: 'The first free slot is later than the scheduling deadline', LOW_SCORE: 'Best match scored below the automatic-assignment threshold', OWNER_PREFERENCE_UNMET: "Owner's preferred dates are not available",
};
export const reasonLabel = (s: string) => R[s] ?? s;
export const PART_LABEL: Record<string, string> = { workload: 'Workload', distance: 'Distance', specialisation: 'Skill fit', success: 'Completion record', noRepeat: 'Fresh inspector' };

const IST = 'Asia/Kolkata'; const loc = (l: Lang) => (l === 'hi' ? 'hi-IN' : 'en-IN');
export const fmtDateTime = (s: string | null | undefined, lang: Lang = 'en') => (s ? new Date(s).toLocaleString(loc(lang), { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDay = (s: string | null | undefined, lang: Lang = 'en') => (s ? new Date(s.length === 10 ? s + 'T12:00:00+05:30' : s).toLocaleDateString(loc(lang), { timeZone: IST, weekday: 'short', day: '2-digit', month: 'short' }) : '—');
export const fmtTime = (s: string, lang: Lang = 'en') => new Date(s).toLocaleTimeString(loc(lang), { timeZone: IST, hour: '2-digit', minute: '2-digit' });
export const fmtWindow = (a: string, b: string, lang: Lang = 'en') => `${fmtDay(a, lang)}, ${fmtTime(a, lang)} – ${fmtTime(b, lang)}`;
export const istDayOf = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const addDaysStr = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
/** `datetime-local` value (what the person typed, in IST) to an ISO instant. */
export const istLocalToIso = (v: string) => new Date(v + ':00+05:30').toISOString();

export interface OwnerDoc { id: string; code: string; nameEn: string; nameHi: string | null; required: boolean; maxSizeMb: number; current: null | { id: string; version: number; scan: string; review: 'PENDING' | 'ACCEPTED' | 'FLAGGED'; comment: string | null; reasonCode: string | null; mimeType: string; sizeBytes: number; uploadedAt: string }; history?: { id: string; version: number; review: string; superseded: boolean; uploadedAt: string }[] }
export interface AppDetail {
  id: string; applicationNo: string; status: string; type: string; version: number; dueDate: string | null; applyByDate: string | null; createdAt: string; failedAttempts: number; cancelReason: string | null;
  instrument: { id: string; instrumentNo: string; serialNo: string; make: string; category: string }; area: { id: string; name: string }; preferred: { from: string; to: string } | null; accessHours: string | null;
  stepper: { steps: string[]; current: number; terminal: boolean }; documents: OwnerDoc[]; documentsComplete: boolean;
  visit: null | { id: string; status: string; start: string; end: string; inspectorId?: string; breakdown?: Breakdown | null; outOfJurisdiction?: boolean; assignedBy?: string | null };
  waitingForOfficer: boolean; rescheduleRequest: null | { id: string; reason: string; preferredFrom: string; preferredTo: string | null; status: string; note: string | null; createdAt: string };
  timeline: { action: string; from: string | null; to: string; at: string; remark?: string | null }[];
  allowed: { cancel: boolean; uploadDocuments: boolean; requestReschedule: boolean };
  scheduleMode?: string | null; readyAt?: string | null; proposal?: null | { id: string; inspectorId: string | null; reasons: string[]; breakdown: Breakdown | null; start: string | null; end: string | null }; slaHours?: Record<string, number>;
}
export interface Breakdown { mode: string; total: number | null; parts: Record<string, { raw: number; weight: number; points: number }> | null; inputs: { distanceKm: number | null; loadRatio: number; areaProximity: number } | null; candidatesConsidered?: number; reasons?: string[] }
