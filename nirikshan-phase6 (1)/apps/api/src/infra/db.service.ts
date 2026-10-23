import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ENV, AppEnv } from '../config/env';
import type { RoleCode } from '@nirikshan/shared';
import { ctx } from '../common/request-context';

export interface DbContext {
  userId?: string;
  role: RoleCode | 'SYSTEM' | 'PUBLIC';
  businessIds?: string[];
  areaIds?: string[];
}
export type Tx = PoolClient;

/**
 * Every query runs inside a transaction that first drops to the unprivileged `nirikshan_app` role and sets
 * app.user_id / app.role / app.business_ids / app.area_ids, so PostgreSQL Row-Level Security is the second
 * authorisation layer behind the NestJS guards.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;
  hasPostgis = false;
  constructor(@Inject(ENV) env: AppEnv) {
    this.pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
    this.pool.on('error', () => undefined);
  }
  async init() {
    const r = await this.pool.query(`SELECT 1 FROM pg_extension WHERE extname='postgis'`);
    this.hasPostgis = (r.rowCount ?? 0) > 0;
  }
  async onModuleDestroy() { await this.pool.end(); }

  async tx<T>(c: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE nirikshan_app');
      const q = `SELECT set_config('app.user_id',$1,true), set_config('app.role',$2,true), set_config('app.business_ids',$3,true), set_config('app.area_ids',$4,true), set_config('app.request_id',$5,true)`;
      await client.query(q, [
        c.userId ?? '', c.role, toPgArray(c.businessIds), toPgArray(c.areaIds), ctx()?.requestId ?? '',
      ]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> { return this.tx({ role: 'SYSTEM' }, fn); }
  /** Context for the signed-in user, built from the request session. */
  forUser<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const u = ctx()?.user;
    if (!u) throw new Error('No user in request context');
    return this.tx({ userId: u.userId, role: u.role, businessIds: u.businessIds, areaIds: u.areaIds }, fn);
  }
}
const toPgArray = (a?: string[]) => (a && a.length ? `{${a.join(',')}}` : '');
