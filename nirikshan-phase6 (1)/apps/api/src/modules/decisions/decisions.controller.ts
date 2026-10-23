import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { decisionSchema, reinspectSchema, secondApprovalSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RequirePermission, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { DecisionsService } from './decisions.service';

@ApiTags('decisions')
@Controller()
export class DecisionsController {
  constructor(private svc: DecisionsService) {}
  private u() { return ctx()!.user!; }

  @RequirePermission('decision.make') @Get('officer/decisions') pending() { return this.svc.pending(this.u()); }
  @RequirePermission('case.review', 'case.read.all') @Get('officer/cases/:id/inspection') inspection(@Param('id') id: string) { return this.svc.caseInspection(this.u(), parse(uuid, id)); }

  @RequirePermission('decision.make') @StepUp() @HttpCode(200) @Idempotent() @Post('decisions')
  decide(@Body() body: unknown) { return this.svc.decide(this.u(), parse(decisionSchema, body)); }
  @RequirePermission('decision.make') @StepUp() @HttpCode(200) @Idempotent() @Post('decisions/:id/second-approval')
  second(@Param('id') id: string, @Body() body: unknown) { return this.svc.secondApproval(this.u(), parse(uuid, id), parse(secondApprovalSchema, body)); }
  @RequirePermission('decision.make') @HttpCode(200) @Idempotent() @Post('officer/cases/:id/reinspect')
  reinspect(@Param('id') id: string, @Body() body: unknown) { return this.svc.reinspect(this.u(), parse(uuid, id), parse(reinspectSchema, body).remarks); }
}
