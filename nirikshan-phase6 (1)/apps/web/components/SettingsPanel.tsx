'use client';
import { useState, type FormEvent } from 'react';
import { del, post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { MyData } from './MyData';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle } from './ui';

interface Sess { ref: string; createdAt: number; lastSeen: number; ua: string; current: boolean }
export function SettingsPanel() {
  const { t, lang } = useI18n(); const { me, signOut } = useSession(); const sess = useFetch<Sess[]>('/auth/sessions');
  const [cur, setCur] = useState(''); const [np, setNp] = useState(''); const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  const change = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); setOk(false); try { await post('/auth/password/change', { currentPassword: cur, newPassword: np }); setOk(true); setCur(''); setNp(''); await sess.reload(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const revoke = async (ref: string) => { await del(`/auth/sessions/${ref}`); await sess.reload(); };
  return (
    <div className="mx-auto max-w-2xl space-y-6"><PageTitle>{t('nav.settings')}</PageTitle>
      <Card><h2 className="mb-3 text-lg font-semibold">Your details</h2><dl className="grid gap-2 sm:grid-cols-2"><div><dt className="text-xs text-muted">Name</dt><dd>{me?.fullName}</dd></div><div><dt className="text-xs text-muted">Role</dt><dd>{me?.role}</dd></div><div><dt className="text-xs text-muted">Mobile</dt><dd>{me?.mobileMasked ?? '—'}</dd></div><div><dt className="text-xs text-muted">Email</dt><dd>{me?.emailMasked ?? '—'}</dd></div></dl></Card>
      <Card><h2 className="mb-3 text-lg font-semibold">Change password</h2>
        <form onSubmit={change} className="space-y-4"><Input label={t('f.curpw')} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /><Input label={t('f.newpw')} type="password" autoComplete="new-password" value={np} onChange={(e) => setNp(e.target.value)} required minLength={10} hint="Other devices are signed out when you change it." />
          {ok && <Alert tone="ok">Password changed.</Alert>}<ErrorNote error={err} /><Button type="submit" loading={busy}>{t('a.save')}</Button></form></Card>
      <Card><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Where you are signed in</h2><Button variant="secondary" onClick={async () => { await post('/auth/logout-all'); await signOut(); }}>Sign out everywhere</Button></div>
        {sess.loading && <Loading />}<ul className="divide-y divide-line">{sess.data?.map((s) => <li key={s.ref} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm">{s.ua?.slice(0, 80) || 'Unknown device'} {s.current && <Badge tone="ok">This device</Badge>}</p><p className="text-xs text-muted">Started {fmtDate(new Date(s.createdAt).toISOString(), lang)}</p></div>{!s.current && <Button variant="ghost" onClick={() => revoke(s.ref)}>Sign out</Button>}</li>)}</ul></Card>
      {(me?.role === 'OWNER' || me?.role === 'TRADER') && <MyData />}
    </div>
  );
}
