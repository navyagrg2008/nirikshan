import request from 'supertest';
import { createHmac, randomInt } from 'crypto';
import { Pool } from 'pg';
import { readFileSync, writeFileSync } from 'fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/bootstrap';
import { MessageProvider } from '../src/infra/providers';
import { CryptoService } from '../src/infra/crypto';
import { RedisService } from '../src/infra/redis.service';
import { seedDemoUsers, type DemoCreds } from '../src/db/seed-data';

export const ORIGIN = 'http://localhost:3000';
export const API = '/api/v1';
let ipCounter = 10;

export interface Ctx { app: NestExpressApplication; pool: Pool; outbox: MessageProvider['outbox']; crypto: CryptoService; redis: RedisService; demo: Record<string, DemoCreds>; wards: string[] }

export async function boot(): Promise<Ctx> {
  const app = await createApp(); await app.init();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const crypto = app.get(CryptoService);
  let creds = await seedDemoUsers(pool, crypto, 1024);
  const cache = '/var/tmp/nrk-demo-creds.json'; // later suites find the users already seeded, so reuse the first suite's credentials
  if (creds.length) writeFileSync(cache, JSON.stringify(creds)); else creds = JSON.parse(readFileSync(cache, 'utf8'));
  const demo: Record<string, DemoCreds> = {}; for (const c of creds) demo[demo[c.role] ? c.role + '2' : c.role] = c;
  for (const k of await app.get(RedisService).client.keys('totpused:*')) await app.get(RedisService).client.del(k); // each suite starts with fresh TOTP replay state
  const wards = (await pool.query(`SELECT id FROM areas WHERE level='WARD' ORDER BY code`)).rows.map((r) => r.id as string);
  return { app, pool, outbox: app.get(MessageProvider).outbox, crypto, redis: app.get(RedisService), demo, wards };
}
export async function shutdown(c: Ctx) { await c.app.close(); await c.pool.end(); }

/** Base32 (RFC 4648) decode for TOTP secrets. */
function b32(s: string): Buffer { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of s.replace(/=+$/, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0'); const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
/** TOTP for a given 30 s step offset, so tests can use distinct codes (the server accepts +-1 step and refuses code reuse). */
export function totp(secret: string, offset = 0): string {
  const counter = Math.floor(Date.now() / 30000) + offset; const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', b32(secret)).update(buf).digest(); const o = h[h.length - 1]! & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

export class Client {
  agent: ReturnType<typeof request.agent>; csrf = ''; ip: string;
  constructor(public c: Ctx) { this.agent = request.agent(c.app.getHttpServer()); this.ip = `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`; }
  private track(res: request.Response) {
    const sc = ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);
    for (const s of sc) { const m = /^nrk_csrf=([^;]+)/.exec(s); if (m) this.csrf = m[1]!; }
    return res;
  }
  async init() { this.track(await this.agent.get(`${API}/auth/csrf`).set('X-Forwarded-For', this.ip)); return this; }
  get(path: string) { return this.agent.get(API + path).set('X-Forwarded-For', this.ip).then((r) => this.track(r)); }
  post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    let r = this.agent.post(API + path).set('X-Forwarded-For', this.ip).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body as object).then((x) => this.track(x));
  }
  put(path: string, body: unknown) { return this.agent.put(API + path).set('X-Forwarded-For', this.ip).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf).send(body as object).then((r) => this.track(r)); }
  patch(path: string, body: unknown, headers: Record<string, string> = {}) {
    let r = this.agent.patch(API + path).set('X-Forwarded-For', this.ip).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body as object).then((x) => this.track(x));
  }
  del(path: string) { return this.agent.delete(API + path).set('X-Forwarded-For', this.ip).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf).then((r) => this.track(r)); }

  lastCode(to: string): string {
    const m = [...this.c.outbox].reverse().find((x) => x.to === to); const code = m && /\b(\d{6})\b/.exec(m.body);
    if (!code) throw new Error('No OTP in outbox for ' + to); return code[1]!;
  }
  /** Sends and verifies an OTP, returning the one-time verification token. */
  async otp(mobile: string, purpose: 'REGISTER' | 'LOGIN') {
    const s = await this.post('/auth/otp/send', { channel: 'MOBILE', target: mobile, purpose }); if (s.status !== 201 && s.status !== 200) throw new Error('otp send failed ' + s.status + JSON.stringify(s.body));
    const v = await this.post('/auth/otp/verify', { challengeId: s.body.challengeId, code: this.lastCode(mobile) });
    if (v.status !== 200 && v.status !== 201) throw new Error('otp verify failed ' + JSON.stringify(v.body)); return v.body.verificationToken as string;
  }
  async confirmToken() {
    for (const p of ['otp:cool:*', 'otp:hr:*', 'otp:iphr:*', 'rl:otp*']) for (const k of await this.c.redis.client.keys(p)) await this.c.redis.client.del(k);
    const s = await this.post('/auth/otp/confirm/send'); if (s.status >= 300) throw new Error('confirm send ' + JSON.stringify(s.body));
    const me = await this.get('/me'); void me;
    const to = this.c.outbox[this.c.outbox.length - 1]!.to;
    const v = await this.post('/auth/otp/confirm/verify', { challengeId: s.body.challengeId, code: this.lastCode(to) }); return v.body.verificationToken as string;
  }
  async loginStaff(creds: DemoCreds, offset = -1) {
    const l = await this.post('/auth/login', { identifier: creds.mobile, password: creds.password });
    if (l.body.status !== 'MFA_REQUIRED') throw new Error('expected MFA ' + JSON.stringify(l.body));
    const m = await this.post('/auth/mfa/verify', { pendingId: l.body.pendingId, code: totp(creds.totpSecret!, offset) });
    if (m.body.status !== 'OK') throw new Error('mfa failed ' + JSON.stringify(m.body)); return this;
  }
}

export async function clearCooldown(c: Ctx, mobile: string) { await c.redis.client.del(`otp:cool:${c.crypto.blindIndex('mobile', mobile).toString('hex').slice(0, 32)}`); }
export const randomMobile = () => `9${String(randomInt(100000000, 999999999))}`;
export function registerBody(c: Ctx, mobile: string, token: string, over: Record<string, unknown> = {}) {
  return {
    identity: { fullName: 'Test Person', dob: '1990-05-05', mobile, email: undefined }, mobileToken: token, businessType: 'OWNER', business: { firmName: 'Sharma General Store', tradeLicenceNo: 'TL-12345' },
    address: { line1: '12 Market Road', pincode: '201001', areaId: c.wards[0] }, documents: [], password: 'Tr0ub4dor&3-horse', lang: 'en', consent: { policyVersion: '1', accepted: true }, ...over,
  };
}
/** Registers a fresh owner/trader account and leaves the client signed in (pending approval). */
export async function registerUser(c: Ctx, over: { businessType?: string; wardIndex?: number } = {}) {
  const cl = await new Client(c).init(); const mobile = randomMobile(); const token = await cl.otp(mobile, 'REGISTER');
  const body = registerBody(c, mobile, token, { businessType: over.businessType ?? 'OWNER', address: { line1: '12 Market Road', pincode: '201001', areaId: c.wards[over.wardIndex ?? 0] } });
  const r = await cl.post('/auth/register', body); if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.body));
  const id = (await cl.get('/me')).body.id as string; return { cl, mobile, id };
}
export async function approve(c: Ctx, officer: Client, userId: string): Promise<{ status: number; body: any }> { return officer.post(`/officer/accounts/${userId}/decision`, { outcome: 'APPROVED' }); }
export async function activate(c: Ctx, userId: string) { await c.pool.query(`UPDATE users SET account_status='ACTIVE' WHERE id=$1`, [userId]); }

export async function catalog(cl: Client) {
  const cats = (await cl.get('/catalog/categories')).body as { categories: { id: string; code: string; capacityBands: { id: string; min: string; max: string; unit: string }[]; subCategories: { id: string }[] }[]; accuracyClasses: { id: string; code: string }[] };
  const cat = cats.categories.find((x) => x.code === 'PLATFORM_SCALE')!; const band = cat.capacityBands[0]!;
  return { cat, band, cls: cats.accuracyClasses.find((x) => x.code === 'III')!, cats };
}
export function instrumentBody(c: Ctx, cat: Awaited<ReturnType<typeof catalog>>, confirmToken: string, over: Record<string, unknown> = {}) {
  return {
    categoryId: cat.cat.id, capacityBandId: cat.band.id, accuracyClassId: cat.cls.id, capacity: '50', capacityUnit: 'kg', serialNo: 'SN-' + randomInt(1e6, 9e6), make: 'Acme', model: 'PS-50',
    location: { address: '12 Market Road, Ward 1', areaId: c.wards[0] }, ownership: { mode: 'SELF' }, confirmToken, declarationAccepted: true, ...over,
  };
}
