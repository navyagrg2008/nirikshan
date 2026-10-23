import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { ENV, AppEnv } from '../config/env';
import { AppError } from '../common/errors';

export interface OutboundMessage { channel: 'SMS' | 'EMAIL'; to: string; subject?: string; body: string }

/**
 * Provider seam for SMS and email.
 *  - EMAIL: SMTP (Mailpit in development).
 *  - SMS: no gateway is chosen yet (India DLT registration is an open question), so the only provider is the console/outbox one.
 *    It is refused in production: the API will not start sending OTPs into the void.
 * In tests the outbox is readable so integration tests can complete OTP flows. The outbox is never exposed in other modes.
 */
@Injectable()
export class MessageProvider {
  private log = new Logger('MessageProvider');
  private smtp?: Transporter;
  readonly outbox: OutboundMessage[] = [];
  constructor(@Inject(ENV) private env: AppEnv) {
    if (env.SMTP_HOST) {
      this.smtp = nodemailer.createTransport({
        host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
    }
  }
  async send(m: OutboundMessage): Promise<{ ok: boolean; ref?: string }> {
    if (this.env.NODE_ENV === 'test') { this.outbox.push(m); return { ok: true, ref: 'test' }; }
    if (m.channel === 'EMAIL' && this.smtp) {
      try { const r = await this.smtp.sendMail({ from: this.env.MAIL_FROM, to: m.to, subject: m.subject ?? '', text: m.body }); return { ok: true, ref: r.messageId }; }
      catch { return { ok: false }; }
    }
    if (this.env.NODE_ENV === 'development') {
      // Development only: prints the message so OTPs can be read locally. Never runs in production.
      this.log.warn(`[dev ${m.channel}] to=${m.to} :: ${m.subject ? m.subject + ' :: ' : ''}${m.body}`);
      return { ok: true, ref: 'console' };
    }
    throw new AppError(503, 'MESSAGE_PROVIDER_NOT_CONFIGURED');
  }
}

@Injectable()
export class CaptchaService {
  constructor(@Inject(ENV) private env: AppEnv) {}
  get enabled() { return this.env.CAPTCHA_PROVIDER !== 'none'; }
  async verify(token: string | undefined, ip: string): Promise<boolean> {
    if (!this.enabled) return true;
    if (!token) return false;
    const url = this.env.CAPTCHA_PROVIDER === 'turnstile'
      ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify' : 'https://hcaptcha.com/siteverify';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: this.env.CAPTCHA_SECRET ?? '', response: token, remoteip: ip }), signal: AbortSignal.timeout(5000) });
      const j = (await r.json()) as { success?: boolean };
      return j.success === true;
    } catch { return false; }
  }
}
