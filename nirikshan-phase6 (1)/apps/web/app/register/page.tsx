'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAreas } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Alert, Button, Card, ErrorNote, Input, PageTitle, Select } from '@/components/ui';
import { OtpVerify } from '@/components/Otp';

const BTYPES = [['OWNER', 'Shop or instrument owner'], ['DEALER', 'Dealer or trader'], ['MANUFACTURER', 'Manufacturer'], ['REPAIRER', 'Repairer']] as const;
const ID_TYPES = [['', 'Skip for now'], ['AADHAAR', 'Aadhaar'], ['PAN', 'PAN'], ['VOTER_ID', 'Voter ID'], ['DRIVING_LICENCE', 'Driving licence'], ['PASSPORT', 'Passport']] as const;
const DOCS = [['TRADE_LICENCE', 'Trade licence'], ['GST_CERTIFICATE', 'GST certificate'], ['ID_PROOF', 'ID proof']] as const;
const POLICY_VERSION = '2026-10';

export default function Register() {
  const { t } = useI18n(); const router = useRouter(); const { refresh } = useSession(); const areas = useAreas();
  const [step, setStep] = useState(1); const [mobileToken, setMobileToken] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [f, setF] = useState({ mobile: '', fullName: '', dob: '', email: '', businessType: 'OWNER', firmName: '', tradeLicenceNo: '', gstin: '', line1: '', pincode: '', areaId: '', idType: '', idLast4: '', password: '', consent: false });
  const [files, setFiles] = useState<Record<string, { fileId: string; name: string }>>({}); const [upBusy, setUpBusy] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const wards = (areas.data ?? []).filter((a) => a.level === 'WARD'); const steps = [t('reg.s1'), t('reg.s2'), t('reg.s3'), t('reg.s4'), t('reg.s5')];

  const upload = async (kind: string, file: File | undefined) => {
    if (!file) return; setUpBusy(kind); setErr(null);
    try { const fd = new FormData(); fd.append('kind', kind); fd.append('file', file); const r = await api<{ fileId: string }>('/auth/register/uploads', { method: 'POST', form: fd }); setFiles((x) => ({ ...x, [kind]: { fileId: r.fileId, name: file.name } })); }
    catch (e) { setErr(e); } finally { setUpBusy(null); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await post('/auth/register', {
        identity: { fullName: f.fullName, dob: f.dob, mobile: f.mobile.trim(), ...(f.email ? { email: f.email } : {}) }, mobileToken, businessType: f.businessType,
        business: { firmName: f.firmName, ...(f.tradeLicenceNo ? { tradeLicenceNo: f.tradeLicenceNo } : {}), ...(f.gstin ? { gstin: f.gstin } : {}) },
        address: { line1: f.line1, pincode: f.pincode, areaId: f.areaId }, ...(f.idType ? { idProof: { type: f.idType, last4: f.idLast4 } } : {}),
        documents: Object.entries(files).map(([kind, v]) => ({ kind, fileId: v.fileId })), password: f.password, lang: 'en', consent: { policyVersion: POLICY_VERSION, accepted: true },
      });
      await refresh(); router.replace('/register/pending');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const can = [!!mobileToken, f.fullName.length > 1 && !!f.dob && f.password.length >= 10, f.firmName.length > 1 && f.line1.length > 2 && /^[1-9]\d{5}$/.test(f.pincode) && !!f.areaId && (!f.idType || f.idLast4.length === 4), true, f.consent][step - 1]!;
  return (
    <div className="mx-auto max-w-xl"><PageTitle>{t('reg.title')}</PageTitle>
      <ol className="mb-6 flex gap-1" aria-label="Progress">{steps.map((s, i) => <li key={s} aria-current={step === i + 1 ? 'step' : undefined} className={`flex-1 rounded-full border px-2 py-1 text-center text-xs ${step === i + 1 ? 'border-primary bg-primary-soft font-semibold' : i + 1 < step ? 'border-ok text-ok' : 'border-line text-muted'}`}>{i + 1}. {s}</li>)}</ol>
      <Card><form onSubmit={submit} className="space-y-4">
        {step === 1 && <><Input label={t('f.mobile')} inputMode="tel" autoComplete="tel" value={f.mobile} onChange={(e) => { setF({ ...f, mobile: e.target.value }); setMobileToken(null); }} hint="We send a code to confirm this number." />
          {mobileToken ? <Alert tone="ok">Mobile number confirmed.</Alert> : <OtpVerify target={f.mobile.trim()} purpose="REGISTER" onVerified={setMobileToken} />}</>}
        {step === 2 && <><Input label={t('f.fullname')} autoComplete="name" value={f.fullName} onChange={set('fullName')} required />
          <Input label={t('f.dob')} type="date" value={f.dob} onChange={set('dob')} autoComplete="bday" required hint="You must be 18 or older." />
          <Input label={`${t('f.email')} (optional)`} type="email" autoComplete="email" value={f.email} onChange={set('email')} />
          <Input label={t('f.password')} type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={10} hint="At least 10 characters. Do not use your name or phone number." /></>}
        {step === 3 && <><Select label={t('f.btype')} value={f.businessType} onChange={set('businessType')}>{BTYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Input label={t('f.firm')} value={f.firmName} onChange={set('firmName')} required /><Input label={t('f.licence')} value={f.tradeLicenceNo} onChange={set('tradeLicenceNo')} />
          <Input label={t('f.gstin')} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} />
          <Input label={t('f.address')} autoComplete="street-address" value={f.line1} onChange={set('line1')} required />
          <div className="grid gap-4 sm:grid-cols-2"><Input label={t('f.pincode')} inputMode="numeric" autoComplete="postal-code" maxLength={6} value={f.pincode} onChange={set('pincode')} required />
            <Select label={t('f.area')} value={f.areaId} onChange={set('areaId')} required><option value="">Select…</option>{wards.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></div>
          <fieldset className="space-y-3 rounded-lg border border-line p-3"><legend className="px-1 text-sm font-medium">ID proof (optional)</legend>
            <p className="text-xs text-muted">We keep only the type and the last 4 characters, never the full number.</p>
            <div className="grid gap-4 sm:grid-cols-2"><Select label="Type" value={f.idType} onChange={set('idType')}>{ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              <Input label="Last 4 characters" maxLength={4} value={f.idLast4} onChange={set('idLast4')} disabled={!f.idType} /></div></fieldset></>}
        {step === 4 && <><p className="text-sm text-muted">Upload clear copies. PDF, JPEG or PNG, up to 5 MB each. Every file is scanned. You can skip this and send documents later if the officer asks.</p>
          {DOCS.map(([k, l]) => <div key={k} className="space-y-1"><label htmlFor={`d-${k}`} className="block text-sm font-medium">{l}</label>
            <input id={`d-${k}`} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => upload(k, e.target.files?.[0])} className="block min-h-11 w-full text-sm" disabled={upBusy === k} />
            {upBusy === k && <p className="text-xs text-muted">Uploading…</p>}{files[k] && <p className="text-xs text-ok">Added: {files[k]!.name}</p>}</div>)}</>}
        {step === 5 && <><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"><dt className="text-muted">Name</dt><dd>{f.fullName}</dd><dt className="text-muted">Mobile</dt><dd>{f.mobile}</dd><dt className="text-muted">Business</dt><dd>{f.firmName}</dd><dt className="text-muted">Address</dt><dd>{f.line1}, {f.pincode}</dd><dt className="text-muted">Documents</dt><dd>{Object.keys(files).length || 'None'}</dd></dl>
          <label className="flex min-h-11 items-start gap-3"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} className="mt-1 size-5" /><span className="text-sm">{t('reg.consent')} <Link className="text-primary underline" href="/privacy" target="_blank">Privacy</Link></span></label></>}
        <ErrorNote error={err} />
        <div className="flex justify-between gap-2 pt-2"><Button type="button" variant="secondary" onClick={() => { setErr(null); setStep(step - 1); }} disabled={step === 1}>{t('a.back')}</Button>
          {step < 5 ? <Button type="button" onClick={() => { setErr(null); setStep(step + 1); }} disabled={!can}>{t('a.next')}</Button> : <Button type="submit" loading={busy} disabled={!can}>{t('a.submit')}</Button>}</div>
      </form></Card>
    </div>
  );
}
