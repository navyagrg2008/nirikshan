'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, get } from '@/lib/api';
import { fmtDate as fmtDay } from '@/lib/hooks';
import { certStatusLabel, certStatusTone, useTr } from '@/lib/inspection';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle } from './ui';

interface Cert { certNo: string; holder: string; category: string; capacity: string; accuracyClass: string; area: string; verifiedOn: string; validTill: string; daysRemaining: number; issuingOffice: string; status: string; reason: string | null; replacedBy: string | null }
interface Result { result: string; signatureCheck?: string; certificate?: Cert }
export const SITEKEY = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY;

/** The public check page. The certificate number comes from the box, the address bar (?cert=) or a QR token. */
export function ValidateView({ token, initialCert }: { token?: string; initialCert?: string }) {
  const { tr, lang } = useTr(); const router = useRouter(); const [cert, setCert] = useState(initialCert ?? ''); const [res, setRes] = useState<Result | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [needCaptcha, setNeedCaptcha] = useState(false); const [captcha, setCaptcha] = useState<string | undefined>();
  const run = useCallback(async (c: string | null, tok: string | null, cap?: string) => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const extra = cap ? `${tok ? '?' : '&'}captchaToken=${encodeURIComponent(cap)}` : '';
      const r = tok ? await get<Result>(`/public/validate/qr/${encodeURIComponent(tok)}${extra}`) : await get<Result>(`/public/validate?cert=${encodeURIComponent(c ?? '')}${extra}`);
      setRes(r); setNeedCaptcha(false); setCaptcha(undefined);
    } catch (e) { if (e instanceof ApiError && e.code === 'CAPTCHA_REQUIRED') setNeedCaptcha(true); setErr(e); } finally { setBusy(false); }
  }, []);
  const first = useRef(true);
  useEffect(() => { if (!first.current) return; first.current = false; if (token) void run(null, token); else if (initialCert && initialCert.length >= 8) void run(initialCert, null); }, [token, initialCert, run]);
  const submit = (e: FormEvent) => { e.preventDefault(); void run(cert, null, captcha); };
  return (
    <div className="mx-auto max-w-2xl space-y-5"><PageTitle>{tr('Check a certificate', 'प्रमाणपत्र जाँचें')}</PageTitle>
      <p className="-mt-3 text-muted">{tr('Type the certificate number printed on the certificate, or scan its QR code. Checking is free and needs no sign-in.', 'प्रमाणपत्र पर छपी संख्या लिखें, या उसका QR कोड स्कैन करें। जाँच मुफ़्त है और साइन-इन नहीं चाहिए।')}</p>
      <Card><form onSubmit={submit} className="space-y-3"><Input label={tr('Certificate number', 'प्रमाणपत्र संख्या')} placeholder="NRK/CERT/…/2026/000001" value={cert} required minLength={8} maxLength={40} autoComplete="off" onChange={(e) => setCert(e.target.value)} />
        {needCaptcha && <Captcha onToken={setCaptcha} />}
        <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy} disabled={needCaptcha && !captcha && !!SITEKEY}>{tr('Check', 'जाँचें')}</Button><Scan onToken={(t) => router.push(`/v/${t}`)} /></div></form></Card>
      {busy && !res && <Loading />}
      {err instanceof ApiError && err.code === 'CAPTCHA_REQUIRED' ? <Alert tone="warn">{tr('Several lookups did not match, so please complete the check above before trying again.', 'कई खोजें मेल नहीं खाईं, इसलिए दोबारा कोशिश से पहले ऊपर की जाँच पूरी करें।')}{!SITEKEY && ` ${tr('(The human check is not set up on this server.)', '(इस सर्वर पर मानव-जाँच चालू नहीं है।)')}`}</Alert> : <ErrorNote error={err} />}
      {res && <Outcome r={res} lang={lang} />}
    </div>
  );
}
function Outcome({ r, lang }: { r: Result; lang: 'en' | 'hi' }) {
  const { tr } = useTr(); const hi = lang === 'hi'; const c = r.certificate;
  if (!c) return <Alert tone="warn"><p className="font-medium">{r.result === 'INVALID_QR' ? tr('This QR code could not be verified.', 'इस QR कोड की पुष्टि नहीं हो सकी।') : tr('No certificate found for that number.', 'इस संख्या का कोई प्रमाणपत्र नहीं मिला।')}</p><p className="text-sm">{tr('Check the number and try again. If it came from a printed certificate, treat it as unverified and tell the Legal Metrology office.', 'संख्या जाँचकर फिर कोशिश करें। यदि यह छपे प्रमाणपत्र से आई है, तो इसे असत्यापित मानें और वैधानिक माप-विज्ञान कार्यालय को बताएँ।')}</p></Alert>;
  const ok = c.status === 'VALID';
  return (
    <div role="status"><Card className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-lg font-semibold">{c.certNo}</p><Badge tone={certStatusTone(c.status)}>{ok ? tr('Valid', 'मान्य') : certStatusLabel(c.status, hi)}</Badge></div>
      {ok ? <Alert tone="ok">{tr('This certificate is genuine and in force.', 'यह प्रमाणपत्र असली है और लागू है।')}{r.signatureCheck === 'MATCH' && ` ${tr('The QR signature matched.', 'QR हस्ताक्षर मेल खाया।')}`}{c.daysRemaining <= 30 && ` ${tr(`It expires in ${c.daysRemaining} days.`, `यह ${c.daysRemaining} दिन में समाप्त होगा।`)}`}</Alert>
        : <Alert tone={c.status === 'REVOKED' ? 'danger' : 'warn'}>{tr('This certificate is not valid right now.', 'यह प्रमाणपत्र अभी मान्य नहीं है।')}{c.reason ? ` ${c.reason}.` : ''}</Alert>}
      {c.replacedBy && <p className="text-sm">{tr('Replaced by', 'इसकी जगह')} <Link className="font-mono text-primary underline" href={`/validate?cert=${encodeURIComponent(c.replacedBy)}`}>{c.replacedBy}</Link></p>}
      <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted">{tr('Holder', 'धारक')}</dt><dd className="font-medium">{c.holder}</dd></div><div><dt className="text-muted">{tr('Instrument', 'उपकरण')}</dt><dd className="font-medium">{c.category} · {c.capacity} · {c.accuracyClass}</dd></div>
        <div><dt className="text-muted">{tr('Verified on', 'सत्यापन की तिथि')}</dt><dd className="font-medium">{fmtDay(c.verifiedOn, lang)}</dd></div><div><dt className="text-muted">{tr('Valid till', 'मान्य तिथि तक')}</dt><dd className="font-medium">{fmtDay(c.validTill, lang)}</dd></div>
        <div><dt className="text-muted">{tr('Area', 'क्षेत्र')}</dt><dd className="font-medium">{c.area}</dd></div><div><dt className="text-muted">{tr('Issuing office', 'जारीकर्ता कार्यालय')}</dt><dd className="font-medium">{c.issuingOffice}</dd></div></dl>
      <p className="text-xs text-muted">{tr('The holder name is shortened and no address or contact details are shown here.', 'धारक का नाम संक्षिप्त है और यहाँ कोई पता या संपर्क विवरण नहीं दिखाया जाता।')}</p></Card></div>
  );
}
/** Camera scan where the browser supports it; otherwise the person types the number. */
function Scan({ onToken }: { onToken: (t: string) => void }) {
  const { tr } = useTr(); const [on, setOn] = useState(false); const [msg, setMsg] = useState(''); const video = useRef<HTMLVideoElement>(null);
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    if (!on) return; let stop = false; let stream: MediaStream | undefined;
    (async () => {
      try {
        const Det = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector; const det = new Det({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        while (!stop) {
          const hits = video.current ? await det.detect(video.current).catch(() => []) : [];
          for (const h of hits) { const m = /\/v\/([A-Za-z0-9._-]{20,80})$/.exec(h.rawValue.split('?')[0] ?? ''); if (m) { stop = true; onToken(m[1]!); return; } }
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch { setMsg(tr('The camera could not be opened. Type the number instead.', 'कैमरा नहीं खुल सका। संख्या लिखें।')); setOn(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [on, onToken, tr]);
  if (!supported) return <p className="self-center text-xs text-muted">{tr('QR scanning is not available in this browser. You can scan with your phone camera app, which opens this page.', 'इस ब्राउज़र में QR स्कैन उपलब्ध नहीं है। आप फ़ोन के कैमरा ऐप से स्कैन करें, वह यही पृष्ठ खोलेगा।')}</p>;
  return <><Button type="button" variant="secondary" aria-pressed={on} onClick={() => { setMsg(''); setOn(!on); }}>{on ? tr('Stop camera', 'कैमरा बंद करें') : tr('Scan QR code', 'QR कोड स्कैन करें')}</Button>{msg && <p role="alert" className="w-full text-sm text-danger">{msg}</p>}{on && <video ref={video} muted playsInline aria-label={tr('Camera view for scanning', 'स्कैन के लिए कैमरा दृश्य')} className="mt-2 w-full max-w-sm rounded-lg border border-line" />}</>;
}
export function Captcha({ onToken }: { onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!SITEKEY || !ref.current) return; const w = window as unknown as { turnstile?: { render: (el: HTMLElement, o: { sitekey: string; callback: (t: string) => void }) => void } };
    const draw = () => w.turnstile?.render(ref.current!, { sitekey: SITEKEY, callback: onToken });
    if (w.turnstile) { draw(); return; }
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = draw; document.head.appendChild(s);
  }, [onToken]);
  return <div ref={ref} />;
}
