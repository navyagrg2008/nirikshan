'use client';
import { useEffect, useState } from 'react';
import type { IntervalRow, MpeRow, RuleContent, RuleDiff, SlaRow } from '@nirikshan/shared';
import { del, post, put } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, PageTitle, Select, Textarea } from '@/components/ui';

interface Item { id: string; version: number; status: string; effectiveFrom: string; effectiveTo: string | null; authoredBy: string | null; reviewedBy: string | null; pinnedCases: number; mpeRows: number; intervalRows: number }
interface Names { categories: Record<string, string>; classes: Record<string, string>; bands: Record<string, { categoryId: string; label: string }> }
interface Detail extends Item { note: string | null; reviewRemark: string | null; authoredById: string | null; content: RuleContent; names: Names; diff: RuleDiff | null; comparedWith: { id: string; version: number } | null; coverageGaps: { mpe: string[]; intervals: string[]; slas: string[] } | null; canEdit: boolean }
interface Plan { from: string; to: string | null; closes: { version: number; newEffectiveTo: string }[]; blocks: { version: number; effectiveFrom: string; effectiveTo: string | null }[]; inPast: boolean; publishable: boolean }
const TONE: Record<string, 'ok' | 'warn' | 'info' | 'muted'> = { PUBLISHED: 'ok', DRAFT: 'warn', IN_REVIEW: 'info', RETIRED: 'muted' };
const STEP: Record<string, string> = { DOCUMENT_CHECK: 'Document check', SCHEDULE: 'Schedule a visit', DECISION: 'Decision' };

export default function Rules() {
  const list = useFetch<{ items: Item[] }>('/admin/rules'); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [from, setFrom] = useState('');
  const hasDraft = list.data?.items.some((i) => i.status === 'DRAFT' || i.status === 'IN_REVIEW');
  const create = async () => { setBusy(true); setErr(null); try { const r = await post<{ id: string }>('/admin/rules', { effectiveFrom: from }, true); await list.reload(); setOpen(r.id); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (open) return <Editor id={open} onBack={() => { setOpen(null); list.reload(); }} />;
  return (
    <div className="space-y-4"><PageTitle>Rules</PageTitle>
      <p className="max-w-prose text-sm text-muted">The limits of error, re-verification intervals and deadlines. A published version never changes. To change a rule, copy the current version into a draft, edit it, and have a second admin review it before it is published.</p>
      {list.loading && !list.data && <Loading />}<ErrorNote error={list.error} /><ErrorNote error={err} />
      {!hasDraft && list.data && <Card className="flex flex-wrap items-end gap-3"><div className="w-48"><Input label="New version starts on" type="date" value={from} onChange={(e) => setFrom(e.target.value)} hint="Tomorrow or later" /></div><Button disabled={!from} loading={busy} onClick={create}>Start a draft from the current version</Button></Card>}
      {list.data?.items.length === 0 && <Empty>No rule sets.</Empty>}
      {list.data?.items.map((r) => (
        <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Version {r.version} <Badge tone={TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Badge></h2>
          <p className="text-sm text-muted">From {fmtDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${fmtDate(r.effectiveTo)}` : ' onwards'} · {r.mpeRows} error limits, {r.intervalRows} intervals · {r.pinnedCases} cases use it{r.authoredBy && ` · written by ${r.authoredBy}`}</p></div>
          <Button variant="secondary" onClick={() => setOpen(r.id)}>{r.status === 'DRAFT' ? 'Edit' : 'Open'}</Button></Card>))}
    </div>
  );
}

function Editor({ id, onBack }: { id: string; onBack: () => void }) {
  const { me } = useSession(); const d = useFetch<Detail>(`/admin/rules/${id}`); const [c, setC] = useState<RuleContent | null>(null); const [eff, setEff] = useState(''); const [note, setNote] = useState(''); const [dirty, setDirty] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(''); const [remark, setRemark] = useState(''); const [msg, setMsg] = useState('');
  useEffect(() => { if (d.data && !dirty) { setC(d.data.content); setEff(d.data.effectiveFrom); setNote(d.data.note ?? ''); } }, [d.data, dirty]);
  const x = d.data; const nm = x?.names;
  useEffect(() => { if (x && (x.status === 'IN_REVIEW' || x.status === 'DRAFT')) import('@/lib/api').then(({ get }) => get<Plan>(`/admin/rules/${id}/preflight`).then(setPlan).catch(() => undefined)); }, [x?.status, x?.effectiveFrom, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, f: () => Promise<unknown>, ok?: string) => { setBusy(key); setErr(null); setMsg(''); try { await f(); if (ok) setMsg(ok); setDirty(false); await d.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  const catName = (i: string) => nm?.categories[i] ?? i.slice(0, 6); const band = (i: string) => nm?.bands[i]?.label ?? i.slice(0, 6); const cls = (i: string) => nm?.classes[i] ?? i.slice(0, 6);
  const setMpe = (i: number, p: Partial<MpeRow>) => { setDirty(true); setC((v) => v && { ...v, mpe: v.mpe.map((r, j) => (j === i ? { ...r, ...p } : r)) }); };
  const setIv = (i: number, p: Partial<IntervalRow>) => { setDirty(true); setC((v) => v && { ...v, intervals: v.intervals.map((r, j) => (j === i ? { ...r, ...p } : r)) }); };
  const setSla = (i: number, p: Partial<SlaRow>) => { setDirty(true); setC((v) => v && { ...v, slas: v.slas.map((r, j) => (j === i ? { ...r, ...p } : r)) }); };
  const mine = !!x && x.authoredById === me?.id; const th = (h: string) => <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h}</th>;
  const editable = !!x?.canEdit;
  return (
    <div className="space-y-4"><Button variant="ghost" onClick={onBack}>← All versions</Button>
      {d.loading && !x && <Loading />}<ErrorNote error={d.error} /><ErrorNote error={err} />{msg && <p role="status" className="text-sm text-ok">{msg}</p>}
      {x && c && <>
        <PageTitle>Version {x.version} <Badge tone={TONE[x.status]}>{x.status.replace('_', ' ').toLowerCase()}</Badge></PageTitle>
        {x.reviewRemark && <Alert tone="warn"><b>Reviewer's note:</b> {x.reviewRemark}</Alert>}
        {x.diff && <Card className="space-y-2"><h2 className="font-semibold">What changes{x.comparedWith && ` from version ${x.comparedWith.version}`}</h2>
          <p className="text-sm">{x.diff.counts.changed} changed, {x.diff.counts.added} added, {x.diff.counts.removed} removed.</p>
          {x.diff.mpe.changed.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{x.diff.mpe.changed.map((ch) => <li key={ch.key}>Error limit, {catName(ch.to.categoryId)} {band(ch.to.capacityBandId)} class {cls(ch.to.accuracyClassId)}: {ch.fields.map((f) => `${f} ${String(ch.from[f as keyof MpeRow])} → ${String(ch.to[f as keyof MpeRow])}`).join(', ')}</li>)}</ul>}
          {x.diff.intervals.changed.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{x.diff.intervals.changed.map((ch) => <li key={ch.key}>Interval, {catName(ch.to.categoryId)} {band(ch.to.capacityBandId)}: {ch.fields.map((f) => `${f} ${String(ch.from[f as keyof IntervalRow])} → ${String(ch.to[f as keyof IntervalRow])}`).join(', ')}</li>)}</ul>}
          {x.diff.slas.changed.length > 0 && <ul className="list-disc pl-5 text-sm">{x.diff.slas.changed.map((ch) => <li key={ch.key}>{STEP[ch.to.step] ?? ch.to.step}: {ch.from.maxHours} → {ch.to.maxHours} hours</li>)}</ul>}
          {x.diff.mpe.added.length + x.diff.intervals.added.length > 0 && <p className="text-sm">New rows: {x.diff.mpe.added.length} error limits, {x.diff.intervals.added.length} intervals.</p>}
          {x.coverageGaps && x.coverageGaps.mpe.length + x.coverageGaps.intervals.length + x.coverageGaps.slas.length > 0 && <Alert tone="danger">This draft leaves out rules the current version has ({x.coverageGaps.mpe.length} error limits, {x.coverageGaps.intervals.length} intervals, {x.coverageGaps.slas.length} deadlines). It cannot be sent for review until they are restored.</Alert>}
        </Card>}
        {editable && <Card className="grid gap-3 sm:grid-cols-2"><Input label="Starts on" type="date" value={eff} onChange={(e) => { setEff(e.target.value); setDirty(true); }} hint="Tomorrow or later" /><Textarea label="Note" value={note} maxLength={500} onChange={(e) => { setNote(e.target.value); setDirty(true); }} /></Card>}
        <Card className="space-y-2"><h2 className="font-semibold">Error limits ({c.mpe.length})</h2>
          <div className="max-h-[28rem] overflow-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Error limits</caption><thead><tr>{['Category', 'Capacity', 'Class', 'Direction', 'Limit', 'Unit', 'Marginal %', ''].map((h, i) => th(h || String(i)))}</tr></thead>
            <tbody>{c.mpe.map((r, i) => <tr key={i} className="border-b border-line/60"><td className="px-2 py-1">{catName(r.categoryId)}</td><td className="px-2 py-1">{band(r.capacityBandId)}</td><td className="px-2 py-1">{cls(r.accuracyClassId)}</td>
              <td className="px-2 py-1">{editable ? <select aria-label={`Direction, row ${i + 1}`} className="min-h-9 rounded border border-line bg-surface px-1" value={r.direction} onChange={(e) => setMpe(i, { direction: e.target.value as MpeRow['direction'] })}><option value="PLUS_MINUS">±</option><option value="PLUS">+</option><option value="MINUS">−</option></select> : r.direction === 'PLUS_MINUS' ? '±' : r.direction === 'PLUS' ? '+' : '−'}</td>
              <td className="px-2 py-1">{editable ? <input aria-label={`Limit, row ${i + 1}`} className="min-h-9 w-24 rounded border border-line bg-surface px-1" inputMode="decimal" value={r.value} onChange={(e) => setMpe(i, { value: e.target.value })} /> : Number(r.value)}</td><td className="px-2 py-1">{r.unit}</td>
              <td className="px-2 py-1">{editable ? <input aria-label={`Marginal percent, row ${i + 1}`} className="min-h-9 w-20 rounded border border-line bg-surface px-1" inputMode="decimal" value={r.marginalPct} onChange={(e) => setMpe(i, { marginalPct: e.target.value })} /> : Number(r.marginalPct)}</td>
              <td className="px-2 py-1">{editable && <Button variant="ghost" aria-label={`Remove row ${i + 1}`} onClick={() => { setDirty(true); setC({ ...c, mpe: c.mpe.filter((_, j) => j !== i) }); }}>Remove</Button>}</td></tr>)}</tbody></table></div></Card>
        <Card className="space-y-2"><h2 className="font-semibold">Re-verification intervals ({c.intervals.length})</h2>
          <div className="max-h-96 overflow-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Intervals</caption><thead><tr>{['Category', 'Capacity', 'Months', 'Months if marginal', 'Grace days', 'Apply within days'].map(th)}</tr></thead>
            <tbody>{c.intervals.map((r, i) => <tr key={i} className="border-b border-line/60"><td className="px-2 py-1">{catName(r.categoryId)}</td><td className="px-2 py-1">{band(r.capacityBandId)}</td>
              {(['months', 'marginalMonths', 'graceDays', 'applicationWindowDays'] as const).map((f) => <td key={f} className="px-2 py-1">{editable ? <input type="number" aria-label={`${f}, row ${i + 1}`} className="min-h-9 w-20 rounded border border-line bg-surface px-1" value={r[f] ?? ''} onChange={(e) => setIv(i, { [f]: e.target.value === '' && f === 'marginalMonths' ? null : Number(e.target.value) } as Partial<IntervalRow>)} /> : (r[f] ?? '—')}</td>)}</tr>)}</tbody></table></div></Card>
        <Card className="space-y-2"><h2 className="font-semibold">Officer deadlines</h2>
          <table className="text-sm"><caption className="sr-only">Deadlines</caption><thead><tr>{['Step', 'Hours allowed'].map(th)}</tr></thead><tbody>{c.slas.map((r, i) => <tr key={r.step}><td className="px-2 py-1">{STEP[r.step] ?? r.step}</td><td className="px-2 py-1">{editable ? <input type="number" aria-label={`${STEP[r.step] ?? r.step} hours`} className="min-h-9 w-24 rounded border border-line bg-surface px-1" value={r.maxHours} onChange={(e) => setSla(i, { maxHours: Number(e.target.value) })} /> : r.maxHours}</td></tr>)}</tbody></table></Card>

        <Card className="space-y-3"><h2 className="font-semibold">Next step</h2>
          {x.status === 'DRAFT' && <div className="flex flex-wrap gap-2">
            <Button loading={busy === 'save'} disabled={!dirty} onClick={() => run('save', () => put(`/admin/rules/${id}/draft`, { effectiveFrom: eff, note: note || undefined, mpe: c.mpe, intervals: c.intervals, slas: c.slas }), 'Draft saved.')}>Save draft</Button>
            <Button variant="secondary" loading={busy === 'rev'} disabled={dirty} onClick={() => run('rev', () => post(`/admin/rules/${id}/request-review`, {}, true), 'Sent for review.')}>Send for review</Button>
            <Button variant="danger" loading={busy === 'del'} onClick={() => run('del', async () => { await del(`/admin/rules/${id}`); onBack(); })}>Discard draft</Button>
            {dirty && <p className="w-full text-xs text-muted">Save your changes before sending for review.</p>}</div>}
          {x.status === 'IN_REVIEW' && !x.reviewedBy && (mine ? <Alert tone="info">Waiting for a different admin to review this. You wrote it, so you cannot review it.</Alert> : <>
            <Textarea label="Remark (required to send back)" value={remark} onChange={(e) => setRemark(e.target.value)} />
            <div className="flex flex-wrap gap-2"><Button loading={busy === 'ap'} onClick={() => run('ap', () => post(`/admin/rules/${id}/review`, { outcome: 'APPROVE', ...(remark ? { remark } : {}) }, true), 'Approved.')}>Approve</Button><Button variant="danger" loading={busy === 'rt'} disabled={remark.trim().length < 5} onClick={() => run('rt', () => post(`/admin/rules/${id}/review`, { outcome: 'RETURN', remark }, true), 'Sent back to the author.')}>Send back</Button></div></>)}
          {x.status === 'IN_REVIEW' && x.reviewedBy && <>
            <p className="text-sm">Reviewed by {x.reviewedBy}. Publishing makes this version the rule from {fmtDate(x.effectiveFrom)}; it cannot be edited afterwards.</p>
            {plan?.closes.map((p) => <Alert key={p.version} tone="info">Version {p.version} will end on {fmtDate(p.newEffectiveTo)}.</Alert>)}
            {plan?.blocks.map((p) => <Alert key={p.version} tone="danger">Clashes with version {p.version} ({fmtDate(p.effectiveFrom)}{p.effectiveTo ? ` to ${fmtDate(p.effectiveTo)}` : ' onwards'}). Change the start date or retire that version.</Alert>)}
            {plan?.inPast && <Alert tone="danger">The start date is no longer in the future.</Alert>}
            <Button disabled={!plan?.publishable} loading={busy === 'pub'} onClick={() => run('pub', () => post(`/admin/rules/${id}/publish`, {}, true), 'Published.')}>Publish</Button></>}
          {(x.status === 'PUBLISHED' || x.status === 'RETIRED') && <p className="text-sm text-muted">This version is fixed. {x.pinnedCases} cases were decided under it and will always be judged by it.</p>}
        </Card>
      </>}
    </div>
  );
}
