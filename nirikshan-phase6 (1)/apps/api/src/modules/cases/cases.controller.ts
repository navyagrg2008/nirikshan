import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { assignSchema, availabilitySchema, bulkRescheduleSchema, casesQuery, docReviewSchema, noShowSchema, requestDecisionSchema, uuid, visitRescheduleSchema } from '@nirikshan/shared';
import { Idempotent, RequirePermission, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { CasesService } from './cases.service';

const dateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQ = z.object({ from: dateQ, to: dateQ }).strict().refine((v) => v.to >= v.from && Date.parse(v.to) - Date.parse(v.from) <= 62 * 86_400_000, 'INVALID_RANGE');
const dayQ = z.object({ date: dateQ }).strict();

@ApiTags('cases')
@Controller()
export class CasesController {
  constructor(private svc: CasesService) {}
  private u() { return ctx()!.user!; }

  @RequirePermission('case.review') @Get('officer/cases') list(@Query() q: unknown) { return this.svc.list(this.u(), parse(casesQuery, q)); }
  @RequirePermission('case.review') @Get('officer/cases/summary') summary() { return this.svc.summary(this.u()); }
  @RequirePermission('case.review', 'case.read.all') @Get('officer/cases/:id') detail(@Param('id') id: string) { return this.svc.detail(this.u(), parse(uuid, id)); }

  @RequirePermission('case.review') @HttpCode(200) @Post('officer/cases/:id/documents/:docId/review')
  review(@Param('id') id: string, @Param('docId') docId: string, @Body() body: unknown) { return this.svc.reviewDocument(this.u(), parse(uuid, id), parse(uuid, docId), parse(docReviewSchema, body)); }
  @RequirePermission('case.review') @HttpCode(200) @Idempotent() @Post('officer/cases/:id/document-check-complete')
  complete(@Param('id') id: string) { return this.svc.documentCheckComplete(this.u(), parse(uuid, id)); }

  @RequirePermission('schedule.manage') @HttpCode(200) @Post('officer/cases/:id/schedule') rerun(@Param('id') id: string) { return this.svc.rerun(this.u(), parse(uuid, id)); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Idempotent() @Post('officer/cases/:id/assign')
  assign(@Param('id') id: string, @Body() body: unknown) { return this.svc.assign(this.u(), parse(uuid, id), parse(assignSchema, body)); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Idempotent() @Post('officer/cases/:id/proposal/accept')
  accept(@Param('id') id: string) { return this.svc.acceptProposal(this.u(), parse(uuid, id)); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Idempotent() @Post('officer/cases/:id/reschedule')
  reschedule(@Param('id') id: string, @Body() body: unknown) { return this.svc.rescheduleVisit(this.u(), parse(uuid, id), parse(visitRescheduleSchema, body)); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Post('officer/cases/:id/reschedule-request/decision')
  decide(@Param('id') id: string, @Body() body: unknown) { return this.svc.decideRequest(this.u(), parse(uuid, id), parse(requestDecisionSchema, body)); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Idempotent() @Post('officer/cases/:id/no-show')
  noShow(@Param('id') id: string, @Body() body: unknown) { return this.svc.noShow(this.u(), parse(uuid, id), parse(noShowSchema, body ?? {}).note); }

  @RequirePermission('schedule.manage') @Get('officer/schedule') calendar(@Query() q: unknown) { const r = parse(rangeQ, q); return this.svc.calendar(this.u(), r.from, r.to); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Post('officer/schedule/bulk-reschedule/preview')
  bulkPreview(@Body() body: unknown) { const b = parse(bulkRescheduleSchema, body); return this.svc.bulkPreview(this.u(), b); }
  @RequirePermission('schedule.manage') @StepUp() @HttpCode(200) @Idempotent() @Post('officer/schedule/bulk-reschedule')
  bulkCommit(@Body() body: unknown) { return this.svc.bulkCommit(this.u(), parse(bulkRescheduleSchema, body)); }

  @RequirePermission('schedule.manage') @Get('officer/inspectors') inspectors() { return this.svc.inspectors(this.u()); }
  @RequirePermission('schedule.manage') @Post('officer/inspectors/:id/availability')
  addAvail(@Param('id') id: string, @Body() body: unknown) { return this.svc.addAvailability(this.u(), parse(uuid, id), parse(availabilitySchema, body)); }
  @RequirePermission('schedule.manage') @HttpCode(200) @Delete('officer/availability/:id') delAvail(@Param('id') id: string) { return this.svc.removeAvailability(this.u(), parse(uuid, id)); }
  @RequirePermission('schedule.manage') @Get('officer/inspectors/:id/route-sheet')
  route(@Param('id') id: string, @Query() q: unknown) { return this.svc.routeSheet(this.u(), parse(uuid, id), parse(dayQ, q).date); }

}
