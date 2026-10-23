import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { decimalString, uuid, type MasterEntity } from '@nirikshan/shared';
import { DbService } from '../../infra/db.service';
import { AuditService } from '../audit/audit.service';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { parse } from '../../common/zod';

const code = z.string().trim().regex(/^[A-Z0-9_\-]{2,40}$/, 'INVALID_CODE');
const name = z.string().trim().min(1).max(120);
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
const status = z.enum(['ACTIVE', 'INACTIVE']);

interface Entity { table: string; create: z.ZodObject<any>; update?: z.ZodObject<any>; order: string; deletable?: boolean; versioned?: boolean }
const E: Record<MasterEntity, Entity> = {
  categories: { table: 'categories', order: 'name_en', create: z.object({ code, name_en: name, name_hi: opt(name), is_automatic: z.boolean().default(false), status: status.default('ACTIVE') }).strict() },
  'sub-categories': { table: 'sub_categories', order: 'name_en', create: z.object({ category_id: uuid, code, name_en: name, name_hi: opt(name) }).strict() },
  'accuracy-classes': { table: 'accuracy_classes', order: 'code', create: z.object({ code, name }).strict() },
  'capacity-bands': { table: 'capacity_bands', order: 'category_id, min_capacity', create: z.object({ category_id: uuid, min_capacity: decimalString, max_capacity: decimalString, unit: z.string().trim().min(1).max(10) }).strict() },
  'document-types': { table: 'document_types', order: 'name_en', create: z.object({ code, name_en: name, name_hi: opt(name), required_for: z.array(z.enum(['NEW', 'RE_VERIFICATION', 'RENEWAL', 'RE_TEST'])).default([]), max_size_mb: z.number().int().min(1).max(25).default(10) }).strict() },
  'reason-codes': { table: 'reason_codes', order: 'applies_to, code', create: z.object({ code, applies_to: z.enum(['REJECT', 'REVOKE', 'SUSPEND', 'FLAG_DOCUMENT', 'GEOFENCE', 'RE_INSPECT']), text_en: z.string().trim().min(3).max(300), text_hi: opt(z.string().trim().max(300)), public_safe: z.boolean().default(false) }).strict() },
  holidays: { table: 'holiday_calendar', order: 'holiday_date', deletable: true, create: z.object({ area_id: opt(uuid), holiday_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name }).strict() },
  'notification-templates': { table: 'notification_templates', order: 'event_code, channel, lang, version DESC', versioned: true, create: z.object({ event_code: z.string().regex(/^[A-Z_]{3,60}$/), channel: z.enum(['SMS', 'EMAIL', 'IN_APP']), lang: z.enum(['en', 'hi']), subject: opt(z.string().max(200)), body: z.string().min(3).max(1000) }).strict() },
  areas: { table: 'areas', order: 'level, name_en', create: z.object({ parent_id: opt(uuid), level: z.enum(['DIVISION', 'ZONE', 'CIRCLE', 'WARD']), code: z.string().trim().regex(/^[A-Z0-9_\-]{2,40}$/), name_en: name, name_hi: opt(name), status: status.default('ACTIVE') }).strict() },
};
for (const k of ['categories', 'sub-categories', 'accuracy-classes', 'capacity-bands', 'document-types', 'reason-codes', 'holidays', 'areas'] as const) E[k].update = E[k].create.partial();
const PARENT: Record<string, string | null> = { DIVISION: null, ZONE: 'DIVISION', CIRCLE: 'ZONE', WARD: 'CIRCLE' };

@Injectable()
export class MasterdataService {
  constructor(private db: DbService, private audit: AuditService) {}
  private ent(e: string): Entity { const x = (E as Record<string, Entity>)[e]; if (!x) throw notFound('UNKNOWN_ENTITY'); return x; }

  async list(e: string) { const x = this.ent(e); return this.db.system(async (tx) => (await tx.query(`SELECT * FROM ${x.table} ORDER BY ${x.order}`)).rows); }

  private async checkRules(tx: import('../../infra/db.service').Tx, e: string, d: Record<string, unknown>, selfId?: string) {
    if (e === 'areas' && (d.level !== undefined || d.parent_id !== undefined)) {
      const cur = selfId ? (await tx.query('SELECT level, parent_id FROM areas WHERE id=$1', [selfId])).rows[0] : {};
      const level = (d.level ?? cur.level) as string; const parentId = (d.parent_id !== undefined ? d.parent_id : cur.parent_id) as string | null;
      const need = PARENT[level];
      if (!need) { if (parentId) throw unprocessable('INVALID_HIERARCHY'); }
      else { const p = parentId ? (await tx.query('SELECT level FROM areas WHERE id=$1', [parentId])).rows[0] : null; if (!p || p.level !== need) throw unprocessable('INVALID_HIERARCHY'); }
    }
    if (e === 'capacity-bands') {
      const cur = selfId ? (await tx.query('SELECT * FROM capacity_bands WHERE id=$1', [selfId])).rows[0] : {};
      const cat = d.category_id ?? cur.category_id; const min = d.min_capacity ?? cur.min_capacity; const max = d.max_capacity ?? cur.max_capacity; const unit = d.unit ?? cur.unit;
      if (!(Number(max) > Number(min))) throw unprocessable('INVALID_RANGE');
      const ov = await tx.query(`SELECT 1 FROM capacity_bands WHERE category_id=$1 AND lower(unit)=lower($2) AND ($5::uuid IS NULL OR id<>$5) AND numrange(min_capacity, max_capacity, '[]') && numrange($3::numeric, $4::numeric, '[]')`, [cat, unit, min, max, selfId ?? null]);
      if (ov.rowCount) throw conflict('BAND_OVERLAP');
    }
  }

  async create(e: string, body: unknown) {
    const x = this.ent(e); const d = parse(x.create, body) as Record<string, unknown>;
    return this.db.system(async (tx) => {
      await this.checkRules(tx, e, d);
      if (x.versioned) { const v = await tx.query('SELECT coalesce(max(version),0)+1 AS v FROM notification_templates WHERE event_code=$1 AND channel=$2 AND lang=$3', [d.event_code, d.channel, d.lang]); d.version = v.rows[0].v; }
      const cols = Object.keys(d); const vals = Object.values(d);
      try {
        const r = await tx.query(`INSERT INTO ${x.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
        await this.audit.record(tx, { action: `masterdata.${e}.created`, entityType: e, entityId: r.rows[0].id, details: { fields: cols } });
        return r.rows[0];
      } catch (err) { if ((err as { code?: string }).code === '23505') throw conflict('ALREADY_EXISTS'); if ((err as { code?: string }).code === '23503') throw unprocessable('INVALID_REFERENCE'); throw err; }
    });
  }
  async update(e: string, id: string, body: unknown) {
    const x = this.ent(e); if (!x.update) throw conflict('IMMUTABLE_ENTITY');
    const d = parse(x.update, body) as Record<string, unknown>; const cols = Object.keys(d); if (!cols.length) throw unprocessable('NOTHING_TO_UPDATE');
    return this.db.system(async (tx) => {
      const ex = await tx.query(`SELECT 1 FROM ${x.table} WHERE id=$1`, [id]); if (!ex.rowCount) throw notFound();
      await this.checkRules(tx, e, d, id);
      const bump = e === 'areas' ? ', version=version+1, updated_at=now()' : '';
      try {
        const r = await tx.query(`UPDATE ${x.table} SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(',')}${bump} WHERE id=$1 RETURNING *`, [id, ...Object.values(d)]);
        await this.audit.record(tx, { action: `masterdata.${e}.updated`, entityType: e, entityId: id, details: { fields: cols } });
        return r.rows[0];
      } catch (err) { if ((err as { code?: string }).code === '23505') throw conflict('ALREADY_EXISTS'); if ((err as { code?: string }).code === '23503') throw unprocessable('INVALID_REFERENCE'); throw err; }
    });
  }
  async remove(e: string, id: string) {
    const x = this.ent(e); if (!x.deletable) throw conflict('DELETE_NOT_ALLOWED');
    await this.db.system(async (tx) => {
      const r = await tx.query(`DELETE FROM ${x.table} WHERE id=$1`, [id]); if (!r.rowCount) throw notFound();
      await this.audit.record(tx, { action: `masterdata.${e}.deleted`, entityType: e, entityId: id });
    });
    return { ok: true };
  }
}
