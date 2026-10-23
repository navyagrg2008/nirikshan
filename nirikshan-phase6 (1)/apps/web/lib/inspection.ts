import { useI18n } from './i18n';
import type { Tone } from './cases';

/** Pick the Hindi or English wording for a screen-local string. */
export function useTr() { const { lang } = useI18n(); return { lang, tr: (en: string, hi: string) => (lang === 'hi' ? hi : en) }; }

export type Verdict = 'PASS' | 'MARGINAL_PASS' | 'FAIL';
export type Recommendation = 'RECOMMEND_APPROVE' | 'RECOMMEND_REJECT' | 'RE_INSPECT';
export const VERDICT: Record<Verdict, [string, string, Tone]> = { PASS: ['Pass', 'सफल', 'ok'], MARGINAL_PASS: ['Marginal pass', 'सीमांत सफल', 'warn'], FAIL: ['Fail', 'असफल', 'danger'] };
export const verdictLabel = (v: string | null | undefined, hi = false) => (v && VERDICT[v as Verdict] ? VERDICT[v as Verdict][hi ? 1 : 0] : '—');
export const verdictTone = (v: string | null | undefined): Tone => (v && VERDICT[v as Verdict] ? VERDICT[v as Verdict][2] : 'muted');
export const REC: Record<Recommendation, [string, string]> = { RECOMMEND_APPROVE: ['Recommend approval', 'स्वीकृति की सिफ़ारिश'], RECOMMEND_REJECT: ['Recommend rejection', 'अस्वीकृति की सिफ़ारिश'], RE_INSPECT: ['Needs another inspection', 'दोबारा निरीक्षण ज़रूरी'] };
export const recLabel = (r: string | null | undefined, hi = false) => (r && REC[r as Recommendation] ? REC[r as Recommendation][hi ? 1 : 0] : '—');
export const EVIDENCE_LABEL: Record<string, [string, string]> = { DISPLAY: ['Display / indicator', 'डिस्प्ले / सूचक'], TEST_WEIGHTS: ['Test weights', 'परीक्षण बाट'], SEAL: ['Seal', 'सील'], TAMPER: ['Tampering sign', 'छेड़छाड़ का निशान'], OTHER: ['Other', 'अन्य'] };
export const evidenceLabel = (k: string, hi = false) => EVIDENCE_LABEL[k]?.[hi ? 1 : 0] ?? k;
export const CERT_STATUS: Record<string, [string, string, Tone]> = { VALID: ['Valid', 'मान्य', 'ok'], EXPIRED: ['Expired', 'समाप्त', 'muted'], SUSPENDED: ['Suspended', 'निलंबित', 'warn'], REVOKED: ['Revoked', 'रद्द', 'danger'], REPLACED: ['Replaced', 'बदला गया', 'muted'] };
export const certStatusLabel = (s: string, hi = false) => CERT_STATUS[s]?.[hi ? 1 : 0] ?? s;
export const certStatusTone = (s: string): Tone => CERT_STATUS[s]?.[2] ?? 'muted';
export const BLOCKER: Record<string, [string, string]> = {
  DOCUMENTS_INCOMPLETE: ['Required documents are missing or not accepted.', 'ज़रूरी दस्तावेज़ नहीं हैं या स्वीकृत नहीं हैं।'],
  INSPECTION_MISSING: ['The inspector has not submitted an inspection.', 'निरीक्षक ने निरीक्षण जमा नहीं किया है।'],
  TRIALS_MISSING: ['Not enough test readings were recorded.', 'पर्याप्त परीक्षण रीडिंग दर्ज नहीं हैं।'],
  MPE_FAILED: ['A test reading is outside the permissible error.', 'एक परीक्षण रीडिंग अनुमत त्रुटि से बाहर है।'],
  EVIDENCE_MISSING: ['Required photos are missing.', 'ज़रूरी फ़ोटो नहीं हैं।'],
  EVIDENCE_UNSAFE: ['A photo failed the safety scan.', 'एक फ़ोटो सुरक्षा जाँच में विफल रही।'],
  CRITICAL_ITEM_FAILED: ['A critical checklist item failed.', 'एक महत्वपूर्ण जाँच-बिंदु असफल रहा।'],
  INSPECTOR_RECOMMENDED_AGAINST: ['The inspector did not recommend approval.', 'निरीक्षक ने स्वीकृति की सिफ़ारिश नहीं की।'],
  STICKER_MISSING: ['No sticker serial number was recorded.', 'स्टिकर क्रम संख्या दर्ज नहीं है।'],
};
export const blockerText = (c: string, hi = false) => BLOCKER[c]?.[hi ? 1 : 0] ?? c;

export interface ChecklistItem { code: string; textEn: string; textHi?: string; critical: boolean; required: boolean; pass: 'YES' | 'NO'; hintEn?: string }
export interface TrialRow { trialNo: number; reference: string; observed: string; unit: string; errorValue: string; errorUnit: string; errorPct: string; mpeValue: string; verdict: Verdict }
export interface EvidenceRow { id: string; kind: string; capturedAt: string; geoTagged: boolean; scan?: string }
export type Answer = { answer: 'YES' | 'NO' | 'NA'; remark?: string };
export interface DraftData { step?: number; checklist?: Record<string, Answer>; trials?: { reference: string; observed: string }[]; recommendation?: Recommendation | null; rejectReasonCodes?: string[]; note?: string; stickerSerial?: string }
export interface VisitOpen {
  id: string; status: string; readOnly: false; window: { start: string; end: string }; applicationNo: string; applicationId: string; type: string; accessHours: string | null;
  instrument: { instrumentNo: string; category: string; categoryCode: string; make: string | null; model: string | null; serialNo: string; capacity: string; capacityUnit: string; accuracyClass: string; displayCount: number | null };
  area: string; address: string | null; hasPremisesPoint: boolean; arrival: null | { at: string; distanceM: number | null; geofenceOk: boolean | null };
  checklist: { templateId: string; version: number; items: ChecklistItem[] }; mpe: { value: string; unit: string; direction: string; marginalPct: string };
  interval: { months: number; marginalMonths: number | null }; rules: { version: number; effectiveFrom: string };
  rejectReasons: { code: string; textEn: string; textHi: string | null }[]; settings: { minTrials: number; requiredEvidence: string[]; geofenceRadiusM: number; draftDays: number };
  draft: null | { data: DraftData; savedAt: string; version: number }; evidence: EvidenceRow[];
}
export interface VisitDone {
  id: string; status: string; readOnly: true; window: { start: string; end: string }; summary: unknown; recommendation: string | null; overall: string | null; stickerSerial: string | null; note: string | null; submittedAt: string | null;
  trials: TrialRow[]; checklist: { item_code: string; answer: string; remark: string | null }[]; evidence: EvidenceRow[]; hasTestSheet: boolean;
}
export const MPE_DIR: Record<string, string> = { PLUS_MINUS: '±', PLUS: '+', MINUS: '−' };
export const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;
