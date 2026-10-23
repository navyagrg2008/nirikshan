'use client';
import { useState } from 'react';
import { download } from '@/lib/api';
import { useAreas, useFetch } from '@/lib/hooks';
import { Alert, Button, Card, Empty, ErrorNote, Input, Loading, Select } from '@/components/ui';

interface Def { id: string; title: string; description: string; filters: ('date' | 'area' | 'status')[]; statusHint: string[] | null }
interface Preview { title: string; columns: { key: string; label: string }[]; rows: (string | number | null)[][]; shown: number; moreAvailable: boolean; generatedAt: string }
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ReportsView() {
  const cat = useFetch<{ items: Def[] }>('/reports'); const areas = useAreas();
  const [id, setId] = useState(''); const today = new Date(); const [from, setFrom] = useState(iso(new Date(today.getTime() - 89 * 864e5))); const [to, setTo] = useState(iso(today));
  const [areaId, setAreaId] = useState(''); const [status, setStatus] = useState('');
  const [out, setOut] = useState<Preview | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  const def = cat.data?.items.find((r) => r.id === id);
  const qs = () => { const p = new URLSearchParams(); if (def?.filters.includes('date')) { p.set('from', from); p.set('to', to); } if (areaId && def?.filters.includes('area')) p.set('areaId', areaId); if (status && def?.filters.includes('status')) p.set('status', status); return p.toString(); };
  const run = async () => { setBusy(true); setErr(null); setNote(''); try { const { get } = await import('@/lib/api'); setOut(await get<Preview>(`/reports/${id}?${qs()}`)); } catch (e) { setErr(e); setOut(null); } finally { setBusy(false); } };
  const save = async (format: 'csv' | 'xlsx' | 'pdf') => { setErr(null); setNote(''); try { const cut = await download(`/reports/${id}/download?${qs()}&format=${format}`, `${id}.${format}`); setNote(cut ? 'The file was cut at the size limit. Narrow the dates or area to get everything.' : 'Download started.'); } catch (e) { setErr(e); } };
  const areaOpts = (areas.data ?? []).filter((a) => a.level !== 'STATE');
  return (
    <div className="space-y-4">
      {cat.loading && <Loading />}<ErrorNote error={cat.error} />
      <Card className="space-y-3">
        <Select label="Report" value={id} onChange={(e) => { setId(e.target.value); setOut(null); setStatus(''); }}>
          <option value="">Choose a report</option>{cat.data?.items.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </Select>
        {def && <p className="text-sm text-muted">{def.description}</p>}
        {def && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {def.filters.includes('date') && <><Input label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></>}
            {def.filters.includes('area') && <Select label="Area" value={areaId} onChange={(e) => setAreaId(e.target.value)}><option value="">All my areas</option>{areaOpts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
            {def.filters.includes('status') && (def.statusHint ? <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>{def.statusHint.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}</Select> : <Input label="Status" value={status} onChange={(e) => setStatus(e.target.value)} />)}
          </div>
        )}
        <div className="flex flex-wrap gap-2"><Button disabled={!id} loading={busy} onClick={run}>Show report</Button>
          {(['csv', 'xlsx', 'pdf'] as const).map((f) => <Button key={f} variant="secondary" disabled={!id} onClick={() => save(f)}>Download {f.toUpperCase()}</Button>)}</div>
        <ErrorNote error={err} />{note && <p role="status" className="text-sm text-muted">{note}</p>}
      </Card>
      {out && (
        <Card className="space-y-2">
          <h2 className="font-semibold">{out.title}</h2>
          {out.moreAvailable && <Alert tone="info">Showing the first {out.shown} rows. Download the file to get every row.</Alert>}
          {out.rows.length === 0 ? <Empty>No rows for these filters.</Empty> : (
            <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{out.title}</caption>
              <thead><tr>{out.columns.map((c) => <th key={c.key} scope="col" className="whitespace-nowrap border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{c.label}</th>)}</tr></thead>
              <tbody>{out.rows.map((r, i) => <tr key={i} className="border-b border-line/60">{r.map((v, j) => <td key={j} className="px-2 py-1.5 align-top">{v ?? '—'}</td>)}</tr>)}</tbody></table></div>
          )}
        </Card>
      )}
    </div>
  );
}
