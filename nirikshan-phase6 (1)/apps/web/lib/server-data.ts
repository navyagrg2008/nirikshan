/** Fetches public JSON on the server so the first HTML already holds the data. Returns null on any problem; the page then fetches on the client as before. */
export async function serverGet<T>(path: string): Promise<T | null> {
  try {
    const base = process.env.API_INTERNAL_URL || 'http://localhost:4000';
    const r = await fetch(`${base}/api/v1${path}`, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}
