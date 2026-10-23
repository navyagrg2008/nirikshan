'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { get, post } from '@/lib/api';
import { useFetch, type Area } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { addDaysStr, fmtDay, fmtTime, istDayOf } from '@/lib/cases';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle, Select, Textarea } from '@/components/ui';

interface Visit { id: string; status: string; applicationId: string; applicationNo: string; inspectorId: string; inspector: string; start: string; end: string; mode: string | null; outOfJurisdiction: boolean; category: string }
interface Avail { id: string; inspectorId: string; kind: string; start: string; end: string; reason: string | null }
interface Cal { visits: Visit[]; availability: Avail[]; holidays: { d: string; name: string }[] }
const monday = (day: string) => { const w = new Date(day + 'T12:00:00Z').getUTCDay(); return addDaysStr(day, -((w + 6) % 7)); };

export default function Schedule() {
  const { t, lang } = useI18n(); const [week, setWeek] = useState(() => monday(addDaysStr(istDayOf(new Date()), 1))); const [cal, setCal] = useState<Cal | null>(null); const [err, setErr] = useState<unknown>(null); const [tick, setTick] = useState(0);
  const days = useMemo(() => Array.from({ length: 7 }, (_, n) => addDaysStr(week, n)), [week]); const inspectors = useFetch<{ id: string; name: string }[]>('/officer/inspectors');
  useEffect(() => { let live = true; setCal(null); get<Cal>(`/officer/schedule?from=${days[0]}&to=${days[6]}`).then((r) => live && setCal(r)).catch((e) => live && setErr(e)); return () => { live = false; }; }, [days, tick]);
  const nameOf = (id: string) => inspectors.data?.find((i) => i.id === id)?.name ?? 'Inspector';
  return (
    <div className="space-y-6"><PageTitle actions={<div className="flex items-center gap-2"><Button variant="secondary" onClick={() => setWeek(addDaysStr(week, -7))}>Previous week</Button><Button variant="secondary" onClick={() => setWeek(monday(addDaysStr(istDayOf(new Date()), 1)))}>This week</Button><Button variant="secondary" onClick={() => setWeek(addDaysStr(week, 7))}>Next week</Button></div>}>{t('nav.schedule')}</PageTitle>
      <ErrorNote error={err} />{!cal && !err && <Loading />}
      {cal && <ol aria-label="Week" className="grid gap-3 md:grid-cols-7">{days.map((d) => { const hol = cal.holidays.find((h) => h.d === d); const vs = cal.visits.filter((v) => istDayOf(new Date(v.start)) === d); const av = cal.availability.filter((a) => istDayOf(new Date(a.start)) <= d && istDayOf(new Date(new Date(a.end).getTime() - 1)) >= d);
        return <li key={d} className="rounded-xl border border-line bg-surface p-3"><h2 className="text-sm font-semibold">{fmtDay(d, lang)}</h2>{hol && <p className="mt-1"><Badge tone="warn">{hol.name}</Badge></p>}
          <ul className="mt-2 space-y-2">{vs.map((v) => <li key={v.id} className="rounded-lg border border-line p-2 text-xs"><p className="font-medium">{fmtTime(v.start, lang)} – {fmtTime(v.end, lang)}</p><Link className="text-primary underline" href={`/officer/cases/${v.applicationId}`}>{v.applicationNo}</Link><p className="text-muted">{v.inspector} · {v.category}</p>{v.mode === 'REVIEW' && <Badge tone="info">Officer set</Badge>}{v.outOfJurisdiction && <Badge tone="warn">Outside area</Badge>}</li>)}
            {av.map((a) => <li key={a.id} className="rounded-lg border border-dashed border-line p-2 text-xs text-muted">{nameOf(a.inspectorId)}: {a.kind === 'CAPACITY_OVERRIDE' ? 'reduced capacity' : a.kind === 'LEAVE' ? 'on leave' : 'unavailable'}</li>)}
            {vs.length === 0 && av.length === 0 && !hol && <li className="text-xs text-muted">No visits</li>}</ul></li>; })}</ol>}
      <Bulk onDone={() => setTick((n) => n + 1)} />
    </div>
  );
}

function Bulk({ onDone }: { onDone: () => void }) {
  const areas = useFetch<Area[]>('/catalog/areas'); const [f, setF] = useState({ areaId: '', date: '', reason: '', notBefore: '' }); const [pv, setPv] = useState<{ count: number; items: { applicationId: string; applicationNo: string; start: string; inspector: string }[] } | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState<number | null>(null);
  const { lang } = useI18n(); const body = () => ({ areaId: f.areaId, date: f.date, reason: f.reason, ...(f.notBefore ? { notBefore: f.notBefore } : {}) });
  const preview = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); setDone(null); try { setPv(await post('/officer/schedule/bulk-reschedule/preview', body())); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const commit = async () => { setBusy(true); setErr(null); try { const r = await post<{ moved: number }>('/officer/schedule/bulk-reschedule', body(), true); setDone(r.moved); setPv(null); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const opts = (areas.data ?? []).filter((a) => a.level !== 'WARD' || true);
  return (
    <Card className="space-y-4"><h2 className="font-semibold">Move every visit on a day</h2><p className="text-sm text-muted">Use this when a day is lost, for example a declared holiday or bad weather. You see the list first. Nothing moves until you confirm.</p>
      <form onSubmit={preview} className="space-y-4"><div className="grid gap-4 sm:grid-cols-3"><Select label="Area" required value={f.areaId} onChange={(e) => setF({ ...f, areaId: e.target.value })}><option value="">Choose…</option>{opts.map((a) => <option key={a.id} value={a.id}>{a.level.toLowerCase()} · {lang === 'hi' && a.nameHi ? a.nameHi : a.name}</option>)}</Select>
        <Input label="Day to clear" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /><Input label="Do not book before (optional)" type="date" value={f.notBefore} onChange={(e) => setF({ ...f, notBefore: e.target.value })} /></div>
        <Textarea label="Reason (recorded)" required minLength={3} maxLength={300} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /><ErrorNote error={err} /><Button type="submit" variant="secondary" loading={busy && !pv}>Show affected visits</Button></form>
      {done !== null && <Alert tone="ok">{done} visit{done === 1 ? '' : 's'} moved. Owners and inspectors have been told about the new times.</Alert>}
      {pv && <div className="space-y-3">{pv.count === 0 ? <Alert tone="info">No visits on that day in this area.</Alert> : <><Alert tone="warn">{pv.count} visit{pv.count === 1 ? '' : 's'} will be moved and their owners notified.</Alert>
        <ul className="max-h-60 divide-y divide-line overflow-auto rounded-lg border border-line text-sm">{pv.items.map((i) => <li key={i.applicationId} className="flex flex-wrap justify-between gap-2 p-2"><span>{i.applicationNo}</span><span className="text-muted">{fmtTime(i.start, lang)} · {i.inspector}</span></li>)}</ul>
        <Button onClick={commit} loading={busy}>Move {pv.count} visit{pv.count === 1 ? '' : 's'}</Button></>}</div>}
    </Card>
  );
}
