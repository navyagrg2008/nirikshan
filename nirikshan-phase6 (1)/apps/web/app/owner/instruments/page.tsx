'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { statusTone, type Instrument } from '@/lib/catalog';
import { Badge, Button, Empty, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';

export default function Instruments() {
  const { t } = useI18n(); const { me } = useSession(); const [items, setItems] = useState<Instrument[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [err, setErr] = useState<unknown>(null);
  const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const load = useCallback(async (reset: boolean, cur?: string | null) => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ limit: '20' }); if (status) p.set('status', status); if (q.trim().length >= 2) p.set('q', q.trim()); if (!reset && cur) p.set('cursor', cur);
      const r = await get<{ items: Instrument[]; nextCursor: string | null }>(`/instruments?${p}`); setItems((x) => (reset ? r.items : [...x, ...r.items])); setCursor(r.nextCursor);
    } catch (e) { setErr(e); } finally { setLoading(false); }
  }, [q, status]);
  useEffect(() => { const id = setTimeout(() => void load(true), 250); return () => clearTimeout(id); }, [load]);
  return (
    <div><PageTitle actions={<div className="flex gap-2"><a href="/api/v1/instruments/export.csv" className="min-h-11 content-center rounded-lg border border-line px-4 text-sm hover:bg-primary-soft">{t('a.export')}</a>{me?.role === 'TRADER' && <Link href="/owner/instruments/bulk" className="min-h-11 content-center rounded-lg border border-line px-4 text-sm hover:bg-primary-soft">Bulk upload</Link>}<Link href="/owner/instruments/new" className="min-h-11 content-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-ink">{t('inst.new')}</Link></div>}>{t('inst.title')}</PageTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_200px]"><Input label="Search serial or make" value={q} onChange={(e) => setQ(e.target.value)} hint="At least 2 characters" />
        <Select label={t('inst.status')} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="REGISTERED">Registered</option><option value="VERIFIED">Verified</option><option value="EXPIRED">Expired</option></Select></div>
      <ErrorNote error={err} />
      {!loading && items.length === 0 && !err && <Empty>{t('inst.none')}</Empty>}
      {items.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">{t('inst.title')}</caption>
        <thead className="bg-primary-soft"><tr>{[t('inst.no'), t('inst.cat'), t('inst.serial'), 'Capacity', t('inst.area'), t('inst.status')].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
        <tbody>{items.map((i) => <tr key={i.id} className="border-t border-line hover:bg-paper"><th scope="row" className="p-3 font-medium"><Link className="text-primary underline" href={`/owner/instruments/${i.id}`}>{i.instrumentNo}</Link></th><td className="p-3">{i.category.name}</td><td className="p-3">{i.serialNo}</td><td className="p-3">{+i.capacity} {i.capacityUnit}</td><td className="p-3">{i.area.name}</td>
          <td className="space-x-1 p-3"><Badge tone={statusTone(i.status)}>{i.status}</Badge>{i.outOfArea && <Badge tone="warn">Outside area</Badge>}{i.ownership === 'ON_BEHALF' && <Badge>For customer</Badge>}</td></tr>)}</tbody></table></div>}
      {loading && <Loading />}
      {cursor && !loading && <Button variant="secondary" className="mt-4" onClick={() => load(false, cursor)}>Load more</Button>}
    </div>
  );
}
