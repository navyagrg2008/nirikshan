'use client';
import { use, useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { get, post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { actionLabel, fmtDateTime, fmtDay, fmtWindow, istLocalToIso, PART_LABEL, reasonLabel, statusLabel, statusTone2, typeLabel, type AppDetail, type Breakdown, type OwnerDoc } from '@/lib/cases';
import { InspectionPanel } from '@/components/InspectionPanel';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, Modal, PageTitle, Select, Textarea } from '@/components/ui';

interface Insp { id: string; name: string; skills: string[]; dailyCapacity: number; today: number; next7Days: number; active: boolean }
const REASONS = [['DOC_ILLEGIBLE', 'Not readable'], ['DOC_EXPIRED', 'Expired']];

export default function Case({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const { lang } = useI18n(); const [d, setD] = useState<AppDetail | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null); const [modal, setModal] = useState<null | 'assign' | 'reschedule' | 'decline'>(null); const [flag, setFlag] = useState<OwnerDoc | null>(null); const [msg, setMsg] = useState('');
  const load = useCallback(async () => { try { setD(await get<AppDetail>(`/officer/cases/${id}`)); setErr(null); } catch (e) { setErr(e); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (key: string, path: string, body: unknown = {}, ok = '') => { setBusy(key); setErr(null); setMsg(''); try { const r = await post<Record<string, unknown>>(`/officer/cases/${id}/${path}`, body, true); setMsg(ok || summarise(r)); await load(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const open = async (docId: string) => { try { const r = await get<{ url: string }>(`/applications/${id}/documents/${docId}/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  if (!d) return err ? <ErrorNote error={err} /> : <Loading />;
  const canCheck = d.status === 'APPLIED'; const req = d.rescheduleRequest?.status === 'OPEN';
  return (
    <div className="mx-auto max-w-5xl space-y-5"><Link href="/officer/cases" className="text-sm text-primary underline">← All cases</Link>
      <PageTitle actions={<Badge tone={statusTone2(d.status)}>{statusLabel(d.status, lang)}</Badge>}>{d.applicationNo}</PageTitle>
      <p className="-mt-3 text-muted">{typeLabel(d.type, lang)} · {d.instrument.category} · {d.instrument.instrumentNo} · serial {d.instrument.serialNo} · {d.area.name} · due {fmtDay(d.dueDate, lang)}</p>
      <ErrorNote error={err} />{msg && <Alert tone="ok">{msg}</Alert>}
      <Card className="space-y-3"><h2 className="font-semibold">Documents</h2>
        <ul className="divide-y divide-line">{d.documents.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-medium">{x.nameEn} {x.required && <span className="text-xs text-muted">(required)</span>}</p>
            {x.current ? <p className="text-xs text-muted">Version {x.current.version} · uploaded {fmtDateTime(x.current.uploadedAt, lang)}{x.current.comment ? ` · flagged: ${x.current.comment}` : ''}</p> : <p className="text-xs text-warn">Not uploaded</p>}</div>
            <div className="flex flex-wrap items-center gap-2">{x.current && <><Badge tone={x.current.review === 'ACCEPTED' ? 'ok' : x.current.review === 'FLAGGED' ? 'danger' : 'info'}>{x.current.review === 'PENDING' ? 'To check' : x.current.review === 'ACCEPTED' ? 'Accepted' : 'Flagged'}</Badge>
              <Button variant="secondary" onClick={() => open(x.current!.id)}>View</Button>
              {canCheck && <><Button variant="secondary" loading={busy === 'a' + x.id} onClick={() => act('a' + x.id, `documents/${x.current!.id}/review`, { status: 'ACCEPTED' }, 'Document accepted.')} disabled={x.current.review === 'ACCEPTED'}>Accept</Button><Button variant="secondary" onClick={() => setFlag(x)}>Flag</Button></>}</>}</div></li>))}</ul>
        <p className="text-xs text-muted">Viewing a file is recorded in the audit trail.</p>
        {canCheck && <Button loading={busy === 'check'} onClick={() => act('check', 'document-check-complete', {}, '')}>Document check complete</Button>}
      </Card>
      {(d.status === 'DOCUMENT_CHECKED' || d.status === 'FAILED_ATTEMPT' || d.status === 'SCHEDULED') && <Card className="space-y-3"><h2 className="font-semibold">Visit</h2>
        {d.visit && <div className="space-y-2"><p className="text-lg font-medium">{fmtWindow(d.visit.start, d.visit.end, lang)}</p>
          <p className="text-sm text-muted">{d.scheduleMode === 'AUTO' ? 'Assigned automatically.' : 'Confirmed by an officer.'}{d.visit.outOfJurisdiction && ' Inspector is from outside this area (reason recorded).'}</p>
          {d.visit.breakdown?.parts && <Breakdown b={d.visit.breakdown} />}</div>}
        {d.proposal && <div className="space-y-2"><Alert tone="warn">This case needs an officer to confirm the visit. {d.proposal.reasons.map(reasonLabel).join('. ')}.</Alert>
          {d.proposal.start && d.proposal.end && <p>Suggested: <b>{fmtWindow(d.proposal.start, d.proposal.end, lang)}</b></p>}{d.proposal.breakdown?.parts && <Breakdown b={d.proposal.breakdown} />}
          <div className="flex flex-wrap gap-2">{d.proposal.start && <Button loading={busy === 'acc'} onClick={() => act('acc', 'proposal/accept', {}, 'Visit confirmed.')}>Accept suggestion</Button>}<Button variant="secondary" onClick={() => setModal('assign')}>Choose inspector and time</Button><Button variant="secondary" loading={busy === 'rerun'} onClick={() => act('rerun', 'schedule', {})}>Try automatic again</Button></div></div>}
        {!d.visit && !d.proposal && d.status !== 'SCHEDULED' && <div className="flex flex-wrap gap-2"><Button loading={busy === 'rerun'} onClick={() => act('rerun', 'schedule', {})}>Run automatic scheduling</Button><Button variant="secondary" onClick={() => setModal('assign')}>Choose inspector and time</Button></div>}
        {d.failedAttempts > 0 && <p className="text-sm">Visit attempts that did not happen: <b>{d.failedAttempts}</b></p>}
        {d.status === 'SCHEDULED' && <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setModal('reschedule')}>Move visit</Button><Button variant="secondary" loading={busy === 'ns'} onClick={() => act('ns', 'no-show', {}, 'Recorded. The case went back to the queue.')}>Mark visit not completed</Button></div>}
      </Card>}
      {req && d.rescheduleRequest && <Card className="space-y-3"><h2 className="font-semibold">Owner asked for another time</h2><p>“{d.rescheduleRequest.reason}”</p><p className="text-sm text-muted">Preferred: {fmtDay(d.rescheduleRequest.preferredFrom, lang)}{d.rescheduleRequest.preferredTo ? ` to ${fmtDay(d.rescheduleRequest.preferredTo, lang)}` : ' onwards'}</p>
        <div className="flex gap-2"><Button loading={busy === 'ap'} onClick={() => act('ap', 'reschedule-request/decision', { outcome: 'APPROVED' }, 'Approved. The case is being re-booked.')}>Approve and re-book</Button><Button variant="secondary" onClick={() => setModal('decline')}>Decline</Button></div></Card>}
      {['INSPECTED', 'REFERRED', 'APPROVED', 'REJECTED', 'CERTIFICATE_ISSUED'].includes(d.status) || d.timeline.some((t) => t.action === 'submit') ? <InspectionPanel caseId={id} status={d.status} onChanged={() => void load()} /> : null}
      <Card><h2 className="mb-3 font-semibold">History</h2><ol className="space-y-2 text-sm">{[...d.timeline].reverse().map((t, n) => <li key={n} className="flex flex-wrap gap-x-3"><time className="w-40 shrink-0 text-muted">{fmtDateTime(t.at, lang)}</time><span>{actionLabel(t.action, lang)}{t.remark ? <span className="text-muted"> — {t.remark}</span> : null}</span></li>)}</ol></Card>
      {flag && <FlagModal doc={flag} caseId={id} onClose={() => setFlag(null)} onDone={() => { setFlag(null); setMsg('Flagged. The owner has been told.'); void load(); }} />}
      {modal === 'assign' && <AssignModal title="Choose inspector and time" path={`/officer/cases/${id}/assign`} onClose={() => setModal(null)} onDone={() => { setModal(null); setMsg('Visit scheduled.'); void load(); }} />}
      {modal === 'reschedule' && <AssignModal title="Move the visit" path={`/officer/cases/${id}/reschedule`} withReason optionalSlot onClose={() => setModal(null)} onDone={() => { setModal(null); setMsg('Visit moved.'); void load(); }} />}
      {modal === 'decline' && <DeclineModal id={id} onClose={() => setModal(null)} onDone={() => { setModal(null); setMsg('Request declined.'); void load(); }} />}
    </div>
  );
}
function summarise(r: Record<string, unknown>) {
  const s = (r.scheduling ?? r) as { mode?: string };
  return s.mode === 'AUTO' ? 'Done. A visit was booked automatically.' : s.mode === 'REVIEW' ? 'Done. The visit needs your confirmation below.' : s.mode === 'ERROR' ? 'Done, but automatic scheduling hit a problem. Use “Run automatic scheduling”.' : 'Done.';
}
function Breakdown({ b }: { b: Breakdown }) {
  return (
    <details className="rounded-lg border border-line p-3 text-sm"><summary className="cursor-pointer font-medium">Why this inspector: score {b.total}/100</summary>
      <table className="mt-2 w-full text-left"><caption className="sr-only">Score breakdown</caption><thead><tr className="text-xs text-muted"><th scope="col" className="py-1">Factor</th><th scope="col">Fit</th><th scope="col">Weight</th><th scope="col">Points</th></tr></thead>
        <tbody>{Object.entries(b.parts ?? {}).map(([k, p]) => <tr key={k} className="border-t border-line"><th scope="row" className="py-1 font-normal">{PART_LABEL[k] ?? k}</th><td>{Math.round(p.raw * 100)}%</td><td>{p.weight}</td><td>{p.points}</td></tr>)}</tbody></table>
      {b.inputs && <p className="mt-2 text-xs text-muted">Distance {b.inputs.distanceKm == null ? 'not available (area used)' : `${b.inputs.distanceKm.toFixed(1)} km`} · load {Math.round(b.inputs.loadRatio * 100)}% · {b.candidatesConsidered ?? '?'} inspectors considered</p>}</details>
  );
}
function FlagModal({ doc, caseId, onClose, onDone }: { doc: OwnerDoc; caseId: string; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState(''); const [code, setCode] = useState('DOC_ILLEGIBLE'); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post(`/officer/cases/${caseId}/documents/${doc.current!.id}/review`, { status: 'FLAGGED', comment, reasonCode: code }); onDone(); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title={`Flag ${doc.nameEn}`} onClose={onClose}><form onSubmit={go} className="space-y-4"><Select label="Reason" value={code} onChange={(e) => setCode(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select><Textarea label="Tell the owner what to fix" value={comment} required minLength={3} maxLength={300} onChange={(e) => setComment(e.target.value)} /><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" variant="danger" loading={busy}>Flag document</Button></div></form></Modal>;
}
function DeclineModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await post(`/officer/cases/${id}/reschedule-request/decision`, { outcome: 'REJECTED', reason }); onDone(); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title="Decline the request" onClose={onClose}><form onSubmit={go} className="space-y-4"><Textarea label="Reason the owner will see" value={reason} required minLength={3} maxLength={300} onChange={(e) => setReason(e.target.value)} /><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>Decline</Button></div></form></Modal>;
}
function AssignModal({ title, path, withReason, optionalSlot, onClose, onDone }: { title: string; path: string; withReason?: boolean; optionalSlot?: boolean; onClose: () => void; onDone: () => void }) {
  const ins = useFetch<Insp[]>('/officer/inspectors'); const [f, setF] = useState({ inspector: '', start: '', end: '', ooj: '', reason: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [needOoj, setNeedOoj] = useState(false);
  const manual = !!f.start || !optionalSlot;
  const go = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post(path, { ...(withReason ? { reason: f.reason } : {}), ...(f.inspector ? { inspectorId: f.inspector } : {}), ...(manual ? { windowStart: istLocalToIso(f.start), windowEnd: istLocalToIso(f.end) } : {}), ...(f.ooj ? { outOfJurisdictionReason: f.ooj } : {}) }, true); onDone(); }
    catch (x) { setErr(x); setBusy(false); if ((x as { code?: string }).code === 'OUT_OF_JURISDICTION_REASON_REQUIRED') setNeedOoj(true); }
  };
  return <Modal title={title} onClose={onClose}><form onSubmit={go} className="space-y-4">
    {withReason && <Textarea label="Why is it being moved?" value={f.reason} required minLength={3} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
    <Select label={optionalSlot ? 'Inspector (leave blank to keep or let the system choose)' : 'Inspector'} value={f.inspector} required={!optionalSlot} onChange={(e) => setF({ ...f, inspector: e.target.value })}><option value="">{optionalSlot ? 'Automatic' : 'Choose…'}</option>{ins.data?.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{i.name} · {i.today} today · {i.next7Days} this week</option>)}</Select>
    <div className="grid gap-4 sm:grid-cols-2"><Input label={optionalSlot ? 'Start (optional, IST)' : 'Start (IST)'} type="datetime-local" required={!optionalSlot} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /><Input label="End (IST)" type="datetime-local" required={manual} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></div>
    {optionalSlot && !f.start && <p className="text-xs text-muted">With no time given, the system picks the next free slot and avoids the one being left.</p>}
    {needOoj && <Textarea label="This inspector is outside the area. Why?" value={f.ooj} required minLength={3} maxLength={300} onChange={(e) => setF({ ...f, ooj: e.target.value })} hint="This reason is recorded in the audit trail." />}
    <ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>Confirm</Button></div></form></Modal>;
}
