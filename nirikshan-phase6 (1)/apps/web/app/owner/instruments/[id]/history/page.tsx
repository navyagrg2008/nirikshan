'use client';
import { use } from 'react';
import Link from 'next/link';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Badge, Card, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface H { applications: { id: string; applicationNo: string; type: string; status: string; createdAt: string }[]; certificates: { id: string; certNo: string; status: string; verifiedOn: string; validTill: string }[]; ownership: { at: string; from: string | null; to: string }[]; requests: { kind: string; status: string; createdAt: string; decidedAt: string | null }[] }
const KIND: Record<string, [string, string]> = { TRANSFER: ['Transfer', 'हस्तांतरण'], ADDRESS_CHANGE: ['Change of address', 'पता बदलना'], DEREGISTER: ['De-registration', 'पंजीकरण रद्द'] };

export default function History({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const { tr, lang } = useTr(); const q = useFetch<H>(`/instruments/${id}/history`); const h = q.data;
  const th = (s: string) => <th key={s} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{s}</th>;
  return (
    <div className="mx-auto max-w-3xl space-y-4"><Link href={`/owner/instruments/${id}`} className="text-sm text-primary underline">← {tr('Back to the instrument', 'उपकरण पर वापस')}</Link>
      <PageTitle>{tr('History', 'इतिहास')}</PageTitle>{q.loading && !h && <Loading />}<ErrorNote error={q.error} />
      {h && <>
        <Card className="space-y-2"><h2 className="font-semibold">{tr('Certificates', 'प्रमाणपत्र')}</h2>{h.certificates.length === 0 ? <p className="text-sm text-muted">{tr('None yet.', 'अभी कोई नहीं।')}</p> : <table className="w-full text-left text-sm"><caption className="sr-only">Certificates</caption><thead><tr>{[tr('Number', 'संख्या'), tr('Verified on', 'सत्यापन तिथि'), tr('Valid till', 'मान्य तिथि तक'), tr('Status', 'स्थिति')].map(th)}</tr></thead>
          <tbody>{h.certificates.map((c) => <tr key={c.id} className="border-b border-line/60"><td className="px-2 py-1.5"><Link className="text-primary underline" href={`/owner/certificates/${c.id}`}>{c.certNo}</Link></td><td className="px-2 py-1.5">{fmtDate(c.verifiedOn, lang)}</td><td className="px-2 py-1.5">{fmtDate(c.validTill, lang)}</td><td className="px-2 py-1.5"><Badge tone={c.status === 'VALID' ? 'ok' : 'muted'}>{c.status.toLowerCase()}</Badge></td></tr>)}</tbody></table>}</Card>
        <Card className="space-y-2"><h2 className="font-semibold">{tr('Applications', 'आवेदन')}</h2>{h.applications.length === 0 ? <p className="text-sm text-muted">{tr('None yet.', 'अभी कोई नहीं।')}</p> : <ul className="divide-y divide-line">{h.applications.map((a) => <li key={a.id} className="flex justify-between gap-2 py-2 text-sm"><Link className="text-primary underline" href={`/owner/applications/${a.id}`}>{a.applicationNo}</Link><span className="text-muted">{a.type.replace(/_/g, ' ').toLowerCase()} · {a.status.replace(/_/g, ' ').toLowerCase()} · {fmtDate(a.createdAt, lang)}</span></li>)}</ul>}</Card>
        <Card className="space-y-2"><h2 className="font-semibold">{tr('Owners', 'स्वामी')}</h2>{h.ownership.length === 0 ? <p className="text-sm text-muted">{tr('No change of owner.', 'स्वामी में कोई बदलाव नहीं।')}</p> : <ul className="divide-y divide-line">{h.ownership.map((o, i) => <li key={i} className="py-2 text-sm">{fmtDate(o.at, lang)} · {o.from ? `${o.from} → ` : ''}<b>{o.to}</b></li>)}</ul>}</Card>
        <Card className="space-y-2"><h2 className="font-semibold">{tr('Requests', 'अनुरोध')}</h2>{h.requests.length === 0 ? <p className="text-sm text-muted">{tr('None.', 'कोई नहीं।')}</p> : <ul className="divide-y divide-line">{h.requests.map((r, i) => <li key={i} className="py-2 text-sm">{KIND[r.kind]?.[lang === 'hi' ? 1 : 0] ?? r.kind} · {r.status.toLowerCase()} · {fmtDate(r.createdAt, lang)}</li>)}</ul>}</Card>
      </>}
    </div>
  );
}
