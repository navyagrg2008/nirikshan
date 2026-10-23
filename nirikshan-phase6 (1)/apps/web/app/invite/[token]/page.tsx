'use client';
import { use, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { get, post } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, Button, Card, ErrorNote, Input, Loading, PageTitle } from '@/components/ui';
import { MfaEnrol, type LoginOut } from '@/components/Mfa';

export default function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params); const router = useRouter(); const { refresh } = useSession();
  const [info, setInfo] = useState<{ role: string } | null | false>(null); const [pw, setPw] = useState(''); const [pending, setPending] = useState<string | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { get<{ role: string }>(`/auth/invite/${encodeURIComponent(token)}`).then(setInfo).catch(() => setInfo(false)); }, [token]);
  const accept = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { const r = await post<LoginOut>('/auth/invite/accept', { token, password: pw }); setPending(r.pendingId ?? null); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const done = async (r: LoginOut) => { const me = await refresh(); router.replace(r.home ?? me?.home ?? '/'); };
  if (info === null) return <Loading />;
  return (
    <div className="mx-auto max-w-md"><PageTitle>Welcome to Nirikshan</PageTitle>
      <Card className="space-y-4">
        {info === false ? <Alert>This invitation link is not valid, was already used, or has expired. Ask your administrator for a new one.</Alert>
          : pending ? <MfaEnrol pendingId={pending} onDone={done} />
          : <form onSubmit={accept} className="space-y-4"><p>You have been invited as <b>{info.role.replace('_', ' ').toLowerCase()}</b>. Choose a password to begin.</p>
            <Input label="Password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} hint="At least 10 characters. Do not use your name or phone number." /><ErrorNote error={err} /><Button type="submit" loading={busy}>Continue</Button></form>}
      </Card></div>
  );
}
