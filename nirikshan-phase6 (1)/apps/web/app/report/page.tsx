'use client';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api, get } from '@/lib/api';
import { fmtDate } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Captcha, SITEKEY } from '@/components/ValidateView';
import { Alert, Button, Card, ErrorNote, Input, PageTitle, Textarea } from '@/components/ui';

export default function Report() {
  const { tr, lang } = useTr(); const photo = useRef<HTMLInputElement>(null);
  const [v, setV] = useState({ description: '', certNo: '', contact: '' }); const [captcha, setCaptcha] = useState<string | undefined>(); const [needCaptcha, setNeed] = useState(false);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [ref, setRef] = useState('');
  const [look, setLook] = useState(''); const [stat, setStat] = useState<{ ref: string; status: string; receivedOn: string } | null>(null); const [lerr, setLerr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append('description', v.description); if (v.certNo) fd.append('certNo', v.certNo); if (v.contact) fd.append('contact', v.contact); if (captcha) fd.append('captchaToken', captcha);
      const f = photo.current?.files?.[0]; if (f) fd.append('photo', f);
      const r = await api<{ ref: string }>('/public/tamper-reports', { method: 'POST', form: fd }); setRef(r.ref); setV({ description: '', certNo: '', contact: '' });
    } catch (x) { if (x instanceof ApiError && x.code === 'CAPTCHA_REQUIRED') setNeed(true); setErr(x); } finally { setBusy(false); }
  };
  const check = async (e: FormEvent) => { e.preventDefault(); setLerr(null); setStat(null); try { setStat(await get(`/public/tamper-reports/${encodeURIComponent(look.trim())}`)); } catch (x) { setLerr(x); } };
  return (
    <div className="mx-auto max-w-2xl space-y-6"><PageTitle>{tr('Report tampering', 'छेड़छाड़ की सूचना दें')}</PageTitle>
      <p className="text-sm text-muted">{tr('Tell us if a verification seal or certificate looks altered, forged or misused. You do not need an account. Do not put any payment details here; no fee is ever asked for.', 'यदि कोई सत्यापन मुहर या प्रमाणपत्र बदला हुआ, नकली या ग़लत इस्तेमाल होता दिखे तो बताएँ। खाते की ज़रूरत नहीं। यहाँ भुगतान की कोई जानकारी न दें; कोई शुल्क नहीं माँगा जाता।')}</p>
      {ref ? <Alert tone="ok"><b>{tr('Thank you. Your report number is', 'धन्यवाद। आपकी सूचना संख्या है')} {ref}.</b> {tr('Keep it to check the status later.', 'बाद में स्थिति जाँचने के लिए इसे सँभालकर रखें।')}</Alert> : (
        <Card><form onSubmit={submit} className="space-y-4">
          <Textarea label={tr('What did you see?', 'आपने क्या देखा?')} required minLength={10} maxLength={1500} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} hint={tr('Where, when, and what looked wrong.', 'कहाँ, कब, और क्या ग़लत लगा।')} />
          <Input label={tr('Certificate number (if you have it)', 'प्रमाणपत्र संख्या (यदि है)')} value={v.certNo} onChange={(e) => setV({ ...v, certNo: e.target.value })} />
          <Input label={tr('How can we reach you? (optional)', 'हम आपसे कैसे संपर्क करें? (वैकल्पिक)')} value={v.contact} onChange={(e) => setV({ ...v, contact: e.target.value })} hint={tr('Phone or email. Only officers see it.', 'फ़ोन या ईमेल। केवल अधिकारी देख सकते हैं।')} />
          <div><label htmlFor="ph" className="mb-1 block text-sm font-medium">{tr('Photo (optional, JPG or PNG, up to 5 MB)', 'फ़ोटो (वैकल्पिक, JPG या PNG, 5 MB तक)')}</label><input id="ph" ref={photo} type="file" accept="image/jpeg,image/png" className="block min-h-11 w-full text-sm" /></div>
          {needCaptcha && <Captcha onToken={setCaptcha} />}<ErrorNote error={err} />
          <Button type="submit" loading={busy} disabled={needCaptcha && !captcha && !!SITEKEY}>{tr('Send report', 'सूचना भेजें')}</Button>
        </form></Card>)}
      <Card><h2 className="mb-2 font-semibold">{tr('Check a report', 'सूचना की स्थिति जाँचें')}</h2>
        <form onSubmit={check} className="flex flex-wrap items-end gap-2"><div className="min-w-56 flex-1"><Input label={tr('Report number', 'सूचना संख्या')} placeholder="TMP-2026-00001" value={look} onChange={(e) => setLook(e.target.value)} /></div><Button type="submit" variant="secondary" disabled={!/^TMP-\d{4}-\d{5}$/i.test(look.trim())}>{tr('Check', 'जाँचें')}</Button></form>
        <ErrorNote error={lerr} />{stat && <p role="status" className="mt-3 text-sm">{stat.ref}: <b>{stat.status === 'CLOSED' ? tr('Looked into and closed', 'जाँच पूरी, बंद') : tr('Received, with the officers', 'प्राप्त, अधिकारियों के पास')}</b> · {tr('received on', 'प्राप्त')} {fmtDate(stat.receivedOn, lang)}</p>}</Card>
    </div>
  );
}
