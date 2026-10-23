import { z } from 'zod';
import { BUSINESS_TYPES, LANGS, OTP_PURPOSES, ROLES } from './enums';
import { normaliseEmail, normaliseMobile } from './mask';

export const uuid = z.string().uuid();
export const mobileSchema = z.string().transform((v, ctx) => {
  const m = normaliseMobile(v);
  if (!m) { ctx.addIssue({ code: 'custom', message: 'INVALID_MOBILE' }); return z.NEVER; }
  return m;
});
export const emailSchema = z.string().max(254).email().transform(normaliseEmail);
export const decimalString = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'INVALID_DECIMAL');

const adult = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  return d <= cutoff && d.getUTCFullYear() > 1900;
};

// ---------------------------------------------------------------- OTP
export const otpSendSchema = z.object({
  channel: z.enum(['MOBILE', 'EMAIL']),
  target: z.string().min(3).max(254),
  purpose: z.enum(OTP_PURPOSES),
  captchaToken: z.string().max(4096).optional(),
}).strict();
export type OtpSendInput = z.infer<typeof otpSendSchema>;

export const otpVerifySchema = z.object({
  challengeId: uuid,
  code: z.string().regex(/^\d{6}$/, 'INVALID_CODE'),
}).strict();

// ---------------------------------------------------------------- registration
export const ID_DOC_TYPES = ['AADHAAR', 'PAN', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT'] as const;
export const REG_DOC_KINDS = ['TRADE_LICENCE', 'GST_CERTIFICATE', 'ID_PROOF'] as const;

export const registerSchema = z.object({
  identity: z.object({
    fullName: z.string().trim().min(2).max(120),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(adult, 'UNDER_18'),
    mobile: mobileSchema,
    email: emailSchema.optional(),
  }).strict(),
  mobileToken: z.string().min(20).max(200),
  emailToken: z.string().min(20).max(200).optional(),
  businessType: z.enum(BUSINESS_TYPES),
  business: z.object({
    firmName: z.string().trim().min(2).max(160),
    tradeLicenceNo: z.string().trim().min(3).max(40).optional(),
    gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'INVALID_GSTIN').optional(),
  }).strict(),
  address: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    pincode: z.string().regex(/^[1-9]\d{5}$/, 'INVALID_PINCODE'),
    areaId: uuid,
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }).strict(),
  idProof: z.object({ type: z.enum(ID_DOC_TYPES), last4: z.string().regex(/^[0-9A-Za-z]{4}$/) }).strict().optional(),
  documents: z.array(z.object({ kind: z.enum(REG_DOC_KINDS), fileId: uuid }).strict()).max(6),
  password: z.string().min(10).max(128),
  lang: z.enum(LANGS).default('en'),
  consent: z.object({ policyVersion: z.string().min(1).max(20), accepted: z.literal(true) }).strict(),
}).strict();
export type RegisterInput = z.infer<typeof registerSchema>;

// ---------------------------------------------------------------- login
export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
}).strict();
export const loginOtpSchema = z.object({ mobileToken: z.string().min(20).max(200) }).strict();
export const mfaVerifySchema = z.object({
  pendingId: z.string().min(20).max(200),
  code: z.string().regex(/^(\d{6}|[A-Za-z0-9]{10})$/, 'INVALID_CODE'),
}).strict();
export const reauthSchema = z.object({ password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/).optional() }).strict();
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128),
}).strict();
export const forgotPasswordSchema = z.object({ mobileToken: z.string().min(20).max(200), newPassword: z.string().min(10).max(128), mobile: mobileSchema }).strict();

// ---------------------------------------------------------------- staff invites
export const inviteCreateSchema = z.object({
  role: z.enum(ROLES).refine((r) => r !== 'OWNER' && r !== 'TRADER', 'STAFF_ROLE_ONLY'),
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  mobile: mobileSchema.optional(),
  areaIds: z.array(uuid).max(50).default([]),
}).strict();
export const inviteAcceptSchema = z.object({ token: z.string().min(20).max(400), password: z.string().min(10).max(128) }).strict();
export const inviteConfirmMfaSchema = z.object({ enrolmentId: z.string().min(20).max(200), code: z.string().regex(/^\d{6}$/) }).strict();

// ---------------------------------------------------------------- account approval
export const accountDecisionSchema = z.object({
  outcome: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().max(500).optional(),
}).strict().refine((v) => v.outcome === 'APPROVED' || !!v.reason, { message: 'REASON_REQUIRED', path: ['reason'] });

// ---------------------------------------------------------------- instruments
export const instrumentLocationSchema = z.object({
  address: z.string().trim().min(3).max(300),
  areaId: uuid,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
}).strict();

export const instrumentBaseSchema = z.object({
  categoryId: uuid,
  subCategoryId: uuid.optional(),
  capacityBandId: uuid,
  accuracyClassId: uuid,
  capacity: decimalString,
  capacityUnit: z.string().trim().min(1).max(10),
  serialNo: z.string().trim().min(2).max(60),
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().max(80).optional(),
  manufactureYear: z.number().int().min(1950).max(new Date().getUTCFullYear()).optional(),
  loadCellSerial: z.string().trim().max(60).optional(),
  displayCount: z.number().int().min(1).max(10_000_000).optional(),
  location: instrumentLocationSchema,
  ownership: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('SELF') }).strict(),
    z.object({ mode: z.literal('ON_BEHALF'), customerBusinessId: uuid }).strict(),
  ]),
}).strict();

export const instrumentCreateSchema = instrumentBaseSchema.extend({
  confirmToken: z.string().min(20).max(200),
  declarationAccepted: z.literal(true),
  requestDuplicateReview: z.boolean().default(false),
}).strict();
export type InstrumentCreateInput = z.infer<typeof instrumentCreateSchema>;

export const instrumentUpdateSchema = z.object({
  model: z.string().trim().max(80).nullable().optional(),
  manufactureYear: z.number().int().min(1950).max(new Date().getUTCFullYear()).nullable().optional(),
  loadCellSerial: z.string().trim().max(60).nullable().optional(),
  displayCount: z.number().int().min(1).max(10_000_000).nullable().optional(),
  location: instrumentLocationSchema.optional(),
  categoryId: uuid.optional(),
  capacityBandId: uuid.optional(),
  accuracyClassId: uuid.optional(),
  capacity: decimalString.optional(),
  capacityUnit: z.string().trim().min(1).max(10).optional(),
  serialNo: z.string().trim().min(2).max(60).optional(),
  make: z.string().trim().min(1).max(80).optional(),
}).strict();

export const customerBusinessSchema = z.object({
  firmName: z.string().trim().min(2).max(160),
  areaId: uuid,
}).strict();

export const draftSchema = z.object({ step: z.number().int().min(1).max(6), data: z.record(z.string(), z.unknown()) }).strict();

// ---------------------------------------------------------------- bulk
export const BULK_COLUMNS = [
  'category_code', 'capacity', 'capacity_unit', 'accuracy_class_code', 'serial_no', 'make', 'model',
  'manufacture_year', 'load_cell_serial', 'display_count', 'address', 'area_code', 'customer_firm',
] as const;

// ---------------------------------------------------------------- master data
export const masterEntities = [
  'categories', 'sub-categories', 'accuracy-classes', 'capacity-bands', 'document-types', 'reason-codes', 'holidays',
  'notification-templates', 'areas',
] as const;
export type MasterEntity = (typeof masterEntities)[number];

export const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  contact: z.string().trim().min(5).max(254),
  message: z.string().trim().min(10).max(2000),
  captchaToken: z.string().max(4096).optional(),
}).strict();

export const userStatusSchema = z.object({ action: z.enum(['SUSPEND', 'REACTIVATE', 'FORCE_PASSWORD_RESET', 'RESET_MFA', 'REVOKE_SESSIONS']), reason: z.string().trim().max(300).optional() }).strict();

// ---------------------------------------------------------------- Phase 3: applications and scheduling
export const VERIFICATION_TYPES = ['NEW', 'RE_VERIFICATION', 'RENEWAL', 'RE_TEST'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'INVALID_DATE').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'INVALID_DATE');
const isoDateTime = z.string().datetime({ offset: true });
const reasonText = z.string().trim().min(3).max(300);

export const applicationCreateSchema = z.object({
  instrumentId: uuid,
  type: z.enum(VERIFICATION_TYPES),
  preferredFrom: isoDate.optional(),
  preferredTo: isoDate.optional(),
  accessHours: z.string().trim().max(100).optional(),
  contactPerson: z.object({ name: z.string().trim().min(2).max(80), phone: mobileSchema.optional() }).strict().optional(),
  declarationAccepted: z.literal(true),
}).strict().refine((v) => !v.preferredTo || (!!v.preferredFrom && v.preferredTo >= v.preferredFrom), { message: 'INVALID_PREFERRED_RANGE', path: ['preferredTo'] });
export const applicationBatchSchema = z.object({
  instrumentIds: z.array(uuid).min(1).max(50),
  type: z.enum(VERIFICATION_TYPES),
  preferredFrom: isoDate.optional(),
  preferredTo: isoDate.optional(),
  accessHours: z.string().trim().max(100).optional(),
  declarationAccepted: z.literal(true),
}).strict();
export const precheckQuery = z.object({ type: z.enum(VERIFICATION_TYPES) }).strict();
export const cancelSchema = z.object({ reason: reasonText }).strict();
export const rescheduleRequestSchema = z.object({ reason: reasonText, preferredFrom: isoDate, preferredTo: isoDate.optional() }).strict();
export const docReviewSchema = z.object({
  status: z.enum(['ACCEPTED', 'FLAGGED']),
  comment: z.string().trim().max(300).optional(),
  reasonCode: z.string().trim().max(40).optional(),
}).strict().refine((v) => v.status === 'ACCEPTED' || !!v.comment || !!v.reasonCode, { message: 'COMMENT_REQUIRED', path: ['comment'] });
export const assignSchema = z.object({
  inspectorId: uuid,
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  outOfJurisdictionReason: reasonText.optional(),
}).strict();
export const visitRescheduleSchema = z.object({
  reason: reasonText,
  inspectorId: uuid.optional(),
  windowStart: isoDateTime.optional(),
  windowEnd: isoDateTime.optional(),
  outOfJurisdictionReason: reasonText.optional(),
}).strict().refine((v) => (!!v.windowStart) === (!!v.windowEnd), { message: 'WINDOW_INCOMPLETE', path: ['windowEnd'] });
export const bulkRescheduleSchema = z.object({ areaId: uuid, date: isoDate, reason: reasonText, notBefore: isoDate.optional() }).strict();
export const availabilitySchema = z.object({
  kind: z.enum(['LEAVE', 'UNAVAILABLE', 'CAPACITY_OVERRIDE']),
  from: isoDate, to: isoDate,
  dailyCapacity: z.number().int().min(0).max(12).optional(),
  reason: reasonText,
}).strict().refine((v) => v.to >= v.from, { message: 'INVALID_RANGE', path: ['to'] })
  .refine((v) => v.kind !== 'CAPACITY_OVERRIDE' || v.dailyCapacity !== undefined, { message: 'CAPACITY_REQUIRED', path: ['dailyCapacity'] });
export const requestDecisionSchema = z.object({ outcome: z.enum(['APPROVED', 'REJECTED']), reason: reasonText.optional() }).strict()
  .refine((v) => v.outcome === 'APPROVED' || !!v.reason, { message: 'REASON_REQUIRED', path: ['reason'] });
export const noShowSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const casesQuery = z.object({
  status: z.string().max(200).optional(), q: z.string().trim().min(2).max(60).optional(), sla: z.enum(['OVERDUE', 'AT_RISK']).optional(),
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

// ---------------------------------------------------------------- Phase 4: inspection, decision, certificate
export const EVIDENCE_KINDS = ['DISPLAY', 'TEST_WEIGHTS', 'SEAL', 'TAMPER', 'OTHER'] as const;
const decimalTrial = z.string().trim().regex(/^-?\d{1,12}(\.\d{1,6})?$/, 'INVALID_DECIMAL');
const latSchema = z.number().min(-90).max(90);
const lonSchema = z.number().min(-180).max(180);
const stickerSchema = z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/, 'INVALID_STICKER');

export const arriveSchema = z.object({
  lat: latSchema, lon: lonSchema, accuracyM: z.number().min(0).max(10_000).optional(),
  justification: z.string().trim().min(10).max(500).optional(),
}).strict();
export const trialInputSchema = z.object({ reference: decimalTrial, observed: decimalTrial }).strict();
export const computeTrialsSchema = z.object({ trials: z.array(trialInputSchema).min(1).max(20) }).strict();
const answer = z.object({ answer: z.enum(['YES', 'NO', 'NA']), remark: z.string().trim().max(500).optional() }).strict();
/** The draft is the inspector's private working copy. It is lenient (fields may be half typed) and is encrypted at rest. */
export const inspectionDraftSchema = z.object({
  step: z.number().int().min(1).max(5).optional(),
  checklist: z.record(z.string().max(40), answer).optional(),
  trials: z.array(z.object({ reference: z.string().max(20), observed: z.string().max(20) }).strict()).max(20).optional(),
  recommendation: z.enum(['RECOMMEND_APPROVE', 'RECOMMEND_REJECT', 'RE_INSPECT']).nullable().optional(),
  rejectReasonCodes: z.array(z.string().max(40)).max(5).optional(),
  note: z.string().max(1000).optional(),
  stickerSerial: z.string().max(40).optional(),
}).strict();
export const submitInspectionSchema = z.object({
  checklist: z.record(z.string().max(40), answer),
  trials: z.array(trialInputSchema).min(1).max(20),
  recommendation: z.enum(['RECOMMEND_APPROVE', 'RECOMMEND_REJECT', 'RE_INSPECT']),
  rejectReasonCodes: z.array(z.string().max(40)).max(5).default([]),
  note: z.string().trim().max(1000).optional(),
  stickerSerial: stickerSchema.optional(),
}).strict();
export const evidenceMetaSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
}).strict();

const remarksText = z.string().trim().min(10).max(1000);
export const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('APPROVE'), applicationId: uuid, validityMonths: z.number().int().min(1).max(120).optional(), remarks: z.string().trim().max(1000).optional() }).strict(),
  z.object({ decision: z.literal('REJECT'), applicationId: uuid, reasonCode: z.string().max(40), remarks: remarksText }).strict(),
  z.object({ decision: z.literal('REFER'), applicationId: uuid, remarks: remarksText }).strict(),
]);
export const reinspectSchema = z.object({ remarks: remarksText }).strict();
export const secondApprovalSchema = z.object({ action: z.enum(['CONFIRM', 'DECLINE']), remarks: z.string().trim().max(1000).optional() }).strict()
  .refine((v) => v.action === 'CONFIRM' || (v.remarks && v.remarks.length >= 10), { message: 'REMARKS_REQUIRED', path: ['remarks'] });
export const certificateActionSchema = z.object({ reasonCode: z.string().max(40), internalNote: z.string().trim().min(10).max(1000) }).strict();
export const certificateReinstateSchema = z.object({ internalNote: z.string().trim().min(10).max(1000) }).strict();
export const reissueSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const certificatesQuery = z.object({
  tab: z.enum(['VALID', 'EXPIRING', 'EXPIRED', 'REVOKED', 'SUSPENDED', 'ALL']).default('ALL'),
  q: z.string().trim().max(60).optional(),
  category: uuid.optional(),
  area: uuid.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
}).strict();
export const publicValidateQuery = z.object({ cert: z.string().trim().min(8).max(40), captchaToken: z.string().max(4096).optional() }).strict();

// ---------------------------------------------------------------- Phase 5: settings
export const maintenanceSchema = z.object({ enabled: z.boolean(), level: z.enum(['info', 'warn']), textEn: z.string().trim().max(300), textHi: z.string().trim().max(300) }).strict()
  .refine((v) => !v.enabled || v.textEn.length > 0, { message: 'TEXT_REQUIRED', path: ['textEn'] });
export const flagsSchema = z.object({ publicSearch: z.boolean(), tamperReports: z.boolean(), bulkRegister: z.boolean(), selfServiceDataRequests: z.boolean() }).strict();
export const lifecycleSchema = z.object({
  reminderDays: z.array(z.number().int().min(1).max(365)).min(1).max(8), dueForRenewalDays: z.number().int().min(1).max(365), applicationExpiryDays: z.number().int().min(1).max(180),
  visitReminderHours: z.number().int().min(1).max(72), unscheduledAlertHours: z.number().int().min(1).max(168),
}).strict();
export const settingKeySchema = z.enum(['maintenance', 'flags', 'lifecycle']);
export const settingSchemas = { maintenance: maintenanceSchema, flags: flagsSchema, lifecycle: lifecycleSchema } as const;

// ---------------------------------------------------------------- Phase 5: instrument requests and repair jobs
export const DEREGISTER_REASONS = ['SOLD_OUTSIDE_JURISDICTION', 'SCRAPPED', 'DAMAGED_BEYOND_REPAIR', 'NO_LONGER_IN_USE', 'OTHER'] as const;
const note = z.string().trim().max(500).optional();
export const requestCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TRANSFER'), toMobile: z.string().regex(/^[6-9]\d{9}$/), note }).strict(),
  z.object({ kind: z.literal('ADDRESS_CHANGE'), address: z.string().trim().min(5).max(300), areaId: z.string().uuid(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), note }).strict(),
  z.object({ kind: z.literal('DEREGISTER'), reasonCode: z.enum(DEREGISTER_REASONS), note }).strict(),
]);
export const instrumentRequestDecisionSchema = z.object({ outcome: z.enum(['APPROVED', 'REJECTED']), remark: z.string().trim().max(500).optional() }).strict()
  .refine((v) => v.outcome === 'APPROVED' || (v.remark?.length ?? 0) >= 5, { message: 'REMARK_REQUIRED', path: ['remark'] });
export const serviceJobCreateSchema = z.object({ instrumentId: z.string().uuid(), issue: z.string().trim().min(3).max(300) }).strict();
export const serviceJobAdvanceSchema = z.object({ to: z.enum(['TECHNICIAN_ASSIGNED', 'REPAIRED', 'READY_FOR_VERIFICATION']), technicianName: z.string().trim().min(2).max(80).optional(), notes: z.string().trim().max(500).optional() }).strict();

// ---------------------------------------------------------------- Phase 5: complaints, tamper reports, enforcement, public search
export const grievanceCreateSchema = z.object({ subject: z.string().trim().min(5).max(120), body: z.string().trim().min(10).max(2000), applicationId: z.string().uuid().optional() }).strict();
export const grievanceRespondSchema = z.object({ status: z.enum(['IN_PROGRESS', 'CLOSED']), response: z.string().trim().min(5).max(2000) }).strict();
export const tamperReportSchema = z.object({ description: z.string().trim().min(10).max(1500), certNo: z.string().trim().max(60).optional(), contact: z.string().trim().max(120).optional(), captchaToken: z.string().max(2000).optional() }).strict();
export const tamperResolveSchema = z.object({ status: z.enum(['IN_PROGRESS', 'CLOSED']), resolution: z.string().trim().min(5).max(1500) }).strict();
export const driveCreateSchema = z.object({ name: z.string().trim().min(3).max(100), areaId: z.string().uuid(), instrumentIds: z.array(z.string().uuid()).min(1).max(500) }).strict();
export const publicSearchSchema = z.object({
  q: z.string().trim().max(60).optional(), categoryId: z.string().uuid().optional(), areaCode: z.string().trim().max(40).optional(), status: z.enum(['VALID', 'EXPIRED', 'REVOKED', 'SUSPENDED']).optional(),
  page: z.coerce.number().int().min(1).max(50).default(1), captchaToken: z.string().max(2000).optional(),
}).strict();

// ---------------------------------------------------------------- Phase 5: rule sets
const dec = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
export const mpeRowSchema = z.object({ categoryId: z.string().uuid(), capacityBandId: z.string().uuid(), accuracyClassId: z.string().uuid(), direction: z.enum(['PLUS_MINUS', 'PLUS', 'MINUS']), value: dec.refine((v) => Number(v) > 0, 'POSITIVE'),
  unit: z.string().trim().min(1).max(10), marginalPct: dec.refine((v) => Number(v) <= 100, 'MAX_100') }).strict();
export const intervalRowSchema = z.object({ categoryId: z.string().uuid(), capacityBandId: z.string().uuid(), months: z.number().int().min(1).max(120), marginalMonths: z.number().int().min(1).max(120).nullable(),
  graceDays: z.number().int().min(0).max(365), applicationWindowDays: z.number().int().min(1).max(365) }).strict().refine((v) => v.marginalMonths == null || v.marginalMonths <= v.months, { message: 'MARGINAL_TOO_LONG', path: ['marginalMonths'] });
export const slaRowSchema = z.object({ step: z.enum(['DOCUMENT_CHECK', 'SCHEDULE', 'DECISION']), maxHours: z.number().int().min(1).max(24 * 60) }).strict();
export const ruleDraftSchema = z.object({
  effectiveFrom: isoDate, effectiveTo: isoDate.nullable().optional(), note: z.string().trim().max(500).optional(),
  mpe: z.array(mpeRowSchema).max(2000), intervals: z.array(intervalRowSchema).max(500), slas: z.array(slaRowSchema).max(10),
}).strict().refine((v) => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, { message: 'RANGE_INVALID', path: ['effectiveTo'] });
export const ruleCreateSchema = z.object({ copyFromId: z.string().uuid().optional(), effectiveFrom: isoDate }).strict();
export const ruleReviewSchema = z.object({ outcome: z.enum(['APPROVE', 'RETURN']), remark: z.string().trim().max(500).optional() }).strict()
  .refine((v) => v.outcome === 'APPROVE' || (v.remark?.length ?? 0) >= 5, { message: 'REMARK_REQUIRED', path: ['remark'] });

// ---------------------------------------------------------------- Phase 5: privacy
export const dsrCreateSchema = z.object({ kind: z.enum(['ACCESS', 'CORRECTION', 'ERASURE', 'DEACTIVATION']), details: z.string().trim().max(1000).optional() }).strict()
  .refine((v) => v.kind !== 'CORRECTION' || (v.details?.length ?? 0) >= 5, { message: 'DETAILS_REQUIRED', path: ['details'] });
export const dsrResolveSchema = z.object({ action: z.enum(['FULFIL', 'REJECT']), note: z.string().trim().max(1000).optional(), correction: z.object({ fullName: z.string().trim().min(2).max(120) }).strict().optional() }).strict()
  .refine((v) => v.action === 'FULFIL' || (v.note?.length ?? 0) >= 5, { message: 'NOTE_REQUIRED', path: ['note'] });
export const BREACH_STEPS = ['CONTAIN', 'ASSESS', 'NOTIFY_AUTHORITY', 'NOTIFY_PEOPLE', 'PRESERVE_EVIDENCE', 'FIX', 'REVIEW'] as const;
export const breachUpdateSchema = z.object({ step: z.enum(BREACH_STEPS), done: z.boolean() }).strict();
