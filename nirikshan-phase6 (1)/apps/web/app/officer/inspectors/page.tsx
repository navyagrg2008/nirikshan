'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { istDayOf } from '@/lib/cases';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, Modal, PageTitle, Select, Textarea } from '@/components/ui';

interface Insp { id: string; name: string; dailyCapacity: number; active: boolean; skills: string[]; today: number; next7Days: number }
export default function Inspectors() {
  const { t } = useI18n(); const q = useFetch<Insp[]>('/officer/inspectors'); const [sel, setSel] = useState<Insp | null>(null); const [msg, setMsg] = useState(''); const today = istDayOf(new Date());
  return (
    <div><PageTitle>{t('nav.inspectors')}</PageTitle>{msg && <div className="mb-4"><Alert tone="ok">{msg}</Alert></div>}
      {q.loading && !q.data && <Loading />}<ErrorNote error={q.error} />{q.data?.length === 0 && <Empty>No inspectors in your area.</Empty>}
      {q.data && q.data.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">{t('nav.inspectors')}</caption>
        <thead className="bg-primary-soft"><tr>{['Inspector', 'Certified for', 'Visits today', 'Next 7 days', 'Daily limit', 'Actions'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
        <tbody>{q.data.map((i) => <tr key={i.id} className="border-t border-line"><th scope="row" className="p-3 font-medium">{i.name}{!i.active && <> <Badge tone="muted">Inactive</Badge></>}</th><td className="p-3">{i.skills.join(', ') || '—'}</td><td className="p-3">{i.today}</td><td className="p-3">{i.next7Days}</td><td className="p-3">{i.dailyCapacity}</td>
          <td className="flex flex-wrap gap-2 p-3"><Button variant="secondary" onClick={() => setSel(i)}>Leave or limit</Button><Link className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 hover:bg-primary-soft" href={`/officer/inspectors/${i.id}/route/${today}`}>Route sheet</Link></td></tr>)}</tbody></table></div>}
      {sel && <AvailModal i={sel} onClose={() => setSel(null)} onDone={(n) => { setSel(null); setMsg(n ? `Saved. ${n} visit${n === 1 ? ' was' : 's were'} moved to other times.` : 'Saved.'); void q.reload(); }} />}
    </div>
  );
}
function AvailModal({ i, onClose, onDone }: { i: Insp; onClose: () => void; onDone: (moved: number) => void }) {
  const [f, setF] = useState({ kind: 'LEAVE', from: '', to: '', cap: '2', reason: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { const r = await post<{ affected: unknown[] }>(`/officer/inspectors/${i.id}/availability`, { kind: f.kind, from: f.from, to: f.to || f.from, reason: f.reason, ...(f.kind === 'CAPACITY_OVERRIDE' ? { dailyCapacity: +f.cap } : {}) }); onDone(r.affected.length); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title={`${i.name}: leave or daily limit`} onClose={onClose}><form onSubmit={go} className="space-y-4"><Select label="What" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="LEAVE">Leave</option><option value="UNAVAILABLE">Unavailable</option><option value="CAPACITY_OVERRIDE">Lower or change daily limit</option></Select>
    <div className="grid gap-4 sm:grid-cols-2"><Input label="From" type="date" required value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="To" type="date" min={f.from} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} hint="Same day if empty" /></div>
    {f.kind === 'CAPACITY_OVERRIDE' && <Input label="Visits per day" type="number" min={0} max={12} value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} />}
    <Textarea label="Reason (recorded)" required minLength={3} maxLength={300} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
    {f.kind !== 'CAPACITY_OVERRIDE' && <p className="text-xs text-muted">Visits already booked in this period are moved automatically and the owners are told.</p>}
    <ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>Save</Button></div></form></Modal>;
}
