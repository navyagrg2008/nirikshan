import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { als } from './request-context';
import { CryptoService } from '../infra/crypto';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private log = new Logger('http');
  constructor(private crypto: CryptoService) {}
  use(req: Request, res: Response, next: NextFunction) {
    const inbound = req.header('x-request-id');
    const requestId = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    // Nothing from the API may be kept by a shared cache or the browser's back/forward cache unless a handler says so (the public catalogue does).
    res.setHeader('Cache-Control', 'no-store');
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const start = Date.now();
    als.run({ requestId, ip, ipHash: this.crypto.blindIndex('ip', ip), ua: (req.header('user-agent') ?? '').slice(0, 200) }, () => {
      res.on('finish', () => {
        // No headers, bodies or query strings are logged.
        const uid = (req as unknown as { sessionUserId?: string }).sessionUserId;
        this.log.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms rid=${requestId}${uid ? ` uid=${uid}` : ''}`);
      });
      next();
    });
  }
}
