'use client';
import { use, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { patch } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { statusTone, type Instrument } from '@/lib/catalog';
import { RequestsPanel } from '@/components/RequestsPanel';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle } from '@/components/ui';

export default function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const { lang } = useI18n(); const q = useFetch<Instrument>(`/instruments/${id}`);
  const [edit, setEdit] = useState(false); const [f, setF] = useState({ model: '', manufactureYear: '', loadCellSerial: '', displayCount: '', address: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [ok, setOk] = useState(false);
  const i = q.data;
  useEffect(() => { if (i) setF({ model: i.model ?? '', manufactureYear: i.manufactureYear?.toString() ?? '', loadCellSerial: i.loadCellSerial ?? '', displayCount: i.displayCount?.toString() ?? '', address: i.address ?? '' }); }, [i]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!i) return; setBusy(true); setErr(null); setOk(false);
    try {
      await patch(`/instruments/${id}`, { model: f.model || null, manufactureYear: f.manufactureYear ? +f.manufactureYear : null, loadCellSerial: f.loadCellSerial || null, displayCount: f.displayCount ? +f.displayCount : null, ...(f.address !== i.address ? { location: { address: f.address, areaId: i.area.id } } : {}) }, i.version);
      await q.reload(); setEdit(false); setOk(true);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (q.loading && !i) return <Loading />;
  if (q.error || !i) return <div><ErrorNote error={q.error} /><Link href="/owner/instruments" className="mt-4 inline-block text-primary underline">Back</Link></div>;
  const rows: [string, string][] = [['Category', i.category.name], ['Capacity', `${+i.capacity} ${i.capacityUnit}`], ['Accuracy class', i.classCode], ['Serial number', i.serialNo], ['Make', i.make], ['Model', i.model ?? '—'], ['Year', i.manufactureYear?.toString() ?? '—'], ['Load cell serial', i.loadCellSerial ?? '—'], ['Display count', i.displayCount?.toString() ?? '—'], ['Area', i.area.name], ['Address', i.address ?? '—'], ['Registered', fmtDate(i.createdAt, lang)], ['First verified', fmtDate(i.firstVerifiedAt, lang)]];
  return (
    <div className="mx-auto max-w-3xl"><Link href="/owner/instruments" className="text-sm text-primary underline">← All instruments</Link>
      <PageTitle actions={<Badge tone={statusTone(i.status)}>{i.status}</Badge>}>{i.instrumentNo}</PageTitle>
      {ok && <div className="mb-4"><Alert tone="ok">Saved.</Alert></div>}{i.outOfArea && <div className="mb-4"><Alert tone="warn">This instrument is outside the area of your business address. An officer may check it.</Alert></div>}
      <Card>{!edit ? <><dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{rows.map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>)}</dl><Button className="mt-5" variant="secondary" onClick={() => setEdit(true)}>Edit details</Button>
        {i.firstVerifiedAt && <p className="mt-3 text-xs text-muted">Category, capacity, serial number and make are locked because this instrument has been verified.</p>}</>
        : <form onSubmit={save} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><Input label="Model" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /><Input label="Year of manufacture" inputMode="numeric" maxLength={4} value={f.manufactureYear} onChange={(e) => setF({ ...f, manufactureYear: e.target.value })} /><Input label="Load cell serial" value={f.loadCellSerial} onChange={(e) => setF({ ...f, loadCellSerial: e.target.value })} /><Input label="Display count" inputMode="numeric" value={f.displayCount} onChange={(e) => setF({ ...f, displayCount: e.target.value })} /></div>
          <Input label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /><ErrorNote error={err} /><div className="flex gap-2"><Button type="submit" loading={busy}>Save</Button><Button type="button" variant="secondary" onClick={() => { setEdit(false); setErr(null); }}>Cancel</Button></div></form>}</Card>
      <RequestsPanel instrumentId={i.id} status={i.status} onChanged={q.reload} />
      <p className="mt-4"><Link href={`/owner/instruments/${i.id}/history`} className="text-sm text-primary underline">History of this instrument</Link></p>
      {i.status !== 'DEREGISTERED' && <div className="mt-5"><Link href={`/owner/instruments/${i.id}/apply`} className="inline-block min-h-11 content-center rounded-lg bg-primary px-5 font-medium text-primary-ink">Apply for verification</Link></div>}
    </div>
  );
}
