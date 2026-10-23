'use client';
import { useState, type FormEvent } from 'react';
import { post } from '@/lib/api';
import { Alert, Button, ErrorNote, Input } from './ui';

export interface LoginOut { status: 'OK' | 'MFA_REQUIRED' | 'MFA_ENROL_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED'; pendingId?: string; home?: string; accountStatus?: string; recoveryCodes?: string[] }

export function MfaEnrol({ pendingId, onDone }: { pendingId: string; onDone: (r: LoginOut) => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null); const [code, setCode] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [codes, setCodes] = useState<string[] | null>(null); const [out, setOut] = useState<LoginOut | null>(null);
  const start = async () => { setBusy(true); setErr(null); try { setSetup(await post('/auth/mfa/enrol/start', { pendingId })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const confirm = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { const r = await post<LoginOut>('/auth/mfa/enrol/confirm', { pendingId, code }); setOut(r); setCodes(r.recoveryCodes ?? []); } catch (x) { setErr(x); } finally { setBusy(false); } };
  if (codes && out) return (
    <div className="space-y-4"><Alert tone="warn">Save these recovery codes now. Each works once if you lose your phone. We cannot show them again.</Alert>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm">{codes.map((c) => <li key={c} className="rounded border border-line bg-paper p-2">{c}</li>)}</ul>
      <Button onClick={() => onDone(out)}>I have saved them</Button></div>
  );
  return (
    <div className="space-y-4"><p>Staff accounts need a second step. Add this account to an authenticator app, then enter the 6-digit code it shows.</p>
      {!setup ? <Button onClick={start} loading={busy}>Start setup</Button> : (
        <form onSubmit={confirm} className="space-y-4">
          <div className="rounded-lg border border-line bg-paper p-3 text-sm"><p>In your authenticator app choose <b>Enter a setup key</b> and type:</p><p className="mt-2 break-all font-mono text-base font-semibold">{setup.secret}</p><a className="mt-2 inline-block text-primary underline" href={setup.otpauthUri}>Open in authenticator app</a></div>
          <Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          <Button type="submit" loading={busy} disabled={code.length !== 6}>Confirm and continue</Button></form>)}
      <ErrorNote error={err} /></div>
  );
}
