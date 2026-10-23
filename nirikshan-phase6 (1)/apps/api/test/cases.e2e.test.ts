import { randomInt } from 'crypto';
import { addDays, istDay } from '@nirikshan/shared';
import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody, API, ORIGIN } from './helpers';

let c: Ctx; let officer: Client; let admin: Client; let trader: Client; let insp1: Client; let insp2: Client;
let owner: { cl: Client; id: string }; let other: { cl: Client; id: string };
let cat: Awaited<ReturnType<typeof catalog>>; let docType: Record<string, string> = {}; let inspId: Record<string, string> = {};
let n = 0; const key = () => `p3-${Date.now()}-${n++}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const userIdByMobile = async (m: string) => (await c.pool.query('SELECT id FROM users WHERE mobile_bidx=$1', [c.crypto.blindIndex('mobile', m)])).rows[0].id as string;
async function newInstrument(cl: Client, over: Record<string, unknown> = {}) {
  const tok = await cl.confirmToken(); const r = await cl.post('/instruments', instrumentBody(c, cat, tok, over), { 'Idempotency-Key': key() }); if (r.status !== 201) throw new Error('instrument ' + JSON.stringify(r.body)); return r.body.id as string;
}
async function apply(cl: Client, instrumentId: string, over: Record<string, unknown> = {}) { return cl.post('/applications', { instrumentId, type: 'NEW', declarationAccepted: true, ...over }, { 'Idempotency-Key': key() }); }
function upload(cl: Client, appId: string, typeCode: string, buf: Buffer = PDF, name = 'doc.pdf') {
  return cl.agent.post(`${API}/applications/${appId}/documents`).set('X-Forwarded-For', cl.ip).set('Origin', ORIGIN).set('X-CSRF-Token', cl.csrf).field('documentTypeId', docType[typeCode]!).attach('file', buf, { filename: name });
}
async function docsOf(appId: string) { return ((await officer.get(`/officer/cases/${appId}`)).body.documents as { code: string; current: { id: string } | null }[]).filter((d) => d.current); }
async function acceptAll(appId: string) { for (const d of await docsOf(appId)) expect((await officer.post(`/officer/cases/${appId}/documents/${d.current!.id}/review`, { status: 'ACCEPTED' })).status).toBe(200); }
/** A case with both required documents uploaded and accepted, still waiting for "document check complete". */
async function readyCase(cl = owner.cl, instrumentOver: Record<string, unknown> = {}) {
  for (const k of await c.redis.client.keys('rl:doc-upload*')) await c.redis.client.del(k);
  const instrumentId = await newInstrument(cl, instrumentOver); const a = await apply(cl, instrumentId); expect(a.status).toBe(201);
  expect((await upload(cl, a.body.id, 'INVOICE')).status).toBe(201); expect((await upload(cl, a.body.id, 'INSTRUMENT_PHOTO')).status).toBe(201);
  await acceptAll(a.body.id); return { instrumentId, appId: a.body.id as string, appNo: a.body.applicationNo as string };
}
async function scheduledCase(cl = owner.cl) { const k = await readyCase(cl); const r = await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() }); return { ...k, r }; }
const visitOf = async (appId: string) => (await c.pool.query(`SELECT * FROM inspection_visits WHERE application_id=$1 AND status IN ('SCHEDULED','IN_PROGRESS') ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
const notifs = async (userId: string, ev: string) => (await c.pool.query('SELECT body, deep_link FROM in_app_notifications WHERE user_id=$1 AND event_code=$2', [userId, ev])).rows;
const resetAvail = () => c.pool.query('DELETE FROM inspector_availability');

beforeAll(async () => {
  c = await boot();
  officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1); admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1);
  insp1 = await new Client(c).init(); await insp1.loginStaff(c.demo.INSPECTOR!, -1); insp2 = await new Client(c).init(); await insp2.loginStaff(c.demo.INSPECTOR2!, -1);
  trader = await new Client(c).init(); await trader.post('/auth/login', { identifier: c.demo.TRADER!.mobile, password: c.demo.TRADER!.password });
  const a = await registerUser(c); await activate(c, a.id); owner = a; const b = await registerUser(c); await activate(c, b.id); other = b;
  cat = await catalog(owner.cl);
  for (const r of (await c.pool.query('SELECT id, code FROM document_types')).rows) docType[r.code] = r.id;
  inspId = { one: await userIdByMobile(c.demo.INSPECTOR!.mobile), two: await userIdByMobile(c.demo.INSPECTOR2!.mobile) };
});
afterAll(() => shutdown(c));
afterEach(async () => { await resetAvail(); await c.pool.query('UPDATE inspector_profiles SET daily_capacity=4'); });

describe('applying', () => {
  it('pre-check shows blockers, required documents and server-calculated dates; the client cannot set dates', async () => {
    const id = await newInstrument(owner.cl);
    const pc = await owner.cl.get(`/instruments/${id}/precheck?type=NEW`); expect(pc.status).toBe(200);
    expect(pc.body.eligible).toBe(true); expect(pc.body.requiredDocuments.filter((d: { required: boolean }) => d.required).map((d: { code: string }) => d.code).sort()).toEqual(['INSTRUMENT_PHOTO', 'INVOICE']);
    expect(pc.body.due.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(JSON.stringify(pc.body).toLowerCase()).not.toMatch(/"[a-z]*(fee|payment|amount)[a-z]*"\s*:/); // keys only: a random UUID can contain the letters "fee"
    expect((await owner.cl.get(`/instruments/${id}/precheck?type=RENEWAL`)).body.blockers).toContain('NOT_YET_VERIFIED');
    expect((await other.cl.get(`/instruments/${id}/precheck?type=NEW`)).status).toBe(404);
    const sneaky = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true, dueDate: '2030-01-01' }, { 'Idempotency-Key': key() }); expect(sneaky.status).toBe(422);
    const noDecl = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: false }, { 'Idempotency-Key': key() }); expect(noDecl.status).toBe(422);
  });
  it('creates one case per instrument, pins the rule version, notifies owner and officers, and refuses a second open case', async () => {
    const id = await newInstrument(owner.cl); const k = key();
    const a = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': k });
    expect(a.status).toBe(201); expect(a.body.applicationNo).toMatch(/^NRK-APP-\d{8}$/);
    const replay = await owner.cl.post('/applications', { instrumentId: id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': k }); expect(replay.body.id).toBe(a.body.id);
    const row = (await c.pool.query(`SELECT a.status, a.rule_set_id, a.due_date, (SELECT id FROM rule_sets WHERE status='PUBLISHED') AS current FROM applications a WHERE a.id=$1`, [a.body.id])).rows[0];
    expect(row.status).toBe('APPLIED'); expect(row.rule_set_id).toBe(row.current); expect(row.due_date).toBeTruthy();
    const second = await apply(owner.cl, id); expect(second.status).toBe(409); expect(second.body.code).toBe('OPEN_APPLICATION_EXISTS');
    expect((await notifs(owner.id, 'APPLICATION_RECEIVED')).some((x) => x.body.includes(a.body.applicationNo))).toBe(true);
    const off = await userIdByMobile(c.demo.OFFICER!.mobile); expect((await notifs(off, 'APPLICATION_NEW')).some((x) => x.body.includes(a.body.applicationNo))).toBe(true);
    expect((await notifs(owner.id, 'APPLICATION_RECEIVED')).every((x) => !/Sharma|Market Road|Test Person/.test(x.body))).toBe(true); // application number and link only
    const hist = await c.pool.query('SELECT action FROM case_status_history WHERE application_id=$1', [a.body.id]); expect(hist.rows.map((r) => r.action)).toEqual(['apply']);
  });
  it('another owner cannot apply for, see or upload to this instrument or case', async () => {
    const id = await newInstrument(owner.cl); const a = await apply(owner.cl, id);
    expect((await apply(other.cl, id)).status).toBe(404);
    expect((await other.cl.get(`/applications/${a.body.id}`)).status).toBe(404);
    expect((await upload(other.cl, a.body.id, 'INVOICE')).status).toBe(404);
    expect((await other.cl.post(`/applications/${a.body.id}/cancel`, { reason: 'not mine' })).status).toBe(404);
    expect((await other.cl.get('/applications')).body.items.find((i: { id: string }) => i.id === a.body.id)).toBeUndefined();
    expect((await insp1.get(`/applications/${a.body.id}`)).status).toBe(403);
  });
  it('trader batch apply creates one case each and rejects mixed categories', async () => {
    const mine = await trader.get('/me'); expect(mine.status).toBe(200);
    const ids: string[] = []; for (let i = 0; i < 2; i++) ids.push(await newInstrument(trader));
    const r = await trader.post('/applications/batch', { instrumentIds: ids, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    expect(r.status).toBe(201); expect(r.body.created).toHaveLength(2); expect(r.body.failed).toHaveLength(0);
    const again = await trader.post('/applications/batch', { instrumentIds: ids, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() }); expect(again.body.failed.map((f: { code: string }) => f.code)).toEqual(['OPEN_APPLICATION_EXISTS', 'OPEN_APPLICATION_EXISTS']);
    expect((await owner.cl.post('/applications/batch', { instrumentIds: ids, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() })).status).toBe(403);
  });
  it('cancel works while APPLIED, needs a reason, and is refused once scheduled', async () => {
    const id = await newInstrument(owner.cl); const a = await apply(owner.cl, id);
    expect((await owner.cl.post(`/applications/${a.body.id}/cancel`, {})).status).toBe(422);
    expect((await owner.cl.post(`/applications/${a.body.id}/cancel`, { reason: 'Sold the instrument' })).status).toBe(200);
    expect((await owner.cl.get(`/applications/${a.body.id}`)).body.status).toBe('CANCELLED');
    expect((await apply(owner.cl, id)).status).toBe(201); // a cancelled case frees the instrument
    const s = await scheduledCase(); expect(s.r.body.scheduling.mode).toBe('AUTO');
    const late = await owner.cl.post(`/applications/${s.appId}/cancel`, { reason: 'Changed my mind' }); expect(late.status).toBe(409); expect(late.body.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('documents', () => {
  it('checks real file type, size and malware; versions replacements; locks after the check', async () => {
    const id = await newInstrument(owner.cl); const a = await apply(owner.cl, id); const app = a.body.id as string;
    const fake = await upload(owner.cl, app, 'INVOICE', Buffer.from('MZ not a pdf at all'), 'invoice.pdf'); expect(fake.status).toBe(422); expect(fake.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    const eicar = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n'); const inf = await upload(owner.cl, app, 'INVOICE', eicar); expect(inf.status).toBe(422); expect(inf.body.code).toBe('FILE_INFECTED');
    const js = await upload(owner.cl, app, 'INVOICE', Buffer.from('%PDF-1.4\n<< /JavaScript (app.alert(1)) >>\n')); expect(js.body.code).toBe('FILE_INFECTED');
    const big = await upload(owner.cl, app, 'INVOICE', Buffer.concat([PDF, Buffer.alloc(5.5 * 1024 * 1024)])); expect([413, 422]).toContain(big.status);
    const v1 = await upload(owner.cl, app, 'INVOICE'); expect(v1.status).toBe(201); expect(v1.body.version).toBe(1);
    const v2 = await upload(owner.cl, app, 'INVOICE', Buffer.concat([PDF, Buffer.from('v2')])); expect(v2.body.version).toBe(2);
    const rows = (await c.pool.query('SELECT doc_version, superseded FROM application_documents WHERE application_id=$1 ORDER BY doc_version', [app])).rows; expect(rows).toEqual([{ doc_version: 1, superseded: true }, { doc_version: 2, superseded: false }]);
    expect((await c.pool.query('SELECT object_key, original_name_enc FROM application_documents WHERE application_id=$1', [app])).rows.every((r) => !r.object_key.includes('invoice') && Buffer.isBuffer(r.original_name_enc))).toBe(true);
    expect((await upload(officer, app, 'INVOICE')).status).toBe(403);
    expect((await owner.cl.post(`/applications/${app}/documents`, {})).status).toBe(422);
  });
  it('officer flags with a comment, owner sees it and is notified, replacement resets review, the check completes only when all are accepted', async () => {
    const id = await newInstrument(owner.cl); const a = await apply(owner.cl, id); const app = a.body.id as string;
    const early = await officer.post(`/officer/cases/${app}/document-check-complete`, {}, { 'Idempotency-Key': key() }); expect(early.status).toBe(422); expect(early.body.code).toBe('DOCUMENTS_INCOMPLETE'); expect(early.body.blockers.some((b: string) => b.startsWith('MISSING:'))).toBe(true);
    await upload(owner.cl, app, 'INVOICE'); await upload(owner.cl, app, 'INSTRUMENT_PHOTO');
    const docs = await docsOf(app); const inv = docs.find((d) => d.code === 'INVOICE')!;
    expect((await officer.post(`/officer/cases/${app}/documents/${inv.current!.id}/review`, { status: 'FLAGGED' })).status).toBe(422);
    expect((await officer.post(`/officer/cases/${app}/documents/${inv.current!.id}/review`, { status: 'FLAGGED', comment: 'Invoice date is cut off', reasonCode: 'DOC_ILLEGIBLE' })).status).toBe(200);
    const seen = (await owner.cl.get(`/applications/${app}`)).body.documents.find((d: { code: string }) => d.code === 'INVOICE'); expect(seen.current.review).toBe('FLAGGED'); expect(seen.current.comment).toBe('Invoice date is cut off');
    expect((await notifs(owner.id, 'DOCUMENTS_FLAGGED')).length).toBeGreaterThan(0);
    const ph = docs.find((d) => d.code === 'INSTRUMENT_PHOTO')!; await officer.post(`/officer/cases/${app}/documents/${ph.current!.id}/review`, { status: 'ACCEPTED' });
    const blocked = await officer.post(`/officer/cases/${app}/document-check-complete`, {}, { 'Idempotency-Key': key() }); expect(blocked.status).toBe(422); expect(blocked.body.blockers).toContain(`NOT_ACCEPTED:${docType.INVOICE}`);
    await upload(owner.cl, app, 'INVOICE', Buffer.concat([PDF, Buffer.from('fixed')]));
    expect((await owner.cl.get(`/applications/${app}`)).body.documents.find((d: { code: string }) => d.code === 'INVOICE').current.review).toBe('PENDING');
    await acceptAll(app); const ok = await officer.post(`/officer/cases/${app}/document-check-complete`, {}, { 'Idempotency-Key': key() }); expect(ok.status).toBe(200); expect(ok.body.status).toBe('DOCUMENT_CHECKED');
    const locked = await upload(owner.cl, app, 'INVOICE'); expect(locked.status).toBe(409); expect(locked.body.code).toBe('DOCUMENTS_LOCKED');
    expect((await officer.post(`/officer/cases/${app}/document-check-complete`, {}, { 'Idempotency-Key': key() })).status).toBe(409);
  });
  it('document links are short-lived, audited, and limited to people who can see the case', async () => {
    const k = await readyCase(); const d = (await docsOf(k.appId))[0]!.current!.id;
    const before = Number((await c.pool.query(`SELECT count(*) FROM audit_events WHERE action='document.link_issued'`)).rows[0].count);
    const link = await owner.cl.get(`/applications/${k.appId}/documents/${d}/link`); expect(link.status).toBe(200); expect(link.body.expiresInSec).toBeLessThanOrEqual(300);
    const file = await owner.cl.agent.get(link.body.url).set('X-Forwarded-For', owner.cl.ip); expect(file.status).toBe(200); expect(file.headers['content-disposition']).toBe('attachment'); expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect((await officer.get(`/applications/${k.appId}/documents/${d}/link`)).status).toBe(200);
    expect((await other.cl.get(`/applications/${k.appId}/documents/${d}/link`)).status).toBe(404);
    expect(Number((await c.pool.query(`SELECT count(*) FROM audit_events WHERE action='document.link_issued'`)).rows[0].count)).toBe(before + 2);
  });
});

describe('scheduling engine', () => {
  it('auto-assigns after the document check: visit created, state moved, score stored, everybody notified, owner view updated', async () => {
    const s = await scheduledCase(); expect(s.r.status).toBe(200); expect(s.r.body.scheduling.mode).toBe('AUTO');
    const v = await visitOf(s.appId); expect(v).toBeTruthy(); expect(v.assigned_by).toBeNull();
    expect(v.score_breakdown.total).toBeGreaterThan(0); expect(Object.keys(v.score_breakdown.parts).sort()).toEqual(['distance', 'noRepeat', 'specialisation', 'success', 'workload']);
    const start = new Date(v.scheduled_window.match(/"([^"]+)",/)?.[1] ?? Date.now()); void start;
    const row = (await c.pool.query(`SELECT status, schedule_mode FROM applications WHERE id=$1`, [s.appId])).rows[0]; expect(row).toEqual({ status: 'SCHEDULED', schedule_mode: 'AUTO' });
    expect((await notifs(owner.id, 'VISIT_SCHEDULED')).some((x) => x.body.includes(s.appNo))).toBe(true);
    expect((await notifs(v.inspector_id, 'VISIT_ASSIGNED')).some((x) => x.body.includes(s.appNo))).toBe(true);
    const mine = await (v.inspector_id === inspId.one ? insp1 : insp2).get('/inspector/visits'); expect(mine.body.map((x: { applicationNo: string }) => x.applicationNo)).toContain(s.appNo);
    const theirs = await (v.inspector_id === inspId.one ? insp2 : insp1).get('/inspector/visits'); expect(theirs.body.map((x: { applicationNo: string }) => x.applicationNo)).not.toContain(s.appNo);
    const d = await owner.cl.get(`/applications/${s.appId}`); expect(d.body.status).toBe('SCHEDULED'); expect(d.body.visit.start).toBeTruthy(); expect(d.body.stepper.current).toBe(3);
    expect(d.body.timeline.map((t: { action: string }) => t.action)).toEqual(['apply', 'document.accepted', 'document.accepted', 'documentCheckComplete', 'assign']); expect(JSON.stringify(d.body)).not.toMatch(/score|breakdown|inspectorId/);
    const day = istDay(new Date(d.body.visit.start)); const tomorrow = addDays(istDay(new Date()), 1); expect(day >= tomorrow).toBe(true); expect(new Date(day + 'T12:00:00+05:30').getUTCDay()).not.toBe(0);
    const staff = await officer.get(`/officer/cases/${s.appId}`); expect(staff.body.visit.breakdown.total).toBe(v.score_breakdown.total); expect(staff.body.timeline.length).toBeGreaterThanOrEqual(3);
  });
  it('polling with If-None-Match returns 304 until something changes', async () => {
    const k = await readyCase(); const first = await owner.cl.get(`/applications/${k.appId}`); const etag = first.headers.etag as string; expect(etag).toBeTruthy();
    const same = await owner.cl.agent.get(`${API}/applications/${k.appId}`).set('X-Forwarded-For', owner.cl.ip).set('If-None-Match', etag); expect(same.status).toBe(304);
    await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() });
    const changed = await owner.cl.agent.get(`${API}/applications/${k.appId}`).set('X-Forwarded-For', owner.cl.ip).set('If-None-Match', etag); expect(changed.status).toBe(200); expect(changed.headers.etag).not.toBe(etag);
  });
  it('never gives one inspector more cases per day than their capacity', async () => {
    await c.pool.query('UPDATE inspector_profiles SET daily_capacity=1'); const days = new Map<string, number>();
    // The engine sends a case to officer review when the free slot would fall outside the service deadline (for example right before a weekend),
    // so the number of automatic bookings depends on the day this runs. The rule being tested is only that capacity is never exceeded.
    let auto = 0;
    for (let i = 0; i < 4; i++) { const s = await scheduledCase(); if (s.r.body.scheduling.mode !== 'AUTO') continue; auto++; const v = await visitOf(s.appId); const day = istDay(new Date((await owner.cl.get(`/applications/${s.appId}`)).body.visit.start)); const k = `${v.inspector_id}:${day}`; days.set(k, (days.get(k) ?? 0) + 1); }
    expect(auto).toBeGreaterThanOrEqual(2); expect([...days.values()].every((x) => x === 1)).toBe(true); expect(days.size).toBe(auto);
  });
  it('skips holidays and inspector leave', async () => {
    const s0 = await scheduledCase(); const first = istDay(new Date((await owner.cl.get(`/applications/${s0.appId}`)).body.visit.start));
    await c.pool.query(`INSERT INTO holiday_calendar (area_id, holiday_date, name) VALUES (NULL,$1,'Test holiday')`, [first]);
    try { const s = await scheduledCase(); const day = istDay(new Date((await owner.cl.get(`/applications/${s.appId}`)).body.visit.start)); expect(day).not.toBe(first); expect(day > first).toBe(true); }
    finally { await c.pool.query(`DELETE FROM holiday_calendar WHERE name='Test holiday'`); }
    for (const id of [inspId.one, inspId.two]) expect((await officer.post(`/officer/inspectors/${id}/availability`, { kind: 'LEAVE', from: first, to: addDays(first, 4), reason: 'Training' })).status).toBe(201);
    // Five days of leave pushes the first free slot past the 72 h scheduling SLA, so the engine proposes it and waits for an officer instead of assigning.
    const k2 = await readyCase(); const r2 = await officer.post(`/officer/cases/${k2.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() });
    expect(r2.body.scheduling.mode).toBe('REVIEW'); expect(r2.body.scheduling.reasons).toContain('OUTSIDE_SLA');
    const prop = (await officer.get(`/officer/cases/${k2.appId}`)).body.proposal; expect(istDay(new Date(prop.start)) > addDays(first, 4)).toBe(true);
  });
  it('leave entered after assignment hands the visit back to the queue and the engine finds a new slot', async () => {
    const s = await scheduledCase(); const day = istDay(new Date((await owner.cl.get(`/applications/${s.appId}`)).body.visit.start)); const v0 = await visitOf(s.appId);
    const r = await officer.post(`/officer/inspectors/${v0.inspector_id}/availability`, { kind: 'LEAVE', from: day, to: day, reason: 'Sick leave' }); expect(r.status).toBe(201); expect(r.body.affected.some((x: { applicationId: string }) => x.applicationId === s.appId)).toBe(true);
    const v1 = await visitOf(s.appId); expect(v1).toBeTruthy(); expect(v1.id).not.toBe(v0.id);
    const old = (await c.pool.query('SELECT status FROM inspection_visits WHERE id=$1', [v0.id])).rows[0]; expect(old.status).toBe('SUPERSEDED');
    expect((await notifs(owner.id, 'VISIT_RESCHEDULED')).some((x) => x.body.includes(s.appNo))).toBe(true);
  });
  it('with nobody available the case waits for an officer (REVIEW), shows why, and the officer can retry or assign', async () => {
    const from = istDay(new Date()); for (const id of [inspId.one, inspId.two]) await officer.post(`/officer/inspectors/${id}/availability`, { kind: 'UNAVAILABLE', from, to: addDays(from, 40), reason: 'Audit' });
    const k = await readyCase(); const r = await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() });
    expect(r.body.scheduling.mode).toBe('REVIEW'); expect(r.body.scheduling.reasons).toContain('NO_CANDIDATE');
    const d = await officer.get(`/officer/cases/${k.appId}`); expect(d.body.status).toBe('DOCUMENT_CHECKED'); expect(d.body.proposal.reasons).toContain('NO_CANDIDATE'); expect(d.body.scheduleMode).toBe('REVIEW');
    expect((await owner.cl.get(`/applications/${k.appId}`)).body.waitingForOfficer).toBe(true);
    const off = await userIdByMobile(c.demo.OFFICER!.mobile); expect((await notifs(off, 'SCHEDULE_REVIEW_NEEDED')).some((x) => x.body.includes(k.appNo))).toBe(true);
    const list = await officer.get('/officer/cases?status=DOCUMENT_CHECKED'); expect(list.body.items.find((i: { id: string }) => i.id === k.appId).needsReview).toBe(true);
    await resetAvail(); const retry = await officer.post(`/officer/cases/${k.appId}/schedule`, {}); expect(retry.body.mode).toBe('AUTO');
    expect((await c.pool.query(`SELECT status FROM schedule_proposals WHERE application_id=$1`, [k.appId])).rows.map((x) => x.status)).toContain('ACCEPTED');
  });
  it('a low score is proposed, not assigned, until an officer accepts it', async () => {
    await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=101`);
    try {
      const k = await readyCase(); const r = await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() }); expect(r.body.scheduling.mode).toBe('REVIEW'); expect(r.body.scheduling.reasons).toContain('LOW_SCORE');
      expect((await visitOf(k.appId))).toBeUndefined();
      const acc = await officer.post(`/officer/cases/${k.appId}/proposal/accept`, {}, { 'Idempotency-Key': key() }); expect(acc.status).toBe(200);
      expect((await c.pool.query(`SELECT status, schedule_mode FROM applications WHERE id=$1`, [k.appId])).rows[0]).toEqual({ status: 'SCHEDULED', schedule_mode: 'REVIEW' });
      expect((await visitOf(k.appId)).assigned_by).toBeTruthy();
    } finally { await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=50`); }
  });
});

describe('manual assignment and the double-booking guard', () => {
  const slot = (dayOffset: number, hour: number) => { const d = addDays(istDay(new Date()), dayOffset); return { windowStart: new Date(`${d}T${String(hour).padStart(2, '0')}:00:00+05:30`).toISOString(), windowEnd: new Date(`${d}T${String(hour + 2).padStart(2, '0')}:00:00+05:30`).toISOString() }; };
  const workday = () => { let o = 5; while (new Date(addDays(istDay(new Date()), o) + 'T12:00:00+05:30').getUTCDay() === 0) o++; return o; };
  it('the database refuses overlapping live visits for one inspector, even when the code is bypassed', async () => {
    const a = await readyCase(); const b = await readyCase(); const w = slot(30, 10);
    await c.pool.query(`INSERT INTO inspection_visits (application_id, inspector_id, scheduled_window) VALUES ($1,$2,tstzrange($3::timestamptz,$4::timestamptz))`, [a.appId, inspId.one, w.windowStart, w.windowEnd]);
    await expect(c.pool.query(`INSERT INTO inspection_visits (application_id, inspector_id, scheduled_window) VALUES ($1,$2,tstzrange($3::timestamptz,$4::timestamptz))`, [b.appId, inspId.one, w.windowStart, w.windowEnd])).rejects.toMatchObject({ code: '23P01' });
    await c.pool.query(`DELETE FROM inspection_visits WHERE application_id=$1`, [a.appId]);
  });
  it('two officers racing for the same slot: exactly one wins, the other gets 409 SLOT_TAKEN', async () => {
    const a = await readyCase(); const b = await readyCase(); for (const k of [a, b]) await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() });
    await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=101`); // (cases above were already auto-assigned or not; make both free for a manual race)
    await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=50`);
    const x = await readyCase(); const y = await readyCase(); await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=101`);
    try { for (const k of [x, y]) await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() }); } finally { await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=50`); }
    const w = slot(workday(), 14);
    const res = await Promise.all([x, y].map((k) => officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.one, ...w }, { 'Idempotency-Key': key() })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]); expect(res.find((r) => r.status === 409)!.body.code).toBe('SLOT_TAKEN');
  });
  it('validates the manual choice: skill, leave, holiday, past window, wrong state', async () => {
    await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=101`);
    let k: Awaited<ReturnType<typeof readyCase>>;
    try { k = await readyCase(); await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() }); } finally { await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=50`); }
    const w = slot(workday(), 10);
    expect((await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.one, windowStart: new Date(Date.now() - 3600_000).toISOString(), windowEnd: new Date(Date.now() + 3600_000).toISOString() }, { 'Idempotency-Key': key() })).body.code).toBe('WINDOW_IN_PAST');
    expect((await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.one, windowStart: w.windowStart, windowEnd: new Date(new Date(w.windowStart).getTime() + 9 * 3600_000).toISOString() }, { 'Idempotency-Key': key() })).body.code).toBe('INVALID_WINDOW');
    const skill = (await c.pool.query('SELECT category_id, certified_until FROM inspector_skills WHERE inspector_id=$1', [inspId.two])).rows; await c.pool.query('DELETE FROM inspector_skills WHERE inspector_id=$1', [inspId.two]);
    try { const r = await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.two, ...w }, { 'Idempotency-Key': key() }); expect(r.status).toBe(422); expect(r.body.code).toBe('NO_SKILL'); }
    finally { for (const s of skill) await c.pool.query('INSERT INTO inspector_skills (inspector_id, category_id, certified_until) VALUES ($1,$2,$3)', [inspId.two, s.category_id, s.certified_until]); }
    const day = istDay(new Date(w.windowStart)); await c.pool.query(`INSERT INTO holiday_calendar (area_id, holiday_date, name) VALUES (NULL,$1,'Test holiday')`, [day]);
    try { expect((await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.one, ...w }, { 'Idempotency-Key': key() })).body.code).toBe('HOLIDAY'); } finally { await c.pool.query(`DELETE FROM holiday_calendar WHERE name='Test holiday'`); }
    await officer.post(`/officer/inspectors/${inspId.one}/availability`, { kind: 'LEAVE', from: day, to: day, reason: 'Leave' });
    expect((await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.one, ...w }, { 'Idempotency-Key': key() })).body.code).toBe('INSPECTOR_UNAVAILABLE');
    expect((await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.two, ...w }, { 'Idempotency-Key': key() })).status).toBe(200);
    const again = await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.two, ...slot(workday() + 1, 10) }, { 'Idempotency-Key': key() }); expect(again.status).toBe(409); expect(again.body.code).toBe('ILLEGAL_TRANSITION');
  });
  it('an out-of-jurisdiction inspector needs a recorded reason, and the choice is audited', async () => {
    await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=101`);
    let k: Awaited<ReturnType<typeof readyCase>>;
    try { k = await readyCase(); await officer.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() }); } finally { await c.pool.query(`UPDATE scheduling_settings SET auto_threshold=50`); }
    const scopes = (await c.pool.query('SELECT area_id FROM user_area_scopes WHERE user_id=$1', [inspId.two])).rows;
    await c.pool.query('DELETE FROM user_area_scopes WHERE user_id=$1', [inspId.two]);
    try {
      const w = slot(workday() + 2, 10);
      const no = await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.two, ...w }, { 'Idempotency-Key': key() }); expect(no.status).toBe(422); expect(no.body.code).toBe('OUT_OF_JURISDICTION_REASON_REQUIRED');
      const yes = await officer.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.two, ...w, outOfJurisdictionReason: 'Only certified inspector available' }, { 'Idempotency-Key': key() }); expect(yes.status).toBe(200);
      expect((await visitOf(k.appId)).out_of_jurisdiction).toBe(true);
      expect(Number((await c.pool.query(`SELECT count(*) FROM audit_events WHERE action='visit.out_of_jurisdiction'`)).rows[0].count)).toBeGreaterThan(0);
    } finally { for (const s of scopes) await c.pool.query('INSERT INTO user_area_scopes (user_id, area_id) VALUES ($1,$2)', [inspId.two, s.area_id]); }
  });
});

describe('reschedule, no-show and bulk changes', () => {
  it('owner requests a new date; officer approves and the engine moves the visit; a decline needs a reason', async () => {
    const s = await scheduledCase(); const v0 = await visitOf(s.appId); const tomorrow = istDay(new Date());
    expect((await owner.cl.post(`/applications/${s.appId}/reschedule-request`, { reason: 'We are closed that day', preferredFrom: tomorrow })).status).toBe(422);
    const when = addDays(tomorrow, 10); const req = await owner.cl.post(`/applications/${s.appId}/reschedule-request`, { reason: 'We are closed that day', preferredFrom: when, preferredTo: addDays(when, 3) }); expect(req.status).toBe(201);
    expect((await owner.cl.post(`/applications/${s.appId}/reschedule-request`, { reason: 'Again', preferredFrom: when })).body.code).toBe('RESCHEDULE_ALREADY_REQUESTED');
    const off = await userIdByMobile(c.demo.OFFICER!.mobile); expect((await notifs(off, 'RESCHEDULE_REQUESTED')).length).toBeGreaterThan(0);
    expect((await officer.get('/officer/cases/summary')).body.rescheduleRequests).toBeGreaterThan(0);
    expect((await officer.post(`/officer/cases/${s.appId}/reschedule-request/decision`, { outcome: 'REJECTED' })).status).toBe(422);
    const ok = await officer.post(`/officer/cases/${s.appId}/reschedule-request/decision`, { outcome: 'APPROVED' }); expect(ok.status).toBe(200);
    const v1 = await visitOf(s.appId); expect(v1.id).not.toBe(v0.id); const day = istDay(new Date((await owner.cl.get(`/applications/${s.appId}`)).body.visit.start)); expect(day >= when).toBe(true); expect(day <= addDays(when, 3)).toBe(true);
    expect((await owner.cl.get(`/applications/${s.appId}`)).body.rescheduleRequest.status).toBe('APPROVED');
    expect((await notifs(owner.id, 'RESCHEDULE_DECIDED')).length).toBeGreaterThan(0);
    const s2 = await scheduledCase(); await owner.cl.post(`/applications/${s2.appId}/reschedule-request`, { reason: 'Away', preferredFrom: when });
    const no = await officer.post(`/officer/cases/${s2.appId}/reschedule-request/decision`, { outcome: 'REJECTED', reason: 'Slots are fully booked then' }); expect(no.status).toBe(200);
    expect((await visitOf(s2.appId)).id).toBeTruthy(); expect((await owner.cl.get(`/applications/${s2.appId}`)).body.rescheduleRequest.note).toBe('Slots are fully booked then');
    const n = await owner.cl.post(`/applications/${s2.appId}/reschedule-request`, { reason: 'Away again', preferredFrom: when }); expect(n.status).toBe(201);
  });
  it('officer moves a visit by hand or lets the engine choose; the old slot is freed', async () => {
    const s = await scheduledCase(); const v0 = await visitOf(s.appId);
    const auto = await officer.post(`/officer/cases/${s.appId}/reschedule`, { reason: 'Inspector reassigned' }, { 'Idempotency-Key': key() }); expect(auto.status).toBe(200); expect(auto.body.mode).toBe('AUTO');
    expect((await c.pool.query('SELECT status FROM inspection_visits WHERE id=$1', [v0.id])).rows[0].status).toBe('SUPERSEDED');
    expect((await officer.post(`/officer/cases/${s.appId}/reschedule`, { reason: 'x' }, { 'Idempotency-Key': key() })).status).toBe(422);
    const d = addDays(istDay(new Date()), 40); const man = await officer.post(`/officer/cases/${s.appId}/reschedule`, { reason: 'Owner asked by phone', inspectorId: inspId.two, windowStart: new Date(`${d}T10:00:00+05:30`).toISOString(), windowEnd: new Date(`${d}T12:00:00+05:30`).toISOString() }, { 'Idempotency-Key': key() });
    expect([200, 422]).toContain(man.status); // 422 only if day 40 happens to be a holiday or Sunday-only rule; both are valid outcomes of the rule check
    if (man.status === 200) expect((await visitOf(s.appId)).inspector_id).toBe(inspId.two);
  });
  it('a no-show returns the case to the queue and re-books; after the attempt limit it waits for an officer', async () => {
    const s = await scheduledCase(); const max = (await c.pool.query('SELECT max_failed_attempts FROM scheduling_settings')).rows[0].max_failed_attempts as number;
    for (let i = 1; i < max; i++) {
      const r = await officer.post(`/officer/cases/${s.appId}/no-show`, { note: 'Premises closed' }, { 'Idempotency-Key': key() }); expect(r.status).toBe(200); expect(r.body.attemptsExhausted).toBe(false); expect(r.body.scheduling.mode).toBe('AUTO');
      expect((await c.pool.query('SELECT status, failed_attempts FROM applications WHERE id=$1', [s.appId])).rows[0]).toEqual({ status: 'SCHEDULED', failed_attempts: i });
    }
    const last = await officer.post(`/officer/cases/${s.appId}/no-show`, {}, { 'Idempotency-Key': key() }); expect(last.body.attemptsExhausted).toBe(true);
    expect((await c.pool.query('SELECT status, failed_attempts FROM applications WHERE id=$1', [s.appId])).rows[0]).toEqual({ status: 'FAILED_ATTEMPT', failed_attempts: max });
    const off = await userIdByMobile(c.demo.OFFICER!.mobile); expect((await notifs(off, 'ATTEMPTS_EXHAUSTED')).some((x) => x.body.includes(s.appNo))).toBe(true);
    expect((await notifs(owner.id, 'VISIT_NOSHOW')).length).toBeGreaterThan(0);
    expect((await officer.post(`/officer/cases/${s.appId}/no-show`, {}, { 'Idempotency-Key': key() })).body.code).toBe('NO_OPEN_VISIT');
    const again = await officer.post(`/officer/cases/${s.appId}/schedule`, {}); expect(again.body.mode).toBe('AUTO'); // an officer can still decide to try once more
  });
  it('bulk reschedule previews first, moves every visit on the day, never into that day, and is audited', async () => {
    const s1 = await scheduledCase(); const s2 = await scheduledCase();
    const day = istDay(new Date((await owner.cl.get(`/applications/${s1.appId}`)).body.visit.start)); const area = c.wards[0]!;
    const parent = (await c.pool.query(`SELECT id FROM areas WHERE code='DIV-CEN'`)).rows[0].id as string;
    const pv = await officer.post('/officer/schedule/bulk-reschedule/preview', { areaId: parent, date: day, reason: 'Declared holiday' }); expect(pv.status).toBe(200); expect(pv.body.count).toBeGreaterThanOrEqual(1);
    expect((await officer.post('/officer/schedule/bulk-reschedule/preview', { areaId: '00000000-0000-4000-8000-000000000000', date: day, reason: 'Declared holiday' })).status).toBe(403);
    const r = await officer.post('/officer/schedule/bulk-reschedule', { areaId: parent, date: day, reason: 'Declared holiday' }, { 'Idempotency-Key': key() }); expect(r.status).toBe(200); expect(r.body.moved).toBe(pv.body.count);
    for (const id of [s1.appId, s2.appId]) { const v = await visitOf(id); if (v) { const nd = istDay(new Date((await owner.cl.get(`/applications/${id}`)).body.visit.start)); expect(nd > day || nd !== day).toBe(true); } }
    expect((await officer.post('/officer/schedule/bulk-reschedule/preview', { areaId: parent, date: day, reason: 'Declared holiday' })).body.count).toBe(0);
    expect(Number((await c.pool.query(`SELECT count(*) FROM audit_events WHERE action='schedule.bulk_reschedule'`)).rows[0].count)).toBeGreaterThan(0); void area;
  });
});

describe('officer views and access control', () => {
  it('queue filters, SLA states, calendar, inspector list and route sheet (audited)', async () => {
    const k = await readyCase(); const list = await officer.get('/officer/cases?status=APPLIED&q=' + k.appNo.slice(-6)); expect(list.body.items.map((i: { id: string }) => i.id)).toContain(k.appId);
    const row = list.body.items.find((i: { id: string }) => i.id === k.appId); expect(row.sla.step).toBe('DOCUMENT_CHECK'); expect(row.sla.state).toBe('OK');
    await c.pool.query(`UPDATE applications SET created_at = now() - interval '60 hours' WHERE id=$1`, [k.appId]);
    expect((await officer.get('/officer/cases?sla=OVERDUE')).body.items.map((i: { id: string }) => i.id)).toContain(k.appId);
    expect((await officer.get('/officer/cases/summary')).body.overdue).toBeGreaterThan(0);
    const s = await scheduledCase(); const start = (await owner.cl.get(`/applications/${s.appId}`)).body.visit.start as string; const day = istDay(new Date(start));
    const cal = await officer.get(`/officer/schedule?from=${day}&to=${day}`); expect(cal.status).toBe(200); expect(cal.body.visits.map((v: { applicationNo: string }) => v.applicationNo)).toContain(s.appNo);
    const insp = await officer.get('/officer/inspectors'); expect(insp.body.length).toBeGreaterThanOrEqual(2); expect(insp.body[0].skills.length).toBeGreaterThan(0);
    const v = await visitOf(s.appId); const before = Number((await c.pool.query(`SELECT count(*) FROM audit_events WHERE action='route_sheet.viewed'`)).rows[0].count);
    const rs = await officer.get(`/officer/inspectors/${v.inspector_id}/route-sheet?date=${day}`); expect(rs.status).toBe(200); expect(rs.body.stops.some((x: { applicationNo: string; address: string }) => x.applicationNo === s.appNo && x.address?.includes('Market Road'))).toBe(true);
    expect(Number((await c.pool.query(`SELECT count(*) FROM audit_events WHERE action='route_sheet.viewed'`)).rows[0].count)).toBe(before + 1);
    expect((await officer.get(`/officer/inspectors/${c.demo.OWNER?.mobile ?? '00000000-0000-4000-8000-000000000000'}/route-sheet?date=${day}`)).status).toBe(422);
  });
  it('owners, traders and inspectors cannot use officer endpoints; admins can read but not act', async () => {
    const k = await readyCase();
    for (const cl of [owner.cl, trader, insp1]) { expect((await cl.get('/officer/cases')).status).toBe(403); expect((await cl.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() })).status).toBe(403); }
    expect((await owner.cl.post(`/officer/cases/${k.appId}/assign`, { inspectorId: inspId.one, windowStart: new Date(Date.now() + 864e5).toISOString(), windowEnd: new Date(Date.now() + 864e5 + 72e5).toISOString() }, { 'Idempotency-Key': key() })).status).toBe(403);
    expect((await admin.get(`/officer/cases/${k.appId}`)).status).toBe(200);
    expect((await admin.post(`/officer/cases/${k.appId}/document-check-complete`, {}, { 'Idempotency-Key': key() })).status).toBe(403);
    expect((await officer.get('/inspector/visits')).status).toBe(403);
  });
  it('row-level security hides cases from other owners and from officers outside the area, independent of the API', async () => {
    const s = await scheduledCase();
    const as = async (role: string, ids: { user?: string; biz?: string[]; areas?: string[] }, sql: string, p: unknown[] = []) => {
      const cl = await c.pool.connect(); try {
        await cl.query('BEGIN'); await cl.query('SET LOCAL ROLE nirikshan_app');
        await cl.query(`SELECT set_config('app.user_id',$1,true), set_config('app.role',$2,true), set_config('app.business_ids',$3,true), set_config('app.area_ids',$4,true)`, [ids.user ?? '', role, `{${(ids.biz ?? []).join(',')}}`, `{${(ids.areas ?? []).join(',')}}`]);
        const r = await cl.query(sql, p); await cl.query('ROLLBACK'); return r.rows;
      } catch (e) { await cl.query('ROLLBACK').catch(() => undefined); throw e; } finally { cl.release(); }
    };
    const otherBiz = (await c.pool.query('SELECT id FROM businesses WHERE owner_user_id=$1', [other.id])).rows.map((r) => r.id as string); const ownBiz = (await c.pool.query('SELECT id FROM businesses WHERE owner_user_id=$1', [owner.id])).rows.map((r) => r.id as string);
    for (const t of ['applications WHERE id=$1', 'application_documents WHERE application_id=$1', 'case_status_history WHERE application_id=$1', 'inspection_visits WHERE application_id=$1']) {
      const col = t.startsWith('applications') ? 'id' : 'application_id'; void col;
      expect((await as('OWNER', { user: other.id, biz: otherBiz }, `SELECT 1 FROM ${t}`, [s.appId])).length).toBe(0);
      expect((await as('OWNER', { user: owner.id, biz: ownBiz }, `SELECT 1 FROM ${t}`, [s.appId])).length).toBeGreaterThan(0);
      expect((await as('OFFICER', { user: inspId.one, areas: [c.wards[1] ?? '00000000-0000-4000-8000-000000000000'] }, `SELECT 1 FROM ${t}`, [s.appId])).length).toBe(0);
    }
    const v = await visitOf(s.appId); const mine = await as('INSPECTOR', { user: v.inspector_id }, 'SELECT id FROM instruments'); expect(mine.length).toBeGreaterThan(0);
    const notMine = await as('INSPECTOR', { user: v.inspector_id === inspId.one ? inspId.two : inspId.one }, 'SELECT id FROM applications WHERE id=$1', [s.appId]); expect(notMine.length).toBe(0);
    await expect(as('OWNER', { user: owner.id, biz: ownBiz }, 'UPDATE case_status_history SET remark=\'x\'')).rejects.toBeTruthy();
    expect((await as('OWNER', { user: owner.id, biz: ownBiz }, 'SELECT 1 FROM inspector_profiles')).length).toBe(0);
  });
  it('every status change left a history row and an audit event, and the audit chain is still intact', async () => {
    const s = await scheduledCase(); const h = (await c.pool.query('SELECT action, from_status, to_status FROM case_status_history WHERE application_id=$1 ORDER BY created_at, id', [s.appId])).rows;
    expect(h.map((x) => x.action)).toEqual(['apply', 'document.accepted', 'document.accepted', 'documentCheckComplete', 'assign']); expect(h[3]).toMatchObject({ from_status: 'APPLIED', to_status: 'DOCUMENT_CHECKED' }); expect(h[4]).toMatchObject({ from_status: 'DOCUMENT_CHECKED', to_status: 'SCHEDULED' });
    const a = (await c.pool.query(`SELECT action FROM audit_events WHERE entity_id=$1`, [s.appId])).rows.map((x) => x.action); expect(a).toEqual(expect.arrayContaining(['application.created', 'case.documentCheckComplete', 'case.assign']));
    await expect(c.pool.query('UPDATE case_status_history SET remark=$1 WHERE application_id=$2', ['tamper', s.appId])).resolves.toBeTruthy(); // superuser can, nirikshan_app cannot (checked above)
    const chain = await admin.post('/admin/audit/verify-chain'); expect(chain.body.intact).toBe(true);
  });
});
void randomInt;
