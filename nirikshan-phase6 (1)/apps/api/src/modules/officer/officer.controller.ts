import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { accountDecisionSchema, uuid } from '@nirikshan/shared';
import { z } from 'zod';
import { RequirePermission, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { OfficerService } from './officer.service';

const decision = z.object({ outcome: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().max(500).optional() }).strict();

@ApiTags('officer')
@Controller('officer')
export class OfficerController {
  constructor(private svc: OfficerService) {}
  private u() { return ctx()!.user!; }
  @RequirePermission('account.approve.area', 'account.approve.all') @Get('accounts') accounts() { return this.svc.pendingAccounts(this.u()); }
  @RequirePermission('account.approve.area', 'account.approve.all') @HttpCode(200) @Post('accounts/:id/decision')
  decide(@Param('id') id: string, @Body() body: unknown) { const b = parse(accountDecisionSchema, body); return this.svc.decideAccount(this.u(), parse(uuid, id), b.outcome, b.reason); }
  @RequirePermission('account.approve.area', 'account.approve.all') @Get('accounts/:id/documents/:docId/link')
  link(@Param('id') id: string, @Param('docId') docId: string) { return this.svc.documentLink(this.u(), parse(uuid, id), parse(uuid, docId)); }

  @RequirePermission('instrument.duplicate.override') @Get('duplicates') duplicates() { return this.svc.duplicates(this.u()); }
  @RequirePermission('instrument.duplicate.override') @HttpCode(200) @Post('duplicates/:id/decision')
  dup(@Param('id') id: string, @Body() body: unknown) { const b = parse(decision, body); return this.svc.decideDuplicate(this.u(), parse(uuid, id), b.outcome, b.reason); }
}
void Roles;
