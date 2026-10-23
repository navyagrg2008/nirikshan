'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { get, post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/cases';
import { fmtDate as fmtDay } from '@/lib/hooks';
import { certStatusLabel, certStatusTone, useTr } from '@/lib/inspection';
import { Alert, Badge, Button, Card, ErrorNote, Loading, Modal, PageTitle, Select, Textarea } from './ui';

interface Detail {
  id: string; certNo: string; status: string; storedStatus: string; verifiedOn: string; validTill: string; validityMonths: number; marginal: boolean;
  instrument: { id: string; instrumentNo: string; serialNo: string; category: string };
  content: { holder: string; makeModel: string; capacity: string; accuracyClass: string; area: string; mpe: string; stickerSerial: string; issuingOffice: string; issuedBy: string; ruleVersion: number };
  qrUrl: string; signature: { keyId: string; status: 'MATCH' | 'MISMATCH'; fingerprint: string }; replacesCertificateId: string | null; replacedBy: string | null;
  history: { from: string | null; to: string; publicReason: string | null; note?: string | null; reasonCode: string | null; at: string }[];
  allowed: { revoke: boolean; suspend: boolean; reinstate: boolean; reissue: boolean };
}
export function CertificateView({ id, back, staff }: { id: string; back: string; staff?: boolean }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi'; const q = useFetch<Detail>(`/certificates/${id}`); const [qr, setQr] = useState(''); const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState('');
  const [modal, setModal] = useState<null | 'suspend' | 'revoke' | 'reinstate' | 'reissue'>(null);
  const url = q.data?.qrUrl;
  useEffect(() => { if (url) QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr('')); }, [url]);
  const pdf = async () => { try { const r = await get<{ url: string }>(`/certificates/${id}/pdf`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  const done = useCallback((m: string) => { setModal(null); setMsg(m); q.reload(); }, [q]);
  const c = q.data; if (!c) return q.error ? <ErrorNote error={q.error} /> : <Loading />;
  const row = (k: string, v: string) => <div><dt className="text-xs text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>;
  return (
    <div className="mx-auto max-w-4xl space-y-5"><Link href={back} className="no-print text-sm text-primary underline">← {tr('All certificates', 'सभी प्रमाणपत्र')}</Link>
      <PageTitle actions={<Badge tone={certStatusTone(c.status)}>{certStatusLabel(c.status, hi)}</Badge>}><span className="font-mono text-2xl">{c.certNo}</span></PageTitle>
      <ErrorNote error={err} />{msg && <Alert tone="ok">{msg}</Alert>}
      {c.status === 'SUSPENDED' && <Alert tone="warn">{tr('This certificate is suspended. It is not valid until it is reinstated.', 'यह प्रमाणपत्र निलंबित है। बहाल होने तक मान्य नहीं है।')}</Alert>}
      {c.status === 'REVOKED' && <Alert tone="danger">{tr('This certificate has been revoked.', 'यह प्रमाणपत्र रद्द कर दिया गया है।')}</Alert>}
      {c.replacedBy && <Alert tone="info">{tr('Replaced by', 'इसकी जगह नया')} <span className="font-mono">{c.replacedBy}</span></Alert>}
      <div className="grid gap-5 md:grid-cols-[1fr_auto]">
        <Card><dl className="grid gap-3 sm:grid-cols-2">{row(tr('Holder', 'धारक'), c.content.holder)}{row(tr('Instrument', 'उपकरण'), `${c.instrument.category} · ${c.instrument.instrumentNo}`)}{row(tr('Make / model', 'निर्माता / मॉडल'), c.content.makeModel || '—')}{row(tr('Serial number', 'क्रम संख्या'), c.instrument.serialNo)}
          {row(tr('Capacity', 'क्षमता'), c.content.capacity)}{row(tr('Accuracy class', 'सटीकता श्रेणी'), c.content.accuracyClass)}{row(tr('Permitted error', 'अनुमत त्रुटि'), c.content.mpe)}{row(tr('Sticker', 'स्टिकर'), c.content.stickerSerial || '—')}
          {row(tr('Verified on', 'सत्यापन की तिथि'), fmtDay(c.verifiedOn, lang))}{row(tr('Valid till', 'मान्य तिथि तक'), `${fmtDay(c.validTill, lang)} (${c.validityMonths} ${tr('months', 'माह')})`)}{row(tr('Issuing office', 'जारीकर्ता कार्यालय'), c.content.issuingOffice)}{row(tr('Rule version', 'नियम संस्करण'), String(c.content.ruleVersion))}</dl>
          <div className="no-print mt-4 flex flex-wrap gap-2"><Button onClick={pdf}>{tr('Download certificate (PDF)', 'प्रमाणपत्र डाउनलोड करें (PDF)')}</Button><Button variant="secondary" onClick={() => window.print()}>{tr('Print', 'प्रिंट करें')}</Button>{!staff && c.status === 'VALID' && <Link href={`/owner/instruments/${c.instrument.id}/apply`} className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium">{tr('Renew', 'नवीनीकरण')}</Link>}<Link href={`/validate?cert=${encodeURIComponent(c.certNo)}`} className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-medium hover:bg-primary-soft">{tr('See the public check page', 'सार्वजनिक जाँच पृष्ठ देखें')}</Link></div></Card>
        <Card className="text-center">{qr ? <img src={qr} width={220} height={220} alt={tr(`QR code for certificate ${c.certNo}. It opens the public check page.`, `प्रमाणपत्र ${c.certNo} का QR कोड। यह सार्वजनिक जाँच पृष्ठ खोलता है।`)} className="mx-auto" /> : <div className="grid size-[220px] place-items-center text-sm text-muted">QR…</div>}<p className="mt-2 max-w-[220px] break-all text-xs text-muted">{c.qrUrl}</p></Card>
      </div>
      {staff && <Card className="space-y-2 text-sm"><h2 className="font-semibold">{tr('Integrity', 'अखंडता')}</h2><p>{tr('Stored details match the signed fingerprint', 'सेव किया विवरण हस्ताक्षरित फ़िंगरप्रिंट से मेल खाता है')}: <Badge tone={c.signature.status === 'MATCH' ? 'ok' : 'danger'}>{c.signature.status === 'MATCH' ? 'Yes' : 'NO — investigate'}</Badge></p><p className="break-all text-xs text-muted">Key {c.signature.keyId} · fingerprint {c.signature.fingerprint}</p></Card>}
      {staff && (c.allowed.suspend || c.allowed.revoke || c.allowed.reinstate || c.allowed.reissue) && <Card className="space-y-3"><h2 className="font-semibold">Actions</h2><div className="flex flex-wrap gap-2">
        {c.allowed.suspend && <Button variant="secondary" onClick={() => setModal('suspend')}>Suspend…</Button>}{c.allowed.reinstate && <Button onClick={() => setModal('reinstate')}>Reinstate…</Button>}{c.allowed.reissue && <Button variant="secondary" onClick={() => setModal('reissue')}>Re-issue…</Button>}{c.allowed.revoke && <Button variant="danger" onClick={() => setModal('revoke')}>Revoke…</Button>}</div><p className="text-xs text-muted">Each action asks you to confirm your password again and is recorded in the audit trail.</p></Card>}
      <Card><h2 className="mb-2 font-semibold">{tr('History', 'इतिहास')}</h2>{c.history.length === 0 ? <p className="text-sm text-muted">{tr('No changes since it was issued.', 'जारी होने के बाद कोई बदलाव नहीं।')}</p> : <ol className="space-y-2 text-sm">{c.history.map((h, i) => <li key={i} className="flex flex-wrap gap-x-3"><time className="w-40 shrink-0 text-muted">{fmtDateTime(h.at, lang)}</time><span>{h.from} → <b>{h.to}</b>{h.publicReason ? <span className="text-muted"> — {h.publicReason}</span> : null}{staff && h.note ? <span className="block text-xs text-muted">Internal: {h.note}</span> : null}</span></li>)}</ol>}</Card>
      {modal && (modal === 'reissue' || modal === 'reinstate' ? <NoteModal kind={modal} id={id} onClose={() => setModal(null)} onDone={done} /> : <ReasonModal kind={modal} id={id} onClose={() => setModal(null)} onDone={done} />)}
    </div>
  );
}
function ReasonModal({ kind, id, onClose, onDone }: { kind: 'suspend' | 'revoke'; id: string; onClose: () => void; onDone: (m: string) => void }) {
  const reasons = useFetch<{ code: string; textEn: string }[]>(`/catalog/reason-codes?appliesTo=${kind === 'suspend' ? 'SUSPEND' : 'REVOKE'}`); const [code, setCode] = useState(''); const [note, setNote] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!code && reasons.data?.[0]) setCode(reasons.data[0].code); }, [reasons.data, code]);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post(`/certificates/${id}/${kind}`, { reasonCode: code, internalNote: note }, true); onDone(kind === 'suspend' ? 'Certificate suspended. The owner has been told.' : 'Certificate revoked. The owner has been told.'); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title={kind === 'suspend' ? 'Suspend certificate' : 'Revoke certificate'} onClose={onClose}><form onSubmit={go} className="space-y-4"><Select label="Reason" value={code} required onChange={(e) => setCode(e.target.value)}>{reasons.data?.map((r) => <option key={r.code} value={r.code}>{r.textEn}</option>)}</Select>
    <Textarea label="Internal note (staff only, at least 10 characters)" value={note} required minLength={10} maxLength={1000} onChange={(e) => setNote(e.target.value)} hint="The public check page shows only the reason text, never this note." /><ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" variant={kind === 'revoke' ? 'danger' : 'primary'} loading={busy}>{kind === 'suspend' ? 'Suspend' : 'Revoke'}</Button></div></form></Modal>;
}
function NoteModal({ kind, id, onClose, onDone }: { kind: 'reinstate' | 'reissue'; id: string; onClose: () => void; onDone: (m: string) => void }) {
  const [text, setText] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { const r = await post<{ certNo?: string }>(`/certificates/${id}/${kind}`, kind === 'reinstate' ? { internalNote: text } : { reason: text }, true); onDone(kind === 'reinstate' ? 'Certificate is valid again.' : `Re-issued as ${r.certNo ?? 'a new certificate'}. The old one is marked replaced.`); } catch (x) { setErr(x); setBusy(false); } };
  return <Modal title={kind === 'reinstate' ? 'Reinstate certificate' : 'Re-issue certificate'} onClose={onClose}><form onSubmit={go} className="space-y-4"><Textarea label={kind === 'reinstate' ? 'Internal note (at least 10 characters)' : 'Why is it being re-issued? (at least 10 characters)'} value={text} required minLength={10} maxLength={kind === 'reinstate' ? 1000 : 500} onChange={(e) => setText(e.target.value)} />
    {kind === 'reissue' && <p className="text-xs text-muted">A new certificate number and QR are created with the same validity dates. The old one stops being valid.</p>}<ErrorNote error={err} /><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Close</Button><Button type="submit" loading={busy}>Confirm</Button></div></form></Modal>;
}
