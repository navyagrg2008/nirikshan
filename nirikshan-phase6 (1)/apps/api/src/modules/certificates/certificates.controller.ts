import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { certificateActionSchema, certificateReinstateSchema, certificatesQuery, reissueSchema, uuid } from '@nirikshan/shared';
import { Idempotent, Public, RateLimit, RequirePermission, Roles, StepUp } from '../../common/decorators';
import { parse } from '../../common/zod';
import { ctx } from '../../common/request-context';
import { publicValidateQuery } from '@nirikshan/shared';
import { CertificatesService } from './certificates.service';

const READ = ['certificate.read.own', 'certificate.read.area', 'certificate.read.all'] as const;

@ApiTags('certificates')
@Controller()
export class CertificatesController {
  constructor(private svc: CertificatesService) {}
  private u() { return ctx()!.user!; }

  @RequirePermission(...READ) @Get('certificates') list(@Query() q: unknown) { return this.svc.list(this.u(), parse(certificatesQuery, q)); }
  @RequirePermission(...READ) @Get('certificates/:id') detail(@Param('id') id: string) { return this.svc.detail(this.u(), parse(uuid, id)); }
  @RequirePermission(...READ) @Get('certificates/:id/pdf') pdf(@Param('id') id: string) { return this.svc.pdfLink(this.u(), parse(uuid, id)); }

  @RequirePermission('certificate.manage') @StepUp() @HttpCode(200) @Idempotent() @Post('certificates/:id/suspend')
  suspend(@Param('id') id: string, @Body() b: unknown) { return this.svc.suspend(this.u(), parse(uuid, id), parse(certificateActionSchema, b)); }
  @RequirePermission('certificate.manage') @StepUp() @HttpCode(200) @Idempotent() @Post('certificates/:id/revoke')
  revoke(@Param('id') id: string, @Body() b: unknown) { return this.svc.revoke(this.u(), parse(uuid, id), parse(certificateActionSchema, b)); }
  @RequirePermission('certificate.manage') @StepUp() @HttpCode(200) @Idempotent() @Post('certificates/:id/reinstate')
  reinstate(@Param('id') id: string, @Body() b: unknown) { return this.svc.reinstate(this.u(), parse(uuid, id), parse(certificateReinstateSchema, b)); }
  @RequirePermission('certificate.manage') @StepUp() @HttpCode(200) @Idempotent() @Post('certificates/:id/reissue')
  reissue(@Param('id') id: string, @Body() b: unknown) { return this.svc.reissue(this.u(), parse(uuid, id), parse(reissueSchema, b)); }

  @Roles('ADMIN') @RequirePermission('certificate.manage') @Get('admin/certificates/keys') keys() { return this.svc.keys(this.u()); }

  @Public() @RateLimit({ name: 'pub-validate', limit: 30, windowSec: 60 }) @Get('public/validate')
  validate(@Query() q: unknown) { const b = parse(publicValidateQuery, q); return this.svc.validate({ cert: b.cert, captchaToken: b.captchaToken }); }
  @Public() @RateLimit({ name: 'pub-validate', limit: 30, windowSec: 60 }) @Get('public/validate/qr/:token')
  validateQr(@Param('token') token: string, @Query('captchaToken') captchaToken?: string) { return this.svc.validate({ token: token.slice(0, 80), captchaToken }); }
}
