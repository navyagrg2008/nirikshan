import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { istDay, grievanceCreateSchema, grievanceRespondSchema, tamperReportSchema, tamperResolveSchema, publicSearchSchema } from '@nirikshan/shared';
import { DbService } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { StorageService } from '../../infra/storage';
import { ScanService, sniffMime } from '../../infra/scan';
import { CaptchaService } from '../../infra/providers';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { SettingsService } from '../system/settings.service';
import { AppError, notFound, unprocessable } from '../../common/errors';
import { ctx, type SessionUser } from '../../common/request-context';

export const GRIEVANCE_REPLY_DAYS = 7;
const IMG: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const dstr = (d: Date) => d.toISOString().slice(0, 10);
const esc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

@Injectable()
export class ComplaintsService {
  constructor(private db: DbService, private crypto: CryptoService, private storage: StorageService, private scan: ScanService, private captcha: CaptchaService,
    private audit: AuditService, private notif: NotificationService, private settings: SettingsService) {}

  // ------------------------------------------------------------------ grievances
  async raise(user: SessionUser, input: z.infer<typeof grievanceCreateSchema>) {
    const g = await this.db.forUser(async (tx) => {
      let areaId: string | undefined;
      if (input.applicationId) {
        const a = (await tx.query('SELECT area_id FROM applications WHERE id=$1', [input.applicationId])).rows[0];
        if (!a) throw notFound();   // not yours, or not there
        areaId = a.area_id;
      } else areaId = (await tx.query('SELECT area_id FROM businesses WHERE id = ANY($1::uuid[]) ORDER BY created_at LIMIT 1', [user.businessIds])).rows[0]?.area_id;
      const due = new Date(Date.now() + GRIEVANCE_REPLY_DAYS * 86400_000);
      const r = (await tx.query(`INSERT INTO grievances (raised_by, application_id, subject, body, area_id, due_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ref_no, due_at`,
        [user.userId, input.applicationId ?? null, input.subject, input.body, areaId ?? null, due])).rows[0];
      await this.audit.record(tx, { action: 'grievance.raised', entityType: 'grievance', entityId: r.id, areaId });
      return { id: r.id as string, ref: r.ref_no as string, due: r.due_at as Date, areaId };
    });
    if (g.areaId) await this.notif.notifyOfficersInArea(g.areaId, 'GRIEVANCE_RECEIVED', { ref: g.ref, due: dstr(g.due) }, '/officer/queue?tab=grievances');
    else await this.notif.notifyRole('ADMIN', 'GRIEVANCE_RECEIVED', { ref: g.ref, due: dstr(g.due) }, '/officer/queue?tab=grievances');
    return { id: g.id, ref: g.ref, replyBy: g.due };
  }
  async mine(user: SessionUser) {
    const rows = await this.db.forUser(async (tx) => (await tx.query('SELECT id, ref_no, subject, body, status, response, due_at, resolved_at, created_at FROM grievances ORDER BY created_at DESC LIMIT 100')).rows);
    return { items: rows.map((r) => ({ id: r.id as string, ref: r.ref_no as string, subject: r.subject as string, body: r.body as string, status: r.status as string, response: r.response as string | null, replyBy: r.due_at as Date | null, resolvedAt: r.resolved_at as Date | null, createdAt: r.created_at as Date })) };
  }
  async grievanceQueue(user: SessionUser, status: string) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT g.id, g.ref_no, g.subject, g.body, g.status, g.response, g.due_at, g.created_at, g.application_id, a.application_no, (g.status IN ('OPEN','IN_PROGRESS') AND g.due_at < now()) AS overdue
       FROM grievances g LEFT JOIN applications a ON a.id=g.application_id WHERE g.status::text = ANY($1::text[]) ORDER BY overdue DESC, g.due_at LIMIT 200`, [status === 'ALL' ? ['OPEN', 'IN_PROGRESS', 'CLOSED'] : status === 'ACTIVE' ? ['OPEN', 'IN_PROGRESS'] : [status]])).rows);
    return { items: rows.map((r) => ({ id: r.id as string, ref: r.ref_no as string, subject: r.subject as string, body: r.body as string, status: r.status as string, response: r.response as string | null, replyBy: r.due_at as Date | null, createdAt: r.created_at as Date, applicationId: r.application_id as string | null, applicationNo: r.application_no as string | null, overdue: r.overdue as boolean })) };
  }
  async respond(user: SessionUser, id: string, input: z.infer<typeof grievanceRespondSchema>) {
    const g = await this.db.forUser(async (tx) => {
      const r = (await tx.query('SELECT id, ref_no, raised_by, status, area_id FROM grievances WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound();
      if (r.status === 'CLOSED') throw new AppError(409, 'GRIEVANCE_CLOSED');
      await tx.query(`UPDATE grievances SET status=$2::request_status, response=$3, handled_by=$4, resolved_at=CASE WHEN $2='CLOSED' THEN now() END, updated_at=now() WHERE id=$1`, [id, input.status, input.response, user.userId]);
      await this.audit.record(tx, { action: 'grievance.responded', entityType: 'grievance', entityId: id, areaId: r.area_id, details: { status: input.status } });
      return r;
    });
    await this.notif.notifyUser(g.raised_by, 'GRIEVANCE_UPDATED', { ref: g.ref_no, status: input.status === 'CLOSED' ? 'closed' : 'being looked at' }, '/owner/grievances');
    return { id, status: input.status };
  }

  // ------------------------------------------------------------------ tamper reports (public)
  async reportTamper(input: z.infer<typeof tamperReportSchema>, file?: Buffer) {
    if (!(await this.settings.get('flags')).tamperReports) throw new AppError(503, 'FEATURE_DISABLED');
    if (!(await this.captcha.verify(input.captchaToken, ctx()?.ip ?? ''))) throw new AppError(403, 'CAPTCHA_REQUIRED');
    let photoKey: string | null = null;
    if (file) {
      const mime = sniffMime(file); const ext = mime ? IMG[mime] : undefined;
      if (!mime || !ext) throw unprocessable('UNSUPPORTED_FILE_TYPE');
      if (file.length > 5 * 1024 * 1024) throw unprocessable('FILE_TOO_LARGE', { maxMb: 5 });
      const v = await this.scan.scan(file);
      if (v === 'INFECTED') throw unprocessable('FILE_REJECTED');
      if (v !== 'CLEAN') throw new AppError(503, 'SCAN_UNAVAILABLE');
      photoKey = `tamper/${randomUUID()}.${ext}`; await this.storage.put(photoKey, file, { contentType: mime });
    }
    const r = await this.db.system(async (tx) => {
      const areaId = input.certNo ? (await tx.query(`SELECT i.area_id FROM certificates c JOIN instruments i ON i.id=c.instrument_id WHERE c.cert_no=$1`, [input.certNo.toUpperCase()])).rows[0]?.area_id as string | undefined : undefined;
      const row = (await tx.query(`INSERT INTO tamper_reports (cert_no, description, photo_key, contact_enc, ip_hash, assigned_area_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ref_no`,
        [input.certNo?.toUpperCase() ?? null, input.description, photoKey, input.contact ? this.crypto.encrypt(input.contact) : null, ctx()?.ipHash ?? null, areaId ?? null])).rows[0];
      await this.audit.record(tx, { action: 'public.tamper_report', entityType: 'tamper_report', entityId: row.id, areaId, actorId: null, actorRole: 'PUBLIC' });
      return { ref: row.ref_no as string, areaId };
    });
    if (r.areaId) await this.notif.notifyOfficersInArea(r.areaId, 'TAMPER_REPORT_RECEIVED', { ref: r.ref }, '/officer/queue?tab=tamper');
    else { for (const role of ['SENIOR_OFFICER', 'ADMIN'] as const) await this.notif.notifyRole(role, 'TAMPER_REPORT_RECEIVED', { ref: r.ref }, '/officer/queue?tab=tamper'); }   // no area yet: the people who can assign it
    return { ref: r.ref };
  }
  async tamperQueue(user: SessionUser, status: string) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT id, ref_no, cert_no, description, photo_key, contact_enc, status, resolution, created_at FROM tamper_reports WHERE status::text = ANY($1::text[]) ORDER BY created_at DESC LIMIT 200`,
      [status === 'ACTIVE' ? ['OPEN', 'IN_PROGRESS'] : status === 'ALL' ? ['OPEN', 'IN_PROGRESS', 'CLOSED'] : [status]])).rows);
    return { items: await Promise.all(rows.map(async (r) => ({ id: r.id as string, ref: r.ref_no as string, certNo: r.cert_no as string | null, description: r.description as string, status: r.status as string, resolution: r.resolution as string | null, createdAt: r.created_at as Date,
      contact: r.contact_enc ? this.crypto.decStr(r.contact_enc) : null, photoUrl: r.photo_key ? await this.storage.signedUrl(r.photo_key, (r.photo_key as string).endsWith('png') ? 'image/png' : 'image/jpeg') : null }))) };
  }
  async tamperResolve(user: SessionUser, id: string, input: z.infer<typeof tamperResolveSchema>) {
    return this.db.forUser(async (tx) => {
      const r = (await tx.query('SELECT id, status, assigned_area_id FROM tamper_reports WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound(); if (r.status === 'CLOSED') throw new AppError(409, 'REPORT_CLOSED');
      await tx.query(`UPDATE tamper_reports SET status=$2::request_status, resolution=$3, handled_by=$4, resolved_at=CASE WHEN $2='CLOSED' THEN now() END, updated_at=now() WHERE id=$1`, [id, input.status, input.resolution, user.userId]);
      await this.audit.record(tx, { action: 'tamper_report.handled', entityType: 'tamper_report', entityId: id, areaId: r.assigned_area_id, details: { status: input.status } });
      return { id, status: input.status };
    });
  }
  /** What the reporter can see about their report with just the reference: the status and nothing else. */
  async tamperStatus(ref: string) {
    const r = await this.db.system(async (tx) => (await tx.query('SELECT status, created_at FROM tamper_reports WHERE ref_no=$1', [ref.toUpperCase()])).rows[0]);
    if (!r) throw notFound(); return { ref: ref.toUpperCase(), status: r.status === 'CLOSED' ? 'CLOSED' : 'RECEIVED', receivedOn: dstr(r.created_at) };
  }

  // ------------------------------------------------------------------ masked public directory
  async search(input: z.infer<typeof publicSearchSchema>, now = new Date()) {
    if (!(await this.settings.get('flags')).publicSearch) throw new AppError(503, 'FEATURE_DISABLED');
    if (!input.q && !input.categoryId && !input.areaCode && !input.status) throw unprocessable('FILTER_REQUIRED');
    const today = istDay(now); const size = 20;
    const rows = await this.db.system(async (tx) => {
      const r = (await tx.query(
        `SELECT x.cert_no, x.holder_masked, x.category_name, x.capacity_text, x.class_code, x.area_label, x.status, x.valid_till
         FROM public_certificate_index x
         WHERE ($1::text IS NULL OR x.cert_no ILIKE $1 || '%' ESCAPE '\\' OR x.holder_masked ILIKE '%' || $1 || '%' ESCAPE '\\')
           AND ($2::uuid IS NULL OR x.category_name = (SELECT name_en FROM categories WHERE id=$2))
           AND ($3::text IS NULL OR x.area_label = (SELECT name_en FROM areas WHERE code=$3))
           AND ($4::text IS NULL OR (CASE WHEN x.status='VALID' AND x.valid_till < $5::date THEN 'EXPIRED' ELSE x.status::text END) = $4)
         ORDER BY x.valid_till DESC, x.cert_no LIMIT $6 OFFSET $7`, [input.q ? esc(input.q) : null, input.categoryId ?? null, input.areaCode ?? null, input.status ?? null, today, size + 1, (input.page - 1) * size])).rows;
      await tx.query(`INSERT INTO public_lookup_log (ip_hash, mode, result) VALUES ($1,'SEARCH',$2)`, [ctx()?.ipHash ?? Buffer.alloc(1), r.length ? 'FOUND' : 'NONE']);
      return r;
    });
    return { page: input.page, hasMore: rows.length > size, items: rows.slice(0, size).map((r) => ({ certNo: r.cert_no as string, holder: r.holder_masked as string, category: r.category_name as string, capacity: r.capacity_text as string, accuracyClass: r.class_code as string, area: r.area_label as string,
      status: (r.status === 'VALID' && dstr(r.valid_till) < today ? 'EXPIRED' : r.status) as string, validTill: dstr(r.valid_till) })) };
  }
}
