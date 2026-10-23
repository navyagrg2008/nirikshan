'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Alert, Button, Card, ErrorNote, Input, PageTitle } from '@/components/ui';
import { OtpVerify } from '@/components/Otp';

export default function Forgot() {
  const { t } = useI18n(); const [mobile, setMobile] = useState(''); const [tok, setTok] = useState<string | null>(null); const [pw, setPw] = useState(''); const [done, setDone] = useState(false); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post('/auth/password/forgot', { mobile: mobile.trim(), mobileToken: tok, newPassword: pw }); setDone(true); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <div className="mx-auto max-w-md"><PageTitle>{t('login.forgot')}</PageTitle>
      <Card className="space-y-4">
        {done ? <><Alert tone="ok">Your password was changed. Sign in with the new one.</Alert><Link className="text-primary underline" href="/login">{t('login.title')}</Link></> : <>
          <Input label={t('f.mobile')} inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} disabled={!!tok} autoComplete="tel" />
          {!tok ? <OtpVerify target={mobile.trim()} purpose="LOGIN" onVerified={setTok} /> :
            <form onSubmit={submit} className="space-y-4"><Alert tone="ok">Mobile number confirmed.</Alert><Input label={t('f.newpw')} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required minLength={10} hint="At least 10 characters. Do not use your name or phone number." /><ErrorNote error={err} /><Button type="submit" loading={busy}>{t('a.save')}</Button></form>}</>}
      </Card></div>
  );
}
