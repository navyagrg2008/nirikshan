'use client';
import { use, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { get, post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { fmtDay, typeLabel } from '@/lib/cases';
import type { Instrument } from '@/lib/catalog';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';

interface Pre { instrumentNo: string; type: string; eligible: boolean; blockers: string[]; warnings: string[]; due: { dueDate: string; applyByDate: string; graceEndsOn: string; overdue: boolean; applyByPassed: boolean }; requiredDocuments: { id: string; code: string; nameEn: string; nameHi: string | null; required: boolean; maxSizeMb: number }[]; openApplicationId: string | null; firstAvailableDay: string | null }
const BLOCK: Record<string, string> = {
  INSTRUMENT_DEREGISTERED: 'This instrument has been removed from your list.', OPEN_APPLICATION_EXISTS: 'This instrument already has an application in progress.', ALREADY_VERIFIED: 'This instrument was already verified. Choose renewal or re-verification.',
  NOT_YET_VERIFIED: 'This instrument has not been verified yet. Choose new verification.', NO_ACTIVE_RULES: 'Verification rules are not published yet.',
};
const WARN: Record<string, string> = {
  OVERDUE: 'Your verification date has passed. You can still apply, and the officer will see the date.', APPLY_BY_PASSED: 'You are applying after the recommended last date, so the visit may happen after the due date.',
  NO_SLOTS_IN_HORIZON: 'No inspector slot is free in the next three weeks. You can still apply. An officer will arrange a time and you will be told.',
};

export default function Apply({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); const { lang } = useI18n(); const router = useRouter(); const inst = useFetch<Instrument>(`/instruments/${id}`);
  const [type, setType] = useState(''); const [pre, setPre] = useState<Pre | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [checking, setChecking] = useState(false);
  const [f, setF] = useState({ preferredFrom: '', preferredTo: '', accessHours: '', contactName: '', contactPhone: '', ok: false });
  useEffect(() => { if (inst.data && !type) setType(inst.data.firstVerifiedAt ? 'RENEWAL' : 'NEW'); }, [inst.data, type]);
  useEffect(() => {
    if (!type) return; let live = true; setChecking(true); setErr(null);
    get<Pre>(`/instruments/${id}/precheck?type=${type}`).then((r) => live && setPre(r)).catch((e) => live && setErr(e)).finally(() => live && setChecking(false));
    return () => { live = false; };
  }, [id, type]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await post<{ id: string }>('/applications', { instrumentId: id, type, declarationAccepted: true, ...(f.preferredFrom ? { preferredFrom: f.preferredFrom } : {}), ...(f.preferredTo ? { preferredTo: f.preferredTo } : {}), ...(f.accessHours ? { accessHours: f.accessHours } : {}),
        ...(f.contactName ? { contactPerson: { name: f.contactName, ...(f.contactPhone ? { phone: f.contactPhone } : {}) } } : {}) }, true);
      router.push(`/owner/applications/${r.id}`);
    } catch (x) { setErr(x); setBusy(false); }
  };
  if (inst.loading && !inst.data) return <Loading />;
  const i = inst.data;
  return (
    <div className="mx-auto max-w-3xl"><Link href={`/owner/instruments/${id}`} className="text-sm text-primary underline">← Back to instrument</Link>
      <PageTitle>Apply for verification</PageTitle>
      {i && <p className="mb-4 text-muted">{i.instrumentNo} · {i.category.name} · {+i.capacity} {i.capacityUnit} · serial {i.serialNo}</p>}
      <form onSubmit={submit} className="space-y-5">
        <Card className="space-y-4"><Select label="What do you need?" value={type} onChange={(e) => { setType(e.target.value); setPre(null); }}>{['NEW', 'RE_VERIFICATION', 'RENEWAL', 'RE_TEST'].map((t) => <option key={t} value={t}>{typeLabel(t, lang)}</option>)}</Select>
          {checking && <Loading />}<ErrorNote error={err} />
          {pre && <>
            {pre.blockers.map((b) => <Alert key={b} tone="danger">{BLOCK[b] ?? b}{b === 'OPEN_APPLICATION_EXISTS' && pre.openApplicationId && <> <Link className="underline" href={`/owner/applications/${pre.openApplicationId}`}>Open it</Link></>}</Alert>)}
            {pre.warnings.map((w) => <Alert key={w} tone="warn">{WARN[w] ?? w}</Alert>)}
            <dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted">Verification due</dt><dd className="font-medium">{fmtDay(pre.due.dueDate, lang)}</dd></div><div><dt className="text-xs text-muted">Apply by</dt><dd className="font-medium">{fmtDay(pre.due.applyByDate, lang)}</dd></div><div><dt className="text-xs text-muted">Earliest visit</dt><dd className="font-medium">{pre.firstAvailableDay ? fmtDay(pre.firstAvailableDay, lang) : 'To be arranged'}</dd></div></dl>
            <p className="text-xs text-muted">These dates are worked out by the portal from the published rules. You cannot change them.</p></>}
        </Card>
        {pre && <Card className="space-y-3"><h2 className="font-semibold">Documents you will need</h2><p className="text-sm text-muted">You will upload these on the next page. PDF, JPEG or PNG, up to 5 MB each.</p>
          <ul className="space-y-1 text-sm">{pre.requiredDocuments.map((d) => <li key={d.id} className="flex items-center gap-2">{lang === 'hi' && d.nameHi ? d.nameHi : d.nameEn} <Badge tone={d.required ? 'info' : 'muted'}>{d.required ? 'Required' : 'Optional'}</Badge></li>)}</ul></Card>}
        {pre && <Card className="space-y-4"><h2 className="font-semibold">Visit preferences (optional)</h2>
          <div className="grid gap-4 sm:grid-cols-2"><Input label="Preferred from" type="date" value={f.preferredFrom} onChange={(e) => setF({ ...f, preferredFrom: e.target.value })} /><Input label="Preferred to" type="date" value={f.preferredTo} min={f.preferredFrom} onChange={(e) => setF({ ...f, preferredTo: e.target.value })} /></div>
          <Input label="Hours when someone is at the premises" value={f.accessHours} maxLength={100} placeholder="e.g. 10am to 6pm" onChange={(e) => setF({ ...f, accessHours: e.target.value })} />
          <div className="grid gap-4 sm:grid-cols-2"><Input label="Contact person at the premises" value={f.contactName} maxLength={80} onChange={(e) => setF({ ...f, contactName: e.target.value })} /><Input label="Their mobile number" inputMode="numeric" maxLength={10} value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value.replace(/\D/g, '') })} /></div>
          <p className="text-xs text-muted">Preferences are tried first. If they are not possible, the portal chooses the nearest free time.</p></Card>}
        {pre && <Card className="space-y-4"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-5" checked={f.ok} onChange={(e) => setF({ ...f, ok: e.target.checked })} /><span>I confirm the instrument details are correct and I will keep the instrument ready, unaltered and accessible for the visit.</span></label>
          <p className="text-sm text-muted">There is no fee for applying or for verification.</p>
          <Button type="submit" loading={busy} disabled={!f.ok || !pre.eligible}>Submit application</Button></Card>}
      </form>
    </div>
  );
}
