'use client';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Alert, Badge, Button, Card, ErrorNote, Select, Textarea } from './ui';

interface R { id: string; ref: string; kind: string; status: string; details: string | null; resolution: string | null; hasExport: boolean; dueBy: string; createdAt: string }
const KIND: Record<string, [string, string, string]> = {
  ACCESS: ['Get a copy of my data', 'मेरे डेटा की प्रति', 'We will prepare a file with everything we hold about you.'],
  CORRECTION: ['Correct my details', 'मेरी जानकारी सुधारें', 'Say what is wrong and what it should be.'],
  ERASURE: ['Erase my personal data', 'मेरा व्यक्तिगत डेटा मिटाएँ', 'Your name and contact details are replaced. Certificates and inspection records the law requires us to keep stay, without your personal details where possible. This cannot be undone.'],
  DEACTIVATION: ['Close my account', 'मेरा खाता बंद करें', 'You will no longer be able to sign in.'],
};
const ST: Record<string, [string, string, 'info' | 'ok' | 'danger']> = { OPEN: ['Received', 'प्राप्त', 'info'], IN_PROGRESS: ['In progress', 'जारी', 'info'], CLOSED: ['Done', 'पूर्ण', 'ok'], REJECTED: ['Not possible', 'संभव नहीं', 'danger'] };

/** The person's own data rights: ask for a copy, a correction, erasure or closure. An admin carries it out. */
export function MyData() {
  const { tr, lang } = useTr(); const l = lang === 'hi' ? 1 : 0; const list = useFetch<{ items: R[] }>('/me/data-requests');
  const [kind, setKind] = useState(''); const [details, setDetails] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [ok, setOk] = useState('');
  const send = async () => { setBusy(true); setErr(null); setOk(''); try { const r = await post<{ ref: string }>('/me/data-requests', { kind, ...(details.trim() ? { details: details.trim() } : {}) }, true); setOk(`${tr('Request received. Reference', 'अनुरोध प्राप्त। संदर्भ')} ${r.ref}.`); setKind(''); setDetails(''); await list.reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const dl = async (id: string) => { try { const r = await get<{ url: string }>(`/me/data-requests/${id}/download`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  return (
    <Card className="space-y-3"><h2 className="text-lg font-semibold">{tr('My data', 'मेरा डेटा')}</h2>
      <p className="text-sm text-muted">{tr('You can ask what we hold about you, have it corrected, or have it erased. An administrator replies within 30 days.', 'आप पूछ सकते हैं कि हमारे पास आपका क्या डेटा है, उसे सुधरवा सकते हैं या मिटवा सकते हैं। प्रशासक 30 दिन के भीतर उत्तर देता है।')}</p>
      <Select label={tr('What would you like?', 'आप क्या चाहते हैं?')} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">{tr('Choose', 'चुनें')}</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v[l]}</option>)}</Select>
      {kind && <p className="text-sm text-muted">{kind === 'ACCESS' ? tr(KIND.ACCESS![2], 'हम आपके बारे में हमारे पास मौजूद हर जानकारी की एक फ़ाइल तैयार करेंगे।') : kind === 'CORRECTION' ? tr(KIND.CORRECTION![2], 'बताएँ क्या ग़लत है और क्या होना चाहिए।') : kind === 'ERASURE' ? tr(KIND.ERASURE![2], 'आपका नाम और संपर्क विवरण बदल दिए जाएँगे। क़ानून के अनुसार रखे जाने वाले प्रमाणपत्र और निरीक्षण रिकॉर्ड बने रहेंगे। इसे पलटा नहीं जा सकता।') : tr(KIND.DEACTIVATION![2], 'आप फिर साइन इन नहीं कर पाएँगे।')}</p>}
      {(kind === 'CORRECTION' || kind === 'ERASURE') && <Textarea label={kind === 'CORRECTION' ? tr('What should be corrected?', 'क्या सुधारना है?') : tr('Anything we should know (optional)', 'कुछ बताना हो तो (वैकल्पिक)')} value={details} maxLength={1000} onChange={(e) => setDetails(e.target.value)} />}
      {kind === 'ERASURE' && <Alert tone="warn">{tr('Erasure is blocked while you have open applications or requests.', 'खुले आवेदन या अनुरोध होने पर मिटाना रोक दिया जाता है।')}</Alert>}
      <ErrorNote error={err} />{ok && <p role="status" className="text-sm text-ok">{ok}</p>}
      <Button disabled={!kind || (kind === 'CORRECTION' && details.trim().length < 5)} loading={busy} onClick={send}>{tr('Send request', 'अनुरोध भेजें')}</Button>
      {list.data && list.data.items.length > 0 && <ul className="divide-y divide-line border-t border-line">{list.data.items.map((r) => (
        <li key={r.id} className="space-y-1 py-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span><b>{KIND[r.kind]?.[l]}</b> <span className="text-muted">{r.ref}</span> <Badge tone={ST[r.status]?.[2]}>{ST[r.status]?.[l] ?? r.status}</Badge></span><span className="text-xs text-muted">{fmtDate(r.createdAt, lang)}</span></div>
          {r.resolution && <p>{r.resolution}</p>}{r.hasExport && <Button variant="secondary" onClick={() => dl(r.id)}>{tr('Download my data (JSON)', 'मेरा डेटा डाउनलोड करें (JSON)')}</Button>}</li>))}</ul>}
    </Card>
  );
}
