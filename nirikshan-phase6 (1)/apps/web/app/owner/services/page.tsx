'use client';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';
import Link from 'next/link';

interface Job { id: string; stage: string; issue: string | null; technicianName: string | null; notes: string | null; createdAt: string; updatedAt: string; applicationId: string | null; instrumentId: string; instrumentNo: string; category: string }
interface Inst { id: string; instrumentNo: string; category: { name: string }; status: string }
const STAGE: Record<string, [string, string]> = { REPORTED: ['Reported', 'दर्ज'], TECHNICIAN_ASSIGNED: ['Technician assigned', 'तकनीशियन नियुक्त'], REPAIRED: ['Repaired', 'मरम्मत हुई'], READY_FOR_VERIFICATION: ['Sent for verification', 'सत्यापन के लिए भेजा'] };
const NEXT: Record<string, ['TECHNICIAN_ASSIGNED' | 'REPAIRED' | 'READY_FOR_VERIFICATION', string, string]> = { REPORTED: ['TECHNICIAN_ASSIGNED', 'Assign technician', 'तकनीशियन नियुक्त करें'], TECHNICIAN_ASSIGNED: ['REPAIRED', 'Mark as repaired', 'मरम्मत हुई दर्ज करें'], REPAIRED: ['READY_FOR_VERIFICATION', 'Send for re-verification', 'पुनः सत्यापन के लिए भेजें'] };

export default function Services() {
  const { tr, lang } = useTr(); const jobs = useFetch<{ items: Job[] }>('/service-jobs'); const [insts, setInsts] = useState<Inst[] | null>(null);
  const [f, setF] = useState({ instrumentId: '', issue: '' }); const [tech, setTech] = useState<Record<string, string>>({}); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState('');
  const loadInsts = async () => { if (insts) return; try { setInsts((await get<{ items: Inst[] }>('/instruments?limit=100')).items.filter((i) => i.status !== 'DEREGISTERED')); } catch (e) { setErr(e); } };
  const create = async () => { setBusy('new'); setErr(null); try { await post('/service-jobs', { instrumentId: f.instrumentId, issue: f.issue }, true); setF({ instrumentId: '', issue: '' }); await jobs.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  const adv = async (j: Job) => { const n = NEXT[j.stage]!; setBusy(j.id); setErr(null); try { await post(`/service-jobs/${j.id}/advance`, { to: n[0], ...(n[0] === 'TECHNICIAN_ASSIGNED' ? { technicianName: tech[j.id] } : {}) }, true); await jobs.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  const idx = (s: string) => Object.keys(STAGE).indexOf(s);
  return (
    <div className="mx-auto max-w-3xl space-y-4"><PageTitle>{tr('Repair jobs', 'मरम्मत कार्य')}</PageTitle>
      <p className="text-sm text-muted">{tr('Keep track of instruments you are repairing for customers. When the repair is done, send it for re-verification and a new application is opened for the owner.', 'ग्राहकों के उपकरणों की मरम्मत का हिसाब रखें। मरम्मत पूरी होने पर पुनः सत्यापन के लिए भेजें; स्वामी के लिए नया आवेदन खुल जाएगा।')}</p>
      <ErrorNote error={err} />
      <Card className="space-y-3"><h2 className="font-semibold">{tr('New repair job', 'नया मरम्मत कार्य')}</h2>
        <Select label={tr('Instrument', 'उपकरण')} value={f.instrumentId} onFocus={loadInsts} onClick={loadInsts} onChange={(e) => setF({ ...f, instrumentId: e.target.value })}><option value="">{insts ? tr('Choose', 'चुनें') : tr('Choose (loads on open)', 'चुनें')}</option>{insts?.map((i) => <option key={i.id} value={i.id}>{i.instrumentNo} · {i.category.name}</option>)}</Select>
        <Input label={tr('What is wrong?', 'क्या ख़राबी है?')} value={f.issue} maxLength={300} onChange={(e) => setF({ ...f, issue: e.target.value })} />
        <Button disabled={!f.instrumentId || f.issue.trim().length < 3} loading={busy === 'new'} onClick={create}>{tr('Open job', 'कार्य खोलें')}</Button></Card>
      {jobs.loading && !jobs.data && <Loading />}{jobs.data?.items.length === 0 && <Empty>{tr('No repair jobs yet.', 'अभी कोई मरम्मत कार्य नहीं।')}</Empty>}
      {jobs.data?.items.map((j) => (
        <Card key={j.id} className="space-y-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{j.instrumentNo} <span className="font-normal text-muted">· {j.category}</span></h3><p className="text-sm">{j.issue}</p></div><Badge tone={j.stage === 'READY_FOR_VERIFICATION' ? 'ok' : 'info'}>{STAGE[j.stage]?.[lang === 'hi' ? 1 : 0]}</Badge></div>
          <ol className="flex flex-wrap gap-2 text-xs" aria-label={tr('Progress', 'प्रगति')}>{Object.entries(STAGE).map(([k, l], i) => <li key={k} aria-current={k === j.stage ? 'step' : undefined} className={`rounded-full border px-2 py-0.5 ${i <= idx(j.stage) ? 'border-primary bg-primary-soft text-primary-ink' : 'border-line text-muted'}`}>{i < idx(j.stage) ? '✓ ' : ''}{l[lang === 'hi' ? 1 : 0]}</li>)}</ol>
          <p className="text-xs text-muted">{tr('Opened', 'खोला गया')} {fmtDate(j.createdAt, lang)}{j.technicianName && ` · ${tr('Technician', 'तकनीशियन')}: ${j.technicianName}`}</p>
          {j.stage === 'READY_FOR_VERIFICATION' ? (j.applicationId ? <Alert tone="ok">{tr('An application for re-verification has been opened for the owner.', 'स्वामी के लिए पुनः सत्यापन का आवेदन खोल दिया गया है।')} <Link className="underline" href={`/owner/applications/${j.applicationId}`}>{tr('View', 'देखें')}</Link></Alert> : <Alert tone="info">{tr('Sent for re-verification.', 'पुनः सत्यापन के लिए भेजा गया।')}</Alert>) : (
            <div className="flex flex-wrap items-end gap-2">{j.stage === 'REPORTED' && <div className="min-w-48 flex-1"><Input label={tr('Technician name', 'तकनीशियन का नाम')} value={tech[j.id] ?? ''} onChange={(e) => setTech({ ...tech, [j.id]: e.target.value })} /></div>}
              <Button loading={busy === j.id} disabled={j.stage === 'REPORTED' && (tech[j.id] ?? '').trim().length < 2} onClick={() => adv(j)}>{NEXT[j.stage]![lang === 'hi' ? 2 : 1]}</Button></div>)}
        </Card>))}
    </div>
  );
}
