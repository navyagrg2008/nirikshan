import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@nirikshan/shared';
import { DbService } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';
import { Public, RateLimit } from '../../common/decorators';
import { parse } from '../../common/zod';

/** Reference data used by forms. Contains no personal data, so it is cached for a minute. */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private db: DbService, private redis: RedisService) {}
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = await this.redis.getJson<T>(`cache:${key}`); if (hit) return hit;
    const v = await load(); await this.redis.setJson(`cache:${key}`, v, 60); return v;
  }
  @Public() @Get('categories') @Header('Cache-Control', 'public, max-age=60')
  categories() {
    return this.cached('categories', () => this.db.system(async (tx) => {
      const cats = (await tx.query(`SELECT id, code, name_en, name_hi, is_automatic FROM categories WHERE status='ACTIVE' ORDER BY name_en`)).rows;
      const subs = (await tx.query('SELECT id, category_id, code, name_en, name_hi FROM sub_categories ORDER BY name_en')).rows;
      const bands = (await tx.query('SELECT id, category_id, min_capacity, max_capacity, unit FROM capacity_bands ORDER BY category_id, min_capacity')).rows;
      const classes = (await tx.query('SELECT id, code, name FROM accuracy_classes ORDER BY code')).rows;
      return {
        accuracyClasses: classes,
        categories: cats.map((c) => ({
          id: c.id, code: c.code, name: c.name_en, nameHi: c.name_hi, automatic: c.is_automatic,
          subCategories: subs.filter((s) => s.category_id === c.id).map((s) => ({ id: s.id, code: s.code, name: s.name_en, nameHi: s.name_hi })),
          capacityBands: bands.filter((b) => b.category_id === c.id).map((b) => ({ id: b.id, min: b.min_capacity, max: b.max_capacity, unit: b.unit })),
        })),
      };
    }));
  }
  @Public() @Get('areas') @Header('Cache-Control', 'public, max-age=60')
  areas() {
    return this.cached('areas', () => this.db.system(async (tx) =>
      (await tx.query(`SELECT id, parent_id, level, code, name_en, name_hi FROM areas WHERE status='ACTIVE' ORDER BY level, name_en`)).rows
        .map((a) => ({ id: a.id, parentId: a.parent_id, level: a.level, code: a.code, name: a.name_en, nameHi: a.name_hi }))));
  }
  @Public() @Get('document-types') @Header('Cache-Control', 'public, max-age=60')
  documentTypes() {
    return this.cached('doctypes', () => this.db.system(async (tx) =>
      (await tx.query('SELECT id, code, name_en, name_hi, required_for, max_size_mb FROM document_types ORDER BY name_en')).rows
        .map((d) => ({ id: d.id, code: d.code, name: d.name_en, nameHi: d.name_hi, requiredFor: d.required_for, maxSizeMb: d.max_size_mb }))));
  }
  /** Reason codes for officer decisions and certificate actions. Staff only (the default guard requires a session). */
  @Get('reason-codes')
  reasonCodes(@Query() q: unknown) {
    const b = parse(z.object({ appliesTo: z.enum(['REJECT', 'SUSPEND', 'REVOKE']) }).strict(), q);
    return this.db.system(async (tx) => (await tx.query('SELECT code, text_en, text_hi FROM reason_codes WHERE applies_to=$1 ORDER BY code', [b.appliesTo])).rows
      .map((r) => ({ code: r.code, textEn: r.text_en, textHi: r.text_hi })));
  }
  /** Public MPE lookup for a category and capacity, from the published rule set in force today. */
  @Public() @RateLimit({ name: 'mpe', limit: 120, windowSec: 60 }) @Get('mpe')
  async mpe(@Query() q: unknown) {
    const b = parse(z.object({ category: uuid, capacity: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/) }).strict(), q);
    return this.db.system(async (tx) => (await tx.query(
      `SELECT rs.version, rs.effective_from, m.direction, m.value, m.unit, ac.code AS class_code, cb.min_capacity, cb.max_capacity, cb.unit AS capacity_unit
       FROM rule_sets rs JOIN mpe_rules m ON m.rule_set_id=rs.id JOIN capacity_bands cb ON cb.id=m.capacity_band_id JOIN accuracy_classes ac ON ac.id=m.accuracy_class_id
       WHERE rs.status='PUBLISHED' AND rs.effective_from <= current_date AND (rs.effective_to IS NULL OR rs.effective_to > current_date)
         AND m.category_id=$1 AND $2::numeric BETWEEN cb.min_capacity AND cb.max_capacity ORDER BY ac.code`, [b.category, b.capacity])).rows);
  }
}
