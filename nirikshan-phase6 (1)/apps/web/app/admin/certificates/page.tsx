'use client';
import { useFetch } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/cases';
import { useI18n } from '@/lib/i18n';
import { CertificateRegister } from '@/components/CertificateRegister';
import { Badge, Card, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface K { activeKeyId: string; knownKeyIds: string[]; issuedPerKey: { keyId: string; certificates: number; first: string; last: string }[] }
export default function Page() {
  const { lang } = useI18n(); const q = useFetch<K>('/admin/certificates/keys');
  return (
    <div className="space-y-6"><PageTitle>Certificates and signing keys</PageTitle>
      {!q.data ? (q.error ? <ErrorNote error={q.error} /> : <Loading />) : (
        <Card className="space-y-3"><h2 className="font-semibold">Signing key status</h2><p className="text-sm">Active key: <Badge tone="ok">{q.data.activeKeyId}</Badge></p>
          <p className="text-sm text-muted">Keys the server can still verify: {q.data.knownKeyIds.join(', ')}. New certificates always use the active key. Older certificates keep verifying with the key they were issued under, so a key can be rotated without breaking old QR codes.</p>
          <table className="w-full text-left text-sm"><caption className="sr-only">Certificates issued per key</caption><thead><tr className="text-xs text-muted"><th scope="col" className="py-1">Key</th><th scope="col">Certificates</th><th scope="col">First issued</th><th scope="col">Last issued</th></tr></thead>
            <tbody>{q.data.issuedPerKey.map((k) => <tr key={k.keyId} className="border-t border-line"><th scope="row" className="py-2 font-mono font-normal">{k.keyId}</th><td>{k.certificates}</td><td>{fmtDateTime(k.first, lang)}</td><td>{fmtDateTime(k.last, lang)}</td></tr>)}{q.data.issuedPerKey.length === 0 && <tr><td colSpan={4} className="py-2 text-muted">No certificates issued yet.</td></tr>}</tbody></table>
          <p className="text-xs text-muted">Key values are never shown. In this build the keys come from server settings; a production deployment keeps them in a key-management service.</p></Card>)}
      <section aria-labelledby="reg"><h2 id="reg" className="mb-3 font-semibold">All certificates</h2><CertificateRegister base="/officer/certificates" staff /></section>
    </div>
  );
}
