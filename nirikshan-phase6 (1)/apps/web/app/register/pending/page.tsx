'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { Alert, Card, Loading, Seal } from '@/components/ui';

export default function Pending() {
  const { t } = useI18n(); const { me, loading, refresh } = useSession(); const router = useRouter();
  useEffect(() => { if (!loading && !me) router.replace('/login'); else if (me?.accountStatus === 'ACTIVE') router.replace(me.home); }, [loading, me, router]);
  if (loading || !me) return <Loading />;
  return (
    <div className="mx-auto max-w-lg"><Card className="space-y-4 text-center"><div className="mx-auto w-fit"><Seal size={64} /></div>
      {me.accountStatus === 'REJECTED' ? <Alert>Your registration was not approved. Please contact the office through the Help page.</Alert> : <><h1 className="text-2xl font-semibold">{t('pending.title')}</h1><p className="text-muted">{t('pending.body')}</p></>}
      <p className="text-sm text-muted">Signed in as {me.fullName} ({me.mobileMasked})</p>
      <button onClick={() => refresh()} className="min-h-11 rounded-lg border border-line px-4 hover:bg-primary-soft">Check again</button></Card></div>
  );
}
