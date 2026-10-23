import { boot, shutdown, Client, Ctx, registerUser, approve, activate, catalog, instrumentBody, randomMobile, API } from './helpers';
import { InstrumentsService } from '../src/modules/instruments/instruments.service';

let c: Ctx; let officer: Client; let admin: Client; let trader: Client;
let owner: { cl: Client; id: string }; let other: { cl: Client; id: string };
let cat: Awaited<ReturnType<typeof catalog>>;
let n = 0; const key = () => `idem-${Date.now()}-${n++}`;

async function create(cl: Client, over: Record<string, unknown> = {}) {
  const tok = await cl.confirmToken(); return cl.post('/instruments', instrumentBody(c, cat, tok, over), { 'Idempotency-Key': key() });
}
beforeAll(async () => {
  c = await boot(); officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1); admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1);
  trader = await new Client(c).init(); await trader.post('/auth/login', { identifier: c.demo.TRADER!.mobile, password: c.demo.TRADER!.password });
  const a = await registerUser(c); await activate(c, a.id); owner = a; const b = await registerUser(c); await activate(c, b.id); other = b;
  cat = await catalog(owner.cl);
});
afterAll(() => shutdown(c));

describe('registering instruments', () => {
  it('needs a confirmation OTP, validates against master data, and encrypts the address', async () => {
    const bad = await owner.cl.post('/instruments', instrumentBody(c, cat, 'x'.repeat(30)), { 'Idempotency-Key': key() }); expect(bad.status).toBe(422);
    const outside = await create(owner.cl, { capacity: '5000000' }); expect(outside.status).toBe(422); expect(outside.body.reasons).toContain('CAPACITY_OUTSIDE_BAND');
    const wrongUnit = await create(owner.cl, { capacityUnit: 'g' }); expect(wrongUnit.body.reasons).toContain('UNIT_MISMATCH');
    const r = await create(owner.cl); expect(r.status).toBe(201); expect(r.body.instrumentNo).toMatch(/^NRK-INS-\d{8}$/);
    const row = (await c.pool.query('SELECT address_enc, status FROM instruments WHERE id=$1', [r.body.id])).rows[0];
    expect(Buffer.from(row.address_enc).includes(Buffer.from('Market Road'))).toBe(false); expect(row.status).toBe('REGISTERED');
    const got = await owner.cl.get(`/instruments/${r.body.id}`); expect(got.status).toBe(200); expect(got.body.address).toContain('Market Road'); expect(got.headers.etag).toBe('"1"');
  });
  it('a confirmation token can be used once', async () => {
    const tok = await owner.cl.confirmToken(); const body = instrumentBody(c, cat, tok);
    expect((await owner.cl.post('/instruments', body, { 'Idempotency-Key': key() })).status).toBe(201);
    const again = await owner.cl.post('/instruments', { ...body, serialNo: 'OTHER-123' }, { 'Idempotency-Key': key() }); expect(again.status).toBe(422); expect(again.body.code).toBe('INVALID_VERIFICATION');
  });
  it('retries with the same Idempotency-Key replay the first result and create one row', async () => {
    const tok = await owner.cl.confirmToken(); const body = instrumentBody(c, cat, tok); const k = key();
    const a = await owner.cl.post('/instruments', body, { 'Idempotency-Key': k }); const b = await owner.cl.post('/instruments', body, { 'Idempotency-Key': k });
    expect(a.status).toBe(201); expect(b.status).toBe(201); expect(b.body.id).toBe(a.body.id); expect(b.headers['idempotent-replayed']).toBe('true');
    const diff = await owner.cl.post('/instruments', { ...body, make: 'Other' }, { 'Idempotency-Key': k }); expect(diff.status).toBe(422); expect(diff.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await owner.cl.post('/instruments', body); expect(missing.status).toBe(400);
  });
  it('flags an instrument outside the owner\'s division', async () => {
    await c.pool.query(`INSERT INTO areas (code, level, name_en) VALUES ('DIV-OTH','DIVISION','Other Division') ON CONFLICT DO NOTHING`);
    await c.pool.query(`INSERT INTO areas (code, level, name_en, parent_id) SELECT 'ZONE-OTH','ZONE','Other Zone', id FROM areas WHERE code='DIV-OTH' ON CONFLICT DO NOTHING`);
    await c.pool.query(`INSERT INTO areas (code, level, name_en, parent_id) SELECT 'CIR-OTH','CIRCLE','Other Circle', id FROM areas WHERE code='ZONE-OTH' ON CONFLICT DO NOTHING`);
    await c.pool.query(`INSERT INTO areas (code, level, name_en, parent_id) SELECT 'WARD-OTH','WARD','Other Ward', id FROM areas WHERE code='CIR-OTH' ON CONFLICT DO NOTHING`);
    const w = (await c.pool.query(`SELECT id FROM areas WHERE code='WARD-OTH'`)).rows[0].id;
    const r = await create(owner.cl, { location: { address: '1 Far Road', areaId: w } }); expect(r.status).toBe(201); expect(r.body.outOfArea).toBe(true);
  });
});

describe('duplicates', () => {
  it('blocks a duplicate, lets the owner ask for review, and an officer can approve it', async () => {
    const serial = 'DUP-' + Date.now(); const first = await create(owner.cl, { serialNo: serial }); expect(first.status).toBe(201);
    const dup = await create(other.cl, { serialNo: serial }); expect(dup.status).toBe(409); expect(dup.body.code).toBe('DUPLICATE_INSTRUMENT'); expect(JSON.stringify(dup.body)).not.toContain(first.body.id);
    const req = await create(other.cl, { serialNo: serial, requestDuplicateReview: true }); expect(req.status).toBe(202); expect(req.body.status).toBe('REVIEW_REQUESTED');
    const list = await officer.get('/officer/duplicates'); const item = list.body.find((d: { id: string }) => d.id === req.body.requestId); expect(item).toBeTruthy();
    expect((await owner.cl.get('/officer/duplicates')).status).toBe(403);
    expect((await officer.post(`/officer/duplicates/${req.body.requestId}/decision`, { outcome: 'APPROVED' })).status).toBe(200);
    const mine = await other.cl.get('/instruments?limit=100'); expect(mine.body.items.some((i: { serialNo: string }) => i.serialNo === serial)).toBe(true);
    const row = (await c.pool.query(`SELECT duplicate_override_by FROM instruments WHERE serial_no=$1 AND business_id IN (SELECT id FROM businesses WHERE owner_user_id=$2)`, [serial, other.id])).rows[0]; expect(row.duplicate_override_by).toBeTruthy();
  });
});

describe('access control (IDOR)', () => {
  it('other owners get 404 for read and update, and see nothing in lists', async () => {
    const r = await create(owner.cl); const id = r.body.id as string;
    expect((await other.cl.get(`/instruments/${id}`)).status).toBe(404);
    expect((await other.cl.patch(`/instruments/${id}`, { model: 'hack' }, { 'If-Match': '"1"' })).status).toBe(404);
    expect((await other.cl.get('/instruments?limit=100')).body.items.some((i: { id: string }) => i.id === id)).toBe(false);
    expect((await (await new Client(c).init()).get(`/instruments/${id}`)).status).toBe(401);
  });
  it('officers see instruments only inside their areas; admins see all; inspectors none', async () => {
    const r = await create(owner.cl); expect((await officer.get(`/instruments/${r.body.id}`)).status).toBe(200);
    const o = await officer.get(`/instruments/${r.body.id}`); expect(o.body.location).toBeNull(); // premises coordinates are for the owner only
    expect((await admin.get(`/instruments/${r.body.id}`)).status).toBe(200);
    const insp = await new Client(c).init(); await insp.loginStaff(c.demo.INSPECTOR!, 0); expect((await insp.get(`/instruments/${r.body.id}`)).status).toBe(403);
  });
  it('PostgreSQL row-level security independently hides other owners\' rows', async () => {
    const mine = await create(owner.cl); const client = await c.pool.connect();
    try {
      const bizOther = (await c.pool.query('SELECT id FROM businesses WHERE owner_user_id=$1', [other.id])).rows[0].id;
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE nirikshan_app');
      await client.query(`SELECT set_config('app.role','OWNER',true), set_config('app.business_ids',$1,true)`, [`{${bizOther}}`]);
      expect((await client.query('SELECT 1 FROM instruments WHERE id=$1', [mine.body.id])).rowCount).toBe(0);
      await client.query(`SELECT set_config('app.role','',true)`); expect((await client.query('SELECT 1 FROM instruments')).rowCount).toBe(0); // no context, no rows
      await expect(client.query(`UPDATE instruments SET model='x' WHERE id=$1`, [mine.body.id])).resolves.toMatchObject({ rowCount: 0 });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('only traders can use bulk and on-behalf features', async () => {
    expect((await owner.cl.get('/instruments/bulk/template.csv')).status).toBe(403); expect((await owner.cl.post('/me/customers', { firmName: 'X Co', areaId: c.wards[0] })).status).toBe(403);
  });
});

describe('editing and drafts', () => {
  it('uses If-Match for optimistic locking and locks key fields after first verification', async () => {
    const r = await create(owner.cl); const id = r.body.id as string;
    expect((await owner.cl.patch(`/instruments/${id}`, { model: 'New' })).status).toBe(428);
    const ok = await owner.cl.patch(`/instruments/${id}`, { model: 'New', displayCount: 3000 }, { 'If-Match': '"1"' }); expect(ok.status).toBe(200); expect(ok.body.version).toBe(2);
    const stale = await owner.cl.patch(`/instruments/${id}`, { model: 'Again' }, { 'If-Match': '"1"' }); expect(stale.status).toBe(412);
    await c.pool.query(`UPDATE instruments SET first_verified_at=now() WHERE id=$1`, [id]);
    const locked = await owner.cl.patch(`/instruments/${id}`, { capacity: '60' }, { 'If-Match': '"2"' }); expect(locked.status).toBe(409); expect(locked.body.code).toBe('FIELD_LOCKED');
    expect((await owner.cl.patch(`/instruments/${id}`, { model: 'Still ok' }, { 'If-Match': '"2"' })).status).toBe(200);
  });
  it('autosaves the wizard draft to the server, encrypted, private and expiring', async () => {
    expect((await owner.cl.get('/instruments/draft/mine')).body.step).toBeUndefined();
    const put = await owner.cl.put('/instruments/draft/mine', { step: 3, data: { serialNo: 'DRAFT-SECRET-1', address: 'Private lane' } }); expect(put.status).toBe(200);
    const got = await owner.cl.get('/instruments/draft/mine'); expect(got.body.step).toBe(3); expect(got.body.data.serialNo).toBe('DRAFT-SECRET-1');
    const raw = (await c.pool.query('SELECT payload_enc, expires_at FROM instrument_drafts WHERE user_id=$1', [owner.id])).rows[0];
    expect(Buffer.from(raw.payload_enc).includes(Buffer.from('DRAFT-SECRET-1'))).toBe(false); expect(raw.expires_at.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86400000);
    expect((await other.cl.get('/instruments/draft/mine')).body.step).toBeUndefined();
    await c.pool.query(`UPDATE instrument_drafts SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [owner.id]); expect((await owner.cl.get('/instruments/draft/mine')).body.step).toBeUndefined();
    expect((await owner.cl.del('/instruments/draft/mine')).status).toBe(200);
  });
});

describe('lists and export', () => {
  it('paginates with a cursor and filters; short search terms are refused', async () => {
    const p1 = await owner.cl.get('/instruments?limit=2'); expect(p1.body.items).toHaveLength(2); expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await owner.cl.get(`/instruments?limit=2&cursor=${p1.body.nextCursor}`); expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id); expect(p2.body.items.every((i: { id: string }) => !p1.body.items.some((j: { id: string }) => j.id === i.id))).toBe(true);
    expect((await owner.cl.get('/instruments?q=a')).status).toBe(422); expect((await owner.cl.get('/instruments?status=BOGUS')).status).toBe(422);
    expect((await owner.cl.get('/instruments?cursor=garbage')).status).toBe(422);
  });
  it('exports CSV with formula injection neutralised', async () => {
    expect(InstrumentsService.csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`); expect(InstrumentsService.csvCell('@SUM(A1)')).toBe("'@SUM(A1)"); expect(InstrumentsService.csvCell('plain')).toBe('plain');
    const r = await owner.cl.get('/instruments/export.csv'); expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/text\/csv/); expect(r.text.split('\n')[0]).toContain('instrument_no');
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='instrument.exported'`)).rowCount).toBeGreaterThan(0);
  });
});

describe('trader features', () => {
  it('registers on behalf of a managed customer', async () => {
    const cust = await trader.post('/me/customers', { firmName: 'Gupta Kirana', areaId: c.wards[1] }); expect(cust.status).toBe(201);
    const tc = await catalog(trader); const tok = await trader.confirmToken();
    const r = await trader.post('/instruments', instrumentBody(c, tc, tok, { ownership: { mode: 'ON_BEHALF', customerBusinessId: cust.body.id }, location: { address: 'Gupta Kirana shop', areaId: c.wards[1] } }), { 'Idempotency-Key': key() });
    expect(r.status).toBe(201); expect((await trader.get(`/instruments/${r.body.id}`)).body.ownership).toBe('ON_BEHALF');
    const notMine = await create(owner.cl, { ownership: { mode: 'ON_BEHALF', customerBusinessId: cust.body.id } }); expect([403, 404]).toContain(notMine.status);
  });
  it('validates a bulk CSV row by row, reports errors, and commits only the valid rows', async () => {
    const dupSerial = 'BULK-' + Date.now();
    const csv = ['category_code,capacity,capacity_unit,accuracy_class_code,serial_no,make,model,manufacture_year,load_cell_serial,display_count,address,area_code,customer_firm',
      `PLATFORM_SCALE,50,kg,III,${dupSerial}-A,Acme,M1,2024,,,1 Road,WARD-111,`, `PLATFORM_SCALE,50,kg,III,${dupSerial}-A,Acme,M1,2024,,,1 Road,WARD-111,`,
      `NOPE,50,kg,III,${dupSerial}-B,Acme,M1,2024,,,1 Road,WARD-111,`, `PLATFORM_SCALE,99999,kg,III,${dupSerial}-C,Acme,M1,2024,,,1 Road,WARD-111,`,
      `PLATFORM_SCALE,60,kg,III,${dupSerial}-D,Acme,M1,2024,,,2 Road,WARD-112,Bulk Customer`].join('\n');
    const v = await trader.agent.post(API + '/instruments/bulk').set('X-Forwarded-For', trader.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', trader.csrf).attach('file', Buffer.from(csv), 'rows.csv');
    expect(v.status).toBe(201); expect(v.body.total).toBe(5); expect(v.body.valid).toBe(2); expect(v.body.invalid).toBe(3);
    expect(v.body.report.find((r: { row: number }) => r.row === 3).errors).toContain('DUPLICATE_IN_FILE'); expect(v.body.report.find((r: { row: number }) => r.row === 4).errors).toContain('INVALID_CATEGORY');
    expect(v.body.report.find((r: { row: number }) => r.row === 5).errors).toContain('CAPACITY_OUTSIDE_BAND');
    const errs = await trader.get(`/instruments/bulk/${v.body.uploadId}/errors.csv`); expect(errs.text).toContain('DUPLICATE_IN_FILE');
    const tok = await trader.confirmToken(); const commit = await trader.post('/instruments/bulk/commit', { uploadId: v.body.uploadId, confirmToken: tok });
    expect(commit.status).toBe(200); expect(commit.body.accepted).toBe(2); expect(commit.body.failed).toBe(0);
    const again = await trader.post('/instruments/bulk/commit', { uploadId: v.body.uploadId, confirmToken: await trader.confirmToken() }); expect(again.status).toBe(404); // upload consumed
  });
  it('rejects non-CSV and oversized bulk uploads', async () => {
    const bad = await trader.agent.post(API + '/instruments/bulk').set('X-Forwarded-For', trader.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', trader.csrf).attach('file', Buffer.from('not,a\n"unterminated'), 'x.csv'); expect(bad.status).toBe(422);
    const big = await trader.agent.post(API + '/instruments/bulk').set('X-Forwarded-For', trader.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', trader.csrf).attach('file', Buffer.alloc(1100 * 1024, 'a'), 'big.csv'); expect(big.status).toBe(413);
  });
});

describe('uploads and files', () => {
  it('accepts only real PDF/JPEG/PNG by content, rejects scripts and EICAR, and never trusts the extension', async () => {
    const cl = await new Client(c).init(); const up = (buf: Buffer, name: string) => cl.agent.post(API + '/auth/register/uploads').set('X-Forwarded-For', cl.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', cl.csrf).field('kind', 'TRADE_LICENCE').attach('file', buf, name);
    expect((await up(Buffer.from('%PDF-1.4\n%fake but valid header\n'), 'a.pdf')).status).toBe(201);
    expect((await up(Buffer.from('<?php echo 1;'), 'shell.pdf')).status).toBe(415);
    expect((await up(Buffer.from('%PDF-1.4\n/JavaScript (app.alert(1))'), 'js.pdf')).status).toBe(422);
    expect((await up(Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'), 'e.pdf')).status).toBe(422);
    expect((await up(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5.5 * 1024 * 1024)]), 'big.pdf')).status).toBe(413);
  });
  it('registration with uploaded documents lets the officer fetch a short-lived link, audited', async () => {
    const cl = await new Client(c).init(); const mobile = randomMobile(); const token = await cl.otp(mobile, 'REGISTER');
    const up = await cl.agent.post(API + '/auth/register/uploads').set('X-Forwarded-For', cl.ip).set('Origin', 'http://localhost:3000').set('X-CSRF-Token', cl.csrf).field('kind', 'TRADE_LICENCE').attach('file', Buffer.from('%PDF-1.4\nlicence'), 'l.pdf');
    const { registerBody } = await import('./helpers');
    const reg = await cl.post('/auth/register', registerBody(c, mobile, token, { documents: [{ kind: 'TRADE_LICENCE', fileId: up.body.fileId }] })); expect(reg.status).toBe(201);
    const id = (await cl.get('/me')).body.id; const acct = (await officer.get('/officer/accounts')).body.find((a: { id: string }) => a.id === id); expect(acct.documents).toHaveLength(1);
    expect(acct.mobileMasked).toMatch(/\*{6}/); expect(JSON.stringify(acct)).not.toContain(mobile);
    const link = await officer.get(`/officer/accounts/${id}/documents/${acct.documents[0].id}/link`); expect(link.status).toBe(200);
    const file = await officer.agent.get(link.body.url).set('X-Forwarded-For', officer.ip); expect(file.status).toBe(200); expect(file.headers['content-disposition']).toBe('attachment'); expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await officer.agent.get(link.body.url.slice(0, -4) + 'abcd')).status).toBe(404);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='document.viewed'`)).rowCount).toBeGreaterThan(0);
    expect((await cl.get(`/officer/accounts/${id}/documents/${acct.documents[0].id}/link`)).status).toBe(403);
  });
});
void approve;
