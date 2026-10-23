'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/cases';
import { blockerText, evidenceLabel, recLabel, verdictLabel, verdictTone, type TrialRow } from '@/lib/inspection';
import { useSession } from '@/lib/session';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, Modal, Select, Textarea } from './ui';

interface Visit {
  id: string; status: string; inspector: string; window: { start: string; end: string }; submittedAt: string | null; recommendation: string | null; overall: string | null; stickerSerial: string | null; note: string | null; rejectReasonCodes: string[] | null;
  arrival: null | { at: string; distanceM: number | null; geofenceOk: boolean | null; justification: string | null };
  checklist: { code: string; textEn: string; critical: boolean; answer: string; remark: string | null; failed: boolean }[]; trials: TrialRow[]; evidence: { id: string; kind: string; capturedAt: string; geoTagged: boolean }[]; hasTestSheet: boolean;
}
interface Insp {
  visits: Visit[]; rules: { version: number; effectiveFrom: string; mpe: { value: string; unit: string; direction: string } | null; interval: { months: number; marginalMonths: number | null } | null };
  approval: { blockers: { code: string; detail?: string }[]; canApprove: boolean; validity: { min: number; max: number; default: number } | null; requiresSecondApprover: boolean; pendingDecision: string | null };
  decisions: { id: string; decision: string; status: string; remarks: string | null; validityMonths: number | null; reasonCode: string | null; decidedBy: string; secondApprover: string | null; at: string; secondAt: string | null; secondRemarks: string | null }[];
  allowed: { approve: boolean; reject: boolean; refer: boolean; reinspect: boolean };
}
interface Reason { code: string; textEn: string }
const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export function InspectionPanel({ caseId, status, onChanged }: { caseId: string; status: string; onChanged: () => void }) {
  const { lang } = useI18n(); const { me } = useSession(); const q = useFetch<Insp>(`/officer/cases/${caseId}/inspection`);
  const [modal, setModal] = useState<null | 'approve' | 'reject' | 'refer' | 'reinspect' | 'second'>(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState<unknown>(null);
  const done = useCallback((m: string) => { setModal(null); setMsg(m); q.reload(); onChanged(); }, [q, onChanged]);
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : <Loading />;
  const d = q.data; const v = d.visits.find((x) => x.status === 'SUBMITTED'); const pend = d.decisions.find((x) => x.status === 'PENDING_SECOND');
  const open = async (id: string) => { try { const r = await get<{ url: string }>(`/evidence/${id}/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  const sheet = async () => { try { const r = await get<{ url: string }>(`/visits/${v!.id}/test-sheet/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  const deciding = status === 'INSPECTED' || status === 'REFERRED';
  return (
    <div className="space-y-5"><ErrorNote error={err} />{msg && <Alert tone="ok">{msg}</Alert>}
      {!v ? <Card><p className="text-muted">No inspection has been submitted yet.</p></Card> : (
        <Card className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Inspection by {v.inspector}</h2><Badge tone={verdictTone(v.overall)}>{verdictLabel(v.overall)}</Badge></div>
          <p className="text-sm text-muted">Submitted {fmtDateTime(v.submittedAt, lang)} · Inspector recommends: <b>{recLabel(v.recommendation)}</b>{v.stickerSerial ? <> · Sticker <span className="font-mono">{v.stickerSerial}</span></> : null}</p>
          {v.arrival && <p className="text-sm">{v.arrival.geofenceOk === false ? <Badge tone="warn">Started outside the geofence</Badge> : v.arrival.geofenceOk ? <Badge tone="ok">Inside geofence</Badge> : <Badge tone="muted">No premises point to compare</Badge>} {v.arrival.distanceM != null && `${Math.round(v.arrival.distanceM)} m from the premises. `}{v.arrival.justification && <span className="text-muted">Reason: “{v.arrival.justification}”</span>}</p>}
          {d.rules.mpe && <p className="text-xs text-muted">Rules version {d.rules.version} (from {d.rules.effectiveFrom.slice(0, 10)}). Permitted error {d.rules.mpe.direction === 'PLUS_MINUS' ? '±' : d.rules.mpe.direction === 'PLUS' ? '+' : '−'}{trim(d.rules.mpe.value)} {d.rules.mpe.unit}.</p>}
          <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label="Test readings table"><table className="w-full min-w-[34rem] text-left text-sm"><caption className="sr-only">Test readings</caption><thead><tr className="text-xs text-muted"><th scope="col" className="py-1">#</th><th scope="col">Reference</th><th scope="col">Reading</th><th scope="col">Error</th><th scope="col">%</th><th scope="col">Limit</th><th scope="col">Result</th></tr></thead>
            <tbody>{v.trials.map((t) => <tr key={t.trialNo} className="border-t border-line"><th scope="row" className="py-2 font-normal">{t.trialNo}</th><td>{trim(t.reference)} {t.unit}</td><td>{trim(t.observed)} {t.unit}</td><td>{trim(t.errorValue)} {t.errorUnit}</td><td>{trim(t.errorPct)}</td><td>±{trim(t.mpeValue)} {t.errorUnit}</td><td><Badge tone={verdictTone(t.verdict)}>{verdictLabel(t.verdict)}</Badge></td></tr>)}</tbody></table></div>
          <details className="rounded-lg border border-line p-3 text-sm"><summary className="cursor-pointer font-medium">Checklist ({v.checklist.filter((c) => c.failed).length} failed of {v.checklist.length})</summary>
            <ul className="mt-2 divide-y divide-line">{v.checklist.map((c) => <li key={c.code} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{c.textEn}{c.critical && <span className="ml-2 text-xs text-danger">critical</span>}{c.remark && <span className="block text-xs text-muted">“{c.remark}”</span>}</span><Badge tone={c.failed ? 'danger' : c.answer === 'NA' ? 'muted' : 'ok'}>{c.answer === 'YES' ? 'Yes' : c.answer === 'NO' ? 'No' : 'N/A'}</Badge></li>)}</ul></details>
          <div><h3 className="mb-1 text-sm font-medium">Photos</h3><ul className="flex flex-wrap gap-2">{v.evidence.map((e) => <li key={e.id}><Button variant="secondary" onClick={() => open(e.id)}>{evidenceLabel(e.kind)}{e.geoTagged ? ' 📍' : ''}</Button></li>)}{v.evidence.length === 0 && <li className="text-sm text-muted">None</li>}</ul><p className="mt-1 text-xs text-muted">Opening a photo is recorded in the audit trail.</p></div>
          {v.note && <p className="text-sm">Inspector’s note: “{v.note}”</p>}{v.hasTestSheet && <Button variant="secondary" onClick={sheet}>Open test sheet (PDF)</Button>}
        </Card>)}

      {deciding && (
        <Card className="space-y-4"><h2 className="font-semibold">Decision</h2>
          {d.approval.blockers.length > 0 ? <Alert tone="warn"><p className="font-medium">Approval is blocked for these reasons:</p><ul className="mt-1 list-disc pl-5">{d.approval.blockers.map((b) => <li key={b.code}>{blockerText(b.code)}{b.detail ? ` (${b.detail})` : ''}</li>)}</ul></Alert>
            : <Alert tone="ok">Everything needed for approval is in place.{d.approval.requiresSecondApprover && ' This category needs a second approver.'}</Alert>}
          {pend && <Alert tone="info">First approval by {pend.decidedBy === me?.id ? 'you' : 'another officer'} on {fmtDateTime(pend.at, lang)}{pend.validityMonths ? ` for ${pend.validityMonths} months` : ''}. Waiting for a different officer to confirm.</Alert>}
          <div className="flex flex-wrap gap-2">
            {!pend && d.allowed.approve && <Button onClick={() => setModal('approve')}>Approve…</Button>}
            {!pend && d.allowed.reject && <Button variant="danger" onClick={() => setModal('reject')}>Reject…</Button>}
            {!pend && d.allowed.refer && <Button variant="secondary" onClick={() => setModal('refer')}>Refer to senior officer…</Button>}
            {!pend && d.allowed.reinspect && <Button variant="secondary" onClick={() => setModal('reinspect')}>Ask for another inspection…</Button>}
            {pend && pend.decidedBy !== me?.id && <Button onClick={() => setModal('second')}>Give second approval…</Button>}
          </div>
          <p className="text-xs text-muted">Approving, rejecting and second approvals ask you to confirm your password again.</p>
        </Card>)}

      {d.decisions.length > 0 && <Card><h2 className="mb-2 font-semibold">Decision record</h2><ol className="space-y-2 text-sm">{d.decisions.map((x) => <li key={x.id} className="flex flex-wrap gap-x-3"><time className="w-40 shrink-0 text-muted">{fmtDateTime(x.at, lang)}</time><span><b>{x.decision}</b> ({x.status === 'PENDING_SECOND' ? 'waiting for second approver' : x.status === 'VOIDED' ? 'declined by second approver' : 'final'}){x.reasonCode ? ` · ${x.reasonCode}` : ''}{x.remarks ? <span className="text-muted"> — {x.remarks}</span> : null}{x.secondRemarks ? <span className="text-muted"> · second approver: {x.secondRemarks}</span> : null}</span></li>)}</ol></Card>}

      {modal === 'approve' && <ApproveModal caseId={caseId} approval={d.approval} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'reject' && <RejectModal caseId={caseId} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'refer' && <RemarksModal title="Refer to a senior officer" cta="Refer" path="/decisions" extra={{ decision: 'REFER', applicationId: caseId }} done="Referred to a senior officer." onClose={() => setModal(null)} onDone={done} />}
      {modal === 'reinspect' && <RemarksModal title="Ask for another inspection" cta="Send back" path={`/officer/cases/${caseId}/reinspect`} extra={{}} done="Sent back. A new visit will be arranged." onClose={() => setModal(null)} onDone={done} />}
      {modal === 'second' && pend && <SecondModal id={pend.id} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

function Blockers({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'APPROVAL_BLOCKED') { const b = (error.body.blockers as { code: string }[]) ?? []; return <Alert tone="warn"><p className="font-medium">Cannot approve:</p><ul className="list-disc pl-5">{b.map((x) => <li key={x.code}>{blockerText(x.code)}</li>)}</ul></Alert>; }
  return <ErrorNote error={error} />;
}
function ApproveModal({ caseId, approval, onClose, onDone }: { caseId: string; approval: Insp['approval']; onClose: () => void; onDone: (m: string) => void }) {
  const r = approval.validity; const [months, setMonths] = useState(String(r?.default ?? 12)); const [remarks, setRemarks] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { const out = await post<{ status: string; certificate?: { certNo: string } }>('/decisions', { decision: 'APPROVE', applicationId: caseId, validityMonths: Number(months), ...(remarks ? { remarks } : {}) }, true); onDone(out.status === 'PENDING_SECOND' ? 'First approval recorded. A second officer must confirm.' : `Approved. Certificate ${out.certificate?.certNo ?? ''} issued.`); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title="Approve and issue certificate" onClose={onClose}><form onSubmit={go} className="space-y-4">
    {r && <Input label={`Validity in months (1 to ${r.max})`} type="number" min={r.min} max={r.max} required value={months} onChange={(e) => setMonths(e.target.value)} hint="You can shorten the validity but not go beyond the rule." />}
    <Textarea label="Remarks (optional)" value={remarks} maxLength={1000} onChange={(e) => setRemarks(e.target.value)} />
    {approval.requiresSecondApprover && <Alert tone="info">This category needs a second approver. The certificate is issued only after another officer confirms.</Alert>}
    <Blockers error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>Approve</Button></div></form></Modal>;
}
function RejectModal({ caseId, onClose, onDone }: { caseId: string; onClose: () => void; onDone: (m: string) => void }) {
  const reasons = useFetch<Reason[]>('/catalog/reason-codes?appliesTo=REJECT'); const [code, setCode] = useState(''); const [remarks, setRemarks] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!code && reasons.data?.[0]) setCode(reasons.data[0].code); }, [reasons.data, code]);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post('/decisions', { decision: 'REJECT', applicationId: caseId, reasonCode: code, remarks }, true); onDone('Rejected. The owner has been told the reason.'); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title="Reject" onClose={onClose}><form onSubmit={go} className="space-y-4"><Select label="Reason" value={code} required onChange={(e) => setCode(e.target.value)}>{reasons.data?.map((r) => <option key={r.code} value={r.code}>{r.textEn}</option>)}</Select>
    <Textarea label="Explanation the owner will see (at least 10 characters)" value={remarks} required minLength={10} maxLength={1000} onChange={(e) => setRemarks(e.target.value)} /><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" variant="danger" loading={busy}>Reject</Button></div></form></Modal>;
}
function RemarksModal({ title, cta, path, extra, done, onClose, onDone }: { title: string; cta: string; path: string; extra: Record<string, unknown>; done: string; onClose: () => void; onDone: (m: string) => void }) {
  const [remarks, setRemarks] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post(path, { ...extra, remarks }, true); onDone(done); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title={title} onClose={onClose}><form onSubmit={go} className="space-y-4"><Textarea label="Remarks (at least 10 characters)" value={remarks} required minLength={10} maxLength={1000} onChange={(e) => setRemarks(e.target.value)} /><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>{cta}</Button></div></form></Modal>;
}
function SecondModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (m: string) => void }) {
  const [remarks, setRemarks] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const go = async (action: 'CONFIRM' | 'DECLINE') => { setBusy(action); setErr(null); try { const r = await post<{ certificate?: { certNo: string } }>(`/decisions/${id}/second-approval`, { action, ...(remarks ? { remarks } : {}) }, true); onDone(action === 'CONFIRM' ? `Confirmed. Certificate ${r.certificate?.certNo ?? ''} issued.` : 'Declined. The first approval is void and the case is back for a decision.'); } catch (x) { setErr(x); setBusy(null); } };
  return <Modal title="Second approval" onClose={onClose}><div className="space-y-4"><Textarea label="Remarks (at least 10 characters if you decline)" value={remarks} maxLength={1000} onChange={(e) => setRemarks(e.target.value)} /><Blockers error={err} />
    <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="danger" loading={busy === 'DECLINE'} onClick={() => go('DECLINE')}>Decline</Button><Button loading={busy === 'CONFIRM'} onClick={() => go('CONFIRM')}>Confirm and issue</Button></div></div></Modal>;
}
