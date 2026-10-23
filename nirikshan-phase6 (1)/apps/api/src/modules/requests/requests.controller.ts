import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { instrumentRequestDecisionSchema, requestCreateSchema, serviceJobAdvanceSchema, serviceJobCreateSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RateLimit, RequirePermission, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { RequestsService } from './requests.service';

const queueQuery = z.object({ kind: z.enum(['TRANSFER', 'ADDRESS_CHANGE', 'DEREGISTER']).optional(), status: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'CLOSED']).optional() }).strict();

@ApiTags('requests')
@Controller()
export class RequestsController {
  constructor(private svc: RequestsService) {}
  private u() { return ctx()!.user!; }

  // owner
  @Roles('OWNER', 'TRADER') @Idempotent() @RateLimit({ name: 'instrument-request', limit: 30, windowSec: 3600, by: 'user' }) @Post('instruments/:id/requests')
  create(@Param('id') id: string, @Body() body: unknown) { return this.svc.create(this.u(), parse(uuid, id), parse(requestCreateSchema, body)); }
  @Roles('OWNER', 'TRADER') @Get('instruments/:id/requests') list(@Param('id') id: string) { return this.svc.listForInstrument(this.u(), parse(uuid, id)); }
  @Roles('OWNER', 'TRADER') @HttpCode(200) @Post('requests/:id/withdraw') withdraw(@Param('id') id: string) { return this.svc.withdraw(this.u(), parse(uuid, id)); }
  @RequirePermission('instrument.read.own', 'instrument.read.area', 'instrument.read.all') @Get('instruments/:id/history') history(@Param('id') id: string) { return this.svc.history(this.u(), parse(uuid, id)); }

  // officer
  @RequirePermission('request.review') @Get('officer/requests') queue(@Query() q: unknown) { return this.svc.queue(this.u(), parse(queueQuery, q)); }
  @RequirePermission('request.review') @Get('officer/requests/:id') detail(@Param('id') id: string) { return this.svc.detail(this.u(), parse(uuid, id)); }
  @RequirePermission('request.review') @Idempotent() @HttpCode(200) @Post('officer/requests/:id/decision')
  decide(@Param('id') id: string, @Body() body: unknown) { return this.svc.decide(this.u(), parse(uuid, id), parse(instrumentRequestDecisionSchema, body)); }

  // repair jobs
  @Roles('TRADER') @Get('service-jobs') jobs() { return this.svc.jobs(this.u()); }
  @Roles('TRADER') @Idempotent() @Post('service-jobs') createJob(@Body() body: unknown) { return this.svc.createJob(this.u(), parse(serviceJobCreateSchema, body)); }
  @Roles('TRADER') @Idempotent() @HttpCode(200) @Post('service-jobs/:id/advance') advance(@Param('id') id: string, @Body() body: unknown) { return this.svc.advanceJob(this.u(), parse(uuid, id), parse(serviceJobAdvanceSchema, body)); }
}
