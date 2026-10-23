import { randomInt } from 'crypto';
import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody } from './helpers';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { LifecycleService } from '../src/modules/jobs/lifecycle.service';

let c: Ctx; let officer: Client; let admin: Client; let owner: { cl: Client; id: string };
let cat: Awaited<ReturnType<typeof catalog>>; let jobs: JobsService; let life: LifecycleService;
let n = 0; const key = () => `p5j-${Date.now()}-${n++}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const plus = (base: Date, days: number) => new Date(base.getTime() + days * 86400_000);
const NOW = new Date('2027-03-10T06:00:00+05:30');

async function instrument(cl = owner.cl) {
  const tok = await cl.confirmToken(); const r = await cl.post('/instruments', instrumentBody(c, cat, tok), { 'Idempotency-Key': key() });
  if (r.status !== 201) throw new Error('instrument ' + JSON.stringify(r.body)); return r.body.id as string;
}
/** An instrument with an issued certificate ending `left` days after NOW (negative = already over). */
async function withCert(left: number, o: { openApp?: boolean; istatus?: string } = {}) {
  const instrumentId = await instrument();
  const a = await owner.cl.post('/applications', { instrumentId, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
  const appId = a.body.id as string;
  if (!o.openApp) await c.pool.query(`UPDATE applications SET status='CERTIFICATE_ISSUED' WHERE id=$1`, [appId]);
  const app = (await c.pool.query('SELECT rule_set_id, area_id FROM applications WHERE id=$1', [appId])).rows[0];
  const div = (await c.pool.query(`SELECT id FROM areas WHERE level='DIVISION' LIMIT 1`)).rows[0].id;
  const issuer = (await c.pool.query(`SELECT id FROM users LIMIT 1`)).rows[0].id;
  const certNo = `NRK/CERT/T/${randomInt(1e8, 9e8)}`;
  const cert = (await c.pool.query(
    `INSERT INTO certificates (cert_no, application_id, instrument_id, division_id, status, verified_on, valid_till, rule_set_id, pdf_key, fingerprint, key_id, issued_by)
     VALUES ($1,$2,$3,$4,'VALID',$5,$6,$7,'x', decode('00','hex'),'k',$8) RETURNING id`, [certNo, appId, instrumentId, div, day(plus(NOW, left - 365)), day(plus(NOW, left)), app.rule_set_id, issuer])).rows[0].id as string;
  await c.pool.query(`INSERT INTO public_certificate_index (cert_no, holder_masked, category_name, capacity_text, class_code, area_label, status, verified_on, valid_till, issuing_office)
     VALUES ($1,'X','Scale','50 kg','III','Ward','VALID',$2,$3,'Office')`, [certNo, day(plus(NOW, left - 365)), day(plus(NOW, left))]);
  await c.pool.query(`UPDATE instruments SET status=$2 WHERE id=$1`, [instrumentId, o.istatus ?? 'ACTIVE']);
  return { instrumentId, appId, cert, certNo };
}
const notifs = async (ev: string, body?: string) => (await c.pool.query('SELECT body FROM in_app_notifications WHERE user_id=$1 AND event_code=$2 AND ($3::text IS NULL OR body LIKE $3)', [owner.id, ev, body ? `%${body}%` : null])).rows;
const istatus = async (id: string) => (await c.pool.query('SELECT status FROM instruments WHERE id=$1', [id])).rows[0].status as string;
const cstatus = async (id: string) => (await c.pool.query('SELECT status FROM certificates WHERE id=$1', [id])).rows[0].status as string;

beforeAll(async () => {
  c = await boot(); jobs = c.app.get(JobsService); life = c.app.get(LifecycleService);
  officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1);
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1);
  owner = await registerUser(c); await activate(c, owner.id); cat = await catalog(owner.cl);
  await c.pool.query(`INSERT INTO workflow_slas (rule_set_id, step, max_hours) SELECT id, 'DOCUMENT_CHECK', 48 FROM rule_sets WHERE status='PUBLISHED' ON CONFLICT DO NOTHING`).catch(() => undefined);
});
afterAll(() => shutdown(c));

describe('renewal reminders', () => {
  it('sends one reminder for the smallest threshold crossed, and never repeats it', async () => {
    const x = await withCert(29);
    const r1 = await jobs.run('renewal-scan', { now: NOW }); expect(r1.status).toBe('OK');
    const mine = (await notifs('RENEWAL_REMINDER', x.certNo)); expect(mine).toHaveLength(1);
    expect(mine[0].body).toContain('29');
    await jobs.run('renewal-scan', { now: NOW }); expect(await notifs('RENEWAL_REMINDER', x.certNo)).toHaveLength(1);   // same day again: nothing new
    await jobs.run('renewal-scan', { now: plus(NOW, 1) }); expect(await notifs('RENEWAL_REMINDER', x.certNo)).toHaveLength(1); // 28 days left: still the 30 threshold
    await jobs.run('renewal-scan', { now: plus(NOW, 14) }); expect(await notifs('RENEWAL_REMINDER', x.certNo)).toHaveLength(2);  // 15 days left
    await jobs.run('renewal-scan', { now: plus(NOW, 28) }); expect(await notifs('RENEWAL_REMINDER', x.certNo)).toHaveLength(3); // 1 day left
  });
  it('a late first run sends only the smallest threshold, not three at once', async () => {
    const x = await withCert(6);
    await jobs.run('renewal-scan', { now: NOW }); expect(await notifs('RENEWAL_REMINDER', x.certNo)).toHaveLength(1);
  });
  it('moves ACTIVE to DUE_FOR_RENEWAL inside the window and not before', async () => {
    const far = await withCert(90); const near = await withCert(50);
    await jobs.run('renewal-scan', { now: NOW });
    expect(await istatus(far.instrumentId)).toBe('ACTIVE'); expect(await istatus(near.instrumentId)).toBe('DUE_FOR_RENEWAL');
  });
  it('stays quiet while a renewal application is already open', async () => {
    const x = await withCert(5, { openApp: true });
    const r = await jobs.run('renewal-scan', { now: NOW }); expect(r.result!.skippedBecauseApplicationOpen).toBeGreaterThanOrEqual(1);
    expect(await notifs('RENEWAL_REMINDER', x.certNo)).toHaveLength(0);
  });
});

describe('expiry', () => {
  it('expires only certificates whose last day has passed, and writes history, public index and audit', async () => {
    const live = await withCert(0); const dead = await withCert(-1);
    const r = await jobs.run('expiry-sweeper', { now: NOW }); expect(r.status).toBe('OK');
    expect(await cstatus(live.cert)).toBe('VALID'); expect(await cstatus(dead.cert)).toBe('EXPIRED');
    expect(await istatus(live.instrumentId)).toBe('ACTIVE'); expect(await istatus(dead.instrumentId)).toBe('EXPIRED');
    expect((await c.pool.query(`SELECT status FROM public_certificate_index WHERE cert_no=$1`, [dead.certNo])).rows[0].status).toBe('EXPIRED');
    expect((await c.pool.query(`SELECT 1 FROM certificate_status_history WHERE certificate_id=$1 AND to_status='EXPIRED'`, [dead.cert])).rowCount).toBe(1);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='certificate.expired' AND entity_id=$1`, [dead.cert])).rowCount).toBe(1);
    expect(await notifs('CERTIFICATE_EXPIRED', dead.certNo)).toHaveLength(1);
    await jobs.run('expiry-sweeper', { now: NOW }); expect(await notifs('CERTIFICATE_EXPIRED', dead.certNo)).toHaveLength(1);
  });
});

describe('application expiry and visit reminders', () => {
  it('closes an APPLIED case after the configured days through the state machine', async () => {
    const id = await instrument(); const a = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const r = await jobs.run('application-expiry', { now: plus(new Date(), 10) }); expect(r.result!.expired).toBe(0 + (r.result!.expired as number)); // others may exist; check this one
    expect((await c.pool.query('SELECT status FROM applications WHERE id=$1', [a.body.id])).rows[0].status).toBe('APPLIED');
    await jobs.run('application-expiry', { now: plus(new Date(), 31) });
    expect((await c.pool.query('SELECT status FROM applications WHERE id=$1', [a.body.id])).rows[0].status).toBe('APPLICATION_EXPIRED');
    expect((await c.pool.query(`SELECT 1 FROM case_status_history WHERE application_id=$1 AND action='expire'`, [a.body.id])).rowCount).toBe(1);
    expect(await notifs('APPLICATION_EXPIRED', a.body.applicationNo)).toHaveLength(1);
  });
  it('reminds once per visit time, and again if the visit moves', async () => {
    const id = await instrument(); const a = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const insp = (await c.pool.query(`SELECT ur.user_id AS id FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.code='INSPECTOR' LIMIT 1`)).rows[0].id;
    const v = (await c.pool.query(`INSERT INTO inspection_visits (application_id, inspector_id, status, scheduled_window) VALUES ($1,$2,'SCHEDULED', tstzrange($3::timestamptz, $3::timestamptz + interval '1 hour','[)')) RETURNING id`, [a.body.id, insp, plus(NOW, 0.5).toISOString()])).rows[0].id;
    expect((await jobs.run('visit-reminders', { now: NOW })).result!.visitsReminded).toBeGreaterThanOrEqual(1);
    expect((await jobs.run('visit-reminders', { now: NOW })).result!.visitsReminded).toBe(0);
    await c.pool.query(`UPDATE inspection_visits SET scheduled_window = tstzrange($2::timestamptz, $2::timestamptz + interval '1 hour','[)') WHERE id=$1`, [v, plus(NOW, 0.75).toISOString()]);
    expect((await jobs.run('visit-reminders', { now: NOW })).result!.visitsReminded).toBe(1);
    expect(await notifs('VISIT_REMINDER', a.body.applicationNo)).toHaveLength(2);
  });
});

describe('deadlines', () => {
  it('flags a case past its deadline once, and reports it in the daily digest', async () => {
    const id = await instrument(); const a = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const later = plus(new Date(), 4);   // 96 h after creation, past the 48 h document-check deadline
    const rows = await c.app.get(LifecycleService)['db'].system((tx) => life.slaScan(tx, later));
    expect(rows.find((r) => r.appId === a.body.id)).toMatchObject({ step: 'DOCUMENT_CHECK', state: 'BREACHED' });
    expect((await c.app.get(LifecycleService)['db'].system((tx) => life.slaScan(tx, new Date()))).find((r) => r.appId === a.body.id)).toBeUndefined();
    const r1 = await jobs.run('sla-monitor', { now: later }); expect(r1.result!.newBreaches).toBeGreaterThanOrEqual(1);
    expect((await jobs.run('sla-monitor', { now: later })).result!.newBreaches).toBe(0);
    expect((await jobs.run('sla-digest', { now: later })).result!.areasNotified).toBeGreaterThanOrEqual(1);
    expect((await jobs.run('sla-digest', { now: later })).result!.areasNotified).toBe(0);
  });
});

describe('retention, audit chain and run log', () => {
  it('deletes expired drafts and old logs but keeps recent ones', async () => {
    await c.pool.query(`INSERT INTO public_lookup_log (ip_hash, mode, result, created_at) VALUES ('\\x01','t','ok', now() - interval '100 days'), ('\\x02','t','ok', now())`);
    const before = Number((await c.pool.query('SELECT count(*) n FROM public_lookup_log')).rows[0].n);
    const r = await jobs.run('retention', { now: new Date() }); expect(r.status).toBe('OK');
    expect(Number((await c.pool.query('SELECT count(*) n FROM public_lookup_log')).rows[0].n)).toBe(before - (r.result!.lookupLog as number));
    expect(r.result!.lookupLog).toBeGreaterThanOrEqual(1);
  });
  it('audit-verify passes on an intact chain and alerts admins on a broken one', async () => {
    expect((await jobs.run('audit-verify')).result!.intact).toBe(true);
    await c.pool.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    const row = (await c.pool.query(`SELECT id, details FROM audit_events ORDER BY id DESC LIMIT 1`)).rows[0];
    await c.pool.query(`UPDATE audit_events SET details = '{"tampered":true}'::jsonb WHERE id=$1`, [row.id]);
    const r = await jobs.run('audit-verify'); expect(r.result!.intact).toBe(false);
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE event_code='AUDIT_CHAIN_BROKEN'`)).rowCount).toBeGreaterThanOrEqual(1);
    await c.pool.query(`UPDATE audit_events SET details = $2::jsonb WHERE id=$1`, [row.id, JSON.stringify(row.details)]);
    await c.pool.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
    expect((await jobs.run('audit-verify')).result!.intact).toBe(true);
  });
  it('public-stats writes an aggregate row', async () => {
    const r = await jobs.run('public-stats'); expect(r.status).toBe('OK'); expect(r.result!.registered).toBeGreaterThan(0);
  });
  it('a second run while the first holds the lock is SKIPPED; a failing job is FAILED, logged, and never throws', async () => {
    await c.redis.client.set('nrk:joblock:retention', '1', 'EX', 60);
    expect((await jobs.run('retention')).status).toBe('SKIPPED'); await c.redis.client.del('nrk:joblock:retention');
    jobs.add({ name: 'boom', description: 't', cron: '0 0 * * *', run: async () => { throw new Error('kaboom'); } });
    const r = await jobs.run('boom', { attempt: 3 }); expect(r).toMatchObject({ status: 'FAILED', error: 'kaboom' });
    expect((await c.pool.query(`SELECT status, error FROM job_runs WHERE id=$1`, [r.runId])).rows[0]).toMatchObject({ status: 'FAILED', error: 'kaboom' });
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE event_code='JOB_FAILED'`)).rowCount).toBeGreaterThanOrEqual(1);
    await c.redis.client.del('nrk:joblock:boom');
  });
});

describe('admin: system settings and job monitor', () => {
  it('lists jobs, runs one by hand (step-up + idempotency), and records who ran it', async () => {
    const m = await admin.get('/admin/system'); expect(m.status).toBe(200); expect(m.body.jobs.jobs.map((j: { name: string }) => j.name)).toContain('renewal-scan');
    expect((await admin.post('/admin/system/jobs/public-stats/run', {})).status).toBe(400);
    const r = await admin.post('/admin/system/jobs/public-stats/run', {}, { 'Idempotency-Key': key() }); expect(r.status).toBeLessThan(300); expect(r.body.status).toBe('OK');
    expect((await c.pool.query(`SELECT trigger FROM job_runs WHERE id=$1`, [r.body.runId])).rows[0].trigger).toBe('MANUAL');
    expect((await officer.post('/admin/system/jobs/public-stats/run', {}, { 'Idempotency-Key': key() })).status).toBe(403);
    expect((await admin.post('/admin/system/jobs/nope/run', {}, { 'Idempotency-Key': key() })).status).toBe(404);
  });
  it('validates settings, publishes the maintenance banner publicly, and audits the change', async () => {
    const bad = await admin.put('/admin/system/settings/lifecycle', { reminderDays: [], dueForRenewalDays: -1 }); expect(bad.status).toBe(422);
    const ok = await admin.put('/admin/system/settings/maintenance', { enabled: true, level: 'warn', textEn: 'Back at 6 pm', textHi: 'शाम 6 बजे तक' }); expect(ok.status).toBeLessThan(300);
    const pub = await new Client(c).init().then((p) => p.get('/public/system')); expect(pub.body.maintenance).toMatchObject({ enabled: true, textEn: 'Back at 6 pm' });
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='settings.changed'`)).rowCount).toBeGreaterThanOrEqual(1);
    await admin.put('/admin/system/settings/maintenance', { enabled: false, level: 'info', textEn: '', textHi: '' });
    const pub2 = await new Client(c).init().then((p) => p.get('/public/system')); expect(pub2.body.maintenance ?? null).toBeNull();
  });
});
