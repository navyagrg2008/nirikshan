import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ruleCreateSchema, ruleDraftSchema, ruleReviewSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RequirePermission, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { RulesService } from './rules.service';

@ApiTags('admin-rules')
@Controller('admin/rules')
export class RulesController {
  constructor(private svc: RulesService) {}
  private u() { return ctx()!.user!; }
  @RequirePermission('rules.write') @Get() list() { return this.svc.list(); }
  @RequirePermission('rules.write') @Get(':id') detail(@Param('id') id: string, @Query('against') against?: string) { return this.svc.detail(this.u(), parse(uuid, id), against ? parse(uuid, against) : undefined); }
  @RequirePermission('rules.write') @Get(':id/preflight') preflight(@Param('id') id: string) { return this.svc.preflight(this.u(), parse(uuid, id)); }
  @RequirePermission('rules.write') @Idempotent() @Post() create(@Body() body: unknown) { const b = parse(ruleCreateSchema, body); return this.svc.create(this.u(), b.copyFromId, b.effectiveFrom); }
  @RequirePermission('rules.write') @Put(':id/draft') save(@Param('id') id: string, @Body() body: unknown) { return this.svc.saveDraft(this.u(), parse(uuid, id), parse(ruleDraftSchema, body)); }
  @RequirePermission('rules.write') @Delete(':id') discard(@Param('id') id: string) { return this.svc.discard(this.u(), parse(uuid, id)); }
  @RequirePermission('rules.write') @Idempotent() @HttpCode(200) @Post(':id/request-review') request(@Param('id') id: string) { return this.svc.requestReview(this.u(), parse(uuid, id)); }
  @RequirePermission('rules.write') @Idempotent() @HttpCode(200) @Post(':id/review') review(@Param('id') id: string, @Body() body: unknown) { return this.svc.review(this.u(), parse(uuid, id), parse(ruleReviewSchema, body)); }
  @RequirePermission('rules.write') @StepUp() @Idempotent() @HttpCode(200) @Post(':id/publish') publish(@Param('id') id: string) { return this.svc.publish(this.u(), parse(uuid, id)); }
}
void z;
