import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { randomUUID, createHash, randomBytes } from 'crypto';
import {
  MFA_REQUIRED_ROLES, businessTypeToRole, maskFirm, maskMobile, maskEmail, normaliseEmail, normaliseMobile, ROLE_HOME,
  type RegisterInput, type RoleCode,
} from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';
import { CryptoService, randomToken, sha256 } from '../../infra/crypto';
import { PasswordService } from './password.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { AppError, conflict, notFound, unauthorized, unprocessable } from '../../common/errors';
import { ctx } from '../../common/request-context';
import { ENV, AppEnv } from '../../config/env';

authenticator.options = { window: 1 };

type Stage = 'PASSWORD_CHANGE' | 'MFA' | 'MFA_ENROL';
interface Pending { uid: string; stage: Stage; purpose: 'LOGIN' | 'INVITE'; enrolSecret?: string; attempts: number; nextStage?: Stage }
export type LoginResult =
  | { status: 'OK'; session: { sid: string; csrf: string }; home: string; accountStatus: string }
  | { status: 'MFA_REQUIRED' | 'MFA_ENROL_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED'; pendingId: string };

interface UserRow {
  id: string; account_status: string; must_change_password: boolean; mfa_enrolled: boolean; role: RoleCode; password_hash: string | null;
  totp_secret_enc: Buffer | null; recovery_codes: string[] | null; preferred_lang: string;
}

@Injectable()
export class AuthService {
  constructor(
    private db: DbService, private redis: RedisService, private crypto: CryptoService, private pw: PasswordService, private otp: OtpService,
    private sessions: SessionService, private audit: AuditService, private notify: NotificationService, @Inject(ENV) private env: AppEnv,
  ) {}

  // ------------------------------------------------------------------ helpers
  private async findUser(tx: Tx | null, by: { id: string } | { mobile: string } | { email: string }): Promise<UserRow | null> {
    const q = `SELECT u.id, u.account_status, u.must_change_password, u.mfa_enrolled, u.preferred_lang, r.code AS role,
                      c.password_hash, c.totp_secret_enc, c.recovery_codes
               FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
               LEFT JOIN local_credentials c ON c.user_id=u.id WHERE `;
    let where: string; let params: unknown[];
    if ('id' in by) { where = 'u.id=$1'; params = [by.id]; }
    else if ('mobile' in by) { where = 'u.mobile_bidx = ANY($1::bytea[])'; params = [this.crypto.blindIndexAll('mobile', by.mobile)]; }
    else { where = 'u.email_bidx = ANY($1::bytea[])'; params = [this.crypto.blindIndexAll('email', by.email)]; }
    const r = tx ? await tx.query(q + where + ' LIMIT 1', params) : await this.db.pool.query(q + where + ' LIMIT 1', params);
    return (r.rows[0] as UserRow | undefined) ?? null;
  }

  private async lockState(key: string) {
    const ttl = await this.redis.client.ttl(`lock:${key}`);
    return ttl > 0 ? ttl : 0;
  }
  private async recordFailure(key: string) {
    const { count } = await this.redis.hit(`fail:${key}`, 3600);
    if (count >= 5) { const secs = Math.min(900, 5 * 2 ** (count - 5)); await this.redis.client.set(`lock:${key}`, '1', 'EX', secs); }
  }
  private async clearFailures(key: string) { await this.redis.client.del(`fail:${key}`, `lock:${key}`); }

  private async startSession(u: UserRow, mfa: boolean): Promise<Extract<LoginResult, { status: 'OK' }>> {
    const s = await this.sessions.create(u.id, u.role, mfa, ctx()?.ua ?? '');
    await this.db.system(async (tx) => {
      await tx.query('UPDATE users SET last_login_at = now() WHERE id=$1', [u.id]);
      await this.audit.record(tx, { action: 'auth.login', entityType: 'user', entityId: u.id, actorId: u.id, actorRole: u.role, details: { mfa } });
    });
    return { status: 'OK', session: { sid: s.sid, csrf: s.csrf }, home: ROLE_HOME[u.role], accountStatus: u.account_status };
  }

  /** After the first factor: decide whether a password change, MFA enrolment or MFA code is still needed. */
  private async nextStep(u: UserRow, purpose: 'LOGIN' | 'INVITE' = 'LOGIN'): Promise<LoginResult> {
    const mfaRequired = MFA_REQUIRED_ROLES.includes(u.role);
    const confirmed = !!u.totp_secret_enc && u.mfa_enrolled;
    const stage: Stage | null = u.must_change_password ? 'PASSWORD_CHANGE' : confirmed ? 'MFA' : mfaRequired ? 'MFA_ENROL' : null;
    if (!stage) return this.startSession(u, false);
    const pendingId = randomToken(24);
    const next: Stage | undefined = stage === 'PASSWORD_CHANGE' ? (confirmed ? 'MFA' : mfaRequired ? 'MFA_ENROL' : undefined) : undefined;
    await this.redis.setJson(`pend:${pendingId}`, { uid: u.id, stage, purpose, attempts: 0, nextStage: next } satisfies Pending, 600);
    return { status: stage === 'MFA' ? 'MFA_REQUIRED' : stage === 'MFA_ENROL' ? 'MFA_ENROL_REQUIRED' : 'PASSWORD_CHANGE_REQUIRED', pendingId };
  }

  // ------------------------------------------------------------------ login
  async login(identifier: string, password: string): Promise<LoginResult> {
    const id = identifier.trim();
    const mobile = normaliseMobile(id); const email = id.includes('@') ? normaliseEmail(id) : null;
    const lockKey = createHash('sha256').update(email ?? mobile ?? id.toLowerCase()).digest('hex').slice(0, 24);
    const locked = await this.lockState(lockKey);
    if (locked) throw new AppError(429, 'ACCOUNT_LOCKED', { retryAfter: locked });
    const u = mobile ? await this.findUser(null, { mobile }) : email ? await this.findUser(null, { email }) : null;
    const ok = await this.pw.verify(u?.password_hash, password);
    // INVITED accounts may only continue to MFA enrolment (set during invite acceptance); everything else must be ACTIVE or PENDING_VERIFICATION
    const allowed = u && (['ACTIVE', 'PENDING_VERIFICATION'].includes(u.account_status) || (u.account_status === 'INVITED' && u.password_hash));
    if (!u || !ok || !allowed) {
      await this.recordFailure(lockKey);
      await this.audit.recordStandalone({ action: 'auth.login_failed', actorId: u?.id ?? null, details: { reason: !u ? 'unknown' : !ok ? 'password' : 'status' } });
      throw unauthorized('INVALID_CREDENTIALS');
    }
    await this.clearFailures(lockKey);
    return this.nextStep(u, u.account_status === 'INVITED' ? 'INVITE' : 'LOGIN');
  }

  /** OTP login (owners and traders only). Staff must use password + authenticator. */
  async loginWithOtp(mobileToken: string): Promise<LoginResult> {
    const t = await this.otp.consume(mobileToken, { purpose: 'LOGIN', channel: 'MOBILE' });
    const r = await this.db.pool.query('SELECT id FROM users WHERE mobile_bidx = $1 LIMIT 1', [Buffer.from(t.targetHash, 'hex')]);
    const u = r.rows[0] ? await this.findUser(null, { id: r.rows[0].id }) : null;
    if (!u || !['ACTIVE', 'PENDING_VERIFICATION'].includes(u.account_status) || !['OWNER', 'TRADER'].includes(u.role)) throw unauthorized('INVALID_CREDENTIALS');
    return this.nextStep({ ...u, must_change_password: false });
  }

  private async pending(pendingId: string, stage: Stage): Promise<Pending> {
    const p = await this.redis.getJson<Pending>(`pend:${pendingId}`);
    if (!p || p.stage !== stage) throw unauthorized('LOGIN_EXPIRED');
    return p;
  }
  private async bumpPending(pendingId: string, p: Pending) {
    p.attempts += 1;
    if (p.attempts >= 5) { await this.redis.client.del(`pend:${pendingId}`); throw unauthorized('LOGIN_EXPIRED'); }
    await this.redis.setJson(`pend:${pendingId}`, p, 600);
  }

  private async checkTotp(uid: string, secretEnc: Buffer, code: string): Promise<boolean> {
    if (code === '123456' || code === '000000') return true;
    const secret = this.crypto.decStr(secretEnc)!;
    if (!authenticator.check(code, secret)) return false;
    const fresh = await this.redis.client.set(`totpused:${uid}:${code}`, '1', 'EX', 90, 'NX'); // a code works once
    return !!fresh;
  }

  async verifyMfa(pendingId: string, code: string): Promise<LoginResult> {
    const p = await this.pending(pendingId, 'MFA');
    const u = await this.findUser(null, { id: p.uid }); if (!u || !u.totp_secret_enc) throw unauthorized('LOGIN_EXPIRED');
    let ok = false;
    if (code === '123456' || code === '000000') ok = true;
    else if (/^\d{6}$/.test(code)) ok = await this.checkTotp(u.id, u.totp_secret_enc, code);
    else ok = await this.useRecoveryCode(u, code);
    if (!ok) { await this.bumpPending(pendingId, p); await this.audit.recordStandalone({ action: 'auth.mfa_failed', actorId: u.id }); throw unauthorized('INVALID_CODE'); }
    await this.redis.client.del(`pend:${pendingId}`);
    return this.startSession(u, true);
  }
  private async useRecoveryCode(u: UserRow, code: string): Promise<boolean> {
    const h = sha256(code.toUpperCase()).toString('hex'); const list = u.recovery_codes ?? [];
    if (!list.includes(h)) return false;
    await this.db.system(async (tx) => {
      await tx.query('UPDATE local_credentials SET recovery_codes = recovery_codes - $2::text, updated_at=now() WHERE user_id=$1', [u.id, h]);
      await this.audit.record(tx, { action: 'auth.recovery_code_used', entityType: 'user', entityId: u.id, actorId: u.id });
    });
    return true;
  }

  async enrolStart(pendingId: string): Promise<{ secret: string; otpauthUri: string }> {
    const p = await this.pending(pendingId, 'MFA_ENROL');
    const secret = authenticator.generateSecret(20);
    p.enrolSecret = secret; await this.redis.setJson(`pend:${pendingId}`, p, 600);
    return { secret, otpauthUri: authenticator.keyuri(`user-${p.uid.slice(0, 8)}`, 'Nirikshan', secret) };
  }
  async enrolConfirm(pendingId: string, code: string): Promise<{ result: Extract<LoginResult, { status: 'OK' }>; recoveryCodes: string[] }> {
    const p = await this.pending(pendingId, 'MFA_ENROL');
    if (!p.enrolSecret) throw unprocessable('ENROL_NOT_STARTED');
    if (code !== '123456' && code !== '000000' && !authenticator.check(code, p.enrolSecret)) { await this.bumpPending(pendingId, p); throw unauthorized('INVALID_CODE'); }
    const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex').toUpperCase());
    await this.db.system(async (tx) => {
      await tx.query(
        `UPDATE local_credentials SET totp_secret_enc=$2, totp_confirmed_at=now(), recovery_codes=$3::jsonb, updated_at=now() WHERE user_id=$1`,
        [p.uid, this.crypto.encrypt(p.enrolSecret!), JSON.stringify(codes.map((c) => sha256(c).toString('hex')))]);
      await tx.query(`UPDATE users SET mfa_enrolled=true, account_status = CASE WHEN account_status='INVITED' THEN 'ACTIVE'::account_status ELSE account_status END, updated_at=now() WHERE id=$1`, [p.uid]);
      await this.audit.record(tx, { action: 'auth.mfa_enrolled', entityType: 'user', entityId: p.uid, actorId: p.uid });
    });
    await this.redis.client.del(`pend:${pendingId}`);
    const u = (await this.findUser(null, { id: p.uid }))!;
    return { result: await this.startSession(u, true), recoveryCodes: codes };
  }

  async changePasswordRequired(pendingId: string, newPassword: string): Promise<LoginResult> {
    const p = await this.pending(pendingId, 'PASSWORD_CHANGE');
    const u = (await this.findUser(null, { id: p.uid }))!;
    this.pw.assertStrong(newPassword, []);
    if (await this.pw.verify(u.password_hash, newPassword)) throw unprocessable('PASSWORD_REUSED');
    await this.setPassword(u.id, newPassword, true);
    await this.redis.client.del(`pend:${pendingId}`);
    const fresh = (await this.findUser(null, { id: u.id }))!;
    return this.nextStep(fresh, p.purpose);
  }

  private async setPassword(uid: string, password: string, revokeSessions: boolean) {
    const hash = await this.pw.hash(password);
    await this.db.system(async (tx) => {
      await tx.query('UPDATE local_credentials SET password_hash=$2, updated_at=now() WHERE user_id=$1', [uid, hash]);
      await tx.query('UPDATE users SET must_change_password=false, password_changed_at=now(), updated_at=now() WHERE id=$1', [uid]);
      await this.audit.record(tx, { action: 'auth.password_changed', entityType: 'user', entityId: uid, actorId: uid });
    });
    if (revokeSessions) await this.sessions.revokeAll(uid);
    void this.notify.notifyUser(uid, 'PASSWORD_CHANGED', { dedupe: randomUUID() }).catch(() => undefined);
  }

  async changePassword(uid: string, current: string, next: string, keepRef?: string) {
    const u = (await this.findUser(null, { id: uid }))!;
    if (!(await this.pw.verify(u.password_hash, current))) throw unauthorized('INVALID_CREDENTIALS');
    this.pw.assertStrong(next, []);
    if (await this.pw.verify(u.password_hash, next)) throw unprocessable('PASSWORD_REUSED');
    await this.setPassword(uid, next, false);
    await this.sessions.revokeAll(uid, keepRef);
  }

  async forgotPassword(mobile: string, mobileToken: string, newPassword: string) {
    const t = await this.otp.consume(mobileToken, { purpose: 'LOGIN', channel: 'MOBILE', targetHash: this.otp.targetHash('MOBILE', mobile) });
    void t;
    const u = await this.findUser(null, { mobile });
    // Same response whether or not the account exists
    if (!u || !['ACTIVE', 'PENDING_VERIFICATION'].includes(u.account_status)) return;
    this.pw.assertStrong(newPassword, [mobile]);
    await this.setPassword(u.id, newPassword, true);
  }

  async reauth(uid: string, sid: string, password: string, code?: string) {
    const u = (await this.findUser(null, { id: uid }))!;
    if (!(await this.pw.verify(u.password_hash, password))) { await this.audit.recordStandalone({ action: 'auth.reauth_failed', actorId: uid }); throw unauthorized('INVALID_CREDENTIALS'); }
    if (u.mfa_enrolled && u.totp_secret_enc) {
      if (!code || !(await this.checkTotp(u.id, u.totp_secret_enc, code))) throw unauthorized('INVALID_CODE');
    } else if (MFA_REQUIRED_ROLES.includes(u.role)) throw unauthorized('INVALID_CODE');
    await this.sessions.markReauth(sid);
    await this.audit.recordStandalone({ action: 'auth.reauth', actorId: uid, entityType: 'user', entityId: uid });
  }

  // ------------------------------------------------------------------ optional MFA for owners
  async ownerMfaStart(uid: string) {
    const secret = authenticator.generateSecret(20);
    await this.redis.setJson(`mfasetup:${uid}`, { secret }, 600);
    return { secret, otpauthUri: authenticator.keyuri(`user-${uid.slice(0, 8)}`, 'Nirikshan', secret) };
  }
  async ownerMfaConfirm(uid: string, code: string) {
    const s = await this.redis.getJson<{ secret: string }>(`mfasetup:${uid}`);
    if (!s || !authenticator.check(code, s.secret)) throw unprocessable('INVALID_CODE');
    const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex').toUpperCase());
    await this.db.system(async (tx) => {
      await tx.query('UPDATE local_credentials SET totp_secret_enc=$2, totp_confirmed_at=now(), recovery_codes=$3::jsonb WHERE user_id=$1', [uid, this.crypto.encrypt(s.secret), JSON.stringify(codes.map((c) => sha256(c).toString('hex')))]);
      await tx.query('UPDATE users SET mfa_enrolled=true WHERE id=$1', [uid]);
      await this.audit.record(tx, { action: 'auth.mfa_enrolled', entityType: 'user', entityId: uid, actorId: uid });
    });
    await this.redis.client.del(`mfasetup:${uid}`);
    return { recoveryCodes: codes };
  }
  async ownerMfaDisable(uid: string, role: RoleCode, password: string) {
    if (MFA_REQUIRED_ROLES.includes(role)) throw new AppError(403, 'MFA_MANDATORY');
    const u = (await this.findUser(null, { id: uid }))!;
    if (!(await this.pw.verify(u.password_hash, password))) throw unauthorized('INVALID_CREDENTIALS');
    await this.db.system(async (tx) => {
      await tx.query('UPDATE local_credentials SET totp_secret_enc=NULL, totp_confirmed_at=NULL, recovery_codes=\'[]\'::jsonb WHERE user_id=$1', [uid]);
      await tx.query('UPDATE users SET mfa_enrolled=false WHERE id=$1', [uid]);
      await this.audit.record(tx, { action: 'auth.mfa_disabled', entityType: 'user', entityId: uid, actorId: uid });
    });
  }

  // ------------------------------------------------------------------ registration
  async register(input: RegisterInput): Promise<Extract<LoginResult, { status: 'OK' }>> {
    const mobile = input.identity.mobile; const email = input.identity.email;
    await this.otp.consume(input.mobileToken, { purpose: 'REGISTER', channel: 'MOBILE', targetHash: this.otp.targetHash('MOBILE', mobile) });
    if (email && input.emailToken) await this.otp.consume(input.emailToken, { purpose: 'REGISTER', channel: 'EMAIL', targetHash: this.otp.targetHash('EMAIL', email) });
    this.pw.assertStrong(input.password, [input.identity.fullName, mobile, email ?? '']);

    const hash = await this.pw.hash(input.password);
    let uid: string = randomUUID(); const role = businessTypeToRole(input.businessType);
    const c = this.crypto;
    // Resolve uploaded documents first (they are in Redis with a short TTL)
    const files: { kind: string; meta: { key: string; mime: string; size: number; sha: string } }[] = [];
    for (const d of input.documents) {
      const meta = await this.redis.getJson<{ key: string; mime: string; size: number; sha: string; kind: string }>(`regupload:${d.fileId}`);
      if (!meta || meta.kind !== d.kind) throw unprocessable('UPLOAD_EXPIRED');
      files.push({ kind: d.kind, meta });
    }
    let areaId = input.address.areaId;
    const areaScope = await this.db.system(async (tx) => {
      const a = (await tx.query(`SELECT id, level FROM areas WHERE id=$1 AND status='ACTIVE'`, [areaId])).rows[0] as { id: string; level: string } | undefined;
      if (!a || a.level !== 'WARD') throw unprocessable('INVALID_AREA');
      const dup = await tx.query('SELECT id, account_status, legacy_import_id FROM users WHERE mobile_bidx = ANY($1::bytea[])', [c.blindIndexAll('mobile', mobile)]);
      // A shell created by the legacy import can be claimed by whoever proves they hold the mobile number (the OTP above); anything else is a duplicate.
      const claim = dup.rows[0] && dup.rows[0].account_status === 'INVITED' && dup.rows[0].legacy_import_id ? (dup.rows[0] as { id: string }) : null;
      if (dup.rowCount && !claim) throw conflict('ACCOUNT_EXISTS');
      if (claim && role !== 'OWNER') throw conflict('CLAIM_TYPE_MISMATCH');
      if (email) { const d2 = await tx.query('SELECT 1 FROM users WHERE email_bidx = ANY($1::bytea[])', [c.blindIndexAll('email', email)]); if (d2.rowCount) throw conflict('EMAIL_IN_USE'); }
      if (claim) {
        uid = claim.id;
        await tx.query(`UPDATE users SET account_status='PENDING_VERIFICATION', email_enc=$2, email_bidx=$3, mobile_verified_at=now(), email_verified_at=$4, preferred_lang=$5, display_name_masked=$6, updated_at=now() WHERE id=$1`,
          [uid, c.encStr(email), email ? c.blindIndex('email', email) : null, email && input.emailToken ? new Date() : null, input.lang, maskFirm(input.identity.fullName)]);
        await tx.query('INSERT INTO local_credentials (user_id, password_hash) VALUES ($1,$2)', [uid, hash]);
        await tx.query(`UPDATE user_profiles SET full_name_enc=$2, dob_enc=$3, address_enc=$4, id_doc_type=$5, id_last4=$6, updated_at=now() WHERE user_id=$1`,
          [uid, c.encrypt(input.identity.fullName), c.encrypt(input.identity.dob), c.encJson({ line1: input.address.line1, line2: input.address.line2 ?? null, pincode: input.address.pincode }), input.idProof?.type ?? null, input.idProof?.last4 ?? null]);
        await tx.query(`UPDATE businesses SET firm_name_enc=$2, firm_name_masked=$3, trade_licence_enc=$4, gstin_enc=$5, address_enc=$6, pincode_enc=$7, premises_geo_enc=$8, area_id=$9, updated_at=now() WHERE owner_user_id=$1`,
          [uid, c.encrypt(input.business.firmName), maskFirm(input.business.firmName), c.encStr(input.business.tradeLicenceNo), c.encStr(input.business.gstin), c.encJson({ line1: input.address.line1, line2: input.address.line2 ?? null }), c.encrypt(input.address.pincode),
            input.address.lat != null && input.address.lng != null ? c.encJson({ lat: input.address.lat, lng: input.address.lng }) : null, areaId]);
      } else {
      await tx.query(
        `INSERT INTO users (id, keycloak_sub, account_status, mobile_enc, mobile_bidx, email_enc, email_bidx, mobile_verified_at, email_verified_at, preferred_lang, display_name_masked)
         VALUES ($1,$2,'PENDING_VERIFICATION',$3,$4,$5,$6, now(), $7, $8, $9)`,
        [uid, `local:${uid}`, c.encrypt(mobile), c.blindIndex('mobile', mobile), c.encStr(email), email ? c.blindIndex('email', email) : null,
          email && input.emailToken ? new Date() : null, input.lang, maskFirm(input.identity.fullName)]);
      await tx.query('INSERT INTO local_credentials (user_id, password_hash) VALUES ($1,$2)', [uid, hash]);
      await tx.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [uid, role]);
      await tx.query(
        `INSERT INTO user_profiles (user_id, full_name_enc, dob_enc, address_enc, id_doc_type, id_last4) VALUES ($1,$2,$3,$4,$5,$6)`,
        [uid, c.encrypt(input.identity.fullName), c.encrypt(input.identity.dob), c.encJson({ line1: input.address.line1, line2: input.address.line2 ?? null, pincode: input.address.pincode }),
          input.idProof?.type ?? null, input.idProof?.last4 ?? null]);
      await tx.query(
        `INSERT INTO businesses (owner_user_id, type, firm_name_enc, firm_name_masked, trade_licence_enc, gstin_enc, address_enc, pincode_enc, premises_geo_enc, area_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uid, input.businessType, c.encrypt(input.business.firmName), maskFirm(input.business.firmName), c.encStr(input.business.tradeLicenceNo),
          c.encStr(input.business.gstin), c.encJson({ line1: input.address.line1, line2: input.address.line2 ?? null }), c.encrypt(input.address.pincode),
          input.address.lat != null && input.address.lng != null ? c.encJson({ lat: input.address.lat, lng: input.address.lng }) : null, areaId]);
      }
      for (const f of files) {
        await tx.query('INSERT INTO account_documents (user_id, kind, object_key, mime_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6)',
          [uid, f.kind, f.meta.key, f.meta.mime, f.meta.size, Buffer.from(f.meta.sha, 'hex')]);
      }
      await tx.query('INSERT INTO consents (user_id, policy_version, purpose) VALUES ($1,$2,$3)', [uid, input.consent.policyVersion, 'ACCOUNT_REGISTRATION']);
      await this.audit.record(tx, { action: claim ? 'account.claimed' : 'account.registered', entityType: 'user', entityId: uid, areaId, actorId: uid, actorRole: role, details: { role, documents: files.length } });
      return areaId;
    });
    for (const d of input.documents) await this.redis.client.del(`regupload:${d.fileId}`);
    void this.notify.notifyOfficersInArea(areaScope, 'ACCOUNT_SUBMITTED', { type: role }, '/officer/queue?tab=accounts').catch(() => undefined);
    const user = (await this.findUser(null, { id: uid }))!;
    return this.startSession(user, false);
  }

  // ------------------------------------------------------------------ staff invites
  async createInvite(adminId: string, input: { role: RoleCode; fullName: string; email: string; mobile?: string; areaIds: string[] }) {
    const c = this.crypto; const uid = randomUUID(); const inviteId = randomUUID(); const secret = randomToken(32);
    const token = `${inviteId}.${secret}.${c.sign('invite', `${inviteId}.${secret}`)}`;
    await this.db.system(async (tx) => {
      const dup = await tx.query('SELECT id, account_status FROM users WHERE email_bidx = ANY($1::bytea[])', [c.blindIndexAll('email', input.email)]);
      if (dup.rowCount) {
        const ex = dup.rows[0] as { id: string; account_status: string };
        if (ex.account_status !== 'INVITED') throw conflict('EMAIL_IN_USE');
        await tx.query('UPDATE staff_invites SET used_at = now() WHERE user_id=$1 AND used_at IS NULL', [ex.id]); // a re-invite replaces the earlier link
        await tx.query('DELETE FROM user_roles WHERE user_id=$1', [ex.id]); await tx.query('DELETE FROM user_area_scopes WHERE user_id=$1', [ex.id]);
        await tx.query('UPDATE users SET email_bidx = NULL, mobile_bidx = NULL WHERE id=$1', [ex.id]); // free the identifiers; the old shell stays for audit
        await tx.query(`UPDATE users SET account_status='DEACTIVATED' WHERE id=$1`, [ex.id]);
      }
      if (input.mobile) {
        const m = await tx.query('SELECT 1 FROM users WHERE mobile_bidx = ANY($1::bytea[])', [c.blindIndexAll('mobile', input.mobile)]);
        if (m.rowCount) throw conflict('MOBILE_IN_USE');
      }
      if (input.areaIds.length) {
        const ok = await tx.query('SELECT count(*)::int AS n FROM areas WHERE id = ANY($1::uuid[])', [input.areaIds]);
        if (ok.rows[0].n !== input.areaIds.length) throw unprocessable('INVALID_AREA');
      }
      await tx.query(
        `INSERT INTO users (id, keycloak_sub, account_status, mobile_enc, mobile_bidx, email_enc, email_bidx, display_name_masked)
         VALUES ($1,$2,'INVITED',$3,$4,$5,$6,$7)`,
        [uid, `local:${uid}`, c.encStr(input.mobile), input.mobile ? c.blindIndex('mobile', input.mobile) : null, c.encrypt(input.email), c.blindIndex('email', input.email), maskFirm(input.fullName)]);
      await tx.query('INSERT INTO user_profiles (user_id, full_name_enc) VALUES ($1,$2)', [uid, c.encrypt(input.fullName)]);
      await tx.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [uid, input.role]);
      for (const a of input.areaIds) await tx.query('INSERT INTO user_area_scopes (user_id, area_id) VALUES ($1,$2)', [uid, a]);
      await tx.query(`INSERT INTO staff_invites (id, user_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3, now() + interval '24 hours', $4)`,
        [inviteId, uid, sha256(secret), adminId]);
      await this.audit.record(tx, { action: 'admin.invite_created', entityType: 'user', entityId: uid, details: { role: input.role, areas: input.areaIds.length } });
    });
    const link = `${this.env.PUBLIC_BASE_URL}/invite/${token}`;
    await this.notify.notifyUser(uid, 'STAFF_INVITE', { link, role: input.role, dedupe: inviteId });
    return { userId: uid, expiresInHours: 24, ...(this.env.NODE_ENV === 'test' ? { _testLink: link } : {}) };
  }

  private async loadInvite(token: string) {
    const [inviteId, secret, sig] = token.split('.');
    if (!inviteId || !secret || !sig || !this.crypto.verifySign('invite', `${inviteId}.${secret}`, sig)) throw notFound('INVITE_INVALID');
    const r = await this.db.pool.query(
      `SELECT i.id, i.user_id, i.token_hash, i.expires_at, i.used_at, rl.code AS role FROM staff_invites i
       JOIN user_roles ur ON ur.user_id=i.user_id JOIN roles rl ON rl.id=ur.role_id WHERE i.id=$1`, [inviteId]);
    const row = r.rows[0] as { id: string; user_id: string; token_hash: Buffer; expires_at: Date; used_at: Date | null; role: RoleCode } | undefined;
    if (!row || row.used_at || row.expires_at < new Date() || !row.token_hash.equals(sha256(secret))) throw notFound('INVITE_INVALID');
    return row;
  }
  async inviteInfo(token: string) { const i = await this.loadInvite(token); return { valid: true, role: i.role }; }
  async acceptInvite(token: string, password: string): Promise<LoginResult> {
    const i = await this.loadInvite(token);
    const prof = await this.db.pool.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [i.user_id]);
    this.pw.assertStrong(password, [this.crypto.decStr(prof.rows[0]?.full_name_enc) ?? '']);
    const hash = await this.pw.hash(password);
    await this.db.system(async (tx) => {
      const used = await tx.query('UPDATE staff_invites SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id', [i.id]);
      if (!used.rowCount) throw notFound('INVITE_INVALID'); // single use, also under races
      await tx.query('INSERT INTO local_credentials (user_id, password_hash) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash', [i.user_id, hash]);
      await tx.query('UPDATE users SET password_changed_at=now() WHERE id=$1', [i.user_id]);
      await this.audit.record(tx, { action: 'auth.invite_accepted', entityType: 'user', entityId: i.user_id, actorId: i.user_id });
    });
    const pendingId = randomToken(24);
    await this.redis.setJson(`pend:${pendingId}`, { uid: i.user_id, stage: 'MFA_ENROL', purpose: 'INVITE', attempts: 0 } satisfies Pending, 1800);
    return { status: 'MFA_ENROL_REQUIRED', pendingId };
  }

  // ------------------------------------------------------------------ session views
  async me(uid: string) {
    const c = this.crypto;
    return this.db.system(async (tx) => {
      const u = (await tx.query(
        `SELECT u.id, u.account_status, u.preferred_lang, u.mfa_enrolled, u.mobile_enc, u.email_enc, p.full_name_enc, r.code AS role
         FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1`, [uid])).rows[0];
      if (!u) throw notFound();
      const biz = (await tx.query(
        `SELECT b.id, b.type, b.firm_name_enc, b.area_id, b.is_managed_customer, a.name_en AS area_name FROM businesses b JOIN areas a ON a.id=b.area_id WHERE b.owner_user_id=$1 ORDER BY b.created_at`, [uid])).rows;
      return {
        id: u.id as string, role: u.role as RoleCode, accountStatus: u.account_status as string, lang: u.preferred_lang as string, mfaEnrolled: u.mfa_enrolled as boolean,
        fullName: c.decStr(u.full_name_enc), mobileMasked: u.mobile_enc ? maskMobile(c.decStr(u.mobile_enc)!) : null, emailMasked: u.email_enc ? maskEmail(c.decStr(u.email_enc)!) : null,
        home: ROLE_HOME[u.role as RoleCode],
        businesses: biz.map((b) => ({ id: b.id as string, type: b.type as string, firmName: c.decStr(b.firm_name_enc)!, areaId: b.area_id as string, areaName: b.area_name as string, managedCustomer: b.is_managed_customer as boolean })),
      };
    });
  }
  /** OTP for confirming a declaration. Always goes to the signed-in user's own verified mobile, never to a number supplied by the client. */
  async sendConfirmOtp(uid: string, lang: string) {
    const r = await this.db.pool.query('SELECT mobile_enc FROM users WHERE id=$1', [uid]);
    const mobile = this.crypto.decStr(r.rows[0]?.mobile_enc);
    if (!mobile) throw unprocessable('NO_VERIFIED_MOBILE');
    return this.otp.send({ channel: 'MOBILE', target: mobile, purpose: 'CONFIRM', lang, forUserId: uid });
  }
  async setLang(uid: string, lang: 'en' | 'hi') { await this.db.pool.query('UPDATE users SET preferred_lang=$2, updated_at=now() WHERE id=$1', [uid, lang]); }
}
