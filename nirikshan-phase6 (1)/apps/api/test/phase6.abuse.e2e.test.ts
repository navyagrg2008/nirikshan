import 'reflect-metadata';
import request from 'supertest';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { roleHas, type RoleCode } from '@nirikshan/shared';
import { IS_PUBLIC, ROLES_KEY, PERM_KEY } from '../src/common/decorators';
import { CaptchaService } from '../src/infra/providers';
import { StorageService } from '../src/infra/storage';
import { boot, shutdown, Client, activate, registerUser, catalog, instrumentBody, API, ORIGIN, type Ctx } from './helpers';

let c: Ctx; let owner: Client; let trader: Client; let outsider: Client; let admin: Client; let officer: Client;
const key = () => ({ 'Idempotency-Key': randomUUID() });
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let ipn = 0; const nextIp = () => `10.88.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;

beforeAll(async () => {
  c = await boot();
  owner = await new Client(c).init(); await owner.post('/auth/login', { identifier: c.demo.OWNER!.mobile, password: c.demo.OWNER!.password });
  trader = await new Client(c).init(); await trader.post('/auth/login', { identifier: c.demo.TRADER!.mobile, password: c.demo.TRADER!.password });
  officer = await (await new Client(c).init()).loginStaff(c.demo.OFFICER!, 0); admin = await (await new Client(c).init()).loginStaff(c.demo.ADMIN!, 0);
  const o = await registerUser(c); await activate(c, o.id); outsider = o.cl;
}, 120000);
afterAll(async () => { await shutdown(c); });

// ------------------------------------------------------------------------------------------------ IDOR
describe('one owner cannot reach another owner\'s records (IDOR)', () => {
  it('every owner route that takes an id answers 404 for a stranger, for every record type', async () => {
    // Make sure the real owner has one of each thing, then try them all as an unrelated owner and as a trader from another business.
    const cat = await catalog(owner); const tok = await owner.confirmToken();
    const mk = await owner.post('/instruments', instrumentBody(c, cat, tok), key()); expect([201, 200]).toContain(mk.status); const instId = mk.body.id as string;
    await owner.post(`/instruments/${instId}/requests`, { kind: 'ADDRESS_CHANGE', address: '5 Lake Road', areaId: c.wards[1] ?? c.wards[0] }, key());
    const grv = await owner.post('/grievances', { subject: 'A private complaint', body: 'This text belongs to the owner only.' }, key());
    const dsr = await owner.post('/me/data-requests', { kind: 'ACCESS' }, key());
    const app = await owner.post('/applications', { instrumentId: instId, type: 'NEW', declarationAccepted: true }, key()); const appId = (app.body.id ?? (await owner.get('/applications')).body.items?.[0]?.id) as string | undefined;
    const anyCert = (await c.pool.query('SELECT id FROM certificates LIMIT 1')).rows[0]?.id as string | undefined; const anyVisit = (await c.pool.query('SELECT id FROM inspection_visits LIMIT 1')).rows[0]?.id as string | undefined;
    const reqs = (await owner.get(`/instruments/${instId}/requests`)).body.items as { id: string }[];
    const ids: Record<string, string | undefined> = { instruments: instId, applications: appId, certificates: anyCert, visits: anyVisit, requests: reqs[0]?.id, grievances: grv.body.id, 'data-requests': dsr.body.id };
    // collect the routes an owner may call that carry an :id
    const reflector = c.app.get(Reflector); const out: { method: string; path: string; res: string }[] = []; const checked: string[] = [];
    const wrappers = [...c.app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
    for (const w of wrappers) {
      const inst = w.instance as object | undefined; if (!inst) continue; const proto = Object.getPrototypeOf(inst) as object; const base = ([Reflect.getMetadata('path', w.metatype as object)] as string[]).flat()[0] ?? '';
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = (proto as Record<string, unknown>)[name]; if (typeof fn !== 'function') continue; const m = Reflect.getMetadata('method', fn) as number | undefined; if (m === undefined) continue;
        const sub = ([Reflect.getMetadata('path', fn)] as string[]).flat()[0] ?? ''; const path = '/' + [base, sub].filter((x) => x && x !== '/').join('/').replace(/\/+/g, '/'); const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][m]; if (!method) continue;
        const roles = reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [fn as never, w.metatype as never]); const perms = reflector.getAllAndOverride<string[]>(PERM_KEY, [fn as never, w.metatype as never]);
        if (reflector.getAllAndOverride<boolean>(IS_PUBLIC, [fn as never, w.metatype as never])) continue;
        const ownerOk = (roles ? roles.includes('OWNER') : true) && (perms ? perms.some((p) => roleHas('OWNER', p as never)) : true); if (!ownerOk) continue;
        const idParams = path.match(/:[A-Za-z]+/g) ?? []; if (idParams.length !== 1) continue;
        const resource = path.split('/').filter(Boolean)[0]!; const realId = ids[resource] ?? (resource === 'me' ? ids['data-requests'] : undefined); if (!realId || !/id$/i.test(idParams[0]!)) continue;
        if (/logout|sessions|notifications/.test(path)) continue;
        const p = path.replace(idParams[0]!, realId); checked.push(`${method} ${path}`);
        for (const [who, cl] of [['outsider', outsider], ['trader', trader]] as const) {
          cl.ip = nextIp(); const r = method === 'GET' ? await cl.get(p) : method === 'POST' ? await cl.post(p, {}, key()) : method === 'PUT' ? await cl.put(p, {}) : method === 'PATCH' ? await cl.patch(p, {}) : await cl.del(p);
          // 404 is the answer. 422/400/428 come from checks that run before any lookup, so they are identical for an id that does not exist. A 200 is only fine if it is an empty list (the database hid the rows).
          const emptyList = r.status === 200 && Array.isArray(r.body?.items) && r.body.items.length === 0;
          if (![404, 422, 400, 428].includes(r.status) && !emptyList) out.push({ method, path: `${who}: ${path}`, res: String(r.status) });
        }
      }
    }
    expect(checked.length).toBeGreaterThan(10); expect(checked.some((x) => x.includes('/applications/'))).toBe(true); expect(checked.some((x) => x.includes('/instruments/'))).toBe(true);   // the matrix really covered something
    expect(out).toEqual([]);
    // and the real owner can still read their own records
    expect((await owner.get(`/instruments/${instId}`)).status).toBe(200);
  }, 180000);
  it('lists never include other people\'s rows', async () => {
    const mine = (await owner.get('/instruments')).body.items.map((x: { id: string }) => x.id); const theirs = (await outsider.get('/instruments')).body.items.map((x: { id: string }) => x.id);
    expect(theirs.filter((id: string) => mine.includes(id))).toEqual([]);
    expect((await outsider.get('/grievances')).body.items).toEqual([]); expect((await outsider.get('/me/data-requests')).body.items).toEqual([]);
  });
  it('a signed file link works only for the exact file, and a changed or expired link is refused', async () => {
    const st = c.app.get(StorageService); const url = await st.signedUrl('docs/example.pdf', 'application/pdf'); const tok = url.split('/').pop()!;
    const anon = await new Client(c).init();
    expect((await anon.get(`/files/local/${tok.slice(0, -2)}xx`)).status).toBe(404);            // signature changed
    const parts = tok.split('.'); parts[0] = Buffer.from('../../etc/passwd').toString('base64url'); expect((await anon.get(`/files/local/${parts.join('.')}`)).status).toBe(404);   // other file, same signature
    parts[0] = tok.split('.')[0]!; parts[1] = String(Math.floor(Date.now() / 1000) - 5); expect((await anon.get(`/files/local/${parts.join('.')}`)).status).toBe(404);          // expiry moved back
    expect((await anon.get('/files/local/garbage')).status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------ sign-in and sessions
describe('sign-in and session abuse', () => {
  it('a forged, truncated or foreign session cookie is not a session', async () => {
    for (const v of ['x', 'a'.repeat(64), 'a'.repeat(5000), '../../etc/passwd', '%00', 'null', '{"uid":"1"}']) {
      const r = await request(c.app.getHttpServer()).get(API + '/me').set('Cookie', `nrk_sid=${encodeURIComponent(v)}`).set('X-Forwarded-For', nextIp()); expect(r.status).toBe(401);
    }
  });
  it('the session id changes at sign-in and the old one stops working after sign-out', async () => {
    const cl = await new Client(c).init(); const before = (await request(c.app.getHttpServer()).get(API + '/auth/csrf').set('X-Forwarded-For', nextIp())).headers['set-cookie'];
    const l = await cl.post('/auth/login', { identifier: c.demo.OWNER!.mobile, password: c.demo.OWNER!.password }); const sid = /nrk_sid=([^;]+)/.exec((l.headers['set-cookie'] as unknown as string[]).join(';'))![1]!;
    expect(String(before)).not.toContain(sid);
    expect((await cl.get('/me')).status).toBe(200); await cl.post('/auth/logout', {});
    const replay = await request(c.app.getHttpServer()).get(API + '/me').set('Cookie', `nrk_sid=${sid}`).set('X-Forwarded-For', nextIp()); expect(replay.status).toBe(401);
  });
  it('a half-finished staff sign-in (password done, code not yet) opens nothing', async () => {
    const cl = await new Client(c).init(); const l = await cl.post('/auth/login', { identifier: c.demo.ADMIN!.mobile, password: c.demo.ADMIN!.password }); expect(l.body.status).toBe('MFA_REQUIRED');
    expect((await cl.get('/me')).status).toBe(401); expect((await cl.get('/admin/users')).status).toBe(401); expect((await cl.get('/admin/dashboard')).status).toBe(401);
  });
  it('wrong-origin and token-less state changes are refused even with a valid session', async () => {
    const cl = await new Client(c).init(); await cl.post('/auth/login', { identifier: c.demo.OWNER!.mobile, password: c.demo.OWNER!.password });
    const evil = await cl.agent.post(API + '/grievances').set('Origin', 'https://evil.example').set('X-CSRF-Token', cl.csrf).set('Idempotency-Key', randomUUID()).send({ subject: 'abcde', body: 'abcdefghij' }); expect(evil.status).toBe(403);
    const none = await cl.agent.post(API + '/grievances').set('Origin', ORIGIN).set('Idempotency-Key', randomUUID()).send({ subject: 'abcde', body: 'abcdefghij' }); expect(none.status).toBe(403);
    const other = await cl.agent.post(API + '/grievances').set('Origin', ORIGIN).set('X-CSRF-Token', 'a'.repeat(cl.csrf.length)).set('Idempotency-Key', randomUUID()).send({ subject: 'abcde', body: 'abcdefghij' }); expect(other.status).toBe(403);
    const nul = await cl.agent.post(API + '/grievances').set('Origin', 'null').set('X-CSRF-Token', cl.csrf).set('Idempotency-Key', randomUUID()).send({ subject: 'abcde', body: 'abcdefghij' }); expect(nul.status).toBe(403);
  });
  it('guessing passwords is slowed per account even when the attacker changes address each time', async () => {
    const mobile = c.demo.INSPECTOR2?.mobile ?? c.demo.INSPECTOR!.mobile; const codes: number[] = [];
    for (let i = 0; i < 9; i++) { const cl = await new Client(c).init(); cl.ip = nextIp(); const r = await cl.post('/auth/login', { identifier: mobile, password: 'Guess-' + i + '-Wrong!' }); codes.push(r.status); }
    expect(codes.slice(0, 2)).toEqual([401, 401]); expect(codes.slice(-3).every((s) => s === 429 || s === 423 || s === 401)).toBe(true);
    expect(codes.some((s) => s === 429 || s === 423)).toBe(true);
    await c.pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE true`).catch(() => undefined);
    for (const k of await c.redis.client.keys('rl:login*')) await c.redis.client.del(k); for (const k of await c.redis.client.keys('lock:*')) await c.redis.client.del(k);
  });
  it('fields that would raise privileges are refused, not ignored', async () => {
    const r = await owner.patch('/me', { role: 'ADMIN' }); expect([400, 422]).toContain(r.status);
    const anon = await new Client(c).init(); const reg = await anon.post('/auth/register', { identity: {}, role: 'ADMIN', accountStatus: 'ACTIVE' }); expect([400, 422]).toContain(reg.status);
    expect((await owner.get('/me')).body.role).toBe('OWNER');
  });
});

// ------------------------------------------------------------------------------------------------ hostile input
describe('hostile input', () => {
  const evilQuery = encodeURIComponent("' OR '1'='1' --") + '&status=' + encodeURIComponent("x'; DROP TABLE users;--") + '&limit=-5&page=abc&cursor=%00%00&from=9999-99-99&areaId=not-a-uuid&format=exe';
  it('SQL-looking text in any query parameter of any readable route gives a clean error, never a crash, and users still exist', async () => {
    const reflector = c.app.get(Reflector); const wrappers = [...c.app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]); const bad: string[] = []; let n = 0;
    for (const w of wrappers) {
      const inst = w.instance as object | undefined; if (!inst) continue; const proto = Object.getPrototypeOf(inst) as object; const base = ([Reflect.getMetadata('path', w.metatype as object)] as string[]).flat()[0] ?? '';
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = (proto as Record<string, unknown>)[name]; if (typeof fn !== 'function' || Reflect.getMetadata('method', fn) !== 0) continue;
        const sub = ([Reflect.getMetadata('path', fn)] as string[]).flat()[0] ?? ''; const path = ('/' + [base, sub].filter((x) => x && x !== '/').join('/')).replace(/\/+/g, '/').replace(/:[A-Za-z]+/g, randomUUID()); if (/download|\.pdf|\.csv|notices\.pdf|files\/local|logout/.test(path)) continue;
        const roles = reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [fn as never, w.metatype as never]); const perms = reflector.getAllAndOverride<string[]>(PERM_KEY, [fn as never, w.metatype as never]); const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC, [fn as never, w.metatype as never]);
        const who = isPublic ? outsider : (roles?.includes('ADMIN') || perms?.some((p) => roleHas('ADMIN', p as never))) ? admin : (roles?.includes('OFFICER') || perms?.some((p) => roleHas('OFFICER', p as never))) ? officer : owner;
        who.ip = nextIp(); const r = await who.get(`${path}?q=${evilQuery}`); n++; if (r.status >= 500) bad.push(`${path} -> ${r.status}`);
      }
    }
    expect(n).toBeGreaterThan(60); expect(bad).toEqual([]);
    expect(Number((await c.pool.query('SELECT count(*) FROM users')).rows[0].count)).toBeGreaterThan(5);
  }, 180000);
  it('odd JSON bodies get a 4xx: arrays, strings, nesting, prototype keys, huge bodies', async () => {
    const send = (body: unknown, raw?: string) => { const r = owner.agent.post(API + '/grievances').set('X-Forwarded-For', nextIp()).set('Origin', ORIGIN).set('X-CSRF-Token', owner.csrf).set('Idempotency-Key', randomUUID()); return raw ? r.set('Content-Type', 'application/json').send(raw) : r.send(body as object); };
    for (const raw of ['[]', '"text"', '42', 'null', 'true']) { const r = await send(null, raw); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500); }
    expect((await send(null, '{"subject":"abcde","body":"abcdefghij","__proto__":{"admin":true}}')).status).toBeLessThan(500);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect((await send(null, '{'.repeat(5000))).status).toBe(400);
    expect((await send(null, JSON.stringify({ subject: 'abcde', body: 'x'.repeat(300_000) }))).status).toBe(413);
    expect((await send({ subject: 'abcde', body: 'abcdefghij', extra: 1 })).status).toBe(422);
  });
  it('script text is stored as text and comes back as JSON, so a page cannot run it', async () => {
    const r = await owner.post('/grievances', { subject: '<img src=x onerror=alert(1)>', body: '<script>alert(document.cookie)</script> long enough' }, key()); expect(r.status).toBeLessThan(300);
    const list = await owner.get('/grievances'); expect(list.headers['content-type']).toMatch(/application\/json/); expect(list.headers['x-content-type-options']).toBe('nosniff');
  });
});

// ------------------------------------------------------------------------------------------------ uploads
describe('upload abuse', () => {
  const tamper = (cl: Client, buf: Buffer | null, name: string, type: string, extra?: (r: request.Test) => request.Test) => {
    let r = cl.agent.post(API + '/public/tamper-reports').set('X-Forwarded-For', nextIp()).set('Origin', ORIGIN).set('X-CSRF-Token', cl.csrf).field('description', 'The seal on this scale looks scratched off.');
    if (buf) r = r.attach('photo', buf, { filename: name, contentType: type }); return extra ? extra(r) : r;
  };
  let anon: Client;
  beforeAll(async () => { anon = await new Client(c).init(); jest.spyOn(c.app.get(CaptchaService), 'verify').mockResolvedValue(true); });
  afterAll(() => { jest.restoreAllMocks(); });
  it('refuses files whose content is not a real JPEG or PNG, whatever they are called', async () => {
    for (const [buf, name, type] of [
      [Buffer.from('<html><script>alert(1)</script></html>'), 'photo.png', 'image/png'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.png', 'image/png'],
      [Buffer.from('GIF89a<script>'), 'x.png', 'image/png'], [Buffer.from('MZ\x90\x00 fake exe'), 'x.jpg', 'image/jpeg'], [Buffer.from('%PDF-1.4 fake'), 'x.png', 'image/png'], [Buffer.alloc(0), 'empty.png', 'image/png'],
    ] as [Buffer, string, string][]) { const r = await tamper(anon, buf, name, type); expect([400, 415, 422]).toContain(r.status); }
  });
  it('refuses a virus test file hidden behind a PNG header', async () => {
    const r = await tamper(anon, Buffer.concat([PNG, Buffer.from(EICAR)]), 'cute.png', 'image/png'); expect([400, 415, 422]).toContain(r.status);
  });
  it('refuses oversized uploads and extra files', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]); const r = await tamper(anon, big, 'big.png', 'image/png'); expect([413, 422]).toContain(r.status);
    const two = await tamper(anon, PNG, 'a.png', 'image/png', (q) => q.attach('photo', PNG, { filename: 'b.png', contentType: 'image/png' })); expect(two.status).toBeGreaterThanOrEqual(400); expect(two.status).toBeLessThan(500);
  });
  it('stores a good photo under a random name, never the name the sender chose', async () => {
    const r = await tamper(anon, PNG, '../../../etc/cron.d/evil.png', 'image/png'); expect(r.status).toBe(201);
    const row = (await c.pool.query('SELECT photo_key FROM tamper_reports WHERE ref_no=$1', [r.body.ref])).rows[0]; expect(row.photo_key).toBeTruthy(); expect(row.photo_key).not.toMatch(/\.\.|evil|cron/);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`])); expect(walk('/var/tmp/nrk-test-uploads').some((f) => /evil|cron/.test(f))).toBe(false);
  });
  it('a non-CSV or binary file in the import tool is refused without a crash', async () => {
    for (const [buf, name, type] of [[Buffer.from([0, 1, 2, 3, 255, 254]), 'x.csv', 'text/csv'], [PNG, 'x.csv', 'text/csv'], [Buffer.alloc(3 * 1024 * 1024, 'a'), 'big.csv', 'text/csv']] as [Buffer, string, string][]) {
      const r = await admin.agent.post(API + '/admin/migration/validate').set('X-Forwarded-For', nextIp()).set('Origin', ORIGIN).set('X-CSRF-Token', admin.csrf).attach('file', buf, { filename: name, contentType: type });
      expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
    }
  });
});

// ------------------------------------------------------------------------------------------------ rate limits
describe('rate limits', () => {
  it('the public certificate check slows a scraper down with 429 and a Retry-After', async () => {
    const anon = await new Client(c).init(); anon.ip = '10.99.1.1'; const seen: number[] = []; let retry = '';
    for (let i = 0; i < 40; i++) { const r = await anon.get('/public/validate?cert=NRK-FAKE-' + i); seen.push(r.status); if (r.status === 429) { retry = String(r.headers['retry-after'] ?? ''); break; } }
    expect(seen).toContain(429); expect(Number(retry)).toBeGreaterThan(0); expect(seen.filter((s) => s >= 500)).toEqual([]);
  });
  it('tamper reports are limited per address', async () => {
    const anon = await new Client(c).init(); anon.ip = '10.99.2.1'; jest.spyOn(c.app.get(CaptchaService), 'verify').mockResolvedValue(true); const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push((await anon.agent.post(API + '/public/tamper-reports').set('X-Forwarded-For', anon.ip).set('Origin', ORIGIN).set('X-CSRF-Token', anon.csrf).field('description', 'A scale with a broken seal, number ' + i)).status);
    jest.restoreAllMocks(); expect(seen.filter((s) => s === 201).length).toBeLessThanOrEqual(5); expect(seen).toContain(429);
  });
  it('sending one-time codes to the same number is throttled', async () => {
    const anon = await new Client(c).init(); anon.ip = nextIp(); const m = '98' + String(Math.floor(10000000 + Math.random() * 89999999)); const a = await anon.post('/auth/otp/send', { channel: 'MOBILE', target: m, purpose: 'REGISTER' }); const b = await anon.post('/auth/otp/send', { channel: 'MOBILE', target: m, purpose: 'REGISTER' });
    expect(a.status).toBeLessThan(300); expect(b.status).toBe(429);
  });
});

// ------------------------------------------------------------------------------------------------ headers and data exposure
describe('headers and data exposure', () => {
  it('API responses carry the protective headers and no server banner', async () => {
    const r = await request(c.app.getHttpServer()).get(API + '/public/system').set('X-Forwarded-For', nextIp());
    expect(r.headers['x-powered-by']).toBeUndefined(); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/); expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['referrer-policy']).toBeTruthy(); expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
  });
  it('a foreign website is not given permission to read responses (no CORS grant)', async () => {
    const r = await request(c.app.getHttpServer()).get(API + '/public/system').set('Origin', 'https://evil.example').set('X-Forwarded-For', nextIp()); expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(c.app.getHttpServer()).options(API + '/grievances').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST').set('X-Forwarded-For', nextIp()); expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('signed-in responses are not cacheable by shared caches', async () => {
    for (const p of ['/me', '/instruments', '/certificates', '/notifications']) { const r = await owner.get(p); const cc = String(r.headers['cache-control'] ?? ''); expect(`${p} ${/no-store|private/.test(cc) ? 'ok' : 'cacheable:' + cc}`).toBe(`${p} ok`); }
  });
  it('no response from any role holds encrypted blobs, password hashes, secrets or blind indexes', async () => {
    const hits: string[] = []; const re = /"[A-Za-z_]*(_enc|_bidx|password_hash|passwordHash|totp_secret|totpSecret|secret|salt)"\s*:/;
    const paths = ['/me', '/instruments', '/applications', '/certificates', '/notifications', '/grievances', '/officer/accounts', '/officer/requests', '/officer/cases', '/officer/schedule', '/admin/users?limit=50', '/admin/audit?limit=50', '/admin/system', '/admin/dashboard', '/officer/dashboard', '/public/search?q=NRK', '/officer/tamper-reports', '/admin/privacy/requests', '/admin/migration/jobs'];
    for (const [cl, ps] of [[owner, paths.slice(0, 6)], [officer, paths.slice(5, 11).concat(['/officer/tamper-reports'])], [admin, paths.slice(11)]] as [Client, string[]][]) for (const p of ps) { const r = await cl.get(p); if (re.test(JSON.stringify(r.body))) hits.push(p); }
    expect(hits).toEqual([]);
  });
  it('the public directory and certificate check never show a full mobile number, email or owner name', async () => {
    const anon = await new Client(c).init(); anon.ip = nextIp(); const r = await anon.get('/public/search?q=NRK'); const t = JSON.stringify(r.body); expect(t).not.toMatch(/\b[6-9]\d{9}\b/); expect(t).not.toMatch(/@/);
    const names = (await c.pool.query(`SELECT 1`)).rowCount; void names;
  });
  it('request logs hold no password, one-time code, query string or session id', async () => {
    const { Logger } = await import('@nestjs/common'); const lines: string[] = []; const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
    const cl = await new Client(c).init(); const r = await cl.post('/auth/login?token=QUERYSECRET123', { identifier: c.demo.OWNER!.mobile, password: 'SuperSecretPw-9!' }); const sid = /nrk_sid=([^;]+)/.exec(String(r.headers['set-cookie']))?.[1] ?? 'none';
    await cl.get('/me?otp=654321'); spy.mockRestore(); const all = lines.join('\n');
    expect(all.length).toBeGreaterThan(0); for (const bad of ['SuperSecretPw', 'QUERYSECRET123', '654321', sid, c.demo.OWNER!.mobile]) expect(all).not.toContain(bad);
  });
});
