import ExcelJS from 'exceljs';
import { boot, shutdown, Client, Ctx, registerUser, activate, catalog, instrumentBody } from './helpers';

let c: Ctx; let admin: Client; let officer: Client; let owner: { cl: Client; id: string }; let cat: Awaited<ReturnType<typeof catalog>>; let n = 0; const key = () => `p5p-${Date.now()}-${n++}`;
const ALL = ['registry', 'pending-ageing', 'document-pending', 'scheduled-visits', 'certificate-register', 'expired-enforcement', 'inspector-performance', 'category-rejection', 'grievance-register', 'renewal-compliance', 'sla-compliance', 'user-activity', 'audit-extract'];
const AREA_ONLY = ALL.filter((x) => !['user-activity', 'audit-extract'].includes(x));
const bin = (cl: Client, url: string) => cl.agent.get('/api/v1' + url).set('X-Forwarded-For', cl.ip).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });

beforeAll(async () => {
  c = await boot();
  admin = await new Client(c).init(); await admin.loginStaff(c.demo.ADMIN!, -1); officer = await new Client(c).init(); await officer.loginStaff(c.demo.OFFICER!, -1);
  owner = await registerUser(c); await activate(c, owner.id); cat = await catalog(owner.cl);
  const tok = await owner.cl.confirmToken(); const i = await owner.cl.post('/instruments', instrumentBody(c, cat, tok, { serialNo: '=cmd|calc' }), { 'Idempotency-Key': key() });
  await owner.cl.post('/applications', { instrumentId: i.body.id, type: 'NEW', declarationAccepted: true }, { 'Idempotency-Key': key() });
  await owner.cl.post('/grievances', { subject: '=HYPERLINK("x")', body: 'A grievance that starts with a formula.' }, { 'Idempotency-Key': key() });
});
afterAll(() => shutdown(c));

describe('report library', () => {
  it('lists reports by role: officers get the area reports, admins also get user activity and the audit extract, others nothing', async () => {
    expect((await officer.get('/reports')).body.items.map((x: { id: string }) => x.id).sort()).toEqual([...AREA_ONLY].sort());
    expect((await admin.get('/reports')).body.items.map((x: { id: string }) => x.id).sort()).toEqual([...ALL].sort());
    expect((await owner.cl.get('/reports')).status).toBe(403); expect((await officer.get('/reports/audit-extract')).status).toBe(404); expect((await officer.get('/reports/user-activity')).status).toBe(404);
  });
  it.each(ALL)('runs %s as admin with valid columns and rows of the right width', async (id) => {
    const r = await admin.get(`/reports/${id}`); expect(r.status).toBe(200); expect(r.body.columns.length).toBeGreaterThan(2);
    for (const row of r.body.rows) expect(row).toHaveLength(r.body.columns.length);
    if (['registry', 'pending-ageing', 'user-activity', 'audit-extract'].includes(id)) expect(r.body.rows.length).toBeGreaterThan(0);
  });
  it.each(AREA_ONLY)('runs %s as an officer', async (id) => { expect((await officer.get(`/reports/${id}`)).status).toBe(200); });
  it('shows owner names to staff and applies filters and date checks', async () => {
    const r = await officer.get('/reports/registry?status=REGISTERED'); expect(r.body.rows.some((x: string[]) => x[1] === 'Sharma General Store')).toBe(true); expect(r.body.rows.every((x: string[]) => x[8] === 'REGISTERED')).toBe(true);
    expect((await officer.get('/reports/registry?from=2027-01-01&to=2026-01-01')).status).toBe(422);
    expect((await officer.get('/reports/registry?from=2010-01-01&to=2026-01-01')).status).toBe(422);
    expect((await officer.get('/reports/registry?from=bad')).status).toBe(422);
    const far = await officer.get('/reports/registry?areaId=00000000-0000-4000-8000-000000000000'); expect(far.body.rows).toEqual([]);
  });
  it('ageing buckets a waiting application and the SLA report only lists deadline trouble', async () => {
    const r = await admin.get('/reports/pending-ageing?status=APPLIED'); expect(r.body.rows[0][6]).toBe('0-2 days');
    await c.pool.query(`UPDATE applications SET created_at = now() - interval '20 days' WHERE status='APPLIED'`);
    const r2 = await admin.get('/reports/pending-ageing?status=APPLIED'); expect(r2.body.rows[0][6]).toBe('over 14 days');
    const s = await admin.get('/reports/sla-compliance'); expect(s.body.rows.length).toBeGreaterThan(0); expect(s.body.rows.every((x: Cell[]) => x[4] === 'Past deadline' || x[4] === 'At risk')).toBe(true);
    expect((await admin.get('/reports/sla-compliance?status=AT_RISK')).body.rows.every((x: Cell[]) => x[4] === 'At risk')).toBe(true);
  });
  it('downloads CSV with formulas defused, a real XLSX and a PDF, and records each export', async () => {
    const csv = await bin(admin, '/reports/registry/download?format=csv'); expect(csv.status).toBe(200); expect(csv.headers['content-type']).toContain('text/csv');
    const text = (csv.body as Buffer).toString('utf8'); expect(text.startsWith('﻿Instrument no,')).toBe(true); expect(text).toContain("'=cmd|calc"); expect(text).not.toMatch(/,=cmd/);
    const g = (await bin(admin, '/reports/grievance-register/download?format=csv')).body.toString('utf8'); expect(g).toContain(`'=HYPERLINK`);
    const x = await bin(admin, '/reports/registry/download?format=xlsx'); expect(x.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as never); const ws = wb.worksheets[0]!; expect(ws.getRow(1).getCell(1).value).toBe('Instrument no'); expect(ws.rowCount).toBeGreaterThan(1);
    const pdf = await bin(officer, '/reports/certificate-register/download?format=pdf'); expect(pdf.status).toBe(200); expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-'); expect(pdf.headers['x-report-truncated']).toBe('false');
    expect((await bin(admin, '/reports/registry/download?format=docx')).status).toBe(422);
    expect((await bin(owner.cl, '/reports/registry/download?format=csv')).status).toBe(403);
    expect((await c.pool.query(`SELECT count(*)::int n FROM audit_events WHERE action='report.exported'`)).rows[0].n).toBeGreaterThanOrEqual(4);
  });
});

type Cell = string | number | null;
describe('dashboards', () => {
  it('officer dashboard has queues, work, deadlines, compliance and an 8-week trend', async () => {
    const r = await officer.get('/officer/dashboard'); expect(r.status).toBe(200);
    expect(Object.keys(r.body.queues).sort()).toEqual(['accounts', 'deregistrations', 'duplicates', 'grievances', 'tamperReports', 'transfers']);
    expect(r.body.work.documentsToCheck).toBeGreaterThanOrEqual(1); expect(r.body.trend).toHaveLength(8); expect(r.body.queues.grievances).toBeGreaterThanOrEqual(1);
    expect(r.body.deadlines.breached).toBeGreaterThanOrEqual(1); expect(r.body.trend.reduce((s: number, w: { applications: number }) => s + w.applications, 0)).toBeGreaterThanOrEqual(1);
    expect((await owner.cl.get('/officer/dashboard')).status).toBe(403); expect((await admin.get('/officer/dashboard')).status).toBe(403);
  });
  it('admin dashboard has people, registry, health, privacy and rules', async () => {
    const r = await admin.get('/admin/dashboard'); expect(r.status).toBe(200);
    expect(r.body.people.find((x: { role: string }) => x.role === 'ADMIN')).toBeTruthy(); expect(r.body.registry.openApplications).toBeGreaterThanOrEqual(1);
    expect(r.body.health).toHaveProperty('schedulerOn'); expect(r.body.rules.inForce.version).toBeGreaterThanOrEqual(1); expect(r.body.privacy).toHaveProperty('overdueRequests');
    expect(r.body.backlogByArea.length).toBeGreaterThan(0); expect(r.body.trend).toHaveLength(8);
    expect((await officer.get('/admin/dashboard')).status).toBe(403);
  });
});
