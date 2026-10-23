import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { driveCreateSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RequirePermission } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { EnforcementService } from './enforcement.service';

const expiredQ = z.object({ areaId: uuid.optional(), minDaysOverdue: z.coerce.number().int().min(0).max(3650).optional() }).strict();

@ApiTags('enforcement')
@Controller('officer/enforcement')
export class EnforcementController {
  constructor(private svc: EnforcementService) {}
  private u() { return ctx()!.user!; }
  @RequirePermission('enforcement.manage') @Get('expired') expired(@Query() q: unknown) { return this.svc.expired(this.u(), parse(expiredQ, q)); }
  @RequirePermission('enforcement.manage') @Get('drives') drives() { return this.svc.drives(this.u()); }
  @RequirePermission('enforcement.manage') @Idempotent() @Post('drives') create(@Body() body: unknown) { return this.svc.createDrive(this.u(), parse(driveCreateSchema, body)); }
  @RequirePermission('enforcement.manage') @Get('drives/:id') drive(@Param('id') id: string) { return this.svc.drive(this.u(), parse(uuid, id)); }
  @RequirePermission('enforcement.manage') @Idempotent() @HttpCode(200) @Post('drives/:id/notices') send(@Param('id') id: string) { return this.svc.sendNotices(this.u(), parse(uuid, id)); }
  @RequirePermission('enforcement.manage') @Header('Content-Type', 'application/pdf') @Header('Content-Disposition', 'attachment; filename="notices.pdf"') @Header('Cache-Control', 'no-store') @Get('drives/:id/notices.pdf')
  async pdf(@Param('id') id: string) { return new StreamableFile(await this.svc.lettersPdf(this.u(), parse(uuid, id))); }
  @RequirePermission('enforcement.manage') @Idempotent() @HttpCode(200) @Post('drives/:id/escalate') escalate(@Param('id') id: string, @Body() body: unknown) { return this.svc.escalate(this.u(), parse(uuid, id), parse(z.object({ instrumentId: uuid }).strict(), body).instrumentId); }
  @RequirePermission('enforcement.manage') @Idempotent() @HttpCode(200) @Post('drives/:id/close') close(@Param('id') id: string) { return this.svc.close(this.u(), parse(uuid, id)); }
}
void ({} as typeof Res);
