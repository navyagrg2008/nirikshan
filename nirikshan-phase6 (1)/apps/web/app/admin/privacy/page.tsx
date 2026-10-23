'use client';
import { useState } from 'react';
import { del, post, put } from '@/lib/api';
import { BREACH_STEPS } from '@nirikshan/shared';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, PageTitle, Textarea } from '@/components/ui';

interface Dsr { id: string; ref: string; kind: string; status: string; details: string | null; resolution: string | null; dueBy: string; overdue: boolean; createdAt: string; person: string | null; mobile: string | null }
const KIND: Record<string, string> = { ACCESS: 'Copy of data', CORRECTION: 'Correction', ERASURE: 'Erasure', DEACTIVATION: 'Close account' };
const STEP: Record<string, string> = { CONTAIN: 'Contain the incident', ASSESS: 'Assess what data was exposed', NOTIFY_AUTHORITY: 'Notify the authority', NOTIFY_PEOPLE: 'Notify the people affected', PRESERVE_EVIDENCE: 'Preserve evidence', FIX: 'Fix the cause', REVIEW: 'Review and learn' };
type Tab = 'requests' | 'consents' | 'retention' | 'breach';

export default function Privacy() {
  const [tab, setTab] = useState<Tab>('requests');
  const tabs: [Tab, string][] = [['requests', 'Data requests'], ['consents', 'Consents'], ['retention', 'Retention'], ['breach', 'Breach checklist']];
  return (
    <div><PageTitle>Privacy</PageTitle>
      <div role="tablist" aria-label="Privacy" className="mb-4 flex flex-wrap gap-2">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-11 rounded-lg border px-4 text-sm ${tab === k ? 'border-primary bg-primary-soft font-semibold' : 'border-line'}`}>{l}</button>)}</div>
      <div role="tabpanel">{tab === 'requests' ? <Requests /> : tab === 'consents' ? <Consents /> : tab === 'retention' ? <Retention /> : <Breach />}</div>
    </div>
  );
}

function Requests() {
  const [status, setStatus] = useState('ACTIVE'); const list = useFetch<{ items: Dsr[] }>(`/admin/privacy/requests?status=${status}`); const [note, setNote] = useState<Record<string, string>>({}); const [fix, setFix] = useState<Record<string, string>>({}); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState('');
  const resolve = async (r: Dsr, action: 'FULFIL' | 'REJECT') => { setBusy(r.id + action); setErr(null); try { const correction = action === 'FULFIL' && r.kind === 'CORRECTION' && fix[r.id]?.trim() ? { correction: { fullName: fix[r.id]!.trim() } } : {}; await post(`/admin/privacy/requests/${r.id}/resolve`, { action, ...(note[r.id]?.trim() ? { note: note[r.id]!.trim() } : {}), ...correction }, true); await list.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  return (
    <div className="space-y-4">
      <div className="flex gap-2">{[['ACTIVE', 'Waiting'], ['CLOSED', 'Finished'], ['REJECTED', 'Declined']].map(([s, l]) => <Button key={s} variant={status === s ? 'primary' : 'secondary'} onClick={() => setStatus(s!)}>{l}</Button>)}</div>
      {list.loading && !list.data && <Loading />}<ErrorNote error={list.error} /><ErrorNote error={err} />
      {list.data?.items.length === 0 && <Empty>No requests.</Empty>}
      {list.data?.items.map((r) => (
        <Card key={r.id} className="space-y-3"><div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-semibold">{KIND[r.kind] ?? r.kind} <Badge>{r.ref}</Badge> {r.overdue && <Badge tone="danger">Past due date</Badge>}</h2><span className="text-xs text-muted">Raised {fmtDate(r.createdAt)} · due {fmtDate(r.dueBy)}</span></div>
          <p className="text-sm text-muted">{r.person ?? 'Unknown'} · {r.mobile ?? ''}</p>{r.details && <p className="whitespace-pre-line text-sm">{r.details}</p>}
          {r.resolution && <p className="text-sm"><b>Reply sent:</b> {r.resolution}</p>}
          {r.kind === 'ERASURE' && r.status !== 'CLOSED' && <Alert tone="info">Erasure replaces personal details with a placeholder. Records the law requires us to keep (certificates, inspections, audit trail) are kept. It cannot be undone, and it is blocked while the person has open cases.</Alert>}
          {(r.status === 'OPEN' || r.status === 'IN_PROGRESS') && <>
            {r.kind === 'CORRECTION' && <Input label="Corrected full name (optional)" value={fix[r.id] ?? ''} onChange={(e) => setFix({ ...fix, [r.id]: e.target.value })} />}
            <Textarea label="Note to the person (required to decline)" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
            <div className="flex flex-wrap gap-2"><Button loading={busy === r.id + 'FULFIL'} onClick={() => resolve(r, 'FULFIL')}>Carry out</Button><Button variant="danger" loading={busy === r.id + 'REJECT'} disabled={(note[r.id] ?? '').trim().length < 5} onClick={() => resolve(r, 'REJECT')}>Decline</Button></div></>}
        </Card>))}
    </div>
  );
}

function Consents() {
  const [m, setM] = useState(''); const [q, setQ] = useState(''); const list = useFetch<{ summary: { purpose: string; policyVersion: string; granted: number; withdrawn: number }[]; person: { purpose: string; policyVersion: string; grantedAt: string; withdrawnAt: string | null }[] | null }>(`/admin/privacy/consents${q ? `?mobile=${q}` : ''}`);
  const th = (h: string) => <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h}</th>;
  return (
    <div className="space-y-4">
      <Card className="space-y-2"><h2 className="font-semibold">All consents</h2>{list.loading && !list.data && <Loading />}<ErrorNote error={list.error} />
        {list.data && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Consent summary</caption><thead><tr>{['Purpose', 'Notice version', 'Given', 'Withdrawn'].map(th)}</tr></thead>
          <tbody>{list.data.summary.map((c) => <tr key={c.purpose + c.policyVersion} className="border-b border-line/60"><td className="px-2 py-1.5">{c.purpose}</td><td className="px-2 py-1.5">{c.policyVersion}</td><td className="px-2 py-1.5">{c.granted}</td><td className="px-2 py-1.5">{c.withdrawn}</td></tr>)}</tbody></table></div>}</Card>
      <Card className="space-y-3"><h2 className="font-semibold">Look up one person</h2>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setQ(/^[6-9]\d{9}$/.test(m) ? m : ''); }}><div className="w-56"><Input label="Mobile number" inputMode="numeric" maxLength={10} value={m} onChange={(e) => setM(e.target.value.replace(/\D/g, ''))} /></div><Button type="submit" variant="secondary">Search</Button></form>
        {q && list.data?.person?.length === 0 && <Empty>No consent records for this number.</Empty>}
        {list.data?.person && list.data.person.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Consents for this person</caption><thead><tr>{['Purpose', 'Notice version', 'Given', 'Withdrawn'].map(th)}</tr></thead>
          <tbody>{list.data.person.map((c, i) => <tr key={i} className="border-b border-line/60"><td className="px-2 py-1.5">{c.purpose}</td><td className="px-2 py-1.5">{c.policyVersion}</td><td className="px-2 py-1.5">{fmtDate(c.grantedAt)}</td><td className="px-2 py-1.5">{fmtDate(c.withdrawnAt)}</td></tr>)}</tbody></table></div>}</Card>
    </div>
  );
}

function Retention() {
  const r = useFetch<{ schedule: { item: string; keep: string }[]; lastRun: { status: string; startedAt: string; result: Record<string, unknown> | null } | null; kept: { what: string; why: string }[] }>('/admin/privacy/retention');
  return (<div className="space-y-4">{r.loading && !r.data && <Loading />}<ErrorNote error={r.error} />
    {r.data && <><Card className="space-y-2"><h2 className="font-semibold">How long we keep things</h2><div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Retention schedule</caption><thead><tr>{['Data', 'Kept for'].map((h) => <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h}</th>)}</tr></thead>
      <tbody>{r.data.schedule.map((x) => <tr key={x.item} className="border-b border-line/60"><td className="px-2 py-1.5">{x.item}</td><td className="px-2 py-1.5">{x.keep}</td></tr>)}</tbody></table></div></Card>
      <Card className="space-y-1"><h2 className="font-semibold">Last clean-up</h2>{r.data.lastRun ? <p className="text-sm">{r.data.lastRun.status.toLowerCase()} on {fmtDate(r.data.lastRun.startedAt)}{r.data.lastRun.result && <span className="block break-words text-xs text-muted">{JSON.stringify(r.data.lastRun.result)}</span>}</p> : <p className="text-sm text-muted">It has not run yet.</p>}</Card>
      <Card className="space-y-1"><h2 className="font-semibold">Kept even after an erasure request</h2><ul className="list-disc space-y-1 pl-5 text-sm">{r.data.kept.map((k) => <li key={k.what}>{k.what}<span className="block text-xs text-muted">{k.why}</span></li>)}</ul></Card></>}
    <p className="text-sm text-muted">The nightly retention job removes data past its time. Run it now from System.</p></div>);
}

function Breach() {
  const b = useFetch<{ steps: { id: string; done: boolean; at: string | null }[] }>('/admin/privacy/breach'); const [err, setErr] = useState<unknown>(null);
  const toggle = async (step: string, done: boolean) => { setErr(null); try { await put('/admin/privacy/breach', { step, done }); await b.reload(); } catch (e) { setErr(e); } };
  const reset = async () => { setErr(null); try { await del('/admin/privacy/breach'); await b.reload(); } catch (e) { setErr(e); } };
  return (<Card className="space-y-3"><p className="text-sm text-muted">Tick each step as it is done. Every tick is written to the audit trail.</p>{b.loading && !b.data && <Loading />}<ErrorNote error={b.error} /><ErrorNote error={err} />
    {b.data && <ul className="space-y-1">{b.data.steps.map((s) => <li key={s.id}><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="size-5" checked={s.done} onChange={(e) => toggle(s.id, e.target.checked)} /><span>{STEP[s.id] ?? s.id}{s.at && <span className="ml-2 text-xs text-muted">{fmtDate(s.at)}</span>}</span></label></li>)}</ul>}
    <Button variant="ghost" onClick={reset}>Clear checklist</Button></Card>);
}
