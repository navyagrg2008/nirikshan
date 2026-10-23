import { Controller, Get, Header, HttpCode, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { uuid } from '@nirikshan/shared';
import { Idempotent, RateLimit, RequirePermission, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { unprocessable } from '../../common/errors';
import { MigrationService } from './migration.service';

@ApiTags('admin-migration')
@Controller('admin/migration')
export class MigrationController {
  constructor(private svc: MigrationService) {}
  private u() { return ctx()!.user!; }
  @RequirePermission('migration.run') @Get('template.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="legacy-import-template.csv"') template() { return this.svc.template(); }
  @RequirePermission('migration.run') @Get('jobs') list() { return this.svc.list(); }
  @RequirePermission('migration.run') @RateLimit({ name: 'migration-validate', limit: 20, windowSec: 3600, by: 'user' }) @Post('validate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  validate(@UploadedFile() f: Express.Multer.File | undefined) { if (!f) throw unprocessable('FILE_REQUIRED'); return this.svc.validate(this.u(), f.originalname, f.buffer); }
  @RequirePermission('migration.run') @Get('jobs/:id/errors.csv') @Header('Content-Type', 'text/csv; charset=utf-8') @Header('Content-Disposition', 'attachment; filename="import-problems.csv"') errors(@Param('id') id: string) { return this.svc.errorsCsv(parse(uuid, id)); }
  @RequirePermission('migration.run') @StepUp() @Idempotent() @HttpCode(200) @Post('jobs/:id/commit') commit(@Param('id') id: string) { return this.svc.commit(this.u(), parse(uuid, id)); }
  @RequirePermission('migration.run') @Idempotent() @HttpCode(200) @Post('jobs/:id/discard') discard(@Param('id') id: string) { return this.svc.discard(this.u(), parse(uuid, id)); }
}
