'use client';
import { useState } from 'react';
import { post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Loading, Textarea } from '@/components/ui';

interface Req { id: string; kind: string; status: string; createdAt: string; instrumentNo: string; category: string; area: string; fromFirm: string | null; toFirm: string | null; reasonCode: string | null }
interface ReqDetail { id: string; kind: string; instrumentNo: string; instrumentStatus: string; category: string; area: string; fromFirm: string | null; toFirm: string | null; reasonCode: string | null; note: string | null; currentAddress: string | null; newAddress: string | null; newArea: string | null; hasValidCertificate: boolean }
const KIND: Record<string, string> = { TRANSFER: 'Transfer of ownership', ADDRESS_CHANGE: 'Change of address', DEREGISTER: 'De-registration' };
export const REASON: Record<string, string> = { SOLD_OUTSIDE_JURISDICTION: 'Sold outside this jurisdiction', SCRAPPED: 'Scrapped', DAMAGED_BEYOND_REPAIR: 'Damaged beyond repair', NO_LONGER_IN_USE: 'No longer in use', OTHER: 'Other reason' };

/** Transfer / address-change / de-registration requests. The officer sees the facts, then approves or rejects with a reason. */
export function RequestsTab({ kinds, empty }: { kinds: string[]; empty: string }) {
  const list = useFetch<{ items: Req[] }>('/officer/requests'); const [open, setOpen] = useState<string | null>(null); const detail = useFetch<ReqDetail>(open ? `/officer/requests/${open}` : null);
  const [remark, setRemark] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const items = (list.data?.items ?? []).filter((r) => kinds.includes(r.kind));
  const decide = async (outcome: 'APPROVED' | 'REJECTED') => {
    if (!open) return; setBusy(true); setErr(null);
    try { await post(`/officer/requests/${open}/decision`, { outcome, ...(remark ? { remark } : {}) }, true); setOpen(null); setRemark(''); await list.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div role="tabpanel" className="space-y-4">
      {list.loading && !list.data && <Loading />}<ErrorNote error={list.error} />
      {list.data && items.length === 0 && <Empty>{empty}</Empty>}
      {items.map((r) => (
        <Card key={r.id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h2 className="font-semibold">{KIND[r.kind]} <Badge>{r.instrumentNo}</Badge></h2><p className="text-sm text-muted">{r.category} · {r.area} · from {r.fromFirm}{r.toFirm ? ` to ${r.toFirm}` : ''}</p></div>
            <time className="text-xs text-muted">{fmtDate(r.createdAt)}</time>
          </div>
          {open === r.id ? (
            <div className="space-y-3">
              {detail.loading && <Loading />}
              {detail.data && (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  {detail.data.kind === 'ADDRESS_CHANGE' && <><div><dt className="text-xs text-muted">Current address</dt><dd>{detail.data.currentAddress ?? '—'}</dd></div><div><dt className="text-xs text-muted">New address ({detail.data.newArea})</dt><dd>{detail.data.newAddress}</dd></div></>}
                  {detail.data.kind === 'DEREGISTER' && <div><dt className="text-xs text-muted">Reason</dt><dd>{REASON[detail.data.reasonCode ?? ''] ?? detail.data.reasonCode}</dd></div>}
                  {detail.data.kind === 'TRANSFER' && <><div><dt className="text-xs text-muted">Current owner</dt><dd>{detail.data.fromFirm}</dd></div><div><dt className="text-xs text-muted">New owner</dt><dd>{detail.data.toFirm}</dd></div></>}
                  <div><dt className="text-xs text-muted">Note from the owner</dt><dd>{detail.data.note ?? '—'}</dd></div>
                  <div><dt className="text-xs text-muted">Valid certificate</dt><dd>{detail.data.hasValidCertificate ? 'Yes' : 'No'}</dd></div>
                </dl>
              )}
              {detail.data?.kind === 'DEREGISTER' && detail.data.hasValidCertificate && <Alert tone="warn">Approving will withdraw the valid certificate on this instrument. The public check page will show it as revoked.</Alert>}
              {detail.data?.kind === 'TRANSFER' && <Alert tone="info">The certificate stays valid and moves with the instrument. Approving cannot be undone from here.</Alert>}
              <Textarea label="Remark (required to reject)" value={remark} onChange={(e) => setRemark(e.target.value)} />
              <ErrorNote error={err} />
              <div className="flex flex-wrap gap-2"><Button loading={busy} onClick={() => decide('APPROVED')}>Approve</Button><Button variant="danger" disabled={remark.trim().length < 5} loading={busy} onClick={() => decide('REJECTED')}>Reject</Button><Button variant="ghost" onClick={() => setOpen(null)}>Close</Button></div>
            </div>
          ) : <Button variant="secondary" onClick={() => { setOpen(r.id); setRemark(''); setErr(null); }}>Review</Button>}
        </Card>
      ))}
    </div>
  );
}

interface Gr { id: string; ref: string; subject: string; body: string; status: string; replyBy: string | null; createdAt: string; applicationNo: string | null; overdue: boolean }
export function GrievancesTab() {
  const list = useFetch<{ items: Gr[] }>('/officer/grievances?status=ACTIVE'); const [reply, setReply] = useState<Record<string, string>>({}); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const send = async (id: string, status: 'IN_PROGRESS' | 'CLOSED') => { setBusy(id + status); setErr(null); try { await post(`/officer/grievances/${id}/respond`, { status, response: reply[id] ?? '' }, true); setReply({ ...reply, [id]: '' }); await list.reload(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  return (
    <div role="tabpanel" className="space-y-4">
      {list.loading && !list.data && <Loading />}<ErrorNote error={list.error} /><ErrorNote error={err} />
      {list.data?.items.length === 0 && <Empty>No grievances waiting.</Empty>}
      {list.data?.items.map((g) => (
        <Card key={g.id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{g.subject} <Badge>{g.ref}</Badge> {g.overdue && <Badge tone="danger">Past reply date</Badge>} {g.status === 'IN_PROGRESS' && <Badge tone="info">In progress</Badge>}</h2>
            <p className="text-sm text-muted">Raised {fmtDate(g.createdAt)} · reply by {fmtDate(g.replyBy)}{g.applicationNo ? ` · about ${g.applicationNo}` : ''}</p></div></div>
          <p className="whitespace-pre-line text-sm">{g.body}</p>
          <Textarea label="Your reply (the person will see this)" value={reply[g.id] ?? ''} onChange={(e) => setReply({ ...reply, [g.id]: e.target.value })} />
          <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={(reply[g.id] ?? '').trim().length < 5} loading={busy === g.id + 'IN_PROGRESS'} onClick={() => send(g.id, 'IN_PROGRESS')}>Reply and keep open</Button><Button disabled={(reply[g.id] ?? '').trim().length < 5} loading={busy === g.id + 'CLOSED'} onClick={() => send(g.id, 'CLOSED')}>Reply and close</Button></div>
        </Card>
      ))}
    </div>
  );
}

interface Tr { id: string; ref: string; certNo: string | null; description: string; status: string; createdAt: string; contact: string | null; photoUrl: string | null }
export function TamperTab() {
  const list = useFetch<{ items: Tr[] }>('/officer/tamper-reports?status=ACTIVE'); const [note, setNote] = useState<Record<string, string>>({}); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const send = async (id: string, status: 'IN_PROGRESS' | 'CLOSED') => { setBusy(id + status); setErr(null); try { await post(`/officer/tamper-reports/${id}/resolve`, { status, resolution: note[id] ?? '' }, true); setNote({ ...note, [id]: '' }); await list.reload(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  return (
    <div role="tabpanel" className="space-y-4">
      {list.loading && !list.data && <Loading />}<ErrorNote error={list.error} /><ErrorNote error={err} />
      {list.data?.items.length === 0 && <Empty>No tamper reports waiting.</Empty>}
      {list.data?.items.map((r) => (
        <Card key={r.id} className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-semibold">{r.ref} {r.certNo && <Badge>{r.certNo}</Badge>} {r.status === 'IN_PROGRESS' && <Badge tone="info">In progress</Badge>}</h2><time className="text-xs text-muted">{fmtDate(r.createdAt)}</time></div>
          <p className="whitespace-pre-line text-sm">{r.description}</p>
          <p className="text-sm text-muted">Reporter contact: {r.contact ?? 'not given'}{r.photoUrl && <> · <a href={r.photoUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">View photo</a></>}</p>
          <Textarea label="What was done" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
          <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={(note[r.id] ?? '').trim().length < 5} loading={busy === r.id + 'IN_PROGRESS'} onClick={() => send(r.id, 'IN_PROGRESS')}>Save and keep open</Button><Button disabled={(note[r.id] ?? '').trim().length < 5} loading={busy === r.id + 'CLOSED'} onClick={() => send(r.id, 'CLOSED')}>Close report</Button></div>
        </Card>
      ))}
    </div>
  );
}
