import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ctx } from './request-context';

const TITLES: Record<number, string> = {
  400: 'Bad request', 401: 'Sign in required', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict', 413: 'File too large',
  422: 'Check the details', 429: 'Too many requests', 500: 'Something went wrong', 503: 'Service unavailable',
};

/** RFC 7807 problem+json. Never leaks stack traces, SQL or internal messages. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private log = new Logger('Problem');
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = 500; let code = 'INTERNAL_ERROR'; let extra: Record<string, unknown> = {};
    if (err instanceof HttpException) {
      status = err.getStatus();
      const body = err.getResponse() as Record<string, unknown> | string;
      if (typeof body === 'object' && body) {
        code = typeof body.code === 'string' ? body.code : status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'HTTP_ERROR';
        const { code: _c, message: _m, statusCode: _s, error: _e, ...rest } = body as Record<string, unknown>;
        extra = rest;
      }
    } else {
      const e = err as { code?: string; type?: string; status?: number };
      if (e?.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; }
      else if (e?.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; }
      else this.log.error(`${req.method} ${req.path} ${(err as Error)?.message ?? err}`);
    }
    if (status === 429 && typeof extra.retryAfter === 'number') res.setHeader('Retry-After', String(extra.retryAfter));
    res.status(status).type('application/problem+json').json({
      type: `https://nirikshan.example/problems/${code}`,
      title: TITLES[status] ?? 'Error', status, code, requestId: ctx()?.requestId, ...extra,
    });
  }
}
