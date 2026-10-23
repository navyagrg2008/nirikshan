import { computeTrial, overallVerdict, addMonthsISO, validityRange, evaluateChecklist, allowedRecommendations, approvalBlockers, distanceMeters, formatCertNo, divisionCode, certNoToSlug, slugToCertNo, parseQrToken, toScaled, fromScaled, type ChecklistItem, type MpeInput } from './inspection';

const mpe: MpeInput = { value: '5', unit: 'g', direction: 'PLUS_MINUS', marginalPct: '80' };

describe('test calculation (decimal safe)', () => {
  it('converts the capacity unit to the MPE unit and calculates error and percent', () => {
    const r = computeTrial(1, '20', '20.003', 'kg', mpe);
    expect(r.errorValue).toBe('3.000000'); expect(r.errorUnit).toBe('g'); expect(r.errorPct).toBe('0.015000'); expect(r.verdict).toBe('PASS');
  });
  it('handles decimal fractions that floating point gets wrong', () => {
    const r = computeTrial(1, '0.1', '0.3', 'kg', { ...mpe, value: '1000' });
    expect(r.errorValue).toBe('200.000000'); expect(r.errorPct).toBe('200.000000');
    expect(fromScaled(toScaled('0.1') + toScaled('0.2'))).toBe('0.300000');
  });
  it('limit is inclusive; marginal starts at 80 percent of the limit', () => {
    expect(computeTrial(1, '10', '10.004', 'kg', mpe).verdict).toBe('MARGINAL_PASS');   // exactly 4 g = 80 %
    expect(computeTrial(1, '10', '10.00399', 'kg', mpe).verdict).toBe('PASS');
    expect(computeTrial(1, '10', '10.005', 'kg', mpe).verdict).toBe('MARGINAL_PASS');   // exactly at the limit still passes
    expect(computeTrial(1, '10', '10.005001', 'kg', mpe).verdict).toBe('FAIL');
    expect(computeTrial(1, '10', '9.995', 'kg', mpe).verdict).toBe('MARGINAL_PASS');
    expect(computeTrial(1, '10', '9.994', 'kg', mpe).verdict).toBe('FAIL');
  });
  it('one-sided limits', () => {
    expect(computeTrial(1, '10', '9.999', 'kg', { ...mpe, direction: 'PLUS' }).verdict).toBe('FAIL');
    expect(computeTrial(1, '10', '10.001', 'kg', { ...mpe, direction: 'PLUS' }).verdict).toBe('PASS');
    expect(computeTrial(1, '10', '10.001', 'kg', { ...mpe, direction: 'MINUS' }).verdict).toBe('FAIL');
    expect(computeTrial(1, '10', '9.999', 'kg', { ...mpe, direction: 'MINUS' }).verdict).toBe('PASS');
  });
  it('rejects nonsense input', () => {
    expect(() => computeTrial(1, '0', '1', 'kg', mpe)).toThrow('REFERENCE_MUST_BE_POSITIVE');
    expect(() => computeTrial(1, '1', '-1', 'kg', mpe)).toThrow('OBSERVED_MUST_NOT_BE_NEGATIVE');
    expect(() => computeTrial(1, '1e3', '1', 'kg', mpe)).toThrow('INVALID_DECIMAL');
    expect(() => computeTrial(1, '1', '1', 'kg', { ...mpe, unit: 'mL' })).toThrow('UNIT_MISMATCH');
    expect(() => toScaled('1.1234567')).toThrow();
  });
  it('overall verdict is the worst trial', () => {
    expect(overallVerdict(['PASS', 'PASS'])).toBe('PASS');
    expect(overallVerdict(['PASS', 'MARGINAL_PASS'])).toBe('MARGINAL_PASS');
    expect(overallVerdict(['PASS', 'FAIL', 'MARGINAL_PASS'])).toBe('FAIL');
    expect(overallVerdict([])).toBeNull();
  });
});

describe('validity', () => {
  it('adds months and clamps to month end', () => {
    expect(addMonthsISO('2026-01-31', 1)).toBe('2026-02-28'); expect(addMonthsISO('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsISO('2026-10-18', 12)).toBe('2027-10-18'); expect(addMonthsISO('2026-11-15', 6)).toBe('2027-05-15');
  });
  it('officer can shorten but not extend; marginal is capped', () => {
    expect(validityRange('PASS', { months: 12, marginalMonths: 6 })).toEqual({ min: 1, max: 12, default: 12 });
    expect(validityRange('MARGINAL_PASS', { months: 12, marginalMonths: 6 })).toEqual({ min: 1, max: 6, default: 6 });
    expect(validityRange('MARGINAL_PASS', { months: 12, marginalMonths: null }).max).toBe(12);
  });
});

const items: ChecklistItem[] = [
  { code: 'SEALS', textEn: 'Seals intact', critical: true, required: true, pass: 'YES' },
  { code: 'TAMPER', textEn: 'Tampering found', critical: true, required: true, pass: 'NO' },
  { code: 'ANC', textEn: 'Ancillary ok', critical: false, required: false, pass: 'YES' },
];
describe('checklist', () => {
  it('flags missing, failing, remark-less and NA on critical items', () => {
    expect(evaluateChecklist(items, {}).missing).toEqual(['SEALS', 'TAMPER']);
    const e = evaluateChecklist(items, { SEALS: { answer: 'NO' }, TAMPER: { answer: 'NA' }, ANC: { answer: 'NO', remark: 'worn' } });
    expect(e.failedCritical).toEqual(['SEALS']); expect(e.needRemark).toEqual(['SEALS']); expect(e.invalidNA).toEqual(['TAMPER']); expect(e.failed).toEqual(['SEALS', 'ANC']);
    expect(evaluateChecklist(items, { SEALS: { answer: 'YES' }, TAMPER: { answer: 'NO' } })).toEqual({ missing: [], needRemark: [], failed: [], failedCritical: [], invalidNA: [] });
  });
  it('closes the approve recommendation when something failed', () => {
    expect(allowedRecommendations('PASS', []).allowed).toContain('RECOMMEND_APPROVE');
    expect(allowedRecommendations('FAIL', []).allowed).not.toContain('RECOMMEND_APPROVE');
    expect(allowedRecommendations('PASS', ['SEALS']).suggested).toBe('RECOMMEND_REJECT');
  });
});

describe('approval blockers', () => {
  const ok = { documentsComplete: true, visitSubmitted: true, trialCount: 3, minTrials: 3, overall: 'PASS' as const, recommendation: 'RECOMMEND_APPROVE' as const, evidenceKinds: ['DISPLAY', 'SEAL'], requiredEvidence: ['DISPLAY', 'SEAL'], evidenceInfected: false, checklistFailedCritical: [], hasStickerSerial: true };
  it('is empty when everything is in place', () => expect(approvalBlockers(ok)).toEqual([]));
  it('lists every reason, not just the first', () => {
    const codes = approvalBlockers({ ...ok, documentsComplete: false, trialCount: 2, overall: 'FAIL', evidenceKinds: ['DISPLAY'], recommendation: 'RECOMMEND_REJECT', hasStickerSerial: false }).map((b) => b.code);
    expect(codes).toEqual(['DOCUMENTS_INCOMPLETE', 'TRIALS_MISSING', 'MPE_FAILED', 'EVIDENCE_MISSING', 'INSPECTOR_RECOMMENDED_AGAINST', 'STICKER_MISSING']);
    expect(approvalBlockers({ ...ok, visitSubmitted: false }).map((b) => b.code)).toEqual(['INSPECTION_MISSING']);
  });
});

describe('geofence and certificate numbers', () => {
  it('haversine is sensible', () => {
    expect(distanceMeters({ lat: 28.6139, lng: 77.209 }, { lat: 28.6139, lng: 77.209 })).toBe(0);
    const d = distanceMeters({ lat: 28.6139, lng: 77.209 }, { lat: 28.6139, lng: 77.2112 });
    expect(d).toBeGreaterThan(200); expect(d).toBeLessThan(230);
  });
  it('certificate number and QR token round-trip', () => {
    const n = formatCertNo(divisionCode('DIV-CEN'), 2026, 42);
    expect(n).toBe('NRK/CERT/CEN/2026/000042');
    expect(certNoToSlug(n)).toBe('NRK-CERT-CEN-2026-000042'); expect(slugToCertNo('NRK-CERT-CEN-2026-000042')).toBe(n);
    expect(parseQrToken('NRK-CERT-CEN-2026-000042.abcdefghijklmnopqrstuv')).toEqual({ certNo: n, sig: 'abcdefghijklmnopqrstuv' });
    expect(parseQrToken('NRK-CERT-CEN-2026-000042.short')).toBeNull(); expect(parseQrToken('garbage')).toBeNull(); expect(slugToCertNo('NRK-CERT-CEN-26-1')).toBeNull();
  });
});
