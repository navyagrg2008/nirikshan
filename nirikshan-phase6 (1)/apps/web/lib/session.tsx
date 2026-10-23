'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, get, onUnauthenticated, reauth } from './api';
import { Button, ErrorNote } from '@/components/ui';
import { useI18n } from './i18n';

export interface Business { id: string; type: string; firmName: string; areaId: string; areaName: string; managedCustomer: boolean }
export interface Me { authenticated: true; id: string; role: string; accountStatus: string; lang: string; mfaEnrolled: boolean; fullName: string | null; mobileMasked: string | null; emailMasked: string | null; home: string; businesses: Business[]; sessionRef: string }
type State = { loading: boolean; me: Me | null; refresh: () => Promise<Me | null>; signOut: () => Promise<void> };
const Ctx = createContext<State>({ loading: true, me: null, refresh: async () => null, signOut: async () => {} });
export const useSession = () => useContext(Ctx);

const IDLE_MIN: Record<string, number> = { OWNER: 30, TRADER: 30 }; // staff default 15
const WARN_BEFORE_MS = 2 * 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [loading, setLoading] = useState(true); const router = useRouter();
  const refresh = useCallback(async () => {
    try { const s = await get<Me | { authenticated: false }>('/auth/session'); const m = s.authenticated ? (s as Me) : null; setMe(m); return m; }
    catch { setMe(null); return null; } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { onUnauthenticated.fn = () => { setMe(null); router.replace('/login?expired=1'); }; return () => { onUnauthenticated.fn = null; }; }, [router]);
  const [ask, setAsk] = useState<{ done: (ok: boolean) => void } | null>(null);
  useEffect(() => { reauth.fn = () => new Promise<boolean>((done) => setAsk({ done })); return () => { reauth.fn = null; }; }, []);
  const signOut = useCallback(async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* already gone */ } setMe(null); router.replace('/login'); }, [router]);
  return <Ctx.Provider value={{ loading, me, refresh, signOut }}>{children}{ask && <ReauthDialog onDone={(ok) => { ask.done(ok); setAsk(null); }} needsCode={!!me?.mfaEnrolled} />}{me && <IdleGuard role={me.role} onExpire={() => { setMe(null); router.replace('/login?expired=1'); }} />}</Ctx.Provider>;
}

/** Warns two minutes before the server's idle limit and lets the person stay signed in (the server stays the authority). */
function IdleGuard({ role, onExpire }: { role: string; onExpire: () => void }) {
  const { t } = useI18n(); const limit = (IDLE_MIN[role] ?? 15) * 60_000; const last = useRef(Date.now()); const [warn, setWarn] = useState(false); const [left, setLeft] = useState(0);
  useEffect(() => {
    const bump = () => { if (!warn) last.current = Date.now(); };
    const ev = ['pointerdown', 'keydown', 'scroll'] as const; ev.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => { const idle = Date.now() - last.current; setLeft(Math.max(0, Math.ceil((limit - idle) / 1000))); if (idle >= limit) { setWarn(false); onExpire(); } else if (idle >= limit - WARN_BEFORE_MS) setWarn(true); }, 1000);
    return () => { ev.forEach((e) => window.removeEventListener(e, bump)); clearInterval(iv); };
  }, [limit, onExpire, warn]);
  if (!warn) return null;
  const stay = async () => { try { await get('/auth/session'); last.current = Date.now(); setWarn(false); } catch { onExpire(); } };
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="idle-t" aria-describedby="idle-d" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-xl">
        <h2 id="idle-t" className="text-lg font-semibold">{t('sess.title')}</h2>
        <p id="idle-d" className="mt-2 text-muted">{t('sess.body')} <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b></p>
        <button autoFocus onClick={stay} className="mt-5 min-h-11 w-full rounded-lg bg-primary px-4 font-medium text-primary-ink">{t('a.stay')}</button>
      </div>
    </div>
  );
}

/** Use at the top of a protected layout. Sends the visitor to the right place instead of rendering. */
export function useRequireRole(roles: string[]) {
  const { me, loading } = useSession(); const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!me) router.replace('/login');
    else if (me.accountStatus === 'PENDING_VERIFICATION' || me.accountStatus === 'REJECTED') router.replace('/register/pending');
    else if (!roles.includes(me.role)) router.replace(me.home);
  }, [loading, me, roles, router]);
  return { ready: !loading && !!me && roles.includes(me.role) && me.accountStatus === 'ACTIVE', me };
}

/** Step-up: sensitive actions need the password (and an authenticator code when set up) within the last five minutes. */
function ReauthDialog({ onDone, needsCode }: { onDone: (ok: boolean) => void; needsCode: boolean }) {
  const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await api('/auth/reauth', { method: 'POST', body: { password: pw, ...(code ? { code } : {}) } }); onDone(true); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ra-t" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <form onSubmit={go} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6 shadow-xl">
        <h2 id="ra-t" className="text-lg font-semibold">Confirm it is you</h2><p className="text-sm text-muted">This action needs a fresh sign-in check.</p>
        <label className="block text-sm font-medium">Password<input autoFocus type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3" /></label>
        {needsCode && <label className="block text-sm font-medium">Authenticator code<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3" /></label>}
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => onDone(false)}>Cancel</Button><Button type="submit" loading={busy}>Confirm</Button></div>
      </form>
    </div>
  );
}
