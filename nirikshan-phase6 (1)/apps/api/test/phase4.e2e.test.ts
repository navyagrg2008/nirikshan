import { randomInt } from 'crypto';
import request from 'supertest';
import { createHash } from 'crypto';
import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody, API, ORIGIN } from './helpers';
import { CaptchaService } from '../src/infra/providers';
import { StorageService } from '../src/infra/storage';
import { effectiveStatus } from '../src/modules/certificates/certificates.service';
import { InspectionService } from '../src/modules/inspection/inspection.service';

let c: Ctx; let officer: Client; let officer2: Client; let senior: Client; let admin: Client; let insp1: Client; let insp2: Client;
let owner: { cl: Client; id: string }; let other: { cl: Client; id: string };
let cat: Awaited<ReturnType<typeof catalog>>; let docType: Record<string, string> = {}; let byInsp: Record<string, Client> = {};
let n = 0; let slot = 0; const key = () => `p4-${Date.now()}-${n++}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const EICAR = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);

const ANSWERS = { IDENTITY: { answer: 'YES' }, SEALS: { answer: 'YES' }, TAMPER: { answer: 'NO' }, MAGNETIC: { answer: 'NO' }, DISPLAY: { answer: 'YES' }, ZERO: { answer: 'YES' } };
const PASS3 = [{ reference: '10', observed: '10.001' }, { reference: '20', observed: '20.002' }, { reference: '30', observed: '30' }];
const MARGINAL3 = [{ reference: '10', observed: '10.004' }, { reference: '20', observed: '20.001' }, { reference: '30', observed: '30' }];
const FAIL3 = [{ reference: '10', observed: '10.006' }, { reference: '20', observed: '20.001' }, { reference: '30', observed: '30' }];

async function newInstrument(cl: Client, over: Record<string, unknown> = {}) {
  const tok = await cl.confirmToken(); const r = await cl.post('/instruments', instrumentBody(c, cat, tok, over), { 'Idempotency-Key': key() }); if (r.status !== 201) throw new Error('instrument ' + JSON.stringify(r.body)); return r.body.id as string;
}
function upload(cl: Client, appId: string, typeCode: string) {
  return cl.agent.post(`${API}/applications/${appId}/documents`).set('X-Forwarded-For', cl.ip).set('Origin', ORIGIN).set('X-CSRF-Token', cl.csrf).field('documentTypeId', docType[typeCode]!).attach('file', PDF, { filename: 'doc.pdf' });
}
/** Owner applies, officer accepts the documents and completes the check; the engine books a visit that this helper moves to "now". */
async function booked(instrumentOver: Record<string, unknown> = {}) {
  for (const k of await c.redis.client.keys('rl:doc-upload*')) await c.redis.client.del(k);
  const instrumentId = await newInstrument(owner.cl, instrumentOver);
  const a = await owner.cl.post('/applications', { instrumentId, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() }); expect(a.status).toBe(201);
  const appId = a.body.id as string;
  expect((await upload(owner.cl, appId, 'INVOICE')).status).toBe(201); expect((await upload(owner.cl, appId, 'INSTRUMENT_PHOTO')).status).toBe(201);
  for (const d of (await officer.get(`/officer/cases/${appId}`)).body.documents.filter((x: { current: unknown }) => x.current)) await officer.post(`/officer/cases/${appId}/documents/${d.current.id}/review`, { status: 'ACCEPTED' });
  const r = await officer.post(`/officer/cases/${appId}/document-check-complete`, {}, { 'Idempotency-Key': key() }); expect(r.status).toBe(200); expect(r.body.scheduling.mode).toBe('AUTO');
  return { instrumentId, appId, appNo: a.body.applicationNo as string, ...(await nowWindow(appId)) };
}
async function nowWindow(appId: string) {
  const v = (await c.pool.query(`SELECT id, inspector_id FROM inspection_visits WHERE application_id=$1 AND status='SCHEDULED' ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
  const k = -230 + (slot++ % 95) * 3;
  await c.pool.query(`UPDATE inspection_visits SET scheduled_window = tstzrange(now() + make_interval(mins => $2), now() + make_interval(mins => $2 + 1), '[)') WHERE id=$1`, [v.id, k]);
  return { visitId: v.id as string, insp: byInsp[v.inspector_id]!, inspectorId: v.inspector_id as string };
}
const arrive = (insp: Client, v: string, body: object = { lat: 28.6, lon: 77.2 }) => insp.post(`/inspector/visits/${v}/arrive`, body, { 'Idempotency-Key': key() });
function evidence(insp: Client, visitId: string, kind: string, buf = JPG, geo: boolean | { lat?: string } = true) {
  let r = insp.agent.post(`${API}/inspector/visits/${visitId}/evidence`).set('X-Forwarded-For', insp.ip).set('Origin', ORIGIN).set('X-CSRF-Token', insp.csrf).field('kind', kind);
  if (geo) r = r.field('lat', '28.6').field('lon', '77.2'); return r.attach('file', buf, { filename: 'p.jpg' });
}
const submit = (insp: Client, v: string, over: Record<string, unknown> = {}, idem = key()) => insp.post(`/inspector/visits/${v}/submit`,
  { checklist: ANSWERS, trials: PASS3, recommendation: 'RECOMMEND_APPROVE', stickerSerial: 'STK-' + randomInt(1e6, 9e6), ...over }, { 'Idempotency-Key': idem });
/** Booked, arrived, photographed and submitted. */
async function inspected(o: { trials?: object[]; recommendation?: string; rejectReasonCodes?: string[]; instrument?: Record<string, unknown>; checklist?: object } = {}) {
  for (const k of await c.redis.client.keys('rl:evidence-upload*')) await c.redis.client.del(k);
  const b = await booked(o.instrument);
  expect((await arrive(b.insp, b.visitId)).status).toBe(200);
  expect((await evidence(b.insp, b.visitId, 'DISPLAY')).status).toBe(201); expect((await evidence(b.insp, b.visitId, 'SEAL')).status).toBe(201);
  const r = await submit(b.insp, b.visitId, { ...(o.trials ? { trials: o.trials } : {}), ...(o.recommendation ? { recommendation: o.recommendation } : {}), ...(o.rejectReasonCodes ? { rejectReasonCodes: o.rejectReasonCodes } : {}), ...(o.checklist ? { checklist: o.checklist } : {}) });
  if (r.status !== 200) throw new Error('submit ' + r.status + JSON.stringify(r.body)); return b;
}
const decide = (cl: Client, body: object, k = key()) => cl.post('/decisions', body, { 'Idempotency-Key': k });
const certOf = async (appId: string) => (await c.pool.query('SELECT * FROM certificates WHERE application_id=$1 ORDER BY created_at DESC', [appId])).rows;
const caseStatus = async (appId: string) => (await c.pool.query('SELECT status FROM applications WHERE id=$1', [appId])).rows[0].status as string;
const notifs = async (userId: string, ev: string) => (await c.pool.query('SELECT body FROM in_app_notifications WHERE user_id=$1 AND event_code=$2', [userId, ev])).rows;
const fileBytes = (key: string) => c.app.get(StorageService).getLocal(key);
const weighbridge = () => {
  const w = cat.cats.categories.find((x: { code: string }) => x.code === 'WEIGHBRIDGE')!;
  return { categoryId: w.id, capacityBandId: w.capacityBands[0]!.id, capacity: '20', capacityUnit: 't', subCategoryId: undefined };
};

beforeAll(async () => {
  c = await boot();
  officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1);
  officer2 = await new Client(c).init(); await officer2.loginStaff(c.demo.OFFICER2!, -1);
  senior = await new Client(c).init(); await senior.loginStaff(c.demo.SENIOR_OFFICER!, -1);
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1);
  insp1 = await new Client(c).init(); await insp1.loginStaff(c.demo.INSPECTOR!, -1); insp2 = await new Client(c).init(); await insp2.loginStaff(c.demo.INSPECTOR2!, -1);
  const a = await registerUser(c); await activate(c, a.id); owner = a; const b = await registerUser(c); await activate(c, b.id); other = b;
  cat = await catalog(owner.cl);
  for (const r of (await c.pool.query('SELECT id, code FROM document_types')).rows) docType[r.code] = r.id;
  const idOf = async (m: string) => (await c.pool.query('SELECT id FROM users WHERE mobile_bidx=$1', [c.crypto.blindIndex('mobile', m)])).rows[0].id as string;
  byInsp = { [await idOf(c.demo.INSPECTOR!.mobile)]: insp1, [await idOf(c.demo.INSPECTOR2!.mobile)]: insp2 };
});
afterAll(() => shutdown(c));

describe('step 3: the server calculates, the client only types readings', () => {
  it('returns error, limit, percent and verdict per trial; the client cannot send a verdict', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId);
    const r = await b.insp.post(`/inspector/visits/${b.visitId}/trials/compute`, { trials: [{ reference: '10', observed: '10.003' }, { reference: '10', observed: '10.004' }, { reference: '10', observed: '10.006' }] });
    expect(r.status).toBe(200);
    expect(r.body.trials.map((t: { verdict: string }) => t.verdict)).toEqual(['PASS', 'MARGINAL_PASS', 'FAIL']);
    expect(r.body.trials[0]).toMatchObject({ errorValue: '3.000000', errorUnit: 'g', errorPct: '0.030000', mpeValue: '5.000000' });
    expect(r.body.overall).toBe('FAIL'); expect(r.body.allowed).not.toContain('RECOMMEND_APPROVE'); expect(r.body.suggested).toBe('RECOMMEND_REJECT');
    expect((await b.insp.post(`/inspector/visits/${b.visitId}/trials/compute`, { trials: [{ reference: '10', observed: '10.003', verdict: 'PASS' }] })).status).toBe(422);
    expect((await b.insp.post(`/inspector/visits/${b.visitId}/trials/compute`, { trials: [{ reference: '0', observed: '1' }] })).status).toBe(422);
    expect((await b.insp.post(`/inspector/visits/${b.visitId}/trials/compute`, { trials: [{ reference: '1e3', observed: '1' }] })).status).toBe(422);
  });
  it('uses the rule version pinned to the application, not the latest', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId);
    await c.pool.query(`UPDATE rule_sets SET effective_to='2026-11-01' WHERE version=1`);
    const rs = (await c.pool.query(`INSERT INTO rule_sets (version, status, effective_from, published_at, note) VALUES ((SELECT max(version)+1 FROM rule_sets),'PUBLISHED','2026-11-01', now(), 'test v2') RETURNING id`)).rows[0].id;
    await c.pool.query(`ALTER TABLE mpe_rules DISABLE TRIGGER mpe_rules_immutable`);
    await c.pool.query(`INSERT INTO mpe_rules (rule_set_id, category_id, capacity_band_id, accuracy_class_id, direction, value, unit) SELECT $1, category_id, capacity_band_id, accuracy_class_id, direction, 1, unit FROM mpe_rules WHERE rule_set_id=(SELECT id FROM rule_sets WHERE version=1)`, [rs]);
    await c.pool.query(`ALTER TABLE mpe_rules ENABLE TRIGGER mpe_rules_immutable`);
    const r = await b.insp.post(`/inspector/visits/${b.visitId}/trials/compute`, { trials: [{ reference: '10', observed: '10.003' }] });
    expect(r.body.trials[0].mpeValue).toBe('5.000000'); expect(r.body.trials[0].verdict).toBe('PASS'); // v2 would say 1 g and fail
    await c.pool.query(`UPDATE rule_sets SET status='RETIRED' WHERE id=$1`, [rs]); await c.pool.query(`UPDATE rule_sets SET effective_to=NULL WHERE version=1`);
  });
});

describe('step 1: arrive', () => {
  it('only the assigned inspector, only around the window, only once', async () => {
    const b = await booked(); const other_ = b.insp === insp1 ? insp2 : insp1;
    expect((await arrive(other_, b.visitId)).status).toBe(404);
    await c.pool.query(`UPDATE inspection_visits SET scheduled_window = tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour') WHERE id=$1`, [b.visitId]);
    const early = await arrive(b.insp, b.visitId); expect(early.status).toBe(409); expect(early.body.code).toBe('OUTSIDE_VISIT_WINDOW');
    await c.pool.query(`UPDATE inspection_visits SET scheduled_window = tstzrange(now() + make_interval(mins => $2), now() + make_interval(mins => $2 + 1)) WHERE id=$1`, [b.visitId, -230 + (slot++ % 95) * 3]);
    const ok = await arrive(b.insp, b.visitId); expect(ok.status).toBe(200); expect(ok.body.status).toBe('IN_PROGRESS');
    expect(await caseStatus(b.appId)).toBe('INSPECTION_IN_PROGRESS');
    expect((await arrive(b.insp, b.visitId)).status).toBe(409);
  });
  it('outside the geofence needs a written reason; inside does not', async () => {
    const b = await booked();
    await c.pool.query('UPDATE instruments SET location_enc=$2 WHERE id=$1', [b.instrumentId, c.crypto.encJson({ lat: 28.6139, lng: 77.209 })]);
    const far = await arrive(b.insp, b.visitId, { lat: 28.7, lon: 77.3 }); expect(far.status).toBe(422); expect(far.body.code).toBe('JUSTIFICATION_REQUIRED'); expect(far.body.radiusM).toBe(200);
    const ok = await arrive(b.insp, b.visitId, { lat: 28.7, lon: 77.3, justification: 'Gate is on the next street, premises shifted' }); expect(ok.status).toBe(200); expect(ok.body.geofenceOk).toBe(false);
    const v = (await c.pool.query('SELECT geofence_ok, geofence_justification FROM inspection_visits WHERE id=$1', [b.visitId])).rows[0]; expect(v.geofence_ok).toBe(false); expect(v.geofence_justification).toMatch(/next street/);
    const b2 = await booked(); await c.pool.query('UPDATE instruments SET location_enc=$2 WHERE id=$1', [b2.instrumentId, c.crypto.encJson({ lat: 28.6139, lng: 77.209 })]);
    const near = await arrive(b2.insp, b2.visitId, { lat: 28.6140, lon: 77.2091 }); expect(near.status).toBe(200); expect(near.body.geofenceOk).toBe(true);
  });
});

describe('autosave drafts', () => {
  it('are saved encrypted, private to the inspector, restored on reopen, and expire', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId);
    const secret = 'private note ' + randomInt(1e6, 9e6);
    const s = await b.insp.put(`/inspector/visits/${b.visitId}/draft`, { step: 3, trials: [{ reference: '10', observed: '10.0' }], note: secret }); expect(s.status).toBe(200); expect(s.body.version).toBe(1);
    expect((await b.insp.put(`/inspector/visits/${b.visitId}/draft`, { step: 3, note: secret + '!' })).body.version).toBe(2);
    const raw = (await c.pool.query('SELECT payload_enc FROM inspection_drafts WHERE visit_id=$1', [b.visitId])).rows[0].payload_enc as Buffer; expect(raw.includes(Buffer.from(secret))).toBe(false);
    const d = await b.insp.get(`/inspector/visits/${b.visitId}`); expect(d.body.draft.data.note).toBe(secret + '!'); expect(d.body.draft.data.step).toBe(3);
    expect((await b.insp.put(`/inspector/visits/${b.visitId}/draft`, { step: 9 })).status).toBe(422); expect((await b.insp.put(`/inspector/visits/${b.visitId}/draft`, { verdict: 'PASS' })).status).toBe(422);
    const other_ = b.insp === insp1 ? insp2 : insp1; expect((await other_.put(`/inspector/visits/${b.visitId}/draft`, { step: 1 })).status).toBe(404); expect((await other_.get(`/inspector/visits/${b.visitId}`)).status).toBe(404);
    // no officer or admin can read it, even through the database policies
    const cx = await c.pool.connect(); try {
      await cx.query('BEGIN'); await cx.query('SET LOCAL ROLE nirikshan_app'); await cx.query(`SELECT set_config('app.role','OFFICER',true)`);
      expect((await cx.query('SELECT 1 FROM inspection_drafts')).rowCount).toBe(0); await cx.query('ROLLBACK');
    } finally { cx.release(); }
    await c.pool.query(`UPDATE inspection_drafts SET expires_at = now() - interval '1 minute' WHERE visit_id=$1`, [b.visitId]);
    expect((await b.insp.get(`/inspector/visits/${b.visitId}`)).body.draft).toBeNull();
    expect(await c.app.get(InspectionService).purgeExpiredDrafts()).toBeGreaterThanOrEqual(1);
    expect((await c.pool.query('SELECT 1 FROM inspection_drafts WHERE visit_id=$1', [b.visitId])).rowCount).toBe(0);
  });
});

describe('step 4: evidence', () => {
  it('needs a geotag, a real image, and a clean scan; links are short lived and audited', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId);
    expect((await evidence(b.insp, b.visitId, 'DISPLAY', JPG, false)).body.code).toBe('GEO_REQUIRED');
    expect((await evidence(b.insp, b.visitId, 'DISPLAY', PDF)).body.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await evidence(b.insp, b.visitId, 'DISPLAY', EICAR)).body.code).toBe('FILE_INFECTED');
    expect((await evidence(b.insp, b.visitId, 'AUDIO')).status).toBe(422);
    const ok = await evidence(b.insp, b.visitId, 'DISPLAY'); expect(ok.status).toBe(201); expect(ok.body.geoTagged).toBe(true);
    const l = await b.insp.get(`/evidence/${ok.body.id}/link`); expect(l.status).toBe(200); expect(l.body.expiresInSec).toBeLessThanOrEqual(120);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='evidence.link_issued' AND entity_id=$1`, [ok.body.id])).rowCount).toBe(1);
    const other_ = b.insp === insp1 ? insp2 : insp1; expect((await other_.get(`/evidence/${ok.body.id}/link`)).status).toBe(404);
    expect((await owner.cl.get(`/evidence/${ok.body.id}/link`)).status).toBe(403);
  });
  it('is closed before the visit starts', async () => {
    const b = await booked(); expect((await evidence(b.insp, b.visitId, 'DISPLAY')).status).toBe(409);
  });
});

describe('step 5: submit', () => {
  it('lists what is missing, one clear reason at a time', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId);
    const miss = await submit(b.insp, b.visitId, { checklist: { SEALS: { answer: 'YES' } } }); expect(miss.status).toBe(422); expect(miss.body.code).toBe('CHECKLIST_INCOMPLETE'); expect(miss.body.missing).toEqual(expect.arrayContaining(['IDENTITY', 'TAMPER', 'MAGNETIC', 'DISPLAY', 'ZERO']));
    expect((await submit(b.insp, b.visitId, { checklist: { ...ANSWERS, SEALS: { answer: 'NA' } } })).body.notApplicableNotAllowed).toEqual(['SEALS']);
    expect((await submit(b.insp, b.visitId, { checklist: { ...ANSWERS, SEALS: { answer: 'NO' } } })).body.remarkRequired).toEqual(['SEALS']);
    expect((await submit(b.insp, b.visitId, { checklist: { ...ANSWERS, NOPE: { answer: 'YES' } } })).body.code).toBe('UNKNOWN_CHECKLIST_ITEM');
    const few = await submit(b.insp, b.visitId, { trials: PASS3.slice(0, 2) }); expect(few.body.code).toBe('TRIALS_MISSING');
    expect((await submit(b.insp, b.visitId)).body.code).toBe('EVIDENCE_MISSING');
    await evidence(b.insp, b.visitId, 'DISPLAY'); await evidence(b.insp, b.visitId, 'SEAL');
    expect((await submit(b.insp, b.visitId, { stickerSerial: undefined })).body.code).toBe('STICKER_REQUIRED');
    const bad = await submit(b.insp, b.visitId, { trials: FAIL3 }); expect(bad.body.code).toBe('RECOMMENDATION_NOT_ALLOWED'); expect(bad.body.allowed).toEqual(['RECOMMEND_REJECT', 'RE_INSPECT']);
    expect((await submit(b.insp, b.visitId, { trials: FAIL3, recommendation: 'RECOMMEND_REJECT', rejectReasonCodes: [] })).body.code).toBe('REASON_CODE_REQUIRED');
    expect((await submit(b.insp, b.visitId, { trials: FAIL3, recommendation: 'RECOMMEND_REJECT', rejectReasonCodes: ['MISUSE'] })).body.code).toBe('INVALID_REASON_CODE');
    expect((await submit(b.insp, b.visitId, { verdict: 'PASS' })).status).toBe(422);
    expect(await caseStatus(b.appId)).toBe('INSPECTION_IN_PROGRESS'); // nothing above changed the case
  });
  it('a broken seal closes the approve option even when every reading passes', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId); await evidence(b.insp, b.visitId, 'DISPLAY'); await evidence(b.insp, b.visitId, 'SEAL');
    const r = await submit(b.insp, b.visitId, { checklist: { ...ANSWERS, SEALS: { answer: 'NO', remark: 'Seal cut' } } }); expect(r.body.code).toBe('RECOMMENDATION_NOT_ALLOWED');
    const t = await submit(b.insp, b.visitId, { checklist: { ...ANSWERS, TAMPER: { answer: 'YES', remark: 'Extra wire' } }, recommendation: 'RECOMMEND_REJECT', rejectReasonCodes: ['SEAL_BROKEN'] }); expect(t.body.code).toBe('EVIDENCE_MISSING'); expect(t.body.kinds).toEqual(['TAMPER']);
  });
  it('stores server-computed results, makes the visit read-only, generates a test sheet, and is idempotent', async () => {
    const b = await booked(); await arrive(b.insp, b.visitId); await evidence(b.insp, b.visitId, 'DISPLAY'); await evidence(b.insp, b.visitId, 'SEAL');
    await b.insp.put(`/inspector/visits/${b.visitId}/draft`, { step: 5 });
    const idem = key(); const sticker = 'STK-' + randomInt(1e6, 9e6);
    const r = await submit(b.insp, b.visitId, { trials: MARGINAL3, stickerSerial: sticker }, idem); expect(r.status).toBe(200); expect(r.body.overall).toBe('MARGINAL_PASS');
    const again = await submit(b.insp, b.visitId, { trials: MARGINAL3, stickerSerial: sticker }, idem); expect(again.status).toBe(200); expect(again.body).toEqual(r.body);
    expect((await submit(b.insp, b.visitId, { stickerSerial: 'STK-NEW1234' })).status).toBe(409);
    expect(await caseStatus(b.appId)).toBe('INSPECTED');
    const rows = (await c.pool.query('SELECT trial_no, error_value, error_pct, mpe_value, verdict, error_unit FROM test_measurements WHERE visit_id=$1 ORDER BY trial_no', [b.visitId])).rows;
    expect(rows).toHaveLength(3); expect(rows[0]).toMatchObject({ error_value: '4.000000', verdict: 'MARGINAL_PASS', mpe_value: '5.000000', error_unit: 'g' }); expect(rows[1].verdict).toBe('PASS');
    expect((await c.pool.query('SELECT 1 FROM inspection_drafts WHERE visit_id=$1', [b.visitId])).rowCount).toBe(0);
    expect((await b.insp.put(`/inspector/visits/${b.visitId}/draft`, { step: 1 })).status).toBe(409); expect((await evidence(b.insp, b.visitId, 'DISPLAY')).status).toBe(409);
    const d = await b.insp.get(`/inspector/visits/${b.visitId}`); expect(d.body.readOnly).toBe(true); expect(d.body.trials).toHaveLength(3); expect(d.body.hasTestSheet).toBe(true);
    const link = await b.insp.get(`/visits/${b.visitId}/test-sheet/link`); expect(link.status).toBe(200);
    const sheetKey = (await c.pool.query('SELECT test_sheet_key, test_sheet_sha256 FROM inspection_visits WHERE id=$1', [b.visitId])).rows[0];
    const bytes = await fileBytes(sheetKey.test_sheet_key); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(createHash('sha256').update(bytes).digest().equals(sheetKey.test_sheet_sha256)).toBe(true);
    const hist = await b.insp.get('/inspector/history'); expect(hist.body.some((h: { id: string }) => h.id === b.visitId)).toBe(true);
    expect((await notifs((await c.pool.query('SELECT owner_user_id FROM businesses b JOIN applications a ON a.business_id=b.id WHERE a.id=$1', [b.appId])).rows[0].owner_user_id, 'INSPECTION_DONE')).length).toBeGreaterThanOrEqual(1);
  });
  it('a sticker serial cannot be used on two submitted inspections', async () => {
    const a = await inspected(); const sticker = (await c.pool.query('SELECT sticker_serial FROM inspection_visits WHERE id=$1', [a.visitId])).rows[0].sticker_serial;
    const b = await booked(); await arrive(b.insp, b.visitId); await evidence(b.insp, b.visitId, 'DISPLAY'); await evidence(b.insp, b.visitId, 'SEAL');
    const r = await submit(b.insp, b.visitId, { stickerSerial: sticker.toLowerCase() }); expect(r.status).toBe(409); expect(r.body.code).toBe('STICKER_IN_USE');
  });
  it('submitted measurements cannot be edited or deleted by the application, only read', async () => {
    const a = await inspected(); const cx = await c.pool.connect();
    try {
      await cx.query('BEGIN'); await cx.query('SET LOCAL ROLE nirikshan_app'); await cx.query(`SELECT set_config('app.role','SYSTEM',true)`);
      await expect(cx.query(`UPDATE test_measurements SET verdict='PASS' WHERE visit_id=$1`, [a.visitId])).rejects.toThrow(/permission denied/); await cx.query('ROLLBACK');
      await cx.query('BEGIN'); await cx.query('SET LOCAL ROLE nirikshan_app'); await expect(cx.query('DELETE FROM checklist_responses')).rejects.toThrow(/permission denied/); await cx.query('ROLLBACK');
    } finally { cx.release(); }
  });
});

describe('officer view and decisions', () => {
  it('officer sees the inspection, the rules applied and the blockers; owner and other inspector cannot', async () => {
    const a = await inspected(); const v = await officer.get(`/officer/cases/${a.appId}/inspection`); expect(v.status).toBe(200);
    expect(v.body.visits[0].trials).toHaveLength(3); expect(v.body.visits[0].checklist.length).toBeGreaterThanOrEqual(5); expect(v.body.visits[0].evidence.every((e: { geoTagged: boolean }) => e.geoTagged)).toBe(true);
    expect(v.body.rules).toMatchObject({ version: 1, mpe: { value: '5.000000', unit: 'g' } }); expect(v.body.approval).toMatchObject({ canApprove: true, blockers: [], requiresSecondApprover: false, validity: { min: 1, max: 12, default: 12 } });
    expect((await owner.cl.get(`/officer/cases/${a.appId}/inspection`)).status).toBe(403);
    const pending = await officer.get('/officer/decisions'); expect(pending.body.some((p: { id: string }) => p.id === a.appId)).toBe(true);
    expect((await owner.cl.get('/officer/decisions')).status).toBe(403); expect((await a.insp.get('/officer/decisions')).status).toBe(403);
  });
  it('cannot approve a case that is not inspected; owners and inspectors cannot decide', async () => {
    const b = await booked(); const r = await decide(officer, { decision: 'APPROVE', applicationId: b.appId }); expect(r.status).toBe(409); expect(r.body.code).toBe('ILLEGAL_TRANSITION');
    expect((await decide(owner.cl, { decision: 'APPROVE', applicationId: b.appId })).status).toBe(403); expect((await decide(b.insp, { decision: 'APPROVE', applicationId: b.appId })).status).toBe(403);
    expect((await owner.cl.post('/decisions', { decision: 'APPROVE', applicationId: b.appId })).status).toBe(403);
  });
  it('approve blocked for a failed reading, listing every reason', async () => {
    const a = await inspected({ trials: FAIL3, recommendation: 'RECOMMEND_REJECT', rejectReasonCodes: ['OUT_OF_LIMIT'] });
    const r = await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); expect(r.status).toBe(422); expect(r.body.code).toBe('APPROVAL_BLOCKED');
    expect(r.body.blockers.map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(['MPE_FAILED', 'INSPECTOR_RECOMMENDED_AGAINST']));
    expect(await caseStatus(a.appId)).toBe('INSPECTED'); expect(await certOf(a.appId)).toHaveLength(0);
  });
  it('approve blocked when documents are no longer complete or evidence is flagged', async () => {
    const a = await inspected(); await c.pool.query(`UPDATE application_documents SET review='FLAGGED' WHERE application_id=$1`, [a.appId]);
    expect((await decide(officer, { decision: 'APPROVE', applicationId: a.appId })).body.blockers.map((b: { code: string }) => b.code)).toContain('DOCUMENTS_INCOMPLETE');
    await c.pool.query(`UPDATE application_documents SET review='ACCEPTED' WHERE application_id=$1`, [a.appId]);
    await c.pool.query(`UPDATE evidence SET scan='INFECTED' WHERE visit_id=$1 AND kind='SEAL'`, [a.visitId]);
    const r = await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); expect(r.body.blockers.map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(['EVIDENCE_MISSING', 'EVIDENCE_UNSAFE']));
  });
  it('approves, issues a numbered certificate with a signed QR, and updates the instrument, public index and owner', async () => {
    const a = await inspected(); const r = await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); expect(r.status).toBe(200); expect(r.body.status).toBe('CERTIFICATE_ISSUED');
    expect(r.body.certificate.certNo).toMatch(/^NRK\/CERT\/CEN\/\d{4}\/\d{6}$/);
    expect(await caseStatus(a.appId)).toBe('CERTIFICATE_ISSUED');
    const [cert] = await certOf(a.appId)!; expect(cert.status).toBe('VALID'); expect(cert.validity_months).toBe(12); expect(cert.marginal).toBe(false);
    const vf = new Date(cert.verified_on); const vt = new Date(cert.valid_till); expect(vt.getFullYear() - vf.getFullYear()).toBe(1);
    expect(createHash('sha256').update(JSON.stringify(sortDeep(cert.content))).digest().equals(cert.fingerprint)).toBe(true);
    const pdf = await fileBytes(cert.pdf_key); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); expect(createHash('sha256').update(pdf).digest().equals(cert.pdf_sha256)).toBe(true);
    const inst = (await c.pool.query('SELECT status, first_verified_at FROM instruments WHERE id=$1', [a.instrumentId])).rows[0]; expect(inst.status).toBe('ACTIVE'); expect(inst.first_verified_at).not.toBeNull();
    const idx = (await c.pool.query('SELECT * FROM public_certificate_index WHERE cert_no=$1', [cert.cert_no])).rows[0]; expect(idx.status).toBe('VALID'); expect(idx.holder_masked).toMatch(/\*/);
    const hist = (await c.pool.query('SELECT to_status FROM certificate_status_history WHERE certificate_id=$1', [cert.id])).rows; expect(hist.map((h) => h.to_status)).toEqual(['VALID']);
    const ownerId = (await c.pool.query('SELECT owner_user_id FROM businesses b JOIN applications a ON a.business_id=b.id WHERE a.id=$1', [a.appId])).rows[0].owner_user_id;
    expect((await notifs(ownerId, 'CERTIFICATE_ISSUED')).some((x) => x.body.includes(cert.cert_no))).toBe(true);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action IN ('decision.approved','certificate.issued') AND entity_id IN ($1,$2)`, [a.appId, cert.id])).rowCount).toBe(2);
    const hist2 = (await c.pool.query('SELECT to_status FROM case_status_history WHERE application_id=$1 ORDER BY created_at', [a.appId])).rows.map((x) => x.to_status); expect(hist2.slice(-3)).toEqual(['INSPECTED', 'APPROVED', 'CERTIFICATE_ISSUED']);
  });
  it('the owner sees the certificate; other owners, inspectors and unrelated users do not', async () => {
    const a = await inspected(); await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); const cert = (await certOf(a.appId))[0];
    const list = await owner.cl.get('/certificates'); expect(list.status).toBe(200); expect(list.body.items.some((x: { id: string }) => x.id === cert.id)).toBe(true);
    const d = await owner.cl.get(`/certificates/${cert.id}`); expect(d.status).toBe(200); expect(d.body.signature.status).toBe('MATCH'); expect(d.body.content.holder).toMatch(/Sharma/); expect(d.body.qrUrl).toMatch(/\/v\/NRK-CERT-CEN-\d{4}-\d{6}\.[A-Za-z0-9_-]{22}$/);
    expect(d.body.history[0].note).toBeUndefined();
    expect((await other.cl.get(`/certificates/${cert.id}`)).status).toBe(404); expect((await other.cl.get('/certificates')).body.items.some((x: { id: string }) => x.id === cert.id)).toBe(false);
    expect((await a.insp.get('/certificates')).status).toBe(403);
    const link = await owner.cl.get(`/certificates/${cert.id}/pdf`); expect(link.status).toBe(200); expect(link.body.fileName).toMatch(/^NRK-CERT-CEN-/);
    expect((await other.cl.get(`/certificates/${cert.id}/pdf`)).status).toBe(404);
    const od = await officer.get(`/certificates/${cert.id}`); expect(od.status).toBe(200); expect(od.body.allowed.revoke).toBe(true); expect(d.body.allowed.revoke).toBe(false);
    const tabs = await owner.cl.get('/certificates?tab=VALID'); expect(tabs.body.items.some((x: { id: string }) => x.id === cert.id)).toBe(true);
    expect((await owner.cl.get('/certificates?tab=REVOKED')).body.items.some((x: { id: string }) => x.id === cert.id)).toBe(false);
  });
  it('validity can be shortened but never extended; a marginal pass is capped at the marginal interval', async () => {
    const a = await inspected(); const r = await decide(officer, { decision: 'APPROVE', applicationId: a.appId, validityMonths: 13 }); expect(r.status).toBe(422); expect(r.body.code).toBe('VALIDITY_OUT_OF_RANGE');
    expect((await decide(officer, { decision: 'APPROVE', applicationId: a.appId, validityMonths: 6 })).status).toBe(200); expect((await certOf(a.appId))[0].validity_months).toBe(6);
    const m = await inspected({ trials: MARGINAL3 }); const mv = await officer.get(`/officer/cases/${m.appId}/inspection`); expect(mv.body.approval.validity).toEqual({ min: 1, max: 6, default: 6 });
    expect((await decide(officer, { decision: 'APPROVE', applicationId: m.appId, validityMonths: 12 })).status).toBe(422);
    expect((await decide(officer, { decision: 'APPROVE', applicationId: m.appId })).status).toBe(200); const mc = (await certOf(m.appId))[0]; expect(mc.validity_months).toBe(6); expect(mc.marginal).toBe(true);
  });
  it('rejects with a reason code and remarks; the owner is told why', async () => {
    const a = await inspected({ trials: FAIL3, recommendation: 'RECOMMEND_REJECT', rejectReasonCodes: ['OUT_OF_LIMIT'] });
    expect((await decide(officer, { decision: 'REJECT', applicationId: a.appId, reasonCode: 'OUT_OF_LIMIT', remarks: 'short' })).status).toBe(422);
    expect((await decide(officer, { decision: 'REJECT', applicationId: a.appId, reasonCode: 'MISUSE', remarks: 'Not a reject reason code' })).body.code).toBe('INVALID_REASON_CODE');
    const r = await decide(officer, { decision: 'REJECT', applicationId: a.appId, reasonCode: 'OUT_OF_LIMIT', remarks: 'Readings exceed the limit at 10 kg; repair and apply again.' }); expect(r.status).toBe(200); expect(r.body.status).toBe('REJECTED');
    expect(await caseStatus(a.appId)).toBe('REJECTED'); expect(await certOf(a.appId)).toHaveLength(0);
    const det = await owner.cl.get(`/applications/${a.appId}`); expect(det.body.timeline.some((t: { remark?: string }) => /Readings exceed/.test(t.remark ?? ''))).toBe(true);
    const ownerId = (await c.pool.query('SELECT owner_user_id FROM businesses b JOIN applications a ON a.business_id=b.id WHERE a.id=$1', [a.appId])).rows[0].owner_user_id; expect((await notifs(ownerId, 'APPLICATION_REJECTED')).length).toBeGreaterThanOrEqual(1);
    expect((await decide(officer, { decision: 'APPROVE', applicationId: a.appId })).status).toBe(409);
  });
  it('refer sends the case to a senior officer, who alone can decide it', async () => {
    const a = await inspected(); expect((await decide(officer, { decision: 'REFER', applicationId: a.appId, remarks: 'Unusual wear on the platform; need a second view.' })).body.status).toBe('REFERRED');
    expect(await caseStatus(a.appId)).toBe('REFERRED');
    expect((await decide(officer, { decision: 'APPROVE', applicationId: a.appId })).status).toBe(409); expect((await decide(officer2, { decision: 'REJECT', applicationId: a.appId, reasonCode: 'OUT_OF_LIMIT', remarks: 'Not allowed for officers.' })).status).toBe(409);
    const p = await senior.get('/officer/decisions'); expect(p.body.find((x: { id: string }) => x.id === a.appId).canAct).toBe(true); expect((await officer.get('/officer/decisions')).body.find((x: { id: string }) => x.id === a.appId).canAct).toBe(false);
    expect((await decide(senior, { decision: 'APPROVE', applicationId: a.appId })).body.status).toBe('CERTIFICATE_ISSUED');
  });
  it('dual approval: the first approver cannot confirm their own decision; a second officer completes it', async () => {
    const a = await inspected({ instrument: weighbridge() }); const first = await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); expect(first.status).toBe(200); expect(first.body.status).toBe('PENDING_SECOND');
    expect(await caseStatus(a.appId)).toBe('INSPECTED'); expect(await certOf(a.appId)).toHaveLength(0);
    expect((await decide(officer2, { decision: 'APPROVE', applicationId: a.appId })).body.code).toBe('DECISION_PENDING_SECOND');
    expect((await officer.post(`/decisions/${first.body.decisionId}/second-approval`, { action: 'CONFIRM' }, { 'Idempotency-Key': key() })).status).toBe(403);
    expect((await officer2.get('/officer/decisions')).body.find((x: { id: string }) => x.id === a.appId)).toMatchObject({ waitingForSecondApprover: true, firstApproverIsMe: false });
    expect((await owner.cl.post(`/decisions/${first.body.decisionId}/second-approval`, { action: 'CONFIRM' }, { 'Idempotency-Key': key() })).status).toBe(403);
    const done = await officer2.post(`/decisions/${first.body.decisionId}/second-approval`, { action: 'CONFIRM' }, { 'Idempotency-Key': key() }); expect(done.status).toBe(200); expect(done.body.status).toBe('CERTIFICATE_ISSUED');
    const d = (await c.pool.query('SELECT status, decided_by, second_approver_id FROM decisions WHERE id=$1', [first.body.decisionId])).rows[0]; expect(d.status).toBe('FINAL'); expect(d.second_approver_id).not.toBe(d.decided_by);
    expect((await officer2.post(`/decisions/${first.body.decisionId}/second-approval`, { action: 'CONFIRM' }, { 'Idempotency-Key': key() })).status).toBe(409);
  });
  it('dual approval: the second officer can decline, which returns the case to the queue', async () => {
    const a = await inspected({ instrument: weighbridge() }); const first = await decide(officer, { decision: 'APPROVE', applicationId: a.appId });
    expect((await officer2.post(`/decisions/${first.body.decisionId}/second-approval`, { action: 'DECLINE' }, { 'Idempotency-Key': key() })).status).toBe(422);
    expect((await officer2.post(`/decisions/${first.body.decisionId}/second-approval`, { action: 'DECLINE', remarks: 'Need to see the load cell certificate first.' }, { 'Idempotency-Key': key() })).body.status).toBe('RETURNED_TO_QUEUE');
    expect((await c.pool.query('SELECT status FROM decisions WHERE id=$1', [first.body.decisionId])).rows[0].status).toBe('VOIDED');
    expect((await decide(officer2, { decision: 'REJECT', applicationId: a.appId, reasonCode: 'REPAIR_NEEDED', remarks: 'Load cell certificate missing; repair needed.' })).body.status).toBe('REJECTED');
  });
  it('re-inspection keeps the first sheet and books a new visit', async () => {
    const a = await inspected(); const r = await officer.post(`/officer/cases/${a.appId}/reinspect`, { remarks: 'Reading at 30 kg looks doubtful; test again.' }, { 'Idempotency-Key': key() }); expect(r.status).toBe(200);
    expect(r.body.scheduling.mode).toBe('AUTO'); expect(await caseStatus(a.appId)).toBe('SCHEDULED');
    const visits = (await c.pool.query('SELECT status, test_sheet_key FROM inspection_visits WHERE application_id=$1 ORDER BY created_at', [a.appId])).rows; expect(visits.map((v) => v.status)).toEqual(['SUBMITTED', 'SCHEDULED']); expect(visits[0].test_sheet_key).toBeTruthy();
    expect((await officer.post(`/officer/cases/${a.appId}/reinspect`, { remarks: 'Again please.' }, { 'Idempotency-Key': key() })).status).toBe(409);
    expect((await officer.post(`/officer/cases/${a.appId}/reinspect`, { remarks: 'short' }, { 'Idempotency-Key': key() })).status).toBe(422);
    // second inspection, then approve using the latest sheet
    const w = await nowWindow(a.appId); await arrive(w.insp, w.visitId); await evidence(w.insp, w.visitId, 'DISPLAY'); await evidence(w.insp, w.visitId, 'SEAL'); expect((await submit(w.insp, w.visitId)).status).toBe(200);
    const ins = await officer.get(`/officer/cases/${a.appId}/inspection`); expect(ins.body.visits).toHaveLength(2); expect(ins.body.visits[0].id).toBe(w.visitId);
    expect((await decide(officer, { decision: 'APPROVE', applicationId: a.appId })).body.status).toBe('CERTIFICATE_ISSUED');
  });
  it('a retried approval returns the same certificate; two racing approvals issue exactly one', async () => {
    const a = await inspected(); const k = key(); const r1 = await decide(officer, { decision: 'APPROVE', applicationId: a.appId }, k); const r2 = await decide(officer, { decision: 'APPROVE', applicationId: a.appId }, k);
    expect(r2.body).toEqual(r1.body); expect(await certOf(a.appId)).toHaveLength(1);
    const b = await inspected(); const [x, y] = await Promise.all([decide(officer, { decision: 'APPROVE', applicationId: b.appId }), decide(senior, { decision: 'APPROVE', applicationId: b.appId })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]); expect(await certOf(b.appId)).toHaveLength(1);
  });
  it('certificate numbers are unique and count up per division and year', async () => {
    const nos = (await c.pool.query(`SELECT cert_no FROM certificates ORDER BY created_at`)).rows.map((r) => r.cert_no as string);
    expect(new Set(nos).size).toBe(nos.length); const seqs = nos.map((x) => Number(x.split('/').pop())); expect(seqs).toEqual([...seqs].sort((p, q) => p - q));
    expect(seqs[0]).toBe(1); for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1);
  });
});

describe('certificate lifecycle', () => {
  const act = (cl: Client, id: string, what: string, body: object) => cl.post(`/certificates/${id}/${what}`, body, { 'Idempotency-Key': key() });
  it('suspend, reinstate and revoke; the public page shows only the public-safe reason', async () => {
    const a = await inspected(); await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); const cert = (await certOf(a.appId))[0];
    expect((await act(owner.cl, cert.id, 'suspend', { reasonCode: 'UNDER_REVIEW', internalNote: 'owner may not do this' })).status).toBe(403);
    expect((await act(officer, cert.id, 'suspend', { reasonCode: 'MISUSE', internalNote: 'wrong kind of reason code' })).body.code).toBe('INVALID_REASON_CODE');
    const note = 'Complaint from neighbouring shop about short measure, ref 4471';
    expect((await act(officer, cert.id, 'suspend', { reasonCode: 'UNDER_REVIEW', internalNote: note })).body.status).toBe('SUSPENDED');
    const pub = await new Client(c).init().then((p) => p.get(`/public/validate?cert=${encodeURIComponent(cert.cert_no)}`)); expect(pub.body.result).toBe('SUSPENDED'); expect(pub.body.certificate.reason).toBe('Certificate is under review'); expect(JSON.stringify(pub.body)).not.toMatch(/4471|neighbouring/);
    expect((await owner.cl.get(`/certificates/${cert.id}`)).body.history.map((h: { note?: string }) => h.note)).not.toContain(note);
    expect((await act(officer, cert.id, 'suspend', { reasonCode: 'UNDER_REVIEW', internalNote: note })).status).toBe(409);
    expect((await act(officer, cert.id, 'reinstate', { internalNote: 'Complaint closed, no fault found.' })).body.status).toBe('VALID');
    expect((await act(admin, cert.id, 'revoke', { reasonCode: 'MISUSE', internalNote: 'Found tampered during enforcement drive.' })).body.status).toBe('REVOKED');
    expect((await c.pool.query('SELECT status FROM instruments WHERE id=$1', [a.instrumentId])).rows[0].status).toBe('REGISTERED');
    expect((await act(officer, cert.id, 'suspend', { reasonCode: 'UNDER_REVIEW', internalNote: 'Cannot suspend a revoked one.' })).status).toBe(409); expect((await act(officer, cert.id, 'reinstate', { internalNote: 'Cannot reinstate revoked.' })).status).toBe(409);
    expect((await c.pool.query('SELECT status FROM public_certificate_index WHERE cert_no=$1', [cert.cert_no])).rows[0].status).toBe('REVOKED');
    expect((await c.pool.query('SELECT to_status FROM certificate_status_history WHERE certificate_id=$1 ORDER BY created_at', [cert.id])).rows.map((r) => r.to_status)).toEqual(['VALID', 'SUSPENDED', 'VALID', 'REVOKED']);
    expect((await owner.cl.get('/certificates?tab=REVOKED')).body.items.some((x: { id: string }) => x.id === cert.id)).toBe(true);
    expect((await notifs((await c.pool.query('SELECT owner_user_id FROM businesses b JOIN applications a ON a.business_id=b.id WHERE a.id=$1', [a.appId])).rows[0].owner_user_id, 'CERTIFICATE_REVOKED')).length).toBeGreaterThanOrEqual(1);
  });
  it('re-issue gives a new number that REPLACES the old one, which stays on record', async () => {
    const a = await inspected(); await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); const old = (await certOf(a.appId))[0];
    const r = await act(officer, old.id, 'reissue', { reason: 'Owner reported the printed copy was damaged.' }); expect(r.status).toBe(200); expect(r.body.certNo).not.toBe(old.cert_no); expect(r.body.replaces).toBe(old.cert_no);
    const rows = await certOf(a.appId); expect(rows).toHaveLength(2); const nu = rows.find((x) => x.cert_no === r.body.certNo)!;
    expect(nu.replaces_certificate_id).toBe(old.id); expect(nu.status).toBe('VALID'); expect(new Date(nu.valid_till).getTime()).toBe(new Date(old.valid_till).getTime()); expect(new Date(nu.verified_on).getTime()).toBe(new Date(old.verified_on).getTime());
    expect((await c.pool.query('SELECT status FROM certificates WHERE id=$1', [old.id])).rows[0].status).toBe('REPLACED');
    const pubOld = await new Client(c).init().then((p) => p.get(`/public/validate?cert=${encodeURIComponent(old.cert_no)}`)); expect(pubOld.body.result).toBe('REPLACED'); expect(pubOld.body.certificate.replacedBy).toBe(r.body.certNo);
    expect((await act(officer, old.id, 'reissue', { reason: 'Second time on the replaced one.' })).status).toBe(409);
    expect((await owner.cl.get(`/certificates/${nu.id}`)).body.content.replaces).toBe(old.cert_no);
  });
  it('stored certificates are immutable except for status', async () => {
    const [cert] = (await c.pool.query('SELECT id FROM certificates LIMIT 1')).rows;
    await expect(c.pool.query(`UPDATE certificates SET fingerprint='\\x00' WHERE id=$1`, [cert.id])).rejects.toThrow(/immutable/);
    await expect(c.pool.query(`UPDATE certificates SET cert_no='X' WHERE id=$1`, [cert.id])).rejects.toThrow(/immutable/);
  });
  it('detects a certificate whose stored content was altered', async () => {
    const a = await inspected(); await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); const cert = (await certOf(a.appId))[0];
    await c.pool.query(`UPDATE certificates SET content = jsonb_set(content, '{capacity}', '"500 kg"') WHERE id=$1`, [cert.id]);
    expect((await officer.get(`/certificates/${cert.id}`)).body.signature.status).toBe('MISMATCH');
  });
  it('key status is for admins only', async () => {
    const k = await admin.get('/admin/certificates/keys'); expect(k.status).toBe(200); expect(k.body.activeKeyId).toBeTruthy(); expect(k.body.issuedPerKey.reduce((s: number, x: { certificates: number }) => s + x.certificates, 0)).toBeGreaterThan(0);
    expect((await officer.get('/admin/certificates/keys')).status).toBe(403);
  });
});

describe('public validation', () => {
  let cert: { id: string; cert_no: string; fingerprint: Buffer; key_id: string }; let cert2: typeof cert; let pub: Client;
  beforeAll(async () => {
    const a = await inspected(); await decide(officer, { decision: 'APPROVE', applicationId: a.appId }); cert = (await certOf(a.appId))[0];
    const b = await inspected(); await decide(officer, { decision: 'APPROVE', applicationId: b.appId }); cert2 = (await certOf(b.appId))[0];
  });
  beforeEach(async () => { pub = await new Client(c).init(); for (const k of await c.redis.client.keys('pubmiss:*')) await c.redis.client.del(k); for (const k of await c.redis.client.keys('rl:pub-validate*')) await c.redis.client.del(k); });
  const slug = (no: string) => no.replace(/\//g, '-'); const sig = (x: typeof cert) => c.crypto.qrSig(x.key_id, x.cert_no, x.fingerprint.toString('hex'));

  it('returns the public-safe result by number, without any personal data', async () => {
    const r = await pub.get(`/public/validate?cert=${encodeURIComponent(cert.cert_no)}`); expect(r.status).toBe(200); expect(r.body.result).toBe('VERIFIED'); expect(r.body.signatureCheck).toBe('NOT_CHECKED');
    expect(r.body.certificate).toMatchObject({ certNo: cert.cert_no, category: 'Platform scale', accuracyClass: 'III', status: 'VALID', issuingOffice: 'Central Division' }); expect(r.body.certificate.daysRemaining).toBeGreaterThan(300);
    const txt = JSON.stringify(r.body); expect(r.body.certificate.holder).toMatch(/\*/); expect(txt).not.toMatch(/Sharma|Demo|@|serial|SN-|STK-|instrumentNo|NRK-INS/i);
    expect((await pub.get(`/public/validate?cert=${slug(cert.cert_no)}`)).body.result).toBe('VERIFIED'); expect((await pub.get(`/public/validate?cert=${encodeURIComponent(cert.cert_no.toLowerCase())}`)).body.result).toBe('VERIFIED');
  });
  it('the QR link verifies the signature; a forged or swapped signature shows nothing about the certificate', async () => {
    const ok = await pub.get(`/public/validate/qr/${slug(cert.cert_no)}.${sig(cert)}`); expect(ok.body.result).toBe('VERIFIED'); expect(ok.body.signatureCheck).toBe('MATCH');
    const s = sig(cert); const forged = s.slice(0, 21) + (s.endsWith('A') ? 'B' : 'A');
    for (const t of [`${slug(cert.cert_no)}.${forged}`, `${slug(cert.cert_no)}.${sig(cert2)}`, `${slug(cert.cert_no)}.short`, 'garbage', `${slug('NRK/CERT/CEN/2026/999999')}.${s}`]) {
      const r = await pub.get(`/public/validate/qr/${encodeURIComponent(t)}`); expect(r.status).toBe(200); expect(r.body).toEqual({ result: 'INVALID_QR' });
    }
  });
  it('unknown numbers get the same shape, take the same time, and are logged', async () => {
    const t = async (q: string) => { const s = Date.now(); const r = await pub.get(`/public/validate?cert=${encodeURIComponent(q)}`); return { r, ms: Date.now() - s }; };
    const hit = await t(cert.cert_no); const miss = await t('NRK/CERT/CEN/2026/999999'); const junk = await t('not a number at all');
    expect(miss.r.body).toEqual({ result: 'NOT_FOUND' }); expect(junk.r.body).toEqual({ result: 'NOT_FOUND' }); expect(miss.r.status).toBe(200);
    for (const x of [hit, miss, junk]) expect(x.ms).toBeGreaterThanOrEqual(140);
    expect(Math.abs(hit.ms - miss.ms)).toBeLessThan(120);
    expect((await c.pool.query(`SELECT 1 FROM public_lookup_log WHERE result IN ('VERIFIED','NOT_FOUND') AND created_at > now() - interval '1 minute'`)).rowCount).toBeGreaterThanOrEqual(3);
    expect((await pub.get('/public/validate')).status).toBe(422);
  });
  it('shows an expired certificate as expired', async () => {
    // the expiry sweeper (Phase 5) sets EXPIRED; the validation page also derives it from the date, covered by the unit test below
    await c.pool.query(`UPDATE certificates SET status='EXPIRED' WHERE id=$1`, [cert2.id]); await c.pool.query(`UPDATE public_certificate_index SET status='EXPIRED' WHERE cert_no=$1`, [cert2.cert_no]);
    const r = await pub.get(`/public/validate?cert=${encodeURIComponent(cert2.cert_no)}`); expect(r.body.result).toBe('EXPIRED'); expect(r.body.certificate.status).toBe('EXPIRED');
    expect(effectiveStatus('VALID', new Date('2020-01-01T00:00:00'), '2026-10-18')).toBe('EXPIRED'); expect(effectiveStatus('VALID', '2026-10-18', '2026-10-18')).toBe('VALID'); expect(effectiveStatus('REVOKED', '2020-01-01', '2026-10-18')).toBe('REVOKED');
    expect((await owner.cl.get('/certificates?tab=EXPIRED')).body.items.some((x: { id: string }) => x.id === cert2.id)).toBe(true);
  });
  it('asks for a CAPTCHA after repeated misses and rate-limits the endpoint', async () => {
    const spy = jest.spyOn(c.app.get(CaptchaService), 'verify').mockResolvedValue(false);
    for (let i = 0; i < 5; i++) expect((await pub.get(`/public/validate?cert=NRK/CERT/CEN/2026/${900000 + i}`)).body.result).toBe('NOT_FOUND');
    const blocked = await pub.get(`/public/validate?cert=${encodeURIComponent(cert.cert_no)}`); expect(blocked.status).toBe(403); expect(blocked.body.code).toBe('CAPTCHA_REQUIRED');
    spy.mockResolvedValue(true); expect((await pub.get(`/public/validate?cert=${encodeURIComponent(cert.cert_no)}&captchaToken=ok`)).status).toBe(200); spy.mockRestore();
    for (const k of await c.redis.client.keys('pubmiss:*')) await c.redis.client.del(k);
    let limited = 0; for (let i = 0; i < 35; i++) { const r = await request(c.app.getHttpServer()).get(`${API}/public/validate/qr/x`).set('X-Forwarded-For', '10.250.1.1'); if (r.status === 429) limited++; } expect(limited).toBeGreaterThan(0);
  });
});

describe('isolation', () => {
  it('row-level security: inspectors see only their own measurements; owners none; officers only through their area', async () => {
    const a = await inspected(); const run = async (role: string, extra: Record<string, string>) => {
      const cx = await c.pool.connect(); try {
        await cx.query('BEGIN'); await cx.query('SET LOCAL ROLE nirikshan_app'); await cx.query(`SELECT set_config('app.role',$1,true)`, [role]);
        for (const [k, v] of Object.entries(extra)) await cx.query(`SELECT set_config($1,$2,true)`, [k, v]);
        const out = { tm: (await cx.query('SELECT 1 FROM test_measurements WHERE visit_id=$1', [a.visitId])).rowCount, cl: (await cx.query('SELECT 1 FROM checklist_responses WHERE visit_id=$1', [a.visitId])).rowCount, dec: (await cx.query('SELECT 1 FROM decisions')).rowCount, ev: (await cx.query('SELECT 1 FROM evidence WHERE visit_id=$1', [a.visitId])).rowCount };
        await cx.query('ROLLBACK'); return out;
      } finally { cx.release(); }
    };
    const ownerBiz = (await c.pool.query('SELECT id FROM businesses WHERE owner_user_id=$1', [owner.id])).rows[0].id as string;
    expect(await run('INSPECTOR', { 'app.user_id': a.inspectorId })).toMatchObject({ tm: 3 }); expect(await run('INSPECTOR', { 'app.user_id': '00000000-0000-4000-8000-000000000001' })).toEqual({ tm: 0, cl: 0, dec: 0, ev: 0 });
    expect(await run('OWNER', { 'app.business_ids': `{${ownerBiz}}` })).toEqual({ tm: 0, cl: 0, dec: 0, ev: 0 });
    const area = (await c.pool.query(`SELECT id FROM areas WHERE code='DIV-CEN'`)).rows[0].id as string; const wards = (await c.pool.query(`SELECT id FROM areas WHERE level='WARD'`)).rows.map((r) => r.id).join(',');
    expect((await run('OFFICER', { 'app.area_ids': `{${wards},${area}}` })).tm).toBe(3); expect(await run('OFFICER', { 'app.area_ids': '{}' })).toEqual({ tm: 0, cl: 0, dec: 0, ev: 0 });
  });
  it('inspectors cannot reach officer or owner endpoints, and officers cannot work visits', async () => {
    const b = await booked();
    expect((await b.insp.get('/officer/cases')).status).toBe(403); expect((await b.insp.get('/certificates')).status).toBe(403); expect((await owner.cl.get('/inspector/visits')).status).toBe(403);
    expect((await officer.get(`/inspector/visits/${b.visitId}`)).status).toBe(403); expect((await arrive(officer, b.visitId)).status).toBe(403);
    expect((await owner.cl.post(`/officer/cases/${b.appId}/reinspect`, { remarks: 'owner trying to do this' }, { 'Idempotency-Key': key() })).status).toBe(403);
    expect((await owner.cl.post('/certificates/00000000-0000-4000-8000-000000000001/revoke', { reasonCode: 'MISUSE', internalNote: 'owner trying revoke' }, { 'Idempotency-Key': key() })).status).toBe(403);
  });
  it('the audit chain is still intact after all of this', async () => {
    const v = await admin.post('/admin/audit/verify-chain'); expect(v.status).toBe(200); expect(v.body.intact).toBe(true); expect(v.body.checked).toBeGreaterThan(100);
  });
});

function sortDeep(v: unknown): unknown { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortDeep(x)])) : v; }
void request;
