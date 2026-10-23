import { checkPassword, maskFirm, maskMobile, maskEmail, normaliseMobile, findTransition, allowedActions, isTerminal, registerSchema, accountDecisionSchema, ROLE_PERMISSIONS, roleHas, TRANSITIONS, APPLICATION_STATES } from './index';

describe('password policy', () => {
  it('rejects short, simple and common passwords', () => {
    expect(checkPassword('short1A!').reasons).toContain('TOO_SHORT');
    expect(checkPassword('alllowercaseletters').reasons).toContain('TOO_SIMPLE');
    expect(checkPassword('Password123').reasons).toContain('COMMON');
    expect(checkPassword('aaaaBcd12345!').reasons).toContain('REPEATED');
  });
  it('rejects passwords containing identifiers', () => {
    expect(checkPassword('Ananya-Gupta-77!', ['ananya gupta']).reasons).toContain('CONTAINS_IDENTIFIER');
  });
  it('accepts a strong password', () => { expect(checkPassword('Tr0ub4dor&3-horse').ok).toBe(true); });
});

describe('masking', () => {
  it('masks firm names to first letter', () => { expect(maskFirm('  sharma stores ')).toBe('S******'); expect(maskFirm('')).toBe('******'); });
  it('masks mobile and email', () => { expect(maskMobile('9876543210')).toBe('+91 ******10'); expect(maskEmail('abc@x.in')).toBe('a******@x.in'); });
  it('normalises Indian mobiles', () => {
    expect(normaliseMobile('+91 98765-43210')).toBe('9876543210');
    expect(normaliseMobile('9123456789')).toBe('9123456789');
    expect(normaliseMobile('919123456789')).toBe('9123456789');
    expect(normaliseMobile('+919876543210')).toBe('9876543210');
    expect(normaliseMobile('1234567890')).toBeNull();
    expect(normaliseMobile('98765')).toBeNull();
  });
});

describe('schemas', () => {
  const base = {
    identity: { fullName: 'Test User', dob: '1990-01-01', mobile: '9876543210' },
    mobileToken: 'x'.repeat(24), businessType: 'OWNER', business: { firmName: 'Test Store' },
    address: { line1: '1 Test Road', pincode: '201001', areaId: '11111111-1111-4111-8111-111111111111' },
    documents: [], password: 'Tr0ub4dor&3-horse', consent: { policyVersion: '1', accepted: true },
  };
  it('accepts a valid registration', () => { expect(registerSchema.safeParse(base).success).toBe(true); });
  it('rejects under-18 and unknown keys', () => {
    expect(registerSchema.safeParse({ ...base, identity: { ...base.identity, dob: new Date().toISOString().slice(0, 10) } }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it('rejects full ID numbers (only last 4 allowed)', () => {
    expect(registerSchema.safeParse({ ...base, idProof: { type: 'AADHAAR', last4: '123456789012' } }).success).toBe(false);
  });
  it('requires a reason when rejecting an account', () => {
    expect(accountDecisionSchema.safeParse({ outcome: 'REJECTED' }).success).toBe(false);
    expect(accountDecisionSchema.safeParse({ outcome: 'APPROVED' }).success).toBe(true);
  });
});

describe('permissions', () => {
  it('keeps decisions and rules away from owners', () => {
    expect(roleHas('OWNER', 'rules.write')).toBe(false);
    expect(roleHas('ADMIN', 'rules.write')).toBe(true);
    expect(roleHas('TRADER', 'instrument.bulk')).toBe(true);
    expect(roleHas('OWNER', 'instrument.bulk')).toBe(false);
  });
  it('gives every role the public validate permission', () => { for (const r of Object.keys(ROLE_PERMISSIONS)) expect(roleHas(r as never, 'public.validate')).toBe(true); });
});

describe('case state machine', () => {
  it('has no payment step: APPLIED goes straight to document check', () => {
    expect(findTransition('APPLIED', 'documentCheckComplete', 'OFFICER')?.to).toBe('DOCUMENT_CHECKED');
    expect(APPLICATION_STATES.some((s) => /PAY|FEE/i.test(s))).toBe(false);
  });
  it('blocks illegal transitions and wrong actors', () => {
    expect(findTransition('APPLIED', 'approve', 'OFFICER')).toBeUndefined();
    expect(findTransition('SCHEDULED', 'startVisit', 'OWNER')).toBeUndefined();
    expect(findTransition('INSPECTED', 'approve', 'INSPECTOR')).toBeUndefined();
  });
  it('requires re-auth for decisions', () => {
    for (const a of ['approve', 'reject']) expect(findTransition('INSPECTED', a, 'OFFICER')?.reauth).toBe(true);
  });
  it('owner can cancel only while APPLIED', () => {
    expect(allowedActions('APPLIED', 'OWNER')).toContain('cancel');
    expect(allowedActions('SCHEDULED', 'OWNER')).not.toContain('cancel');
  });
  it('terminal states have no outgoing transitions', () => {
    for (const t of TRANSITIONS) expect(isTerminal(t.from)).toBe(false);
  });
});

import { addDays, addMonths, computeDueDates, distanceFactor, documentCheckBlockers, haversineKm, isWorkingDay, isoWeekday, istDay, istInstant, scoreCandidate, slaState, slotsForDay, DEFAULT_WEIGHTS } from './scheduling';
describe('scheduling: dates and slots', () => {
  it('does day and month arithmetic without drifting', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02'); expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'); expect(addMonths('2026-11-15', 14)).toBe('2028-01-15');
    expect(isoWeekday('2026-10-18')).toBe(7); expect(isoWeekday('2026-10-19')).toBe(1);
  });
  it('knows the IST day around midnight UTC', () => {
    expect(istDay(new Date('2026-10-17T20:00:00Z'))).toBe('2026-10-18'); expect(istDay(new Date('2026-10-17T18:29:00Z'))).toBe('2026-10-17');
    expect(istInstant('2026-10-19', 10).toISOString()).toBe('2026-10-19T04:30:00.000Z');
  });
  it('builds four two-hour slots from 10 to 18 and skips Sundays and holidays', () => {
    const s = { dayStartHour: 10, dayEndHour: 18, slotHours: 2, workingDays: [1, 2, 3, 4, 5, 6] };
    const slots = slotsForDay('2026-10-19', s); expect(slots).toHaveLength(4); expect(slots[3]!.end.toISOString()).toBe('2026-10-19T12:30:00.000Z');
    expect(isWorkingDay('2026-10-18', s, new Set())).toBe(false); expect(isWorkingDay('2026-10-19', s, new Set(['2026-10-19']))).toBe(false); expect(isWorkingDay('2026-10-20', s, new Set())).toBe(true);
  });
});
describe('scheduling: scoring', () => {
  const base = { loadRatio: 0, distanceKm: 0, areaProximity: 1, skillCount: 1, completedVisits: 10, noShowVisits: 0, inspectedLastTime: false };
  it('gives a perfect candidate 100 and explains every part', () => {
    const r = scoreCandidate(base); expect(r.total).toBe(100); expect(Object.keys(r.parts).sort()).toEqual(['distance', 'noRepeat', 'specialisation', 'success', 'workload']); expect(r.parts.workload.points).toBe(35);
  });
  it('prefers the lighter-loaded, closer, fresher inspector', () => {
    const busy = scoreCandidate({ ...base, loadRatio: 0.9 }); const far = scoreCandidate({ ...base, distanceKm: 35 }); const repeat = scoreCandidate({ ...base, inspectedLastTime: true });
    expect(busy.total).toBeLessThan(100); expect(far.total).toBeLessThan(100); expect(repeat.total).toBe(85); expect(busy.parts.workload.raw).toBe(0.1);
  });
  it('falls back to area proximity without coordinates, and weights are normalised', () => {
    expect(scoreCandidate({ ...base, distanceKm: null, areaProximity: 0.5 }).parts.distance.raw).toBe(0.5);
    expect(scoreCandidate(base, { workload: 7, distance: 5, specialisation: 3, success: 2, noRepeat: 3 }).total).toBe(100);
    expect(scoreCandidate({ ...base, completedVisits: 0, noShowVisits: 0 }).parts.success.raw).toBe(0.5);
  });
  it('measures distance sensibly', () => { expect(haversineKm({ lat: 28.61, lng: 77.2 }, { lat: 28.61, lng: 77.2 })).toBe(0); expect(haversineKm({ lat: 28.61, lng: 77.2 }, { lat: 28.7, lng: 77.2 })).toBeGreaterThan(9); expect(distanceFactor(80)).toBe(0); void DEFAULT_WEIGHTS; });
});
describe('scheduling: due dates, SLA, documents', () => {
  const b = { today: '2026-10-17', registeredOn: '2026-10-10', firstVerifiedOn: null, validUntil: null, intervalMonths: 12, windowDays: 30, graceDays: 15, totalSlaHours: 192 };
  it('NEW: due a window after registration; apply-by leaves room for the SLAs', () => {
    const r = computeDueDates({ ...b, type: 'NEW' }); expect(r.dueDate).toBe('2026-11-09'); expect(r.applyByDate).toBe('2026-11-01'); expect(r.applyByPassed).toBe(false); expect(r.graceEndsOn).toBe('2026-11-24');
  });
  it('RENEWAL: due on validity end, and flags a late application', () => {
    const r = computeDueDates({ ...b, type: 'RENEWAL', validUntil: '2026-10-20' }); expect(r.dueDate).toBe('2026-10-20'); expect(r.applyByPassed).toBe(true); expect(r.overdue).toBe(false);
    expect(computeDueDates({ ...b, type: 'RENEWAL', validUntil: '2026-10-01' }).overdue).toBe(true);
    expect(computeDueDates({ ...b, type: 'RE_VERIFICATION', firstVerifiedOn: '2025-12-01' }).dueDate).toBe('2026-12-01');
    expect(computeDueDates({ ...b, type: 'RE_TEST' }).dueDate).toBe('2026-11-16');
  });
  it('tracks SLA state', () => {
    const t = new Date('2026-10-17T00:00:00Z'); expect(slaState(t, 48, new Date('2026-10-17T20:00:00Z')).state).toBe('OK'); expect(slaState(t, 48, new Date('2026-10-18T14:00:00Z')).state).toBe('AT_RISK'); expect(slaState(t, 48, new Date('2026-10-19T00:00:01Z')).state).toBe('OVERDUE');
  });
  it('lists what blocks the document check', () => {
    expect(documentCheckBlockers(['a', 'b'], [{ typeId: 'a', review: 'ACCEPTED', scan: 'CLEAN' }])).toEqual(['MISSING:b']);
    expect(documentCheckBlockers(['a'], [{ typeId: 'a', review: 'PENDING', scan: 'CLEAN' }])).toEqual(['NOT_ACCEPTED:a']);
    expect(documentCheckBlockers(['a'], [{ typeId: 'a', review: 'ACCEPTED', scan: 'PENDING' }])).toEqual(['NOT_SCANNED:a']);
    expect(documentCheckBlockers(['a'], [{ typeId: 'a', review: 'ACCEPTED', scan: 'CLEAN' }, { typeId: 'x', review: 'FLAGGED', scan: 'CLEAN' }])).toEqual(['FLAGGED:x']);
    expect(documentCheckBlockers(['a'], [{ typeId: 'a', review: 'ACCEPTED', scan: 'CLEAN' }])).toEqual([]);
  });
});

import { diffRules, missingCoverage, rangesOverlap, type RuleContent } from './rules-diff';
describe('rule set diff', () => {
  const base: RuleContent = {
    mpe: [{ categoryId: 'c1', capacityBandId: 'b1', accuracyClassId: 'a1', direction: 'PLUS_MINUS', value: '5.000000', unit: 'g', marginalPct: '80.00' }, { categoryId: 'c1', capacityBandId: 'b2', accuracyClassId: 'a1', direction: 'PLUS_MINUS', value: '10', unit: 'g', marginalPct: '80' }],
    intervals: [{ categoryId: 'c1', capacityBandId: 'b1', months: 12, marginalMonths: 6, graceDays: 0, applicationWindowDays: 30 }], slas: [{ step: 'DECISION', maxHours: 72 }],
  };
  it('treats equal numbers as equal however they are written, and reports real changes', () => {
    const next: RuleContent = { ...base, mpe: [{ ...base.mpe[0]!, value: '5', marginalPct: '80' }, { ...base.mpe[1]!, value: '12' }], slas: [{ step: 'DECISION', maxHours: 48 }, { step: 'SCHEDULE', maxHours: 72 }] };
    const d = diffRules(base, next);
    expect(d.mpe.changed.map((c) => [c.key, c.fields])).toEqual([['c1|b2|a1', ['value']]]);
    expect(d.slas.added.map((s) => s.step)).toEqual(['SCHEDULE']); expect(d.slas.changed[0]!.fields).toEqual(['maxHours']);
    expect(d.counts).toEqual({ added: 1, removed: 0, changed: 2 });
  });
  it('finds removed rows and missing coverage', () => {
    const next: RuleContent = { ...base, mpe: [base.mpe[0]!], intervals: [] };
    expect(diffRules(base, next).counts.removed).toBe(2);
    expect(missingCoverage(base, next)).toEqual({ mpe: ['c1|b2|a1'], intervals: ['c1|b1'], slas: [] });
  });
  it('detects overlapping date ranges, treating a missing end as open-ended and the end day as free', () => {
    expect(rangesOverlap('2026-01-01', null, '2027-01-01', null)).toBe(true);
    expect(rangesOverlap('2026-01-01', '2027-01-01', '2027-01-01', null)).toBe(false);
    expect(rangesOverlap('2026-01-01', '2027-01-02', '2027-01-01', null)).toBe(true);
    expect(rangesOverlap('2028-01-01', null, '2026-01-01', '2027-01-01')).toBe(false);
  });
});
