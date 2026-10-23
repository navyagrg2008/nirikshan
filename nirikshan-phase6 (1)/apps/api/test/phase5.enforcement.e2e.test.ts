import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody } from './helpers';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { CaptchaService } from '../src/infra/providers';

let c: Ctx; let officer: Client; let senior: Client; let admin: Client; let anon: Client;
let owner: { cl: Client; id: string }; let other: { cl: Client; id: string };
let cat: Awaited<ReturnType<typeof catalog>>; let n = 0; const key = () => `p5e-${Date.now()}-${n++}`;
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const EICAR = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);

async function expiredInstrument() {
  const tok = await owner.cl.confirmToken(); const r = await owner.cl.post('/instruments', instrumentBody(c, cat, tok), { 'Idempotency-Key': key() });
  await c.pool.query(`UPDATE instruments SET status='EXPIRED', first_verified_at=now() - interval '400 days' WHERE id=$1`, [r.body.id]); return r.body.id as string;
}
const setFlag = (k: string, v: boolean) => c.pool.query(`UPDATE app_settings SET value = value || jsonb_build_object($1::text, $2::boolean) WHERE key='flags'`, [k, v]).then(() => c.redis.client.del('cache:public-system'));

beforeAll(async () => {
  c = await boot();
  officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1);
  senior = await new Client(c).init(); await senior.loginStaff(c.demo.SENIOR_OFFICER!, -1);
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1); anon = await new Client(c).init();
  owner = await registerUser(c); await activate(c, owner.id); other = await registerUser(c); await activate(c, other.id); cat = await catalog(owner.cl);
});
afterAll(() => shutdown(c));

describe('enforcement drives', () => {
  it('lists expired instruments, builds a drive, sends notices once, prints letters and tracks progress', async () => {
    const a = await expiredInstrument(); const b = await expiredInstrument();
    const list = await officer.get('/officer/enforcement/expired'); expect(list.status).toBe(200);
    expect(list.body.items.map((x: { instrumentId: string }) => x.instrumentId)).toEqual(expect.arrayContaining([a, b]));
    expect((await owner.cl.get('/officer/enforcement/expired')).status).toBe(403);
    const areaId = list.body.items.find((x: { instrumentId: string }) => x.instrumentId === a).areaId;
    expect((await officer.post('/officer/enforcement/drives', { name: 'Ward 1 sweep', areaId, instrumentIds: [a, b] })).status).toBe(400);
    const d = await officer.post('/officer/enforcement/drives', { name: 'Ward 1 sweep', areaId, instrumentIds: [a, b] }, { 'Idempotency-Key': key() }); expect(d.status).toBe(201);
    // already in a running drive, so no longer on the expired list and cannot be added again
    expect((await officer.get('/officer/enforcement/expired')).body.items.map((x: { instrumentId: string }) => x.instrumentId)).not.toContain(a);
    expect((await officer.post('/officer/enforcement/drives', { name: 'Again', areaId, instrumentIds: [a] }, { 'Idempotency-Key': key() })).status).toBe(422);
    const draft = await officer.agent.get(`/api/v1/officer/enforcement/drives/${d.body.id}/notices.pdf`).set('X-Forwarded-For', officer.ip); expect(draft.status).toBe(200); expect(draft.headers['content-type']).toContain('application/pdf');
    const sent = await officer.post(`/officer/enforcement/drives/${d.body.id}/notices`, {}, { 'Idempotency-Key': key() }); expect(sent.body.sent).toBe(2);
    expect((await officer.post(`/officer/enforcement/drives/${d.body.id}/notices`, {}, { 'Idempotency-Key': key() })).body.sent).toBe(0);
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE user_id=$1 AND event_code='ENFORCEMENT_NOTICE'`, [owner.id])).rowCount).toBe(2);
    let det = await officer.get(`/officer/enforcement/drives/${d.body.id}`); expect(det.body.status).toBe('NOTICES_SENT');
    expect(det.body.items.every((x: { stage: string; noticeNo: string }) => x.stage === 'NOTIFIED' && /^ENF\/\d{4}\/\d{6}$/.test(x.noticeNo))).toBe(true);
    // owner applies for one and gets a certificate for the other
    await owner.cl.post('/applications', { instrumentId: a, type: 'RE_VERIFICATION', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const app = (await c.pool.query(`SELECT id, rule_set_id FROM applications WHERE instrument_id=$1`, [a])).rows[0];
    expect(app).toBeTruthy();
    const ap2 = await owner.cl.post('/applications', { instrumentId: b, type: 'RE_VERIFICATION', declarationAccepted: true }, { 'Idempotency-Key': key() });
    await c.pool.query(`UPDATE applications SET status='CERTIFICATE_ISSUED' WHERE id=$1`, [ap2.body.id]);
    const div = (await c.pool.query(`SELECT id FROM areas WHERE level='DIVISION' LIMIT 1`)).rows[0].id; const iss = (await c.pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await c.pool.query(`INSERT INTO certificates (cert_no, application_id, instrument_id, division_id, verified_on, valid_till, rule_set_id, pdf_key, fingerprint, key_id, issued_by) VALUES ($1,$2,$3,$4,current_date,current_date+300,$5,'x',decode('00','hex'),'k',$6)`, [`NRK/CERT/E/${Date.now()}`, ap2.body.id, b, div, app.rule_set_id, iss]);
    const r = await c.app.get(JobsService).run('enforcement-sync'); expect(r.status).toBe('OK');
    det = await officer.get(`/officer/enforcement/drives/${d.body.id}`);
    expect(Object.fromEntries(det.body.items.map((x: { instrumentId: string; stage: string }) => [x.instrumentId, x.stage]))).toEqual({ [a]: 'APPLIED', [b]: 'VERIFIED' });
    expect(det.body.status).toBe('IN_PROGRESS');
    const ds = await officer.get('/officer/enforcement/drives'); expect(ds.body.items.find((x: { id: string }) => x.id === d.body.id).stages).toMatchObject({ APPLIED: 1, VERIFIED: 1 });
    expect((await officer.post(`/officer/enforcement/drives/${d.body.id}/escalate`, { instrumentId: a }, { 'Idempotency-Key': key() })).status).toBe(409);   // already applied
    expect((await officer.post(`/officer/enforcement/drives/${d.body.id}/close`, {}, { 'Idempotency-Key': key() })).status).toBe(200);
    expect((await officer.post(`/officer/enforcement/drives/${d.body.id}/notices`, {}, { 'Idempotency-Key': key() })).status).toBe(409);
  });
  it('escalates an owner who ignores the notice', async () => {
    const a = await expiredInstrument(); const areaId = (await officer.get('/officer/enforcement/expired')).body.items.find((x: { instrumentId: string }) => x.instrumentId === a).areaId;
    const d = await officer.post('/officer/enforcement/drives', { name: 'Escalation', areaId, instrumentIds: [a] }, { 'Idempotency-Key': key() });
    await officer.post(`/officer/enforcement/drives/${d.body.id}/notices`, {}, { 'Idempotency-Key': key() });
    expect((await officer.post(`/officer/enforcement/drives/${d.body.id}/escalate`, { instrumentId: a }, { 'Idempotency-Key': key() })).status).toBe(200);
    expect((await officer.get(`/officer/enforcement/drives/${d.body.id}`)).body.items[0].stage).toBe('ESCALATED');
  });
});

describe('grievances', () => {
  it('owner raises, officer sees it with a deadline, responds, owner is told; strangers see nothing', async () => {
    const g = await owner.cl.post('/grievances', { subject: 'Visit was missed', body: 'The inspector never arrived at the shop.' }, { 'Idempotency-Key': key() }); expect(g.status).toBe(201);
    expect(g.body.ref).toMatch(/^GRV-\d{4}-\d{5}$/); expect(new Date(g.body.replyBy).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect((await other.cl.get('/grievances')).body.items).toHaveLength(0);
    const q = await officer.get('/officer/grievances'); expect(q.body.items.find((x: { id: string }) => x.id === g.body.id)).toMatchObject({ status: 'OPEN', overdue: false });
    expect((await owner.cl.get('/officer/grievances')).status).toBe(403);
    expect((await officer.post(`/officer/grievances/${g.body.id}/respond`, { status: 'CLOSED', response: 'x' }, { 'Idempotency-Key': key() })).status).toBe(422);
    expect((await officer.post(`/officer/grievances/${g.body.id}/respond`, { status: 'CLOSED', response: 'Visit has been rescheduled.' }, { 'Idempotency-Key': key() })).status).toBe(200);
    expect((await owner.cl.get('/grievances')).body.items[0]).toMatchObject({ status: 'CLOSED', response: 'Visit has been rescheduled.' });
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE user_id=$1 AND event_code='GRIEVANCE_UPDATED'`, [owner.id])).rowCount).toBe(1);
    expect((await officer.post(`/officer/grievances/${g.body.id}/respond`, { status: 'IN_PROGRESS', response: 'reopen please' }, { 'Idempotency-Key': key() })).status).toBe(409);
    await c.pool.query(`UPDATE grievances SET due_at = now() - interval '1 day' WHERE id=$1`, [g.body.id]);
  });
  it('shows overdue grievances first', async () => {
    const g = await owner.cl.post('/grievances', { subject: 'Wrong certificate date', body: 'The validity on my certificate is wrong.' }, { 'Idempotency-Key': key() });
    await c.pool.query(`UPDATE grievances SET due_at = now() - interval '1 hour' WHERE id=$1`, [g.body.id]);
    expect((await officer.get('/officer/grievances')).body.items[0]).toMatchObject({ id: g.body.id, overdue: true });
  });
});

describe('tamper reports and the public directory', () => {
  it('anyone can report with a captcha; the reporter gets a reference; officers see it with the photo; a bad photo is refused', async () => {
    const post = (b: object, file?: Buffer) => { let r = anon.agent.post('/api/v1/public/tamper-reports').set('X-Forwarded-For', '10.9.9.' + (n++ % 200 + 1)).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', anon.csrf); for (const [k, v] of Object.entries(b)) r = r.field(k, String(v)); return file ? r.attach('photo', file, { filename: 'p.jpg' }) : r; };
    const spy = jest.spyOn(c.app.get(CaptchaService), 'verify').mockResolvedValue(false);
    expect((await post({ description: 'The seal on this scale looks cut open.' })).status).toBe(403); spy.mockResolvedValue(true);
    expect((await post({ description: 'short' })).status).toBe(422);
    expect((await post({ description: 'The seal on this scale looks cut open.' }, EICAR)).status).toBe(422);
    expect((await post({ description: 'The seal on this scale looks cut open.' }, Buffer.from('not an image at all'))).status).toBe(422);
    const t = await post({ description: 'The seal on this scale looks cut open.', contact: '9876500000' }, JPG); expect(t.status).toBe(201); expect(t.body.ref).toMatch(/^TMP-\d{4}-\d{5}$/);
    const st = await anon.get(`/public/tamper-reports/${t.body.ref}`); expect(st.body).toMatchObject({ status: 'RECEIVED' }); expect(JSON.stringify(st.body)).not.toContain('seal');
    const row = (await c.pool.query('SELECT contact_enc FROM tamper_reports WHERE ref_no=$1', [t.body.ref])).rows[0]; expect(Buffer.from(row.contact_enc).includes(Buffer.from('9876500000'))).toBe(false);
    // unassigned (no certificate given) goes to admins
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE event_code='TAMPER_REPORT_RECEIVED'`)).rowCount).toBeGreaterThanOrEqual(1);
    const aq = await admin.get('/officer/tamper-reports'); const item = aq.body.items.find((x: { ref: string }) => x.ref === t.body.ref);
    expect(item).toMatchObject({ contact: '9876500000', status: 'OPEN' }); expect(item.photoUrl).toBeTruthy();
    expect((await admin.post(`/officer/tamper-reports/${item.id}/resolve`, { status: 'CLOSED', resolution: 'Inspector visited, seal replaced.' }, { 'Idempotency-Key': key() })).status).toBe(200);
    expect((await anon.get(`/public/tamper-reports/${t.body.ref}`)).body.status).toBe('CLOSED');
    spy.mockRestore();
  });
  it('a report that names a certificate goes to the officers of that area', async () => {
    const a = await expiredInstrument(); const ap = await owner.cl.post('/applications', { instrumentId: a, type: 'RE_VERIFICATION', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const rs = (await c.pool.query('SELECT rule_set_id FROM applications WHERE id=$1', [ap.body.id])).rows[0].rule_set_id; const div = (await c.pool.query(`SELECT id FROM areas WHERE level='DIVISION' LIMIT 1`)).rows[0].id; const iss = (await c.pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    const no = `NRK/CERT/T/${Date.now()}`; await c.pool.query(`INSERT INTO certificates (cert_no, application_id, instrument_id, division_id, verified_on, valid_till, rule_set_id, pdf_key, fingerprint, key_id, issued_by) VALUES ($1,$2,$3,$4,current_date,current_date+300,$5,'x',decode('00','hex'),'k',$6)`, [no, ap.body.id, a, div, rs, iss]);
    jest.spyOn(c.app.get(CaptchaService), 'verify').mockResolvedValue(true);
    const r = await anon.agent.post('/api/v1/public/tamper-reports').set('X-Forwarded-For', '10.9.8.1').set('Origin', 'http://localhost:3000').set('X-CSRF-Token', anon.csrf).field('description', 'Sticker on this instrument looks forged.').field('certNo', no);
    expect(r.status).toBe(201);
    const q = await officer.get('/officer/tamper-reports'); expect(q.body.items.map((x: { ref: string }) => x.ref)).toContain(r.body.ref);
    expect((await owner.cl.get('/officer/tamper-reports')).status).toBe(403);
    // A report with no certificate number has no area, but an officer must still be able to see it and close it.
    const loose = await anon.agent.post('/api/v1/public/tamper-reports').set('X-Forwarded-For', '10.9.8.2').set('Origin', 'http://localhost:3000').set('X-CSRF-Token', anon.csrf).field('description', 'A shop near the bus stand seems to use an unmarked scale.');
    expect(loose.status).toBe(201);
    const lq = await officer.get('/officer/tamper-reports'); const li = lq.body.items.find((x: { ref: string }) => x.ref === loose.body.ref); expect(li).toBeTruthy();
    expect((await officer.post(`/officer/tamper-reports/${li.id}/resolve`, { status: 'CLOSED', resolution: 'Shop visited and warned.' }, { 'Idempotency-Key': key() })).status).toBe(200);
    jest.restoreAllMocks();
  });
  it('the directory shows masked data only, needs a filter, and can be switched off', async () => {
    const no = `NRK/CERT/S/${Date.now()}`; const a = await expiredInstrument();
    const ap = await owner.cl.post('/applications', { instrumentId: a, type: 'RE_VERIFICATION', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const rs = (await c.pool.query('SELECT rule_set_id FROM applications WHERE id=$1', [ap.body.id])).rows[0].rule_set_id; const div = (await c.pool.query(`SELECT id FROM areas WHERE level='DIVISION' LIMIT 1`)).rows[0].id; const iss = (await c.pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    await c.pool.query(`INSERT INTO certificates (cert_no, application_id, instrument_id, division_id, verified_on, valid_till, rule_set_id, pdf_key, fingerprint, key_id, issued_by) VALUES ($1,$2,$3,$4,current_date - 400,current_date - 35,$5,'x',decode('00','hex'),'k',$6)`, [no, ap.body.id, a, div, rs, iss]);
    await c.pool.query(`INSERT INTO public_certificate_index (cert_no, holder_masked, category_name, capacity_text, class_code, area_label, status, verified_on, valid_till, issuing_office) VALUES ($1,'M/s ****** Store','Platform Scale','50 kg','III','Ward 1','VALID',current_date-400,current_date-35,'Office')`, [no]);
    expect((await anon.get('/public/search')).status).toBe(422);
    const r = await anon.get(`/public/search?q=${encodeURIComponent(no.slice(0, 18))}`); expect(r.status).toBe(200);
    const hit = r.body.items.find((x: { certNo: string }) => x.certNo === no); expect(hit).toMatchObject({ holder: 'M/s ****** Store', status: 'EXPIRED' });   // VALID in the index but past its date
    expect(Object.keys(hit).sort()).toEqual(['accuracyClass', 'area', 'capacity', 'category', 'certNo', 'holder', 'status', 'validTill']);
    expect((await anon.get('/public/search?status=EXPIRED')).body.items.some((x: { certNo: string }) => x.certNo === no)).toBe(true);
    expect((await anon.get('/public/search?q=%25')).body.items).toHaveLength(0);          // wildcard is not a wildcard
    await setFlag('publicSearch', false); expect((await anon.get(`/public/search?q=NRK`)).status).toBe(503); await setFlag('publicSearch', true);
    await setFlag('tamperReports', false);
    expect((await anon.agent.post('/api/v1/public/tamper-reports').set('X-Forwarded-For', '10.9.7.1').set('Origin', 'http://localhost:3000').set('X-CSRF-Token', anon.csrf).field('description', 'This should be refused now.')).status).toBe(503);
    await setFlag('tamperReports', true);
  });
});
