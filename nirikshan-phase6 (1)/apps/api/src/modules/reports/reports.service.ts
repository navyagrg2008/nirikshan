import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { istDay, roleHas } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { LifecycleService } from '../jobs/lifecycle.service';
import { conflict, notFound, unprocessable } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

export const CSV_CAP = 50_000; export const PDF_CAP = 1_500; const PREVIEW = 200;
type Cell = string | number | null;
type Row = Cell[];
export interface Params { from: string; to: string; areaId?: string; status?: string }
interface Col { key: string; label: string }
interface Def {
  id: string; title: string; description: string; audience: 'AREA' | 'ADMIN'; filters: ('date' | 'area' | 'status')[]; statusHint?: string[]; columns: Col[];
  run: (tx: Tx, p: Params, u: SessionUser, cap: number, now: Date) => Promise<Row[]>;
}
const cols = (s: string): Col[] => s.split(',').map((x) => { const [key, label] = x.split(':'); return { key: key!.trim(), label: (label ?? key)!.trim() }; });
const d = (v: unknown): Cell => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const t = (v: unknown): Cell => (v == null ? null : new Date(v as string).toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '').slice(0, 16));
const n = (v: unknown): Cell => (v == null ? null : Number(v));
const TERMINAL = `('REJECTED','CANCELLED','APPLICATION_EXPIRED','CERTIFICATE_ISSUED')`;
const AGE = (col: string) => `floor(extract(epoch FROM (now() - ${col})) / 86400)::int`;

@Injectable()
export class ReportsService {
  private defs: Def[];
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private life: LifecycleService) {
    const firm = (x: unknown) => this.crypto.decStr(x as Buffer | null);
    const q = (tx: Tx, sql: string, args: unknown[]) => tx.query(sql, args).then((r) => r.rows);
    this.defs = [
      { id: 'registry', title: 'Instrument registry', description: 'Every registered instrument with its owner, category and status.', audience: 'AREA', filters: ['date', 'area', 'status'], statusHint: ['REGISTERED', 'ACTIVE', 'DUE_FOR_RENEWAL', 'EXPIRED', 'DEREGISTERED'],
        columns: cols('no:Instrument no,firm:Owner firm,category:Category,capacity:Capacity,class:Class,serial:Serial,make:Make,area:Area,status:Status,verified:First verified,registered:Registered on'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT i.instrument_no, b.firm_name_enc, c.name_en, i.capacity::float8 || ' ' || i.capacity_unit AS cap, ac.code, i.serial_no, i.make, a.name_en AS area, i.status, i.first_verified_at, i.created_at
          FROM instruments i JOIN businesses b ON b.id=i.business_id JOIN categories c ON c.id=i.category_id JOIN accuracy_classes ac ON ac.id=i.accuracy_class_id JOIN areas a ON a.id=i.area_id
          WHERE i.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.area_id=$3) AND ($4::text IS NULL OR i.status::text=$4) ORDER BY i.created_at DESC LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [r.instrument_no, firm(r.firm_name_enc), r.name_en, r.cap, r.code, r.serial_no, r.make, r.area, r.status, d(r.first_verified_at), d(r.created_at)]) },
      { id: 'pending-ageing', title: 'Pending applications by age', description: 'Open applications and how long each has been waiting.', audience: 'AREA', filters: ['date', 'area', 'status'], statusHint: ['APPLIED', 'DOCUMENT_CHECKED', 'SCHEDULED', 'INSPECTION_IN_PROGRESS', 'FAILED_ATTEMPT', 'INSPECTED', 'REFERRED', 'APPROVED'],
        columns: cols('no:Application,type:Type,status:Status,area:Area,created:Applied on,age:Days waiting,bucket:Age group'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT a.application_no, a.type, a.status, ar.name_en AS area, a.created_at, ${AGE('a.created_at')} AS age FROM applications a JOIN areas ar ON ar.id=a.area_id
          WHERE a.status NOT IN ${TERMINAL} AND a.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.area_id=$3) AND ($4::text IS NULL OR a.status::text=$4) ORDER BY a.created_at LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [r.application_no, r.type, r.status, r.area, d(r.created_at), n(r.age), r.age <= 2 ? '0-2 days' : r.age <= 7 ? '3-7 days' : r.age <= 14 ? '8-14 days' : 'over 14 days']) },
      { id: 'document-pending', title: 'Document-pending cases', description: 'Applications still in the document stage, with how many files are waiting for review or flagged.', audience: 'AREA', filters: ['date', 'area'],
        columns: cols('no:Application,area:Area,created:Applied on,age:Days waiting,total:Files,waiting:Waiting review,flagged:Flagged'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT a.application_no, ar.name_en AS area, a.created_at, ${AGE('a.created_at')} AS age,
            count(d.id)::int AS total, count(d.id) FILTER (WHERE d.review='PENDING')::int AS waiting, count(d.id) FILTER (WHERE d.review='FLAGGED')::int AS flagged
          FROM applications a JOIN areas ar ON ar.id=a.area_id LEFT JOIN application_documents d ON d.application_id=a.id AND d.doc_version = (SELECT max(x.doc_version) FROM application_documents x WHERE x.application_id=d.application_id AND x.document_type_id=d.document_type_id)
          WHERE a.status='APPLIED' AND a.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.area_id=$3) GROUP BY a.id, ar.name_en ORDER BY a.created_at LIMIT $4`, [p.from, p.to, p.areaId ?? null, cap + 1]))
          .map((r) => [r.application_no, r.area, d(r.created_at), n(r.age), n(r.total), n(r.waiting), n(r.flagged)]) },
      { id: 'scheduled-visits', title: 'Scheduled visits', description: 'Inspection visits planned in the period.', audience: 'AREA', filters: ['date', 'area', 'status'], statusHint: ['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'NO_SHOW', 'CANCELLED'],
        columns: cols('no:Application,inspector:Inspector,start:Starts,end:Ends,status:Status,mode:Booked by,area:Area'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT a.application_no, u.display_name_masked AS inspector, lower(v.scheduled_window) AS s, upper(v.scheduled_window) AS e, v.status, v.assigned_by, ar.name_en AS area
          FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN users u ON u.id=v.inspector_id JOIN areas ar ON ar.id=a.area_id
          WHERE lower(v.scheduled_window)::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.area_id=$3) AND ($4::text IS NULL OR v.status=$4) ORDER BY lower(v.scheduled_window) LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [r.application_no, r.inspector, t(r.s), t(r.e), r.status, r.assigned_by ? 'Officer' : 'Automatic', r.area]) },
      { id: 'certificate-register', title: 'Certificate register', description: 'Certificates issued in the period with their validity and status.', audience: 'AREA', filters: ['date', 'area', 'status'], statusHint: ['VALID', 'EXPIRED', 'REVOKED', 'SUSPENDED', 'REPLACED'],
        columns: cols('cert:Certificate,instrument:Instrument,area:Area,status:Status,verified:Verified on,till:Valid till,marginal:Marginal'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT c.cert_no, i.instrument_no, ar.name_en AS area, c.status, c.verified_on, c.valid_till, c.marginal FROM certificates c JOIN instruments i ON i.id=c.instrument_id JOIN areas ar ON ar.id=i.area_id
          WHERE c.verified_on BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.area_id=$3) AND ($4::text IS NULL OR c.status::text=$4) ORDER BY c.verified_on DESC, c.cert_no LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [r.cert_no, r.instrument_no, r.area, r.status, d(r.verified_on), d(r.valid_till), r.marginal ? 'Yes' : 'No']) },
      { id: 'expired-enforcement', title: 'Expired and enforcement', description: 'Instruments whose verification has lapsed, how long ago, and where they stand in an enforcement drive.', audience: 'AREA', filters: ['area'],
        columns: cols('instrument:Instrument,firm:Owner firm,area:Area,till:Verification ended,overdue:Days overdue,drive:Drive,stage:Stage'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT i.instrument_no, b.firm_name_enc, ar.name_en AS area, x.till, CASE WHEN x.till IS NULL THEN NULL ELSE (current_date - x.till) END AS overdue, dr.name AS drive, dr.stage
          FROM instruments i JOIN businesses b ON b.id=i.business_id JOIN areas ar ON ar.id=i.area_id
          CROSS JOIN LATERAL (SELECT COALESCE((SELECT max(valid_till) FROM certificates c WHERE c.instrument_id=i.id), i.legacy_valid_till) AS till) x
          LEFT JOIN LATERAL (SELECT d.name, di.stage FROM enforcement_drive_items di JOIN enforcement_drives d ON d.id=di.drive_id WHERE di.instrument_id=i.id ORDER BY d.created_at DESC LIMIT 1) dr ON true
          WHERE i.status='EXPIRED' AND ($1::uuid IS NULL OR i.area_id=$1) ORDER BY x.till NULLS LAST LIMIT $2`, [p.areaId ?? null, cap + 1]))
          .map((r) => [r.instrument_no, firm(r.firm_name_enc), r.area, d(r.till), n(r.overdue), r.drive ?? '-', r.stage ?? 'Not in a drive']) },
      { id: 'inspector-performance', title: 'Inspector performance', description: 'Visits handled, turnaround and recommendations per inspector.', audience: 'AREA', filters: ['date', 'area'],
        columns: cols('inspector:Inspector,assigned:Visits assigned,done:Completed,noshow:No-shows,hours:Avg hours from start to report,approve:Recommend approve,reject:Recommend reject'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT u.display_name_masked AS inspector, count(*)::int AS assigned, count(*) FILTER (WHERE v.status='SUBMITTED')::int AS done, count(*) FILTER (WHERE v.status='NO_SHOW')::int AS noshow,
            round(avg(extract(epoch FROM (v.submitted_at - lower(v.scheduled_window))) / 3600) FILTER (WHERE v.submitted_at IS NOT NULL)::numeric, 1) AS hours,
            count(*) FILTER (WHERE v.recommendation::text LIKE '%APPROVE%')::int AS approve, count(*) FILTER (WHERE v.recommendation::text LIKE '%REJECT%')::int AS rej
          FROM inspection_visits v JOIN applications a ON a.id=v.application_id JOIN users u ON u.id=v.inspector_id
          WHERE v.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.area_id=$3) GROUP BY u.id, u.display_name_masked ORDER BY done DESC, inspector LIMIT $4`, [p.from, p.to, p.areaId ?? null, cap + 1]))
          .map((r) => [r.inspector, n(r.assigned), n(r.done), n(r.noshow), n(r.hours), n(r.approve), n(r.rej)]) },
      { id: 'category-rejection', title: 'Rejection by category', description: 'For each instrument category: decided cases and how many were rejected.', audience: 'AREA', filters: ['date', 'area'],
        columns: cols('category:Category,decided:Decided,rejected:Rejected,rate:Rejection rate %'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT c.name_en AS category, count(*)::int AS decided, count(*) FILTER (WHERE a.status='REJECTED')::int AS rejected
          FROM applications a JOIN instruments i ON i.id=a.instrument_id JOIN categories c ON c.id=i.category_id
          WHERE a.status IN ('REJECTED','APPROVED','CERTIFICATE_ISSUED') AND a.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.area_id=$3) GROUP BY c.id, c.name_en ORDER BY rejected DESC, category LIMIT $4`, [p.from, p.to, p.areaId ?? null, cap + 1]))
          .map((r) => [r.category, n(r.decided), n(r.rejected), r.decided ? Math.round((r.rejected / r.decided) * 1000) / 10 : 0]) },
      { id: 'grievance-register', title: 'Grievance register', description: 'Grievances raised in the period, their deadline and outcome.', audience: 'AREA', filters: ['date', 'area', 'status'], statusHint: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
        columns: cols('ref:Reference,subject:Subject,status:Status,area:Area,raised:Raised on,due:Reply by,resolved:Closed on,late:Late'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT g.ref_no, g.subject, g.status, ar.name_en AS area, g.created_at, g.due_at, g.resolved_at, (COALESCE(g.resolved_at, now()) > g.due_at) AS late FROM grievances g LEFT JOIN areas ar ON ar.id=g.area_id
          WHERE g.created_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR g.area_id=$3) AND ($4::text IS NULL OR g.status::text=$4) ORDER BY g.created_at DESC LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [r.ref_no, r.subject, r.status, r.area ?? '-', d(r.created_at), d(r.due_at), d(r.resolved_at), r.late ? 'Yes' : 'No']) },
      { id: 'renewal-compliance', title: 'Renewal compliance', description: 'Certificates that ended in the period and whether the owner renewed on time, late, or not at all.', audience: 'AREA', filters: ['date', 'area', 'status'], statusHint: ['RENEWED_ON_TIME', 'RENEWED_LATE', 'NOT_RENEWED', 'NOT_DUE_YET'],
        columns: cols('cert:Certificate,instrument:Instrument,area:Area,till:Valid till,next:Next certificate issued,outcome:Outcome'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT * FROM (SELECT c.cert_no, i.instrument_no, ar.name_en AS area, c.valid_till, nx.at AS next_at,
            CASE WHEN nx.at IS NOT NULL AND nx.at::date <= c.valid_till THEN 'RENEWED_ON_TIME' WHEN nx.at IS NOT NULL THEN 'RENEWED_LATE' WHEN c.valid_till >= current_date THEN 'NOT_DUE_YET' ELSE 'NOT_RENEWED' END AS outcome
          FROM certificates c JOIN instruments i ON i.id=c.instrument_id JOIN areas ar ON ar.id=i.area_id
          LEFT JOIN LATERAL (SELECT min(n.created_at) AS at FROM certificates n WHERE n.instrument_id=c.instrument_id AND n.created_at > c.created_at) nx ON true
          WHERE c.valid_till BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.area_id=$3)) z WHERE ($4::text IS NULL OR z.outcome=$4) ORDER BY z.valid_till LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [r.cert_no, r.instrument_no, r.area, d(r.valid_till), d(r.next_at), r.outcome]) },
      { id: 'sla-compliance', title: 'Deadline compliance (open cases)', description: 'Open cases that are past, or close to, the deadline for their current step.', audience: 'AREA', filters: ['area', 'status'], statusHint: ['BREACHED', 'AT_RISK'],
        columns: cols('no:Application,step:Step,started:Step started,due:Deadline,state:State,late:Hours past deadline'),
        run: async (tx, p, u, cap, now) => {
          const scope = p.areaId ? [p.areaId] : u.role === 'ADMIN' ? undefined : u.areaIds;
          return (await this.life.slaScan(tx, now, scope)).filter((r) => !p.status || r.state === p.status).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()).slice(0, cap + 1)
            .map((r) => [r.applicationNo, r.step.replace('_', ' ').toLowerCase(), t(r.startedAt), t(r.dueAt), r.state === 'BREACHED' ? 'Past deadline' : 'At risk', r.state === 'BREACHED' ? Math.round((now.getTime() - r.dueAt.getTime()) / 360000) / 10 : 0]);
        } },
      { id: 'user-activity', title: 'User activity', description: 'Who is active: last sign-in and number of recorded actions in the period.', audience: 'ADMIN', filters: ['date', 'status'], statusHint: ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'DEACTIVATED', 'INVITED', 'REJECTED'],
        columns: cols('name:User,role:Role,status:Account,last:Last sign-in,actions:Actions in period'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT u.display_name_masked AS name, r.code AS role, u.account_status, u.last_login_at, (SELECT count(*)::int FROM audit_events e WHERE e.actor_id=u.id AND e.occurred_at::date BETWEEN $1 AND $2) AS actions
          FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE ($3::text IS NULL OR u.account_status::text=$3) ORDER BY actions DESC, u.last_login_at DESC NULLS LAST LIMIT $4`, [p.from, p.to, p.status ?? null, cap + 1]))
          .map((r) => [r.name, r.role, r.account_status, t(r.last_login_at), n(r.actions)]) },
      { id: 'audit-extract', title: 'Audit extract', description: 'Audit trail entries for the period. The details column never holds personal data.', audience: 'ADMIN', filters: ['date', 'area', 'status'], statusHint: ['an action name, e.g. rules.published'],
        columns: cols('id:No,at:When,role:Actor role,action:Action,entity:Entity,entityId:Entity id,area:Area,details:Details'),
        run: async (tx, p, _u, cap) => (await q(tx, `SELECT e.id, e.occurred_at, e.actor_role, e.action, e.entity_type, e.entity_id, ar.name_en AS area, e.details FROM audit_events e LEFT JOIN areas ar ON ar.id=e.area_id
          WHERE e.occurred_at::date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR e.area_id=$3) AND ($4::text IS NULL OR e.action=$4) ORDER BY e.id DESC LIMIT $5`, [p.from, p.to, p.areaId ?? null, p.status ?? null, cap + 1]))
          .map((r) => [Number(r.id), t(r.occurred_at), r.actor_role ?? 'system', r.action, r.entity_type ?? '-', r.entity_id ?? '-', r.area ?? '-', JSON.stringify(r.details).slice(0, 200)]) },
    ];
  }

  private allowed(u: SessionUser) { return this.defs.filter((x) => (x.audience === 'ADMIN' ? roleHas(u.role, 'report.run.all') : roleHas(u.role, 'report.run.all') || roleHas(u.role, 'report.run.area'))); }
  catalog(u: SessionUser) { return { items: this.allowed(u).map(({ id, title, description, audience, filters, statusHint, columns }) => ({ id, title, description, audience, filters, statusHint: statusHint ?? null, columns })) }; }

  defaults(now = new Date()) { return { from: istDay(new Date(now.getTime() - 89 * 86400_000)), to: istDay(now) }; }
  private def(u: SessionUser, id: string) { const x = this.allowed(u).find((r) => r.id === id); if (!x) throw notFound(); return x; }
  private async exec(u: SessionUser, id: string, p: Params, cap: number, now = new Date()) {
    const def = this.def(u, id);
    if (p.from > p.to) throw unprocessable('RANGE_INVALID');
    if ((Date.parse(p.to) - Date.parse(p.from)) / 86400_000 > 800) throw unprocessable('RANGE_TOO_LONG', { maxDays: 800 });
    // Officers can only ask for their own areas; the database narrows it again.
    if (p.areaId && u.role !== 'ADMIN' && !u.areaIds.includes(p.areaId)) return { def, rows: [] as Row[], truncated: false };
    const all = await this.db.forUser((tx) => def.run(tx, p, u, cap, now));
    return { def, rows: all.slice(0, cap), truncated: all.length > cap };
  }

  async preview(u: SessionUser, id: string, p: Params) {
    const { def, rows, truncated } = await this.exec(u, id, p, PREVIEW);
    return { id, title: def.title, columns: def.columns, rows, shown: rows.length, moreAvailable: truncated, params: p, generatedAt: new Date().toISOString() };
  }

  async download(u: SessionUser, id: string, p: Params, format: 'csv' | 'xlsx' | 'pdf') {
    const cap = format === 'pdf' ? PDF_CAP : CSV_CAP;
    const { def, rows, truncated } = await this.exec(u, id, p, cap);
    await this.db.forUser((tx) => this.audit.record(tx, { action: 'report.exported', entityType: 'report', details: { report: id, format, rows: rows.length, truncated } }));
    const name = `${id}-${p.to}`;
    if (format === 'csv') return { buf: Buffer.from('﻿' + [def.columns.map((c) => this.csv(c.label)).join(','), ...rows.map((r) => r.map((v) => this.csv(v)).join(','))].join('\r\n') + '\r\n'), type: 'text/csv; charset=utf-8', name: `${name}.csv`, truncated };
    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook(); wb.creator = 'Nirikshan'; wb.created = new Date(); const ws = wb.addWorksheet(def.title.slice(0, 31));
      ws.addRow(def.columns.map((c) => c.label)).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }];
      for (const r of rows) ws.addRow(r.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v)));
      def.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(48, Math.max(12, c.label.length + 2, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length + 2))); });
      return { buf: Buffer.from(await wb.xlsx.writeBuffer()), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${name}.xlsx`, truncated };
    }
    return { buf: await this.pdf(def, rows, p, truncated), type: 'application/pdf', name: `${name}.pdf`, truncated };
  }
  /** Quotes a CSV cell, and defuses a leading = + - @ so a spreadsheet never runs it as a formula. */
  private csv(v: Cell): string { if (v == null) return ''; let s = String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  private async pdf(def: Def, rows: Row[], p: Params, truncated: boolean) {
    const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica); const fb = await doc.embedFont(StandardFonts.HelveticaBold);
    const W = 842; const H = 595; const M = 36; const colW = (W - 2 * M) / def.columns.length; const fit = (s: string, w: number) => { let x = s; while (x.length > 1 && f.widthOfTextAtSize(x, 7) > w - 4) x = x.slice(0, -1); return x.length < s.length ? x.slice(0, -1) + '.' : x; };
    let page = doc.addPage([W, H]); let y = H - M; let pageNo = 1;
    const head = () => { page.drawText(`Nirikshan - ${def.title}`, { x: M, y, size: 12, font: fb }); y -= 14; page.drawText(`Period ${p.from} to ${p.to}${p.areaId ? ' (one area)' : ''}${p.status ? `, filter ${p.status}` : ''}   Generated ${new Date().toISOString().slice(0, 16)}Z   Page ${pageNo}`, { x: M, y, size: 7, font: f, color: rgb(0.35, 0.35, 0.35) }); y -= 16;
      def.columns.forEach((c, i) => page.drawText(fit(c.label, colW), { x: M + i * colW, y, size: 7, font: fb })); y -= 10; };
    head();
    for (const r of rows) {
      if (y < M + 20) { page = doc.addPage([W, H]); y = H - M; pageNo++; head(); }
      r.forEach((v, i) => page.drawText(fit(String(v ?? ''), colW), { x: M + i * colW, y, size: 7, font: f })); y -= 10;
    }
    if (!rows.length) page.drawText('No rows for this period.', { x: M, y, size: 9, font: f });
    if (truncated) page.drawText(`Only the first ${rows.length} rows are shown. Download the CSV or Excel version for everything.`, { x: M, y: y - 14, size: 8, font: fb });
    return Buffer.from(await doc.save());
  }
}
void conflict;
