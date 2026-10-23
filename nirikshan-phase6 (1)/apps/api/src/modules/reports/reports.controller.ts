import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { uuid } from '@nirikshan/shared';
import { RateLimit, RequirePermission } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { ReportsService } from './reports.service';
import { DashboardService } from './dashboard.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paramsQ = z.object({ from: isoDate.optional(), to: isoDate.optional(), areaId: uuid.optional(), status: z.string().trim().max(60).optional() }).strict();
const dlQ = paramsQ.extend({ format: z.enum(['csv', 'xlsx', 'pdf']).default('csv') }).strict();

@ApiTags('reports')
@Controller()
export class ReportsController {
  constructor(private svc: ReportsService, private dash: DashboardService) {}
  private u() { return ctx()!.user!; }
  private p(q: z.infer<typeof paramsQ>) { const d = this.svc.defaults(); return { from: q.from ?? d.from, to: q.to ?? d.to, areaId: q.areaId, status: q.status || undefined }; }

  @RequirePermission('report.run.area', 'report.run.all') @Get('reports') catalog() { return this.svc.catalog(this.u()); }
  @RequirePermission('report.run.area', 'report.run.all') @RateLimit({ name: 'report-run', limit: 120, windowSec: 3600, by: 'user' }) @Get('reports/:id') run(@Param('id') id: string, @Query() q: unknown) { return this.svc.preview(this.u(), id, this.p(parse(paramsQ, q))); }
  @RequirePermission('report.run.area', 'report.run.all') @RateLimit({ name: 'report-export', limit: 30, windowSec: 3600, by: 'user' }) @Get('reports/:id/download')
  async download(@Param('id') id: string, @Query() q: unknown, @Res() res: Response) {
    const b = parse(dlQ, q); const out = await this.svc.download(this.u(), id, this.p(b), b.format);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Report-Truncated': String(out.truncated), 'Access-Control-Expose-Headers': 'X-Report-Truncated, Content-Disposition' }).send(out.buf);
  }
  @RequirePermission('report.run.area') @Get('officer/dashboard') officer() { return this.dash.officerView(this.u()); }
  @RequirePermission('report.run.all') @Get('admin/dashboard') admin() { return this.dash.adminView(this.u()); }
}
