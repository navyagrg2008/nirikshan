'use client';
import { use, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api, ApiError, get, getEtag, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { actionLabel, fmtDateTime, fmtDay, fmtWindow, STEPS, statusLabel, statusTone2, typeLabel, type AppDetail, type OwnerDoc } from '@/lib/cases';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, Modal, PageTitle, Textarea } from '@/components/ui';

const POLL_MS = 20_000;
function Stepper({ s, lang }: { s: AppDetail['stepper']; lang: 'en' | 'hi' }) {
  return (
    <ol aria-label="Progress" className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {s.steps.map((k, n) => { const done = n < s.current; const cur = n === s.current && !s.terminal; return (
        <li key={k} aria-current={cur ? 'step' : undefined} className={`rounded-lg border p-2 text-center text-xs ${done ? 'border-ok text-ok' : cur ? 'border-primary bg-primary-soft font-semibold' : 'border-line text-muted'}`}>
          <span className="block text-base" aria-hidden>{done ? '✓' : n + 1}</span>{STEPS[k]?.[lang === 'hi' ? 1 : 0] ?? k}<span className="sr-only">{done ? ' (done)' : cur ? ' (current)' : ''}</span></li>); })}
    </ol>
  );
}

export default function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const { lang } = useI18n(); const [d, setD] = useState<AppDetail | null>(null); const [err, setErr] = useState<unknown>(null); const [loading, setLoading] = useState(true); const etag = useRef<string>('');
  const [modal, setModal] = useState<null | 'cancel' | 'reschedule'>(null); const [live, setLive] = useState('');
  const refresh = useCallback(async (quiet = false) => {
    try { const r = await getEtag<AppDetail>(`/applications/${id}`, etag.current || undefined); if (!r.notModified) { etag.current = r.etag; setD((old) => { if (quiet && old && old.status !== r.data.status) setLive(`Status changed to ${statusLabel(r.data.status, lang)}`); return r.data; }); } setErr(null); }
    catch (e) { if (!quiet) setErr(e); } finally { setLoading(false); }
  }, [id, lang]);
  useEffect(() => { void refresh(); const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(true); }, POLL_MS); return () => clearInterval(t); }, [refresh]);
  if (loading && !d) return <Loading />;
  if (!d) return <div><ErrorNote error={err} /><Link href="/owner/applications" className="mt-4 inline-block text-primary underline">Back</Link></div>;
  return (
    <div className="mx-auto max-w-4xl space-y-5"><Link href="/owner/applications" className="text-sm text-primary underline">← All applications</Link>
      <PageTitle actions={<Badge tone={statusTone2(d.status)}>{statusLabel(d.status, lang)}</Badge>}>{d.applicationNo}</PageTitle>
      <p className="sr-only" role="status" aria-live="polite">{live}</p>
      <p className="-mt-3 text-muted">{typeLabel(d.type, lang)} · <Link className="text-primary underline" href={`/owner/instruments/${d.instrument.id}`}>{d.instrument.instrumentNo}</Link> · {d.instrument.category} · serial {d.instrument.serialNo}</p>
      <Card><Stepper s={d.stepper} lang={lang} />
        <p className="mt-3 text-xs text-muted">This page refreshes by itself every 20 seconds. Due date: {fmtDay(d.dueDate, lang)}.</p></Card>
      {d.status === 'CERTIFICATE_ISSUED' && <Alert tone="ok">Your certificate is ready. <Link href="/owner/certificates" className="font-medium underline">Open your certificates</Link> to download it.</Alert>}
      {d.status === 'REJECTED' && <Alert tone="danger">This verification was not approved. The reason is in the history below. You may apply again after correcting it.</Alert>}
      {d.status === 'INSPECTED' && <Alert tone="info">The inspection is done. An officer is reviewing it.</Alert>}
      {d.status === 'CANCELLED' && <Alert tone="info">This application was cancelled{d.cancelReason ? `: ${d.cancelReason}` : ''}. You can apply again from the instrument page.</Alert>}
      {d.status === 'APPLIED' && !d.documentsComplete && <Alert tone="warn">Upload all required documents so an officer can check them.</Alert>}
      {d.status === 'APPLIED' && d.documentsComplete && <Alert tone="info">Your documents are with the officer for checking.</Alert>}
      {d.waitingForOfficer && <Alert tone="info">Your documents are accepted. An officer will confirm the visit time and you will be told.</Alert>}
      {d.status === 'FAILED_ATTEMPT' && <Alert tone="warn">The last visit could not be completed. A new time will be arranged.</Alert>}
      {d.visit && (d.status === 'SCHEDULED' || d.status === 'INSPECTION_IN_PROGRESS') && (
        <Card className="space-y-2"><h2 className="font-semibold">Your visit</h2><p className="text-lg font-medium">{fmtWindow(d.visit.start, d.visit.end, lang)}</p>
          <p className="text-sm text-muted">Please keep the instrument ready, unaltered and accessible. An inspector will come to the premises.</p>
          {d.rescheduleRequest && <p className="text-sm">Reschedule request: <Badge tone={d.rescheduleRequest.status === 'OPEN' ? 'info' : d.rescheduleRequest.status === 'APPROVED' ? 'ok' : 'muted'}>{d.rescheduleRequest.status === 'OPEN' ? 'Waiting for officer' : d.rescheduleRequest.status === 'APPROVED' ? 'Approved' : d.rescheduleRequest.status === 'REJECTED' ? 'Declined' : 'Closed'}</Badge>{d.rescheduleRequest.note && <> · {d.rescheduleRequest.note}</>}</p>}
          {d.allowed.requestReschedule && <Button variant="secondary" onClick={() => setModal('reschedule')}>Ask for another time</Button>}</Card>)}
      <Documents d={d} onChange={() => refresh()} />
      <Card><h2 className="mb-3 font-semibold">History</h2><ol className="space-y-2 text-sm">{[...d.timeline].reverse().map((t, n) => <li key={n} className="flex gap-3"><time className="w-40 shrink-0 text-muted">{fmtDateTime(t.at, lang)}</time><span>{actionLabel(t.action, lang)}</span></li>)}</ol></Card>
      {d.allowed.cancel && <div><Button variant="danger" onClick={() => setModal('cancel')}>Cancel this application</Button></div>}
      {modal === 'cancel' && <ReasonModal title="Cancel this application?" label="Why are you cancelling?" cta="Cancel application" path={`/applications/${id}/cancel`} onClose={() => setModal(null)} onDone={() => { setModal(null); void refresh(); }} />}
      {modal === 'reschedule' && <RescheduleModal id={id} onClose={() => setModal(null)} onDone={() => { setModal(null); void refresh(); }} />}
    </div>
  );
}

function Documents({ d, onChange }: { d: AppDetail; onChange: () => void }) {
  const { lang } = useI18n(); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const upload = async (doc: OwnerDoc, file: File) => {
    setErr(null);
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) { setErr({ code: 'UNSUPPORTED_FILE_TYPE' }); return; }
    if (file.size > Math.min(5, doc.maxSizeMb) * 1024 * 1024) { setErr({ code: 'FILE_TOO_LARGE' }); return; }
    setBusy(doc.id); const form = new FormData(); form.append('documentTypeId', doc.id); form.append('file', file);
    try { await api(`/applications/${d.id}/documents`, { method: 'POST', form }); onChange(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const view = async (docId: string) => { try { const r = await get<{ url: string }>(`/applications/${d.id}/documents/${docId}/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  const state = (x: OwnerDoc) => !x.current ? <Badge tone={x.required ? 'warn' : 'muted'}>Not uploaded</Badge> : x.current.review === 'ACCEPTED' ? <Badge tone="ok">Accepted</Badge> : x.current.review === 'FLAGGED' ? <Badge tone="danger">Needs a new file</Badge> : <Badge tone="info">Waiting for check</Badge>;
  return (
    <Card className="space-y-3"><h2 className="font-semibold">Documents</h2>
      {err ? <ErrorNoteAny e={err} /> : null}
      <ul className="divide-y divide-line">{d.documents.map((x) => (
        <li key={x.id} className="space-y-2 py-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{lang === 'hi' && x.nameHi ? x.nameHi : x.nameEn} {x.required && <span className="text-xs text-muted">(required)</span>}</p>{state(x)}</div>
          {x.current?.review === 'FLAGGED' && <Alert tone="danger">The officer says: {x.current.comment ?? 'Please upload a clearer or correct file.'}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            {x.current && <Button variant="secondary" onClick={() => view(x.current!.id)}>View file</Button>}
            {d.allowed.uploadDocuments && <label className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-4 text-sm hover:bg-primary-soft ${busy === x.id ? 'opacity-50' : ''}`}>{busy === x.id ? 'Uploading…' : x.current ? 'Replace file' : 'Choose file'}
              <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" disabled={busy === x.id} aria-label={`${x.current ? 'Replace' : 'Upload'} ${x.nameEn}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(x, f); e.target.value = ''; }} /></label>}
          </div></li>))}</ul>
      {d.allowed.uploadDocuments ? <p className="text-xs text-muted">PDF, JPEG or PNG, up to 5 MB. Files are checked for safety when you upload them. Replacing a file keeps the old one on record.</p> : <p className="text-xs text-muted">Documents are locked once the officer has finished checking them.</p>}
    </Card>
  );
}
function ErrorNoteAny({ e }: { e: unknown }) { return <ErrorNote error={e instanceof ApiError ? e : new ApiError(422, (e as { code?: string }).code ?? 'ERROR', {})} />; }

function ReasonModal({ title, label, cta, path, onClose, onDone }: { title: string; label: string; cta: string; path: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post(path, { reason }); onDone(); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title={title} onClose={onClose}><form onSubmit={go} className="space-y-4"><Textarea label={label} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} required minLength={3} /><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Keep it</Button><Button type="submit" variant="danger" loading={busy}>{cta}</Button></div></form></Modal>;
}
function RescheduleModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ reason: '', from: '', to: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { /* focus handled by Modal */ }, []);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post(`/applications/${id}/reschedule-request`, { reason: f.reason, preferredFrom: f.from, ...(f.to ? { preferredTo: f.to } : {}) }); onDone(); } catch (x) { setErr(x); setBusy(false); } };
  const tomorrow = new Date(Date.now() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  return <Modal title="Ask for another time" onClose={onClose}><form onSubmit={go} className="space-y-4"><Textarea label="Why do you need another time?" value={f.reason} maxLength={300} required minLength={3} onChange={(e) => setF({ ...f, reason: e.target.value })} />
    <div className="grid gap-4 sm:grid-cols-2"><Input label="Earliest date" type="date" min={tomorrow} required value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="Latest date (optional)" type="date" min={f.from || tomorrow} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
    <p className="text-xs text-muted">An officer will look at your request. Your current time stays until it is approved.</p><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>Send request</Button></div></form></Modal>;
}
