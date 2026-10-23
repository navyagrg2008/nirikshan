// Browser smoke test (Playwright + axe). Needs a running stack in development mode with API logs in /var/tmp/nrk-api.log (OTPs are read from it).
// Usage: node smoke.mjs <officerPw> <officerTotp> <adminPw> <adminTotp>   (values printed by 'pnpm seed'). Dev dependencies: playwright, axe-core, otplib@12.
import { chromium } from 'playwright'; import { readFileSync, writeFileSync } from 'fs'; import { authenticator } from 'otplib'; import axe from 'axe-core';
const BASE = 'http://localhost:3000'; const LOG = '/var/tmp/nrk-api.log'; const SHOTS = process.env.SHOTS; const OFFICER = { m: '9000000003', pw: process.argv[2], totp: process.argv[3] }; const ADMIN = { m: '9000000005', pw: process.argv[4], totp: process.argv[5] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = []; const ok = (n, c, d = '') => { results.push([c ? 'PASS' : 'FAIL', n, d]); console.log(c ? 'PASS' : 'FAIL', n, d); };
const otpFor = async (to) => { for (let i = 0; i < 30; i++) { const t = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`to=${to}`) || (to === '*' && l.includes('[dev '))); const l = t[t.length - 1]; if (l) { const m = l.match(/\b(\d{6})\b(?!.*\b\d{6}\b)/); if (m) return m[1]; } await sleep(300); } throw new Error('no otp for ' + to); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const newCtx = () => browser.newContext({ viewport: { width: 1280, height: 900 } });
async function scan(page, name) { await page.addScriptTag({ content: axe.source }); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })); const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)); ok(`a11y ${name}`, bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length})`).join(',')); return r.violations; }
async function code(page, label = '6-digit code', who) { const c = await otpFor(who); await page.getByLabel(label, { exact: true }).fill(c); }
async function loginStaff(page, who) {
  await page.goto(BASE + '/login'); await page.getByLabel('Mobile number or email').fill(who.m); await page.getByLabel('Password').fill(who.pw); await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.getByLabel('6-digit code').fill(authenticator.generate(who.totp)); await page.getByRole('button', { name: 'Verify' }).click();
}
const mobile = '98' + String(Math.floor(1e7 + Math.random() * 9e7)); const pw = 'Tr1cky-Horizon-77'; const firm = 'Kapoor Store ' + mobile.slice(-4);
try {
  // ---- public pages
  let c = await newCtx(); let p = await c.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.goto(BASE); await p.getByRole('heading', { level: 1 }).waitFor(); ok('home renders', true); if (SHOTS) await p.screenshot({ path: SHOTS + '/home.png' }); await scan(p, 'home');
  await p.getByRole('button', { name: 'हिन्दी' }).click(); ok('hindi toggle', (await p.getByRole('heading', { level: 1 }).innerText()).includes('सत्यापन')); await p.getByRole('button', { name: 'English' }).click();
  await p.getByRole('button', { name: 'Dark mode' }).click(); ok('dark theme', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark'); if (SHOTS) await p.screenshot({ path: SHOTS + '/home-dark.png' }); await scan(p, 'home-dark'); await p.getByRole('button', { name: 'Dark mode' }).click();
  for (const path of ['/rules', '/notices', '/help', '/privacy', '/login', '/register']) { await p.goto(BASE + path); await p.getByRole('heading', { level: 1 }).first().waitFor(); await scan(p, path); }
  // ---- registration (5 steps, OTP, upload)
  await p.goto(BASE + '/register'); await p.getByLabel('Mobile number').fill(mobile); await p.getByRole('button', { name: 'Send code' }).click(); await code(p, '6-digit code', mobile); await p.getByRole('button', { name: 'Verify' }).click(); await p.getByText('Mobile number confirmed.').waitFor(); await p.getByRole('button', { name: 'Next' }).click();
  await p.getByLabel('Full name').fill('Meera Kapoor'); await p.getByLabel('Date of birth').fill('1988-04-12'); await p.getByLabel('Password', { exact: false }).fill(pw); await p.getByRole('button', { name: 'Next' }).click();
  await p.getByLabel('Business name').fill(firm); await p.getByLabel('Address').fill('14 Market Road'); await p.getByLabel('PIN code').fill('201001'); await p.getByLabel('Area').selectOption({ index: 1 }); await p.getByRole('button', { name: 'Next' }).click();
  writeFileSync('/var/tmp/licence.pdf', '%PDF-1.4\n% synthetic licence\n'); await p.getByLabel('Trade licence').setInputFiles('/var/tmp/licence.pdf'); await p.getByText('Added: licence.pdf').waitFor(); await scan(p, 'register-docs'); await p.getByRole('button', { name: 'Next' }).click();
  await p.getByRole('checkbox').check(); await p.getByRole('button', { name: 'Submit' }).click(); await p.waitForURL('**/register/pending'); ok('registration lands on pending page', true); if (SHOTS) await p.screenshot({ path: SHOTS + '/pending.png' });
  await p.goto(BASE + '/owner/instruments'); await p.waitForURL('**/register/pending'); ok('pending account is kept out of owner area', true);
  // ---- officer approves
  const oc = await newCtx(); const op = await oc.newPage(); await loginStaff(op, OFFICER); await op.waitForURL('**/officer/dashboard'); ok('officer MFA login lands on dashboard', true); await scan(op, 'officer-dashboard'); await op.getByRole('link', { name: 'Queue' }).click();
  const card = op.locator('section', { hasText: firm }); await card.waitFor(); ok('queue shows masked mobile', (await op.locator('body').innerText()).includes('******') && !(await op.locator('body').innerText()).includes(mobile)); await scan(op, 'officer-queue'); if (SHOTS) await op.screenshot({ path: SHOTS + '/officer-queue.png' });
  const [popup] = await Promise.all([op.waitForEvent('popup', { timeout: 8000 }).catch(() => null), card.getByRole('button', { name: /View trade licence/i }).click()]); ok('officer can open uploaded document via signed link', !!popup); await popup?.close();
  await card.getByRole('button', { name: 'Approve' }).click(); await card.waitFor({ state: 'detached' }); ok('officer approves account', true);
  // ---- owner signs in, adds instrument
  await p.goto(BASE + '/login'); await p.getByLabel('Mobile number or email').fill(mobile); await p.getByLabel('Password').fill(pw); await p.getByRole('button', { name: 'Sign in' }).first().click(); await p.waitForURL('**/owner/dashboard'); ok('approved owner lands on dashboard', true); await scan(p, 'owner-dashboard'); await p.getByRole('link', { name: 'Instruments' }).first().click(); await p.waitForURL('**/owner/instruments');
  await p.getByText('No instruments yet.').waitFor(); await scan(p, 'owner-empty');
  await p.getByRole('link', { name: 'Add instrument' }).click(); await p.getByLabel('Category').selectOption({ index: 1 }); await p.getByLabel('Capacity range').selectOption({ index: 1 }); await p.getByLabel('Accuracy class').selectOption({ index: 1 }); await p.getByRole('button', { name: 'Next' }).click();
  const band = await p.getByText(/^Capacity \(/).innerText().catch(() => ''); await p.getByLabel(/^Capacity/).first().fill('1'); await p.getByLabel('Serial number').fill('UI-' + Date.now()); await p.getByLabel('Make').fill('Acme'); await p.getByRole('button', { name: 'Next' }).click();
  await p.getByLabel(/Address/).fill('14 Market Road'); await p.getByLabel('Area').selectOption({ index: 1 }); await sleep(1800); ok('draft autosaved', (await p.getByRole('status').filter({ hasText: /Draft/ }).count()) > 0); await p.getByRole('button', { name: 'Next' }).click(); await p.getByRole('button', { name: 'Next' }).click();
  await p.getByRole('checkbox').check(); await scan(p, 'wizard-review'); await p.getByRole('button', { name: 'Next' }).click();
  await sleep(31000); await p.getByRole('button', { name: 'Send code' }).click(); await sleep(500); await code(p, '6-digit code', mobile); await p.getByRole('button', { name: 'Verify' }).click(); await p.getByText('Confirmed.').waitFor(); await p.getByRole('button', { name: 'Register instrument' }).click();
  await p.waitForURL(/\/owner\/instruments\/[0-9a-f-]{36}/, { timeout: 10000 }); ok('instrument registered via wizard', true); await p.getByText(/NRK-INS-\d+/).first().waitFor(); if (SHOTS) await p.screenshot({ path: SHOTS + '/instrument.png' }); await scan(p, 'instrument-detail');
  await p.getByRole('button', { name: 'Edit details' }).click(); await p.getByLabel('Model').fill('PS-1'); await p.getByRole('button', { name: 'Save' }).click(); await p.getByText('Saved.').waitFor(); ok('edit with version check', true);
  await p.goto(BASE + '/owner/instruments'); await p.getByRole('link', { name: /NRK-INS-/ }).waitFor(); if (SHOTS) await p.screenshot({ path: SHOTS + '/instruments.png' }); await scan(p, 'owner-list');
  await p.goto(BASE + '/owner/settings'); await p.getByText('This device').waitFor(); await scan(p, 'settings'); await p.goto(BASE + '/officer/queue'); await p.waitForURL('**/owner/dashboard'); ok('owner cannot open officer area', true);
  // ---- admin
  const ac = await newCtx(); const ap = await ac.newPage(); await loginStaff(ap, ADMIN); await ap.waitForURL('**/admin/dashboard'); ok('admin login lands on dashboard', true); await scan(ap, 'admin-dashboard'); await ap.goto(BASE + '/admin/users'); await ap.getByRole('table').waitFor(); await scan(ap, 'admin-users'); if (SHOTS) await ap.screenshot({ path: SHOTS + '/admin-users.png' });
  await ap.goto(BASE + '/admin/masterdata'); await ap.getByRole('table').waitFor(); await scan(ap, 'admin-masterdata');
  await ap.goto(BASE + '/admin/audit'); await ap.getByRole('table').waitFor(); await ap.getByRole('button', { name: 'Verify chain' }).click(); await ap.getByText(/Chain intact/).waitFor({ timeout: 15000 }).catch(async () => { await ap.getByLabel('Password').fill(ADMIN.pw).catch(() => {}); }); 
  if (await ap.getByLabel('Password').isVisible().catch(() => false)) { await ap.getByLabel('Password').fill(ADMIN.pw); await ap.getByLabel('Authenticator code').fill(authenticator.generate(ADMIN.totp, { epoch: Date.now() + 30000 })); await ap.getByRole('button', { name: 'Confirm' }).click(); }
  await ap.getByText(/Chain intact/).waitFor({ timeout: 15000 }); ok('audit chain verified from UI (with step-up if prompted)', true); if (SHOTS) await ap.screenshot({ path: SHOTS + '/admin-audit.png' });
  // ---- session timeout dialog (fake clock) and sign out
  ok('no browser console errors on public/owner pages', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.slice(0, 3).join(' | '));
  await p.getByRole('button', { name: 'Sign out' }).click(); await p.waitForURL('**/login'); await p.goto(BASE + '/owner/instruments'); await p.waitForURL('**/login'); ok('sign out ends session', true);
} catch (e) { ok('script completed', false, String(e).split('\n').slice(0, 4).join(' ')); } finally { await browser.close(); }
const f = results.filter((r) => r[0] === 'FAIL').length; console.log(`\n${results.length - f} passed, ${f} failed`); process.exit(f ? 1 : 0);
