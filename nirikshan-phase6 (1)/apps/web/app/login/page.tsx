'use client';
import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { Alert, Button, Card, ErrorNote, Input, PageTitle } from '@/components/ui';
import { OtpVerify } from '@/components/Otp';
import { MfaEnrol, type LoginOut } from '@/components/Mfa';

type Stage = { k: 'password' } | { k: 'otp' } | { k: 'mfa'; pendingId: string } | { k: 'enrol'; pendingId: string } | { k: 'pwchange'; pendingId: string };

function LoginForm() {
  const { t } = useI18n(); const router = useRouter(); const { refresh } = useSession(); const params = useSearchParams();
  const [stage, setStage] = useState<Stage>({ k: 'password' }); const [id, setId] = useState(''); const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [np, setNp] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const next = async (r: LoginOut) => {
    if (r.status === 'OK') { const me = await refresh(); router.replace(me?.accountStatus === 'PENDING_VERIFICATION' ? '/register/pending' : (r.home ?? me?.home ?? '/')); }
    else if (r.status === 'MFA_REQUIRED') setStage({ k: 'mfa', pendingId: r.pendingId! });
    else if (r.status === 'MFA_ENROL_REQUIRED') setStage({ k: 'enrol', pendingId: r.pendingId! });
    else setStage({ k: 'pwchange', pendingId: r.pendingId! });
  };
  const run = async (fn: () => Promise<LoginOut>) => { setBusy(true); setErr(null); try { await next(await fn()); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const submitPw = (e: FormEvent) => { e.preventDefault(); void run(() => post('/auth/login', { identifier: id.trim(), password: pw })); };
  const submitMfa = (e: FormEvent) => { e.preventDefault(); if (stage.k === 'mfa') void run(() => post('/auth/mfa/verify', { pendingId: stage.pendingId, code: code.trim() })); };
  const submitPwChange = (e: FormEvent) => { e.preventDefault(); if (stage.k === 'pwchange') void run(() => post('/auth/password/change-required', { pendingId: stage.pendingId, newPassword: np })); };
  return (
    <div className="mx-auto max-w-md"><PageTitle>{t('login.title')}</PageTitle>
      {params.get('expired') && <div className="mb-4"><Alert tone="warn">You were signed out. Please sign in again.</Alert></div>}
      <Card className="space-y-4">
        {stage.k === 'password' && <form onSubmit={submitPw} className="space-y-4">
          <Input label={t('f.identifier')} value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required />
          <Input label={t('f.password')} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
          <ErrorNote error={err} /><Button type="submit" loading={busy} className="w-full">{t('login.title')}</Button>
          <div className="flex flex-wrap justify-between gap-2 text-sm"><button type="button" className="text-primary underline" onClick={() => { setErr(null); setStage({ k: 'otp' }); }}>{t('login.otp')}</button><Link className="text-primary underline" href="/forgot-password">{t('login.forgot')}</Link></div></form>}
        {stage.k === 'otp' && <div className="space-y-4"><Input label={t('f.mobile')} inputMode="tel" value={id} onChange={(e) => setId(e.target.value)} autoComplete="tel" />
          <OtpVerify target={id.trim()} purpose="LOGIN" onVerified={(tok) => run(() => post('/auth/login/otp', { mobileToken: tok }))} />
          <ErrorNote error={err} /><button type="button" className="text-sm text-primary underline" onClick={() => { setErr(null); setStage({ k: 'password' }); }}>{t('login.pw')}</button></div>}
        {stage.k === 'mfa' && <form onSubmit={submitMfa} className="space-y-4"><p>{t('login.mfa')}</p><Input label={t('f.code')} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required /><ErrorNote error={err} /><Button type="submit" loading={busy} className="w-full">{t('a.verify')}</Button></form>}
        {stage.k === 'enrol' && <MfaEnrol pendingId={stage.pendingId} onDone={next} />}
        {stage.k === 'pwchange' && <form onSubmit={submitPwChange} className="space-y-4"><Alert tone="info">Please choose a new password before you continue.</Alert><Input label={t('f.newpw')} type="password" value={np} onChange={(e) => setNp(e.target.value)} autoComplete="new-password" hint="At least 10 characters. Do not use your name or phone number." required minLength={10} /><ErrorNote error={err} /><Button type="submit" loading={busy} className="w-full">{t('a.continue')}</Button></form>}
      </Card>
      <p className="mt-4 text-center text-sm">{t('login.noacct')} <Link href="/register" className="text-primary underline">{t('nav.register')}</Link></p>
    </div>
  );
}
export default function Login() { return <Suspense><LoginForm /></Suspense>; }
