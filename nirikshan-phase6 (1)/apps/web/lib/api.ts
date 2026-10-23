/** Thin fetch wrapper. The browser only talks to its own origin (/api/v1 is proxied to the API), so cookies are first-party. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown>) { super(code); }
  get retryAfter(): number | undefined { return typeof this.body.retryAfter === 'number' ? this.body.retryAfter : undefined; }
  get fieldErrors(): Record<string, string> { return (this.body.errors as Record<string, string>) ?? {}; }
}
const BASE = '/api/v1';
const readCsrf = () => (typeof document === 'undefined' ? '' : document.cookie.split('; ').find((c) => c.startsWith('nrk_csrf='))?.slice(9) ?? '');
async function ensureCsrf() { if (!readCsrf()) await fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' }); return readCsrf(); }

export interface Opts { method?: string; body?: unknown; form?: FormData; headers?: Record<string, string>; idempotent?: boolean; signal?: AbortSignal }
export const onUnauthenticated: { fn: (() => void) | null } = { fn: null };
/** Set by the session provider: shows the password/code dialog and resolves true once the person has re-confirmed. */
export const reauth: { fn: (() => Promise<boolean>) | null } = { fn: null };

export async function api<T = unknown>(path: string, o: Opts = {}, retried = false): Promise<T> {
  const method = o.method ?? 'GET'; const headers: Record<string, string> = { Accept: 'application/json', ...o.headers };
  if (method !== 'GET') headers['X-CSRF-Token'] = await ensureCsrf();
  if (o.idempotent) headers['Idempotency-Key'] = crypto.randomUUID();
  let body: BodyInit | undefined;
  if (o.form) body = o.form; else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await fetch(BASE + path, { method, headers, body, credentials: 'same-origin', signal: o.signal, cache: 'no-store' });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const b = (typeof data === 'object' ? data : {}) as Record<string, unknown>;
    if (res.status === 401 && b.code === 'REAUTH_REQUIRED' && !retried && reauth.fn && (await reauth.fn())) return api<T>(path, o, true);
    if (res.status === 401 && !['INVALID_CREDENTIALS', 'INVALID_CODE', 'REAUTH_REQUIRED'].includes(String(b.code))) onUnauthenticated.fn?.();
    throw new ApiError(res.status, String(b.code ?? 'ERROR'), b);
  }
  return data as T;
}
export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, body?: unknown, idempotent = false) => api<T>(p, { method: 'POST', body, idempotent });
export const patch = <T,>(p: string, body: unknown, ifMatch?: number) => api<T>(p, { method: 'PATCH', body, headers: ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined });
export const put = <T,>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const del = <T,>(p: string) => api<T>(p, { method: 'DELETE' });

/** GET that sends If-None-Match and reports 304 as `notModified`, so screens can poll cheaply. */
export async function getEtag<T>(path: string, etag?: string): Promise<{ notModified: true; etag: string } | { notModified: false; etag: string; data: T }> {
  const res = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) } });
  if (res.status === 304) return { notModified: true, etag: etag ?? '' };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401) onUnauthenticated.fn?.(); throw new ApiError(res.status, String((data as Record<string, unknown>).code ?? 'ERROR'), data as Record<string, unknown>); }
  return { notModified: false, etag: res.headers.get('etag') ?? '', data: data as T };
}

/** Fetches a file (CSV, XLSX, PDF) with the session cookie and hands it to the browser as a download. Returns true if the server cut the rows short. */
export async function download(path: string, fallbackName: string): Promise<boolean> {
  const res = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as Record<string, unknown>; throw new ApiError(res.status, String(b.code ?? 'ERROR'), b); }
  const cd = res.headers.get('content-disposition') ?? ''; const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return res.headers.get('x-report-truncated') === 'true';
}
