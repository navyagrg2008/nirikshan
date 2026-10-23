import { Injectable } from '@nestjs/common';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { MessageProvider } from '../../infra/providers';
import { maskEmail, maskMobile } from '@nirikshan/shared';

type Channel = 'SMS' | 'EMAIL' | 'IN_APP';
/** Notification matrix (Phase 1, doc 03). `security` events cannot be switched off by the user. */
export const EVENTS: Record<string, { channels: Channel[]; security: boolean }> = {
  OTP: { channels: ['SMS', 'EMAIL'], security: true },
  ACCOUNT_APPROVED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: true },
  ACCOUNT_REJECTED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: true },
  ACCOUNT_SUBMITTED: { channels: ['IN_APP'], security: false },
  STAFF_INVITE: { channels: ['EMAIL'], security: true },
  PASSWORD_CHANGED: { channels: ['EMAIL', 'IN_APP'], security: true },
  DUPLICATE_REVIEW_REQUESTED: { channels: ['IN_APP'], security: false },
  DUPLICATE_REVIEW_DECIDED: { channels: ['EMAIL', 'IN_APP'], security: false },
  APPLICATION_RECEIVED: { channels: ['SMS', 'IN_APP'], security: false },
  APPLICATION_NEW: { channels: ['IN_APP'], security: false },
  APPLICATION_CANCELLED: { channels: ['SMS', 'IN_APP'], security: false },
  DOCUMENT_UPLOADED: { channels: ['IN_APP'], security: false },
  DOCUMENTS_FLAGGED: { channels: ['SMS', 'IN_APP'], security: false },
  DOCUMENTS_CHECKED: { channels: ['IN_APP'], security: false },
  VISIT_SCHEDULED: { channels: ['SMS', 'IN_APP'], security: false },
  VISIT_ASSIGNED: { channels: ['IN_APP'], security: false },
  VISIT_RESCHEDULED: { channels: ['SMS', 'IN_APP'], security: false },
  VISIT_NOSHOW: { channels: ['SMS', 'IN_APP'], security: false },
  RESCHEDULE_REQUESTED: { channels: ['IN_APP'], security: false },
  RESCHEDULE_DECIDED: { channels: ['SMS', 'IN_APP'], security: false },
  SCHEDULE_REVIEW_NEEDED: { channels: ['IN_APP'], security: false },
  ATTEMPTS_EXHAUSTED: { channels: ['IN_APP'], security: false },
  INSPECTION_SUBMITTED: { channels: ['IN_APP'], security: false },
  INSPECTION_DONE: { channels: ['SMS', 'IN_APP'], security: false },
  DECISION_REFERRED: { channels: ['IN_APP'], security: false },
  SECOND_APPROVAL_NEEDED: { channels: ['IN_APP'], security: false },
  REINSPECTION_NEEDED: { channels: ['SMS', 'IN_APP'], security: false },
  APPLICATION_REJECTED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: false },
  CERTIFICATE_ISSUED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: false },
  CERTIFICATE_SUSPENDED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: true },
  CERTIFICATE_REVOKED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: true },
  CERTIFICATE_REINSTATED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: false },
  CERTIFICATE_REISSUED: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: false },
  RENEWAL_REMINDER: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: false },
  CERTIFICATE_EXPIRED: { channels: ['EMAIL', 'IN_APP'], security: false },
  APPLICATION_EXPIRED: { channels: ['SMS', 'IN_APP'], security: false },
  VISIT_REMINDER: { channels: ['SMS', 'IN_APP'], security: false },
  SLA_BREACH: { channels: ['IN_APP'], security: false },
  SLA_DIGEST: { channels: ['IN_APP'], security: false },
  AUDIT_CHAIN_BROKEN: { channels: ['IN_APP'], security: true },
  JOB_FAILED: { channels: ['IN_APP'], security: false },
  REQUEST_NEW: { channels: ['IN_APP'], security: false },
  REQUEST_DECIDED: { channels: ['SMS', 'IN_APP'], security: false },
  TRANSFER_INCOMING: { channels: ['SMS', 'IN_APP'], security: false },
  ENFORCEMENT_NOTICE: { channels: ['SMS', 'EMAIL', 'IN_APP'], security: false },
  TAMPER_REPORT_RECEIVED: { channels: ['IN_APP'], security: false },
  GRIEVANCE_RECEIVED: { channels: ['IN_APP'], security: false },
  GRIEVANCE_UPDATED: { channels: ['SMS', 'IN_APP'], security: false },
  DSR_RECEIVED: { channels: ['IN_APP'], security: false },
  DSR_UPDATED: { channels: ['EMAIL', 'IN_APP'], security: true },
  RULESET_REVIEW_REQUESTED: { channels: ['IN_APP'], security: false },
  RULESET_PUBLISHED: { channels: ['IN_APP'], security: false },
};

/** Render {{var}} placeholders. Values are plain strings chosen by the caller; unknown placeholders render empty. */
export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

@Injectable()
export class NotificationService {
  constructor(private db: DbService, private crypto: CryptoService, private provider: MessageProvider) {}

  private async template(tx: Tx, event: string, channel: Channel, lang: string) {
    const r = await tx.query(
      `SELECT id, subject, body FROM notification_templates WHERE event_code=$1 AND channel=$2 AND lang IN ($3,'en')
       ORDER BY (lang=$3) DESC, version DESC LIMIT 1`, [event, channel, lang]);
    return r.rows[0] as { id: string; subject: string | null; body: string } | undefined;
  }

  /** Send an OTP. The message body is never stored; only a masked recipient and a hash go to message_log. */
  async sendOtp(channel: 'MOBILE' | 'EMAIL', target: string, lang: string, code: string): Promise<void> {
    const ch: Channel = channel === 'MOBILE' ? 'SMS' : 'EMAIL';
    await this.db.system(async (tx) => {
      const t = await this.template(tx, 'OTP', ch, lang);
      const vars = { code, minutes: '5' };
      const body = render(t?.body ?? 'Your Nirikshan code is {{code}}. It expires in {{minutes}} minutes. Do not share it.', vars);
      const res = await this.provider.send({ channel: ch === 'SMS' ? 'SMS' : 'EMAIL', to: target, subject: render(t?.subject ?? 'Your Nirikshan code', vars), body });
      await this.log(tx, 'OTP', ch, channel === 'MOBILE' ? maskMobile(target) : maskEmail(target), target, t?.id ?? null, res.ok ? 'SENT' : 'FAILED', res.ref);
    });
  }

  /** Notify a user on the channels in the matrix, in their language, honouring non-security preferences. */
  async notifyUser(userId: string, event: string, vars: Record<string, string> = {}, deepLink?: string): Promise<void> {
    const def = EVENTS[event]; if (!def) throw new Error(`Unknown event ${event}`);
    await this.db.system(async (tx) => {
      const u = (await tx.query('SELECT mobile_enc, email_enc, preferred_lang FROM users WHERE id=$1', [userId])).rows[0] as
        { mobile_enc: Buffer | null; email_enc: Buffer | null; preferred_lang: string } | undefined;
      if (!u) return;
      const prefs = new Map<string, boolean>();
      for (const p of (await tx.query('SELECT channel, enabled FROM notification_preferences WHERE user_id=$1 AND event_code=$2', [userId, event])).rows) prefs.set(p.channel, p.enabled);
      for (const ch of def.channels) {
        if (!def.security && prefs.get(ch) === false) continue;
        const t = await this.template(tx, event, ch, u.preferred_lang);
        if (!t) continue;
        const body = render(t.body, vars); const subject = render(t.subject ?? '', vars);
        if (ch === 'IN_APP') {
          await tx.query('INSERT INTO in_app_notifications (user_id, event_code, title, body, deep_link) VALUES ($1,$2,$3,$4,$5)', [userId, event, subject || event, body, deepLink ?? null]);
          continue;
        }
        const to = ch === 'SMS' ? this.crypto.decStr(u.mobile_enc) : this.crypto.decStr(u.email_enc);
        if (!to) continue;
        let status = 'SENT'; let ref: string | undefined;
        try { const r = await this.provider.send({ channel: ch, to, subject, body }); status = r.ok ? 'SENT' : 'FAILED'; ref = r.ref; } catch { status = 'FAILED'; }
        await this.log(tx, event, ch, ch === 'SMS' ? maskMobile(to) : maskEmail(to), to, t.id, status, ref, vars.dedupe ? `${event}:${userId}:${ch}:${vars.dedupe}` : undefined);
      }
    });
  }

  /** In-app (per matrix) to every active user holding a role, for example ADMIN. Used for system alerts. */
  async notifyRole(role: string, event: string, vars: Record<string, string>, deepLink: string): Promise<void> {
    const ids = await this.db.system(async (tx) => (await tx.query(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.code=$1 AND u.account_status='ACTIVE'`, [role])).rows.map((r) => r.id as string));
    for (const id of ids) await this.notifyUser(id, event, vars, deepLink);
  }
  /** In-app only, to every officer whose scope covers the area. */
  async notifyOfficersInArea(areaId: string, event: string, vars: Record<string, string>, deepLink: string, roles: string[] = ['OFFICER', 'SENIOR_OFFICER'], exceptUserId?: string): Promise<void> {
    await this.db.system(async (tx) => {
      const r = await tx.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id FROM areas WHERE id=$1 UNION SELECT a.id, a.parent_id FROM areas a JOIN up ON a.id = up.parent_id)
         SELECT DISTINCT s.user_id FROM user_area_scopes s JOIN user_roles ur ON ur.user_id=s.user_id JOIN roles r ON r.id=ur.role_id
         WHERE s.area_id IN (SELECT id FROM up) AND r.code = ANY ($2::text[]) AND ($3::uuid IS NULL OR s.user_id <> $3::uuid)`, [areaId, roles, exceptUserId ?? null]);
      for (const row of r.rows) {
        const t = await this.template(tx, event, 'IN_APP', 'en'); if (!t) continue;
        await tx.query('INSERT INTO in_app_notifications (user_id, event_code, title, body, deep_link) VALUES ($1,$2,$3,$4,$5)',
          [row.user_id, event, render(t.subject ?? event, vars), render(t.body, vars), deepLink]);
      }
    });
  }

  private async log(tx: Tx, event: string, ch: Channel, masked: string, raw: string, templateId: string | null, status: string, ref?: string, dedupe?: string) {
    await tx.query(
      `INSERT INTO message_log (event_code, channel, recipient_masked, recipient_hash, template_id, status, provider_ref, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [event, ch, masked, this.crypto.blindIndex('msg', raw), templateId, status, ref ?? null, dedupe ?? null]);
  }
}
