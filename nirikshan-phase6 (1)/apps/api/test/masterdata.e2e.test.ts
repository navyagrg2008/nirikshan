import { boot, shutdown, Client, Ctx, registerUser, activate } from './helpers';

let c: Ctx; let admin: Client; let officer: Client; let owner: Client;
beforeAll(async () => {
  c = await boot(); admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1); officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, 0);
  const o = await registerUser(c); await activate(c, o.id); owner = o.cl;
});
afterAll(() => shutdown(c));

describe('master data', () => {
  it('is readable by admins, writable only by admins', async () => {
    expect((await admin.get('/admin/masterdata/categories')).status).toBe(200);
    expect((await owner.post('/admin/masterdata/categories', { code: 'X1', name_en: 'X' })).status).toBe(403);
    expect((await officer.post('/admin/masterdata/categories', { code: 'X1', name_en: 'X' })).status).toBe(403);
    expect((await (await new Client(c).init()).get('/admin/masterdata/categories')).status).toBe(401);
  });
  it('validates input strictly and rejects unknown entities and fields', async () => {
    expect((await admin.post('/admin/masterdata/categories', { code: 'ok', name_en: 'X', extra: 1 })).status).toBe(422);
    expect((await admin.get('/admin/masterdata/users')).status).toBe(422);
    expect((await admin.patch('/admin/masterdata/categories/not-a-uuid', { name_en: 'Y' })).status).toBe(422);
  });
  it('creates, edits and removes a category, with audit entries', async () => {
    const code = 'T' + Date.now().toString(36).toUpperCase().slice(-6);
    const cr = await admin.post('/admin/masterdata/categories', { code, name_en: 'Test category', name_hi: 'परीक्षण' }); expect(cr.status).toBe(201);
    expect((await admin.patch(`/admin/masterdata/categories/${cr.body.id}`, { name_en: 'Renamed' })).status).toBe(200);
    expect((await admin.post('/admin/masterdata/categories', { code, name_en: 'Dup' })).status).toBe(409);
    const del = await admin.del(`/admin/masterdata/categories/${cr.body.id}`); expect(del.status).toBe(409); expect(del.body.code).toBe('DELETE_NOT_ALLOWED'); // retired, never deleted
    expect((await admin.patch(`/admin/masterdata/categories/${cr.body.id}`, { status: 'INACTIVE' })).status).toBe(200);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action LIKE 'masterdata.%'`)).rowCount).toBeGreaterThanOrEqual(3);
  });
  it('rejects overlapping capacity bands and min >= max', async () => {
    const cat = (await admin.get('/catalog/categories')).body.categories[0].id as string; const u = 'kg';
    const a = await admin.post('/admin/masterdata/capacity-bands', { category_id: cat, min_capacity: '70000', max_capacity: '80000', unit: u }); expect(a.status).toBe(201);
    expect((await admin.post('/admin/masterdata/capacity-bands', { category_id: cat, min_capacity: '75000', max_capacity: '90000', unit: u })).status).toBe(409);
    expect((await admin.post('/admin/masterdata/capacity-bands', { category_id: cat, min_capacity: '9', max_capacity: '9', unit: u })).status).toBeGreaterThanOrEqual(400);
    await admin.del(`/admin/masterdata/capacity-bands/${a.body.id}`);
  });
  it('keeps the area hierarchy valid (a ward cannot sit directly under a division)', async () => {
    const div = (await c.pool.query(`SELECT id FROM areas WHERE level='DIVISION' LIMIT 1`)).rows[0].id;
    expect((await admin.post('/admin/masterdata/areas', { level: 'WARD', code: 'BAD-WARD', name_en: 'Bad', parent_id: div })).status).toBe(422);
  });
});

describe('public endpoints', () => {
  it('serves reference data without login and with cache headers', async () => {
    const anon = await new Client(c).init(); const cats = await anon.get('/catalog/categories'); expect(cats.status).toBe(200); expect(cats.headers['cache-control']).toMatch(/max-age=60/); expect(cats.body.categories.length).toBeGreaterThan(0);
    expect((await anon.get('/catalog/areas')).status).toBe(200); expect((await anon.get('/catalog/document-types')).status).toBe(200);
    expect((await anon.get('/public/rules')).status).toBe(200); expect((await anon.get('/public/notices')).status).toBe(200);
  });
  it('public stats are aggregate-only: no personal data and no fees anywhere', async () => {
    const s = await (await new Client(c).init()).get('/public/stats'); expect(s.status).toBe(200); const txt = JSON.stringify(s.body).toLowerCase();
    for (const bad of ['mobile', 'email', 'firm', 'address', 'fee', 'payment', 'price']) expect(txt).not.toContain(bad);
  });
  it('contact form validates, stores the message and is rate limited', async () => {
    const anon = await new Client(c).init(); expect((await anon.post('/public/contact', { name: 'A', contact: 'x', message: 'short' })).status).toBe(422);
    const ok = { name: 'Ravi Kumar', contact: 'ravi@example.com', message: 'Please explain how to register a counter scale.' };
    expect((await anon.post('/public/contact', ok)).status).toBe(201);
    expect((await c.pool.query('SELECT 1 FROM contact_messages')).rowCount).toBeGreaterThan(0);
    let last = 201; for (let i = 0; i < 6; i++) last = (await anon.post('/public/contact', ok)).status; expect(last).toBe(429);
  });
  it('errors are RFC 7807 without stack traces, SQL or internals', async () => {
    const anon = await new Client(c).init(); const r = await anon.get('/catalog/mpe?categoryId=nope'); expect(r.status).toBe(422); expect(r.headers['content-type']).toMatch(/problem\+json/);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts|node_modules|SELECT |pg_|stack/i); expect(r.body.requestId).toBeTruthy();
    const nf = await anon.get('/nope/nothing'); expect(nf.status).toBe(404); expect(JSON.stringify(nf.body)).not.toMatch(/Cannot GET|express/i);
  });
  it('sets security headers', async () => {
    const r = await (await new Client(c).init()).get('/catalog/categories'); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
