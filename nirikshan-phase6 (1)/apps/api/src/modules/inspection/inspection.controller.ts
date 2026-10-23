import { Body, Controller, Get, HttpCode, Param, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { arriveSchema, computeTrialsSchema, evidenceMetaSchema, inspectionDraftSchema, submitInspectionSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RateLimit, RequirePermission, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { unprocessable } from '../../common/errors';
import { InspectionService } from './inspection.service';

@ApiTags('inspection')
@Controller()
export class InspectionController {
  constructor(private svc: InspectionService) {}
  private u() { return ctx()!.user!; }

  @Roles('INSPECTOR') @Get('inspector/visits') mine() { return this.svc.myVisits(this.u()); }
  @Roles('INSPECTOR') @Get('inspector/history') history() { return this.svc.history(this.u()); }
  @Roles('INSPECTOR') @Get('inspector/visits/:id') detail(@Param('id') id: string) { return this.svc.detail(this.u(), parse(uuid, id)); }

  @Roles('INSPECTOR') @HttpCode(200) @Idempotent() @Post('inspector/visits/:id/arrive')
  arrive(@Param('id') id: string, @Body() body: unknown) { return this.svc.arrive(this.u(), parse(uuid, id), parse(arriveSchema, body)); }

  @Roles('INSPECTOR') @HttpCode(200) @RateLimit({ name: 'trial-compute', limit: 600, windowSec: 600, by: 'user' }) @Post('inspector/visits/:id/trials/compute')
  compute(@Param('id') id: string, @Body() body: unknown) { return this.svc.computeTrials(this.u(), parse(uuid, id), parse(computeTrialsSchema, body).trials); }

  @Roles('INSPECTOR') @RateLimit({ name: 'draft-save', limit: 900, windowSec: 600, by: 'user' }) @Put('inspector/visits/:id/draft')
  draft(@Param('id') id: string, @Body() body: unknown) { return this.svc.saveDraft(this.u(), parse(uuid, id), parse(inspectionDraftSchema, body)); }

  @Roles('INSPECTOR') @RateLimit({ name: 'evidence-upload', limit: 120, windowSec: 3600, by: 'user' }) @Post('inspector/visits/:id/evidence')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 6 * 1024 * 1024, files: 1 } }))
  evidence(@Param('id') id: string, @Body() body: unknown, @UploadedFile() f: Express.Multer.File | undefined) {
    if (!f) throw unprocessable('FILE_REQUIRED');
    const m = parse(evidenceMetaSchema, body); return this.svc.uploadEvidence(this.u(), parse(uuid, id), m.kind, { lat: m.lat, lon: m.lon }, f);
  }

  @Roles('INSPECTOR') @HttpCode(200) @Idempotent() @Post('inspector/visits/:id/submit')
  submit(@Param('id') id: string, @Body() body: unknown) { return this.svc.submit(this.u(), parse(uuid, id), parse(submitInspectionSchema, body)); }

  @RequirePermission('visit.work', 'case.review', 'case.read.all') @Get('evidence/:id/link')
  evidenceLink(@Param('id') id: string) { return this.svc.evidenceLink(this.u(), parse(uuid, id)); }
  @RequirePermission('visit.work', 'case.review', 'case.read.all') @Get('visits/:id/test-sheet/link')
  sheetLink(@Param('id') id: string) { return this.svc.testSheetLink(this.u(), parse(uuid, id)); }
}
