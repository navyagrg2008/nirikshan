import { Inject, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'crypto';
import { DbService } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';
import { CryptoService, randomToken } from '../../infra/crypto';
import { CaptchaService } from '../../infra/providers';
import { NotificationService } from '../notifications/notification.service';
import { ENV, AppEnv } from '../../config/env';
import { AppError, tooMany, unprocessable } from '../../common/errors';
import { ctx } from '../../common/request-context';
import { normaliseEmail, normaliseMobile, type OtpPurpose } from '@nirikshan/shared';

export interface VerificationToken { targetHash: string; channel: 'MOBILE' | 'EMAIL'; purpose: OtpPurpose; userId?: string }

@Injectable()
export class OtpService {
  constructor(private db: DbService, private redis: RedisService, private crypto: CryptoService, private captcha: CaptchaService,
    private notify: NotificationService, @Inject(ENV) private env: AppEnv) {}

  normaliseTarget(channel: 'MOBILE' | 'EMAIL', target: string): string {
    if (channel === 'MOBILE') { const m = normaliseMobile(target); if (!m) throw unprocessable('INVALID_MOBILE'); return m; }
    const e = normaliseEmail(target);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > 254) throw unprocessable('INVALID_EMAIL');
    return e;
  }
  targetHash(channel: 'MOBILE' | 'EMAIL', value: string): Buffer { return this.crypto.blindIndex(channel === 'MOBILE' ? 'mobile' : 'email', value); }

  async send(input: { channel: 'MOBILE' | 'EMAIL'; target: string; purpose: OtpPurpose; captchaToken?: string; lang?: string; forUserId?: string }) {
    const value = this.normaliseTarget(input.channel, input.target);
    const th = this.targetHash(input.channel, value); const thHex = th.toString('hex').slice(0, 32);
    // 30 s resend throttle and 5 per hour per target
    const cool = await this.redis.client.set(`otp:cool:${thHex}`, '1', 'EX', 30, 'NX');
    if (!cool) throw tooMany(await this.redis.client.ttl(`otp:cool:${thHex}`), 'OTP_RESEND_TOO_SOON');
    const hr = await this.redis.hit(`otp:hr:${thHex}`, 3600);
    if (hr.count > 5) throw tooMany(hr.ttl, 'OTP_HOURLY_LIMIT');
    // CAPTCHA after repeated sends from one address
    const ipHr = await this.redis.hit(`otp:iphr:${(ctx()?.ipHash ?? Buffer.alloc(0)).toString('hex').slice(0, 24)}`, 3600);
    if (ipHr.count > 20) throw tooMany(ipHr.ttl, 'OTP_IP_LIMIT');
    if (ipHr.count > 3 && !(await this.captcha.verify(input.captchaToken, ctx()?.ip ?? ''))) throw new AppError(403, 'CAPTCHA_REQUIRED');

    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.system((tx) => tx.query(
      `INSERT INTO otp_challenges (id, target_hash, purpose, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
      [id, th, `${input.channel}:${input.purpose}${input.forUserId ? ':' + input.forUserId : ''}`, this.crypto.otpHash(id, code), String(this.env.OTP_TTL_SECONDS)]));
    // For LOGIN the code is only sent when an account exists, but the response is identical either way (no account enumeration).
    let deliver = true;
    if (input.purpose === 'LOGIN') {
      const col = input.channel === 'MOBILE' ? 'mobile_bidx' : 'email_bidx';
      const hashes = this.crypto.blindIndexAll(input.channel === 'MOBILE' ? 'mobile' : 'email', value);
      deliver = ((await this.db.pool.query(`SELECT 1 FROM users WHERE ${col} = ANY($1::bytea[]) AND account_status IN ('ACTIVE','PENDING_VERIFICATION')`, [hashes])).rowCount ?? 0) > 0;
    }
    if (deliver) await this.notify.sendOtp(input.channel, value, input.lang ?? 'en', code);
    return { challengeId: id, expiresIn: this.env.OTP_TTL_SECONDS, resendAfter: 30 };
  }

  async verify(challengeId: string, code: string): Promise<{ verificationToken: string }> {
    const bad = () => unprocessable('INVALID_CODE');
    const row = await this.db.system(async (tx) => {
      const r = (await tx.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [challengeId])).rows[0] as
        { target_hash: Buffer; purpose: string; code_hash: Buffer; attempts: number; expires_at: Date; consumed_at: Date | null } | undefined;
      if (!r || r.consumed_at || r.expires_at < new Date()) return null;
      if (r.attempts >= 5) return 'LOCKED' as const;
      const ok = this.crypto.otpHash(challengeId, code).equals(r.code_hash);
      if (!ok) { await tx.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id=$1', [challengeId]); return 'WRONG' as const; }
      await tx.query('UPDATE otp_challenges SET consumed_at = now() WHERE id=$1', [challengeId]);
      return r;
    });
    if (row === 'LOCKED') throw new AppError(422, 'OTP_ATTEMPTS_EXCEEDED');
    if (!row || row === 'WRONG') throw bad();
    const [channel, purpose, userId] = row.purpose.split(':') as ['MOBILE' | 'EMAIL', OtpPurpose, string | undefined];
    const token = randomToken(24);
    const payload: VerificationToken = { targetHash: row.target_hash.toString('hex'), channel, purpose, userId };
    await this.redis.setJson(`vt:${token}`, payload, 900);
    return { verificationToken: token };
  }

  /** One-time use. Throws a generic error when the token is unknown, used, expired or for another purpose or target. */
  async consume(token: string, expect: { purpose: OtpPurpose; channel: 'MOBILE' | 'EMAIL'; targetHash?: Buffer; userId?: string }): Promise<VerificationToken> {
    const t = await this.redis.takeJson<VerificationToken>(`vt:${token}`);
    if (!t || t.purpose !== expect.purpose || t.channel !== expect.channel) throw unprocessable('INVALID_VERIFICATION');
    if (expect.targetHash && !expect.targetHash.equals(Buffer.from(t.targetHash, 'hex'))) throw unprocessable('INVALID_VERIFICATION');
    if (expect.userId && t.userId !== expect.userId) throw unprocessable('INVALID_VERIFICATION');
    return t;
  }
  async peek(token: string): Promise<VerificationToken | null> { return this.redis.getJson<VerificationToken>(`vt:${token}`); }
}
