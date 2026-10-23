import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { breachUpdateSchema, dsrCreateSchema, dsrResolveSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RateLimit, RequirePermission, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { PrivacyService } from './privacy.service';

const statusQ = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED', 'REJECTED', 'ACTIVE', 'ALL']).default('ACTIVE') }).strict();

@ApiTags('privacy')
@Controller()
export class PrivacyController {
  constructor(private svc: PrivacyService) {}
  private u() { return ctx()!.user!; }
  @RequirePermission('data.request.own') @Idempotent() @RateLimit({ name: 'dsr', limit: 10, windowSec: 86400, by: 'user' }) @Post('me/data-requests') create(@Body() body: unknown) { return this.svc.create(this.u(), parse(dsrCreateSchema, body)); }
  @RequirePermission('data.request.own') @Get('me/data-requests') mine() { return this.svc.mine(this.u()); }
  @RequirePermission('data.request.own') @Get('me/data-requests/:id/download') download(@Param('id') id: string) { return this.svc.download(this.u(), parse(uuid, id)); }

  @RequirePermission('privacy.manage') @Get('admin/privacy/requests') list(@Query() q: unknown) { return this.svc.list(parse(statusQ, q).status); }
  @RequirePermission('privacy.manage') @StepUp() @Idempotent() @HttpCode(200) @Post('admin/privacy/requests/:id/resolve') resolve(@Param('id') id: string, @Body() body: unknown) { return this.svc.resolve(this.u(), parse(uuid, id), parse(dsrResolveSchema, body)); }
  @RequirePermission('privacy.manage') @Get('admin/privacy/consents') consents(@Query('mobile') mobile?: string) { return this.svc.consents(mobile ? parse(z.string().regex(/^[6-9]\d{9}$/), mobile) : undefined); }
  @RequirePermission('privacy.manage') @Get('admin/privacy/retention') retention() { return this.svc.retention(); }
  @RequirePermission('privacy.manage') @Get('admin/privacy/breach') breach() { return this.svc.breach(); }
  @RequirePermission('privacy.manage') @Put('admin/privacy/breach') breachSet(@Body() body: unknown) { const b = parse(breachUpdateSchema, body); return this.svc.breachSet(this.u(), b.step, b.done); }
  @RequirePermission('privacy.manage') @Delete('admin/privacy/breach') breachReset() { return this.svc.breachReset(this.u()); }
}
