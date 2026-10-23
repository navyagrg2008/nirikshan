import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UploadedFile, UseInterceptors, Inject, Patch } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import {
  changePasswordSchema, forgotPasswordSchema, inviteAcceptSchema, loginOtpSchema, loginSchema, mfaVerifySchema, otpSendSchema, otpVerifySchema,
  reauthSchema, registerSchema, REG_DOC_KINDS,
} from '@nirikshan/shared';
import { z } from 'zod';
import { AllowPending, Public, RateLimit, Roles } from '../../common/decorators';
import { parse } from '../../common/zod';
import { AppError, unprocessable } from '../../common/errors';
import { ctx } from '../../common/request-context';
import { AuthService, LoginResult } from './auth.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { randomToken } from '../../infra/crypto';
import { RedisService } from '../../infra/redis.service';
import { StorageService } from '../../infra/storage';
import { ScanService, ALLOWED_UPLOADS, sniffMime } from '../../infra/scan';
import { CaptchaService } from '../../infra/providers';
import { ENV, AppEnv } from '../../config/env';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService, private otp: OtpService, private sessions: SessionService, private redis: RedisService,
    private storage: StorageService, private scan: ScanService, private captcha: CaptchaService, @Inject(ENV) private env: AppEnv,
  ) {}

  private cookieOpts() { return { path: '/', sameSite: 'lax' as const, secure: this.env.COOKIE_SECURE }; }
  private setSession(res: Response, s: { sid: string; csrf: string }) {
    res.cookie(this.sessions.cookieName, s.sid, { ...this.cookieOpts(), httpOnly: true });
    res.cookie(this.sessions.csrfCookieName, s.csrf, { ...this.cookieOpts(), httpOnly: false });
    res.setHeader('Cache-Control', 'no-store');
  }
  private out(res: Response, r: LoginResult) {
    res.setHeader('Cache-Control', 'no-store');
    if (r.status === 'OK') { this.setSession(res, r.session); return { status: 'OK', home: r.home, accountStatus: r.accountStatus }; }
    return r;
  }

  @Public() @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const existing = (req.cookies as Record<string, string> | undefined)?.[this.sessions.csrfCookieName];
    const token = existing && /^[\w-]{20,64}$/.test(existing) ? existing : randomToken(24);
    res.cookie(this.sessions.csrfCookieName, token, { ...this.cookieOpts(), httpOnly: false });
    res.setHeader('Cache-Control', 'no-store');
    return { csrfToken: token };
  }

  @Public() @HttpCode(200) @RateLimit({ name: 'otp-send', limit: 20, windowSec: 3600 }) @Post('otp/send')
  async otpSend(@Body() body: unknown) {
    const b = parse(otpSendSchema, body);
    return this.otp.send({ channel: b.channel, target: b.target, purpose: b.purpose === 'CONFIRM' ? 'REGISTER' : b.purpose, captchaToken: b.captchaToken });
  }
  @Public() @HttpCode(200) @RateLimit({ name: 'otp-verify', limit: 30, windowSec: 600 }) @Post('otp/verify')
  otpVerify(@Body() body: unknown) { return this.otp.verify(...(Object.values(parse(otpVerifySchema, body)) as [string, string])); }

  /** Registration document upload (before the account exists). Type is sniffed from bytes, size capped, scanned before it can be linked. */
  @Public() @RateLimit({ name: 'reg-upload', limit: 30, windowSec: 3600 }) @Post('register/uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async regUpload(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: { kind?: string }) {
    const kind = parse(z.enum(REG_DOC_KINDS), body?.kind);
    if (!file) throw unprocessable('FILE_REQUIRED');
    const mime = sniffMime(file.buffer);
    if (!mime || !ALLOWED_UPLOADS[mime]) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE');
    if (file.size > ALLOWED_UPLOADS[mime]!.max) throw new AppError(413, 'PAYLOAD_TOO_LARGE');
    const verdict = await this.scan.scan(file.buffer);
    if (verdict !== 'CLEAN') throw new AppError(422, verdict === 'INFECTED' ? 'FILE_REJECTED' : 'SCAN_UNAVAILABLE');
    const id = randomUUID(); const key = `reg/${randomUUID()}.${ALLOWED_UPLOADS[mime]!.ext}`;
    await this.storage.put(key, file.buffer, { contentType: mime });
    await this.redis.setJson(`regupload:${id}`, { key, mime, size: file.size, sha: createHash('sha256').update(file.buffer).digest('hex'), kind }, 7200);
    return { fileId: id, mime, size: file.size };
  }

  @Public() @RateLimit({ name: 'register', limit: 10, windowSec: 3600 }) @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.register(parse(registerSchema, body));
    return this.out(res, r);
  }

  @Public() @HttpCode(200) @RateLimit({ name: 'login', limit: 20, windowSec: 60 }) @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = parse(loginSchema, body); return this.out(res, await this.auth.login(b.identifier, b.password));
  }
  @Public() @HttpCode(200) @RateLimit({ name: 'login-otp', limit: 20, windowSec: 60 }) @Post('login/otp')
  async loginOtp(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.out(res, await this.auth.loginWithOtp(parse(loginOtpSchema, body).mobileToken));
  }
  @Public() @HttpCode(200) @RateLimit({ name: 'mfa', limit: 20, windowSec: 600 }) @Post('mfa/verify')
  async mfa(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = parse(mfaVerifySchema, body); return this.out(res, await this.auth.verifyMfa(b.pendingId, b.code));
  }
  @Public() @HttpCode(200) @RateLimit({ name: 'mfa', limit: 20, windowSec: 600 }) @Post('mfa/enrol/start')
  enrolStart(@Body() body: unknown) { return this.auth.enrolStart(parse(z.object({ pendingId: z.string().min(20).max(200) }).strict(), body).pendingId); }
  @Public() @HttpCode(200) @RateLimit({ name: 'mfa', limit: 20, windowSec: 600 }) @Post('mfa/enrol/confirm')
  async enrolConfirm(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = parse(mfaVerifySchema, body);
    const r = await this.auth.enrolConfirm(b.pendingId, b.code);
    return { ...(this.out(res, r.result) as object), recoveryCodes: r.recoveryCodes };
  }
  @Public() @HttpCode(200) @RateLimit({ name: 'pwchange', limit: 10, windowSec: 600 }) @Post('password/change-required')
  async changeRequired(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = parse(z.object({ pendingId: z.string().min(20).max(200), newPassword: z.string().min(10).max(128) }).strict(), body);
    return this.out(res, await this.auth.changePasswordRequired(b.pendingId, b.newPassword));
  }
  @Public() @HttpCode(200) @RateLimit({ name: 'pwforgot', limit: 10, windowSec: 3600 }) @Post('password/forgot')
  async forgot(@Body() body: unknown) { const b = parse(forgotPasswordSchema, body); await this.auth.forgotPassword(b.mobile, b.mobileToken, b.newPassword); return { ok: true }; }

  @Public() @Get('invite/:token')
  invite(@Param('token') token: string) { return this.auth.inviteInfo(token); }
  @Public() @HttpCode(200) @RateLimit({ name: 'invite', limit: 10, windowSec: 600 }) @Post('invite/accept')
  async accept(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const b = parse(inviteAcceptSchema, body); return this.out(res, await this.auth.acceptInvite(b.token, b.password));
  }

  @Public() @Get('session')
  async session(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const u = ctx()?.user; if (!u) return { authenticated: false };
    return { authenticated: true, ...(await this.auth.me(u.userId)), sessionRef: u.sessionRef };
  }
  @AllowPending() @HttpCode(200) @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sid = (req.cookies as Record<string, string>)[this.sessions.cookieName]; if (sid) await this.sessions.destroy(sid);
    res.clearCookie(this.sessions.cookieName, this.cookieOpts()); res.clearCookie(this.sessions.csrfCookieName, this.cookieOpts());
    return { ok: true };
  }
  @AllowPending() @HttpCode(200) @Post('logout-all')
  async logoutAll(@Res({ passthrough: true }) res: Response) {
    await this.sessions.revokeAll(ctx()!.user!.userId);
    res.clearCookie(this.sessions.cookieName, this.cookieOpts()); res.clearCookie(this.sessions.csrfCookieName, this.cookieOpts());
    return { ok: true };
  }
  @AllowPending() @Get('sessions')
  list() { const u = ctx()!.user!; return this.sessions.list(u.userId, u.sessionRef); }
  @AllowPending() @Delete('sessions/:ref')
  async revoke(@Param('ref') ref: string) {
    if (!/^[0-9a-f]{16}$/.test(ref)) throw unprocessable('INVALID_REF');
    const ok = await this.sessions.revokeByRef(ctx()!.user!.userId, ref);
    if (!ok) throw new AppError(404, 'NOT_FOUND');
    return { ok: true };
  }
  @HttpCode(200) @RateLimit({ name: 'reauth', limit: 10, windowSec: 600, by: 'user' }) @Post('reauth')
  async reauth(@Body() body: unknown, @Req() req: Request) {
    const b = parse(reauthSchema, body); await this.auth.reauth(ctx()!.user!.userId, (req as unknown as { sessionId: string }).sessionId, b.password, b.code);
    return { ok: true, validForSeconds: 300 };
  }
  @AllowPending() @HttpCode(200) @RateLimit({ name: 'pwchange', limit: 10, windowSec: 600, by: 'user' }) @Post('password/change')
  async change(@Body() body: unknown) {
    const b = parse(changePasswordSchema, body); const u = ctx()!.user!;
    await this.auth.changePassword(u.userId, b.currentPassword, b.newPassword, u.sessionRef); return { ok: true };
  }

  // Optional MFA for owners and traders (staff are enrolled through their invite)
  @HttpCode(200) @Post('mfa/setup/start') mfaSetup() { return this.auth.ownerMfaStart(ctx()!.user!.userId); }
  @HttpCode(200) @RateLimit({ name: 'mfa', limit: 20, windowSec: 600, by: 'user' }) @Post('mfa/setup/confirm')
  mfaConfirm(@Body() body: unknown) { return this.auth.ownerMfaConfirm(ctx()!.user!.userId, parse(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), body).code); }
  @HttpCode(200) @Post('mfa/disable')
  async mfaDisable(@Body() body: unknown) {
    const u = ctx()!.user!; await this.auth.ownerMfaDisable(u.userId, u.role, parse(z.object({ password: z.string().min(1).max(128) }).strict(), body).password); return { ok: true };
  }

  // Confirmation OTP for a signed-in user (declarations). Sent to the user's own verified mobile.
  @HttpCode(200) @RateLimit({ name: 'otp-confirm', limit: 10, windowSec: 3600, by: 'user' }) @Post('otp/confirm/send')
  async confirmSend() {
    const u = ctx()!.user!; return this.auth.sendConfirmOtp(u.userId, u.lang);
  }
  @HttpCode(200) @RateLimit({ name: 'otp-verify', limit: 30, windowSec: 600, by: 'user' }) @Post('otp/confirm/verify')
  confirmVerify(@Body() body: unknown) { const b = parse(otpVerifySchema, body); return this.otp.verify(b.challengeId, b.code); }
}

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(private auth: AuthService) {}
  @AllowPending() @Get() me() { return this.auth.me(ctx()!.user!.userId); }
  @AllowPending() @Patch()
  async patch(@Body() body: unknown) {
    const b = parse(z.object({ lang: z.enum(['en', 'hi']) }).strict(), body); await this.auth.setLang(ctx()!.user!.userId, b.lang); return { ok: true };
  }
}
