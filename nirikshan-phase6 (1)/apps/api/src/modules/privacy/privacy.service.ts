import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BREACH_STEPS, dsrCreateSchema, dsrResolveSchema } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { StorageService } from '../../infra/storage';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { SessionService } from '../auth/session.service';
import { SettingsService } from '../system/settings.service';
import { AppError, conflict, notFound } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

const DUE_DAYS = 30;
const KIND_WORD: Record<string, string> = { ACCESS: 'access', CORRECTION: 'correction', ERASURE: 'erasure', DEACTIVATION: 'account closure' };
const dstr = (d: Date | string | null) => (d ? (typeof d === 'string' ? d : d.toISOString()).slice(0, 10) : null);
const maskMobile = (m: string | null) => (m ? `******${m.slice(-4)}` : null);

/** What we keep after an erasure, and why. Shown to the person and to the admin. */
export const RETAINED = [
  { what: 'Verification certificates and the public certificate index (holder name is already masked there)', why: 'Legal metrology records must be kept for the statutory period so a certificate can still be checked' },
  { what: 'Instrument registry records, applications and inspection results (without addresses)', why: 'They are the basis of the certificates and of past enforcement decisions' },
  { what: 'The audit trail', why: 'It is tamper-evident and holds no personal details; it proves who did what and when' },
  { what: 'The record that consent was given', why: 'Needed to show the account was opened lawfully' },
];

@Injectable()
export class PrivacyService {
  constructor(private db: DbService, private crypto: CryptoService, private storage: StorageService, private audit: AuditService, private notif: NotificationService, private sessions: SessionService, private settings: SettingsService) {}

  // ------------------------------------------------------------------ the person's side
  async create(user: SessionUser, input: z.infer<typeof dsrCreateSchema>) {
    if (!(await this.settings.get('flags')).selfServiceDataRequests) throw new AppError(503, 'FEATURE_DISABLED');
    const due = new Date(Date.now() + DUE_DAYS * 86400_000);
    const r = await this.db.forUser(async (tx) => {
      let row;
      try { row = (await tx.query(`INSERT INTO data_subject_requests (user_id, kind, details, due_at) VALUES ($1,$2,$3,$4) RETURNING id, ref_no`, [user.userId, input.kind, input.details ?? null, due])).rows[0]; }
      catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('REQUEST_ALREADY_OPEN'); throw e; }
      await this.audit.record(tx, { action: 'dsr.created', entityType: 'data_subject_request', entityId: row.id, details: { kind: input.kind } });
      return { id: row.id as string, ref: row.ref_no as string };
    });
    await this.notif.notifyRole('ADMIN', 'DSR_RECEIVED', { kind: KIND_WORD[input.kind]!, due: dstr(due)! }, '/admin/privacy');
    return { id: r.id, ref: r.ref, dueBy: dstr(due) };
  }
  async mine(user: SessionUser) {
    const rows = await this.db.forUser(async (tx) => (await tx.query('SELECT id, ref_no, kind, status, details, resolution, export_key, due_at, created_at, closed_at FROM data_subject_requests ORDER BY created_at DESC LIMIT 50')).rows);
    return { items: rows.map((r) => ({ id: r.id as string, ref: r.ref_no as string, kind: r.kind as string, status: r.status as string, details: r.details as string | null, resolution: r.resolution as string | null, hasExport: !!r.export_key, dueBy: dstr(r.due_at), createdAt: r.created_at as Date, closedAt: r.closed_at as Date | null })) };
  }
  async download(user: SessionUser, id: string) {
    const key = await this.db.forUser(async (tx) => {
      const r = (await tx.query(`SELECT export_key FROM data_subject_requests WHERE id=$1 AND kind='ACCESS' AND status='CLOSED'`, [id])).rows[0];
      if (!r?.export_key) throw notFound();
      await this.audit.record(tx, { action: 'dsr.export_link_issued', entityType: 'data_subject_request', entityId: id }); return r.export_key as string;
    });
    return { url: await this.storage.signedUrl(key, 'application/json', 120) };
  }

  // ------------------------------------------------------------------ admin side
  async list(status: string) {
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `SELECT r.id, r.ref_no, r.kind, r.status, r.details, r.resolution, r.due_at, r.created_at, r.closed_at, r.user_id, u.mobile_enc, p.full_name_enc, (r.status IN ('OPEN','IN_PROGRESS') AND r.due_at < now()) AS overdue
       FROM data_subject_requests r JOIN users u ON u.id=r.user_id LEFT JOIN user_profiles p ON p.user_id=u.id
       WHERE ($1::text = 'ALL' OR ($1 = 'ACTIVE' AND r.status IN ('OPEN','IN_PROGRESS')) OR r.status::text = $1) ORDER BY overdue DESC, r.due_at LIMIT 200`, [status])).rows);
    return { items: rows.map((r) => ({ id: r.id as string, ref: r.ref_no as string, kind: r.kind as string, status: r.status as string, details: r.details as string | null, resolution: r.resolution as string | null, dueBy: dstr(r.due_at), overdue: r.overdue as boolean, createdAt: r.created_at as Date, closedAt: r.closed_at as Date | null,
      person: r.full_name_enc ? this.crypto.decStr(r.full_name_enc) : null, mobile: r.mobile_enc ? maskMobile(this.crypto.decStr(r.mobile_enc)) : null })) };
  }

  async resolve(admin: SessionUser, id: string, input: z.infer<typeof dsrResolveSchema>) {
    const out = await this.db.system(async (tx) => {
      const r = (await tx.query('SELECT id, user_id, kind, status FROM data_subject_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!r) throw notFound(); if (r.status !== 'OPEN' && r.status !== 'IN_PROGRESS') throw conflict('REQUEST_CLOSED');
      let resolution = input.note ?? ''; let exportKey: string | null = null; let status: 'CLOSED' | 'REJECTED' = 'CLOSED'; let tell = true;
      if (input.action === 'REJECT') status = 'REJECTED';
      else if (r.kind === 'ACCESS') {
        const data = await this.buildExport(tx, r.user_id); exportKey = `dsr/${id}.json`;
        await this.storage.put(exportKey, Buffer.from(JSON.stringify(data, null, 2)), { contentType: 'application/json' });
        resolution = resolution || 'Your data is ready to download from your settings page.';
      } else if (r.kind === 'CORRECTION') {
        if (input.correction?.fullName) { await tx.query('UPDATE user_profiles SET full_name_enc=$2, updated_at=now() WHERE user_id=$1', [r.user_id, this.crypto.encrypt(input.correction.fullName)]); await tx.query('UPDATE users SET updated_at=now() WHERE id=$1', [r.user_id]); }
        resolution = resolution || (input.correction ? 'The correction was made.' : 'The correction was reviewed.');
      } else if (r.kind === 'DEACTIVATION') {
        await tx.query(`UPDATE users SET account_status='DEACTIVATED', updated_at=now() WHERE id=$1`, [r.user_id]); await this.sessions.revokeAll(r.user_id);
        resolution = resolution || 'Your account was closed.';
      } else {
        const done = await this.erase(tx, r.user_id);
        resolution = (resolution ? resolution + ' ' : '') + `Personal details were removed. Kept by law: ${RETAINED.map((x) => x.what.split(' (')[0]).join('; ')}.`; tell = false; void done;
      }
      await tx.query(`UPDATE data_subject_requests SET status=$2::request_status, resolution=$3, export_key=$4, handled_by=$5, closed_at=now(), updated_at=now(), details = CASE WHEN $6 THEN NULL ELSE details END WHERE id=$1`, [id, status, resolution, exportKey, admin.userId, r.kind === 'ERASURE' && status === 'CLOSED']);
      await this.audit.record(tx, { action: `dsr.${input.action === 'FULFIL' ? 'fulfilled' : 'rejected'}`, entityType: 'data_subject_request', entityId: id, details: { kind: r.kind } });
      return { id, status, kind: r.kind as string, userId: r.user_id as string, tell };
    });
    if (out.tell) await this.notif.notifyUser(out.userId, 'DSR_UPDATED', { kind: KIND_WORD[out.kind]!, status: out.status === 'CLOSED' ? 'done' : 'declined' }, '/owner/settings').catch(() => undefined);
    return { id: out.id, status: out.status };
  }

  private async buildExport(tx: Tx, uid: string) {
    const c = this.crypto; const one = async (sql: string, p: unknown[] = [uid]) => (await tx.query(sql, p)).rows;
    const u = (await one('SELECT u.mobile_enc, u.email_enc, u.created_at, u.preferred_lang, p.full_name_enc, p.dob_enc, p.address_enc, p.id_doc_type, p.id_last4 FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1'))[0] ?? {};
    const biz = await one('SELECT id, type, firm_name_enc, trade_licence_enc, gstin_enc, address_enc, area_id, created_at FROM businesses WHERE owner_user_id=$1');
    const bids = biz.map((b) => b.id);
    return {
      generatedAt: new Date().toISOString(),
      account: { fullName: c.decStr(u.full_name_enc), mobile: c.decStr(u.mobile_enc), email: c.decStr(u.email_enc), dateOfBirth: c.decStr(u.dob_enc), address: u.address_enc ? c.decJson(u.address_enc) : null, idProof: u.id_doc_type ? { type: u.id_doc_type, lastFour: u.id_last4 } : null, language: u.preferred_lang, createdAt: u.created_at },
      businesses: biz.map((b) => ({ type: b.type, firmName: c.decStr(b.firm_name_enc), tradeLicence: c.decStr(b.trade_licence_enc), gstin: c.decStr(b.gstin_enc), address: b.address_enc ? c.decJson(b.address_enc) : null, createdAt: b.created_at })),
      instruments: (await one(`SELECT instrument_no, serial_no, make, model, capacity::text, capacity_unit, status, address_enc, created_at FROM instruments WHERE business_id = ANY($1::uuid[])`, [bids])).map((i) => ({ instrumentNo: i.instrument_no, serialNo: i.serial_no, make: i.make, model: i.model, capacity: `${Number(i.capacity)} ${i.capacity_unit}`, status: i.status, address: c.decStr(i.address_enc), registeredOn: i.created_at })),
      applications: await one(`SELECT application_no AS "applicationNo", type, status, created_at AS "createdAt" FROM applications WHERE business_id = ANY($1::uuid[]) ORDER BY created_at`, [bids]),
      certificates: await one(`SELECT ce.cert_no AS "certNo", ce.status, ce.verified_on AS "verifiedOn", ce.valid_till AS "validTill" FROM certificates ce JOIN instruments i ON i.id=ce.instrument_id WHERE i.business_id = ANY($1::uuid[])`, [bids]),
      consents: await one('SELECT purpose, policy_version AS "policyVersion", granted_at AS "grantedAt", withdrawn_at AS "withdrawnAt" FROM consents WHERE user_id=$1'),
      grievances: await one(`SELECT ref_no AS "ref", subject, body, status, response, created_at AS "createdAt" FROM grievances WHERE raised_by=$1`),
      dataRequests: await one('SELECT ref_no AS "ref", kind, status, created_at AS "createdAt" FROM data_subject_requests WHERE user_id=$1'),
      notifications: Number((await one('SELECT count(*) AS n FROM in_app_notifications WHERE user_id=$1'))[0].n),
    };
  }

  /** Removes personal details but keeps the records the law requires, with the identity replaced. Refuses while a case is open. */
  private async erase(tx: Tx, uid: string) {
    const c = this.crypto;
    const bids = (await tx.query('SELECT id FROM businesses WHERE owner_user_id=$1', [uid])).rows.map((r) => r.id as string);
    const open = (await tx.query(`SELECT 1 FROM applications WHERE business_id = ANY($1::uuid[]) AND status NOT IN ('REJECTED','CANCELLED','APPLICATION_EXPIRED','CERTIFICATE_ISSUED') LIMIT 1`, [bids])).rowCount
      || (await tx.query(`SELECT 1 FROM instrument_requests WHERE from_business_id = ANY($1::uuid[]) AND status='OPEN' LIMIT 1`, [bids])).rowCount;
    if (open) throw conflict('OPEN_CASES');
    await tx.query(`UPDATE user_profiles SET full_name_enc=$2, dob_enc=NULL, address_enc=NULL, id_doc_type=NULL, id_last4=NULL, updated_at=now() WHERE user_id=$1`, [uid, c.encrypt('Erased user')]);
    await tx.query(`UPDATE users SET mobile_enc=NULL, mobile_bidx=NULL, email_enc=NULL, email_bidx=NULL, mobile_verified_at=NULL, email_verified_at=NULL, display_name_masked='Erased user', account_status='DEACTIVATED', updated_at=now() WHERE id=$1`, [uid]);
    await tx.query(`UPDATE local_credentials SET password_hash='ERASED', totp_secret_enc=NULL WHERE user_id=$1`, [uid]);
    await this.sessions.revokeAll(uid);
    await tx.query(`UPDATE businesses SET firm_name_enc=$2, trade_licence_enc=NULL, gstin_enc=NULL, address_enc=NULL, premises_geo_enc=NULL, updated_at=now() WHERE owner_user_id=$1`, [uid, c.encrypt('Erased business')]);
    await tx.query(`UPDATE instruments SET address_enc=NULL, location_enc=NULL, updated_at=now() WHERE business_id = ANY($1::uuid[])`, [bids]);
    for (const d of (await tx.query('DELETE FROM account_documents WHERE user_id=$1 RETURNING object_key', [uid])).rows) await this.storage.remove(d.object_key).catch(() => undefined);
    await tx.query('DELETE FROM in_app_notifications WHERE user_id=$1', [uid]); await tx.query('DELETE FROM notification_preferences WHERE user_id=$1', [uid]);
    await tx.query(`UPDATE grievances SET body='[removed at the requester''s request]' WHERE raised_by=$1`, [uid]);
    return { businesses: bids.length };
  }

  // ------------------------------------------------------------------ consent, retention, breach checklist
  async consents(mobile?: string) {
    return this.db.system(async (tx) => {
      const summary = (await tx.query(`SELECT purpose, policy_version, count(*)::int AS granted, count(*) FILTER (WHERE withdrawn_at IS NOT NULL)::int AS withdrawn FROM consents GROUP BY purpose, policy_version ORDER BY purpose, policy_version`)).rows;
      let person: unknown = null;
      if (mobile) {
        const rows = (await tx.query(`SELECT c.purpose, c.policy_version, c.granted_at, c.withdrawn_at FROM consents c JOIN users u ON u.id=c.user_id WHERE u.mobile_bidx = ANY($1::bytea[]) ORDER BY c.granted_at`, [this.crypto.blindIndexAll('mobile', mobile)])).rows;
        await this.audit.record(tx, { action: 'privacy.consent_lookup' });
        person = rows.map((r) => ({ purpose: r.purpose, policyVersion: r.policy_version, grantedAt: r.granted_at, withdrawnAt: r.withdrawn_at }));
      }
      return { summary: summary.map((r) => ({ purpose: r.purpose as string, policyVersion: r.policy_version as string, granted: r.granted as number, withdrawn: r.withdrawn as number })), person };
    });
  }
  async retention() {
    const last = await this.db.system(async (tx) => (await tx.query(`SELECT status, started_at, finished_at, result FROM job_runs WHERE job='retention' ORDER BY started_at DESC LIMIT 1`)).rows[0]);
    return {
      schedule: [
        { item: 'Half-finished instrument registrations', keep: '7 days' }, { item: 'Half-finished inspection forms', keep: '7 days after the visit window' }, { item: 'One-time codes (OTP)', keep: '1 day after expiry' },
        { item: 'Unused staff invitations', keep: '7 days after expiry' }, { item: 'Public lookup log (hashed addresses only)', keep: '90 days' }, { item: 'Job run log', keep: '180 days' }, { item: 'Read in-app notifications', keep: '365 days' },
        { item: 'Certificates, registry, applications, inspections', keep: 'Statutory period (not deleted by jobs)' }, { item: 'Audit trail', keep: 'Kept; no personal details inside' },
      ],
      lastRun: last ? { status: last.status as string, startedAt: last.started_at as Date, finishedAt: last.finished_at as Date | null, result: last.result as Record<string, unknown> | null } : null,
      kept: RETAINED,
    };
  }
  async breach() {
    const v = await this.db.system(async (tx) => (await tx.query(`SELECT value FROM app_settings WHERE key='breach'`)).rows[0]?.value as { steps?: Record<string, { done: boolean; at: string; by: string }> } | undefined);
    return { steps: BREACH_STEPS.map((id) => ({ id, done: !!v?.steps?.[id]?.done, at: v?.steps?.[id]?.at ?? null })) };
  }
  async breachSet(admin: SessionUser, step: string, done: boolean) {
    await this.db.system(async (tx) => {
      const cur = (await tx.query(`SELECT value FROM app_settings WHERE key='breach' FOR UPDATE`)).rows[0]?.value as { steps?: Record<string, unknown> } | undefined;
      const steps = { ...(cur?.steps ?? {}), [step]: { done, at: new Date().toISOString(), by: admin.userId } };
      await tx.query(`INSERT INTO app_settings (key, value, updated_by) VALUES ('breach', $1::jsonb, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify({ steps }), admin.userId]);
      await this.audit.record(tx, { action: 'privacy.breach_step', details: { step, done } });
    });
    return this.breach();
  }
  async breachReset(admin: SessionUser) {
    await this.db.system(async (tx) => { await tx.query(`DELETE FROM app_settings WHERE key='breach'`); await this.audit.record(tx, { action: 'privacy.breach_reset' }); });
    return this.breach();
  }
}
