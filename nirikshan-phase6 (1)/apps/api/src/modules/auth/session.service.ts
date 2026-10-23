import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../infra/redis.service';
import { randomToken } from '../../infra/crypto';
import { ENV, AppEnv } from '../../config/env';
import type { RoleCode } from '@nirikshan/shared';

export interface SessionData {
  uid: string; role: RoleCode; createdAt: number; absExp: number; lastSeen: number; authAt: number; mfa: boolean; csrf: string; ua: string;
}
const ABS_SECONDS = 8 * 3600;
export const idleSeconds = (role: RoleCode) => (role === 'OWNER' || role === 'TRADER' ? 30 * 60 : 15 * 60);
const hashSid = (sid: string) => createHash('sha256').update(sid).digest('hex');

/** Opaque server-side sessions. The browser only holds a random id; Redis stores sha256(id) so a Redis leak does not leak sessions. */
@Injectable()
export class SessionService {
  constructor(private redis: RedisService, @Inject(ENV) private env: AppEnv) {}
  get cookieName() { return this.env.COOKIE_SECURE ? '__Host-nrk_sid' : 'nrk_sid'; }
  get csrfCookieName() { return 'nrk_csrf'; }

  async create(uid: string, role: RoleCode, mfa: boolean, ua: string): Promise<{ sid: string; csrf: string; data: SessionData }> {
    const sid = randomToken(32); const csrf = randomToken(24); const now = Date.now();
    const data: SessionData = { uid, role, createdAt: now, absExp: now + ABS_SECONDS * 1000, lastSeen: now, authAt: now, mfa, csrf, ua: ua.slice(0, 160) };
    const h = hashSid(sid);
    await this.redis.client.multi()
      .set(`sess:${h}`, JSON.stringify(data), 'EX', idleSeconds(role))
      .hset(`usess:${uid}`, h.slice(0, 16), h)
      .expire(`usess:${uid}`, ABS_SECONDS + 600)
      .exec();
    return { sid, csrf, data };
  }

  async get(sid: string): Promise<{ data: SessionData; ref: string } | null> {
    if (!/^[\w-]{20,80}$/.test(sid)) return null;
    const h = hashSid(sid);
    const raw = await this.redis.client.get(`sess:${h}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    const now = Date.now();
    if (now > data.absExp) { await this.destroyHash(data.uid, h); return null; }
    // sliding idle timeout, never beyond the absolute limit
    data.lastSeen = now;
    const ttl = Math.max(1, Math.min(idleSeconds(data.role), Math.floor((data.absExp - now) / 1000)));
    await this.redis.client.set(`sess:${h}`, JSON.stringify(data), 'EX', ttl);
    return { data, ref: h.slice(0, 16) };
  }

  async markReauth(sid: string): Promise<void> {
    const h = hashSid(sid); const raw = await this.redis.client.get(`sess:${h}`); if (!raw) return;
    const d = JSON.parse(raw) as SessionData; d.authAt = Date.now();
    await this.redis.client.set(`sess:${h}`, JSON.stringify(d), 'KEEPTTL');
  }

  async destroy(sid: string): Promise<void> {
    const h = hashSid(sid); const raw = await this.redis.client.get(`sess:${h}`);
    await this.destroyHash(raw ? (JSON.parse(raw) as SessionData).uid : null, h);
  }
  private async destroyHash(uid: string | null, h: string) {
    const m = this.redis.client.multi().del(`sess:${h}`);
    if (uid) m.hdel(`usess:${uid}`, h.slice(0, 16));
    await m.exec();
  }
  async revokeByRef(uid: string, ref: string): Promise<boolean> {
    const h = await this.redis.client.hget(`usess:${uid}`, ref);
    if (!h) return false;
    await this.destroyHash(uid, h); return true;
  }
  async revokeAll(uid: string, exceptRef?: string): Promise<number> {
    const all = await this.redis.client.hgetall(`usess:${uid}`); let n = 0;
    for (const [ref, h] of Object.entries(all)) { if (ref === exceptRef) continue; await this.destroyHash(uid, h); n++; }
    return n;
  }
  async list(uid: string, currentRef?: string) {
    const all = await this.redis.client.hgetall(`usess:${uid}`); const out: { ref: string; createdAt: number; lastSeen: number; ua: string; current: boolean }[] = [];
    for (const [ref, h] of Object.entries(all)) {
      const raw = await this.redis.client.get(`sess:${h}`);
      if (!raw) { await this.redis.client.hdel(`usess:${uid}`, ref); continue; }
      const d = JSON.parse(raw) as SessionData; out.push({ ref, createdAt: d.createdAt, lastSeen: d.lastSeen, ua: d.ua, current: ref === currentRef });
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }
}
