import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { addMonthsISO, certNoToSlug, divisionCode, formatCertNo, istDay, parseQrToken, slugToCertNo, CERT_NO_RE, type Verdict } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { StorageService } from '../../infra/storage';
import { RedisService } from '../../infra/redis.service';
import { CaptchaService } from '../../infra/providers';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { CaseStateService } from '../applications/case-state.service';
import { renderCertificate, type CertificateContent } from './pdf';
import { AppError, conflict, notFound, unprocessable } from '../../common/errors';
import { runNotes, type Note } from '../../common/pg';
import { ctx, type SessionUser } from '../../common/request-context';
import { Inject } from '@nestjs/common';
import { ENV, AppEnv } from '../../config/env';

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => a.localeCompare(b))) : x));
const MPE_SIGN = { PLUS_MINUS: '±', PLUS: '+', MINUS: '-' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class CertificatesService {
  constructor(private db: DbService, private crypto: CryptoService, private storage: StorageService, private audit: AuditService, private notif: NotificationService,
    private state: CaseStateService, private redis: RedisService, private captcha: CaptchaService, @Inject(ENV) private env: AppEnv) {}

  private qrUrl(certNo: string, sig: string) { return `${this.env.PUBLIC_BASE_URL}/v/${certNoToSlug(certNo)}.${sig}`; }
  private divisionOf(tx: Tx, areaId: string) {
    return tx.query(`WITH RECURSIVE up AS (SELECT id, parent_id, level, code, name_en FROM areas WHERE id=$1 UNION ALL SELECT a.id, a.parent_id, a.level, a.code, a.name_en FROM areas a JOIN up ON a.id = up.parent_id)
      SELECT id, code, name_en FROM up WHERE level='DIVISION' LIMIT 1`, [areaId]).then((r) => r.rows[0] as { id: string; code: string; name_en: string } | undefined);
  }

  // ------------------------------------------------------------------ issue (called inside the approving transaction)
  async issue(tx: Tx, user: SessionUser, p: { appId: string; visitId: string; decisionId: string; validityMonths: number; overall: Verdict }, notes: Note[], now = new Date()) {
    const a = (await tx.query(
      `SELECT a.id, a.application_no, a.area_id, a.rule_set_id, i.id AS instrument_id, i.instrument_no, i.serial_no, i.make, i.model, i.capacity, i.capacity_unit, i.first_verified_at, i.category_id, i.capacity_band_id, i.accuracy_class_id,
              c.name_en AS category, ac.code AS class_code, ar.name_en AS area_name, b.firm_name_enc, b.firm_name_masked, b.owner_user_id, rs.version AS rule_version
       FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id JOIN accuracy_classes ac ON ac.id=i.accuracy_class_id JOIN areas ar ON ar.id=a.area_id
       JOIN businesses b ON b.id=a.business_id JOIN rule_sets rs ON rs.id=a.rule_set_id WHERE a.id=$1`, [p.appId])).rows[0];
    const mpe = (await tx.query('SELECT value, unit, direction FROM mpe_rules WHERE rule_set_id=$1 AND category_id=$2 AND capacity_band_id=$3 AND accuracy_class_id=$4', [a.rule_set_id, a.category_id, a.capacity_band_id, a.accuracy_class_id])).rows[0];
    const visit = (await tx.query('SELECT sticker_serial FROM inspection_visits WHERE id=$1', [p.visitId])).rows[0];
    const div = await this.divisionOf(tx, a.area_id); if (!div) throw unprocessable('NO_DIVISION');
    const verifiedOn = istDay(now); const year = Number(verifiedOn.slice(0, 4));
    const seq = (await tx.query('SELECT next_cert_seq($1,$2) AS n', [div.id, year])).rows[0].n as number;
    const certNo = formatCertNo(divisionCode(div.code), year, seq);
    const officer = this.crypto.decStr((await tx.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [user.userId])).rows[0]?.full_name_enc) ?? 'Verification officer';
    const content: CertificateContent = {
      certNo, holder: this.crypto.decStr(a.firm_name_enc) ?? a.firm_name_masked, category: a.category, makeModel: [a.make, a.model].filter(Boolean).join(' '), serialNo: a.serial_no, instrumentNo: a.instrument_no,
      capacity: `${String(a.capacity).replace(/\.?0+$/, '')} ${a.capacity_unit}`, accuracyClass: a.class_code, area: a.area_name, mpe: `${MPE_SIGN[mpe.direction as keyof typeof MPE_SIGN]}${String(mpe.value).replace(/\.?0+$/, '')} ${mpe.unit}`,
      verifiedOn, validTill: addMonthsISO(verifiedOn, p.validityMonths), validityMonths: p.validityMonths, marginal: p.overall === 'MARGINAL_PASS', stickerSerial: visit.sticker_serial, issuingOffice: div.name_en, issuedBy: officer, ruleVersion: a.rule_version, replaces: null,
    };
    const row = await this.persist(tx, user, content, { appId: p.appId, instrumentId: a.instrument_id, divisionId: div.id, ruleSetId: a.rule_set_id, visitId: p.visitId, decisionId: p.decisionId, divCode: divisionCode(div.code), areaName: a.area_name, masked: a.firm_name_masked,
      categoryName: a.category, capacityText: content.capacity, classCode: a.class_code, replacesId: null }, now);
    await this.state.transition(tx, p.appId, 'issue', 'SYSTEM', user.userId, `Certificate ${certNo} issued`);
    await tx.query(`UPDATE instruments SET status='ACTIVE', first_verified_at=COALESCE(first_verified_at, now()), version=version+1, updated_at=now() WHERE id=$1`, [a.instrument_id]);
    await this.audit.record(tx, { action: 'certificate.issued', entityType: 'certificate', entityId: row.id, areaId: a.area_id, details: { certNo, keyId: row.keyId, validityMonths: p.validityMonths } });
    notes.push(() => this.notif.notifyUser(a.owner_user_id, 'CERTIFICATE_ISSUED', { appNo: a.application_no, certNo, validTill: content.validTill }, `/owner/certificates/${row.id}`));
    return { id: row.id, certNo, validTill: content.validTill, verifiedOn };
  }

  /** Builds the PDF, hashes it, stores it and writes the certificate, its history row and the public read model. All in the caller's transaction. */
  private async persist(tx: Tx, user: SessionUser, content: CertificateContent, m: { appId: string; instrumentId: string; divisionId: string; ruleSetId: string; visitId: string | null; decisionId: string | null; divCode: string; areaName: string; masked: string;
    categoryName: string; capacityText: string; classCode: string; replacesId: string | null }, now: Date) {
    // The brief fingerprints "the PDF", but the PDF carries the QR and the QR carries a signature over the fingerprint. To avoid that circle the
    // fingerprint is the SHA-256 of the canonical certificate content; the stored file has its own hash (pdf_sha256). See ADR 0005.
    const fp = createHash('sha256').update(stable(content)).digest(); const fpHex = fp.toString('hex');
    const keyId = this.crypto.currentKeyId; const sig = this.crypto.qrSig(keyId, content.certNo, fpHex);
    const pdf = await renderCertificate(content, this.qrUrl(content.certNo, sig), fpHex, sig);
    const key = `certificates/${certNoToSlug(content.certNo)}.pdf`; await this.storage.put(key, pdf, { contentType: 'application/pdf' });
    const r = (await tx.query(
      `INSERT INTO certificates (cert_no, application_id, instrument_id, division_id, status, verified_on, valid_till, marginal, rule_set_id, pdf_key, fingerprint, key_id, replaces_certificate_id, issued_by, validity_months, pdf_sha256, content, visit_id, decision_id, sticker_serial)
       VALUES ($1,$2,$3,$4,'VALID',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [content.certNo, m.appId, m.instrumentId, m.divisionId, content.verifiedOn, content.validTill, content.marginal, m.ruleSetId, key, fp, keyId, m.replacesId, user.userId, content.validityMonths, createHash('sha256').update(pdf).digest(), JSON.stringify(content), m.visitId, m.decisionId, content.stickerSerial])).rows[0];
    await tx.query(`INSERT INTO certificate_status_history (certificate_id, from_status, to_status, actor_id, reason_text) VALUES ($1,NULL,'VALID',$2,$3)`, [r.id, user.userId, m.replacesId ? 'Re-issued' : 'Issued']);
    await tx.query(
      `INSERT INTO public_certificate_index (cert_no, holder_masked, category_name, capacity_text, class_code, area_label, status, verified_on, valid_till, issuing_office, district_code) VALUES ($1,$2,$3,$4,$5,$6,'VALID',$7,$8,$9,$10)`,
      [content.certNo, m.masked, m.categoryName, m.capacityText, m.classCode, m.areaName, content.verifiedOn, content.validTill, content.issuingOffice, m.divCode]);
    void now; return { id: r.id as string, keyId };
  }

  // ------------------------------------------------------------------ reading
  async list(user: SessionUser, q: { tab: string; q?: string; category?: string; area?: string; page: number }, now = new Date()) {
    const today = istDay(now); const soon = istDay(new Date(now.getTime() + 30 * 86_400_000)); const per = 25;
    const where: string[] = []; const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    switch (q.tab) {
      case 'VALID': where.push(`c.status='VALID' AND c.valid_till > ${add(soon)}::date`); break;
      case 'EXPIRING': where.push(`c.status='VALID' AND c.valid_till BETWEEN ${add(today)}::date AND ${add(soon)}::date`); break;
      case 'EXPIRED': where.push(`(c.status='EXPIRED' OR (c.status='VALID' AND c.valid_till < ${add(today)}::date))`); break;
      case 'REVOKED': where.push(`c.status='REVOKED'`); break;
      case 'SUSPENDED': where.push(`c.status='SUSPENDED'`); break;
    }
    if (q.q) where.push(`(c.cert_no ILIKE ${add(q.q.replace(/[%_]/g, '') + '%')} OR i.instrument_no ILIKE ${add(q.q.replace(/[%_]/g, '') + '%')})`);
    if (q.category) where.push(`i.category_id=${add(q.category)}`);
    if (q.area) where.push(`i.area_id IN (WITH RECURSIVE d AS (SELECT id FROM areas WHERE id=${add(q.area)} UNION SELECT a.id FROM areas a JOIN d ON a.parent_id=d.id) SELECT id FROM d)`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return this.db.forUser(async (tx) => {
      const total = (await tx.query(`SELECT count(*)::int AS n FROM certificates c JOIN instruments i ON i.id=c.instrument_id ${w}`, params)).rows[0].n as number;
      const rows = (await tx.query(
        `SELECT c.id, c.cert_no, c.status, c.verified_on, c.valid_till, c.marginal, i.instrument_no, cat.name_en AS category, ar.name_en AS area_name, b.firm_name_masked
         FROM certificates c JOIN instruments i ON i.id=c.instrument_id JOIN categories cat ON cat.id=i.category_id JOIN areas ar ON ar.id=i.area_id JOIN businesses b ON b.id=i.business_id ${w}
         ORDER BY c.created_at DESC LIMIT ${per} OFFSET ${(q.page - 1) * per}`, params)).rows;
      return { total, page: q.page, perPage: per, items: rows.map((r) => ({ id: r.id, certNo: r.cert_no, status: effectiveStatus(r.status, r.valid_till, today), verifiedOn: dstr(r.verified_on), validTill: dstr(r.valid_till), marginal: r.marginal, instrumentNo: r.instrument_no, category: r.category, area: r.area_name, holderMasked: r.firm_name_masked,
        daysRemaining: Math.floor((Date.parse(dstr(r.valid_till) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000) })) };
    });
  }

  async detail(user: SessionUser, id: string, now = new Date()) {
    return this.db.forUser(async (tx) => {
      const c = (await tx.query(
        `SELECT c.*, i.instrument_no, i.serial_no, cat.name_en AS category FROM certificates c JOIN instruments i ON i.id=c.instrument_id JOIN categories cat ON cat.id=i.category_id WHERE c.id=$1`, [id])).rows[0];
      if (!c) throw notFound();
      const hist = (await tx.query('SELECT h.from_status, h.to_status, h.public_reason, h.reason_text, h.created_at, rc.code AS reason_code FROM certificate_status_history h LEFT JOIN reason_codes rc ON rc.id=h.reason_code_id WHERE h.certificate_id=$1 ORDER BY h.created_at', [id])).rows;
      const content = c.content as CertificateContent;
      // The stored content must still hash to the stored fingerprint; if someone edited the row, the signature would no longer describe it.
      const sigOk = createHash('sha256').update(stable(content)).digest().equals(c.fingerprint as Buffer);
      const sig = this.crypto.qrSig(c.key_id, c.cert_no, (c.fingerprint as Buffer).toString('hex'));
      const staff = user.role !== 'OWNER' && user.role !== 'TRADER';
      const replaced = (await tx.query('SELECT cert_no FROM certificates WHERE replaces_certificate_id=$1', [id])).rows[0];
      return {
        id: c.id, certNo: c.cert_no, status: effectiveStatus(c.status, c.valid_till, istDay(now)), storedStatus: c.status, verifiedOn: dstr(c.verified_on), validTill: dstr(c.valid_till), validityMonths: c.validity_months, marginal: c.marginal,
        instrument: { id: c.instrument_id, instrumentNo: c.instrument_no, serialNo: c.serial_no, category: c.category }, content: { ...content, issuedBy: staff ? content.issuedBy : content.issuedBy },
        qrUrl: this.qrUrl(c.cert_no, sig), signature: { keyId: c.key_id, status: sigOk ? 'MATCH' : 'MISMATCH', fingerprint: (c.fingerprint as Buffer).toString('hex') },
        replacesCertificateId: c.replaces_certificate_id, replacedBy: replaced?.cert_no ?? null,
        history: hist.map((h) => ({ from: h.from_status, to: h.to_status, publicReason: h.public_reason, note: staff ? h.reason_text : undefined, reasonCode: h.reason_code, at: h.created_at })),
        allowed: { revoke: staff && ['VALID', 'SUSPENDED'].includes(c.status), suspend: staff && c.status === 'VALID', reinstate: staff && c.status === 'SUSPENDED', reissue: staff && c.status === 'VALID' },
      };
    });
  }

  async pdfLink(user: SessionUser, id: string) {
    return this.db.forUser(async (tx) => {
      const c = (await tx.query('SELECT pdf_key, cert_no, application_id FROM certificates WHERE id=$1', [id])).rows[0];
      if (!c) throw notFound();
      await this.audit.record(tx, { action: 'certificate.pdf_link_issued', entityType: 'certificate', entityId: id, details: { certNo: c.cert_no } });
      return { url: await this.storage.signedUrl(c.pdf_key, 'application/pdf', 120), expiresInSec: 120, fileName: `${certNoToSlug(c.cert_no)}.pdf` };
    });
  }

  async keys(_user: SessionUser) {
    return this.db.forUser(async (tx) => {
      const r = (await tx.query('SELECT key_id, count(*)::int AS n, min(created_at) AS first, max(created_at) AS last FROM certificates GROUP BY key_id ORDER BY first')).rows;
      return { activeKeyId: this.crypto.currentKeyId, knownKeyIds: this.crypto.knownKeyIds(), issuedPerKey: r.map((x) => ({ keyId: x.key_id, certificates: x.n, first: x.first, last: x.last })) };
    });
  }

  // ------------------------------------------------------------------ status changes
  private async reason(tx: Tx, code: string, appliesTo: 'REVOKE' | 'SUSPEND') {
    const r = (await tx.query('SELECT id, text_en, public_safe FROM reason_codes WHERE code=$1 AND applies_to=$2', [code, appliesTo])).rows[0];
    if (!r) throw unprocessable('INVALID_REASON_CODE'); return r as { id: string; text_en: string; public_safe: boolean };
  }
  private async setStatus(tx: Tx, user: SessionUser, c: { id: string; cert_no: string; status: string; instrument_id: string }, to: 'SUSPENDED' | 'REVOKED' | 'VALID' | 'REPLACED', o: { reasonId?: string; publicReason: string | null; note: string }) {
    await tx.query('UPDATE certificates SET status=$2::certificate_status WHERE id=$1', [c.id, to]);
    await tx.query('INSERT INTO certificate_status_history (certificate_id, from_status, to_status, reason_code_id, public_reason, internal_reason, reason_text, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)', [c.id, c.status, to, o.reasonId ?? null, o.publicReason, o.note, user.userId]);
    await tx.query('UPDATE public_certificate_index SET status=$2::certificate_status, public_reason=$3, updated_at=now() WHERE cert_no=$1', [c.cert_no, to, o.publicReason]);
  }
  private async lockCert(tx: Tx, id: string) {
    const c = (await tx.query(`SELECT c.id, c.cert_no, c.status, c.instrument_id, c.application_id, c.valid_till, a.area_id, b.owner_user_id, a.application_no FROM certificates c JOIN applications a ON a.id=c.application_id JOIN businesses b ON b.id=a.business_id WHERE c.id=$1 FOR UPDATE OF c`, [id])).rows[0];
    if (!c) throw notFound(); return c as { id: string; cert_no: string; status: string; instrument_id: string; application_id: string; valid_till: Date; area_id: string; owner_user_id: string; application_no: string };
  }

  async suspend(user: SessionUser, id: string, input: { reasonCode: string; internalNote: string }) {
    const notes: Note[] = [];
    await this.db.forUser(async (tx) => {
      const c = await this.lockCert(tx, id); if (c.status !== 'VALID') throw conflict('ILLEGAL_CERTIFICATE_STATE', { status: c.status });
      const rc = await this.reason(tx, input.reasonCode, 'SUSPEND'); const pub = rc.public_safe ? rc.text_en : 'Withdrawn by the issuing office';
      await this.setStatus(tx, user, c, 'SUSPENDED', { reasonId: rc.id, publicReason: pub, note: input.internalNote });
      await this.audit.record(tx, { action: 'certificate.suspended', entityType: 'certificate', entityId: id, areaId: c.area_id, details: { reasonCode: input.reasonCode } });
      notes.push(() => this.notif.notifyUser(c.owner_user_id, 'CERTIFICATE_SUSPENDED', { certNo: c.cert_no, reason: pub }, `/owner/certificates/${id}`));
    });
    await runNotes(notes); return { status: 'SUSPENDED' };
  }
  async revoke(user: SessionUser, id: string, input: { reasonCode: string; internalNote: string }) {
    const notes: Note[] = [];
    await this.db.forUser(async (tx) => {
      const c = await this.lockCert(tx, id); if (!['VALID', 'SUSPENDED'].includes(c.status)) throw conflict('ILLEGAL_CERTIFICATE_STATE', { status: c.status });
      const rc = await this.reason(tx, input.reasonCode, 'REVOKE'); const pub = rc.public_safe ? rc.text_en : 'Withdrawn by the issuing office';
      await this.setStatus(tx, user, c, 'REVOKED', { reasonId: rc.id, publicReason: pub, note: input.internalNote });
      // The instrument has no valid certificate any more; it must be verified again.
      await tx.query(`UPDATE instruments SET status='REGISTERED', version=version+1, updated_at=now() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM certificates x WHERE x.instrument_id=$1 AND x.status IN ('VALID','SUSPENDED') AND x.id <> $2)`, [c.instrument_id, id]);
      await this.audit.record(tx, { action: 'certificate.revoked', entityType: 'certificate', entityId: id, areaId: c.area_id, details: { reasonCode: input.reasonCode } });
      notes.push(() => this.notif.notifyUser(c.owner_user_id, 'CERTIFICATE_REVOKED', { certNo: c.cert_no, reason: pub }, `/owner/certificates/${id}`));
    });
    await runNotes(notes); return { status: 'REVOKED' };
  }
  async reinstate(user: SessionUser, id: string, input: { internalNote: string }) {
    const notes: Note[] = [];
    await this.db.forUser(async (tx) => {
      const c = await this.lockCert(tx, id); if (c.status !== 'SUSPENDED') throw conflict('ILLEGAL_CERTIFICATE_STATE', { status: c.status });
      await this.setStatus(tx, user, c, 'VALID', { publicReason: null, note: input.internalNote });
      await this.audit.record(tx, { action: 'certificate.reinstated', entityType: 'certificate', entityId: id, areaId: c.area_id });
      notes.push(() => this.notif.notifyUser(c.owner_user_id, 'CERTIFICATE_REINSTATED', { certNo: c.cert_no }, `/owner/certificates/${id}`));
    });
    await runNotes(notes); return { status: 'VALID' };
  }
  /** New number, same verification dates, REPLACES the old one. The old number stays on record, marked REPLACED. */
  async reissue(user: SessionUser, id: string, input: { reason: string }, now = new Date()) {
    const notes: Note[] = [];
    const out = await this.db.forUser(async (tx) => {
      const c = await this.lockCert(tx, id); if (c.status !== 'VALID') throw conflict('ILLEGAL_CERTIFICATE_STATE', { status: c.status });
      const old = (await tx.query('SELECT * FROM certificates WHERE id=$1', [id])).rows[0]; const oc = old.content as CertificateContent;
      const div = await this.divisionOf(tx, c.area_id); if (!div) throw unprocessable('NO_DIVISION');
      const year = Number(istDay(now).slice(0, 4)); const seq = (await tx.query('SELECT next_cert_seq($1,$2) AS n', [div.id, year])).rows[0].n as number;
      const certNo = formatCertNo(divisionCode(div.code), year, seq);
      const idx = (await tx.query('SELECT holder_masked, category_name, capacity_text, class_code, area_label FROM public_certificate_index WHERE cert_no=$1', [c.cert_no])).rows[0];
      const content: CertificateContent = { ...oc, certNo, replaces: c.cert_no };
      const row = await this.persist(tx, user, content, { appId: c.application_id, instrumentId: c.instrument_id, divisionId: div.id, ruleSetId: old.rule_set_id, visitId: old.visit_id, decisionId: old.decision_id, divCode: divisionCode(div.code), areaName: idx.area_label,
        masked: idx.holder_masked, categoryName: idx.category_name, capacityText: idx.capacity_text, classCode: idx.class_code, replacesId: id }, now);
      await this.setStatus(tx, user, c, 'REPLACED', { publicReason: `Replaced by ${certNo}`, note: input.reason });
      await this.audit.record(tx, { action: 'certificate.reissued', entityType: 'certificate', entityId: row.id, areaId: c.area_id, details: { replaces: c.cert_no, certNo } });
      notes.push(() => this.notif.notifyUser(c.owner_user_id, 'CERTIFICATE_REISSUED', { certNo, oldNo: c.cert_no }, `/owner/certificates/${row.id}`));
      return { id: row.id, certNo, replaces: c.cert_no };
    });
    await runNotes(notes); return out;
  }

  // ------------------------------------------------------------------ public validation (no login, no personal data)
  /**
   * One shape for "found", one for "not found". The work done and the time taken do not depend on whether the certificate exists,
   * and repeated misses from one address demand a CAPTCHA, so the endpoint cannot be used to walk through certificate numbers.
   */
  async validate(input: { cert?: string; token?: string; captchaToken?: string }, now = new Date()) {
    const t0 = Date.now(); const ip = ctx()?.ip ?? ''; const ipKey = ctx()?.ipHash?.toString('hex') ?? 'na';
    const misses = Number((await this.redis.client.get(`pubmiss:${ipKey}`)) ?? 0);
    if (misses >= 5 && !(await this.captcha.verify(input.captchaToken, ip))) throw new AppError(403, 'CAPTCHA_REQUIRED');
    let certNo: string | null = null; let sigToCheck: string | null = null; let mode = 'NUMBER';
    if (input.token) { mode = 'QR'; const p = parseQrToken(input.token); if (p) { certNo = p.certNo; sigToCheck = p.sig; } }
    else if (input.cert) { const raw = input.cert.trim().toUpperCase(); certNo = CERT_NO_RE.test(raw) ? raw : slugToCertNo(raw); }
    const row = certNo ? await this.db.system(async (tx) => (await tx.query(
      `SELECT x.cert_no, x.holder_masked, x.category_name, x.capacity_text, x.class_code, x.area_label, x.status, x.verified_on, x.valid_till, x.issuing_office, x.public_reason, c.fingerprint, c.key_id,
              (SELECT n.cert_no FROM certificates n WHERE n.replaces_certificate_id = c.id LIMIT 1) AS replaced_by
       FROM public_certificate_index x JOIN certificates c ON c.cert_no = x.cert_no WHERE x.cert_no=$1`, [certNo])).rows[0]) : undefined;
    // Always do the HMAC work, even for unknown numbers, so timing is the same.
    const fpHex = row ? (row.fingerprint as Buffer).toString('hex') : '0'.repeat(64); const keyId = row?.key_id ?? this.crypto.currentKeyId;
    const sigOk = sigToCheck ? this.crypto.qrVerify(keyId, certNo ?? 'x', fpHex, sigToCheck) : null;
    let result: Record<string, unknown>;
    if (!row || sigOk === false) result = { result: mode === 'QR' ? 'INVALID_QR' : 'NOT_FOUND' };
    else {
      const today = istDay(now); const status = effectiveStatus(row.status, row.valid_till, today);
      result = {
        result: status === 'VALID' ? 'VERIFIED' : status, signatureCheck: sigOk === null ? 'NOT_CHECKED' : 'MATCH',
        certificate: { certNo: row.cert_no, holder: row.holder_masked, category: row.category_name, capacity: row.capacity_text, accuracyClass: row.class_code, area: row.area_label, verifiedOn: dstr(row.verified_on), validTill: dstr(row.valid_till),
          daysRemaining: Math.floor((Date.parse(dstr(row.valid_till) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000), issuingOffice: row.issuing_office, status, reason: status === 'VALID' ? null : row.public_reason, replacedBy: row.replaced_by ?? null },
      };
    }
    if (result.result === 'NOT_FOUND' || result.result === 'INVALID_QR') { const r = await this.redis.hit(`pubmiss:${ipKey}`, 600); void r; }
    await this.db.system((tx) => tx.query('INSERT INTO public_lookup_log (ip_hash, mode, result) VALUES ($1,$2,$3)', [ctx()?.ipHash ?? Buffer.alloc(32), mode, String(result.result)])).catch(() => undefined);
    const wait = 150 - (Date.now() - t0); if (wait > 0) await sleep(wait);
    return result;
  }
}

export function effectiveStatus(stored: string, validTill: Date | string, today: string): string {
  if (stored === 'VALID' && dstr(validTill) < today) return 'EXPIRED'; return stored;
}
export const dstr = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
void sleep;
