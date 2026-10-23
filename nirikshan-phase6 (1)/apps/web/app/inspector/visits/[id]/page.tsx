'use client';
import { use, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { allowedRecommendations, evaluateChecklist, overallVerdict, type ChecklistItem as SItem } from '@nirikshan/shared';
import { api, get, post, put } from '@/lib/api';
import { fmtDateTime, fmtWindow } from '@/lib/cases';
import { DECIMAL, MPE_DIR, REC, evidenceLabel, recLabel, useTr, verdictLabel, verdictTone, type Answer, type DraftData, type EvidenceRow, type Recommendation, type TrialRow, type VisitDone, type VisitOpen } from '@/lib/inspection';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle, Textarea } from '@/components/ui';

type Pos = { lat: number; lon: number; accuracyM: number };
const here = (): Promise<Pos> => new Promise((ok, no) => {
  if (!navigator.geolocation) return no(new Error('GEO_UNAVAILABLE'));
  navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }), (e) => no(e), { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 });
});
const STEPS: [string, string][] = [['Arrive', 'पहुँचें'], ['Checklist', 'जाँच-सूची'], ['Test', 'परीक्षण'], ['Photos & decision', 'फ़ोटो व सिफ़ारिश'], ['Review & submit', 'जाँचें व जमा करें']];

export default function Visit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const { tr } = useTr();
  const [v, setV] = useState<VisitOpen | VisitDone | null>(null); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(async () => { try { setV(await get<VisitOpen | VisitDone>(`/inspector/visits/${id}`)); setErr(null); } catch (e) { setErr(e); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  if (!v) return err ? <ErrorNote error={err} /> : <Loading />;
  if (v.readOnly) return <Done v={v} />;
  return <Work v={v} reload={load} tr={tr} />;
}

function Done({ v }: { v: VisitDone }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi'; const [err, setErr] = useState<unknown>(null);
  const sheet = async () => { try { const r = await get<{ url: string }>(`/visits/${v.id}/test-sheet/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  return (
    <div className="mx-auto max-w-3xl space-y-4"><Link href="/inspector/history" className="text-sm text-primary underline">← {tr('History', 'इतिहास')}</Link>
      <PageTitle actions={<Badge tone={verdictTone(v.overall)}>{verdictLabel(v.overall, hi)}</Badge>}>{tr('Submitted inspection', 'जमा किया गया निरीक्षण')}</PageTitle>
      <ErrorNote error={err} />
      <Card className="space-y-2"><p>{tr('Submitted', 'जमा किया')}: {fmtDateTime(v.submittedAt, lang)}</p><p>{tr('Your recommendation', 'आपकी सिफ़ारिश')}: <b>{recLabel(v.recommendation, hi)}</b></p>{v.stickerSerial && <p>{tr('Sticker', 'स्टिकर')}: <span className="font-mono">{v.stickerSerial}</span></p>}{v.note && <p className="text-muted">“{v.note}”</p>}
        {v.hasTestSheet && <Button variant="secondary" onClick={sheet}>{tr('Open test sheet (PDF)', 'परीक्षण पत्रक खोलें (PDF)')}</Button>}</Card>
      <TrialTable rows={v.trials} />
    </div>
  );
}

function TrialTable({ rows }: { rows: TrialRow[] }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi';
  return (
    <div className="relative overflow-x-auto" tabIndex={0} role="region" aria-label={tr('Test results table', 'परीक्षण नतीजों की तालिका')}><table className="w-full min-w-[34rem] text-left text-sm"><caption className="sr-only">{tr('Test results calculated by the server', 'सर्वर द्वारा निकाले गए परीक्षण नतीजे')}</caption>
      <thead><tr className="text-xs text-muted"><th scope="col" className="py-1">#</th><th scope="col">{tr('Reference', 'संदर्भ')}</th><th scope="col">{tr('Reading', 'रीडिंग')}</th><th scope="col">{tr('Error', 'त्रुटि')}</th><th scope="col">%</th><th scope="col">{tr('Limit', 'सीमा')}</th><th scope="col">{tr('Result', 'नतीजा')}</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.trialNo} className="border-t border-line"><th scope="row" className="py-2 font-normal">{r.trialNo}</th><td>{trim(r.reference)} {r.unit}</td><td>{trim(r.observed)} {r.unit}</td><td>{trim(r.errorValue)} {r.errorUnit}</td><td>{trim(r.errorPct)}</td><td>±{trim(r.mpeValue)} {r.errorUnit}</td><td><Badge tone={verdictTone(r.verdict)}>{verdictLabel(r.verdict, hi)}</Badge></td></tr>)}</tbody></table></div>
  );
}
const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

function Work({ v, reload, tr }: { v: VisitOpen; reload: () => Promise<void>; tr: (a: string, b: string) => string }) {
  const { lang } = useTr(); const hi = lang === 'hi';
  const started = v.status === 'IN_PROGRESS';
  const d0 = v.draft?.data;
  const [step, setStep] = useState(started ? Math.max(2, d0?.step ?? 2) : 1);
  const [checklist, setChecklist] = useState<Record<string, Answer>>(d0?.checklist ?? {});
  const [trials, setTrials] = useState<{ reference: string; observed: string }[]>(d0?.trials?.length ? d0.trials : Array.from({ length: v.settings.minTrials }, () => ({ reference: '', observed: '' })));
  const [rec, setRec] = useState<Recommendation | null>(d0?.recommendation ?? null);
  const [codes, setCodes] = useState<string[]>(d0?.rejectReasonCodes ?? []);
  const [note, setNote] = useState(d0?.note ?? ''); const [sticker, setSticker] = useState(d0?.stickerSerial ?? '');
  const [evidence, setEvidence] = useState<EvidenceRow[]>(v.evidence);
  const [saved, setSaved] = useState<string | null>(v.draft?.savedAt ?? null); const [saveErr, setSaveErr] = useState(false);
  const [restored] = useState(!!v.draft);

  // Draft autosave: 1.5 s after the last change. Only while the visit is open.
  const first = useRef(true);
  useEffect(() => {
    if (!started) return;
    if (first.current) { first.current = false; return; }
    const body: DraftData = { step, checklist, trials, recommendation: rec, rejectReasonCodes: codes, note, stickerSerial: sticker };
    const h = setTimeout(async () => { try { const r = await put<{ savedAt: string }>(`/inspector/visits/${v.id}/draft`, body); setSaved(r.savedAt); setSaveErr(false); } catch { setSaveErr(true); } }, 1500);
    return () => clearTimeout(h);
  }, [started, v.id, step, checklist, trials, rec, codes, note, sticker]);

  const items = v.checklist.items as SItem[];
  const ev = useMemo(() => evaluateChecklist(items, checklist), [items, checklist]);
  const checklistOk = ev.missing.length === 0 && ev.needRemark.length === 0 && ev.invalidNA.length === 0;
  const trialsFilled = trials.filter((t) => t.reference && t.observed);
  const trialsValid = trialsFilled.length >= v.settings.minTrials && trialsFilled.every((t) => DECIMAL.test(t.reference) && DECIMAL.test(t.observed));

  return (
    <div className="mx-auto max-w-3xl space-y-5"><Link href="/inspector/dashboard" className="text-sm text-primary underline">← {tr('Your visits', 'आपके दौरे')}</Link>
      <PageTitle>{v.applicationNo}</PageTitle>
      <p className="-mt-3 text-muted">{v.instrument.category} · {v.instrument.instrumentNo} · {v.instrument.capacity} · {v.area}</p>
      <nav aria-label={tr('Steps', 'चरण')}><ol className="flex flex-wrap gap-2 text-sm">{STEPS.map(([en, h], i) => {
        const n = i + 1; const reach = n === 1 || started;
        return <li key={n}><button type="button" disabled={!reach} aria-current={step === n ? 'step' : undefined} onClick={() => setStep(n)} className="min-h-11 rounded-lg border border-line px-3 disabled:opacity-50 aria-[current=step]:border-primary aria-[current=step]:bg-primary-soft aria-[current=step]:font-semibold">{n}. {hi ? h : en}</button></li>;
      })}</ol></nav>
      {started && <p className="text-xs text-muted" role="status" aria-live="polite">{saveErr ? tr('Could not save the draft. Check your connection; your entries are still on this screen.', 'ड्राफ़्ट सेव नहीं हुआ। कनेक्शन देखें; आपकी प्रविष्टियाँ इस स्क्रीन पर हैं।') : saved ? `${tr('Draft saved', 'ड्राफ़्ट सेव हुआ')} ${fmtDateTime(saved, lang)}` : tr('Your work is saved as a private draft as you go.', 'आपका काम निजी ड्राफ़्ट के रूप में अपने आप सेव होता है।')}{restored && saved === v.draft?.savedAt ? ` · ${tr('restored your earlier draft', 'पिछला ड्राफ़्ट वापस लाया गया')}` : ''}</p>}

      {step === 1 && <Arrive v={v} started={started} onDone={async () => { await reload(); setStep(2); }} />}
      {step === 2 && <Checklist items={items} checklist={checklist} setChecklist={setChecklist} ev={ev} onNext={() => setStep(3)} />}
      {step === 3 && <Test v={v} trials={trials} setTrials={setTrials} valid={trialsValid} onNext={() => setStep(4)} />}
      {step === 4 && <Decide v={v} items={items} checklist={checklist} trials={trials} trialsValid={trialsValid} evidence={evidence} setEvidence={setEvidence} rec={rec} setRec={setRec} codes={codes} setCodes={setCodes} note={note} setNote={setNote} sticker={sticker} setSticker={setSticker} onNext={() => setStep(5)} />}
      {step === 5 && <Review v={v} items={items} checklist={checklist} trials={trials} evidence={evidence} rec={rec} codes={codes} note={note} sticker={sticker} checklistOk={checklistOk} trialsValid={trialsValid} setStep={setStep} />}
    </div>
  );
}

// ---------------------------------------------------------------- step 1
function Arrive({ v, started, onDone }: { v: VisitOpen; started: boolean; onDone: () => Promise<void> }) {
  const { tr, lang } = useTr(); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [geoErr, setGeoErr] = useState(''); const [why, setWhy] = useState(''); const [need, setNeed] = useState<{ distanceM: number; radiusM: number } | null>(null);
  const go = async (e?: FormEvent) => {
    e?.preventDefault(); setBusy(true); setErr(null); setGeoErr('');
    let p: Pos;
    try { p = await here(); } catch { setGeoErr(tr('We could not read your location. Allow location access for this site and try again.', 'आपकी लोकेशन नहीं मिली। इस साइट को लोकेशन की अनुमति दें और फिर कोशिश करें।')); setBusy(false); return; }
    try { await post(`/inspector/visits/${v.id}/arrive`, { lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, ...(need && why ? { justification: why } : {}) }, true); await onDone(); }
    catch (x) { const b = x as { code?: string; body?: { distanceM?: number; radiusM?: number } }; if (b.code === 'JUSTIFICATION_REQUIRED') setNeed({ distanceM: b.body?.distanceM ?? 0, radiusM: b.body?.radiusM ?? v.settings.geofenceRadiusM }); setErr(x); setBusy(false); }
  };
  return (
    <Card className="space-y-4"><h2 className="font-semibold">{tr('1. Arrive at the premises', '1. परिसर पर पहुँचें')}</h2>
      <p className="text-lg font-medium">{fmtWindow(v.window.start, v.window.end, lang)}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted">{tr('Instrument', 'उपकरण')}</dt><dd>{v.instrument.make} {v.instrument.model} · {tr('serial', 'क्रम')} {v.instrument.serialNo}</dd></div><div><dt className="text-muted">{tr('Class / capacity', 'श्रेणी / क्षमता')}</dt><dd>{v.instrument.accuracyClass} · {v.instrument.capacity}</dd></div>
        <div className="sm:col-span-2"><dt className="text-muted">{tr('Address (shown to you for this visit only)', 'पता (केवल इस दौरे के लिए)')}</dt><dd>{v.address ?? '—'}</dd></div>{v.accessHours && <div><dt className="text-muted">{tr('Access hours', 'पहुँच का समय')}</dt><dd>{v.accessHours}</dd></div>}</dl>
      {started && v.arrival ? <Alert tone={v.arrival.geofenceOk === false ? 'warn' : 'ok'}>{tr('You arrived at', 'आप पहुँचे')} {fmtDateTime(v.arrival.at, lang)}.{v.arrival.distanceM != null && ` ${tr('Distance from premises', 'परिसर से दूरी')}: ${Math.round(v.arrival.distanceM)} m.`}</Alert>
        : <form onSubmit={go} className="space-y-3"><p className="text-sm text-muted">{tr('Your phone location is used once, to confirm you are at the premises. It is stored with this visit.', 'आपकी लोकेशन एक बार, परिसर पर होने की पुष्टि के लिए ली जाती है। यह इस दौरे के साथ सेव होती है।')}</p>
          {need && <Textarea label={tr(`You are ${need.distanceM} m away (limit ${need.radiusM} m). Why are you starting here?`, `आप ${need.distanceM} m दूर हैं (सीमा ${need.radiusM} m)। यहाँ से शुरू करने का कारण?`)} value={why} required minLength={10} maxLength={500} onChange={(e) => setWhy(e.target.value)} />}
          {geoErr && <Alert tone="warn">{geoErr}</Alert>}<ErrorNote error={err} /><Button type="submit" loading={busy}>{tr('Share my location and start', 'लोकेशन साझा करें और शुरू करें')}</Button></form>}
    </Card>
  );
}

// ---------------------------------------------------------------- step 2
function Checklist({ items, checklist, setChecklist, ev, onNext }: { items: SItem[]; checklist: Record<string, Answer>; setChecklist: (f: (c: Record<string, Answer>) => Record<string, Answer>) => void; ev: ReturnType<typeof evaluateChecklist>; onNext: () => void }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi';
  const set = (code: string, p: Partial<Answer>) => setChecklist((c) => ({ ...c, [code]: { ...(c[code] ?? { answer: 'YES' as const }), ...p } }));
  const done = items.filter((i) => checklist[i.code]).length;
  return (
    <div className="space-y-4"><h2 className="font-semibold">{tr('2. Checklist', '2. जाँच-सूची')} <span className="text-sm font-normal text-muted">({done}/{items.length})</span></h2>
      {items.map((it) => {
        const a = checklist[it.code]; const failed = !!a && a.answer !== 'NA' && a.answer !== it.pass; const canNA = !it.critical && !it.required; const name = `c-${it.code}`;
        return (
          <Card key={it.code} className="space-y-3"><fieldset><legend className="font-medium">{hi && it.textHi ? it.textHi : it.textEn} {it.critical && <Badge tone="danger">{tr('Critical', 'महत्वपूर्ण')}</Badge>}</legend>
            {it.hintEn && !hi && <p className="text-xs text-muted">{it.hintEn}</p>}
            <div className="mt-2 flex flex-wrap gap-2">{(['YES', 'NO', ...(canNA ? ['NA' as const] : [])] as ('YES' | 'NO' | 'NA')[]).map((o) => (
              <label key={o} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line px-4 has-[:checked]:border-primary has-[:checked]:bg-primary-soft"><input type="radio" name={name} value={o} checked={a?.answer === o} onChange={() => set(it.code, { answer: o })} />{o === 'YES' ? tr('Yes', 'हाँ') : o === 'NO' ? tr('No', 'नहीं') : tr('Not applicable', 'लागू नहीं')}</label>))}</div></fieldset>
            {failed && <Textarea label={tr('Say what you found (required)', 'क्या मिला, लिखें (ज़रूरी)')} value={a?.remark ?? ''} minLength={3} maxLength={500} required onChange={(e) => set(it.code, { remark: e.target.value })} error={ev.needRemark.includes(it.code) ? tr('A short note is needed for this answer.', 'इस उत्तर के लिए छोटा नोट ज़रूरी है।') : undefined} />}
          </Card>);
      })}
      {ev.failedCritical.length > 0 && <Alert tone="warn">{tr('A critical item failed. You will not be able to recommend approval.', 'एक महत्वपूर्ण बिंदु असफल है। आप स्वीकृति की सिफ़ारिश नहीं कर पाएँगे।')}</Alert>}
      <div className="flex justify-end"><Button onClick={onNext} disabled={ev.missing.length > 0 || ev.needRemark.length > 0}>{tr('Next: test', 'आगे: परीक्षण')}</Button></div>
    </div>
  );
}

// ---------------------------------------------------------------- step 3
function Test({ v, trials, setTrials, valid, onNext }: { v: VisitOpen; trials: { reference: string; observed: string }[]; setTrials: (t: { reference: string; observed: string }[]) => void; valid: boolean; onNext: () => void }) {
  const { tr } = useTr(); const [res, setRes] = useState<{ trials: TrialRow[]; overall: string | null } | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const unit = v.instrument.capacityUnit;
  const upd = (i: number, k: 'reference' | 'observed', val: string) => { setRes(null); setTrials(trials.map((t, n) => (n === i ? { ...t, [k]: val } : t))); };
  const bad = (s: string) => (s && !DECIMAL.test(s) ? tr('Use digits and one decimal point, up to 6 decimals.', 'अंक और एक दशमलव बिंदु (अधिकतम 6 दशमलव) भरें।') : undefined);
  const check = async () => {
    setBusy(true); setErr(null);
    try { setRes(await post<{ trials: TrialRow[]; overall: string | null }>(`/inspector/visits/${v.id}/trials/compute`, { trials: trials.filter((t) => t.reference && t.observed) })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const { lang } = useTr();
  return (
    <div className="space-y-4"><h2 className="font-semibold">{tr('3. Test readings', '3. परीक्षण रीडिंग')}</h2>
      <Alert tone="info">{tr(`Enter the reference load and what the instrument showed, in ${unit}. The server works out the error and the result. Permitted error: ${MPE_DIR[v.mpe.direction] ?? ''}${trim(v.mpe.value)} ${v.mpe.unit} (rule version ${v.rules.version}). At least ${v.settings.minTrials} readings.`, `संदर्भ भार और उपकरण की रीडिंग ${unit} में भरें। त्रुटि और नतीजा सर्वर निकालता है। अनुमत त्रुटि: ${MPE_DIR[v.mpe.direction] ?? ''}${trim(v.mpe.value)} ${v.mpe.unit} (नियम संस्करण ${v.rules.version})। कम से कम ${v.settings.minTrials} रीडिंग।`)}</Alert>
      {trials.map((t, i) => (
        <Card key={i} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><Input label={`${tr('Reading', 'रीडिंग')} ${i + 1}: ${tr('reference', 'संदर्भ')} (${unit})`} inputMode="decimal" value={t.reference} error={bad(t.reference)} onChange={(e) => upd(i, 'reference', e.target.value.trim())} />
          <Input label={`${tr('Instrument showed', 'उपकरण ने दिखाया')} (${unit})`} inputMode="decimal" value={t.observed} error={bad(t.observed)} onChange={(e) => upd(i, 'observed', e.target.value.trim())} />
          {trials.length > v.settings.minTrials && <Button variant="ghost" type="button" aria-label={`${tr('Remove reading', 'रीडिंग हटाएँ')} ${i + 1}`} onClick={() => { setRes(null); setTrials(trials.filter((_, n) => n !== i)); }}>✕</Button>}</Card>))}
      {trials.length < 20 && <Button variant="secondary" type="button" onClick={() => setTrials([...trials, { reference: '', observed: '' }])}>{tr('Add a reading', 'रीडिंग जोड़ें')}</Button>}
      <ErrorNote error={err} />
      <div className="flex flex-wrap items-center gap-3"><Button onClick={check} loading={busy} disabled={!valid}>{tr('Check results', 'नतीजे जाँचें')}</Button>{res && <Badge tone={verdictTone(res.overall)}>{tr('Overall', 'कुल')}: {verdictLabel(res.overall, lang === 'hi')}</Badge>}</div>
      {res && <Card><TrialTable rows={res.trials} /></Card>}
      <div className="flex justify-end"><Button onClick={onNext} disabled={!valid}>{tr('Next: photos and decision', 'आगे: फ़ोटो और सिफ़ारिश')}</Button></div>
    </div>
  );
}

// ---------------------------------------------------------------- step 4
function Decide(p: { v: VisitOpen; items: SItem[]; checklist: Record<string, Answer>; trials: { reference: string; observed: string }[]; trialsValid: boolean; evidence: EvidenceRow[]; setEvidence: (e: EvidenceRow[]) => void; rec: Recommendation | null; setRec: (r: Recommendation) => void; codes: string[]; setCodes: (c: string[]) => void; note: string; setNote: (s: string) => void; sticker: string; setSticker: (s: string) => void; onNext: () => void }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi'; const { v } = p;
  const [kind, setKind] = useState('DISPLAY'); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [overall, setOverall] = useState<string | null>(null);
  // Hint only: the server recomputes the verdict and the allowed recommendations at submit.
  useEffect(() => { let live = true; if (!p.trialsValid) { setOverall(null); return; } post<{ overall: string | null }>(`/inspector/visits/${v.id}/trials/compute`, { trials: p.trials.filter((t) => t.reference && t.observed) }).then((r) => { if (live) setOverall(r.overall); }).catch(() => undefined); return () => { live = false; }; }, [v.id, p.trials, p.trialsValid]);
  const fc = useMemo(() => evaluateChecklist(p.items, p.checklist).failedCritical, [p.items, p.checklist]);
  const allowed = allowedRecommendations(overall as 'PASS' | 'MARGINAL_PASS' | 'FAIL' | null, fc).allowed;
  const have = new Set(p.evidence.map((e) => e.kind)); const missing = v.settings.requiredEvidence.filter((k) => !have.has(k));
  const upload = async (file: File) => {
    setBusy(true); setErr(null);
    try {
      let pos: Pos; try { pos = await here(); } catch { throw Object.assign(new Error('GEO_REQUIRED'), { code: 'GEO_REQUIRED' }); }
      const form = new FormData(); form.set('kind', kind); form.set('lat', String(pos.lat)); form.set('lon', String(pos.lon)); form.set('file', file);
      const r = await api<EvidenceRow>(`/inspector/visits/${v.id}/evidence`, { method: 'POST', form }); p.setEvidence([...p.evidence, r]);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const view = async (id: string) => { try { const r = await get<{ url: string }>(`/evidence/${id}/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(e); } };
  const toggle = (c: string) => p.setCodes(p.codes.includes(c) ? p.codes.filter((x) => x !== c) : [...p.codes, c].slice(0, 5));
  return (
    <div className="space-y-4"><h2 className="font-semibold">{tr('4. Photos and your recommendation', '4. फ़ोटो और आपकी सिफ़ारिश')}</h2>
      <Card className="space-y-3"><h3 className="font-medium">{tr('Photos', 'फ़ोटो')}</h3>
        <p className="text-sm text-muted">{tr('Required:', 'ज़रूरी:')} {v.settings.requiredEvidence.map((k) => evidenceLabel(k, hi)).join(', ')}. {tr('Each photo is tagged with your current location. Photos cannot be removed once added.', 'हर फ़ोटो पर आपकी मौजूदा लोकेशन दर्ज होती है। जोड़ी गई फ़ोटो हटाई नहीं जा सकती।')}</p>
        <ul className="space-y-1 text-sm">{p.evidence.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-2"><Badge tone="ok">{evidenceLabel(e.kind, hi)}</Badge><span className="text-muted">{fmtDateTime(e.capturedAt, lang)}{e.geoTagged ? ` · ${tr('location tagged', 'लोकेशन दर्ज')}` : ''}</span><button type="button" className="min-h-11 text-primary underline" onClick={() => view(e.id)}>{tr('View', 'देखें')}</button></li>)}</ul>
        {missing.length > 0 && <Alert tone="warn">{tr('Still needed:', 'अभी चाहिए:')} {missing.map((k) => evidenceLabel(k, hi)).join(', ')}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className="block text-sm font-medium">{tr('What does the photo show?', 'फ़ोटो में क्या है?')}</span><select value={kind} onChange={(e) => setKind(e.target.value)} className="min-h-11 w-full rounded-lg border border-line bg-surface px-3">{['DISPLAY', 'TEST_WEIGHTS', 'SEAL', 'TAMPER', 'OTHER'].map((k) => <option key={k} value={k}>{evidenceLabel(k, hi)}</option>)}</select></label>
          <label className="space-y-1"><span className="block text-sm font-medium">{tr('Take or choose a photo', 'फ़ोटो लें या चुनें')}</span><input type="file" accept="image/jpeg,image/png" capture="environment" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} className="block min-h-11 w-full text-sm" /></label></div>
        {busy && <p role="status" className="text-sm text-muted">{tr('Uploading and checking the photo…', 'फ़ोटो अपलोड और जाँची जा रही है…')}</p>}<ErrorNote error={err} /></Card>
      <Card className="space-y-3"><h3 className="font-medium">{tr('Recommendation', 'सिफ़ारिश')}</h3>
        {overall === 'FAIL' || fc.length > 0 ? <Alert tone="warn">{tr('A reading is outside the limit, or a critical item failed. Approval cannot be recommended.', 'एक रीडिंग सीमा से बाहर है या महत्वपूर्ण बिंदु असफल है। स्वीकृति की सिफ़ारिश नहीं हो सकती।')}</Alert> : null}
        <fieldset className="flex flex-wrap gap-2"><legend className="sr-only">{tr('Recommendation', 'सिफ़ारिश')}</legend>{(Object.keys(REC) as Recommendation[]).map((r) => (
          <label key={r} className={`flex min-h-11 items-center gap-2 rounded-lg border border-line px-4 has-[:checked]:border-primary has-[:checked]:bg-primary-soft ${allowed.includes(r) ? 'cursor-pointer' : 'opacity-50'}`}><input type="radio" name="rec" value={r} disabled={!allowed.includes(r)} checked={p.rec === r} onChange={() => p.setRec(r)} />{hi ? REC[r][1] : REC[r][0]}</label>))}</fieldset>
        {p.rec === 'RECOMMEND_APPROVE' && <Input label={tr('Sticker serial number you applied', 'आपके द्वारा लगाए स्टिकर की क्रम संख्या')} value={p.sticker} maxLength={40} required onChange={(e) => p.setSticker(e.target.value.toUpperCase())} />}
        {p.rec === 'RECOMMEND_REJECT' && <fieldset className="space-y-1"><legend className="text-sm font-medium">{tr('Reason (choose one or more)', 'कारण (एक या अधिक चुनें)')}</legend>{v.rejectReasons.map((r) => <label key={r.code} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={p.codes.includes(r.code)} onChange={() => toggle(r.code)} />{hi && r.textHi ? r.textHi : r.textEn}</label>)}</fieldset>}
        <Textarea label={tr('Note for the officer (optional)', 'अधिकारी के लिए नोट (वैकल्पिक)')} value={p.note} maxLength={1000} onChange={(e) => p.setNote(e.target.value)} />
      </Card>
      <div className="flex justify-end"><Button onClick={p.onNext} disabled={!p.rec}>{tr('Next: review', 'आगे: समीक्षा')}</Button></div>
    </div>
  );
}

// ---------------------------------------------------------------- step 5
function Review(p: { v: VisitOpen; items: SItem[]; checklist: Record<string, Answer>; trials: { reference: string; observed: string }[]; evidence: EvidenceRow[]; rec: Recommendation | null; codes: string[]; note: string; sticker: string; checklistOk: boolean; trialsValid: boolean; setStep: (n: number) => void }) {
  const { tr, lang } = useTr(); const hi = lang === 'hi'; const { v } = p; const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [done, setDone] = useState<null | { overall: string }>(null);
  const [res, setRes] = useState<TrialRow[] | null>(null);
  useEffect(() => { if (p.trialsValid) post<{ trials: TrialRow[] }>(`/inspector/visits/${v.id}/trials/compute`, { trials: p.trials.filter((t) => t.reference && t.observed) }).then((r) => setRes(r.trials)).catch(() => undefined); }, [v.id, p.trials, p.trialsValid]);
  const overall = res ? overallVerdict(res.map((r) => r.verdict)) : null;
  const have = new Set(p.evidence.map((e) => e.kind)); const missingEv = v.settings.requiredEvidence.filter((k) => !have.has(k));
  const problems = [!p.checklistOk && tr('The checklist is not complete.', 'जाँच-सूची पूरी नहीं है।'), !p.trialsValid && tr('Test readings are missing.', 'परीक्षण रीडिंग नहीं हैं।'), missingEv.length > 0 && tr('Required photos are missing.', 'ज़रूरी फ़ोटो नहीं हैं।'), !p.rec && tr('Choose a recommendation.', 'सिफ़ारिश चुनें।'), p.rec === 'RECOMMEND_APPROVE' && !p.sticker && tr('Enter the sticker serial number.', 'स्टिकर क्रम संख्या भरें।'), p.rec === 'RECOMMEND_REJECT' && p.codes.length === 0 && tr('Choose a rejection reason.', 'अस्वीकृति का कारण चुनें।')].filter(Boolean) as string[];
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post<{ overall: string }>(`/inspector/visits/${v.id}/submit`, { checklist: p.checklist, trials: p.trials.filter((t) => t.reference && t.observed), recommendation: p.rec, rejectReasonCodes: p.rec === 'RECOMMEND_REJECT' ? p.codes : [], note: p.note || undefined, stickerSerial: p.rec === 'RECOMMEND_APPROVE' ? p.sticker : undefined }, true);
      setDone(r);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (done) return <Card className="space-y-3"><Alert tone="ok">{tr('Submitted. The officer has been told. The test sheet is saved with the case.', 'जमा हो गया। अधिकारी को सूचना भेज दी गई है। परीक्षण पत्रक केस के साथ सेव है।')}</Alert><Link href="/inspector/dashboard" className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-ink">{tr('Back to your visits', 'अपने दौरों पर लौटें')}</Link></Card>;
  return (
    <div className="space-y-4"><h2 className="font-semibold">{tr('5. Review and submit', '5. समीक्षा और जमा करें')}</h2>
      <Card className="space-y-2 text-sm"><p>{tr('Checklist', 'जाँच-सूची')}: {Object.keys(p.checklist).length}/{p.items.length} <button className="ml-2 min-h-11 text-primary underline" onClick={() => p.setStep(2)}>{tr('Edit', 'बदलें')}</button></p>
        <p>{tr('Test readings', 'परीक्षण रीडिंग')}: {p.trials.filter((t) => t.reference && t.observed).length} <button className="ml-2 min-h-11 text-primary underline" onClick={() => p.setStep(3)}>{tr('Edit', 'बदलें')}</button></p>
        <p>{tr('Photos', 'फ़ोटो')}: {p.evidence.length}</p>
        <p>{tr('Recommendation', 'सिफ़ारिश')}: <b>{recLabel(p.rec, hi)}</b> <button className="ml-2 min-h-11 text-primary underline" onClick={() => p.setStep(4)}>{tr('Edit', 'बदलें')}</button></p>
        {overall && <p>{tr('Result worked out by the server', 'सर्वर द्वारा निकाला नतीजा')}: <Badge tone={verdictTone(overall)}>{verdictLabel(overall, hi)}</Badge></p>}</Card>
      {res && <Card><TrialTable rows={res} /></Card>}
      {problems.length > 0 && <Alert tone="warn"><ul className="list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul></Alert>}
      <ErrorNote error={err} />
      <p className="text-sm text-muted">{tr('After you submit, you cannot change this inspection. The server checks everything again.', 'जमा करने के बाद इस निरीक्षण में बदलाव नहीं होगा। सर्वर सब कुछ दोबारा जाँचता है।')}</p>
      <div className="flex justify-end"><Button onClick={submit} loading={busy} disabled={problems.length > 0}>{tr('Submit inspection', 'निरीक्षण जमा करें')}</Button></div>
    </div>
  );
}
