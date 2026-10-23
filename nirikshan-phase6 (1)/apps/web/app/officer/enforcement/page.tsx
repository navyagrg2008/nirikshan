'use client';
import { useState } from 'react';
import { download, post } from '@/lib/api';
import { fmtDate, useAreas, useFetch } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';

interface Exp { instrumentId: string; instrumentNo: string; areaId: string; category: string; area: string; firm: string | null; lastValidTill: string | null; daysOverdue: number | null }
interface Drive { id: string; name: string; status: string; createdAt: string; area: string; total: number; stages: Record<string, number> }
interface DriveDetail { id: string; name: string; status: string; area: string; items: { instrumentId: string; instrumentNo: string; category: string; firm: string | null; stage: string; noticeNo: string | null; notifiedAt: string | null; lastValidTill: string | null }[] }
const STAGE: Record<string, [string, 'muted' | 'info' | 'warn' | 'ok' | 'danger']> = { LISTED: ['Listed', 'muted'], NOTIFIED: ['Notice sent', 'info'], APPLIED: ['Applied', 'warn'], VERIFIED: ['Verified again', 'ok'], ESCALATED: ['Escalated', 'danger'] };

export default function Enforcement() {
  const exp = useFetch<{ items: Exp[] }>('/officer/enforcement/expired'); const drives = useFetch<{ items: Drive[] }>('/officer/enforcement/drives'); const areas = useAreas();
  const [sel, setSel] = useState<Set<string>>(new Set()); const [name, setName] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<string | null>(null); const [msg, setMsg] = useState('');
  const detail = useFetch<DriveDetail>(open ? `/officer/enforcement/drives/${open}` : null);
  const items = exp.data?.items ?? []; const areaId = items.find((i) => sel.has(i.instrumentId))?.areaId;
  const toggle = (i: Exp) => { const n = new Set(sel); if (n.has(i.instrumentId)) n.delete(i.instrumentId); else n.add(i.instrumentId); setSel(n); };
  const wrap = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); setErr(null); setMsg(''); try { await f(); setMsg(ok); await Promise.all([exp.reload(), drives.reload(), open ? detail.reload() : Promise.resolve()]); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const create = () => wrap(async () => { const chosen = items.filter((i) => sel.has(i.instrumentId)); const one = new Set(chosen.map((c) => c.areaId)); if (one.size > 1) throw Object.assign(new Error('One drive covers one area. Select instruments from a single area.'), { code: 'MULTIPLE_AREAS' }); const r = await post<{ id: string }>('/officer/enforcement/drives', { name, areaId: chosen[0]!.areaId, instrumentIds: chosen.map((c) => c.instrumentId) }, true); setSel(new Set()); setName(''); setOpen(r.id); }, 'Drive created.');
  void areas;
  return (
    <div className="space-y-6"><PageTitle>Enforcement</PageTitle>
      <p className="max-w-prose text-sm text-muted">Instruments whose verification has lapsed. Pick the ones to chase, start a drive, send notices, and follow each one until it is verified again. Nothing here is a fine or a payment.</p>
      <ErrorNote error={err} />{msg && <p role="status" className="text-sm text-ok">{msg}</p>}
      <Card className="space-y-3">
        <h2 className="font-semibold">Lapsed instruments not in a drive ({items.length})</h2>
        {exp.loading && !exp.data && <Loading />}<ErrorNote error={exp.error} />
        {exp.data && items.length === 0 && <Empty>Nothing lapsed outside a drive.</Empty>}
        {items.length > 0 && (
          <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Lapsed instruments</caption>
            <thead><tr>{['Select', 'Instrument', 'Owner', 'Area', 'Lapsed on', 'Days overdue'].map((h) => <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h}</th>)}</tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.instrumentId} className="border-b border-line/60">
                <td className="px-2 py-1.5"><input type="checkbox" className="size-5" aria-label={`Select ${i.instrumentNo}`} checked={sel.has(i.instrumentId)} disabled={!!areaId && areaId !== i.areaId} onChange={() => toggle(i)} /></td>
                <td className="px-2 py-1.5">{i.instrumentNo}<div className="text-xs text-muted">{i.category}</div></td><td className="px-2 py-1.5">{i.firm ?? '—'}</td><td className="px-2 py-1.5">{i.area}</td><td className="px-2 py-1.5">{fmtDate(i.lastValidTill)}</td><td className="px-2 py-1.5">{i.daysOverdue ?? 'never verified'}</td></tr>))}</tbody></table></div>
        )}
        {sel.size > 0 && (
          <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3"><div className="min-w-60 flex-1"><Input label={`Name this drive (${sel.size} selected)`} value={name} onChange={(e) => setName(e.target.value)} hint="For example: Sadar bazaar scales, October" /></div><Button disabled={name.trim().length < 3} loading={busy} onClick={create}>Start drive</Button></div>
        )}
        {areaId && <p className="text-xs text-muted">Instruments from other areas are greyed out because one drive covers one area.</p>}
      </Card>
      <section aria-labelledby="dr" className="space-y-3"><h2 id="dr" className="font-semibold">Drives</h2>
        {drives.loading && !drives.data && <Loading />}{drives.data?.items.length === 0 && <Empty>No drives yet.</Empty>}
        {drives.data?.items.map((d) => (
          <Card key={d.id} className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{d.name} {d.status === 'CLOSED' && <Badge>Closed</Badge>}</h3><p className="text-sm text-muted">{d.area} · started {fmtDate(d.createdAt)} · {d.total} instruments</p></div>
              <Button variant="secondary" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'Hide' : 'Open'}</Button></div>
            <ul className="flex flex-wrap gap-2 text-xs">{Object.entries(STAGE).map(([k, [l, tone]]) => <li key={k}><Badge tone={tone}>{l}: {d.stages[k] ?? 0}</Badge></li>)}</ul>
            {open === d.id && (
              <div className="space-y-3 border-t border-line pt-3">
                {detail.loading && <Loading />}
                {detail.data && <>
                  {detail.data.status === 'OPEN' && <div className="flex flex-wrap gap-2">
                    <Button loading={busy} disabled={!detail.data.items.some((i) => i.stage === 'LISTED')} onClick={() => wrap(() => post(`/officer/enforcement/drives/${d.id}/notices`, {}, true), 'Notices sent to the owners.')}>Send notices</Button>
                    <Button variant="secondary" onClick={() => wrap(() => download(`/officer/enforcement/drives/${d.id}/notices.pdf`, 'notices.pdf'), 'Printable letters downloaded.')}>Download letters (PDF)</Button>
                    <Button variant="ghost" loading={busy} onClick={() => wrap(() => post(`/officer/enforcement/drives/${d.id}/close`, {}, true), 'Drive closed.')}>Close drive</Button></div>}
                  <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Drive items</caption>
                    <thead><tr>{['Instrument', 'Owner', 'Notice', 'Stage', ''].map((h, i) => <th key={i} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h || <span className="sr-only">Action</span>}</th>)}</tr></thead>
                    <tbody>{detail.data.items.map((i) => (
                      <tr key={i.instrumentId} className="border-b border-line/60"><td className="px-2 py-1.5">{i.instrumentNo}<div className="text-xs text-muted">{i.category}</div></td><td className="px-2 py-1.5">{i.firm ?? '—'}</td><td className="px-2 py-1.5">{i.noticeNo ?? '—'}{i.notifiedAt && <div className="text-xs text-muted">{fmtDate(i.notifiedAt)}</div>}</td>
                        <td className="px-2 py-1.5"><Badge tone={STAGE[i.stage]?.[1]}>{STAGE[i.stage]?.[0] ?? i.stage}</Badge></td>
                        <td className="px-2 py-1.5">{detail.data!.status === 'OPEN' && i.stage === 'NOTIFIED' && <Button variant="secondary" onClick={() => wrap(() => post(`/officer/enforcement/drives/${d.id}/escalate`, { instrumentId: i.instrumentId }, true), 'Marked as escalated.')}>Escalate</Button>}</td></tr>))}</tbody></table></div>
                  <Alert tone="info">Escalate when an owner has ignored the notice. The record stays on file for the senior officer.</Alert></>}
              </div>
            )}
          </Card>))}
      </section>
    </div>
  );
}
