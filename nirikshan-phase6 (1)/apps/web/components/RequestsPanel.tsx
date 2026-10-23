'use client';
import { useState } from 'react';
import { DEREGISTER_REASONS } from '@nirikshan/shared';
import { post } from '@/lib/api';
import { fmtDate, useAreas, useFetch } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Alert, Badge, Button, Card, ErrorNote, Input, Select, Textarea } from '@/components/ui';

interface Req { id: string; kind: string; status: string; reasonCode: string | null; remark: string | null; decidedAt: string | null; createdAt: string; toFirm: string | null }
const KIND: Record<string, [string, string]> = { TRANSFER: ['Transfer of ownership', 'स्वामित्व का हस्तांतरण'], ADDRESS_CHANGE: ['Change of address', 'पता बदलना'], DEREGISTER: ['De-registration', 'पंजीकरण रद्द करना'] };
const STATUS: Record<string, [string, 'info' | 'ok' | 'danger' | 'muted']> = { OPEN: ['Waiting for the officer', 'info'], IN_PROGRESS: ['Waiting for the officer', 'info'], APPROVED: ['Approved', 'ok'], REJECTED: ['Not approved', 'danger'], CLOSED: ['Withdrawn', 'muted'] };
const REASON: Record<string, [string, string]> = { SOLD_OUTSIDE_JURISDICTION: ['Sold outside this jurisdiction', 'इस क्षेत्र के बाहर बेचा गया'], SCRAPPED: ['Scrapped', 'कबाड़ में दिया'], DAMAGED_BEYOND_REPAIR: ['Damaged beyond repair', 'मरम्मत से परे खराब'], NO_LONGER_IN_USE: ['No longer in use', 'अब उपयोग में नहीं'], OTHER: ['Other reason', 'अन्य कारण'] };

/** Transfer, change of address and de-registration for one instrument. The officer decides; nothing here changes the register by itself. */
export function RequestsPanel({ instrumentId, status, onChanged }: { instrumentId: string; status: string; onChanged?: () => void }) {
  const { tr, lang } = useTr(); const list = useFetch<{ items: Req[] }>(`/instruments/${instrumentId}/requests`); const areas = useAreas();
  const [form, setForm] = useState<'' | 'TRANSFER' | 'ADDRESS_CHANGE' | 'DEREGISTER'>(''); const [v, setV] = useState({ toMobile: '', address: '', areaId: '', reasonCode: '', note: '' });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState('');
  const open = list.data?.items.find((r) => r.status === 'OPEN' || r.status === 'IN_PROGRESS');
  if (status === 'DEREGISTERED') return null;
  const body = () => form === 'TRANSFER' ? { kind: form, toMobile: v.toMobile, ...(v.note ? { note: v.note } : {}) } : form === 'ADDRESS_CHANGE' ? { kind: form, address: v.address, areaId: v.areaId, ...(v.note ? { note: v.note } : {}) } : { kind: form, reasonCode: v.reasonCode, ...(v.note ? { note: v.note } : {}) };
  const send = async () => { setBusy(true); setErr(null); setDone(''); try { await post(`/instruments/${instrumentId}/requests`, body(), true); setDone(tr('Request sent. You will get a notice when the officer decides.', 'अनुरोध भेज दिया गया। अधिकारी के निर्णय पर आपको सूचना मिलेगी।')); setForm(''); setV({ toMobile: '', address: '', areaId: '', reasonCode: '', note: '' }); await list.reload(); onChanged?.(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const withdraw = async (id: string) => { setErr(null); try { await post(`/requests/${id}/withdraw`, {}, true); await list.reload(); } catch (e) { setErr(e); } };
  const ok = form === 'TRANSFER' ? /^[6-9]\d{9}$/.test(v.toMobile) : form === 'ADDRESS_CHANGE' ? v.address.trim().length >= 5 && !!v.areaId : form === 'DEREGISTER' ? !!v.reasonCode : false;
  return (
    <Card className="mt-5 space-y-3"><h2 className="font-semibold">{tr('Changes to this instrument', 'इस उपकरण में बदलाव')}</h2>
      {done && <p role="status" className="text-sm text-ok">{done}</p>}<ErrorNote error={err} />
      {open ? <Alert tone="info">{tr('A request is already waiting for the officer. You can send another once it is decided or withdrawn.', 'एक अनुरोध अधिकारी के पास लंबित है। निर्णय या वापसी के बाद आप दूसरा भेज सकते हैं।')}</Alert> : (
        <div className="flex flex-wrap gap-2">{(['TRANSFER', 'ADDRESS_CHANGE', 'DEREGISTER'] as const).map((k) => <Button key={k} variant={form === k ? 'primary' : 'secondary'} aria-pressed={form === k} onClick={() => { setForm(form === k ? '' : k); setErr(null); }}>{KIND[k]![lang === 'hi' ? 1 : 0]}</Button>)}</div>)}
      {form && !open && (
        <div className="space-y-3 border-t border-line pt-3">
          {form === 'TRANSFER' && <><Input label={tr('Mobile number of the new owner', 'नए स्वामी का मोबाइल नंबर')} inputMode="numeric" maxLength={10} value={v.toMobile} onChange={(e) => setV({ ...v, toMobile: e.target.value.replace(/\D/g, '') })} hint={tr('They must already have an approved account on this system.', 'उनका इस प्रणाली पर स्वीकृत खाता पहले से होना चाहिए।')} /><Alert tone="info">{tr('The certificate stays valid and goes with the instrument.', 'प्रमाणपत्र मान्य रहता है और उपकरण के साथ जाता है।')}</Alert></>}
          {form === 'ADDRESS_CHANGE' && <><Input label={tr('New address', 'नया पता')} value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /><Select label={tr('Ward or area', 'वार्ड या क्षेत्र')} value={v.areaId} onChange={(e) => setV({ ...v, areaId: e.target.value })}><option value="">{tr('Choose', 'चुनें')}</option>{(areas.data ?? []).filter((a) => a.level === 'WARD').map((a) => <option key={a.id} value={a.id}>{lang === 'hi' && a.nameHi ? a.nameHi : a.name}</option>)}</Select></>}
          {form === 'DEREGISTER' && <><Select label={tr('Why is it being removed?', 'इसे क्यों हटाया जा रहा है?')} value={v.reasonCode} onChange={(e) => setV({ ...v, reasonCode: e.target.value })}><option value="">{tr('Choose', 'चुनें')}</option>{DEREGISTER_REASONS.map((r) => <option key={r} value={r}>{REASON[r]![lang === 'hi' ? 1 : 0]}</option>)}</Select><Alert tone="warn">{tr('If this instrument has a valid certificate, it will be withdrawn. This cannot be undone.', 'यदि इस उपकरण का वैध प्रमाणपत्र है, तो वह वापस ले लिया जाएगा। इसे पलटा नहीं जा सकता।')}</Alert></>}
          <Textarea label={tr('Note for the officer (optional)', 'अधिकारी के लिए टिप्पणी (वैकल्पिक)')} maxLength={500} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
          <Button disabled={!ok} loading={busy} onClick={send}>{tr('Send request', 'अनुरोध भेजें')}</Button>
        </div>
      )}
      {list.data && list.data.items.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">{list.data.items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><div><b>{KIND[r.kind]?.[lang === 'hi' ? 1 : 0] ?? r.kind}</b>{r.toFirm && ` → ${r.toFirm}`} <Badge tone={STATUS[r.status]?.[1]}>{STATUS[r.status]?.[0] ?? r.status}</Badge><div className="text-xs text-muted">{fmtDate(r.createdAt, lang)}{r.remark && ` · ${r.remark}`}</div></div>
            {(r.status === 'OPEN' || r.status === 'IN_PROGRESS') && <Button variant="ghost" onClick={() => withdraw(r.id)}>{tr('Withdraw', 'वापस लें')}</Button>}</li>))}</ul>)}
    </Card>
  );
}
