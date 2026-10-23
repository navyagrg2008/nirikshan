'use client';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { GrievancesTab, RequestsTab, TamperTab } from '@/components/QueueTabs';
import { useEffect } from 'react';

type TabKey = 'accounts' | 'dups' | 'transfers' | 'dereg' | 'grievances' | 'tamper';
const FROM_URL: Record<string, TabKey> = { accounts: 'accounts', duplicates: 'dups', transfers: 'transfers', deregistration: 'dereg', grievances: 'grievances', tamper: 'tamper' };

interface Acct { id: string; submittedAt: string; role: string; businessType: string; area: { name: string }; fullName: string | null; firmName: string | null; tradeLicenceNo: string | null; gstin: string | null; address: { line1?: string; pincode?: string } | null; mobileMasked: string | null; idProof: { type: string; last4: string } | null; documents: { id: string; kind: string; mime: string; size: number }[] }
interface Dup { id: string; createdAt: string; area: string; serialNo: string; make: string; capacity: string; capacityUnit: string }

export default function Queue() {
  const { t, lang } = useI18n(); const { me } = useSession(); const [tab, setTab] = useState<TabKey>('accounts');
  useEffect(() => { const k = new URLSearchParams(window.location.search).get('tab'); if (k && FROM_URL[k]) setTab(FROM_URL[k]!); }, []);
  const acc = useFetch<Acct[]>('/officer/accounts'); const dup = useFetch<Dup[]>(me?.role === 'INSPECTOR' ? null : '/officer/duplicates');
  const [reason, setReason] = useState<Record<string, string>>({}); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const decide = async (kind: 'accounts' | 'duplicates', id: string, outcome: 'APPROVED' | 'REJECTED') => {
    setBusy(id + outcome); setErr(null);
    try { await post(`/officer/${kind}/${id}/decision`, { outcome, ...(reason[id] ? { reason: reason[id] } : {}) }); await (kind === 'accounts' ? acc.reload() : dup.reload()); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const openDoc = async (uid: string, did: string) => { try { const r = await get<{ url: string }>(`/officer/accounts/${uid}/documents/${did}/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  const reqs = useFetch<{ items: { kind: string }[] }>(me?.role === 'INSPECTOR' ? null : '/officer/requests'); const nreq = (k: string[]) => reqs.data?.items.filter((r) => k.includes(r.kind)).length ?? 0;
  const tabs = [['accounts', `Account approvals (${acc.data?.length ?? 0})`], ['dups', `Duplicate overrides (${dup.data?.length ?? 0})`], ['transfers', `Transfers and address changes (${nreq(['TRANSFER', 'ADDRESS_CHANGE'])})`], ['dereg', `De-registration (${nreq(['DEREGISTER'])})`], ['grievances', 'Grievances'], ['tamper', 'Tamper reports']] as const;
  return (
    <div><PageTitle>{t('nav.queue')}</PageTitle>
      <div role="tablist" aria-label="Queue" className="mb-4 flex flex-wrap gap-2">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`min-h-11 rounded-lg border px-4 text-sm ${tab === k ? 'border-primary bg-primary-soft font-semibold' : 'border-line'}`}>{l}</button>)}</div>
      <ErrorNote error={err} />
      {tab === 'accounts' && <div role="tabpanel" className="space-y-4">{acc.loading && !acc.data && <Loading />}{acc.data?.length === 0 && <Empty>Nothing waiting. Nice.</Empty>}
        {acc.data?.map((a) => <Card key={a.id} className="space-y-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{a.firmName} <Badge>{a.businessType}</Badge></h2><p className="text-sm text-muted">{a.fullName} · {a.mobileMasked} · {a.area.name}</p></div><time className="text-xs text-muted">Submitted {fmtDate(a.submittedAt, lang)}</time></div>
          <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted">Address</dt><dd>{[a.address?.line1, a.address?.pincode].filter(Boolean).join(", ")}</dd></div><div><dt className="text-xs text-muted">Trade licence / GSTIN</dt><dd>{a.tradeLicenceNo ?? '—'} / {a.gstin ?? '—'}</dd></div><div><dt className="text-xs text-muted">ID proof</dt><dd>{a.idProof ? `${a.idProof.type} ending ${a.idProof.last4}` : '—'}</dd></div></dl>
          <div className="flex flex-wrap gap-2">{a.documents.map((d) => <Button key={d.id} variant="secondary" onClick={() => openDoc(a.id, d.id)}>View {d.kind.replace('_', ' ').toLowerCase()}</Button>)}{a.documents.length === 0 && <span className="text-sm text-muted">No documents uploaded</span>}</div>
          <p className="text-xs text-muted">Viewing a document is recorded in the audit trail.</p>
          <div className="flex flex-wrap items-end gap-2"><label className="flex-1 text-sm">Reason (required to reject)<input value={reason[a.id] ?? ''} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3" /></label>
            <Button loading={busy === a.id + 'APPROVED'} onClick={() => decide('accounts', a.id, 'APPROVED')}>{t('a.approve')}</Button><Button variant="danger" disabled={!reason[a.id]} loading={busy === a.id + 'REJECTED'} onClick={() => decide('accounts', a.id, 'REJECTED')}>{t('a.reject')}</Button></div></Card>)}</div>}
      {tab === 'transfers' && <RequestsTab kinds={['TRANSFER', 'ADDRESS_CHANGE']} empty="No transfer or address-change requests waiting." />}
      {tab === 'dereg' && <RequestsTab kinds={['DEREGISTER']} empty="No de-registration requests waiting." />}
      {tab === 'grievances' && <GrievancesTab />}
      {tab === 'tamper' && <TamperTab />}
      {tab === 'dups' && <div role="tabpanel" className="space-y-4">{dup.loading && !dup.data && <Loading />}{dup.data?.length === 0 && <Empty>No duplicate reviews waiting.</Empty>}
        {dup.data?.map((d) => <Card key={d.id} className="space-y-3"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">Serial {d.serialNo} · {d.make} · {+d.capacity} {d.capacityUnit}</h2><time className="text-xs text-muted">{fmtDate(d.createdAt, lang)} · {d.area}</time></div>
          <Alert tone="warn">An instrument with the same serial number, make and category already exists. Approve only if this is a genuinely different instrument.</Alert>
          <div className="flex flex-wrap items-end gap-2"><label className="flex-1 text-sm">Reason (required to reject)<input value={reason[d.id] ?? ''} onChange={(e) => setReason({ ...reason, [d.id]: e.target.value })} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3" /></label>
            <Button loading={busy === d.id + 'APPROVED'} onClick={() => decide('duplicates', d.id, 'APPROVED')}>{t('a.approve')}</Button><Button variant="danger" disabled={!reason[d.id]} loading={busy === d.id + 'REJECTED'} onClick={() => decide('duplicates', d.id, 'REJECTED')}>{t('a.reject')}</Button></div></Card>)}</div>}
    </div>
  );
}
