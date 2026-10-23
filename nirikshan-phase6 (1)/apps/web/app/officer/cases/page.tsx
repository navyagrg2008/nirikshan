'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime, STATUSES, statusLabel, statusTone2, typeLabel } from '@/lib/cases';
import { Badge, Button, Empty, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';
import { Stat } from '@/components/Dashboard';

interface Row { id: string; applicationNo: string; status: string; type: string; dueDate: string | null; instrument: { instrumentNo: string; category: string }; area: string; needsReview: boolean; rescheduleRequested: boolean; visitAt: string | null; sla: { step: string; dueAt: string; state: 'OK' | 'AT_RISK' | 'OVERDUE' } | null }
interface Summary { counts: Record<string, number>; overdue: number; atRisk: number; needsReview: number; rescheduleRequests: number }
export default function Cases() {
  const { t, lang } = useI18n(); const sum = useFetch<Summary>('/officer/cases/summary'); const [status, setStatus] = useState(''); const [sla, setSla] = useState(''); const [q, setQ] = useState('');
  const [items, setItems] = useState<Row[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(async (reset: boolean, cur?: string | null) => {
    setLoading(true); setErr(null);
    try { const p = new URLSearchParams({ limit: '25' }); if (status) p.set('status', status); if (sla) p.set('sla', sla); if (q.trim().length >= 2) p.set('q', q.trim()); if (!reset && cur) p.set('cursor', cur);
      const r = await get<{ items: Row[]; nextCursor: string | null; total: number }>(`/officer/cases?${p}`); setItems((x) => (reset ? r.items : [...x, ...r.items])); setCursor(r.nextCursor); setTotal(r.total); }
    catch (e) { setErr(e); } finally { setLoading(false); }
  }, [status, sla, q]);
  useEffect(() => { const id = setTimeout(() => void load(true), 250); return () => clearTimeout(id); }, [load]);
  const s = sum.data;
  return (
    <div><PageTitle>{t('nav.cases')}</PageTitle>
      <ul className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <li><Stat n={s?.counts.APPLIED ?? '…'} label="Waiting for document check" /></li><li><Stat n={s?.needsReview ?? '…'} label="Need a visit time confirmed" tone={s?.needsReview ? 'warn' : undefined} /></li>
        <li><Stat n={s?.rescheduleRequests ?? '…'} label="Reschedule requests" tone={s?.rescheduleRequests ? 'warn' : undefined} /></li><li><Stat n={s?.atRisk ?? '…'} label="Close to deadline" tone={s?.atRisk ? 'warn' : undefined} /></li><li><Stat n={s?.overdue ?? '…'} label="Past deadline" tone={s?.overdue ? 'warn' : undefined} /></li>
      </ul>
      <div className="mb-4 grid gap-3 sm:grid-cols-3"><Input label="Search application number" value={q} onChange={(e) => setQ(e.target.value)} hint="At least 2 characters" />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x, lang)}</option>)}</Select>
        <Select label="Deadline" value={sla} onChange={(e) => setSla(e.target.value)}><option value="">Any</option><option value="AT_RISK">Close or past</option><option value="OVERDUE">Past deadline</option></Select></div>
      <ErrorNote error={err} />{!loading && items.length === 0 && !err && <Empty>No cases match.</Empty>}
      {items.length > 0 && <><p className="mb-2 text-sm text-muted">{total} case{total === 1 ? '' : 's'}</p><div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">{t('nav.cases')}</caption>
        <thead className="bg-primary-soft"><tr>{['Application', 'Instrument', 'Area', 'Type', 'Status', 'Deadline', 'Visit'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
        <tbody>{items.map((r) => <tr key={r.id} className="border-t border-line hover:bg-paper"><th scope="row" className="p-3 font-medium"><Link className="text-primary underline" href={`/officer/cases/${r.id}`}>{r.applicationNo}</Link></th><td className="p-3">{r.instrument.category}<br /><span className="text-xs text-muted">{r.instrument.instrumentNo}</span></td><td className="p-3">{r.area}</td><td className="p-3">{typeLabel(r.type, lang)}</td>
          <td className="space-y-1 p-3"><Badge tone={statusTone2(r.status)}>{statusLabel(r.status, lang)}</Badge>{r.needsReview && <Badge tone="warn">Confirm time</Badge>}{r.rescheduleRequested && <Badge tone="info">Reschedule asked</Badge>}</td>
          <td className="p-3">{r.sla ? <Badge tone={r.sla.state === 'OK' ? 'ok' : r.sla.state === 'AT_RISK' ? 'warn' : 'danger'}>{r.sla.state === 'OK' ? 'On time' : r.sla.state === 'AT_RISK' ? 'Close' : 'Past'}</Badge> : '—'}</td><td className="p-3">{r.visitAt ? fmtDateTime(r.visitAt, lang) : '—'}</td></tr>)}</tbody></table></div></>}
      {loading && <Loading />}{cursor && !loading && <Button variant="secondary" className="mt-4" onClick={() => load(false, cursor)}>Load more</Button>}
    </div>
  );
}
