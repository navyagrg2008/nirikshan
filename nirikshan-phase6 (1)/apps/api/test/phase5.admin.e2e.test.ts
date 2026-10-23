import { boot, shutdown, Client, Ctx, registerUser, registerBody, activate, catalog, instrumentBody, randomMobile, API } from './helpers';

let c: Ctx; let admin: Client; let officer: Client; let anon: Client;
let cat: Awaited<ReturnType<typeof catalog>>; let n = 0; const key = () => `p5a-${Date.now()}-${n++}`;
const setFlag = (k: string, v: boolean) => c.pool.query(`UPDATE app_settings SET value = value || jsonb_build_object($1::text, $2::boolean) WHERE key='flags'`, [k, v]).then(() => c.redis.client.del('cache:public-system'));
const resolve = (id: string, body: object) => admin.post(`/admin/privacy/requests/${id}/resolve`, body, { 'Idempotency-Key': key() });
async function person() { const u = await registerUser(c); await activate(c, u.id); return u; }
async function inst(cl: Client) { const tok = await cl.confirmToken(); const r = await cl.post('/instruments', instrumentBody(c, cat, tok), { 'Idempotency-Key': key() }); return r.body.id as string; }

beforeAll(async () => {
  c = await boot();
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1); officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1); anon = await new Client(c).init();
  cat = await catalog((await person()).cl);
});
afterAll(() => shutdown(c));

describe('data-subject requests', () => {
  it('access: the person asks, an admin fulfils, the person downloads a file with their own data', async () => {
    const u = await person(); await inst(u.cl);
    expect((await u.cl.post('/me/data-requests', { kind: 'CORRECTION' }, { 'Idempotency-Key': key() })).status).toBe(422);   // correction must say what
    const r = await u.cl.post('/me/data-requests', { kind: 'ACCESS' }, { 'Idempotency-Key': key() }); expect(r.status).toBe(201); expect(r.body.ref).toMatch(/^DSR-\d{4}-\d{5}$/);
    expect((await u.cl.post('/me/data-requests', { kind: 'ACCESS' }, { 'Idempotency-Key': key() })).status).toBe(409);
    expect((await u.cl.get(`/me/data-requests/${r.body.id}/download`)).status).toBe(404);                       // nothing to download yet
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE event_code='DSR_RECEIVED'`)).rowCount).toBeGreaterThanOrEqual(1);
    const q = await admin.get('/admin/privacy/requests'); const row = q.body.items.find((x: { id: string }) => x.id === r.body.id); expect(row).toMatchObject({ kind: 'ACCESS', status: 'OPEN', person: 'Test Person', overdue: false }); expect(row.mobile).toMatch(/^\*{6}\d{4}$/);
    expect((await u.cl.get('/admin/privacy/requests')).status).toBe(403); expect((await officer.get('/admin/privacy/requests')).status).toBe(403);
    expect((await resolve(r.body.id, { action: 'FULFIL' })).status).toBe(200);
    const d = await u.cl.get(`/me/data-requests/${r.body.id}/download`); expect(d.status).toBe(200);
    const file = await anon.agent.get(d.body.url).set('X-Forwarded-For', anon.ip); expect(file.status).toBe(200);
    const data = JSON.parse(file.text); expect(data.account.fullName).toBe('Test Person'); expect(data.account.mobile).toBe(u.mobile); expect(data.instruments).toHaveLength(1);
    expect((await resolve(r.body.id, { action: 'FULFIL' })).status).toBe(409);
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE user_id=$1 AND event_code='DSR_UPDATED'`, [u.id])).rowCount).toBe(1);
    const other = await person(); expect((await other.cl.get(`/me/data-requests/${r.body.id}/download`)).status).toBe(404);   // somebody else's request
  });
  it('correction changes the name; rejection needs a reason and changes nothing', async () => {
    const u = await person(); const r = await u.cl.post('/me/data-requests', { kind: 'CORRECTION', details: 'My name is spelled wrongly' }, { 'Idempotency-Key': key() });
    expect((await resolve(r.body.id, { action: 'REJECT' })).status).toBe(422);
    expect((await resolve(r.body.id, { action: 'FULFIL', correction: { fullName: 'Anita Verma' } })).status).toBe(200);
    expect(c.crypto.decStr((await c.pool.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [u.id])).rows[0].full_name_enc)).toBe('Anita Verma');
    const r2 = await u.cl.post('/me/data-requests', { kind: 'CORRECTION', details: 'Change my date of birth please' }, { 'Idempotency-Key': key() });
    expect((await resolve(r2.body.id, { action: 'REJECT', note: 'Please attach a proof first' })).status).toBe(200);
    expect((await u.cl.get('/me/data-requests')).body.items.find((x: { id: string }) => x.id === r2.body.id)).toMatchObject({ status: 'REJECTED', resolution: 'Please attach a proof first' });
  });
  it('erasure removes personal details but keeps what the law requires; it waits while a case is open', async () => {
    const u = await person(); const i = await inst(u.cl); const a = await u.cl.post('/applications', { instrumentId: i, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    const r = await u.cl.post('/me/data-requests', { kind: 'ERASURE' }, { 'Idempotency-Key': key() });
    const blocked = await resolve(r.body.id, { action: 'FULFIL' }); expect(blocked.status).toBe(409); expect(blocked.body.code).toBe('OPEN_CASES');
    expect((await c.pool.query('SELECT status FROM data_subject_requests WHERE id=$1', [r.body.id])).rows[0].status).toBe('OPEN');
    await c.pool.query(`UPDATE applications SET status='CANCELLED' WHERE id=$1`, [a.body.id]);
    expect((await resolve(r.body.id, { action: 'FULFIL' })).status).toBe(200);
    const row = (await c.pool.query('SELECT mobile_enc, mobile_bidx, email_enc, account_status FROM users WHERE id=$1', [u.id])).rows[0];
    expect(row).toMatchObject({ mobile_enc: null, mobile_bidx: null, email_enc: null, account_status: 'DEACTIVATED' });
    expect(c.crypto.decStr((await c.pool.query('SELECT full_name_enc FROM user_profiles WHERE user_id=$1', [u.id])).rows[0].full_name_enc)).toBe('Erased user');
    const ins = (await c.pool.query('SELECT address_enc, instrument_no FROM instruments WHERE id=$1', [i])).rows[0]; expect(ins.address_enc).toBeNull(); expect(ins.instrument_no).toBeTruthy();   // registry row stays
    const biz = (await c.pool.query('SELECT firm_name_enc, trade_licence_enc FROM businesses WHERE owner_user_id=$1', [u.id])).rows[0]; expect(c.crypto.decStr(biz.firm_name_enc)).toBe('Erased business'); expect(biz.trade_licence_enc).toBeNull();
    expect((await c.pool.query('SELECT 1 FROM consents WHERE user_id=$1', [u.id])).rowCount).toBe(1);
    expect((await u.cl.get('/me')).status).toBe(401);                                                         // sessions are gone
    const again = await new Client(c).init(); expect((await again.post('/auth/login', { identifier: u.mobile, password: 'Tr0ub4dor&3-horse' })).status).toBe(401);
    const done = (await admin.get('/admin/privacy/requests?status=CLOSED')).body.items.find((x: { id: string }) => x.id === r.body.id); expect(done.resolution).toContain('Kept by law');
    expect((await c.pool.query(`SELECT count(*)::int n FROM audit_events WHERE action='dsr.fulfilled' AND entity_id=$1`, [r.body.id])).rows[0].n).toBe(1);
  });
  it('deactivation closes the account and ends sessions; the flag can switch the feature off', async () => {
    const u = await person(); const r = await u.cl.post('/me/data-requests', { kind: 'DEACTIVATION' }, { 'Idempotency-Key': key() });
    await resolve(r.body.id, { action: 'FULFIL' });
    expect((await c.pool.query('SELECT account_status FROM users WHERE id=$1', [u.id])).rows[0].account_status).toBe('DEACTIVATED'); expect((await u.cl.get('/me')).status).toBe(401);
    const v = await person(); await setFlag('selfServiceDataRequests', false);
    expect((await v.cl.post('/me/data-requests', { kind: 'ACCESS' }, { 'Idempotency-Key': key() })).status).toBe(503); await setFlag('selfServiceDataRequests', true);
  });
  it('shows consent records, retention status and a breach checklist that remembers progress', async () => {
    const u = await person();
    const cs = await admin.get('/admin/privacy/consents'); expect(cs.body.summary.find((x: { purpose: string }) => x.purpose === 'ACCOUNT_REGISTRATION').granted).toBeGreaterThanOrEqual(1);
    const one = await admin.get(`/admin/privacy/consents?mobile=${u.mobile}`); expect(one.body.person[0]).toMatchObject({ purpose: 'ACCOUNT_REGISTRATION', withdrawnAt: null });
    expect((await admin.get('/admin/privacy/consents?mobile=abc')).status).toBe(422);
    const rt = await admin.get('/admin/privacy/retention'); expect(rt.body.schedule.length).toBeGreaterThan(5); expect(rt.body.kept.length).toBeGreaterThan(2);
    const b0 = await admin.get('/admin/privacy/breach'); expect(b0.body.steps.every((s: { done: boolean }) => !s.done)).toBe(true);
    const b1 = await admin.put('/admin/privacy/breach', { step: 'CONTAIN', done: true }); expect(b1.body.steps.find((s: { id: string }) => s.id === 'CONTAIN').done).toBe(true);
    expect((await admin.get('/admin/privacy/breach')).body.steps.filter((s: { done: boolean }) => s.done)).toHaveLength(1);
    expect((await admin.put('/admin/privacy/breach', { step: 'NOPE', done: true })).status).toBe(422);
    expect((await admin.del('/admin/privacy/breach')).body.steps.every((s: { done: boolean }) => !s.done)).toBe(true);
  });
});

describe('legacy import', () => {
  const ward = async () => (await c.pool.query(`SELECT code FROM areas WHERE level='WARD' ORDER BY code LIMIT 1`)).rows[0].code as string;
  const csv = (rows: string[][]) => Buffer.from(['legacy_ref,firm_name,owner_name,mobile,category_code,capacity,capacity_unit,accuracy_class,serial_no,make,model,address,ward_code,last_verified_on,valid_till', ...rows.map((r) => r.join(','))].join('\n') + '\n');
  const upload = (buf: Buffer) => admin.agent.post(`${API}/admin/migration/validate`).set('X-Forwarded-For', admin.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', admin.csrf).attach('file', buf, { filename: 'legacy.csv' });
  it('checks every row without creating anything, then commits the clean ones, and the real owner can claim the account', async () => {
    const w = await ward(); const tag = Date.now().toString().slice(-7); const m1 = randomMobile(); const m2 = randomMobile();
    const buf = csv([
      [`L-${tag}-1`, 'Sharma Stores', 'R Sharma', m1, 'PLATFORM_SCALE', '50', 'kg', 'III', `LS-${tag}-1`, 'Acme', 'PS-50', '"12 Market Road"', w, '2025-04-01', '2999-03-31'],
      [`L-${tag}-2`, 'Sharma Stores', 'R Sharma', m1, 'PLATFORM_SCALE', '50', 'kg', 'III', `LS-${tag}-2`, 'Acme', 'PS-50', '"12 Market Road"', w, '2024-01-01', '2025-01-01'],   // expired
      [`L-${tag}-3`, 'Verma Traders', 'A Verma', m2, 'PLATFORM_SCALE', '50', 'kg', 'III', `LS-${tag}-3`, 'Acme', '', '"7 Station Road"', w, '2025-04-01', '2999-03-31'],
      [`L-${tag}-4`, 'Bad Mobile', 'X', '12345', 'PLATFORM_SCALE', '50', 'kg', 'III', `LS-${tag}-4`, 'Acme', '', '"7 Station Road"', w, '2025-04-01', '2999-03-31'],
      [`L-${tag}-5`, 'No Category', 'X', m2, 'NOPE', '50', 'kg', 'III', `LS-${tag}-5`, 'Acme', '', '"7 Station Road"', w, '2025-04-01', '2999-03-31'],
      [`L-${tag}-1`, 'Dup Ref', 'X', m2, 'PLATFORM_SCALE', '50', 'kg', 'III', `LS-${tag}-6`, 'Acme', '', '"7 Station Road"', w, '2025-04-01', '2999-03-31'],
      [`L-${tag}-7`, 'Huge', 'X', m2, 'PLATFORM_SCALE', '99999999', 'kg', 'III', `LS-${tag}-7`, 'Acme', '', '"7 Station Road"', 'NOWARD', '2999-04-01', '2025-03-31'],
    ]);
    const before = Number((await c.pool.query('SELECT count(*) n FROM instruments')).rows[0].n);
    const v = await upload(buf); expect(v.status).toBe(201); expect(v.body).toMatchObject({ total: 7, valid: 3, invalid: 4, canCommit: true });
    expect(Object.keys(v.body.problemsByKind)).toEqual(expect.arrayContaining(['mobile:INVALID_MOBILE', 'category_code:UNKNOWN_CATEGORY', 'legacy_ref:DUPLICATE_IN_FILE', 'ward_code:UNKNOWN_WARD', 'valid_till:BEFORE_VERIFICATION', 'last_verified_on:IN_FUTURE']));
    expect(Number((await c.pool.query('SELECT count(*) n FROM instruments')).rows[0].n)).toBe(before);   // a dry run creates nothing
    const errs = await admin.get(`/admin/migration/jobs/${v.body.id}/errors.csv`); expect(errs.status).toBe(200); expect(errs.text).toContain('INVALID_MOBILE');
    expect((await officer.get('/admin/migration/jobs')).status).toBe(403);
    expect((await admin.post(`/admin/migration/jobs/${v.body.id}/commit`, {})).status).toBe(400);
    const done = await admin.post(`/admin/migration/jobs/${v.body.id}/commit`, {}, { 'Idempotency-Key': key() }); expect(done.status).toBe(200); expect(done.body).toMatchObject({ instruments: 3, newOwnerAccounts: 2, skipped: 0 });
    expect((await admin.post(`/admin/migration/jobs/${v.body.id}/commit`, {}, { 'Idempotency-Key': key() })).status).toBe(409);
    const rows = (await c.pool.query(`SELECT legacy_ref, status, first_verified_at IS NOT NULL AS verified FROM instruments WHERE migration_job_id=$1 ORDER BY legacy_ref`, [v.body.id])).rows;
    expect(rows.map((r) => [r.legacy_ref, r.status, r.verified])).toEqual([[`L-${tag}-1`, 'ACTIVE', true], [`L-${tag}-2`, 'EXPIRED', true], [`L-${tag}-3`, 'ACTIVE', true]]);
    expect((await c.pool.query('SELECT rows_enc FROM migration_jobs WHERE id=$1', [v.body.id])).rows[0].rows_enc).toBeNull();   // staged personal data is gone after commit
    // uploading the same file again is refused row by row
    const again = await upload(buf); expect(again.body.valid).toBe(0);
    // the real owner registers with the same mobile number and gets the imported instruments
    const cl = await new Client(c).init(); const tok = await cl.otp(m1, 'REGISTER');
    const reg = await cl.post('/auth/register', registerBody(c, m1, tok, { identity: { fullName: 'Ravi Sharma', dob: '1980-01-01', mobile: m1 }, business: { firmName: 'Sharma Stores', tradeLicenceNo: 'TL-1' } })); expect(reg.status).toBe(201);
    const uid = (await cl.get('/me')).body.id as string; await activate(c, uid);
    const mine = await cl.get('/instruments'); expect(mine.body.items.map((x: { serialNo?: string }) => x.serialNo).sort()).toEqual([`LS-${tag}-1`, `LS-${tag}-2`]);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='account.claimed' AND entity_id=$1`, [uid])).rowCount).toBe(1);
    // a stranger cannot take a shell that is not theirs by registering as a different kind of business
    const cl2 = await new Client(c).init(); const tok2 = await cl2.otp(m2, 'REGISTER'); const bad = await cl2.post('/auth/register', registerBody(c, m2, tok2, { businessType: 'DEALER' })); expect(bad.status).toBe(409);
    // and an ordinary registered number is still a duplicate
    const dupe = await new Client(c).init(); const tok3 = await dupe.otp(m1, 'REGISTER').catch(() => null); if (tok3) expect((await dupe.post('/auth/register', registerBody(c, m1, tok3))).status).toBe(409);
  });
  it('rejects a file that is not a CSV of the right shape, and a job can be discarded', async () => {
    expect((await upload(Buffer.from('a,b\n1,2\n'))).status).toBe(422);
    const w = await ward(); const v = await upload(csv([[`L-D-${Date.now()}`, 'F', 'O', randomMobile(), 'PLATFORM_SCALE', '50', 'kg', 'III', `SD-${Date.now()}`, 'Acme', '', '"7 Station Road"', w, '2025-04-01', '2999-03-31']]));
    expect(v.body.valid).toBe(1); expect((await admin.post(`/admin/migration/jobs/${v.body.id}/discard`, {}, { 'Idempotency-Key': key() })).status).toBe(200);
    expect((await admin.post(`/admin/migration/jobs/${v.body.id}/commit`, {}, { 'Idempotency-Key': key() })).status).toBe(409);
  });
});
