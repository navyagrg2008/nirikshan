'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime, STATUSES, statusLabel, statusTone2, typeLabel } from '@/lib/cases';
import { Badge, Button, Empty, ErrorNote, Loading, PageTitle, Select } from '@/components/ui';

interface Row { id: string; applicationNo: string; status: string; type: string; dueDate: string | null; createdAt: string; instrument: { instrumentNo: string; serialNo: string; category: string }; visitAt: string | null }
export default function Applications() {
  const { t, lang } = useI18n(); const [items, setItems] = useState<Row[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [err, setErr] = useState<unknown>(null); const [status, setStatus] = useState('');
  const load = useCallback(async (reset: boolean, cur?: string | null) => {
    setLoading(true); setErr(null);
    try { const p = new URLSearchParams({ limit: '20' }); if (status) p.set('status', status); if (!reset && cur) p.set('cursor', cur); const r = await get<{ items: Row[]; nextCursor: string | null }>(`/applications?${p}`); setItems((x) => (reset ? r.items : [...x, ...r.items])); setCursor(r.nextCursor); }
    catch (e) { setErr(e); } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { void load(true); }, [load]);
  return (
    <div><PageTitle actions={<Link href="/owner/applications/batch" className="min-h-11 content-center rounded-lg border border-line px-4 text-sm hover:bg-primary-soft">Apply for several instruments</Link>}>{t('nav.applications')}</PageTitle>
      <div className="mb-4 max-w-xs"><Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s, lang)}</option>)}</Select></div>
      <ErrorNote error={err} />{!loading && items.length === 0 && !err && <Empty>No applications yet. Open an instrument and choose “Apply for verification”.</Empty>}
      {items.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">{t('nav.applications')}</caption>
        <thead className="bg-primary-soft"><tr>{['Application', 'Instrument', 'Type', 'Status', 'Visit', 'Due'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
        <tbody>{items.map((r) => <tr key={r.id} className="border-t border-line hover:bg-paper"><th scope="row" className="p-3 font-medium"><Link className="text-primary underline" href={`/owner/applications/${r.id}`}>{r.applicationNo}</Link></th><td className="p-3">{r.instrument.category} · {r.instrument.serialNo}</td><td className="p-3">{typeLabel(r.type, lang)}</td>
          <td className="p-3"><Badge tone={statusTone2(r.status)}>{statusLabel(r.status, lang)}</Badge></td><td className="p-3">{r.visitAt ? fmtDateTime(r.visitAt, lang) : '—'}</td><td className="p-3">{r.dueDate ?? '—'}</td></tr>)}</tbody></table></div>}
      {loading && <Loading />}{cursor && !loading && <Button variant="secondary" className="mt-4" onClick={() => load(false, cursor)}>Load more</Button>}
    </div>
  );
}
