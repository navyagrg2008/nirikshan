import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { settingKeySchema, settingSchemas } from '@nirikshan/shared';
import { Idempotent, Public, RequirePermission, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { notFound } from '../../common/errors';
import { RedisService } from '../../infra/redis.service';
import { JobsService } from '../jobs/jobs.service';
import { SettingsService } from './settings.service';

@ApiTags('system')
@Controller()
export class SystemController {
  constructor(private settings: SettingsService, private jobs: JobsService, private redis: RedisService) {}
  private u() { return ctx()!.user!; }

  /** Everything the public pages need to know about the system: the maintenance banner and which public features are on. */
  @Public() @Get('public/system')
  async pub() {
    const hit = await this.redis.getJson<object>('cache:public-system'); if (hit) return hit;
    const [m, f] = await Promise.all([this.settings.get('maintenance'), this.settings.get('flags')]);
    const v = { maintenance: m.enabled ? m : null, flags: { publicSearch: f.publicSearch, tamperReports: f.tamperReports } };
    await this.redis.setJson('cache:public-system', v, 15); return v;
  }

  @RequirePermission('system.manage') @Get('admin/system')
  async all() { return { settings: await this.settings.all(), jobs: await this.jobs.monitor() }; }

  @RequirePermission('system.manage') @StepUp() @Put('admin/system/settings/:key')
  async set(@Param('key') key: string, @Body() body: unknown) {
    const k = parse(settingKeySchema, key); const v: unknown = parse(settingSchemas[k] as import('zod').ZodType, body);
    const out = await this.settings.set(this.u(), k, v); await this.redis.client.del('cache:public-system'); return out;
  }

  @RequirePermission('system.manage') @Get('admin/system/jobs') monitor() { return this.jobs.monitor(); }
  @RequirePermission('system.manage') @StepUp() @HttpCode(200) @Idempotent() @Post('admin/system/jobs/:name/run')
  async run(@Param('name') name: string) { if (!this.jobs.has(name)) throw notFound(); return this.jobs.run(name, { trigger: 'MANUAL', userId: this.u().userId }); }
}
