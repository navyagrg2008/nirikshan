import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { istDay, maskFirm } from '@nirikshan/shared';
import { DbService, Tx } from '../../infra/db.service';
import { CryptoService } from '../../infra/crypto';
import { AuditService } from '../audit/audit.service';
import { InstrumentsService } from '../instruments/instruments.service';
import { conflict, notFound, unprocessable } from '../../common/errors';
import type { SessionUser } from '../../common/request-context';

export const LEGACY_COLUMNS = ['legacy_ref', 'firm_name', 'owner_name', 'mobile', 'category_code', 'capacity', 'capacity_unit', 'accuracy_class', 'serial_no', 'make', 'model', 'address', 'ward_code', 'last_verified_on', 'valid_till'] as const;
const MAX_ROWS = 5000; const MAX_REPORT = 500;
interface Problem { row: number; field: string; code: string }
interface Clean { legacyRef: string; firm: string; owner: string; mobile: string; categoryId: string; bandId: string; classId: string; capacity: string; unit: string; serial: string; make: string; model: string | null; address: string; areaId: string; verifiedOn: string; validTill: string }
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

@Injectable()
export class MigrationService {
  constructor(private db: DbService, private crypto: CryptoService, private audit: AuditService, private inst: InstrumentsService) {}

  template() { return LEGACY_COLUMNS.join(',') + '\nL-1001,Sharma Stores,R Sharma,9876501234,PLATFORM_SCALE,50,kg,III,SN-1,Acme,PS-50,"12 Market Road",WARD-01,2025-04-01,2026-03-31\n'; }

  /** Dry run: reads the file, checks every row, stores the clean rows (encrypted) and a report. Nothing is created yet. */
  async validate(admin: SessionUser, filename: string, buf: Buffer, now = new Date()) {
    let recs: Record<string, string>[];
    try { recs = parseCsv(buf, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: false }); }
    catch { throw unprocessable('CSV_UNREADABLE'); }
    if (!recs.length) throw unprocessable('CSV_EMPTY'); if (recs.length > MAX_ROWS) throw unprocessable('TOO_MANY_ROWS', { max: MAX_ROWS });
    const head = Object.keys(recs[0]!); const missing = LEGACY_COLUMNS.filter((c) => !head.includes(c)); if (missing.length) throw unprocessable('MISSING_COLUMNS', { columns: missing });
    const today = istDay(now); const problems: Problem[] = []; const good: Clean[] = []; const seenRef = new Set<string>(); const seenKey = new Set<string>();
    await this.db.system(async (tx) => {
      const cats = new Map((await tx.query(`SELECT id, code FROM categories WHERE status='ACTIVE'`)).rows.map((r) => [String(r.code).toUpperCase(), r.id as string]));
      const cls = new Map((await tx.query('SELECT id, code FROM accuracy_classes')).rows.map((r) => [String(r.code).toUpperCase(), r.id as string]));
      const wards = new Map((await tx.query(`SELECT id, code FROM areas WHERE level='WARD' AND status='ACTIVE'`)).rows.map((r) => [String(r.code).toUpperCase(), r.id as string]));
      const refs = new Set((await tx.query('SELECT legacy_ref FROM instruments WHERE legacy_ref IS NOT NULL')).rows.map((r) => r.legacy_ref as string));
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i]!; const n = i + 2; const bad = (field: string, code: string) => problems.push({ row: n, field, code }); const before = problems.length;
        for (const f of ['legacy_ref', 'firm_name', 'owner_name', 'serial_no', 'make', 'address'] as const) if (!r[f]) bad(f, 'REQUIRED');
        if (r.legacy_ref) { if (r.legacy_ref.length > 40) bad('legacy_ref', 'TOO_LONG'); else if (seenRef.has(r.legacy_ref)) bad('legacy_ref', 'DUPLICATE_IN_FILE'); else if (refs.has(r.legacy_ref)) bad('legacy_ref', 'ALREADY_IMPORTED'); seenRef.add(r.legacy_ref); }
        if (!/^[6-9]\d{9}$/.test(r.mobile ?? '')) bad('mobile', 'INVALID_MOBILE');
        if (r.address && r.address.length < 5) bad('address', 'TOO_SHORT');
        const categoryId = cats.get((r.category_code ?? '').toUpperCase()); if (!categoryId) bad('category_code', 'UNKNOWN_CATEGORY');
        const classId = cls.get((r.accuracy_class ?? '').toUpperCase()); if (!classId) bad('accuracy_class', 'UNKNOWN_CLASS');
        const areaId = wards.get((r.ward_code ?? '').toUpperCase()); if (!areaId) bad('ward_code', 'UNKNOWN_WARD');
        if (!/^\d{1,12}(\.\d{1,4})?$/.test(r.capacity ?? '') || Number(r.capacity) <= 0) bad('capacity', 'INVALID_CAPACITY');
        if (!isDate(r.last_verified_on ?? '')) bad('last_verified_on', 'INVALID_DATE'); else if (r.last_verified_on! > today) bad('last_verified_on', 'IN_FUTURE');
        if (!isDate(r.valid_till ?? '')) bad('valid_till', 'INVALID_DATE'); else if (isDate(r.last_verified_on ?? '') && r.valid_till! <= r.last_verified_on!) bad('valid_till', 'BEFORE_VERIFICATION');
        let bandId: string | undefined;
        if (categoryId && classId && areaId && /^\d{1,12}(\.\d{1,4})?$/.test(r.capacity ?? '') && r.capacity_unit) {
          bandId = (await tx.query('SELECT id FROM capacity_bands WHERE category_id=$1 AND lower(unit)=lower($2) AND $3::numeric BETWEEN min_capacity AND max_capacity ORDER BY min_capacity LIMIT 1', [categoryId, r.capacity_unit, r.capacity])).rows[0]?.id as string | undefined;
          if (!bandId) bad('capacity', 'NO_MATCHING_BAND');
        } else if (!r.capacity_unit) bad('capacity_unit', 'REQUIRED');
        if (categoryId && r.serial_no && r.make) {
          const k = `${r.serial_no.toLowerCase()}|${r.make.toLowerCase()}|${categoryId}`;
          if (seenKey.has(k)) bad('serial_no', 'DUPLICATE_IN_FILE');
          else if (await this.inst.isDuplicate(r.serial_no, r.make, categoryId)) bad('serial_no', 'ALREADY_REGISTERED');
          seenKey.add(k);
        }
        if (problems.length === before && categoryId && classId && areaId && bandId)
          good.push({ legacyRef: r.legacy_ref!, firm: r.firm_name!, owner: r.owner_name!, mobile: r.mobile!, categoryId, bandId, classId, capacity: r.capacity!, unit: r.capacity_unit!, serial: r.serial_no!, make: r.make!, model: r.model || null, address: r.address!, areaId, verifiedOn: r.last_verified_on!, validTill: r.valid_till! });
      }
    });
    const byCode: Record<string, number> = {}; for (const p of problems) byCode[`${p.field}:${p.code}`] = (byCode[`${p.field}:${p.code}`] ?? 0) + 1;
    const invalidRows = new Set(problems.map((p) => p.row)).size;
    const id = await this.db.system(async (tx) => {
      const r = (await tx.query(`INSERT INTO migration_jobs (created_by, filename, total, valid, invalid, report, rows_enc) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
        [admin.userId, filename.slice(0, 120), recs.length, good.length, invalidRows, JSON.stringify(problems.slice(0, MAX_REPORT)), good.length ? this.crypto.encJson(good) : null])).rows[0].id as string;
      await this.audit.record(tx, { action: 'migration.validated', entityType: 'migration_job', entityId: r, details: { total: recs.length, valid: good.length, invalid: invalidRows } });
      return r;
    });
    return { id, total: recs.length, valid: good.length, invalid: invalidRows, problemsByKind: byCode, problems: problems.slice(0, 50), moreProblems: Math.max(0, problems.length - 50), canCommit: good.length > 0 };
  }

  async list() {
    const rows = await this.db.forUser(async (tx) => (await tx.query('SELECT id, filename, status, total, valid, invalid, result, created_at, committed_at FROM migration_jobs ORDER BY created_at DESC LIMIT 50')).rows);
    return { items: rows.map((r) => ({ id: r.id as string, filename: r.filename as string, status: r.status as string, total: r.total as number, valid: r.valid as number, invalid: r.invalid as number, result: r.result as Record<string, unknown> | null, createdAt: r.created_at as Date, committedAt: r.committed_at as Date | null })) };
  }
  async errorsCsv(id: string) {
    const r = await this.db.forUser(async (tx) => (await tx.query('SELECT report FROM migration_jobs WHERE id=$1', [id])).rows[0]); if (!r) throw notFound();
    return 'row,field,problem\n' + (r.report as Problem[]).map((p) => `${p.row},${p.field},${p.code}`).join('\n') + '\n';
  }
  async discard(admin: SessionUser, id: string) {
    return this.db.forUser(async (tx) => {
      const r = await tx.query(`UPDATE migration_jobs SET status='DISCARDED', rows_enc=NULL WHERE id=$1 AND status='VALIDATED' RETURNING id`, [id]);
      if (!r.rowCount) throw conflict('CANNOT_DISCARD'); await this.audit.record(tx, { action: 'migration.discarded', entityType: 'migration_job', entityId: id }); return { ok: true };
    });
  }

  /** Creates the instruments (and owner shells for unknown mobiles) in one transaction: all rows or none. */
  async commit(admin: SessionUser, id: string, now = new Date()) {
    return this.db.system(async (tx) => {
      const j = (await tx.query('SELECT id, status, rows_enc FROM migration_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!j) throw notFound();
      if (j.status !== 'VALIDATED' || !j.rows_enc) throw conflict('NOT_READY');
      const rows = this.crypto.decJson<Clean[]>(j.rows_enc); const today = istDay(now);
      let created = 0; let newOwners = 0; let existingOwners = 0; const skipped: { legacyRef: string; code: string }[] = []; const shells = new Map<string, { business: string; area: string }>();
      for (const r of rows) {
        const owner = await this.ownerFor(tx, r, id, shells, () => newOwners++, () => existingOwners++);
        if (!owner) { skipped.push({ legacyRef: r.legacyRef, code: 'OWNER_HAS_NO_BUSINESS' }); continue; }
        if (await this.dupe(tx, r)) { skipped.push({ legacyRef: r.legacyRef, code: 'ALREADY_REGISTERED' }); continue; }
        const ins = await this.inst.insert(tx, { categoryId: r.categoryId, capacityBandId: r.bandId, accuracyClassId: r.classId, capacity: r.capacity, capacityUnit: r.unit, serialNo: r.serial, make: r.make, model: r.model ?? undefined,
          location: { address: r.address, areaId: r.areaId }, ownership: { mode: 'SELF' } } as never, owner.business, owner.area, admin.userId);
        const status = r.validTill >= today ? 'ACTIVE' : 'EXPIRED';
        await tx.query(`UPDATE instruments SET status=$2::instrument_status, first_verified_at=$3::date, legacy_ref=$4, legacy_valid_till=$5, migration_job_id=$6 WHERE id=$1`, [ins.id, status, r.verifiedOn, r.legacyRef, r.validTill, id]);
        created++;
      }
      const result = { instruments: created, newOwnerAccounts: newOwners, existingOwners, skipped: skipped.length, skippedRows: skipped.slice(0, 100) };
      await tx.query(`UPDATE migration_jobs SET status='COMMITTED', rows_enc=NULL, result=$2::jsonb, committed_at=now() WHERE id=$1`, [id, JSON.stringify(result)]);
      await this.audit.record(tx, { action: 'migration.committed', entityType: 'migration_job', entityId: id, details: { instruments: created, newOwners, skipped: skipped.length } });
      return result;
    });
  }
  private async dupe(tx: Tx, r: Clean) {
    return ((await tx.query(`SELECT 1 FROM instruments WHERE (lower(serial_no)=lower($1) AND lower(make)=lower($2) AND category_id=$3 AND status<>'DEREGISTERED' AND duplicate_override_by IS NULL) OR legacy_ref=$4`, [r.serial, r.make, r.categoryId, r.legacyRef])).rowCount ?? 0) > 0;
  }
  /** The owner's business for a mobile: an existing account's own business, or a new INVITED shell the real owner can claim by registering with that number. */
  private async ownerFor(tx: Tx, r: Clean, jobId: string, shells: Map<string, { business: string; area: string }>, onNew: () => void, onOld: () => void) {
    const c = this.crypto; const hit = shells.get(r.mobile); if (hit) return hit;
    const u = (await tx.query('SELECT id FROM users WHERE mobile_bidx = ANY($1::bytea[])', [c.blindIndexAll('mobile', r.mobile)])).rows[0] as { id: string } | undefined;
    if (u) {
      const b = (await tx.query('SELECT id, area_id FROM businesses WHERE owner_user_id=$1 AND is_managed_customer=false ORDER BY created_at LIMIT 1', [u.id])).rows[0] as { id: string; area_id: string } | undefined;
      if (!b) return null; onOld(); const v = { business: b.id, area: b.area_id }; shells.set(r.mobile, v); return v;
    }
    const uid = randomUUID();
    await tx.query(`INSERT INTO users (id, keycloak_sub, account_status, mobile_enc, mobile_bidx, display_name_masked, legacy_import_id) VALUES ($1,$2,'INVITED',$3,$4,$5,$6)`, [uid, `local:${uid}`, c.encrypt(r.mobile), c.blindIndex('mobile', r.mobile), maskFirm(r.owner), jobId]);
    await tx.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code='OWNER'`, [uid]);
    await tx.query('INSERT INTO user_profiles (user_id, full_name_enc) VALUES ($1,$2)', [uid, c.encrypt(r.owner)]);
    const b = (await tx.query(`INSERT INTO businesses (owner_user_id, type, firm_name_enc, firm_name_masked, area_id) VALUES ($1,'OWNER',$2,$3,$4) RETURNING id`, [uid, c.encrypt(r.firm), maskFirm(r.firm), r.areaId])).rows[0].id as string;
    onNew(); const v = { business: b, area: r.areaId }; shells.set(r.mobile, v); return v;
  }
}
