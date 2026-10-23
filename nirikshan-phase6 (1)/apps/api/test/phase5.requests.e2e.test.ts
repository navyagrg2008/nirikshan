import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody } from './helpers';

let c: Ctx; let officer: Client; let officer2: Client; let admin: Client;
let owner: { cl: Client; id: string; mobile: string }; let buyer: { cl: Client; id: string; mobile: string }; let trader: { cl: Client; id: string; mobile: string };
let cat: Awaited<ReturnType<typeof catalog>>; let n = 0; const key = () => `p5r-${Date.now()}-${n++}`;

async function instrument(cl: Client, over: Record<string, unknown> = {}) {
  const tok = await cl.confirmToken(); const r = await cl.post('/instruments', instrumentBody(c, cat, tok, over), { 'Idempotency-Key': key() });
  if (r.status !== 201) throw new Error('instrument ' + JSON.stringify(r.body)); return r.body.id as string;
}
const ask = (cl: Client, id: string, body: object) => cl.post(`/instruments/${id}/requests`, body, { 'Idempotency-Key': key() });
const decide = (cl: Client, id: string, body: object) => cl.post(`/officer/requests/${id}/decision`, body, { 'Idempotency-Key': key() });
const bizOf = async (userId: string) => (await c.pool.query('SELECT id FROM businesses WHERE owner_user_id=$1', [userId])).rows[0].id as string;
const row = async (id: string) => (await c.pool.query('SELECT * FROM instruments WHERE id=$1', [id])).rows[0];

beforeAll(async () => {
  c = await boot();
  officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1);
  officer2 = await new Client(c).init(); await officer2.loginStaff(c.demo.OFFICER2!, -1);
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1);
  owner = await registerUser(c); await activate(c, owner.id); buyer = await registerUser(c); await activate(c, buyer.id);
  trader = await registerUser(c, { businessType: 'REPAIRER' }); await activate(c, trader.id);
  cat = await catalog(owner.cl);
});
afterAll(() => shutdown(c));

describe('transfer', () => {
  it('moves the instrument to the buyer only after an officer approves, with an ownership trail', async () => {
    const id = await instrument(owner.cl);
    expect((await owner.cl.post(`/instruments/${id}/requests`, { kind: 'TRANSFER', toMobile: buyer.mobile })).status).toBe(400);   // idempotency key required
    expect((await ask(owner.cl, id, { kind: 'TRANSFER', toMobile: '9000099999' })).status).toBe(422);                              // unknown recipient
    expect((await ask(owner.cl, id, { kind: 'TRANSFER', toMobile: owner.mobile })).status).toBe(422);                              // to yourself
    const r = await ask(owner.cl, id, { kind: 'TRANSFER', toMobile: buyer.mobile, note: 'Sold on 12 Oct' }); expect(r.status).toBe(201);
    expect((await row(id)).business_id).toBe(await bizOf(owner.id));            // nothing moved yet
    expect((await ask(owner.cl, id, { kind: 'DEREGISTER', reasonCode: 'SCRAPPED' })).status).toBe(409);   // one open request at a time
    expect((await buyer.cl.get(`/instruments/${id}`)).status).toBe(404);
    const q = await officer.get('/officer/requests?kind=TRANSFER'); expect(q.status).toBe(200);
    expect(q.body.items.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ kind: 'TRANSFER', status: 'OPEN' });
    const d = await officer.get(`/officer/requests/${r.body.id}`); expect(d.body).toMatchObject({ kind: 'TRANSFER', note: 'Sold on 12 Oct' });
    expect((await decide(officer, r.body.id, { outcome: 'REJECTED' })).status).toBe(422);                                         // remark required on reject
    expect((await owner.cl.post(`/officer/requests/${r.body.id}/decision`, { outcome: 'APPROVED' }, { 'Idempotency-Key': key() })).status).toBe(403);
    const ok = await decide(officer, r.body.id, { outcome: 'APPROVED' }); expect(ok.status).toBe(200);
    expect((await row(id)).business_id).toBe(await bizOf(buyer.id));
    expect((await buyer.cl.get(`/instruments/${id}`)).status).toBe(200); expect((await owner.cl.get(`/instruments/${id}`)).status).toBe(404);
    expect((await c.pool.query('SELECT 1 FROM instrument_ownership_history WHERE instrument_id=$1', [id])).rowCount).toBe(1);
    expect((await decide(officer, r.body.id, { outcome: 'APPROVED' })).status).toBe(409);                                         // already decided
    const h = await buyer.cl.get(`/instruments/${id}/history`); expect(h.body.ownership).toHaveLength(1);
    for (const [u, ev] of [[owner.id, 'REQUEST_DECIDED'], [buyer.id, 'TRANSFER_INCOMING']] as const)
      expect((await c.pool.query('SELECT 1 FROM in_app_notifications WHERE user_id=$1 AND event_code=$2', [u, ev])).rowCount).toBeGreaterThanOrEqual(1);
  });
  it('a rejection changes nothing and the owner can ask again', async () => {
    const id = await instrument(owner.cl);
    const r = await ask(owner.cl, id, { kind: 'TRANSFER', toMobile: buyer.mobile });
    expect((await decide(officer, r.body.id, { outcome: 'REJECTED', remark: 'Sale papers missing' })).status).toBe(200);
    expect((await row(id)).business_id).toBe(await bizOf(owner.id));
    expect((await ask(owner.cl, id, { kind: 'TRANSFER', toMobile: buyer.mobile })).status).toBe(201);
    const list = await owner.cl.get(`/instruments/${id}/requests`); expect(list.body.items.map((x: { status: string }) => x.status)).toEqual(['OPEN', 'REJECTED']);
    expect(list.body.items[1].remark).toBe('Sale papers missing');
  });
  it('the owner can withdraw an open request; another user cannot', async () => {
    const id = await instrument(owner.cl); const r = await ask(owner.cl, id, { kind: 'DEREGISTER', reasonCode: 'NO_LONGER_IN_USE' });
    expect((await buyer.cl.post(`/requests/${r.body.id}/withdraw`)).status).toBe(404);
    expect((await owner.cl.post(`/requests/${r.body.id}/withdraw`)).status).toBe(200);
    expect((await decide(officer, r.body.id, { outcome: 'APPROVED' })).status).toBe(409);
  });
  it('is refused while an application is open', async () => {
    const id = await instrument(owner.cl);
    await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    expect((await ask(owner.cl, id, { kind: 'DEREGISTER', reasonCode: 'SCRAPPED' })).body.code ?? '').toMatch(/OPEN_APPLICATION_EXISTS/);
  });
});

describe('change of address and de-registration', () => {
  it('address change applies the new address and area after approval', async () => {
    const id = await instrument(owner.cl); const ward2 = c.wards[1]!;
    const r = await ask(owner.cl, id, { kind: 'ADDRESS_CHANGE', address: '44 New Road, Sector 9', areaId: ward2 }); expect(r.status).toBe(201);
    expect((await row(id)).area_id).toBe(c.wards[0]);
    expect((await ask(owner.cl, id, { kind: 'ADDRESS_CHANGE', address: 'x', areaId: ward2 })).status).toBe(422);
    const d = await officer.get(`/officer/requests/${r.body.id}`); expect(d.body.newAddress).toBe('44 New Road, Sector 9');
    await decide(officer, r.body.id, { outcome: 'APPROVED' });
    expect((await row(id)).area_id).toBe(ward2);
    const g = await owner.cl.get(`/instruments/${id}`); expect(g.body.address).toContain('44 New Road');
  });
  it('de-registration closes the instrument and revokes its valid certificate in the public index', async () => {
    const id = await instrument(owner.cl);
    const a = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    await c.pool.query(`UPDATE applications SET status='CERTIFICATE_ISSUED' WHERE id=$1`, [a.body.id]);
    const ap = (await c.pool.query('SELECT rule_set_id FROM applications WHERE id=$1', [a.body.id])).rows[0];
    const div = (await c.pool.query(`SELECT id FROM areas WHERE level='DIVISION' LIMIT 1`)).rows[0].id; const iss = (await c.pool.query('SELECT id FROM users LIMIT 1')).rows[0].id;
    const no = `NRK/CERT/T/${Date.now()}`;
    const cert = (await c.pool.query(`INSERT INTO certificates (cert_no, application_id, instrument_id, division_id, verified_on, valid_till, rule_set_id, pdf_key, fingerprint, key_id, issued_by) VALUES ($1,$2,$3,$4,current_date - 10,current_date + 300,$5,'x',decode('00','hex'),'k',$6) RETURNING id`, [no, a.body.id, id, div, ap.rule_set_id, iss])).rows[0].id;
    await c.pool.query(`INSERT INTO public_certificate_index (cert_no, holder_masked, category_name, capacity_text, class_code, area_label, status, verified_on, valid_till, issuing_office) VALUES ($1,'X','S','1','III','W','VALID',current_date-10,current_date+300,'O')`, [no]);
    const r = await ask(owner.cl, id, { kind: 'DEREGISTER', reasonCode: 'SCRAPPED', note: 'Broken' });
    expect((await officer2.get(`/officer/requests/${r.body.id}`)).status).toBeLessThan(500);
    await decide(officer, r.body.id, { outcome: 'APPROVED' });
    expect((await row(id)).status).toBe('DEREGISTERED');
    expect((await c.pool.query('SELECT status FROM certificates WHERE id=$1', [cert])).rows[0].status).toBe('REVOKED');
    expect((await c.pool.query('SELECT status FROM public_certificate_index WHERE cert_no=$1', [no])).rows[0].status).toBe('REVOKED');
    expect((await ask(owner.cl, id, { kind: 'TRANSFER', toMobile: buyer.mobile })).status).toBe(409);
  });
});

describe('repair jobs', () => {
  it('walks REPORTED to READY_FOR_VERIFICATION in order and then opens a re-verification case', async () => {
    const id = await instrument(trader.cl, { ownership: { mode: 'SELF' } });
    await c.pool.query(`UPDATE instruments SET first_verified_at=now(), status='ACTIVE' WHERE id=$1`, [id]);
    const j = await trader.cl.post('/service-jobs', { instrumentId: id, issue: 'Display flickers' }, { 'Idempotency-Key': key() }); expect(j.status).toBe(201);
    expect((await trader.cl.post('/service-jobs', { instrumentId: id, issue: 'again' }, { 'Idempotency-Key': key() })).status).toBe(409);
    const adv = (to: string, extra: object = {}) => trader.cl.post(`/service-jobs/${j.body.id}/advance`, { to, ...extra }, { 'Idempotency-Key': key() });
    expect((await adv('REPAIRED')).status).toBe(409);                      // cannot skip
    expect((await adv('TECHNICIAN_ASSIGNED')).status).toBe(422);          // technician name needed
    expect((await adv('TECHNICIAN_ASSIGNED', { technicianName: 'R. Kumar' })).status).toBe(200);
    expect((await adv('REPAIRED', { notes: 'Replaced board' })).status).toBe(200);
    const fin = await adv('READY_FOR_VERIFICATION'); expect(fin.status).toBe(200); expect(fin.body.applicationId).toBeTruthy();
    const list = await trader.cl.get('/service-jobs'); expect(list.body.items[0]).toMatchObject({ stage: 'READY_FOR_VERIFICATION', applicationId: fin.body.applicationId });
    expect((await owner.cl.get('/service-jobs')).status).toBe(403);
    expect((await owner.cl.post(`/service-jobs/${j.body.id}/advance`, { to: 'REPAIRED' }, { 'Idempotency-Key': key() })).status).toBe(403);
  });
});

describe('feature flags', () => {
  it('bulk registration can be switched off', async () => {
    await c.pool.query(`UPDATE app_settings SET value = value || '{"bulkRegister": false}'::jsonb WHERE key='flags'`);
    const r = await trader.cl.agent.post('/api/v1/instruments/bulk').set('X-Forwarded-For', trader.cl.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', trader.cl.csrf).attach('file', Buffer.from('a,b\n'), { filename: 'x.csv' });
    await c.pool.query(`UPDATE app_settings SET value = value || '{"bulkRegister": true}'::jsonb WHERE key='flags'`);
    expect(r.status).toBe(503);
  });
});
