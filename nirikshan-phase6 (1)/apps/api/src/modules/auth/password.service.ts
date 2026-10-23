import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { checkPassword } from '@nirikshan/shared';
import { ENV, AppEnv } from '../../config/env';
import { unprocessable } from '../../common/errors';

@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;
  constructor(@Inject(ENV) private env: AppEnv) {}
  private opts() { return { type: argon2.argon2id, memoryCost: this.env.ARGON_MEMORY_KIB, timeCost: 2, parallelism: 1 } as const; }
  hash(pw: string): Promise<string> { return argon2.hash(pw, this.opts()); }
  async verify(hash: string | null | undefined, pw: string): Promise<boolean> {
    // Unknown accounts still pay for one argon2 verification so response time does not reveal whether the account exists.
    if (!hash) { this.dummy ??= this.hash('nirikshan-dummy-password-for-timing'); await argon2.verify(await this.dummy, pw).catch(() => false); return false; }
    try { return await argon2.verify(hash, pw); } catch { return false; }
  }
  /** Policy (shared with the web form) plus the local denylist. A breached-password API check can be plugged in here. */
  assertStrong(pw: string, identifiers: string[]) {
    const r = checkPassword(pw, identifiers);
    if (!r.ok) throw unprocessable('WEAK_PASSWORD', { reasons: r.reasons });
  }
}
