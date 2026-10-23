import { Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { z } from 'zod';
import { driveCreateSchema } from '@nirikshan/shared';
import { DbService } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { conflict, notFound, unprocessable } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

const NOT_IN_OPEN_DRIVE = `NOT EXISTS (SELECT 1 FROM enforcement_drive_items di JOIN enforcement_drives d ON d.id=di.drive_id WHERE di.instrument_id=i.id AND d.status <> 'CLOSED')`;
const dstr = (d: Date | string | null) => (d ? (typeof d === 'string' ? d : d.toISOString()).slice(0, 10) : '');

@Injectable()
export class EnforcementService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notif: NotificationService) {}

  /** Instruments whose verification has lapsed and that are not already in a running drive. */
  async expired(user: SessionUser, q: { areaId?: string; minDaysOverdue?: number }, now = new Date()) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT i.id, i.instrument_no, i.area_id, c.name_en AS category, a.name_en AS area, b.firm_name_enc, (SELECT max(valid_till) FROM certificates ce WHERE ce.instrument_id=i.id) AS last_valid_till
       FROM instruments i JOIN categories c ON c.id=i.category_id JOIN areas a ON a.id=i.area_id JOIN businesses b ON b.id=i.business_id
       WHERE i.status='EXPIRED' AND ${NOT_IN_OPEN_DRIVE} AND ($1::uuid IS NULL OR i.area_id=$1)
       ORDER BY last_valid_till NULLS LAST LIMIT 500`, [q.areaId ?? null])).rows);
    const items = rows.map((r) => ({ instrumentId: r.id as string, instrumentNo: r.instrument_no as string, areaId: r.area_id as string, category: r.category as string, area: r.area as string, firm: this.crypto.decStr(r.firm_name_enc),
      lastValidTill: r.last_valid_till ? dstr(r.last_valid_till) : null, daysOverdue: r.last_valid_till ? Math.max(0, Math.floor((now.getTime() - new Date(dstr(r.last_valid_till)).getTime()) / 86400_000)) : null }));
    return { items: q.minDaysOverdue ? items.filter((x) => (x.daysOverdue ?? 0) >= q.minDaysOverdue!) : items };
  }

  async createDrive(user: SessionUser, input: z.infer<typeof driveCreateSchema>) {
    if (!user.areaIds.includes(input.areaId)) throw notFound();
    return this.db.forUser(async (tx) => {
      const ids = [...new Set(input.instrumentIds)];
      const ok = (await tx.query(`SELECT i.id FROM instruments i WHERE i.id = ANY($1::uuid[]) AND i.status='EXPIRED' AND ${NOT_IN_OPEN_DRIVE}`, [ids])).rows.map((r) => r.id as string);
      if (ok.length !== ids.length) throw unprocessable('INSTRUMENTS_NOT_ELIGIBLE', { eligible: ok.length, asked: ids.length });
      const d = (await tx.query(`INSERT INTO enforcement_drives (area_id, name, created_by) VALUES ($1,$2,$3) RETURNING id`, [input.areaId, input.name, user.userId])).rows[0].id as string;
      await tx.query(`INSERT INTO enforcement_drive_items (drive_id, instrument_id) SELECT $1, unnest($2::uuid[])`, [d, ids]);
      await this.audit.record(tx, { action: 'enforcement.drive_created', entityType: 'enforcement_drive', entityId: d, areaId: input.areaId, details: { items: ids.length } });
      return { id: d, items: ids.length };
    });
  }

  async drives(user: SessionUser) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT d.id, d.name, d.status, d.created_at, a.name_en AS area, count(*)::int AS total,
              count(*) FILTER (WHERE di.stage='LISTED')::int AS listed, count(*) FILTER (WHERE di.stage='NOTIFIED')::int AS notified, count(*) FILTER (WHERE di.stage='APPLIED')::int AS applied,
              count(*) FILTER (WHERE di.stage='VERIFIED')::int AS verified, count(*) FILTER (WHERE di.stage='ESCALATED')::int AS escalated
       FROM enforcement_drives d JOIN areas a ON a.id=d.area_id JOIN enforcement_drive_items di ON di.drive_id=d.id GROUP BY d.id, a.name_en ORDER BY d.created_at DESC LIMIT 100`)).rows);
    return { items: rows.map((r) => ({ id: r.id as string, name: r.name as string, status: r.status as string, createdAt: r.created_at as Date, area: r.area as string, total: r.total as number, stages: { LISTED: r.listed as number, NOTIFIED: r.notified as number, APPLIED: r.applied as number, VERIFIED: r.verified as number, ESCALATED: r.escalated as number } })) };
  }

  async drive(user: SessionUser, id: string) {
    const seen = await this.db.forUser(async (tx) => (await tx.query('SELECT 1 FROM enforcement_drives WHERE id=$1', [id])).rowCount);
    if (!seen) throw notFound();
    await this.sync(id);
    return this.db.forUser(async (tx) => {
      const d = (await tx.query(`SELECT d.id, d.name, d.status, d.created_at, d.closed_at, a.name_en AS area FROM enforcement_drives d JOIN areas a ON a.id=d.area_id WHERE d.id=$1`, [id])).rows[0];
      const items = (await tx.query(
        `SELECT di.instrument_id, di.stage, di.notice_no, di.notified_at, i.instrument_no, c.name_en AS category, b.firm_name_enc, (SELECT max(valid_till) FROM certificates ce WHERE ce.instrument_id=i.id) AS last_valid_till
         FROM enforcement_drive_items di JOIN instruments i ON i.id=di.instrument_id JOIN categories c ON c.id=i.category_id JOIN businesses b ON b.id=i.business_id WHERE di.drive_id=$1 ORDER BY di.stage, i.instrument_no`, [id])).rows;
      return { id: d.id as string, name: d.name as string, status: d.status as string, area: d.area as string, createdAt: d.created_at as Date, closedAt: d.closed_at as Date | null,
        items: items.map((r) => ({ instrumentId: r.instrument_id as string, instrumentNo: r.instrument_no as string, category: r.category as string, firm: this.crypto.decStr(r.firm_name_enc), stage: r.stage as string, noticeNo: r.notice_no as string | null, notifiedAt: r.notified_at as Date | null, lastValidTill: r.last_valid_till ? dstr(r.last_valid_till) : null })) };
    });
  }

  /** Move listed instruments forward when the owner has since applied or been verified. Safe to run repeatedly. */
  async sync(driveId?: string): Promise<{ applied: number; verified: number }> {
    return this.db.system(async (tx) => {
      const ver = (await tx.query(
        `UPDATE enforcement_drive_items di SET stage='VERIFIED', updated_at=now() FROM enforcement_drives d
         WHERE d.id=di.drive_id AND d.status <> 'CLOSED' AND ($1::uuid IS NULL OR d.id=$1) AND di.stage IN ('LISTED','NOTIFIED','APPLIED')
           AND EXISTS (SELECT 1 FROM certificates ce WHERE ce.instrument_id=di.instrument_id AND ce.status='VALID' AND ce.created_at > di.listed_at)`, [driveId ?? null])).rowCount ?? 0;
      const app = (await tx.query(
        `UPDATE enforcement_drive_items di SET stage='APPLIED', updated_at=now() FROM enforcement_drives d
         WHERE d.id=di.drive_id AND d.status <> 'CLOSED' AND ($1::uuid IS NULL OR d.id=$1) AND di.stage IN ('LISTED','NOTIFIED')
           AND EXISTS (SELECT 1 FROM applications a WHERE a.instrument_id=di.instrument_id AND a.created_at > di.listed_at AND a.status NOT IN ('REJECTED','CANCELLED','APPLICATION_EXPIRED'))`, [driveId ?? null])).rowCount ?? 0;
      await tx.query(`UPDATE enforcement_drives d SET status='IN_PROGRESS' WHERE d.status IN ('PLANNED','NOTICES_SENT') AND ($1::uuid IS NULL OR d.id=$1) AND EXISTS (SELECT 1 FROM enforcement_drive_items di WHERE di.drive_id=d.id AND di.stage IN ('APPLIED','VERIFIED'))`, [driveId ?? null]);
      return { applied: app, verified: ver };
    });
  }

  async sendNotices(user: SessionUser, id: string) {
    const sends: (() => Promise<void>)[] = [];
    const out = await this.db.forUser(async (tx) => {
      const d = (await tx.query('SELECT id, status, area_id FROM enforcement_drives WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!d) throw notFound(); if (d.status === 'CLOSED') throw conflict('DRIVE_CLOSED');
      const items = (await tx.query(
        `SELECT di.instrument_id, i.instrument_no, b.owner_user_id, (SELECT max(valid_till) FROM certificates ce WHERE ce.instrument_id=i.id) AS vt
         FROM enforcement_drive_items di JOIN instruments i ON i.id=di.instrument_id JOIN businesses b ON b.id=i.business_id WHERE di.drive_id=$1 AND di.stage='LISTED' FOR UPDATE OF di`, [id])).rows;
      for (const it of items) {
        const no = (await tx.query(`SELECT 'ENF/' || to_char(now(),'YYYY') || '/' || lpad(nextval('enforcement_notice_seq')::text, 6, '0') AS n`)).rows[0].n as string;
        await tx.query(`UPDATE enforcement_drive_items SET stage='NOTIFIED', notice_no=$3, notified_at=now(), updated_at=now() WHERE drive_id=$1 AND instrument_id=$2`, [id, it.instrument_id, no]);
        sends.push(() => this.notif.notifyUser(it.owner_user_id, 'ENFORCEMENT_NOTICE', { noticeNo: no, instrumentNo: it.instrument_no, validTill: it.vt ? dstr(it.vt) : 'an earlier date' }, `/owner/instruments/${it.instrument_id}`));
      }
      if (items.length) await tx.query(`UPDATE enforcement_drives SET status='NOTICES_SENT' WHERE id=$1 AND status='PLANNED'`, [id]);
      await this.audit.record(tx, { action: 'enforcement.notices_sent', entityType: 'enforcement_drive', entityId: id, areaId: d.area_id, details: { count: items.length } });
      return { sent: items.length };
    });
    for (const s of sends) await s();
    return out;
  }

  async escalate(user: SessionUser, id: string, instrumentId: string) {
    return this.db.forUser(async (tx) => {
      const r = await tx.query(`UPDATE enforcement_drive_items di SET stage='ESCALATED', updated_at=now() FROM enforcement_drives d WHERE d.id=di.drive_id AND d.status <> 'CLOSED' AND di.drive_id=$1 AND di.instrument_id=$2 AND di.stage IN ('NOTIFIED','LISTED') RETURNING d.area_id`, [id, instrumentId]);
      if (!r.rowCount) throw conflict('CANNOT_ESCALATE');
      await this.audit.record(tx, { action: 'enforcement.escalated', entityType: 'enforcement_drive', entityId: id, areaId: r.rows[0].area_id, details: { instrumentId } });
      return { ok: true };
    });
  }
  async close(user: SessionUser, id: string) {
    return this.db.forUser(async (tx) => {
      const r = await tx.query(`UPDATE enforcement_drives SET status='CLOSED', closed_at=now() WHERE id=$1 AND status <> 'CLOSED' RETURNING area_id`, [id]);
      if (!r.rowCount) throw conflict('DRIVE_CLOSED_OR_MISSING');
      await this.audit.record(tx, { action: 'enforcement.drive_closed', entityType: 'enforcement_drive', entityId: id, areaId: r.rows[0].area_id });
      return { id, status: 'CLOSED' };
    });
  }

  /** One print-ready PDF with a letter per instrument that has been notified (or is still listed, marked as a draft). */
  async lettersPdf(user: SessionUser, id: string): Promise<Buffer> {
    const d = await this.drive(user, id);
    const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica); const fb = await doc.embedFont(StandardFonts.HelveticaBold);
    const items = d.items.filter((x) => x.stage === 'LISTED' || x.stage === 'NOTIFIED');
    if (!items.length) throw conflict('NOTHING_TO_PRINT');
    for (const it of items) {
      const p = doc.addPage([595, 842]); let y = 780; const line = (t: string, o: { bold?: boolean; size?: number; gap?: number } = {}) => { p.drawText(t, { x: 56, y, size: o.size ?? 11, font: o.bold ? fb : f, color: rgb(0.1, 0.1, 0.1) }); y -= o.gap ?? 18; };
      line('NIRIKSHAN - Legal Metrology Online Verification', { bold: true, size: 14, gap: 28 });
      line(`Notice no: ${it.noticeNo ?? 'DRAFT (not yet issued)'}`, { bold: true });
      line(`Drive: ${d.name}   Area: ${d.area}`, { gap: 28 });
      line(`To: ${it.firm ?? ''}`); line(`Instrument: ${it.instrumentNo} (${it.category})`);
      line(`Verification ended on: ${it.lastValidTill ?? 'not on record'}`, { gap: 28 });
      for (const t of ['Our records show that the verification of the instrument above has lapsed. A weighing or measuring instrument', 'in use for trade must carry a valid verification certificate.', '', 'Please apply for re-verification on the Nirikshan portal now. Your application will be scheduled for an inspection visit.', 'If you have already applied or the instrument is no longer in use, please apply for de-registration on the portal.', '', 'If you do not act, the matter may be referred to the enforcement officer of your area.']) line(t, { gap: t ? 16 : 10 });
    }
    return Buffer.from(await doc.save());
  }
}
