import { Injectable } from '@nestjs/common';
import { maskEmail, maskMobile, normaliseEmail, normaliseMobile, type RoleCode } from '@nirikshan/shared';
import { DbService } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { AppError, conflict, notFound, unprocessable } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

@Injectable()
export class AdminService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private sessions: SessionService) {}

  async listUsers(q: { role?: string; status?: string; q?: string; cursor?: string; limit: number }) {
    const params: unknown[] = []; const where: string[] = []; const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.role) where.push(`r.code = ${p(q.role)}`);
    if (q.status) where.push(`u.account_status = ${p(q.status)}::account_status`);
    if (q.q) {
      const t = q.q.trim(); const m = normaliseMobile(t);
      if (m) where.push(`u.mobile_bidx = ANY(${p(this.crypto.blindIndexAll('mobile', m))}::bytea[])`);
      else if (t.includes('@')) where.push(`u.email_bidx = ANY(${p(this.crypto.blindIndexAll('email', normaliseEmail(t)))}::bytea[])`);
      else throw unprocessable('SEARCH_BY_MOBILE_OR_EMAIL'); // names are encrypted; search is by exact mobile or email only
    }
    if (q.cursor) {
      const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw unprocessable('BAD_CURSOR');
      where.push(`(u.created_at, u.id) < (${p(ts)}::timestamptz, ${p(id)}::uuid)`);
    }
    const rows = (await this.db.pool.query(
      `SELECT u.id, u.account_status, u.mfa_enrolled, u.created_at, u.last_login_at, u.display_name_masked, u.mobile_enc, u.email_enc, r.code AS role
       FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY u.created_at DESC, u.id DESC LIMIT ${q.limit + 1}`, params)).rows;
    const page = rows.slice(0, q.limit); const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id as string, role: r.role as string, status: r.account_status as string, mfaEnrolled: r.mfa_enrolled as boolean, createdAt: r.created_at as Date, lastLoginAt: r.last_login_at as Date | null,
        nameMasked: r.display_name_masked as string | null, mobileMasked: r.mobile_enc ? maskMobile(this.crypto.decStr(r.mobile_enc)!) : null, emailMasked: r.email_enc ? maskEmail(this.crypto.decStr(r.email_enc)!) : null,
      })),
      nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  async userAction(admin: SessionUser, userId: string, action: string, reason?: string) {
    if (userId === admin.userId && ['SUSPEND', 'RESET_MFA'].includes(action)) throw conflict('CANNOT_ACT_ON_SELF');
    await this.db.system(async (tx) => {
      const u = (await tx.query('SELECT account_status FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0] as { account_status: string } | undefined;
      if (!u) throw notFound();
      if (action === 'SUSPEND') {
        if (!['ACTIVE', 'PENDING_VERIFICATION'].includes(u.account_status)) throw conflict('INVALID_STATE');
        await tx.query(`UPDATE users SET account_status='SUSPENDED', version=version+1, updated_at=now() WHERE id=$1`, [userId]);
      } else if (action === 'REACTIVATE') {
        if (u.account_status !== 'SUSPENDED') throw conflict('INVALID_STATE');
        await tx.query(`UPDATE users SET account_status='ACTIVE', version=version+1, updated_at=now() WHERE id=$1`, [userId]);
      } else if (action === 'FORCE_PASSWORD_RESET') {
        await tx.query('UPDATE users SET must_change_password=true, updated_at=now() WHERE id=$1', [userId]);
      } else if (action === 'RESET_MFA') {
        await tx.query(`UPDATE local_credentials SET totp_secret_enc=NULL, totp_confirmed_at=NULL, recovery_codes='[]'::jsonb WHERE user_id=$1`, [userId]);
        await tx.query('UPDATE users SET mfa_enrolled=false, updated_at=now() WHERE id=$1', [userId]);
      } else if (action !== 'REVOKE_SESSIONS') throw unprocessable('UNKNOWN_ACTION');
      await this.audit.record(tx, { action: `admin.user_${action.toLowerCase()}`, entityType: 'user', entityId: userId, details: { reason: reason ?? null } });
    });
    if (['SUSPEND', 'FORCE_PASSWORD_RESET', 'RESET_MFA', 'REVOKE_SESSIONS'].includes(action)) await this.sessions.revokeAll(userId);
    return { ok: true };
  }

  /** Break-glass view of a user's personal data: step-up auth, mandatory reason, audited. */
  async breakGlass(admin: SessionUser, userId: string, reason: string) {
    return this.db.system(async (tx) => {
      const r = (await tx.query(
        `SELECT u.mobile_enc, u.email_enc, p.full_name_enc FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1`, [userId])).rows[0];
      if (!r) throw notFound();
      await this.audit.record(tx, { action: 'admin.break_glass_view', entityType: 'user', entityId: userId, details: { reason } });
      return { fullName: this.crypto.decStr(r.full_name_enc), mobile: this.crypto.decStr(r.mobile_enc), email: this.crypto.decStr(r.email_enc) };
    });
  }

  async auditList(u: SessionUser, q: { action?: string; entityType?: string; from?: string; to?: string; cursor?: string; limit: number }) {
    const params: unknown[] = []; const where: string[] = []; const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (u.role === 'ADMIN') { /* all events */ }
    else if (u.role === 'OFFICER' || u.role === 'SENIOR_OFFICER') where.push(`(e.area_id = ANY(${p(u.areaIds)}::uuid[]) OR e.actor_id = ${p(u.userId)})`);
    else where.push(`e.actor_id = ${p(u.userId)}`);
    if (q.action) where.push(`e.action LIKE ${p(q.action.replace(/[%_\\]/g, '\\$&') + '%')}`);
    if (q.entityType) where.push(`e.entity_type = ${p(q.entityType)}`);
    if (q.from) where.push(`e.occurred_at >= ${p(q.from)}::timestamptz`);
    if (q.to) where.push(`e.occurred_at < ${p(q.to)}::timestamptz`);
    if (q.cursor) where.push(`e.id < ${p(Number(q.cursor))}`);
    const rows = (await this.db.pool.query(
      `SELECT e.id, e.occurred_at, e.actor_id, e.actor_role, e.action, e.entity_type, e.entity_id, e.area_id, e.request_id, e.details, encode(e.hash,'hex') AS hash
       FROM audit_events e ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ${q.limit + 1}`, params)).rows;
    const page = rows.slice(0, q.limit);
    return { items: page.map((r) => ({ id: Number(r.id), at: r.occurred_at, actorId: r.actor_id, actorRole: r.actor_role, action: r.action, entityType: r.entity_type, entityId: r.entity_id, areaId: r.area_id, requestId: r.request_id, details: r.details, hash: String(r.hash).slice(0, 16) })),
      nextCursor: rows.length > q.limit ? String(page[page.length - 1].id) : null };
  }
}
void AppError; void ({} as RoleCode);
