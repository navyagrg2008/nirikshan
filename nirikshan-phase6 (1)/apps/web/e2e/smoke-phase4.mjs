// Phase 4 browser smoke: inspector stepper (phone size) -> officer decision -> certificate -> public QR check -> suspend/reinstate, plus axe scans.
// Needs the dev stack (API log in /var/tmp/nrk-api.log, psql on 5545). All data is synthetic.
// Usage: node smoke-phase4.mjs <ownerPw> <officerPw> <officerTotp> <insp1Pw> <insp1Totp> <insp2Pw> <insp2Totp> <adminPw> <adminTotp>
import { chromium } from 'playwright'; import { readFileSync, writeFileSync } from 'fs'; import { execSync } from 'child_process'; import { authenticator } from 'otplib'; import axe from 'axe-core';
const BASE = 'http://localhost:3000'; const LOG = '/var/tmp/nrk-api.log'; const SHOTS = process.env.SHOTS;
const [, , OWNER_PW, OFF_PW, OFF_T, I1_PW, I1_T, I2_PW, I2_T, ADM_PW, ADM_T] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
const ok = (n, c, d = '') => { results.push([c ? 'PASS' : 'FAIL', n, d]); console.log(c ? 'PASS' : 'FAIL', n, d); };
const sql = (q) => execSync(`psql -h 127.0.0.1 -p 5545 -U postgres -d nrk_dev -tAc "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
const otpFor = async (to) => { for (let i = 0; i < 30; i++) { const t = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`to=${to}`)); const l = t[t.length - 1]; if (l) { const m = l.match(/\b(\d{6})\b(?!.*\b\d{6}\b)/); if (m) return m[1]; } await sleep(300); } throw new Error('no otp for ' + to); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const newCtx = (o = {}) => browser.newContext({ viewport: { width: 1280, height: 900 }, ...o });
const phone = () => newCtx({ viewport: { width: 375, height: 800 }, geolocation: { latitude: 28.6139, longitude: 77.209 }, permissions: ['geolocation'] });
async function scan(page, name) { await page.addScriptTag({ content: axe.source }); const r = await page.evaluate(async () => await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })); const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)); ok(`a11y ${name}`, bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0]?.target?.join(' ')} ${(v.nodes[0]?.any?.[0]?.message ?? '').slice(0, 140)}`).join(' | ')); }
async function loginStaff(page, m, pw, totp, off = 0) { await page.goto(BASE + '/login'); await page.getByLabel('Mobile number or email').fill(m); await page.getByLabel('Password').fill(pw); await page.getByRole('button', { name: 'Sign in' }).first().click(); await page.getByLabel('6-digit code').fill(authenticator.generate(totp, { epoch: Date.now() + off * 30000 })); await page.getByRole('button', { name: 'Verify' }).click(); }
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }); };
let reauthN = 0; const pages = {};
async function reauthIfAsked(page, pw, totp) { const d = page.getByRole('dialog', { name: 'Confirm it is you' }); if (await d.waitFor({ timeout: 2500 }).then(() => true, () => false)) { await d.getByLabel('Password').fill(pw); const c = d.getByLabel('Authenticator code'); if (await c.count()) await c.fill(authenticator.generate(totp, { epoch: Date.now() + (reauthN++ % 2) * 30000 })); await d.getByRole('button', { name: 'Confirm' }).click(); await d.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {}); return true; } return false; }
const PDF = '/var/tmp/p4-doc.pdf'; writeFileSync(PDF, '%PDF-1.4\n% synthetic document\n');
const PNG = '/var/tmp/p4-photo.png'; writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
try {
  const errors = [];
  // ------------------------------------------------------------ setup: owner applies, officer checks documents (same path as phase 3)
  const oc = await newCtx(); const op = await oc.newPage(); pages.op = op; op.on('pageerror', (e) => errors.push(e.message));
  await op.goto(BASE + '/login'); await op.getByLabel('Mobile number or email').fill('9000000001'); await op.getByLabel('Password').fill(OWNER_PW); await op.getByRole('button', { name: 'Sign in' }).first().click(); await op.waitForURL('**/owner/dashboard');
  const call = (page) => (path, method = 'GET', body, headers = {}) => page.evaluate(async ([path, method, body, headers]) => { const csrf = document.cookie.split('; ').find((c) => c.startsWith('nrk_csrf='))?.slice(9) ?? ''; const r = await fetch('/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [path, method, body, headers]);
  const ocall = call(op);
  const cats = (await ocall('/catalog/categories')).body; const cat = cats.categories.find((c) => c.code === 'PLATFORM_SCALE'); const areas = (await ocall('/catalog/areas')).body; const ward = areas.filter((a) => a.level === 'WARD').sort((a, b) => a.code.localeCompare(b.code))[0];
  const sent = await ocall('/auth/otp/confirm/send', 'POST', {}); const mark = Date.now(); await sleep(400); const cd = await otpFor('9000000001'); const ver = await ocall('/auth/otp/confirm/verify', 'POST', { challengeId: sent.body.challengeId, code: cd });
  const created = await ocall('/instruments', 'POST', { categoryId: cat.id, capacityBandId: cat.capacityBands[0].id, accuracyClassId: cats.accuracyClasses.find((a) => a.code === 'III').id, capacity: '50', capacityUnit: 'kg', serialNo: 'P4-' + mark, make: 'Acme', location: { address: '12 Market Road, Ward 1', areaId: ward.id }, ownership: { mode: 'SELF' }, confirmToken: ver.body.verificationToken, declarationAccepted: true }, { 'Idempotency-Key': crypto.randomUUID() });
  ok('instrument created for the test', created.status === 201, JSON.stringify(created.body).slice(0, 120)); const instId = created.body.id;
  await op.goto(`${BASE}/owner/instruments/${instId}`); await op.getByRole('link', { name: 'Apply for verification' }).click(); await op.getByText('Verification due').waitFor(); await op.getByRole('checkbox').check(); await op.getByRole('button', { name: 'Submit application' }).click();
  await op.waitForURL(/\/owner\/applications\/[0-9a-f-]{36}/); const appUrl = op.url(); const appId = appUrl.split('/').pop(); const inputs = op.locator('input[type=file]');
  await inputs.nth(0).setInputFiles(PDF); await op.getByText('Waiting for check').first().waitFor(); await inputs.nth(1).setInputFiles(PDF); await op.getByText('Waiting for check').nth(1).waitFor();
  const fc = await newCtx(); const fp = await fc.newPage(); pages.fp = fp; fp.on('pageerror', (e) => errors.push(e.message)); await loginStaff(fp, '9000000003', OFF_PW, OFF_T, -1); await fp.waitForURL('**/officer/dashboard');
  await fp.goto(`${BASE}/officer/cases/${appId}`); await fp.getByText('Document check complete').first().waitFor();
  for (const b of await fp.getByRole('button', { name: 'Accept' }).all()) { if (await b.isEnabled()) { await b.click(); await sleep(700); } }
  await fp.getByRole('button', { name: 'Document check complete' }).click(); await fp.getByText(/A visit was booked automatically|needs your confirmation/).first().waitFor({ timeout: 15000 });
  if (await fp.getByRole('button', { name: 'Accept suggestion' }).count()) { await fp.getByRole('button', { name: 'Accept suggestion' }).click(); await fp.getByText('Visit confirmed.').waitFor(); }
  const appNo = (await fp.getByRole('heading', { level: 1 }).innerText()).trim(); ok('case is scheduled', /^NRK-APP-/.test(appNo), appNo);
  // The automatic slot is days away; move it to "now" so the arrival window (start -60 min to end +240 min) is open.
  sql(`UPDATE inspection_visits SET scheduled_window = tstzrange(now() - interval '10 minutes', now() + interval '90 minutes') WHERE application_id='${appId}' AND status='SCHEDULED'`);

  // ------------------------------------------------------------ inspector (phone size)
  let ic, ip, mine = null;
  for (const [m, pw, t] of [['9000000004', I1_PW, I1_T], ['9000000006', I2_PW, I2_T]]) { const c = await phone(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); await loginStaff(p, m, pw, t, -1); await p.waitForURL('**/inspector/dashboard'); await p.getByRole('heading', { name: 'Your visits' }).waitFor(); await sleep(800); if (await p.locator(`a[href^="/inspector/visits/"]`).count()) { ic = c; ip = p; mine = m; break; } await c.close(); }
  ok('the assigned inspector sees the visit', !!ip, mine ?? 'none'); await scan(ip, 'inspector-dashboard-375'); await shot(ip, 'p4-inspector-dashboard');
  await ip.locator('a[href^="/inspector/visits/"]').first().click(); await ip.getByRole('heading', { name: '1. Arrive at the premises' }).waitFor(); await scan(ip, 'stepper-arrive-375'); await shot(ip, 'p4-step1');
  const visitId = ip.url().split('/').pop();
  ok('steps 2-5 are locked before arrival', await ip.getByRole('button', { name: /^2\. Checklist/ }).isDisabled());
  await ip.getByRole('button', { name: 'Share my location and start' }).click(); await ip.getByRole('heading', { name: /2\. Checklist/ }).waitFor({ timeout: 15000 }); ok('arrival with browser location starts the visit', true);
  // checklist: answer every item the passing way, using the template the server sent
  const icall = call(ip); const vd = (await icall(`/inspector/visits/${visitId}`)).body; const items = vd.checklist.items;
  ok('checklist template came from the server', items.length >= 5, String(items.length));
  await scan(ip, 'stepper-checklist-375'); await shot(ip, 'p4-step2');
  await ip.getByRole('button', { name: 'Next: test' }).waitFor(); ok('next is disabled until required items are answered', await ip.getByRole('button', { name: 'Next: test' }).isDisabled());
  for (const it of items) { if (it.required || it.critical || true) await ip.locator(`input[name="c-${it.code}"][value="${it.pass}"]`).check(); }
  ok('next enabled once everything is answered', await ip.getByRole('button', { name: 'Next: test' }).isEnabled());
  await sleep(2600); await ip.reload(); await ip.getByText(/restored your earlier draft/).waitFor({ timeout: 10000 }); ok('draft autosaved and restored after a reload', true);
  ok('answers are still ticked after the reload', await ip.locator(`input[name="c-${items[0].code}"][value="${items[0].pass}"]`).isChecked());
  await ip.getByRole('button', { name: /^3\. Test/ }).click(); await ip.getByRole('heading', { name: /3\. Test readings/ }).waitFor();
  const nums = ip.locator('input[inputmode=decimal]'); const set = async (i, v) => { await nums.nth(i).fill(v); };
  await set(0, '10'); await set(1, '10'); await set(2, '20'); await set(3, '20'); await set(4, '30'); await set(5, '30.5');
  await ip.getByRole('button', { name: 'Check results' }).click(); await ip.getByText('Overall: Fail').waitFor(); ok('server says FAIL for a reading 500 g out', true); await shot(ip, 'p4-step3-fail');
  await set(5, '30'); ok('editing a reading clears the old verdict', (await ip.getByText(/Overall:/).count()) === 0);
  await ip.getByRole('button', { name: 'Check results' }).click(); await ip.getByText('Overall: Pass').waitFor(); ok('server says PASS after the fix', true); await scan(ip, 'stepper-test-375'); await shot(ip, 'p4-step3');
  await nums.nth(0).fill('10.1234567'); ok('a 7-decimal reading is flagged', (await ip.getByText(/up to 6 decimals/).count()) > 0); await nums.nth(0).fill('10');
  await ip.getByRole('button', { name: 'Next: photos and decision' }).click(); await ip.getByRole('heading', { name: /4\. Photos/ }).waitFor();
  ok('approval cannot be recommended-less', await ip.getByRole('button', { name: 'Next: review' }).isDisabled());
  const file = ip.getByLabel('Take or choose a photo'); await file.setInputFiles(PNG); await ip.getByText('location tagged').first().waitFor({ timeout: 15000 }); ok('photo uploaded with location tag', true);
  await ip.getByLabel('What does the photo show?').selectOption('SEAL'); await file.setInputFiles(PNG); await ip.getByText('location tagged').nth(1).waitFor({ timeout: 15000 });
  await ip.getByLabel('Recommend approval').check(); await ip.getByLabel('Sticker serial number you applied').fill('STK-' + String(mark).slice(-7)); await scan(ip, 'stepper-decision-375'); await shot(ip, 'p4-step4');
  await ip.getByRole('button', { name: 'Next: review' }).click(); await ip.getByRole('heading', { name: /5\. Review/ }).waitFor(); await ip.getByText('Pass').first().waitFor(); await scan(ip, 'stepper-review-375'); await shot(ip, 'p4-step5');
  await ip.getByRole('button', { name: 'Submit inspection' }).click(); await ip.getByText(/Submitted\. The officer has been told/).waitFor({ timeout: 20000 }); ok('inspection submitted', true);
  await ip.goto(`${BASE}/inspector/history`); await ip.getByRole('heading', { name: 'Past visits' }).waitFor(); await ip.locator('a[href^="/inspector/visits/"]').first().waitFor(); ok('submitted visit appears in history', (await ip.locator('a[href^="/inspector/visits/"]').count()) >= 1); await scan(ip, 'inspector-history-375');
  await ip.locator('a[href^="/inspector/visits/"]').first().click(); await ip.getByRole('heading', { name: 'Submitted inspection' }).waitFor(); ok('submitted visit opens read-only with server results', (await ip.getByRole('table').count()) === 1); await scan(ip, 'inspector-submitted-375');
  const after = await icall(`/inspector/visits/${visitId}/submit`, 'POST', {}, { 'Idempotency-Key': crypto.randomUUID() }); ok('a submitted visit cannot be submitted again', after.status >= 400, String(after.status));

  // ------------------------------------------------------------ officer decides
  await fp.goto(`${BASE}/officer/decisions`); await fp.getByRole('heading', { name: 'Decisions waiting' }).waitFor(); await fp.getByText(appNo).waitFor(); ok('case is in the officer decision list', true); await scan(fp, 'officer-decisions'); await shot(fp, 'p4-decisions');
  await fp.getByRole('listitem').filter({ hasText: appNo }).getByRole('link', { name: 'Open' }).click(); await fp.getByRole('heading', { name: /Inspection by/ }).waitFor(); await scan(fp, 'officer-case-inspection'); await shot(fp, 'p4-officer-case');
  ok('officer sees the server-computed readings', (await fp.getByRole('table').count()) >= 1);
  await fp.getByRole('button', { name: 'Approve…' }).click(); const dlg = fp.getByRole('dialog', { name: 'Approve and issue certificate' }); await dlg.getByLabel(/Validity in months/).waitFor(); await scan(fp, 'approve-dialog');
  await dlg.getByLabel(/Validity in months/).fill('60'); await dlg.getByLabel(/Validity in months/).evaluate((el) => el.removeAttribute('max')); await dlg.getByRole('button', { name: 'Approve', exact: true }).click(); await reauthIfAsked(fp, OFF_PW, OFF_T);
  await dlg.getByText(/longer than the rules allow/).waitFor({ timeout: 8000 }); ok('validity beyond the rule is refused with a clear message', true);
  await dlg.getByLabel(/Validity in months/).fill('6'); await dlg.getByRole('button', { name: 'Approve', exact: true }).click(); await reauthIfAsked(fp, OFF_PW, OFF_T);
  await fp.getByText(/Approved\. Certificate NRK\/CERT\//).waitFor({ timeout: 20000 }); const certNo = (await fp.getByText(/Approved\. Certificate NRK\/CERT\//).first().innerText()).match(/NRK\/CERT\/[A-Z0-9]+\/\d{4}\/\d{6}/)[0]; ok('officer approved; certificate issued', true, certNo);

  // ------------------------------------------------------------ owner sees it
  await op.goto(appUrl); await op.getByText(/Your certificate is ready/).waitFor(); ok('owner application page links to the certificate', true);
  await op.goto(BASE + '/owner/certificates'); await op.getByText(certNo).waitFor(); await scan(op, 'owner-certificates'); await shot(op, 'p4-owner-certs');
  await op.getByRole('listitem').filter({ hasText: certNo }).getByRole('link', { name: 'Open' }).click(); await op.getByRole('img', { name: /QR code for certificate/ }).waitFor(); const qrUrl = (await op.locator('p.break-all').first().innerText()).trim(); ok('owner sees the certificate and its QR code', /\/v\/NRK-CERT-.*\.[A-Za-z0-9_-]{22}$/.test(qrUrl), qrUrl);
  await scan(op, 'owner-certificate-detail'); await shot(op, 'p4-owner-cert');
  const certId = op.url().split('/').pop(); const pdfLink = (await ocall(`/certificates/${certId}/pdf`)).body; const pdfRes = await oc.request.get(pdfLink.url.startsWith('http') ? pdfLink.url : BASE + pdfLink.url); ok('certificate PDF downloads and is a PDF', pdfRes.ok() && (await pdfRes.body()).slice(0, 5).toString() === '%PDF-', String(pdfRes.status()));
  ok('owner sees no staff actions', (await op.getByRole('button', { name: /Suspend|Revoke/ }).count()) === 0);

  // ------------------------------------------------------------ the public (no sign-in)
  const pc = await phone(); const pp = await pc.newPage(); pages.pp = pp; pp.on('pageerror', (e) => errors.push(e.message));
  await pp.goto(qrUrl); await pp.getByText('This certificate is genuine and in force.').waitFor({ timeout: 10000 }); ok('QR link verifies for anyone', true); ok('QR result states the signature matched', (await pp.getByText('The QR signature matched.').count()) === 1); await scan(pp, 'public-qr-valid-375'); await shot(pp, 'p4-public-valid');
  const pageText = await pp.locator('main').innerText(); ok('public page shows no address, mobile or e-mail', !/Market Road|9000000001|@demo/.test(pageText));
  await pp.goto(qrUrl.slice(0, -3) + 'AAA'); await pp.getByText('This QR code could not be verified.').waitFor({ timeout: 10000 }); ok('a QR with a damaged signature is not verified', true); await scan(pp, 'public-qr-invalid-375');
  await pp.goto(`${BASE}/validate`); await pp.getByLabel('Certificate number').fill(certNo); await pp.getByRole('button', { name: 'Check', exact: true }).click(); await pp.getByText('This certificate is genuine and in force.').waitFor(); ok('typing the number verifies too', true);
  await pp.getByLabel('Certificate number').fill('NRK/CERT/ZZZ/2026/999999'); await pp.getByRole('button', { name: 'Check', exact: true }).click(); await pp.getByText('No certificate found for that number.').waitFor(); ok('an unknown number gives a plain not-found', true); await scan(pp, 'public-validate-notfound-375');
  await pp.goto(`${BASE}/`); await pp.getByLabel('Check a certificate').first().fill(certNo); await pp.getByRole('button', { name: 'Check a certificate' }).click(); await pp.waitForURL(/\/validate\?cert=/); await pp.getByText('This certificate is genuine and in force.').waitFor(); ok('home-page box opens the check page and verifies', true);
  await pp.getByRole('button', { name: 'हिन्दी' }).click().catch(() => {}); await sleep(300); await pp.goto(`${BASE}/validate?cert=${encodeURIComponent(certNo)}`); await pp.getByText(/यह प्रमाणपत्र असली है/).waitFor({ timeout: 8000 }).then(() => ok('Hindi result text', true), () => ok('Hindi result text', false)); await scan(pp, 'public-validate-hindi-375'); await shot(pp, 'p4-public-hindi');
  await pp.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(700); await scan(pp, 'public-validate-dark-hindi-375');

  // ------------------------------------------------------------ officer suspends, public sees it, reinstates
  await fp.goto(`${BASE}/officer/certificates`); await fp.getByText(certNo).waitFor(); await scan(fp, 'officer-certificates'); await fp.getByRole('listitem').filter({ hasText: certNo }).getByRole('link', { name: 'Open' }).click(); await fp.getByRole('heading', { name: 'Actions' }).waitFor(); await scan(fp, 'officer-certificate-detail'); await shot(fp, 'p4-officer-cert');
  ok('integrity check shows a match', (await fp.getByText('Yes', { exact: true }).count()) >= 1);
  await fp.getByRole('button', { name: 'Suspend…' }).click(); const sd = fp.getByRole('dialog', { name: 'Suspend certificate' }); await sd.getByLabel('Internal note (staff only, at least 10 characters)').fill('Complaint being examined internally'); await scan(fp, 'suspend-dialog'); await sd.getByRole('button', { name: 'Suspend', exact: true }).click(); await reauthIfAsked(fp, OFF_PW, OFF_T);
  await fp.getByText('Certificate suspended. The owner has been told.').waitFor({ timeout: 15000 }); ok('officer suspended the certificate', true);
  await pp.evaluate(() => localStorage.setItem('nrk_lang', 'en')); await pp.goto(qrUrl); await pp.getByText('This certificate is not valid right now.').waitFor(); ok('public page now says not valid', true); ok('public reason shows safe text, not the internal note', !(await pp.locator('main').innerText()).includes('Complaint being examined internally'));
  await fp.getByRole('button', { name: 'Reinstate…' }).click(); const rd = fp.getByRole('dialog', { name: 'Reinstate certificate' }); await rd.getByLabel('Internal note (at least 10 characters)').fill('Review closed, certificate stands'); await rd.getByRole('button', { name: 'Confirm' }).click(); await reauthIfAsked(fp, OFF_PW, OFF_T);
  await fp.getByText('Certificate is valid again.').waitFor({ timeout: 15000 }); await pp.goto(qrUrl); await pp.getByText('This certificate is genuine and in force.').waitFor(); ok('reinstated: public page valid again', true);
  await op.goto(BASE + '/owner/notices'); await op.getByText(certNo).first().waitFor({ timeout: 10000 }); ok('owner was notified about the certificate', true);

  // ------------------------------------------------------------ admin
  const ac = await newCtx(); const ap = await ac.newPage(); await loginStaff(ap, '9000000005', ADM_PW, ADM_T, 0); await ap.waitForURL('**/admin/dashboard'); await ap.goto(BASE + '/admin/certificates'); await ap.getByRole('heading', { name: 'Signing key status' }).waitFor(); ok('admin sees signing key status', (await ap.getByText('Active key:').count()) === 1); ok('admin page never prints key material', !/[0-9a-f]{64}/.test((await ap.locator('main').innerText()).replace(/fingerprint [0-9a-f]+/g, ''))); await scan(ap, 'admin-certificates'); await shot(ap, 'p4-admin');
  // owner Hindi + dark on a certificate page
  await op.goto(`${BASE}/owner/certificates/${certId}`); await op.getByRole('button', { name: 'हिन्दी' }).click().catch(() => {}); await op.getByText('प्रमाणपत्र डाउनलोड करें').waitFor({ timeout: 8000 }).then(() => ok('Hindi owner certificate page', true), () => ok('Hindi owner certificate page', false)); await op.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(700); await scan(op, 'owner-certificate-dark-hindi');
  ok('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) { for (const [k, pg] of Object.entries(pages)) { console.log('PAGE', k, pg.url(), (await pg.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 260)); } console.log('SCRIPT ERROR', e.message.split('\n').slice(0, 3).join(' / ')); results.push(['FAIL', 'script', e.message.split('\n')[0]]); }
await browser.close(); const fails = results.filter((r) => r[0] === 'FAIL'); console.log(`\n${results.length - fails.length}/${results.length} passed`); fails.forEach((f) => console.log('FAILED:', f[1], f[2])); process.exit(fails.length ? 1 : 0);
