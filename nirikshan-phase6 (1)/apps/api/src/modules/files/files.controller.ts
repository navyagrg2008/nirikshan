import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/decorators';
import { StorageService } from '../../infra/storage';
import { notFound } from '../../common/errors';

/** Serves files for the LOCAL storage provider only (development/test). Production uses S3 presigned URLs on a separate origin. */
@Controller('files')
export class FilesController {
  constructor(private storage: StorageService) {}
  @Public() @Get('local/:token')
  async local(@Param('token') token: string, @Res() res: Response) {
    const t = this.storage.parseLocalToken(token); if (!t) throw notFound();
    const buf = await this.storage.getLocal(t.key).catch(() => null); if (!buf) throw notFound();
    res.set({ 'Content-Type': t.contentType, 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store' });
    res.send(buf);
  }
}
