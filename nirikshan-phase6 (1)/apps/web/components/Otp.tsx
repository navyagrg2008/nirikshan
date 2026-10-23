'use client';
import { useEffect, useState } from 'react';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Alert, Button, ErrorNote, Input } from './ui';

/** Sends and checks a one-time code. Calls onVerified with the single-use token the server returns. */
export function OtpVerify({ target, channel = 'MOBILE', purpose, onVerified, sendLabel }: { target: string; channel?: 'MOBILE' | 'EMAIL'; purpose: 'REGISTER' | 'LOGIN' | 'CONFIRM'; onVerified: (token: string) => void; sendLabel?: string }) {
  const { t } = useI18n(); const [challenge, setChallenge] = useState<string | null>(null); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [wait, setWait] = useState(0);
  useEffect(() => { if (wait <= 0) return; const id = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(id); }, [wait]);
  const send = async () => {
    setBusy(true); setErr(null);
    try { const r = await post<{ challengeId: string }>('/auth/otp/send', { channel, target, purpose }); setChallenge(r.challengeId); setWait(30); setCode(''); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const verify = async () => {
    if (!challenge) return; setBusy(true); setErr(null);
    try { const r = await post<{ verificationToken: string }>('/auth/otp/verify', { challengeId: challenge, code }); onVerified(r.verificationToken); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      {!challenge ? <Button type="button" onClick={send} loading={busy} disabled={!target}>{sendLabel ?? t('a.send')}</Button> : <>
        <Alert tone="info">We sent a 6-digit code to {channel === 'MOBILE' ? 'your mobile' : 'your email'} (Draft / Demo Code: <b>123456</b>).</Alert>
        <Input label={t('f.code')} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        <div className="flex flex-wrap gap-2"><Button type="button" onClick={verify} loading={busy} disabled={code.length !== 6}>{t('a.verify')}</Button>
          <Button type="button" variant="secondary" onClick={send} disabled={wait > 0 || busy}>{wait > 0 ? `Resend in ${wait}s` : 'Resend code'}</Button></div></>}
      <ErrorNote error={err} />
    </div>
  );
}
