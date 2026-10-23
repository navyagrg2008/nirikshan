import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { contactSchema } from '@nirikshan/shared';
import { DbService } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';
import { CryptoService } from '../../infra/crypto';
import { CaptchaService } from '../../infra/providers';
import { Public, RateLimit } from '../../common/decorators';
import { parse } from '../../common/zod';
import { AppError } from '../../common/errors';
import { ctx } from '../../common/request-context';
import { AuditService } from '../audit/audit.service';
import { z } from 'zod';

@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(private db: DbService, private redis: RedisService, private crypto: CryptoService, private captcha: CaptchaService, private audit: AuditService) {}

  /** Aggregate counts only, cached for 5 minutes. */
  @Public() @Get('stats')
  async stats() {
    const hit = await this.redis.getJson<object>('cache:public-stats'); if (hit) return hit;
    const v = await this.db.system(async (tx) => {
      const reg = await tx.query(`SELECT count(*)::int AS n FROM instruments WHERE status <> 'DEREGISTERED'`);
      const ver = await tx.query(`SELECT count(*)::int AS n FROM instruments WHERE first_verified_at IS NOT NULL`);
      const div = await tx.query(`WITH RECURSIVE up AS (SELECT i.area_id AS id, a.parent_id, a.level FROM instruments i JOIN areas a ON a.id=i.area_id
          UNION ALL SELECT a.id, a.parent_id, a.level FROM areas a JOIN up ON a.id = up.parent_id) SELECT count(DISTINCT id)::int AS n FROM up WHERE level='DIVISION'`);
      return { instrumentsRegistered: reg.rows[0].n as number, instrumentsVerified: ver.rows[0].n as number, divisionsCovered: div.rows[0].n as number, asOf: new Date().toISOString() };
    });
    await this.redis.setJson('cache:public-stats', v, 300); return v;
  }

  @Public() @Get('notices')
  async notices(@Query('limit') limit?: string) {
    const n = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.db.system(async (tx) => (await tx.query(
      'SELECT id, title_en, title_hi, tag, published_at FROM notices WHERE published_at IS NOT NULL AND published_at <= now() ORDER BY published_at DESC LIMIT $1', [n])).rows
      .map((r) => ({ id: r.id, title: r.title_en, titleHi: r.title_hi, tag: r.tag, publishedAt: r.published_at })));
  }

  /** Published rules in force today: MPE and verification intervals. */
  @Public() @Get('rules')
  async rules() {
    return this.db.system(async (tx) => {
      const rs = (await tx.query(`SELECT id, version, effective_from, effective_to FROM rule_sets WHERE status='PUBLISHED' AND effective_from <= current_date AND (effective_to IS NULL OR effective_to > current_date) LIMIT 1`)).rows[0];
      if (!rs) return { ruleSet: null, mpe: [], intervals: [] };
      const mpe = (await tx.query(
        `SELECT c.name_en AS category, c.name_hi AS category_hi, cb.min_capacity, cb.max_capacity, cb.unit AS capacity_unit, ac.code AS class_code, m.direction, m.value, m.unit
         FROM mpe_rules m JOIN categories c ON c.id=m.category_id JOIN capacity_bands cb ON cb.id=m.capacity_band_id JOIN accuracy_classes ac ON ac.id=m.accuracy_class_id
         WHERE m.rule_set_id=$1 ORDER BY c.name_en, cb.min_capacity, ac.code`, [rs.id])).rows;
      const intervals = (await tx.query(
        `SELECT c.name_en AS category, c.name_hi AS category_hi, cb.min_capacity, cb.max_capacity, cb.unit AS capacity_unit, i.months, i.marginal_months, i.grace_days
         FROM interval_rules i JOIN categories c ON c.id=i.category_id JOIN capacity_bands cb ON cb.id=i.capacity_band_id WHERE i.rule_set_id=$1 ORDER BY c.name_en, cb.min_capacity`, [rs.id])).rows;
      return { ruleSet: { version: rs.version, effectiveFrom: rs.effective_from, effectiveTo: rs.effective_to }, mpe, intervals };
    });
  }

  @Public() @HttpCode(201) @RateLimit({ name: 'contact', limit: 5, windowSec: 3600 }) @Post('contact')
  async contact(@Body() body: unknown) {
    const b = parse(contactSchema, body);
    if (!(await this.captcha.verify(b.captchaToken, ctx()?.ip ?? ''))) throw new AppError(403, 'CAPTCHA_REQUIRED');
    await this.db.system(async (tx) => {
      await tx.query('INSERT INTO contact_messages (name_enc, contact_enc, message_enc, ip_hash) VALUES ($1,$2,$3,$4)',
        [this.crypto.encrypt(b.name), this.crypto.encrypt(b.contact), this.crypto.encrypt(b.message), ctx()?.ipHash ?? null]);
      await this.audit.record(tx, { action: 'public.contact_received' });
    });
    return { ok: true };
  }
}
void z;
