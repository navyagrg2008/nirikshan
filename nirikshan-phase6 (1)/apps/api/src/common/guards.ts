import { CanActivate, ExecutionContext, Inject, Injectable, CallHandler, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { Observable, catchError, from, of, switchMap, throwError } from 'rxjs';
import { roleHas, type PermissionCode, type RoleCode } from '@nirikshan/shared';
import { ALLOW_PENDING, IDEMPOTENT, IS_PUBLIC, PERM_KEY, RATE_LIMIT, ROLES_KEY, STEP_UP, RateLimitOpts } from './decorators';
import { AppError, forbidden, unauthorized, tooMany, conflict, unprocessable } from './errors';
import { ctx } from './request-context';
import { SessionService } from '../modules/auth/session.service';
import { DbService } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';
import { CryptoService, safeEqual } from '../infra/crypto';
import { ENV, AppEnv } from '../config/env';

type Req = Request & { sessionUserId?: string; sessionId?: string };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private sessions: SessionService, private db: DbService) {}
  async canActivate(c: ExecutionContext): Promise<boolean> {
    const req = c.switchToHttp().getRequest<Req>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [c.getHandler(), c.getClass()]);
    const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING, [c.getHandler(), c.getClass()]);
    const sid = (req.cookies as Record<string, string> | undefined)?.[this.sessions.cookieName];
    const s = sid ? await this.sessions.get(sid) : null;
    if (!s) { if (isPublic) return true; throw unauthorized(); }
    // Fresh status and scope on every request, so approvals, suspensions and scope changes apply immediately.
    const r = await this.db.pool.query(
      `SELECT u.account_status, u.preferred_lang,
        COALESCE((SELECT array_agg(b.id::text) FROM businesses b WHERE b.owner_user_id = u.id), '{}') AS business_ids,
        COALESCE((WITH RECURSIVE a AS (SELECT area_id AS id FROM user_area_scopes WHERE user_id = u.id
                  UNION SELECT c.id FROM areas c JOIN a ON c.parent_id = a.id) SELECT array_agg(id::text) FROM a), '{}') AS area_ids
       FROM users u WHERE u.id = $1`, [s.data.uid]);
    const row = r.rows[0] as { account_status: string; preferred_lang: 'en' | 'hi'; business_ids: string[]; area_ids: string[] } | undefined;
    if (!row || ['SUSPENDED', 'DEACTIVATED', 'REJECTED'].includes(row.account_status)) {
      await this.sessions.destroy(sid!); if (isPublic) return true; throw unauthorized();
    }
    const user = {
      userId: s.data.uid, role: s.data.role, accountStatus: row.account_status, businessIds: row.business_ids, areaIds: row.area_ids,
      sessionRef: s.ref, authAt: s.data.authAt, mfa: s.data.mfa, lang: row.preferred_lang,
    };
    const store = ctx(); if (store) store.user = user;
    req.sessionUserId = user.userId; req.sessionId = sid;
    if (!isPublic && !allowPending && row.account_status !== 'ACTIVE') throw forbidden('ACCOUNT_NOT_ACTIVE');
    return true;
  }
}

/** Double-submit CSRF token bound to the session, plus Origin check. Applies to every state-changing request. */
@Injectable()
export class CsrfGuard implements CanActivate {
  private origins: Set<string>;
  constructor(@Inject(ENV) env: AppEnv, private sessions: SessionService) {
    this.origins = new Set(env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  }
  async canActivate(c: ExecutionContext): Promise<boolean> {
    const req = c.switchToHttp().getRequest<Req>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.header('origin');
    if (origin && !this.origins.has(origin)) throw forbidden('BAD_ORIGIN');
    if (!origin) {
      const ref = req.header('referer');
      if (ref) { try { if (!this.origins.has(new URL(ref).origin)) throw forbidden('BAD_ORIGIN'); } catch (e) { if (e instanceof AppError) throw e; throw forbidden('BAD_ORIGIN'); } }
    }
    const header = req.header('x-csrf-token'); const cookie = (req.cookies as Record<string, string> | undefined)?.[this.sessions.csrfCookieName];
    if (!header || !cookie || !safeEqual(header, cookie)) throw forbidden('CSRF');
    const user = ctx()?.user;
    if (user && req.sessionId) {
      const s = await this.sessions.get(req.sessionId);
      if (!s || !safeEqual(header, s.data.csrf)) throw forbidden('CSRF');
    }
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(c: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [c.getHandler(), c.getClass()]);
    const perms = this.reflector.getAllAndOverride<PermissionCode[]>(PERM_KEY, [c.getHandler(), c.getClass()]);
    const stepUp = this.reflector.getAllAndOverride<boolean>(STEP_UP, [c.getHandler(), c.getClass()]);
    const user = ctx()?.user;
    if (!roles && !perms && !stepUp) return true;
    if (!user) throw unauthorized();
    if (roles && !roles.includes(user.role)) throw forbidden();
    if (perms && !perms.some((p) => roleHas(user.role, p))) throw forbidden();
    if (stepUp && Date.now() - user.authAt > 5 * 60 * 1000) throw new AppError(401, 'REAUTH_REQUIRED');
    return true;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private reflector: Reflector, private redis: RedisService, private crypto: CryptoService, @Inject(ENV) private env: AppEnv) {}
  async canActivate(c: ExecutionContext): Promise<boolean> {
    const o = this.reflector.getAllAndOverride<RateLimitOpts>(RATE_LIMIT, [c.getHandler(), c.getClass()]) ?? { name: 'default', limit: this.env.RATE_LIMIT_DEFAULT_PER_MIN, windowSec: 60 };
    const cx = ctx(); const subject = o.by === 'user' && cx?.user ? `u:${cx.user.userId}` : `ip:${this.crypto.blindIndex('ip', cx?.ip ?? 'x').toString('hex').slice(0, 24)}`;
    const { count, ttl } = await this.redis.hit(`rl:${o.name}:${subject}`, o.windowSec);
    if (count > o.limit) throw tooMany(ttl);
    return true;
  }
}

/** Idempotency-Key support. Responses are stored encrypted (they may hold personal data). */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector, private db: DbService, private crypto: CryptoService) {}
  intercept(c: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [c.getHandler(), c.getClass()])) return next.handle();
    const req = c.switchToHttp().getRequest<Request>(); const res = c.switchToHttp().getResponse<Response>();
    const user = ctx()?.user; const key = req.header('idempotency-key');
    if (!user) return next.handle();
    if (!key || !/^[\w-]{8,80}$/.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const hash = createHash('sha256').update(req.method + req.path + JSON.stringify(req.body ?? {})).digest();
    return from(this.db.pool.query(
      `INSERT INTO idempotency_keys (key, user_id, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key`, [key, user.userId, hash],
    )).pipe(switchMap(async (ins) => {
      if (ins.rowCount) return { replay: null as null | { status: number; body: unknown } };
      const ex = (await this.db.pool.query('SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key=$1 AND user_id=$2', [key, user.userId])).rows[0] as
        { request_hash: Buffer; response_status: number | null; response_body: { enc: string } | null };
      if (!ex.request_hash.equals(hash)) throw unprocessable('IDEMPOTENCY_KEY_REUSED');
      if (ex.response_status == null || !ex.response_body) throw conflict('REQUEST_IN_PROGRESS');
      return { replay: { status: ex.response_status, body: this.crypto.decJson(Buffer.from(ex.response_body.enc, 'base64')) } };
    }), switchMap((r) => {
      if (r.replay) { res.status(r.replay.status); res.setHeader('Idempotent-Replayed', 'true'); return of(r.replay.body); }
      return next.handle().pipe(
        switchMap(async (body) => {
          // stored before the response is sent, so an immediate retry always replays
          await this.db.pool.query('UPDATE idempotency_keys SET response_status=$3, response_body=$4 WHERE key=$1 AND user_id=$2',
            [key, user.userId, res.statusCode, JSON.stringify({ enc: this.crypto.encJson(body ?? null).toString('base64') })]);
          return body;
        }),
        catchError((err) => from(this.db.pool.query('DELETE FROM idempotency_keys WHERE key=$1 AND user_id=$2 AND response_status IS NULL', [key, user.userId]).catch(() => undefined)).pipe(switchMap(() => throwError(() => err)))));
    }));
  }
}
