import { boot, shutdown, Client, Ctx, registerUser, registerBody, randomMobile, totp, approve, activate, clearCooldown } from './helpers';

let c: Ctx; let officer: Client; let admin: Client;
beforeAll(async () => { c = await boot(); officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1); admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1); });
afterAll(() => shutdown(c));

describe('OTP', () => {
  it('rejects a wrong code, locks after 5 attempts and never reveals the code', async () => {
    const cl = await new Client(c).init(); const mobile = randomMobile();
    const s = await cl.post('/auth/otp/send', { channel: 'MOBILE', target: mobile, purpose: 'REGISTER' }); expect(s.status).toBe(200);
    const real = cl.lastCode(mobile); const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await cl.post('/auth/otp/verify', { challengeId: s.body.challengeId, code: wrong })).body.code).toBe('INVALID_CODE');
    const locked = await cl.post('/auth/otp/verify', { challengeId: s.body.challengeId, code: real });
    expect(locked.status).toBe(422); expect(locked.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    const row = (await c.pool.query('SELECT code_hash FROM otp_challenges WHERE id=$1', [s.body.challengeId])).rows[0];
    expect(row.code_hash.toString('hex')).not.toContain(real); expect(Buffer.from(row.code_hash).length).toBe(32);
  });
  it('throttles resend within 30 seconds', async () => {
    const cl = await new Client(c).init(); const mobile = randomMobile();
    expect((await cl.post('/auth/otp/send', { channel: 'MOBILE', target: mobile, purpose: 'REGISTER' })).status).toBe(200);
    const again = await cl.post('/auth/otp/send', { channel: 'MOBILE', target: mobile, purpose: 'REGISTER' });
    expect(again.status).toBe(429); expect(again.body.code).toBe('OTP_RESEND_TOO_SOON'); expect(again.headers['retry-after']).toBeDefined();
  });
  it('verification token is single use', async () => {
    const cl = await new Client(c).init(); const mobile = randomMobile(); const token = await cl.otp(mobile, 'REGISTER');
    expect((await cl.post('/auth/register', registerBody(c, mobile, token))).status).toBe(201);
    const cl2 = await new Client(c).init();
    const again = await cl2.post('/auth/register', registerBody(c, mobile, token)); expect(again.status).toBe(422); expect(again.body.code).toBe('INVALID_VERIFICATION');
  });
  it('does not reveal whether a mobile has an account when sending a login OTP', async () => {
    const cl = await new Client(c).init(); const known = c.demo.OWNER!.mobile; const unknown = randomMobile();
    const a = await cl.post('/auth/otp/send', { channel: 'MOBILE', target: known, purpose: 'LOGIN' }); const b = await cl.post('/auth/otp/send', { channel: 'MOBILE', target: unknown, purpose: 'LOGIN' });
    expect(a.status).toBe(b.status); expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    expect(c.outbox.some((m) => m.to === unknown)).toBe(false);
  });
  it('rejects invalid mobile numbers', async () => {
    const cl = await new Client(c).init(); const r = await cl.post('/auth/otp/send', { channel: 'MOBILE', target: '12345', purpose: 'REGISTER' }); expect(r.status).toBe(422);
  });
});

describe('registration and approval', () => {
  it('stores PII encrypted, signs the user in as pending, and blocks owner APIs until approved', async () => {
    const { cl, mobile, id } = await registerUser(c);
    const row = (await c.pool.query('SELECT mobile_enc, mobile_bidx FROM users WHERE id=$1', [id])).rows[0];
    expect(Buffer.from(row.mobile_enc).includes(Buffer.from(mobile))).toBe(false); expect(row.mobile_bidx).toBeTruthy();
    const prof = (await c.pool.query('SELECT full_name_enc, dob_enc FROM user_profiles WHERE user_id=$1', [id])).rows[0];
    expect(Buffer.from(prof.full_name_enc).includes(Buffer.from('Test Person'))).toBe(false);
    const biz = (await c.pool.query('SELECT firm_name_enc, firm_name_masked FROM businesses WHERE owner_user_id=$1', [id])).rows[0];
    expect(biz.firm_name_masked).toBe('S******'); expect(Buffer.from(biz.firm_name_enc).includes(Buffer.from('Sharma'))).toBe(false);
    const s = await cl.get('/auth/session'); expect(s.body.authenticated).toBe(true); expect(s.body.accountStatus).toBe('PENDING_VERIFICATION');
    const blocked = await cl.get('/instruments'); expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect((await c.pool.query(`SELECT 1 FROM consents WHERE user_id=$1 AND purpose='ACCOUNT_REGISTRATION'`, [id])).rowCount).toBe(1);
  });
  it('rejects weak passwords, under-18 and existing mobiles', async () => {
    const cl = await new Client(c).init(); const mobile = randomMobile(); const token = await cl.otp(mobile, 'REGISTER');
    const weak = await cl.post('/auth/register', registerBody(c, mobile, token, { password: 'Password123' })); expect(weak.status).toBe(422); expect(weak.body.code).toBe('WEAK_PASSWORD');
    const t2 = await cl.otp(randomMobile(), 'REGISTER');
    const young = await cl.post('/auth/register', registerBody(c, randomMobile(), t2, { identity: { fullName: 'Kid', dob: new Date().toISOString().slice(0, 10), mobile: randomMobile() } })); expect(young.status).toBe(422);
    const { mobile: m2 } = await registerUser(c); const cl3 = await new Client(c).init(); await clearCooldown(c, m2); const t3 = await cl3.otp(m2, 'REGISTER');
    const dup = await cl3.post('/auth/register', registerBody(c, m2, t3)); expect(dup.status).toBe(409); expect(dup.body.code).toBe('ACCOUNT_EXISTS');
  });
  it('officer in jurisdiction approves; the owner then gets access and is notified', async () => {
    const { cl, id } = await registerUser(c);
    const pending = await officer.get('/officer/accounts'); expect(pending.body.some((a: { id: string }) => a.id === id)).toBe(true);
    const before = c.outbox.length;
    expect((await approve(c, officer, id)).status).toBe(200);
    expect((await cl.get('/instruments')).status).toBe(200);
    expect(c.outbox.slice(before).some((m) => m.channel === 'SMS' && /approved/i.test(m.body))).toBe(true);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='account.approved' AND entity_id=$1`, [id])).rowCount).toBe(1);
  });
  it('rejection needs a reason and the account cannot sign in afterwards', async () => {
    const { id, mobile } = await registerUser(c);
    expect((await officer.post(`/officer/accounts/${id}/decision`, { outcome: 'REJECTED' })).status).toBe(422);
    expect((await officer.post(`/officer/accounts/${id}/decision`, { outcome: 'REJECTED', reason: 'Trade licence is not readable' })).status).toBe(200);
    const fresh = await new Client(c).init(); const l = await fresh.post('/auth/login', { identifier: mobile, password: 'Tr0ub4dor&3-horse' }); expect(l.status).toBe(401);
  });
  it('an owner cannot approve accounts', async () => {
    const { cl } = await registerUser(c); const { id } = await registerUser(c);
    expect((await cl.get('/officer/accounts')).status).toBe(403);
    expect((await cl.post(`/officer/accounts/${id}/decision`, { outcome: 'APPROVED' })).status).toBe(403);
  });
});

describe('login, sessions and CSRF', () => {
  it('requires a CSRF token and a trusted origin for state-changing requests', async () => {
    const cl = await new Client(c).init();
    const noToken = await cl.agent.post('/api/v1/auth/login').set('Origin', 'http://localhost:3000').send({ identifier: '9000000001', password: 'x' }); expect(noToken.status).toBe(403); expect(noToken.body.code).toBe('CSRF');
    const badOrigin = await cl.agent.post('/api/v1/auth/login').set('Origin', 'https://evil.example').set('X-CSRF-Token', cl.csrf).send({ identifier: '9000000001', password: 'x' }); expect(badOrigin.status).toBe(403); expect(badOrigin.body.code).toBe('BAD_ORIGIN');
  });
  it('sets an HttpOnly session cookie and a readable CSRF cookie; errors are RFC 7807 with no internals', async () => {
    const cl = await new Client(c).init(); const r = await cl.post('/auth/login', { identifier: c.demo.OWNER!.mobile, password: c.demo.OWNER!.password });
    expect(r.status).toBe(200); const cookies = (r.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/nrk_sid=[^;]+;.*HttpOnly/i); expect(cookies).toMatch(/SameSite=Lax/i); expect(cookies).not.toMatch(/nrk_csrf=[^;]+;.*HttpOnly/i);
    expect(JSON.stringify(r.body)).not.toMatch(/token|sid/i);
    const bad = await cl.post('/auth/login', { identifier: '9000000001', password: 'wrong' }); expect(bad.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(bad.body).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' }); expect(bad.body.requestId).toBeTruthy(); expect(JSON.stringify(bad.body)).not.toMatch(/stack|SELECT|at \w+\./);
  });
  it('uses the same response for unknown accounts and wrong passwords, then locks out with a growing delay', async () => {
    const cl = await new Client(c).init(); const mobile = randomMobile();
    const a = await cl.post('/auth/login', { identifier: mobile, password: 'whatever-123' }); const b = await cl.post('/auth/login', { identifier: c.demo.OWNER!.mobile, password: 'whatever-123' });
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body.code).toBe(b.body.code);
    for (let i = 0; i < 6; i++) await cl.post('/auth/login', { identifier: mobile, password: 'whatever-123' });
    const locked = await cl.post('/auth/login', { identifier: mobile, password: 'whatever-123' }); expect(locked.status).toBe(429); expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });
  it('lists sessions, revokes another session, and logs out', async () => {
    const a = await new Client(c).init(); const b = await new Client(c).init();
    await a.post('/auth/login', { identifier: c.demo.TRADER!.mobile, password: c.demo.TRADER!.password }); await b.post('/auth/login', { identifier: c.demo.TRADER!.mobile, password: c.demo.TRADER!.password });
    const list = await a.get('/auth/sessions'); expect(list.body.length).toBeGreaterThanOrEqual(2);
    const other = list.body.find((s: { current: boolean }) => !s.current); expect((await a.del(`/auth/sessions/${other.ref}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect((await a.get('/auth/session')).body.authenticated).toBe(true);
    expect((await a.post('/auth/logout')).status).toBe(200); expect((await a.get('/auth/session')).body.authenticated).toBe(false);
  });
  it('OTP login works for owners but not for staff', async () => {
    const cl = await new Client(c).init(); await clearCooldown(c, c.demo.OWNER!.mobile); const t = await cl.otp(c.demo.OWNER!.mobile, 'LOGIN'); const r = await cl.post('/auth/login/otp', { mobileToken: t });
    expect(r.status).toBe(200); expect(r.body.status).toBe('OK');
    const cl2 = await new Client(c).init(); const t2 = await cl2.otp(c.demo.OFFICER!.mobile, 'LOGIN'); expect((await cl2.post('/auth/login/otp', { mobileToken: t2 })).status).toBe(401);
  });
  it('forgot password resets through OTP and revokes old sessions', async () => {
    const { cl, mobile } = await registerUser(c); const f = await new Client(c).init(); await clearCooldown(c, mobile); const t = await f.otp(mobile, 'LOGIN');
    expect((await f.post('/auth/password/forgot', { mobile, mobileToken: t, newPassword: 'N3w-Passw0rd!-xyz' })).status).toBe(200);
    expect((await cl.get('/auth/session')).body.authenticated).toBe(false);
    expect((await f.post('/auth/login', { identifier: mobile, password: 'N3w-Passw0rd!-xyz' })).status).toBe(200);
  });
});

describe('staff: MFA, invites and step-up', () => {
  it('requires a TOTP code for staff and refuses to reuse a code', async () => {
    const cl = await new Client(c).init(); const o = c.demo.INSPECTOR!;
    const l = await cl.post('/auth/login', { identifier: o.mobile, password: o.password }); expect(l.body.status).toBe('MFA_REQUIRED'); expect((await cl.get('/auth/session')).body.authenticated).toBe(false);
    expect((await cl.post('/auth/mfa/verify', { pendingId: l.body.pendingId, code: '000000' })).status).toBe(401);
    const code = totp(o.totpSecret!, 0); expect((await cl.post('/auth/mfa/verify', { pendingId: l.body.pendingId, code })).body.status).toBe('OK');
    const l2 = await new Client(c).init(); const r2 = await l2.post('/auth/login', { identifier: o.mobile, password: o.password });
    expect((await l2.post('/auth/mfa/verify', { pendingId: r2.body.pendingId, code })).status).toBe(401); // replay
  });
  it('invites staff by a single-use signed link, forces MFA enrolment, then activates', async () => {
    const email = `new.officer.${Date.now()}@dept.example`; const wardArea = (await c.pool.query(`SELECT id FROM areas WHERE code='DIV-CEN'`)).rows[0].id;
    const inv = await admin.post('/admin/users/invite', { role: 'INSPECTOR', fullName: 'New Inspector', email, areaIds: [wardArea] }, { 'Idempotency-Key': 'inv-' + Date.now() });
    expect(inv.status).toBe(201); const link: string = inv.body._testLink; const token = link.split('/invite/')[1]!;
    expect((await new Client(c).init().then((x) => x.get(`/auth/invite/${token}`))).body.valid).toBe(true);
    expect((await new Client(c).init().then((x) => x.get(`/auth/invite/${token.slice(0, -3)}abc`))).status).toBe(404);
    const cl = await new Client(c).init(); const acc = await cl.post('/auth/invite/accept', { token, password: 'Inv1ted-Staff!-pass' });
    expect(acc.body.status).toBe('MFA_ENROL_REQUIRED');
    expect((await new Client(c).init().then((x) => x.post('/auth/invite/accept', { token, password: 'Inv1ted-Staff!-pass' }))).status).toBe(404); // single use
    const st = await cl.post('/auth/mfa/enrol/start', { pendingId: acc.body.pendingId }); expect(st.body.secret).toBeTruthy();
    expect((await cl.post('/auth/mfa/enrol/confirm', { pendingId: acc.body.pendingId, code: '000000' })).status).toBe(401);
    const done = await cl.post('/auth/mfa/enrol/confirm', { pendingId: acc.body.pendingId, code: totp(st.body.secret, 0) });
    expect(done.body.status).toBe('OK'); expect(done.body.recoveryCodes).toHaveLength(8); expect(done.body.home).toBe('/inspector/dashboard');
    const stored = (await c.pool.query(`SELECT recovery_codes, totp_secret_enc FROM local_credentials lc JOIN users u ON u.id=lc.user_id WHERE u.email_bidx=$1`, [c.crypto.blindIndex('email', email)])).rows[0];
    expect(JSON.stringify(stored.recovery_codes)).not.toContain(done.body.recoveryCodes[0]); expect(Buffer.from(stored.totp_secret_enc).includes(Buffer.from(st.body.secret))).toBe(false);
  });
  it('only admins can invite, and invites need a fresh sign-in', async () => {
    const { cl } = await registerUser(c);
    expect((await cl.post('/admin/users/invite', { role: 'OFFICER', fullName: 'X Y', email: 'x@y.example', areaIds: [] }, { 'Idempotency-Key': 'k-' + Date.now() })).status).toBe(403);
    // age the admin session so step-up is required
    for (const k of await c.redis.client.keys('sess:*')) { const d = JSON.parse((await c.redis.client.get(k))!); if (d.role === 'ADMIN') { d.authAt = Date.now() - 10 * 60 * 1000; await c.redis.client.set(k, JSON.stringify(d), 'KEEPTTL'); } }
    const r = await admin.post('/admin/users/invite', { role: 'OFFICER', fullName: 'X Y', email: `s${Date.now()}@y.example`, areaIds: [] }, { 'Idempotency-Key': 'k2-' + Date.now() });
    expect(r.status).toBe(401); expect(r.body.code).toBe('REAUTH_REQUIRED');
    expect((await admin.post('/auth/reauth', { password: c.demo.ADMIN!.password, code: totp(c.demo.ADMIN!.totpSecret!, 1) })).status).toBe(200);
    expect((await admin.post('/admin/users/invite', { role: 'OFFICER', fullName: 'X Y', email: `s2${Date.now()}@y.example`, areaIds: [] }, { 'Idempotency-Key': 'k3-' + Date.now() })).status).toBe(201);
  });
  it('suspending a user ends their sessions immediately', async () => {
    const { cl, id } = await registerUser(c); expect((await cl.get('/auth/session')).body.authenticated).toBe(true);
    const r = await admin.post(`/admin/users/${id}/action`, { action: 'SUSPEND', reason: 'test' }); expect(r.status).toBe(200);
    expect((await cl.get('/auth/session')).body.authenticated).toBe(false);
  });
  it('break-glass view needs a reason and is audited', async () => {
    const { id } = await registerUser(c);
    expect((await admin.post(`/admin/users/${id}/break-glass`, { reason: 'short' })).status).toBe(422);
    const r = await admin.post(`/admin/users/${id}/break-glass`, { reason: 'Verifying identity for a grievance case' }); expect(r.status).toBe(200); expect(r.body.fullName).toBe('Test Person');
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='admin.break_glass_view' AND entity_id=$1`, [id])).rowCount).toBe(1);
  });
});

describe('audit trail', () => {
  it('is hash-chained and intact, and cannot be changed by the application role', async () => {
    const v = await admin.post('/admin/audit/verify-chain'); expect(v.status).toBe(200); expect(v.body.intact).toBe(true); expect(v.body.checked).toBeGreaterThan(5);
    const client = await c.pool.connect();
    try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE nirikshan_app'); await expect(client.query(`UPDATE audit_events SET action='x'`)).rejects.toThrow(); } finally { await client.query('ROLLBACK'); client.release(); }
    // UUIDs are removed first: a random UUID can contain ten decimal digits in a row, which is not a phone number
    const logs = (await c.pool.query(`SELECT details::text AS d FROM audit_events WHERE regexp_replace(details::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'g') ~ '[0-9]{10}|@'`)).rows; expect(logs.length).toBe(0); // no phone numbers or emails in audit details
  });
  it('owners see only their own audit entries', async () => {
    const { cl, id } = await registerUser(c); await activate(c, id); const r = await cl.get('/audit'); expect(r.status).toBe(200);
    expect(r.body.items.every((e: { actorId: string }) => e.actorId === id)).toBe(true);
  });
});
