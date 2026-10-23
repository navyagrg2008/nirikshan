import 'reflect-metadata';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { roleHas, type RoleCode } from '@nirikshan/shared';
import { IS_PUBLIC, ROLES_KEY, PERM_KEY } from '../src/common/decorators';
import { boot, shutdown, Client, activate, registerUser, type Ctx } from './helpers';

/** NFR-SEC-05: every route is checked, not just the ones someone remembered to write a test for. */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
interface Route { method: string; path: string; isPublic: boolean; roles?: RoleCode[]; perms?: string[]; label: string }

let c: Ctx; let routes: Route[] = [];
const sessions: Record<string, Client> = {};
const ROLE_LIST: RoleCode[] = ['OWNER', 'TRADER', 'OFFICER', 'SENIOR_OFFICER', 'INSPECTOR', 'ADMIN'];
const allowed = (r: Route, role: RoleCode) => (r.roles ? r.roles.includes(role) : true) && (r.perms ? r.perms.some((p) => roleHas(role, p as never)) : true);
const hasGate = (r: Route) => !!r.roles || !!r.perms;
// Authenticated routes that deliberately have no role or permission gate: everyone signed in may call them, and each one works on "my own" data only.
const OPEN_TO_ANY_SIGNED_IN = new Set([
  'GET /me', 'PATCH /me', 'POST /auth/logout', 'POST /auth/logout-all', 'GET /auth/sessions', 'DELETE /auth/sessions/:ref', 'POST /auth/password/change', 'POST /auth/otp/confirm/send', 'POST /auth/otp/confirm/verify',
  'GET /notifications', 'POST /notifications/read-all', 'POST /notifications/:id/read', 'GET /notifications/preferences', 'PUT /notifications/preferences', 'GET /audit/mine', 'POST /auth/reauth', 'POST /auth/mfa/setup/start', 'POST /auth/mfa/setup/confirm', 'POST /auth/mfa/disable', 'GET /catalog/reason-codes',
]);
const fill = (p: string) => p.replace(/:[A-Za-z]+/g, (m) => (/id$/i.test(m) ? randomUUID() : m === ':ref' ? 'X-1' : m === ':token' ? 'junk' : 'x'));
let ip = 0;
const call = (cl: Client, r: Route) => {
  cl.ip = `10.66.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`; const p = fill(r.path); const h = { 'Idempotency-Key': randomUUID() };
  if (r.method === 'GET') return cl.get(p);
  if (r.method === 'POST') return cl.post(p, {}, h);
  if (r.method === 'PUT') return cl.put(p, {});
  if (r.method === 'PATCH') return cl.patch(p, {}, h);
  return cl.del(p);
};
const SKIP_WHEN_ALLOWED = (r: Route) => /logout|\/auth\/sessions|password\/change|mfa|reauth/.test(r.path) || r.path.includes('/jobs/') && r.method === 'POST';

beforeAll(async () => {
  c = await boot();
  const reflector = c.app.get(Reflector); const wrappers = [...c.app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
  for (const w of wrappers) {
    const inst = w.instance as object | undefined; if (!inst) continue; const proto = Object.getPrototypeOf(inst) as object; const base = Reflect.getMetadata('path', w.metatype as object) as string | string[] | undefined;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = (proto as Record<string, unknown>)[name]; if (typeof fn !== 'function' || name === 'constructor') continue;
      const m = Reflect.getMetadata('method', fn) as number | undefined; if (m === undefined) continue;
      const sub = Reflect.getMetadata('path', fn) as string | string[]; const b = [base].flat()[0] ?? ''; const s = [sub].flat()[0] ?? '';
      const path = '/' + [b, s].filter((x) => x && x !== '/').join('/').replace(/\/+/g, '/');
      const handler = fn as (...a: unknown[]) => unknown; const cls = w.metatype as never;
      routes.push({ method: METHODS[m]!, path, label: `${METHODS[m]} ${path}`, isPublic: !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler as never, cls]), roles: reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [handler as never, cls]), perms: reflector.getAllAndOverride<string[]>(PERM_KEY, [handler as never, cls]) });
    }
  }
  routes = routes.filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
  // one signed-in client per role
  const owner = await new Client(c).init(); const od = c.demo.OWNER!; const lo = await owner.post('/auth/login', { identifier: od.mobile, password: od.password }); if (lo.body.status !== 'OK') throw new Error('owner login ' + JSON.stringify(lo.body)); sessions.OWNER = owner;
  const trader = await new Client(c).init(); const td = c.demo.TRADER!; await trader.post('/auth/login', { identifier: td.mobile, password: td.password }); sessions.TRADER = trader;
  let off = 0; for (const [role, key] of [['OFFICER', 'OFFICER'], ['SENIOR_OFFICER', 'SENIOR_OFFICER'], ['INSPECTOR', 'INSPECTOR'], ['ADMIN', 'ADMIN']] as const) { sessions[role] = await (await new Client(c).init()).loginStaff(c.demo[key]!, off); }
}, 120000);
afterAll(async () => { await shutdown(c); });

describe('route inventory', () => {
  it('finds the whole API and every non-public route declares who may use it (or is on the reviewed list)', () => {
    expect(routes.length).toBeGreaterThan(150);
    const ungated = routes.filter((r) => !r.isPublic && !hasGate(r) && !OPEN_TO_ANY_SIGNED_IN.has(r.label));
    expect(ungated.map((r) => r.label)).toEqual([]);
  });
  it('public routes are the expected small set', () => {
    const pub = routes.filter((r) => r.isPublic).map((r) => r.label);
    // Guard against a route becoming public by accident: anything here must be a sign-in, registration, public lookup or health route.
    const odd = pub.filter((l) => !/\/auth\/|\/public\/|\/catalog\/|\/health|\/v\/|\/validate|\/invites|\/rules|\/notices|\/files\/local\//.test(l));   // /files/local/:token only honours an HMAC-signed, expiring token (tested in phase6.abuse)
    expect(odd).toEqual([]);
  });
});

describe('anonymous visitors', () => {
  it('get 401 on every route that is not public, and nothing returns a server error', async () => {
    const anon = await new Client(c).init(); const bad: string[] = [];
    for (const r of routes.filter((x) => !x.isPublic)) { const res = await call(anon, r); if (res.status !== 401) bad.push(`${r.label} -> ${res.status}`); }
    expect(bad).toEqual([]);
  }, 120000);
  it('public routes never return a server error for junk input', async () => {
    const anon = await new Client(c).init(); const bad: string[] = [];
    for (const r of routes.filter((x) => x.isPublic && !/tamper-reports$|\/auth\/otp\/send|\/auth\/login|\/auth\/register/.test(x.path))) { const res = await call(anon, r); if (res.status >= 500) bad.push(`${r.label} -> ${res.status}`); }
    expect(bad).toEqual([]);
  }, 120000);
});

describe('wrong role', () => {
  for (const role of ROLE_LIST) {
    it(`${role} gets 403 on every route meant for other roles, and never a server error on its own`, async () => {
      const cl = sessions[role]!; const bad: string[] = [];
      for (const r of routes.filter((x) => !x.isPublic)) {
        if (allowed(r, role) && SKIP_WHEN_ALLOWED(r)) continue;
        const res = await call(cl, r);
        if (!allowed(r, role)) { if (res.status !== 403) bad.push(`${r.label} -> ${res.status} (expected 403)`); }
        else if (res.status >= 500) bad.push(`${r.label} -> ${res.status} (server error)`);
      }
      expect(bad).toEqual([]);
    }, 240000);
  }
});

describe('error responses', () => {
  it('never leak stack traces, SQL or file paths', async () => {
    const cl = sessions.ADMIN!; const seen: string[] = [];
    for (const r of routes.filter((x) => !x.isPublic && x.method === 'GET').slice(0, 80)) { const res = await call(cl, r); const t = JSON.stringify(res.body); if (/\bat .*\(.*:\d+:\d+\)|SELECT |INSERT |node_modules|\/home\/|pg_catalog|syntax error/i.test(t)) seen.push(r.label); }
    expect(seen).toEqual([]);
  }, 120000);
});
void registerUser; void activate;
