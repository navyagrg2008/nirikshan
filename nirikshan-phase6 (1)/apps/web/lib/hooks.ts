'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';

/** `initial` is data the server already fetched for the first paint; the first client fetch is skipped. reload() still fetches fresh data. */
export function useFetch<T>(path: string | null, initial?: T | null) {
  const [data, setData] = useState<T | null>(initial ?? null); const [error, setError] = useState<unknown>(null); const [loading, setLoading] = useState(!!path && initial == null);
  const skip = useRef(initial != null);
  const reload = useCallback(async () => {
    if (!path) return; setLoading(true); setError(null);
    try { setData(await get<T>(path)); } catch (e) { setError(e); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { if (skip.current) { skip.current = false; return; } void reload(); }, [reload]);
  return { data, error, loading, reload };
}
export interface Area { id: string; parentId: string | null; level: string; code: string; name: string; nameHi: string | null }
export const useAreas = () => useFetch<Area[]>('/catalog/areas');
export const fmtDate = (s: string | null | undefined, lang = 'en') => (s ? new Date(s).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...(s.length === 10 ? { timeZone: 'UTC' } : {}) }) : '—');
