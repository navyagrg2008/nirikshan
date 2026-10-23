'use client';
import Link from 'next/link';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorText, useI18n } from '@/lib/i18n';
import type { Instrument } from '@/lib/catalog';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Loading, PageTitle, Select } from '@/components/ui';

export default function Batch() {
  const { me } = useSession(); const { lang } = useI18n(); const q = useFetch<{ items: Instrument[] }>('/instruments?limit=100'); const [sel, setSel] = useState<Set<string>>(new Set()); const [type, setType] = useState('NEW'); const [ok, setOk] = useState(false);
  const [res, setRes] = useState<{ created: { instrumentId: string; id: string; applicationNo: string }[]; failed: { instrumentId: string; code: string }[] } | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  if (me && me.role !== 'TRADER') return <Alert tone="info">Applying for several instruments at once is for traders. Open an instrument to apply for it.</Alert>;
  const open = (q.data?.items ?? []).filter((i) => i.status !== 'DEREGISTERED');
  const go = async () => { setBusy(true); setErr(null); try { setRes(await post('/applications/batch', { instrumentIds: [...sel], type, declarationAccepted: true }, true)); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const name = (id: string) => open.find((i) => i.id === id)?.instrumentNo ?? id;
  return (
    <div className="mx-auto max-w-3xl space-y-5"><Link href="/owner/applications" className="text-sm text-primary underline">← All applications</Link><PageTitle>Apply for several instruments</PageTitle>
      <Alert tone="info">Choose instruments of the same category in the same area. Each instrument gets its own application and its own documents.</Alert>
      {q.loading && <Loading />}{!q.loading && open.length === 0 && <Empty>No instruments to apply for.</Empty>}
      {open.length > 0 && !res && <Card className="space-y-4"><Select label="Type" value={type} onChange={(e) => setType(e.target.value)}><option value="NEW">New verification</option><option value="RENEWAL">Renewal</option><option value="RE_VERIFICATION">Re-verification</option></Select>
        <fieldset><legend className="mb-2 text-sm font-medium">Instruments</legend><ul className="divide-y divide-line">{open.map((i) => <li key={i.id}><label className="flex min-h-11 items-center gap-3 py-2 text-sm"><input type="checkbox" className="size-5" checked={sel.has(i.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(i.id); else n.delete(i.id); setSel(n); }} /><span className="font-medium">{i.instrumentNo}</span><span>{i.category.name} · {i.serialNo} · {i.area.name}</span><Badge>{i.status}</Badge></label></li>)}</ul></fieldset>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-5" checked={ok} onChange={(e) => setOk(e.target.checked)} /><span>I confirm the details are correct and the instruments will be ready and accessible for the visit. No fee applies.</span></label>
        <ErrorNote error={err} /><Button onClick={go} loading={busy} disabled={!ok || sel.size === 0}>Apply for {sel.size || ''} selected</Button></Card>}
      {res && <Card className="space-y-3"><h2 className="font-semibold">Done</h2>
        {res.created.length > 0 && <ul className="space-y-1 text-sm">{res.created.map((c) => <li key={c.id}><Badge tone="ok">Applied</Badge> {name(c.instrumentId)} · <Link className="text-primary underline" href={`/owner/applications/${c.id}`}>{c.applicationNo}</Link></li>)}</ul>}
        {res.failed.length > 0 && <ul className="space-y-1 text-sm">{res.failed.map((f) => <li key={f.instrumentId}><Badge tone="danger">Not applied</Badge> {name(f.instrumentId)} · {errorText(f.code, lang)}</li>)}</ul>}
        <Link className="inline-block text-primary underline" href="/owner/applications">Go to applications</Link></Card>}
    </div>
  );
}
