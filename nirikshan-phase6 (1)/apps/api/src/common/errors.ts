import { HttpException } from '@nestjs/common';

/** Application error. `code` is a stable machine code the web app maps to translated text. */
export class AppError extends HttpException {
  constructor(status: number, public readonly code: string, public readonly extra?: Record<string, unknown>) {
    super({ code, ...extra }, status);
  }
}
export const notFound = (what = 'NOT_FOUND') => new AppError(404, what);
export const forbidden = (code = 'FORBIDDEN') => new AppError(403, code);
export const unauthorized = (code = 'UNAUTHENTICATED') => new AppError(401, code);
export const conflict = (code: string, extra?: Record<string, unknown>) => new AppError(409, code, extra);
export const badRequest = (code: string, extra?: Record<string, unknown>) => new AppError(400, code, extra);
export const unprocessable = (code: string, extra?: Record<string, unknown>) => new AppError(422, code, extra);
export const tooMany = (retryAfter: number, code = 'RATE_LIMITED') => new AppError(429, code, { retryAfter });
