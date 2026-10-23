import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { applicationBatchSchema, applicationCreateSchema, cancelSchema, precheckQuery, rescheduleRequestSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RateLimit, RequirePermission, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { unprocessable } from '../../common/errors';
import { ApplicationsService } from './applications.service';

const listQuery = z.object({ status: z.string().max(40).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

@ApiTags('applications')
@Controller()
export class ApplicationsController {
  constructor(private svc: ApplicationsService) {}
  private u() { return ctx()!.user!; }

  @RequirePermission('application.apply') @Get('instruments/:id/precheck')
  precheck(@Param('id') id: string, @Query() q: unknown) { return this.svc.precheck(this.u(), parse(uuid, id), parse(precheckQuery, q).type); }

  @RequirePermission('application.apply') @Idempotent() @RateLimit({ name: 'application-create', limit: 60, windowSec: 3600, by: 'user' }) @Post('applications')
  async create(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { declarationAccepted: _d, ...b } = parse(applicationCreateSchema, body); res.status(201); return this.svc.create(this.u(), b);
  }

  @Roles('TRADER') @Idempotent() @RateLimit({ name: 'application-batch', limit: 10, windowSec: 3600, by: 'user' }) @Post('applications/batch')
  async batch(@Body() body: unknown) { const { declarationAccepted: _d, ...b } = parse(applicationBatchSchema, body); return this.svc.createBatch(this.u(), b); }

  @RequirePermission('application.read.own') @Get('applications')
  list(@Query() q: unknown) { return this.svc.list(this.u(), parse(listQuery, q)); }

  @RequirePermission('application.read.own') @Get('applications/:id')
  async get(@Param('id') id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.getForOwner(this.u(), parse(uuid, id), req.header('if-none-match') ?? undefined);
    res.setHeader('ETag', r.etag); res.setHeader('Cache-Control', 'private, no-cache');
    if (r.notModified) { res.status(304); return; }
    return r.body;
  }

  @Roles('OWNER', 'TRADER') @RateLimit({ name: 'doc-upload', limit: 60, windowSec: 3600, by: 'user' }) @Post('applications/:id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 6 * 1024 * 1024, files: 1 } }))
  upload(@Param('id') id: string, @Body() body: unknown, @UploadedFile() f: Express.Multer.File | undefined) {
    if (!f) throw unprocessable('FILE_REQUIRED');
    const b = parse(z.object({ documentTypeId: uuid }).strict(), body);
    return this.svc.upload(this.u(), parse(uuid, id), b.documentTypeId, f);
  }

  @RequirePermission('application.read.own', 'case.review') @Get('applications/:id/documents/:docId/link') @HttpCode(200)
  link(@Param('id') id: string, @Param('docId') docId: string) { return this.svc.documentLink(this.u(), parse(uuid, id), parse(uuid, docId)); }

  @Roles('OWNER', 'TRADER') @HttpCode(200) @Post('applications/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: unknown) { return this.svc.cancel(this.u(), parse(uuid, id), parse(cancelSchema, body).reason); }

  @Roles('OWNER', 'TRADER') @Post('applications/:id/reschedule-request')
  reschedule(@Param('id') id: string, @Body() body: unknown) { return this.svc.requestReschedule(this.u(), parse(uuid, id), parse(rescheduleRequestSchema, body)); }
}
