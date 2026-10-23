import { NextResponse, type NextRequest } from 'next/server';

/**
 * Strict Content Security Policy with a fresh nonce on every page request (SRS NFR-SEC-02).
 * Scripts run only if they carry this request's nonce, so an injected script tag is inert.
 * Styles still allow inline style attributes (charts and progress bars set widths that way); that is a much smaller risk than inline scripts.
 * The human-check widget's host is added only when a site key is configured.
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const human = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY ? ' https://challenges.cloudflare.com' : '';
  const csp = [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'",
    `connect-src 'self'${human}${dev ? ' ws:' : ''}`, `frame-src 'self'${human}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
  const headers = new Headers(req.headers); headers.set('x-nonce', nonce); headers.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers } }); res.headers.set('Content-Security-Policy', csp);
  return res;
}

// Pages only. The API proxy and static assets do not need a per-request policy.
export const config = { matcher: [{ source: '/((?!api/|_next/static|_next/image|favicon.ico|.*\\..*).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }] }] };
