// Phase 6 load test. Signs in once per role in a real browser (so cookies are genuine), then drives the API with autocannon.
// Targets (SRS): read p95 < 300 ms, write p95 < 600 ms, dashboards < 2 s. Usage: node load-test.mjs [connections=10] [seconds=15]
import { chromium } from 'playwright'; import autocannon from 'autocannon'; import { readFileSync, writeFileSync } from 'fs'; import { authenticator } from 'otplib';
const API = 'http://localhost:4000'; const P = '/api/v1'; const WEB = 'http://localhost:3000'; const CONN = +(process.argv[2] ?? 10); const SECS = +(process.argv[3] ?? 15);
const seed = readFileSync('/var/tmp/seed-out.txt', 'utf8'); const cred = (m) => { const l = seed.split('\n').find((x) => x.includes(`mobile ${m} `)); return { pw: l.match(/password (\S+)/)[1], totp: l.match(/totp-secret (\S+)/)?.[1] }; };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
async function session(mobile, staff) { const { pw, totp } = cred(mobile); const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.goto(WEB + '/login'); await p.getByLabel('Mobile number or email').fill(mobile); await p.getByLabel('Password').fill(pw); await p.getByRole('button', { name: 'Sign in' }).first().click();
  if (staff) { await p.getByLabel('6-digit code').fill(authenticator.generate(totp)); await p.getByRole('button', { name: 'Verify' }).click(); }
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }); const ck = await ctx.cookies(); await ctx.close();
  const csrf = ck.find((c) => c.name.endsWith('nrk_csrf'))?.value ?? ''; return { cookie: ck.map((c) => `${c.name}=${c.value}`).join('; '), csrf }; }
const owner = await session('9000000001', false); const officer = await session('9000000003', true); await new Promise((r) => setTimeout(r, 31000)); const admin = await session('9000000005', true); await browser.close();
const H = (s, extra = {}) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, accept: 'application/json', origin: WEB, ...extra });
const scenarios = [
  ['public: rules (read)', 'read', { path: '/public/rules' }],
  ['public: notices (read)', 'read', { path: '/public/notices?limit=5' }],
  ['public: stats (read)', 'read', { path: '/public/stats' }],
  ['owner: my instruments (read)', 'read', { path: '/instruments', headers: H(owner) }],
  ['owner: my applications (read)', 'read', { path: '/applications', headers: H(owner) }],
  ['owner: my certificates (read)', 'read', { path: '/certificates', headers: H(owner) }],
  ['owner: notifications (read)', 'read', { path: '/notifications', headers: H(owner) }],
  ['officer: case list (read)', 'read', { path: '/officer/cases', headers: H(officer) }],
  ['officer: schedule (read)', 'read', { path: '/officer/schedule?from=2026-10-01&to=2026-11-30', headers: H(officer) }],
  ['officer: dashboard', 'dash', { path: '/officer/dashboard', headers: H(officer) }],
  ['admin: dashboard', 'dash', { path: '/admin/dashboard', headers: H(admin) }],
  ['owner: save instrument draft (write, encrypted)', 'write', { path: '/instruments/draft/mine', method: 'PUT', headers: H(owner, { 'content-type': 'application/json' }), body: JSON.stringify({ step: 3, data: { serialNo: 'LOAD-1', address: '12 Market Road' } }) }],
  ['owner: mark notifications read (write)', 'write', { path: '/notifications/read-all', method: 'POST', headers: H(owner, { 'content-type': 'application/json', 'idempotency-key': 'x' }), body: '{}' }],
];
const target = { read: 300, write: 600, dash: 2000 }; const rows = [];
for (const [name, kind, req] of scenarios) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) continue;
  const r = await autocannon({ url: API, connections: CONN, duration: SECS, requests: [{ ...req, path: P + req.path, setupRequest: (rq) => { if (rq.headers?.['idempotency-key']) rq.headers['idempotency-key'] = crypto.randomUUID(); return rq; } }] });
  const non2xx = r.non2xx; const row = { name, kind, conn: CONN, rps: Math.round(r.requests.average), p50: r.latency.p50, p975: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max, total: r.requests.total, non2xx, errors: r.errors, timeouts: r.timeouts, target: target[kind] };
  rows.push(row); console.log(JSON.stringify(row));
}
writeFileSync(`/var/tmp/load-${CONN}.json`, JSON.stringify(rows, null, 1));
