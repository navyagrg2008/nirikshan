'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, del, get, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useAreas, useFetch } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { Catalog } from '@/lib/catalog';
import { Alert, Button, Card, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';

interface Form { categoryId: string; subCategoryId: string; capacityBandId: string; accuracyClassId: string; capacity: string; capacityUnit: string; serialNo: string; make: string; model: string; manufactureYear: string; loadCellSerial: string; displayCount: string; address: string; areaId: string; customerBusinessId: string; declaration: boolean }
const EMPTY: Form = { categoryId: '', subCategoryId: '', capacityBandId: '', accuracyClassId: '', capacity: '', capacityUnit: '', serialNo: '', make: '', model: '', manufactureYear: '', loadCellSerial: '', displayCount: '', address: '', areaId: '', customerBusinessId: '', declaration: false };
const STEPS = ['Type', 'Details', 'Place', 'Owner', 'Review', 'Confirm'];

export default function NewInstrument() {
  const { t } = useI18n(); const router = useRouter(); const { me } = useSession(); const cat = useFetch<Catalog>('/catalog/categories'); const areas = useAreas();
  const isTrader = me?.role === 'TRADER'; const customers = useFetch<{ id: string; firmName: string }[]>(isTrader ? '/me/customers' : null);
  const [step, setStep] = useState(1); const [f, setF] = useState<Form>(EMPTY); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [token, setToken] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null); const [restored, setRestored] = useState(false); const [dup, setDup] = useState(false); const [requested, setRequested] = useState(false); const idem = useRef(crypto.randomUUID());
  // Restore the server-side draft once.
  useEffect(() => { get<{ step?: number; data?: Partial<Form> }>('/instruments/draft/mine').then((d) => { if (d.step && d.data) { setF({ ...EMPTY, ...d.data, declaration: false }); setStep(Math.min(d.step, 5)); setSaved('Draft restored'); } }).catch(() => {}).finally(() => setRestored(true)); }, []);
  // Autosave 1.5 s after the last change. Drafts are encrypted on the server and expire after 7 days.
  useEffect(() => {
    if (!restored || f === EMPTY || JSON.stringify(f) === JSON.stringify(EMPTY)) return;
    const id = setTimeout(() => { put('/instruments/draft/mine', { step: Math.min(step, 5), data: { ...f, declaration: false } }).then(() => setSaved('Draft saved')).catch(() => setSaved('Could not save draft')); }, 1500);
    return () => clearTimeout(id);
  }, [f, step, restored]);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const category = useMemo(() => cat.data?.categories.find((c) => c.id === f.categoryId), [cat.data, f.categoryId]);
  const band = category?.capacityBands.find((b) => b.id === f.capacityBandId);
  const wards = (areas.data ?? []).filter((a) => a.level === 'WARD');
  const capOk = !!band && f.capacity !== '' && +f.capacity >= +band.min && +f.capacity <= +band.max;
  const valid = [!!f.categoryId && !!f.capacityBandId && !!f.accuracyClassId, !!f.serialNo.trim() && !!f.make.trim() && capOk, f.address.trim().length > 2 && !!f.areaId, !isTrader || true, f.declaration][step - 1] ?? true;

  const body = (confirmToken: string, requestDuplicateReview: boolean) => ({
    categoryId: f.categoryId, ...(f.subCategoryId ? { subCategoryId: f.subCategoryId } : {}), capacityBandId: f.capacityBandId, accuracyClassId: f.accuracyClassId, capacity: f.capacity, capacityUnit: band!.unit,
    serialNo: f.serialNo.trim(), make: f.make.trim(), ...(f.model ? { model: f.model } : {}), ...(f.manufactureYear ? { manufactureYear: +f.manufactureYear } : {}), ...(f.loadCellSerial ? { loadCellSerial: f.loadCellSerial } : {}), ...(f.displayCount ? { displayCount: +f.displayCount } : {}),
    location: { address: f.address.trim(), areaId: f.areaId }, ownership: f.customerBusinessId ? { mode: 'ON_BEHALF', customerBusinessId: f.customerBusinessId } : { mode: 'SELF' }, confirmToken, declarationAccepted: true, requestDuplicateReview,
  });
  const submit = async (requestReview: boolean) => {
    if (!token) return; setBusy(true); setErr(null);
    try {
      const r = await api<{ id?: string; status?: string }>('/instruments', { method: 'POST', body: body(token, requestReview), headers: { 'Idempotency-Key': idem.current } });
      void r; await del('/instruments/draft/mine').catch(() => {}); if (requestReview) setRequested(true); else router.replace(`/owner/instruments/${r.id}`);
    } catch (e) {
      idem.current = crypto.randomUUID(); // a new attempt needs a new key (the confirmation code is single-use anyway)
      if (e instanceof ApiError && e.code === 'DUPLICATE_INSTRUMENT') { setDup(true); setToken(null); setErr(null); } else setErr(e);
    } finally { setBusy(false); }
  };
  if (cat.loading || !restored) return <Loading />;
  if (requested) return <Card className="mx-auto max-w-lg space-y-3"><h1 className="text-xl font-semibold">Sent for officer review</h1><p className="text-muted">An officer will check whether this instrument is really different. You will get an alert with the result.</p><Button onClick={() => router.replace('/owner/instruments')}>Back to my instruments</Button></Card>;
  return (
    <div className="mx-auto max-w-2xl"><PageTitle>{t('inst.new')}</PageTitle>
      <ol className="mb-6 flex gap-1" aria-label="Progress">{STEPS.map((s, i) => <li key={s} aria-current={step === i + 1 ? 'step' : undefined} className={`flex-1 rounded-full border px-1 py-1 text-center text-xs ${step === i + 1 ? 'border-primary bg-primary-soft font-semibold' : i + 1 < step ? 'border-ok text-ok' : 'border-line text-muted'}`}>{s}</li>)}</ol>
      <Card className="space-y-4">
        {step === 1 && <><Select label="Category" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value, subCategoryId: '', capacityBandId: '', capacity: '' })} required><option value="">Select…</option>{cat.data?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          {category && category.subCategories.length > 0 && <Select label="Sub-category (optional)" value={f.subCategoryId} onChange={set('subCategoryId')}><option value="">None</option>{category.subCategories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
          {category && <Select label="Capacity range" value={f.capacityBandId} onChange={set('capacityBandId')} required><option value="">Select…</option>{category.capacityBands.map((b) => <option key={b.id} value={b.id}>{+b.min}–{+b.max} {b.unit}</option>)}</Select>}
          <Select label="Accuracy class" value={f.accuracyClassId} onChange={set('accuracyClassId')} required><option value="">Select…</option>{cat.data?.accuracyClasses.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></>}
        {step === 2 && <><Input label={`Capacity${band ? ` (${band.unit})` : ''}`} inputMode="decimal" value={f.capacity} onChange={set('capacity')} required error={f.capacity && !capOk ? `Must be between ${+band!.min} and ${+band!.max} ${band!.unit}` : undefined} />
          <div className="grid gap-4 sm:grid-cols-2"><Input label="Serial number" value={f.serialNo} onChange={set('serialNo')} required /><Input label="Make" value={f.make} onChange={set('make')} required /><Input label="Model (optional)" value={f.model} onChange={set('model')} />
            <Input label="Year of manufacture (optional)" inputMode="numeric" maxLength={4} value={f.manufactureYear} onChange={set('manufactureYear')} /><Input label="Load cell serial (optional)" value={f.loadCellSerial} onChange={set('loadCellSerial')} /><Input label="Display count (optional)" inputMode="numeric" value={f.displayCount} onChange={set('displayCount')} /></div></>}
        {step === 3 && <><Input label="Where is it used? Address" value={f.address} onChange={set('address')} required autoComplete="street-address" /><Select label="Area" value={f.areaId} onChange={set('areaId')} required><option value="">Select…</option>{wards.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></>}
        {step === 4 && (isTrader ? <><Select label="Whose instrument is this?" value={f.customerBusinessId} onChange={set('customerBusinessId')}><option value="">My own</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.firmName}</option>)}</Select><AddCustomer wards={wards} onAdded={async (id) => { await customers.reload(); setF((x) => ({ ...x, customerBusinessId: id })); }} /></> : <p>This instrument will be registered under <b>{me?.businesses[0]?.firmName}</b>.</p>)}
        {step === 5 && <><dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"><dt className="text-muted">Category</dt><dd>{category?.name}</dd><dt className="text-muted">Capacity</dt><dd>{f.capacity} {band?.unit}</dd><dt className="text-muted">Serial / make</dt><dd>{f.serialNo} / {f.make}</dd><dt className="text-muted">Place</dt><dd>{f.address}</dd></dl>
          <label className="flex min-h-11 items-start gap-3"><input type="checkbox" className="mt-1 size-5" checked={f.declaration} onChange={(e) => setF({ ...f, declaration: e.target.checked })} /><span className="text-sm">I declare that these details are true and the instrument is in my control or registered on a customer&apos;s request.</span></label></>}
        {step === 6 && (dup ? <div className="space-y-3"><Alert tone="warn">An instrument with this serial number, make and category is already registered. If you believe yours is a different one, ask an officer to review it.</Alert><ErrorNote error={err} />
            <ConfirmOtp onVerified={setToken} /><p className="text-xs text-muted">Confirm with a new code to send the review request.</p>{token && <Button onClick={() => submit(true)} loading={busy}>Send for officer review</Button>}</div>
          : <div className="space-y-3"><p>For safety, confirm with a code sent to your registered mobile number.</p>{token ? <Alert tone="ok">Confirmed.</Alert> : <ConfirmOtp onVerified={setToken} />}<ErrorNote error={err} />{token && <Button onClick={() => submit(false)} loading={busy}>Register instrument</Button>}</div>)}
        {step < 6 && <ErrorNote error={err} />}
        <div className="flex items-center justify-between gap-2 pt-2"><Button variant="secondary" onClick={() => { setErr(null); setStep(step - 1); }} disabled={step === 1 || busy}>{t('a.back')}</Button><span role="status" className="text-xs text-muted">{saved}</span>
          {step < 6 && <Button onClick={() => { setErr(null); setStep(step + 1); }} disabled={!valid}>{t('a.next')}</Button>}</div>
      </Card></div>
  );
}

/** Sends the confirmation code to the signed-in person's own number (the server knows it) and returns the single-use token. */
function ConfirmOtp({ onVerified }: { onVerified: (t: string) => void }) {
  const [ch, setCh] = useState<string | null>(null); const [code, setCode] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const send = async () => { setBusy(true); setErr(null); try { setCh((await post<{ challengeId: string }>('/auth/otp/confirm/send')).challengeId); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const verify = async () => { setBusy(true); setErr(null); try { onVerified((await post<{ verificationToken: string }>('/auth/otp/confirm/verify', { challengeId: ch, code })).verificationToken); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <div className="space-y-3">{!ch ? <Button onClick={send} loading={busy}>Send code</Button> : <><Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /><Button onClick={verify} loading={busy} disabled={code.length !== 6}>Verify</Button></>}<ErrorNote error={err} /></div>;
}

function AddCustomer({ wards, onAdded }: { wards: { id: string; name: string }[]; onAdded: (id: string) => void }) {
  const [open, setOpen] = useState(false); const [firm, setFirm] = useState(''); const [area, setArea] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const add = async () => { setBusy(true); setErr(null); try { const r = await post<{ id: string }>('/me/customers', { firmName: firm, areaId: area }); setOpen(false); setFirm(''); onAdded(r.id); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>Add a customer</Button>;
  return <div className="space-y-3 rounded-lg border border-line p-3"><Input label="Customer business name" value={firm} onChange={(e) => setFirm(e.target.value)} /><Select label="Customer area" value={area} onChange={(e) => setArea(e.target.value)}><option value="">Select…</option>{wards.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select><ErrorNote error={err} /><div className="flex gap-2"><Button onClick={add} loading={busy} disabled={firm.length < 2 || !area}>Add</Button><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button></div></div>;
}
