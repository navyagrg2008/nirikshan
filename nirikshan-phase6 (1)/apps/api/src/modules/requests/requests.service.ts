import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { requestCreateSchema, instrumentRequestDecisionSchema, serviceJobAdvanceSchema, serviceJobCreateSchema } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { ApplicationsService } from '../applications/applications.service';
import { conflict, notFound, unprocessable } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

type Create = z.infer<typeof requestCreateSchema>;
type Decision = z.infer<typeof instrumentRequestDecisionSchema>;
const KIND_WORD: Record<string, string> = { TRANSFER: 'transfer', ADDRESS_CHANGE: 'change of address', DEREGISTER: 'de-registration' };
const OPEN_APP = `SELECT 1 FROM applications a WHERE a.instrument_id=$1 AND a.status NOT IN ('REJECTED','CANCELLED','APPLICATION_EXPIRED','CERTIFICATE_ISSUED') LIMIT 1`;

interface Details { note?: string; address?: string; lat?: number; lng?: number }

@Injectable()
export class RequestsService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notif: NotificationService, private inst: InstrumentsService, private apps: ApplicationsService) {}

  // ------------------------------------------------------------------ owner side
  async create(user: SessionUser, instrumentId: string, input: Create) {
    let toBusiness: { id: string; ownerId: string } | null = null;
    if (input.kind === 'TRANSFER') {
      toBusiness = await this.db.system(async (tx) => {
        const r = (await tx.query(
          `SELECT b.id, u.id AS owner_id FROM users u JOIN businesses b ON b.owner_user_id=u.id JOIN user_roles ur ON ur.user_id=u.id JOIN roles ro ON ro.id=ur.role_id
           WHERE u.mobile_bidx = ANY($1::bytea[]) AND u.account_status='ACTIVE' AND ro.code IN ('OWNER','TRADER') AND b.status='ACTIVE' ORDER BY b.created_at LIMIT 1`, [this.crypto.blindIndexAll('mobile', input.toMobile)])).rows[0];
        return r ? { id: r.id as string, ownerId: r.owner_id as string } : null;
      });
      if (!toBusiness) throw unprocessable('RECIPIENT_NOT_FOUND');   // same answer whether the number is unknown or not eligible
      if (user.businessIds.includes(toBusiness.id)) throw unprocessable('RECIPIENT_IS_YOU');
    }
    return this.db.forUser(async (tx) => {
      const i = (await tx.query('SELECT id, instrument_no, business_id, area_id, status FROM instruments WHERE id=$1 FOR UPDATE', [instrumentId])).rows[0];
      if (!i || !user.businessIds.includes(i.business_id)) throw notFound();
      if (i.status === 'DEREGISTERED') throw conflict('INSTRUMENT_DEREGISTERED');
      if ((await tx.query(OPEN_APP, [instrumentId])).rowCount) throw conflict('OPEN_APPLICATION_EXISTS');
      let newArea: string | null = null;
      if (input.kind === 'ADDRESS_CHANGE') {
        if (!(await tx.query(`SELECT 1 FROM areas WHERE id=$1 AND level='WARD'`, [input.areaId])).rowCount) throw unprocessable('INVALID_REFERENCE', { reasons: ['AREA'] });
        newArea = input.areaId;
      }
      const details: Details = input.kind === 'ADDRESS_CHANGE' ? { address: input.address, lat: input.lat, lng: input.lng, note: input.note } : { note: input.note };
      let id: string;
      try {
        id = (await tx.query(
          `INSERT INTO instrument_requests (instrument_id, kind, area_id, requested_by, from_business_id, to_business_id, new_area_id, reason_code, details_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [instrumentId, input.kind, i.area_id, user.userId, i.business_id, toBusiness?.id ?? null, newArea, input.kind === 'DEREGISTER' ? input.reasonCode : null, this.crypto.encJson(details)])).rows[0].id;
      } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('REQUEST_ALREADY_OPEN'); throw e; }
      await this.audit.record(tx, { action: 'instrument.request.created', entityType: 'instrument_request', entityId: id, areaId: i.area_id, details: { kind: input.kind } });
      await this.notif.notifyOfficersInArea(i.area_id, 'REQUEST_NEW', { kind: KIND_WORD[input.kind]!, instrumentNo: i.instrument_no }, `/officer/queue?tab=${input.kind === 'DEREGISTER' ? 'deregistration' : 'transfers'}`);
      return { id, status: 'OPEN' as const };
    });
  }

  async listForInstrument(user: SessionUser, instrumentId: string) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT r.id, r.kind, r.status, r.reason_code, r.decision_remark, r.decided_at, r.created_at, r.new_area_id, r.to_business_id, b.firm_name_masked AS to_firm
       FROM instrument_requests r LEFT JOIN businesses b ON b.id=r.to_business_id WHERE r.instrument_id=$1 ORDER BY r.created_at DESC`, [instrumentId])).rows);
    return { items: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, status: r.status as string, reasonCode: r.reason_code as string | null, remark: r.decision_remark as string | null, decidedAt: r.decided_at as Date | null, createdAt: r.created_at as Date, toFirm: r.to_firm as string | null })) };
  }

  async withdraw(user: SessionUser, id: string) {
    return this.db.forUser(async (tx) => {
      const r = (await tx.query(`SELECT id, status, area_id FROM instrument_requests WHERE id=$1 AND requested_by=$2 FOR UPDATE`, [id, user.userId])).rows[0];
      if (!r) throw notFound();
      if (r.status !== 'OPEN') throw conflict('REQUEST_NOT_OPEN');
      await tx.query(`UPDATE instrument_requests SET status='CLOSED', decision_remark='Withdrawn by the requester', decided_at=now(), updated_at=now() WHERE id=$1`, [id]);
      await this.audit.record(tx, { action: 'instrument.request.withdrawn', entityType: 'instrument_request', entityId: id, areaId: r.area_id });
      return { id, status: 'CLOSED' as const };
    });
  }

  // ------------------------------------------------------------------ officer side
  async queue(user: SessionUser, q: { kind?: string; status?: string }) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT r.id, r.kind, r.status, r.created_at, r.reason_code, i.instrument_no, c.name_en AS category, a.name_en AS area, fb.firm_name_enc AS from_firm, tb.firm_name_enc AS to_firm
       FROM instrument_requests r JOIN instruments i ON i.id=r.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas a ON a.id=r.area_id
       JOIN businesses fb ON fb.id=r.from_business_id LEFT JOIN businesses tb ON tb.id=r.to_business_id
       WHERE ($1::text IS NULL OR r.kind=$1) AND ($2::text IS NULL OR r.status::text=$2) ORDER BY (r.status='OPEN') DESC, r.created_at LIMIT 200`, [q.kind ?? null, q.status ?? 'OPEN'])).rows);
    return { items: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, status: r.status as string, createdAt: r.created_at as Date, reasonCode: r.reason_code as string | null, instrumentNo: r.instrument_no as string,
      category: r.category as string, area: r.area as string, fromFirm: this.crypto.decStr(r.from_firm), toFirm: r.to_firm ? this.crypto.decStr(r.to_firm) : null })) };
  }

  async detail(user: SessionUser, id: string) {
    const r = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT r.*, i.instrument_no, i.status AS istatus, i.address_enc AS current_address, c.name_en AS category, a.name_en AS area, na.name_en AS new_area_name, fb.firm_name_enc AS from_firm, tb.firm_name_enc AS to_firm,
              EXISTS (SELECT 1 FROM certificates ce WHERE ce.instrument_id=i.id AND ce.status='VALID') AS has_valid_certificate
       FROM instrument_requests r JOIN instruments i ON i.id=r.instrument_id JOIN categories c ON c.id=i.category_id JOIN areas a ON a.id=r.area_id LEFT JOIN areas na ON na.id=r.new_area_id
       JOIN businesses fb ON fb.id=r.from_business_id LEFT JOIN businesses tb ON tb.id=r.to_business_id WHERE r.id=$1`, [id])).rows[0]);
    if (!r) throw notFound();
    const d = r.details_enc ? this.crypto.decJson<Details>(r.details_enc) : {};
    return { id: r.id as string, kind: r.kind as string, status: r.status as string, createdAt: r.created_at as Date, instrumentNo: r.instrument_no as string, instrumentStatus: r.istatus as string, category: r.category as string, area: r.area as string,
      fromFirm: this.crypto.decStr(r.from_firm), toFirm: r.to_firm ? this.crypto.decStr(r.to_firm) : null, reasonCode: r.reason_code as string | null, note: d.note ?? null,
      currentAddress: r.current_address ? this.crypto.decStr(r.current_address) : null, newAddress: d.address ?? null, newArea: r.new_area_name as string | null, hasValidCertificate: r.has_valid_certificate as boolean,
      decisionRemark: r.decision_remark as string | null, decidedAt: r.decided_at as Date | null };
  }

  /** Authorisation is checked through the officer's own view (area scope); the change itself runs as the system so the instrument, ownership trail, certificates and public index commit together. */
  async decide(user: SessionUser, id: string, input: Decision) {
    const seen = await this.db.forUser(async (tx) => (await tx.query('SELECT id FROM instrument_requests WHERE id=$1', [id])).rowCount);
    if (!seen) throw notFound();
    const notes: (() => Promise<void>)[] = [];
    const out = await this.db.system(async (tx) => {
      const r = (await tx.query(`SELECT r.*, i.instrument_no, i.business_id AS cur_business, i.status AS istatus, i.version AS iversion FROM instrument_requests r JOIN instruments i ON i.id=r.instrument_id WHERE r.id=$1 FOR UPDATE OF r, i`, [id])).rows[0];
      if (r.status !== 'OPEN') throw conflict('REQUEST_NOT_OPEN');
      const requesterOwner = (await tx.query('SELECT owner_user_id FROM businesses WHERE id=$1', [r.from_business_id])).rows[0].owner_user_id as string;
      const word = KIND_WORD[r.kind]!;
      if (input.outcome === 'APPROVED') {
        if (r.istatus === 'DEREGISTERED' || r.cur_business !== r.from_business_id) throw conflict('REQUEST_STALE');
        if ((await tx.query(OPEN_APP, [r.instrument_id])).rowCount) throw conflict('OPEN_APPLICATION_EXISTS');
        await this.apply(tx, r, user);
      }
      await tx.query(`UPDATE instrument_requests SET status=$2::request_status, decided_by=$3, decided_at=now(), decision_remark=$4, updated_at=now() WHERE id=$1`, [id, input.outcome, user.userId, input.remark ?? null]);
      await this.audit.record(tx, { action: `instrument.request.${input.outcome === 'APPROVED' ? 'approved' : 'rejected'}`, entityType: 'instrument_request', entityId: id, areaId: r.area_id, details: { kind: r.kind } });
      const vars = { kind: word, instrumentNo: r.instrument_no as string, outcome: input.outcome === 'APPROVED' ? 'approved' : 'rejected' };
      notes.push(() => this.notif.notifyUser(requesterOwner, 'REQUEST_DECIDED', vars, `/owner/instruments/${r.instrument_id}`));
      if (input.outcome === 'APPROVED' && r.kind === 'TRANSFER') {
        const to = (await tx.query('SELECT owner_user_id FROM businesses WHERE id=$1', [r.to_business_id])).rows[0].owner_user_id as string;
        notes.push(() => this.notif.notifyUser(to, 'TRANSFER_INCOMING', { instrumentNo: r.instrument_no as string }, `/owner/instruments/${r.instrument_id}`));
      }
      return { id, status: input.outcome };
    });
    for (const n of notes) await n();
    return out;
  }

  private async apply(tx: Tx, r: Record<string, any>, user: SessionUser) {
    if (r.kind === 'TRANSFER') {
      const t = (await tx.query(`INSERT INTO ownership_transfers (instrument_id, from_business_id, to_business_id, status, decided_by, reason) VALUES ($1,$2,$3,'APPROVED',$4,$5) RETURNING id`, [r.instrument_id, r.from_business_id, r.to_business_id, user.userId, 'Approved by officer'])).rows[0].id;
      await tx.query(`UPDATE instruments SET business_id=$2, on_behalf_of_business_id=NULL, version=version+1, updated_at=now() WHERE id=$1`, [r.instrument_id, r.to_business_id]);
      await tx.query(`INSERT INTO instrument_ownership_history (instrument_id, from_business_id, to_business_id, transfer_id) VALUES ($1,$2,$3,$4)`, [r.instrument_id, r.from_business_id, r.to_business_id, t]);
      await tx.query(`UPDATE public_certificate_index p SET holder_masked=(SELECT firm_name_masked FROM businesses WHERE id=$2), updated_at=now() WHERE p.cert_no IN (SELECT cert_no FROM certificates WHERE instrument_id=$1)`, [r.instrument_id, r.to_business_id]);
    } else if (r.kind === 'ADDRESS_CHANGE') {
      const d = this.crypto.decJson<Details>(r.details_enc);
      const biz = (await tx.query('SELECT area_id FROM businesses WHERE id=$1', [r.from_business_id])).rows[0] as { area_id: string };
      const oa = await this.inst.outOfArea(tx, r.new_area_id, biz.area_id, d.lat, d.lng);
      const loc = d.lat != null && d.lng != null ? this.crypto.encJson({ lat: d.lat, lng: d.lng }) : null;
      await tx.query(`UPDATE instruments SET area_id=$2, address_enc=$3, location_enc=COALESCE($4, location_enc), out_of_area=$5, version=version+1, updated_at=now() WHERE id=$1`, [r.instrument_id, r.new_area_id, this.crypto.encrypt(d.address!), loc, oa]);
      await tx.query(`UPDATE public_certificate_index p SET area_label=(SELECT name_en FROM areas WHERE id=$2), updated_at=now() WHERE p.cert_no IN (SELECT cert_no FROM certificates WHERE instrument_id=$1)`, [r.instrument_id, r.new_area_id]);
    } else {
      await tx.query(`UPDATE instruments SET status='DEREGISTERED', version=version+1, updated_at=now() WHERE id=$1`, [r.instrument_id]);
      for (const c of (await tx.query(`UPDATE certificates SET status='REVOKED' WHERE instrument_id=$1 AND status='VALID' RETURNING id, cert_no`, [r.instrument_id])).rows) {
        await tx.query(`INSERT INTO certificate_status_history (certificate_id, from_status, to_status, public_reason, internal_reason, actor_id) VALUES ($1,'VALID','REVOKED','Instrument de-registered','De-registration approved',$2)`, [c.id, user.userId]);
        await tx.query(`UPDATE public_certificate_index SET status='REVOKED', public_reason='Instrument de-registered', updated_at=now() WHERE cert_no=$1`, [c.cert_no]);
      }
    }
  }

  // ------------------------------------------------------------------ ownership trail
  async history(user: SessionUser, instrumentId: string) {
    return this.db.forUser(async (tx) => {
      const i = (await tx.query('SELECT id FROM instruments WHERE id=$1', [instrumentId])).rowCount; if (!i) throw notFound();
      const owner = user.role === 'OWNER' || user.role === 'TRADER';
      const cases = (await tx.query(`SELECT a.id, a.application_no, a.type, a.status, a.created_at FROM applications a WHERE a.instrument_id=$1 ORDER BY a.created_at DESC`, [instrumentId])).rows;
      const certs = (await tx.query(`SELECT id, cert_no, status, verified_on, valid_till FROM certificates WHERE instrument_id=$1 ORDER BY created_at DESC`, [instrumentId])).rows;
      const own = (await tx.query(`SELECT h.effective_at, fb.firm_name_masked AS from_firm, tb.firm_name_masked AS to_firm FROM instrument_ownership_history h LEFT JOIN businesses fb ON fb.id=h.from_business_id JOIN businesses tb ON tb.id=h.to_business_id WHERE h.instrument_id=$1 ORDER BY h.effective_at DESC`, [instrumentId])).rows;
      const reqs = (await tx.query(`SELECT kind, status, created_at, decided_at FROM instrument_requests WHERE instrument_id=$1 ORDER BY created_at DESC`, [instrumentId])).rows;
      void owner;
      return { applications: cases.map((r) => ({ id: r.id, applicationNo: r.application_no, type: r.type, status: r.status, createdAt: r.created_at })), certificates: certs.map((r) => ({ id: r.id, certNo: r.cert_no, status: r.status, verifiedOn: r.verified_on, validTill: r.valid_till })),
        ownership: own.map((r) => ({ at: r.effective_at, from: r.from_firm, to: r.to_firm })), requests: reqs.map((r) => ({ kind: r.kind, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at })) };
    });
  }

  // ------------------------------------------------------------------ repair jobs (traders)
  async jobs(user: SessionUser) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT j.id, j.stage, j.issue, j.technician_name, j.notes, j.created_at, j.updated_at, j.resulting_application_id, i.id AS instrument_id, i.instrument_no, c.name_en AS category
       FROM service_jobs j JOIN instruments i ON i.id=j.instrument_id JOIN categories c ON c.id=i.category_id ORDER BY (j.stage='READY_FOR_VERIFICATION'), j.updated_at DESC LIMIT 200`)).rows);
    return { items: rows.map((r) => ({ id: r.id as string, stage: r.stage as string, issue: r.issue as string | null, technicianName: r.technician_name as string | null, notes: r.notes as string | null, createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
      applicationId: r.resulting_application_id as string | null, instrumentId: r.instrument_id as string, instrumentNo: r.instrument_no as string, category: r.category as string })) };
  }
  async createJob(user: SessionUser, input: z.infer<typeof serviceJobCreateSchema>) {
    return this.db.forUser(async (tx) => {
      const i = (await tx.query('SELECT id, business_id, status, area_id FROM instruments WHERE id=$1', [input.instrumentId])).rows[0];
      if (!i || !user.businessIds.includes(i.business_id)) throw notFound();
      if (i.status === 'DEREGISTERED') throw conflict('INSTRUMENT_DEREGISTERED');
      if ((await tx.query(`SELECT 1 FROM service_jobs WHERE instrument_id=$1 AND stage <> 'READY_FOR_VERIFICATION'`, [input.instrumentId])).rowCount) throw conflict('REPAIR_JOB_ALREADY_OPEN');
      const id = (await tx.query(`INSERT INTO service_jobs (trader_business_id, instrument_id, issue) VALUES ($1,$2,$3) RETURNING id`, [i.business_id, input.instrumentId, input.issue])).rows[0].id as string;
      await this.audit.record(tx, { action: 'service_job.created', entityType: 'service_job', entityId: id, areaId: i.area_id });
      return { id, stage: 'REPORTED' };
    });
  }
  async advanceJob(user: SessionUser, id: string, input: z.infer<typeof serviceJobAdvanceSchema>) {
    const ORDER = ['REPORTED', 'TECHNICIAN_ASSIGNED', 'REPAIRED', 'READY_FOR_VERIFICATION'];
    const cur = await this.db.forUser(async (tx) => (await tx.query('SELECT id, stage, instrument_id, technician_name FROM service_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]);
    if (!cur) throw notFound();
    if (ORDER.indexOf(input.to) !== ORDER.indexOf(cur.stage) + 1) throw conflict('INVALID_STAGE_MOVE', { from: cur.stage, to: input.to });
    if (input.to === 'TECHNICIAN_ASSIGNED' && !input.technicianName) throw unprocessable('TECHNICIAN_REQUIRED');
    let applicationId: string | null = null;
    if (input.to === 'READY_FOR_VERIFICATION') {
      // The repaired instrument goes back for verification as a normal application; the usual checks (open case, rules) apply.
      applicationId = (await this.apps.create(user, { instrumentId: cur.instrument_id, type: 'RE_VERIFICATION' })).id;
    }
    return this.db.forUser(async (tx) => {
      await tx.query(`UPDATE service_jobs SET stage=$2, technician_name=COALESCE($3, technician_name), notes=COALESCE($4, notes), resulting_application_id=COALESCE($5, resulting_application_id), updated_at=now() WHERE id=$1`,
        [id, input.to, input.technicianName ?? null, input.notes ?? null, applicationId]);
      await this.audit.record(tx, { action: 'service_job.advanced', entityType: 'service_job', entityId: id, details: { to: input.to } });
      return { id, stage: input.to, applicationId };
    });
  }
}
