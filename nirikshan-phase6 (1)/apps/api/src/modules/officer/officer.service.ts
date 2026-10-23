import { Injectable } from '@nestjs/common';
import { instrumentBaseSchema, maskMobile } from '@nirikshan/shared';
import { z } from 'zod';
import { DbService } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { StorageService } from '../../infra/storage';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { AppError, conflict, notFound } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

@Injectable()
export class OfficerService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notify: NotificationService,
    private storage: StorageService, private instruments: InstrumentsService) {}

  private scopeClause(u: SessionUser, col: string, params: unknown[]) {
    if (u.role === 'ADMIN') return 'TRUE';
    params.push(u.areaIds); return `${col} = ANY($${params.length}::uuid[])`;
  }

  // ------------------------------------------------------------------ account approvals
  async pendingAccounts(u: SessionUser) {
    const params: unknown[] = [];
    const scope = this.scopeClause(u, 'b.area_id', params);
    return this.db.forUser(async (tx) => {
      const rows = (await tx.query(
        `SELECT us.id, us.created_at, us.mobile_enc, r.code AS role, b.type, b.firm_name_enc, b.trade_licence_enc, b.gstin_enc, b.address_enc, b.area_id, a.name_en AS area_name,
                p.full_name_enc, p.id_doc_type, p.id_last4,
                (SELECT json_agg(json_build_object('id', d.id, 'kind', d.kind, 'mime', d.mime_type, 'size', d.size_bytes, 'review', d.review)) FROM account_documents d WHERE d.user_id=us.id) AS docs
         FROM users us JOIN user_roles ur ON ur.user_id=us.id JOIN roles r ON r.id=ur.role_id
         JOIN businesses b ON b.owner_user_id=us.id AND b.is_managed_customer=false JOIN areas a ON a.id=b.area_id LEFT JOIN user_profiles p ON p.user_id=us.id
         WHERE us.account_status='PENDING_VERIFICATION' AND ${scope} ORDER BY us.created_at`, params)).rows;
      return rows.map((r) => ({
        id: r.id as string, submittedAt: r.created_at as Date, role: r.role as string, businessType: r.type as string, area: { id: r.area_id as string, name: r.area_name as string },
        fullName: this.crypto.decStr(r.full_name_enc), firmName: this.crypto.decStr(r.firm_name_enc), tradeLicenceNo: this.crypto.decStr(r.trade_licence_enc), gstin: this.crypto.decStr(r.gstin_enc),
        address: r.address_enc ? this.crypto.decJson(r.address_enc) : null, mobileMasked: r.mobile_enc ? maskMobile(this.crypto.decStr(r.mobile_enc)!) : null,
        idProof: r.id_doc_type ? { type: r.id_doc_type as string, last4: r.id_last4 as string } : null, documents: (r.docs ?? []) as { id: string; kind: string; mime: string; size: number; review: string }[],
      }));
    });
  }

  async decideAccount(u: SessionUser, userId: string, outcome: 'APPROVED' | 'REJECTED', reason?: string) {
    await this.db.forUser(async (tx) => {
      const params: unknown[] = [userId]; const scope = this.scopeClause(u, 'b.area_id', params);
      const row = (await tx.query(
        `SELECT us.id, b.area_id FROM users us JOIN businesses b ON b.owner_user_id=us.id AND b.is_managed_customer=false
         WHERE us.id=$1 AND us.account_status='PENDING_VERIFICATION' AND ${scope} FOR UPDATE OF us`, params)).rows[0] as { id: string; area_id: string } | undefined;
      if (!row) throw notFound();
      await tx.query(`UPDATE users SET account_status=$2::account_status, version=version+1, updated_at=now() WHERE id=$1`, [userId, outcome === 'APPROVED' ? 'ACTIVE' : 'REJECTED']);
      await tx.query('INSERT INTO account_reviews (user_id, reviewer_id, outcome, reason) VALUES ($1,$2,$3,$4)', [userId, u.userId, outcome, reason ?? null]);
      await tx.query(`UPDATE account_documents SET review=$2::doc_review_status WHERE user_id=$1`, [userId, outcome === 'APPROVED' ? 'ACCEPTED' : 'FLAGGED']);
      await this.audit.record(tx, { action: outcome === 'APPROVED' ? 'account.approved' : 'account.rejected', entityType: 'user', entityId: userId, areaId: row.area_id });
    });
    // The user is told the outcome (and the reason, when rejected) by SMS, email and in-app. The reason is entered by the officer and shown to the applicant.
    await this.notify.notifyUser(userId, outcome === 'APPROVED' ? 'ACCOUNT_APPROVED' : 'ACCOUNT_REJECTED', { reason: reason ?? '', dedupe: `decision:${Date.now()}` }, '/owner/dashboard');
    return { ok: true };
  }

  /** Short-lived link to one account document. Every view by staff is audited. */
  async documentLink(u: SessionUser, userId: string, docId: string) {
    return this.db.forUser(async (tx) => {
      const params: unknown[] = [docId, userId]; const scope = this.scopeClause(u, 'b.area_id', params);
      const d = (await tx.query(
        `SELECT d.object_key, d.mime_type, b.area_id FROM account_documents d JOIN businesses b ON b.owner_user_id=d.user_id AND b.is_managed_customer=false WHERE d.id=$1 AND d.user_id=$2 AND ${scope}`, params)).rows[0];
      if (!d) throw notFound();
      await this.audit.record(tx, { action: 'document.viewed', entityType: 'account_document', entityId: docId, areaId: d.area_id });
      return { url: await this.storage.signedUrl(d.object_key as string, d.mime_type as string, 300), expiresInSeconds: 300 };
    });
  }

  // ------------------------------------------------------------------ duplicate instrument overrides
  async duplicates(u: SessionUser) {
    const params: unknown[] = []; const scope = this.scopeClause(u, 'q.area_id', params);
    return this.db.forUser(async (tx) => (await tx.query(
      `SELECT q.id, q.status, q.created_at, q.payload_enc, a.name_en AS area_name FROM instrument_duplicate_requests q JOIN areas a ON a.id=q.area_id
       WHERE q.status='OPEN' AND ${scope} ORDER BY q.created_at`, params)).rows.map((r) => {
      const p = this.crypto.decJson<{ base: z.infer<typeof instrumentBaseSchema> }>(r.payload_enc).base;
      return { id: r.id as string, createdAt: r.created_at as Date, area: r.area_name as string, serialNo: p.serialNo, make: p.make, capacity: p.capacity, capacityUnit: p.capacityUnit };
    }));
  }
  async decideDuplicate(u: SessionUser, id: string, outcome: 'APPROVED' | 'REJECTED', reason?: string) {
    const notifyUser = await this.db.forUser(async (tx) => {
      const params: unknown[] = [id]; const scope = this.scopeClause(u, 'q.area_id', params);
      const q = (await tx.query(`SELECT q.* FROM instrument_duplicate_requests q WHERE q.id=$1 AND q.status='OPEN' AND ${scope} FOR UPDATE`, params)).rows[0];
      if (!q) throw notFound();
      let resulting: string | null = null;
      if (outcome === 'APPROVED') {
        const p = this.crypto.decJson<{ base: z.infer<typeof instrumentBaseSchema>; businessId: string; businessAreaId: string }>(q.payload_enc);
        const ins = await this.instruments.insert(tx, p.base, p.businessId, p.businessAreaId, q.requested_by as string, u.userId);
        resulting = ins.id;
        await this.audit.record(tx, { action: 'instrument.created', entityType: 'instrument', entityId: ins.id, areaId: q.area_id, details: { duplicateOverride: true } });
      }
      await tx.query(`UPDATE instrument_duplicate_requests SET status=$2::request_status, decided_by=$3, reason=$4, resulting_instrument_id=$5, decided_at=now() WHERE id=$1`,
        [id, outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED', u.userId, reason ?? null, resulting]);
      await this.audit.record(tx, { action: outcome === 'APPROVED' ? 'instrument.duplicate_approved' : 'instrument.duplicate_rejected', entityType: 'duplicate_request', entityId: id, areaId: q.area_id });
      return q.requested_by as string;
    });
    await this.notify.notifyUser(notifyUser, 'DUPLICATE_REVIEW_DECIDED', { outcome: outcome === 'APPROVED' ? 'approved' : 'declined', dedupe: id }, '/owner/instruments');
    return { ok: true };
  }
}
void conflict; void AppError;
