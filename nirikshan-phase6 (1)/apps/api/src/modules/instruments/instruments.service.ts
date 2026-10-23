import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { parse as parseCsv } from 'csv-parse/sync';
import { BULK_COLUMNS, type InstrumentCreateInput, instrumentBaseSchema, instrumentUpdateSchema, maskFirm } from '@nirikshan/shared';
import { z } from 'zod';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { RedisService } from '../../infra/redis.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { OtpService } from '../auth/otp.service';
import { SettingsService } from '../system/settings.service';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { ctx, type SessionUser } from '../../common/request-context';

type Base = z.infer<typeof instrumentBaseSchema>;
const LOCKED_AFTER_VERIFICATION = ['categoryId', 'capacityBandId', 'accuracyClassId', 'capacity', 'capacityUnit', 'serialNo', 'make'] as const;

export interface InstrumentRow {
  id: string; instrument_no: string; category_id: string; capacity: string; capacity_unit: string; serial_no: string; make: string; model: string | null;
  manufacture_year: number | null; load_cell_serial: string | null; display_count: number | null; area_id: string; status: string; out_of_area: boolean;
  first_verified_at: Date | null; version: number; created_at: Date; address_enc: Buffer | null; location_enc: Buffer | null;
  category_name: string; category_code: string; class_code: string; area_name: string; area_code: string; sub_category_id: string | null;
  capacity_band_id: string; accuracy_class_id: string; business_id: string; on_behalf_of_business_id: string | null;
}
const SELECT = `SELECT i.*, c.name_en AS category_name, c.code AS category_code, ac.code AS class_code, a.name_en AS area_name, a.code AS area_code
  FROM instruments i JOIN categories c ON c.id=i.category_id JOIN accuracy_classes ac ON ac.id=i.accuracy_class_id JOIN areas a ON a.id=i.area_id`;

@Injectable()
export class InstrumentsService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private notify: NotificationService,
    private otp: OtpService, private redis: RedisService, private settings: SettingsService) {}
  private async bulkOn() { if (!(await this.settings.get('flags')).bulkRegister) throw new AppError(503, 'FEATURE_DISABLED'); }

  // ------------------------------------------------------------------ shared building blocks
  async divisionOf(tx: Tx, areaId: string): Promise<string | null> {
    const r = await tx.query(
      `WITH RECURSIVE up AS (SELECT id, parent_id, level FROM areas WHERE id=$1 UNION ALL SELECT a.id, a.parent_id, a.level FROM areas a JOIN up ON a.id=up.parent_id)
       SELECT id FROM up WHERE level='DIVISION' LIMIT 1`, [areaId]);
    return (r.rows[0]?.id as string | undefined) ?? null;
  }

  /** Checks references against master data. Returns a list of error codes (empty = valid). */
  async validateRefs(tx: Tx, b: Pick<Base, 'categoryId' | 'subCategoryId' | 'capacityBandId' | 'accuracyClassId' | 'capacity' | 'capacityUnit'> & { location: { areaId: string } }): Promise<string[]> {
    const errs: string[] = [];
    const cat = await tx.query(`SELECT 1 FROM categories WHERE id=$1 AND status='ACTIVE'`, [b.categoryId]);
    if (!cat.rowCount) errs.push('INVALID_CATEGORY');
    if (b.subCategoryId) { const s = await tx.query('SELECT 1 FROM sub_categories WHERE id=$1 AND category_id=$2', [b.subCategoryId, b.categoryId]); if (!s.rowCount) errs.push('INVALID_SUB_CATEGORY'); }
    const band = (await tx.query('SELECT unit, $2::numeric BETWEEN min_capacity AND max_capacity AS inside FROM capacity_bands WHERE id=$1 AND category_id=$3', [b.capacityBandId, b.capacity, b.categoryId])).rows[0] as { unit: string; inside: boolean } | undefined;
    if (!band) errs.push('INVALID_CAPACITY_BAND');
    else { if (!band.inside) errs.push('CAPACITY_OUTSIDE_BAND'); if (band.unit.toLowerCase() !== b.capacityUnit.toLowerCase()) errs.push('UNIT_MISMATCH'); }
    if (!(await tx.query('SELECT 1 FROM accuracy_classes WHERE id=$1', [b.accuracyClassId])).rowCount) errs.push('INVALID_ACCURACY_CLASS');
    const area = (await tx.query(`SELECT level FROM areas WHERE id=$1 AND status='ACTIVE'`, [b.location.areaId])).rows[0] as { level: string } | undefined;
    if (!area || area.level !== 'WARD') errs.push('INVALID_AREA');
    return errs;
  }

  async isDuplicate(serial: string, make: string, categoryId: string, excludeId?: string): Promise<boolean> {
    return this.db.system(async (tx) => ((await tx.query(
      `SELECT 1 FROM instruments WHERE lower(serial_no)=lower($1) AND lower(make)=lower($2) AND category_id=$3 AND status<>'DEREGISTERED' AND duplicate_override_by IS NULL AND ($4::uuid IS NULL OR id<>$4)`,
      [serial, make, categoryId, excludeId ?? null])).rowCount ?? 0) > 0);
  }

  async outOfArea(tx: Tx, instrumentAreaId: string, businessAreaId: string, lat?: number, lng?: number): Promise<boolean> {
    const [d1, d2] = await Promise.all([this.divisionOf(tx, instrumentAreaId), this.divisionOf(tx, businessAreaId)]);
    if (d1 !== d2) return true;
    if (this.db.hasPostgis && lat != null && lng != null) {
      const r = await tx.query(`SELECT id FROM areas WHERE level='WARD' AND boundary IS NOT NULL AND ST_Contains(boundary, ST_SetSRID(ST_MakePoint($1,$2),4326)) LIMIT 1`, [lng, lat]);
      if (r.rows[0] && r.rows[0].id !== instrumentAreaId) return true;
    }
    return false;
  }

  private pointSql(n1: number, n2: number) { return this.db.hasPostgis ? `ST_SetSRID(ST_MakePoint($${n1},$${n2}),4326)` : `point($${n1},$${n2})`; }

  /** Inserts one instrument. Caller supplies the transaction (user or officer context) and has validated references. */
  async insert(tx: Tx, b: Base, businessId: string, businessAreaId: string, createdBy: string, overrideBy?: string): Promise<{ id: string; instrumentNo: string; outOfArea: boolean }> {
    const c = this.crypto; const id = uuidv7(); const { lat, lng } = b.location;
    const oa = await this.outOfArea(tx, b.location.areaId, businessAreaId, lat, lng);
    const hasGeo = lat != null && lng != null;
    const r = await tx.query(
      `INSERT INTO instruments (id, business_id, on_behalf_of_business_id, category_id, sub_category_id, capacity_band_id, accuracy_class_id, capacity, capacity_unit,
         serial_no, make, model, manufacture_year, load_cell_serial, display_count, area_id, address_enc, location_enc, out_of_area, duplicate_override_by, created_by
         ${hasGeo ? ', location' : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21 ${hasGeo ? ',' + this.pointSql(22, 23) : ''}) RETURNING instrument_no`,
      [id, b.ownership.mode === 'ON_BEHALF' ? businessId : businessId, b.ownership.mode === 'ON_BEHALF' ? b.ownership.customerBusinessId : null, b.categoryId, b.subCategoryId ?? null,
        b.capacityBandId, b.accuracyClassId, b.capacity, b.capacityUnit, b.serialNo, b.make, b.model ?? null, b.manufactureYear ?? null, b.loadCellSerial ?? null,
        b.displayCount ?? null, b.location.areaId, c.encrypt(b.location.address), hasGeo ? c.encJson({ lat, lng }) : null, oa, overrideBy ?? null, createdBy,
        ...(hasGeo ? [lng, lat] : [])]);
    return { id, instrumentNo: r.rows[0].instrument_no as string, outOfArea: oa };
  }

  /** The business an instrument is registered under. SELF = the user's own business, ON_BEHALF = the trader's own business plus a managed customer. */
  async resolveBusiness(tx: Tx, user: SessionUser, b: Base): Promise<{ id: string; areaId: string }> {
    const own = (await tx.query('SELECT id, area_id FROM businesses WHERE owner_user_id=$1 AND is_managed_customer=false ORDER BY created_at LIMIT 1', [user.userId])).rows[0] as { id: string; area_id: string } | undefined;
    if (!own) throw forbidden('NO_BUSINESS');
    if (b.ownership.mode === 'ON_BEHALF') {
      if (user.role !== 'TRADER') throw forbidden('TRADER_ONLY');
      const cust = (await tx.query('SELECT 1 FROM businesses WHERE id=$1 AND owner_user_id=$2 AND is_managed_customer=true', [b.ownership.customerBusinessId, user.userId])).rowCount;
      if (!cust) throw notFound('CUSTOMER_NOT_FOUND');
    }
    return { id: own.id, areaId: own.area_id };
  }

  // ------------------------------------------------------------------ API operations
  async create(user: SessionUser, input: InstrumentCreateInput): Promise<{ status: number; body: Record<string, unknown> }> {
    await this.otp.consume(input.confirmToken, { purpose: 'CONFIRM', channel: 'MOBILE', userId: user.userId });
    const { confirmToken: _t, declarationAccepted: _d, requestDuplicateReview, ...base } = input;
    const errs = await this.db.system((tx) => this.validateRefs(tx, base));
    if (errs.length) throw unprocessable('INVALID_REFERENCE', { reasons: errs });
    const dup = await this.isDuplicate(base.serialNo, base.make, base.categoryId);
    try {
      return await this.db.forUser(async (tx) => {
        const biz = await this.resolveBusiness(tx, user, base);
        if (dup) {
          if (!requestDuplicateReview) throw conflict('DUPLICATE_INSTRUMENT', { canRequestReview: true });
          const r = await tx.query(
            `INSERT INTO instrument_duplicate_requests (business_id, area_id, requested_by, payload_enc) VALUES ($1,$2,$3,$4) RETURNING id`,
            [biz.id, base.location.areaId, user.userId, this.crypto.encJson({ base, businessId: biz.id, businessAreaId: biz.areaId })]);
          await this.audit.record(tx, { action: 'instrument.duplicate_review_requested', entityType: 'duplicate_request', entityId: r.rows[0].id, areaId: base.location.areaId });
          return { status: 202, body: { status: 'REVIEW_REQUESTED', requestId: r.rows[0].id as string }, notifyArea: base.location.areaId } as never;
        }
        const ins = await this.insert(tx, base, biz.id, biz.areaId, user.userId);
        await tx.query('DELETE FROM instrument_drafts WHERE user_id=$1', [user.userId]);
        await this.audit.record(tx, { action: 'instrument.created', entityType: 'instrument', entityId: ins.id, areaId: base.location.areaId, details: { outOfArea: ins.outOfArea, onBehalf: base.ownership.mode === 'ON_BEHALF' } });
        return { status: 201, body: { id: ins.id, instrumentNo: ins.instrumentNo, outOfArea: ins.outOfArea } };
      }).then((r) => {
        const x = r as unknown as { notifyArea?: string; status: number; body: Record<string, unknown> };
        if (x.notifyArea) void this.notify.notifyOfficersInArea(x.notifyArea, 'DUPLICATE_REVIEW_REQUESTED', {}, '/officer/queue?tab=duplicates').catch(() => undefined);
        return { status: x.status, body: x.body };
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('DUPLICATE_INSTRUMENT', { canRequestReview: true }); // lost a race with another registration
      throw e;
    }
  }

  toDto(r: InstrumentRow, revealPremises: boolean) {
    const loc = revealPremises && r.location_enc ? this.crypto.decJson<{ lat: number; lng: number }>(r.location_enc) : null;
    return {
      id: r.id, instrumentNo: r.instrument_no, category: { id: r.category_id, code: r.category_code, name: r.category_name }, subCategoryId: r.sub_category_id,
      capacityBandId: r.capacity_band_id, accuracyClassId: r.accuracy_class_id, classCode: r.class_code, capacity: r.capacity, capacityUnit: r.capacity_unit,
      serialNo: r.serial_no, make: r.make, model: r.model, manufactureYear: r.manufacture_year, loadCellSerial: r.load_cell_serial, displayCount: r.display_count,
      area: { id: r.area_id, code: r.area_code, name: r.area_name }, address: r.address_enc ? this.crypto.decStr(r.address_enc) : null,
      location: loc, status: r.status, outOfArea: r.out_of_area, firstVerifiedAt: r.first_verified_at, version: r.version, createdAt: r.created_at,
      ownership: r.on_behalf_of_business_id ? 'ON_BEHALF' : 'SELF',
    };
  }

  async list(user: SessionUser, q: { cursor?: string; limit: number; status?: string; categoryId?: string; areaId?: string; q?: string }) {
    const params: unknown[] = []; const where: string[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    // explicit scope as well as RLS (defence in depth)
    if (user.role === 'OWNER' || user.role === 'TRADER') where.push(`(i.business_id = ANY(${p(user.businessIds)}::uuid[]) OR i.on_behalf_of_business_id = ANY(${p(user.businessIds)}::uuid[]))`);
    else if (user.role === 'OFFICER' || user.role === 'SENIOR_OFFICER') where.push(`i.area_id = ANY(${p(user.areaIds)}::uuid[])`);
    else if (user.role !== 'ADMIN') throw forbidden();
    if (q.status) where.push(`i.status = ${p(q.status)}::instrument_status`);
    if (q.categoryId) where.push(`i.category_id = ${p(q.categoryId)}`);
    if (q.areaId) where.push(`i.area_id = ${p(q.areaId)}`);
    if (q.q) { const t = q.q.trim(); if (t.length < 3) throw unprocessable('QUERY_TOO_SHORT'); where.push(`(lower(i.serial_no) LIKE ${p(t.toLowerCase().replace(/[%_\\]/g, '\\$&') + '%')} OR i.instrument_no = ${p(t.toUpperCase())})`); }
    if (q.cursor) {
      const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw unprocessable('BAD_CURSOR');
      where.push(`(i.created_at, i.id) < (${p(ts)}::timestamptz, ${p(id)}::uuid)`);
    }
    const rows = await this.db.forUser(async (tx) => (await tx.query(
      `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.created_at DESC, i.id DESC LIMIT ${q.limit + 1}`, params)).rows as InstrumentRow[]);
    const page = rows.slice(0, q.limit); const last = page[page.length - 1];
    const own = user.role === 'OWNER' || user.role === 'TRADER';
    return {
      items: page.map((r) => this.toDto(r, own)),
      nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  async get(user: SessionUser, id: string) {
    const r = await this.db.forUser(async (tx) => (await tx.query(`${SELECT} WHERE i.id=$1`, [id])).rows[0] as InstrumentRow | undefined);
    if (!r) throw notFound(); // outside scope looks the same as missing
    return this.toDto(r, user.role === 'OWNER' || user.role === 'TRADER');
  }

  async update(user: SessionUser, id: string, ifMatch: number | null, patch: z.infer<typeof instrumentUpdateSchema>) {
    if (ifMatch == null) throw new AppError(428, 'IF_MATCH_REQUIRED');
    return this.db.forUser(async (tx) => {
      const cur = (await tx.query(`${SELECT} WHERE i.id=$1 FOR UPDATE OF i`, [id])).rows[0] as InstrumentRow | undefined;
      if (!cur || !(user.businessIds.includes(cur.business_id))) throw notFound();
      if (cur.status === 'DEREGISTERED') throw conflict('INSTRUMENT_DEREGISTERED');
      if (cur.version !== ifMatch) throw new AppError(412, 'VERSION_CONFLICT');
      if (cur.first_verified_at) for (const k of LOCKED_AFTER_VERIFICATION) if (patch[k] !== undefined) throw conflict('FIELD_LOCKED', { field: k, hint: 'REREGISTER' });
      const next = {
        categoryId: patch.categoryId ?? cur.category_id, capacityBandId: patch.capacityBandId ?? cur.capacity_band_id, accuracyClassId: patch.accuracyClassId ?? cur.accuracy_class_id,
        capacity: patch.capacity ?? cur.capacity, capacityUnit: patch.capacityUnit ?? cur.capacity_unit, serialNo: patch.serialNo ?? cur.serial_no, make: patch.make ?? cur.make,
        subCategoryId: patch.categoryId && patch.categoryId !== cur.category_id ? undefined : cur.sub_category_id ?? undefined,
        location: { areaId: patch.location?.areaId ?? cur.area_id },
      };
      const errs = await this.validateRefs(tx, next); if (errs.length) throw unprocessable('INVALID_REFERENCE', { reasons: errs });
      if ((patch.serialNo || patch.make || patch.categoryId) && await this.isDuplicate(next.serialNo, next.make, next.categoryId, id)) throw conflict('DUPLICATE_INSTRUMENT');
      const biz = (await tx.query('SELECT area_id FROM businesses WHERE id=$1', [cur.business_id])).rows[0] as { area_id: string };
      let oa = cur.out_of_area; let addr = cur.address_enc; let locEnc = cur.location_enc; let setPoint = '';
      const params: unknown[] = [];
      if (patch.location) {
        oa = await this.outOfArea(tx, patch.location.areaId, biz.area_id, patch.location.lat, patch.location.lng);
        addr = this.crypto.encrypt(patch.location.address);
        if (patch.location.lat != null && patch.location.lng != null) { locEnc = this.crypto.encJson({ lat: patch.location.lat, lng: patch.location.lng }); }
      }
      const r = await tx.query(
        `UPDATE instruments SET category_id=$3, capacity_band_id=$4, accuracy_class_id=$5, capacity=$6, capacity_unit=$7, serial_no=$8, make=$9, area_id=$10,
           model=$11, manufacture_year=$12, load_cell_serial=$13, display_count=$14, address_enc=$15, location_enc=$16, out_of_area=$17, version=version+1, updated_at=now()
         WHERE id=$1 AND version=$2 RETURNING version`,
        [id, ifMatch, next.categoryId, next.capacityBandId, next.accuracyClassId, next.capacity, next.capacityUnit, next.serialNo, next.make, next.location.areaId,
          patch.model !== undefined ? patch.model : cur.model, patch.manufactureYear !== undefined ? patch.manufactureYear : cur.manufacture_year,
          patch.loadCellSerial !== undefined ? patch.loadCellSerial : cur.load_cell_serial, patch.displayCount !== undefined ? patch.displayCount : cur.display_count, addr, locEnc, oa]);
      void params; void setPoint;
      if (!r.rowCount) throw new AppError(412, 'VERSION_CONFLICT');
      await this.audit.record(tx, { action: 'instrument.updated', entityType: 'instrument', entityId: id, areaId: next.location.areaId, details: { fields: Object.keys(patch) } });
      return { id, version: r.rows[0].version as number };
    });
  }

  // ------------------------------------------------------------------ drafts (server-side autosave, expires after 7 days)
  async saveDraft(user: SessionUser, step: number, data: Record<string, unknown>) {
    return this.db.forUser(async (tx) => {
      const r = await tx.query(
        `INSERT INTO instrument_drafts (user_id, payload_enc, step, expires_at, updated_at) VALUES ($1,$2,$3, now() + interval '7 days', now())
         ON CONFLICT (user_id) DO UPDATE SET payload_enc=EXCLUDED.payload_enc, step=EXCLUDED.step, expires_at=EXCLUDED.expires_at, updated_at=now() RETURNING updated_at`,
        [user.userId, this.crypto.encJson(data), step]);
      return { savedAt: r.rows[0].updated_at as Date };
    });
  }
  async getDraft(user: SessionUser) {
    return this.db.forUser(async (tx) => {
      const r = (await tx.query('SELECT payload_enc, step, updated_at FROM instrument_drafts WHERE user_id=$1 AND expires_at > now()', [user.userId])).rows[0];
      return r ? { step: r.step as number, data: this.crypto.decJson<Record<string, unknown>>(r.payload_enc), savedAt: r.updated_at as Date } : null;
    });
  }
  async deleteDraft(user: SessionUser) { await this.db.forUser((tx) => tx.query('DELETE FROM instrument_drafts WHERE user_id=$1', [user.userId])); }

  // ------------------------------------------------------------------ managed customers (traders)
  async createCustomer(user: SessionUser, firmName: string, areaId: string) {
    return this.db.forUser(async (tx) => {
      const area = (await tx.query(`SELECT 1 FROM areas WHERE id=$1 AND level='WARD' AND status='ACTIVE'`, [areaId])).rowCount;
      if (!area) throw unprocessable('INVALID_AREA');
      const r = await tx.query(
        `INSERT INTO businesses (owner_user_id, type, firm_name_enc, firm_name_masked, area_id, is_managed_customer) VALUES ($1,'OWNER',$2,$3,$4,true) RETURNING id`,
        [user.userId, this.crypto.encrypt(firmName), maskFirm(firmName), areaId]);
      await this.audit.record(tx, { action: 'business.customer_created', entityType: 'business', entityId: r.rows[0].id, areaId });
      return { id: r.rows[0].id as string, firmName, areaId };
    });
  }
  async listCustomers(user: SessionUser) {
    return this.db.forUser(async (tx) => (await tx.query(
      `SELECT b.id, b.firm_name_enc, b.area_id, a.name_en AS area_name FROM businesses b JOIN areas a ON a.id=b.area_id WHERE b.owner_user_id=$1 AND b.is_managed_customer ORDER BY b.created_at DESC`, [user.userId])).rows
      .map((r) => ({ id: r.id as string, firmName: this.crypto.decStr(r.firm_name_enc)!, areaId: r.area_id as string, areaName: r.area_name as string })));
  }

  // ------------------------------------------------------------------ export and bulk
  static csvCell(v: unknown): string {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  async exportCsv(user: SessionUser): Promise<string> {
    const { items } = await this.list(user, { limit: 5000 });
    await this.db.forUser((tx) => this.audit.record(tx, { action: 'instrument.exported', details: { rows: items.length } }));
    const head = ['instrument_no', 'category', 'capacity', 'unit', 'class', 'serial_no', 'make', 'model', 'year', 'area', 'status', 'registered_on'];
    const lines = items.map((i) => [i.instrumentNo, i.category.name, i.capacity, i.capacityUnit, i.classCode, i.serialNo, i.make, i.model, i.manufactureYear, i.area.name, i.status, i.createdAt.toISOString().slice(0, 10)].map(InstrumentsService.csvCell).join(','));
    return [head.join(','), ...lines].join('\n') + '\n';
  }
  static template(): string {
    return BULK_COLUMNS.join(',') + '\nPLATFORM_SCALE,300,kg,III,SN-0001,Acme,PS-300,2024,,12 Sample Road,WARD-001,\n';
  }

  async bulkValidate(user: SessionUser, buf: Buffer) {
    await this.bulkOn();
    let rows: Record<string, string>[];
    try { rows = parseCsv(buf, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: false }); }
    catch { throw unprocessable('BAD_CSV'); }
    if (rows.length === 0) throw unprocessable('EMPTY_FILE');
    if (rows.length > 500) throw unprocessable('TOO_MANY_ROWS', { max: 500 });
    const first = rows[0]!; for (const col of BULK_COLUMNS) if (!(col in first)) throw unprocessable('MISSING_COLUMN', { column: col });
    const report: { row: number; ok: boolean; errors: string[] }[] = []; const valid: { row: number; base: Base; customerFirm?: string }[] = [];
    const seen = new Set<string>();
    await this.db.system(async (tx) => {
      for (const [idx, r] of rows.entries()) {
        const rowNo = idx + 2; const errors: string[] = [];
        const cat = (await tx.query(`SELECT id FROM categories WHERE code=$1 AND status='ACTIVE'`, [(r.category_code ?? '').toUpperCase()])).rows[0];
        const cls = (await tx.query('SELECT id FROM accuracy_classes WHERE code=$1', [(r.accuracy_class_code ?? '').toUpperCase()])).rows[0];
        const area = (await tx.query(`SELECT id FROM areas WHERE code=$1 AND level='WARD' AND status='ACTIVE'`, [r.area_code ?? ''])).rows[0];
        if (!cat) errors.push('INVALID_CATEGORY'); if (!cls) errors.push('INVALID_ACCURACY_CLASS'); if (!area) errors.push('INVALID_AREA');
        const band = cat && /^\d{1,14}(\.\d{1,4})?$/.test(r.capacity ?? '')
          ? (await tx.query('SELECT id FROM capacity_bands WHERE category_id=$1 AND lower(unit)=lower($3) AND $2::numeric BETWEEN min_capacity AND max_capacity LIMIT 1', [cat.id, r.capacity, r.capacity_unit ?? ''])).rows[0] : null;
        if (!band) errors.push('CAPACITY_OUTSIDE_BAND');
        const year = r.manufacture_year ? Number(r.manufacture_year) : undefined; const disp = r.display_count ? Number(r.display_count) : undefined;
        const candidate = {
          categoryId: cat?.id, capacityBandId: band?.id, accuracyClassId: cls?.id, capacity: r.capacity, capacityUnit: r.capacity_unit, serialNo: r.serial_no, make: r.make,
          model: r.model || undefined, manufactureYear: year, loadCellSerial: r.load_cell_serial || undefined, displayCount: disp,
          location: { address: r.address, areaId: area?.id }, ownership: { mode: 'SELF' as const },
        };
        const parsed = instrumentBaseSchema.safeParse(candidate);
        if (!parsed.success) for (const i of parsed.error.issues) errors.push(`INVALID_${String(i.path[0] ?? 'ROW').toUpperCase()}`);
        if (parsed.success) {
          const key = `${parsed.data.serialNo.toLowerCase()}|${parsed.data.make.toLowerCase()}|${parsed.data.categoryId}`;
          if (seen.has(key)) errors.push('DUPLICATE_IN_FILE'); seen.add(key);
          if (await this.isDuplicate(parsed.data.serialNo, parsed.data.make, parsed.data.categoryId)) errors.push('DUPLICATE_INSTRUMENT');
        }
        const uniq = [...new Set(errors)];
        report.push({ row: rowNo, ok: uniq.length === 0, errors: uniq });
        if (uniq.length === 0 && parsed.success) valid.push({ row: rowNo, base: parsed.data, customerFirm: r.customer_firm || undefined });
      }
    });
    const uploadId = (await import('crypto')).randomUUID();
    await this.redis.setJson(`bulk:${user.userId}:${uploadId}`, { valid, report }, 1800);
    return { uploadId, total: rows.length, valid: valid.length, invalid: rows.length - valid.length, report };
  }
  async bulkErrorsCsv(user: SessionUser, uploadId: string): Promise<string> {
    const s = await this.redis.getJson<{ report: { row: number; ok: boolean; errors: string[] }[] }>(`bulk:${user.userId}:${uploadId}`);
    if (!s) throw notFound('UPLOAD_EXPIRED');
    return ['row,errors', ...s.report.filter((r) => !r.ok).map((r) => `${r.row},${InstrumentsService.csvCell(r.errors.join(' '))}`)].join('\n') + '\n';
  }
  async bulkCommit(user: SessionUser, uploadId: string, confirmToken: string) {
    await this.bulkOn();
    await this.otp.consume(confirmToken, { purpose: 'CONFIRM', channel: 'MOBILE', userId: user.userId });
    const s = await this.redis.takeJson<{ valid: { row: number; base: Base; customerFirm?: string }[] }>(`bulk:${user.userId}:${uploadId}`);
    if (!s) throw notFound('UPLOAD_EXPIRED');
    const results: { row: number; ok: boolean; instrumentNo?: string; error?: string }[] = [];
    for (const v of s.valid) {
      try {
        const out = await this.db.forUser(async (tx) => {
          await tx.query('SAVEPOINT row_sp');
          let base = v.base;
          if (v.customerFirm) {
            const firm = v.customerFirm;
            const existing = (await tx.query('SELECT id, firm_name_enc FROM businesses WHERE owner_user_id=$1 AND is_managed_customer AND area_id=$2', [user.userId, base.location.areaId])).rows
              .find((b) => this.crypto.decStr(b.firm_name_enc)?.toLowerCase() === firm.toLowerCase());
            const custId = existing?.id ?? (await tx.query(
              `INSERT INTO businesses (owner_user_id, type, firm_name_enc, firm_name_masked, area_id, is_managed_customer) VALUES ($1,'OWNER',$2,$3,$4,true) RETURNING id`,
              [user.userId, this.crypto.encrypt(firm), maskFirm(firm), base.location.areaId])).rows[0].id;
            base = { ...base, ownership: { mode: 'ON_BEHALF', customerBusinessId: custId } };
          }
          const biz = await this.resolveBusiness(tx, user, base);
          const ins = await this.insert(tx, base, biz.id, biz.areaId, user.userId);
          await this.audit.record(tx, { action: 'instrument.created', entityType: 'instrument', entityId: ins.id, areaId: base.location.areaId, details: { bulk: true } });
          return ins;
        });
        results.push({ row: v.row, ok: true, instrumentNo: out.instrumentNo });
      } catch (e) {
        results.push({ row: v.row, ok: false, error: (e as { code?: string }).code === '23505' ? 'DUPLICATE_INSTRUMENT' : (e as AppError).getResponse ? String(((e as AppError).getResponse() as { code?: string }).code) : 'FAILED' });
      }
    }
    await this.db.forUser((tx) => this.audit.record(tx, { action: 'instrument.bulk_committed', details: { accepted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } }));
    return { accepted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }
}
void ctx;
