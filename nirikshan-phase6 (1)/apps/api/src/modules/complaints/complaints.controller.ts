import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { grievanceCreateSchema, grievanceRespondSchema, publicSearchSchema, tamperReportSchema, tamperResolveSchema, uuid } from '@nirikshan/shared';
import { Idempotent, Public, RateLimit, RequirePermission, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { ComplaintsService } from './complaints.service';

const statusQ = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED', 'ACTIVE', 'ALL']).default('ACTIVE') }).strict();

@ApiTags('complaints')
@Controller()
export class ComplaintsController {
  constructor(private svc: ComplaintsService) {}
  private u() { return ctx()!.user!; }

  @RequirePermission('grievance.raise') @Idempotent() @RateLimit({ name: 'grievance', limit: 10, windowSec: 86400, by: 'user' }) @Post('grievances')
  raise(@Body() body: unknown) { return this.svc.raise(this.u(), parse(grievanceCreateSchema, body)); }
  @RequirePermission('grievance.raise') @Get('grievances') mine() { return this.svc.mine(this.u()); }
  @RequirePermission('complaint.handle') @Get('officer/grievances') gq(@Query() q: unknown) { return this.svc.grievanceQueue(this.u(), parse(statusQ, q).status); }
  @RequirePermission('complaint.handle') @Idempotent() @HttpCode(200) @Post('officer/grievances/:id/respond') respond(@Param('id') id: string, @Body() body: unknown) { return this.svc.respond(this.u(), parse(uuid, id), parse(grievanceRespondSchema, body)); }

  @Public() @HttpCode(201) @RateLimit({ name: 'tamper', limit: 5, windowSec: 3600 }) @Post('public/tamper-reports')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  tamper(@Body() body: unknown, @UploadedFile() f: Express.Multer.File | undefined) { return this.svc.reportTamper(parse(tamperReportSchema, body), f?.buffer); }
  @Public() @RateLimit({ name: 'tamper-status', limit: 30, windowSec: 3600 }) @Get('public/tamper-reports/:ref') tstatus(@Param('ref') ref: string) { return this.svc.tamperStatus(parse(z.string().regex(/^TMP-\d{4}-\d{5}$/i), ref)); }
  @RequirePermission('complaint.handle') @Get('officer/tamper-reports') tq(@Query() q: unknown) { return this.svc.tamperQueue(this.u(), parse(statusQ, q).status); }
  @RequirePermission('complaint.handle') @Idempotent() @HttpCode(200) @Post('officer/tamper-reports/:id/resolve') tres(@Param('id') id: string, @Body() body: unknown) { return this.svc.tamperResolve(this.u(), parse(uuid, id), parse(tamperResolveSchema, body)); }

  @Public() @RateLimit({ name: 'public-search', limit: 60, windowSec: 3600 }) @Get('public/search') search(@Query() q: unknown) { return this.svc.search(parse(publicSearchSchema, q)); }
}
void Roles;
