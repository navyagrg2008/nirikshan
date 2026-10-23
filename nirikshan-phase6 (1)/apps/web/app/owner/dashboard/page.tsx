'use client';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/cases';
import type { Instrument } from '@/lib/catalog';
import { Dash, Stat } from '@/components/Dashboard';

export default function Page() {
  const { me } = useSession(); const { lang } = useI18n(); const inst = useFetch<{ items: Instrument[]; nextCursor: string | null }>('/instruments?limit=100'); const al = useFetch<{ unread: number }>('/notifications');
  const apps = useFetch<{ items: { id: string; applicationNo: string; status: string; visitAt: string | null }[] }>('/applications?limit=50');
  const items = inst.data?.items ?? []; const more = inst.data?.nextCursor ? '+' : ''; const open = (apps.data?.items ?? []).filter((a) => !['CANCELLED', 'REJECTED', 'APPLICATION_EXPIRED', 'CERTIFICATE_ISSUED'].includes(a.status)); const next = open.filter((a) => a.visitAt).sort((a, b) => a.visitAt!.localeCompare(b.visitAt!))[0];
  return (
    <Dash title={`Welcome${me?.fullName ? ', ' + me.fullName.split(' ')[0] : ''}`} note="Inspection results and certificates arrive in the next releases of this portal. There are no fees.">
      <li><Stat n={`${items.length}${more}`} label="Instruments registered" href="/owner/instruments" /></li>
      <li><Stat n={open.length} label="Applications in progress" href="/owner/applications" /></li>
      <li><Stat n={al.data?.unread ?? 0} label="Unread alerts" href="/owner/notices" /></li>
      {next && <li className="sm:col-span-2 lg:col-span-3"><Link href={`/owner/applications/${next.id}`} className="block rounded-xl border border-line bg-surface p-4 hover:border-primary"><p className="text-xs text-muted">Next visit</p><p className="text-lg font-semibold">{fmtDateTime(next.visitAt, lang)}</p><p className="text-sm text-muted">{next.applicationNo}</p></Link></li>}
      <li className="sm:col-span-2 lg:col-span-3"><Link href="/owner/instruments/new" className="inline-block min-h-11 content-center rounded-lg bg-primary px-5 font-medium text-primary-ink">Add an instrument</Link></li>
    </Dash>
  );
}
