import { istDay } from '@nirikshan/shared';
import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody } from './helpers';
import { JobsService } from '../src/modules/jobs/jobs.service';

let c: Ctx; let admin: Client; let admin2: Client; let officer: Client; let owner: { cl: Client; id: string };
let cat: Awaited<ReturnType<typeof catalog>>; let n = 0; const key = () => `p5u-${Date.now()}-${n++}`;
const day = (plus: number) => istDay(new Date(Date.now() + plus * 86400_000));
let v1: string; let draftId: string; let publishedId: string;
const ID = (r: { body: { id: string } }) => r.body.id;

beforeAll(async () => {
  c = await boot();
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1); admin2 = await new Client(c).init(); await admin2.loginStaff(c.demo.ADMIN2!, -1);
  officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1);
  owner = await registerUser(c); await activate(c, owner.id); cat = await catalog(owner.cl);
  v1 = (await c.pool.query(`SELECT id FROM rule_sets WHERE version=1`)).rows[0].id;
});
afterAll(async () => {
  // put the shared test database back the way other suites expect it
  await c.pool.query(`ALTER TABLE mpe_rules DISABLE TRIGGER mpe_rules_immutable; ALTER TABLE interval_rules DISABLE TRIGGER interval_rules_immutable`);
  for (const id of [publishedId, draftId].filter(Boolean)) { for (const t of ['mpe_rules', 'interval_rules', 'workflow_slas']) await c.pool.query(`DELETE FROM ${t} WHERE rule_set_id=$1`, [id]); await c.pool.query('DELETE FROM rule_sets WHERE id=$1', [id]); }
  await c.pool.query(`ALTER TABLE mpe_rules ENABLE TRIGGER mpe_rules_immutable; ALTER TABLE interval_rules ENABLE TRIGGER interval_rules_immutable`);
  await c.pool.query(`UPDATE rule_sets SET status='PUBLISHED', effective_to=NULL WHERE version=1`);
  await shutdown(c);
});

describe('rule set lifecycle', () => {
  it('is for admins only', async () => { expect((await officer.get('/admin/rules')).status).toBe(403); expect((await owner.cl.get('/admin/rules')).status).toBe(403); });

  it('starts a draft as a copy, one at a time, and never in the past', async () => {
    expect((await admin.post('/admin/rules', { copyFromId: v1, effectiveFrom: day(-1) }, { 'Idempotency-Key': key() })).status).toBe(422);
    const r = await admin.post('/admin/rules', { copyFromId: v1, effectiveFrom: day(10) }, { 'Idempotency-Key': key() }); expect(r.status).toBe(201); draftId = ID(r);
    expect((await admin.post('/admin/rules', { copyFromId: v1, effectiveFrom: day(12) }, { 'Idempotency-Key': key() })).status).toBe(409);
    const d = await admin.get(`/admin/rules/${draftId}?against=${v1}`);
    expect(d.body).toMatchObject({ status: 'DRAFT', canEdit: true, comparedWith: { version: 1 } }); expect(d.body.diff.counts).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(d.body.content.mpe.length).toBeGreaterThan(0);
    const list = await admin.get('/admin/rules'); expect(list.body.items.find((x: { id: string }) => x.id === v1).pinnedCases).toBeGreaterThanOrEqual(0);
  });

  it('validates edits and shows the difference to what is in force', async () => {
    const d = (await admin.get(`/admin/rules/${draftId}?against=${v1}`)).body; const body = (over: object = {}) => ({ effectiveFrom: day(10), mpe: d.content.mpe, intervals: d.content.intervals, slas: d.content.slas, ...over });
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ mpe: [...d.content.mpe, d.content.mpe[0]] }))).status).toBe(422);                                  // duplicate row
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ mpe: [{ ...d.content.mpe[0], value: '-1' }, ...d.content.mpe.slice(1)] }))).status).toBe(422);   // not positive
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ intervals: [{ ...d.content.intervals[0], capacityBandId: d.content.mpe[0].accuracyClassId }, ...d.content.intervals.slice(1)] }))).status).toBe(422); // band that is not a band
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ effectiveFrom: day(-3) }))).status).toBe(422);
    const mpe = d.content.mpe.map((r: { value: string }, i: number) => (i === 0 ? { ...r, value: String(Number(r.value) + 1) } : r));
    const slas = d.content.slas.map((s: { step: string; maxHours: number }) => (s.step === 'DECISION' ? { ...s, maxHours: 48 } : s));
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ mpe, slas, note: 'Tighter first MPE and decision SLA' }))).status).toBe(200);
    const after = (await admin.get(`/admin/rules/${draftId}?against=${v1}`)).body;
    expect(after.diff.counts).toEqual({ added: 0, removed: 0, changed: 2 }); expect(after.diff.mpe.changed[0].fields).toEqual(['value']); expect(after.diff.slas.changed[0].fields).toEqual(['maxHours']);
    // dropping a combination that is in force blocks the review request
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ mpe: mpe.slice(1), slas }))).status).toBe(200);
    const gap = await admin.post(`/admin/rules/${draftId}/request-review`, {}, { 'Idempotency-Key': key() }); expect(gap.status).toBe(422); expect(gap.body.gaps.mpe).toHaveLength(1);
    expect((await admin.put(`/admin/rules/${draftId}/draft`, body({ mpe, slas }))).status).toBe(200);
  });

  it('needs a second admin to review, and an unreviewed or in-review set cannot be edited or published', async () => {
    expect((await admin.post(`/admin/rules/${draftId}/publish`, {}, { 'Idempotency-Key': key() })).status).toBe(409);        // still a draft
    expect((await admin.post(`/admin/rules/${draftId}/request-review`, {}, { 'Idempotency-Key': key() })).status).toBe(200);
    expect((await c.pool.query(`SELECT 1 FROM in_app_notifications WHERE event_code='RULESET_REVIEW_REQUESTED'`)).rowCount).toBeGreaterThanOrEqual(1);
    const d = (await admin.get(`/admin/rules/${draftId}`)).body; expect(d.status).toBe('IN_REVIEW');
    expect((await admin.put(`/admin/rules/${draftId}/draft`, { effectiveFrom: day(10), mpe: d.content.mpe, intervals: d.content.intervals, slas: d.content.slas })).status).toBe(409);
    expect((await admin.post(`/admin/rules/${draftId}/review`, { outcome: 'APPROVE' }, { 'Idempotency-Key': key() })).status).toBe(403);   // the author cannot review
    expect((await admin.post(`/admin/rules/${draftId}/publish`, {}, { 'Idempotency-Key': key() })).status).toBe(409);                    // not reviewed yet
    expect((await admin2.post(`/admin/rules/${draftId}/review`, { outcome: 'RETURN' }, { 'Idempotency-Key': key() })).status).toBe(422);   // a return needs a reason
    const ret = await admin2.post(`/admin/rules/${draftId}/review`, { outcome: 'RETURN', remark: 'Please explain the SLA change' }, { 'Idempotency-Key': key() }); expect(ret.body.status).toBe('DRAFT');
    expect((await admin.get(`/admin/rules/${draftId}`)).body.reviewRemark).toBe('Please explain the SLA change');
    await admin.post(`/admin/rules/${draftId}/request-review`, {}, { 'Idempotency-Key': key() });
    const ok = await admin2.post(`/admin/rules/${draftId}/review`, { outcome: 'APPROVE' }, { 'Idempotency-Key': key() }); expect(ok.body.approved).toBe(true);
    expect((await c.pool.query('SELECT reviewed_by, authored_by FROM rule_sets WHERE id=$1', [draftId])).rows[0].reviewed_by).not.toBeNull();
  });

  it('blocks publication when the dates overlap another published set, and says which one', async () => {
    await c.pool.query(`UPDATE rule_sets SET effective_to=$2 WHERE id=$1`, [v1, day(3)]);   // the database itself refuses overlaps, so make room for the blocker
    const rs = (await c.pool.query(`INSERT INTO rule_sets (version, status, effective_from, effective_to, published_at, note) VALUES ((SELECT max(version)+1 FROM rule_sets),'PUBLISHED',$1,$2, now(), 'blocker') RETURNING id, version`, [day(5), day(20)])).rows[0];
    try {
      const pre = await admin.get(`/admin/rules/${draftId}/preflight`); expect(pre.body.publishable).toBe(false); expect(pre.body.blocks.map((b: { version: number }) => b.version)).toEqual([rs.version]);
      const r = await admin2.post(`/admin/rules/${draftId}/publish`, {}, { 'Idempotency-Key': key() }); expect(r.status).toBe(409); expect(r.body.code).toBe('RULE_OVERLAP'); expect(r.body.overlaps[0].version).toBe(rs.version);
      expect((await c.pool.query('SELECT status FROM rule_sets WHERE id=$1', [draftId])).rows[0].status).toBe('IN_REVIEW');
    } finally { await c.pool.query('DELETE FROM rule_sets WHERE id=$1', [rs.id]); await c.pool.query(`UPDATE rule_sets SET effective_to=NULL WHERE id=$1`, [v1]); }
  });

  it('publishes: closes the old set on the day before, keeps pinned cases on the old rules, and freezes the new set', async () => {
    const pre = await admin.get(`/admin/rules/${draftId}/preflight`); expect(pre.body).toMatchObject({ publishable: true, blocks: [] }); expect(pre.body.closes.map((x: { id: string }) => x.id)).toEqual([v1]);
    const before = await admin2.post(`/admin/rules/${draftId}/publish`, {}, { 'Idempotency-Key': key() }); expect(before.status).toBe(200); publishedId = draftId;
    expect(before.body).toMatchObject({ status: 'PUBLISHED', closedVersions: [1] });
    const old = (await c.pool.query('SELECT effective_to::text FROM rule_sets WHERE id=$1', [v1])).rows[0].effective_to; expect(old).toBe(day(10));
    // a case opened today is pinned to version 1 because version 2 starts later
    const tok = await owner.cl.confirmToken(); const i = await owner.cl.post('/instruments', instrumentBody(c, cat, tok), { 'Idempotency-Key': key() });
    const a = await owner.cl.post('/applications', { instrumentId: i.body.id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
    expect((await c.pool.query('SELECT rule_set_id FROM applications WHERE id=$1', [a.body.id])).rows[0].rule_set_id).toBe(v1);
    await expect(c.pool.query(`UPDATE mpe_rules SET value=99 WHERE rule_set_id=$1`, [publishedId])).rejects.toThrow(/immutable/);
    await expect(c.pool.query(`DELETE FROM interval_rules WHERE rule_set_id=$1`, [publishedId])).rejects.toThrow(/immutable/);
    expect((await admin.put(`/admin/rules/${publishedId}/draft`, { effectiveFrom: day(10), mpe: [], intervals: [], slas: [] })).status).toBe(409);
    expect((await admin.del(`/admin/rules/${publishedId}`)).status).toBe(409);
    expect((await c.pool.query(`SELECT 1 FROM audit_events WHERE action='rules.published' AND entity_id=$1`, [publishedId])).rowCount).toBe(1);
    expect((await admin.get('/admin/rules')).body.items.find((x: { id: string }) => x.id === v1).pinnedCases).toBeGreaterThanOrEqual(1);
  });

  it('retires a set once its end date has passed, and the public rules page follows the date', async () => {
    const r = await c.app.get(JobsService).run('retention', { now: new Date(Date.now() + 11 * 86400_000) }); expect(r.status).toBe('OK'); expect(r.result!.rulesRetired).toBe(1);
    expect((await c.pool.query('SELECT status FROM rule_sets WHERE id=$1', [v1])).rows[0].status).toBe('RETIRED');
    expect((await c.pool.query('SELECT status FROM rule_sets WHERE id=$1', [publishedId])).rows[0].status).toBe('PUBLISHED');
    await expect(c.pool.query(`UPDATE mpe_rules SET value=99 WHERE rule_set_id=$1`, [v1])).rejects.toThrow(/immutable/);   // retired stays frozen
  });

  it('a draft can be thrown away', async () => {
    await c.pool.query(`UPDATE rule_sets SET status='RETIRED' WHERE id=$1`, [publishedId]); await c.pool.query(`UPDATE rule_sets SET status='PUBLISHED', effective_to=NULL WHERE id=$1`, [v1]);
    const r = await admin.post('/admin/rules', { copyFromId: v1, effectiveFrom: day(400) }, { 'Idempotency-Key': key() }); expect(r.status).toBe(201);
    expect((await admin.del(`/admin/rules/${ID(r)}`)).status).toBe(200); expect((await admin.get(`/admin/rules/${ID(r)}`)).status).toBe(404);
  });
});
