'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { fmtDate as fmtDay } from '@/lib/hooks';
import { certStatusLabel, certStatusTone, useTr } from '@/lib/inspection';
import { Badge, Button, Card, Empty, ErrorNote, Input, Loading } from './ui';

interface Row { id: string; certNo: string; status: string; verifiedOn: string; validTill: string; marginal: boolean; instrumentNo: string; category: string; area: string; holderMasked: string; daysRemaining: number }
interface Page { total: number; page: number; perPage: number; items: Row[] }
const TABS: [string, string, string][] = [['ALL', 'All', 'सभी'], ['VALID', 'Valid', 'मान्य'], ['EXPIRING', 'Expiring in 30 days', '30 दिन में समाप्त'], ['EXPIRED', 'Expired', 'समाप्त'], ['SUSPENDED', 'Suspended', 'निलंबित'], ['REVOKED', 'Revoked', 'रद्द']];
export function CertificateRegister({ base, staff }: { base: string; staff?: boolean }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi'; const [tab, setTab] = useState('ALL'); const [text, setText] = useState(''); const [q, setQ] = useState(''); const [page, setPage] = useState(1);
  const r = useFetch<Page>(`/certificates?tab=${tab}&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={tr('Certificate status', 'प्रमाणपत्र की स्थिति')} className="flex flex-wrap gap-2">{TABS.map(([k, en, h]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setPage(1); }} className="min-h-11 rounded-lg border border-line px-3 text-sm aria-selected:border-primary aria-selected:bg-primary-soft aria-selected:font-semibold">{hi ? h : en}</button>)}</div>
      <form onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); setPage(1); }} className="flex flex-wrap items-end gap-2"><div className="w-full max-w-xs"><Input label={tr('Certificate or instrument number', 'प्रमाणपत्र या उपकरण संख्या')} value={text} maxLength={60} onChange={(e) => setText(e.target.value)} /></div><Button type="submit" variant="secondary">{tr('Search', 'खोजें')}</Button></form>
      {r.loading && !r.data && <Loading />}<ErrorNote error={r.error} />
      {r.data?.items.length === 0 && <Empty>{tr('No certificates found.', 'कोई प्रमाणपत्र नहीं मिला।')}</Empty>}
      <ul className="space-y-3">{r.data?.items.map((c) => (
        <li key={c.id}><Card className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono font-semibold">{c.certNo}</p><p className="text-sm text-muted">{c.category} · {c.instrumentNo}{staff ? ` · ${c.holderMasked}` : ''} · {c.area}</p>
          <p className="text-sm">{tr('Valid till', 'मान्य तिथि तक')} {fmtDay(c.validTill, lang)}{c.status === 'VALID' && c.daysRemaining <= 30 ? ` (${c.daysRemaining} ${tr('days left', 'दिन शेष')})` : ''}</p></div>
          <div className="flex items-center gap-3"><Badge tone={certStatusTone(c.status)}>{certStatusLabel(c.status, hi)}</Badge>{c.marginal && <Badge tone="warn">{tr('Marginal', 'सीमांत')}</Badge>}<Link href={`${base}/${c.id}`} className="min-h-11 content-center text-primary underline">{tr('Open', 'खोलें')}</Link></div></Card></li>))}</ul>
      {r.data && r.data.total > r.data.perPage && <div className="flex items-center justify-between"><Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>{tr('Previous', 'पिछला')}</Button><span className="text-sm text-muted">{page} / {Math.ceil(r.data.total / r.data.perPage)}</span><Button variant="secondary" disabled={page * r.data.perPage >= r.data.total} onClick={() => setPage(page + 1)}>{tr('Next', 'अगला')}</Button></div>}
    </div>
  );
}
