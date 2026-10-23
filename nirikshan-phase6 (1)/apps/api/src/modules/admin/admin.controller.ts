import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { inviteCreateSchema, masterEntities, uuid, userStatusSchema } from '@nirikshan/shared';
import { Idempotent, RequirePermission, Roles, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { AdminService } from './admin.service';
import { MasterdataService } from './masterdata.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';

const ent = z.enum(masterEntities);
const usersQuery = z.object({
  role: z.enum(['OWNER', 'TRADER', 'INSPECTOR', 'OFFICER', 'SENIOR_OFFICER', 'ADMIN']).optional(),
  status: z.enum(['INVITED', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED']).optional(),
  q: z.string().max(254).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
const auditQuery = z.object({
  action: z.string().max(60).optional(), entityType: z.string().max(40).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(),
  cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

@ApiTags('admin')
@Controller()
export class AdminController {
  constructor(private admin: AdminService, private md: MasterdataService, private auth: AuthService, private audit: AuditService) {}
  private u() { return ctx()!.user!; }

  @RequirePermission('user.manage') @Get('admin/users') users(@Query() q: unknown) { return this.admin.listUsers(parse(usersQuery, q)); }
  @RequirePermission('user.manage') @StepUp() @Idempotent() @Post('admin/users/invite')
  invite(@Body() body: unknown) { return this.auth.createInvite(this.u().userId, parse(inviteCreateSchema, body)); }
  @RequirePermission('user.manage') @StepUp() @HttpCode(200) @Post('admin/users/:id/action')
  action(@Param('id') id: string, @Body() body: unknown) { const b = parse(userStatusSchema, body); return this.admin.userAction(this.u(), parse(uuid, id), b.action, b.reason); }
  @RequirePermission('user.manage') @StepUp() @HttpCode(200) @Post('admin/users/:id/break-glass')
  breakGlass(@Param('id') id: string, @Body() body: unknown) { return this.admin.breakGlass(this.u(), parse(uuid, id), parse(z.object({ reason: z.string().trim().min(10).max(300) }).strict(), body).reason); }

  @RequirePermission('audit.read.own', 'audit.read.area', 'audit.read.all') @Get('audit') auditList(@Query() q: unknown) { return this.admin.auditList(this.u(), parse(auditQuery, q)); }
  @RequirePermission('audit.read.all') @StepUp() @HttpCode(200) @Post('admin/audit/verify-chain') verify() { return this.audit.verifyChain(); }

  // master data: staff may read, admin may change
  @RequirePermission('masterdata.read') @Get('admin/masterdata/:entity') list(@Param('entity') e: string) { return this.md.list(parse(ent, e)); }
  @RequirePermission('masterdata.write') @Post('admin/masterdata/:entity') create(@Param('entity') e: string, @Body() body: unknown) { return this.md.create(parse(ent, e), body); }
  @RequirePermission('masterdata.write') @Patch('admin/masterdata/:entity/:id') update(@Param('entity') e: string, @Param('id') id: string, @Body() body: unknown) { return this.md.update(parse(ent, e), parse(uuid, id), body); }
  @RequirePermission('masterdata.write') @Delete('admin/masterdata/:entity/:id') remove(@Param('entity') e: string, @Param('id') id: string) { return this.md.remove(parse(ent, e), parse(uuid, id)); }
}
void Roles;
