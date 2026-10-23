// Phase 6 role sweep: every role signs in and opens every page it may use, in light, dark, Hindi (owner/public) and 375 px.
// Fails on: console errors, CSP violations, uncaught page errors, 5xx responses, axe serious/critical, horizontal scroll at 375 px.
// Needs the dev stack and /var/tmp/seed-out.txt. Usage: node sweep-roles.mjs [ROLE ...]
import { chromium } from 'playwright'; import { readFileSync } from 'fs'; import { execSync } from 'child_process'; import { authenticator } from 'otplib'; import axe from 'axe-core';
const BASE = 'http://localhost:3000';
const seed = readFileSync('/var/tmp/seed-out.txt', 'utf8'); const cred = (m) => { const l = seed.split('\n').find((x) => x.includes(`mobile ${m} `)); return { pw: l.match(/password (\S+)/)[1], totp: l.match(/totp-secret (\S+)/)?.[1] }; };
const sql = (q) => execSync(`psql -h 127.0.0.1 -p 5545 -U postgres -d nrk_dev -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (q) => sql(q).split('\n')[0] || 'none';
const today = new Date().toISOString().slice(0, 10);
const PUBLIC = ['/', '/login', '/register', '/forgot-password', '/validate', '/v/not-a-real-token', '/search', '/report', '/rules', '/notices', '/help', '/privacy', '/terms', '/accessibility', '/invite/not-a-real-token'];
const ROLES = {
  OWNER: { mobile: '9000000001', lang: true, pages: (id) => ['/owner/dashboard', '/owner/instruments', '/owner/instruments/new', '/owner/instruments/bulk', `/owner/instruments/${id.inst}`, `/owner/instruments/${id.inst}/apply`, `/owner/instruments/${id.inst}/history`, '/owner/applications', `/owner/applications/${id.app}`, '/owner/applications/batch', '/owner/certificates', `/owner/certificates/${id.cert}`, '/owner/notices', '/owner/services', '/owner/grievances', '/owner/settings'] },
  OFFICER: { mobile: '9000000003', totp: true, pages: (id) => ['/officer/dashboard', '/officer/queue', '/officer/cases', `/officer/cases/${id.app}`, '/officer/decisions', '/officer/certificates', `/officer/certificates/${id.cert}`, '/officer/schedule', '/officer/inspectors', `/officer/inspectors/${id.insp}/route/${today}`, '/officer/enforcement', '/officer/reports', '/officer/settings'] },
  SENIOR_OFFICER: { mobile: '9000000007', totp: true, pages: (id) => ['/officer/dashboard', '/officer/queue', '/officer/cases', '/officer/decisions', '/officer/certificates', '/officer/schedule', '/officer/inspectors', '/officer/enforcement', '/officer/reports', '/officer/settings'] },
  INSPECTOR: { mobile: '9000000004', totp: true, pages: (id) => ['/inspector/dashboard', '/inspector/history', '/inspector/settings', `/inspector/visits/${id.visit}`] },
  ADMIN: { mobile: '9000000005', totp: true, pages: () => ['/admin/dashboard', '/admin/users', '/admin/masterdata', '/admin/rules', '/admin/certificates', '/admin/audit', '/admin/reports', '/admin/system', '/admin/privacy', '/admin/migration'] },
};
const want = process.argv.slice(2); const roles = want.length ? want : ['PUBLIC', ...Object.keys(ROLES)];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
let fails = 0, checks = 0; const report = [];
const ok = (n, c, d = '') => { checks++; if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n, d); report.push({ n, pass: !!c, d }); };
function watch(page, tag) { const bag = { errs: [], bad: [] };
  page.on('pageerror', (e) => bag.errs.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') bag.errs.push('console: ' + m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 500) bag.bad.push(`${r.status()} ${r.url()}`); }); return bag; }
async function axeScan(page) { await page.addScriptTag({ content: axe.source }); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })); return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0]?.target?.join(' ')}`); }
async function visit(page, bag, path, mode, label) {
  bag.errs.length = 0; bag.bad.length = 0;
  const resp = await page.goto(BASE + path, { waitUntil: 'load' }).catch((e) => ({ status: () => 0, err: e }));
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleep(400);
  const st = resp.status?.() ?? 0; const url = new URL(page.url()).pathname;
  await page.evaluate((m) => { document.documentElement.dataset.theme = m; }, mode === 'dark' ? 'dark' : 'light'); await sleep(250);
  const v = await axeScan(page); const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const csp = bag.errs.filter((e) => /Content Security Policy|Refused to/i.test(e)); const other = bag.errs.filter((e) => !/Content Security Policy|Refused to/i.test(e) && !/status of (401|403|404|409|422|428)/.test(e));
  const name = `${label} ${path} [${mode}]`; const probs = [];
  if (st >= 500 || st === 0) probs.push('http ' + st); if (v.length) probs.push('axe ' + v.join(' | ')); if (csp.length) probs.push('CSP ' + csp[0]); if (other.length) probs.push(other[0]); if (bag.bad.length) probs.push(bag.bad[0]); if (mode === 'mobile' && sw > 1) probs.push('h-scroll ' + sw + 'px');
  if (url === '/login' && !path.startsWith('/login') && !PUBLIC.includes(path)) probs.push('bounced to login');
  ok(name, probs.length === 0, probs.join(' ; '));
}
try { for (const role of roles) {
  if (role === 'PUBLIC') {
    for (const [lang, theme] of [['en', 'light'], ['en', 'dark'], ['hi', 'light'], ['hi', 'dark']]) { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript((l) => { try { localStorage.setItem('nrk_lang', l); } catch {} }, lang); const p = await ctx.newPage(); const bag = watch(p); for (const path of PUBLIC) await visit(p, bag, path, theme, `PUBLIC/${lang}`); await ctx.close(); }
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } }); const p = await ctx.newPage(); const bag = watch(p); for (const path of PUBLIC) await visit(p, bag, path, 'mobile', 'PUBLIC'); await ctx.close(); continue;
  }
  const R = ROLES[role]; const { pw, totp } = cred(R.mobile);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const bag = watch(page);
  await page.goto(BASE + '/login'); await page.getByLabel('Mobile number or email').fill(R.mobile); await page.getByLabel('Password').fill(pw); await page.getByRole('button', { name: 'Sign in' }).first().click();
  if (R.totp) { await page.getByLabel('6-digit code').fill(authenticator.generate(totp)); await page.getByRole('button', { name: 'Verify' }).click(); }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {}); ok(`${role} signed in`, !page.url().includes('/login'), page.url());
  const me = await page.evaluate(async () => (await (await fetch('/api/v1/me', { credentials: 'same-origin' })).json()));
  const id = { inst: first("select id from instruments order by created_at limit 1"), app: first("select id from applications order by created_at limit 1"), cert: first("select id from certificates order by created_at limit 1"), insp: first("select inspector_id from inspection_visits limit 1"), visit: first(`select id from inspection_visits where inspector_id='${me.id ?? me.user?.id}' order by created_at limit 1`) };
  const paths = R.pages(id);
  for (const path of paths) await visit(page, bag, path, 'light', role);
  for (const path of paths.slice(0, 6)) await visit(page, bag, path, 'dark', role);
  if (R.lang) { await page.evaluate(() => localStorage.setItem('nrk_lang', 'hi')); for (const path of paths.slice(0, 8)) await visit(page, bag, path, 'light', role + '/hi'); await page.evaluate(() => localStorage.setItem('nrk_lang', 'en')); }
  await page.setViewportSize({ width: 375, height: 800 }); for (const path of paths) await visit(page, bag, path, 'mobile', role);
  await ctx.close(); if (R.totp) await sleep(31000);
} } finally { await browser.close(); }
console.log(`\n${checks - fails}/${checks} passed`); import('fs').then((f) => f.writeFileSync(process.env.OUT ?? '/var/tmp/sweep-report.json', JSON.stringify(report, null, 1))); process.exit(fails ? 1 : 0);
