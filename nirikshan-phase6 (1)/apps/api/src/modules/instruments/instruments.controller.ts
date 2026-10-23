import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { customerBusinessSchema, draftSchema, instrumentCreateSchema, instrumentUpdateSchema, uuid } from '@nirikshan/shared';
import { Idempotent, RateLimit, RequirePermission, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { unprocessable } from '../../common/errors';
import { InstrumentsService } from './instruments.service';

const listQuery = z.object({
  cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['REGISTERED', 'ACTIVE', 'DUE_FOR_RENEWAL', 'EXPIRED', 'DEREGISTERED']).optional(), categoryId: uuid.optional(), areaId: uuid.optional(),
  q: z.string().max(60).optional(),
}).strict();

@ApiTags('instruments')
@Controller()
export class InstrumentsController {
  constructor(private svc: InstrumentsService) {}
  private u() { return ctx()!.user!; }

  @Roles('OWNER', 'TRADER') @Idempotent() @RateLimit({ name: 'instrument-create', limit: 60, windowSec: 3600, by: 'user' }) @Post('instruments')
  async create(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.create(this.u(), parse(instrumentCreateSchema, body)); res.status(r.status); return r.body;
  }
  @RequirePermission('instrument.read.own', 'instrument.read.area', 'instrument.read.all') @Get('instruments')
  list(@Query() q: unknown) { return this.svc.list(this.u(), parse(listQuery, q)); }

  @Roles('OWNER', 'TRADER') @Get('instruments/export.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="instruments.csv"') @Header('Cache-Control', 'no-store')
  exportCsv() { return this.svc.exportCsv(this.u()); }

  // drafts
  @Roles('OWNER', 'TRADER') @Get('instruments/draft/mine') getDraft() { return this.svc.getDraft(this.u()); }
  @Roles('OWNER', 'TRADER') @Put('instruments/draft/mine')
  saveDraft(@Body() body: unknown) { const b = parse(draftSchema, body); return this.svc.saveDraft(this.u(), b.step, b.data); }
  @Roles('OWNER', 'TRADER') @HttpCode(200) @Delete('instruments/draft/mine') async delDraft() { await this.svc.deleteDraft(this.u()); return { ok: true }; }

  // bulk (traders)
  @Roles('TRADER') @Get('instruments/bulk/template.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="nirikshan-bulk-template.csv"')
  template() { return InstrumentsService.template(); }
  @Roles('TRADER') @RateLimit({ name: 'bulk', limit: 20, windowSec: 3600, by: 'user' }) @Post('instruments/bulk')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 1024 * 1024, files: 1 } }))
  bulk(@UploadedFile() f: Express.Multer.File | undefined) { if (!f) throw unprocessable('FILE_REQUIRED'); return this.svc.bulkValidate(this.u(), f.buffer); }
  @Roles('TRADER') @Get('instruments/bulk/:id/errors.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="errors.csv"')
  bulkErrors(@Param('id') id: string) { return this.svc.bulkErrorsCsv(this.u(), parse(uuid, id)); }
  @Roles('TRADER') @HttpCode(200) @Post('instruments/bulk/commit')
  bulkCommit(@Body() body: unknown) { const b = parse(z.object({ uploadId: uuid, confirmToken: z.string().min(20).max(200) }).strict(), body); return this.svc.bulkCommit(this.u(), b.uploadId, b.confirmToken); }

  @RequirePermission('instrument.read.own', 'instrument.read.area', 'instrument.read.all') @Get('instruments/:id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.get(this.u(), parse(uuid, id)); res.setHeader('ETag', `"${r.version}"`); return r;
  }
  @Roles('OWNER', 'TRADER') @Patch('instruments/:id')
  async patch(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const m = /^"?(\d+)"?$/.exec(req.header('if-match') ?? '');
    return this.svc.update(this.u(), parse(uuid, id), m ? Number(m[1]) : null, parse(instrumentUpdateSchema, body));
  }

  // managed customers
  @Roles('TRADER') @Post('me/customers') createCustomer(@Body() body: unknown) { const b = parse(customerBusinessSchema, body); return this.svc.createCustomer(this.u(), b.firmName, b.areaId); }
  @Roles('TRADER') @Get('me/customers') customers() { return this.svc.listCustomers(this.u()); }
}
