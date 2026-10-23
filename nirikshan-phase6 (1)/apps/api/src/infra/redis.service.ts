import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, AppEnv } from '../config/env';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  constructor(@Inject(ENV) env: AppEnv) {
    this.client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  }
  async onModuleDestroy() { await this.client.quit().catch(() => undefined); }
  async setJson(key: string, value: unknown, ttlSec: number) { await this.client.set(key, JSON.stringify(value), 'EX', ttlSec); }
  async getJson<T>(key: string): Promise<T | null> { const v = await this.client.get(key); return v ? (JSON.parse(v) as T) : null; }
  async takeJson<T>(key: string): Promise<T | null> { const v = await this.client.getdel(key); return v ? (JSON.parse(v) as T) : null; }
  /** Fixed window counter. Returns the new count and seconds until reset. */
  async hit(key: string, windowSec: number): Promise<{ count: number; ttl: number }> {
    const res = await this.client.multi().incr(key).ttl(key).exec();
    const count = Number(res?.[0]?.[1] ?? 1); let ttl = Number(res?.[1]?.[1] ?? -1);
    if (ttl < 0) { await this.client.expire(key, windowSec); ttl = windowSec; }
    return { count, ttl };
  }
  async ping() { return this.client.ping(); }
}
