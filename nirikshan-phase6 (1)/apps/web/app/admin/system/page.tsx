'use client';
import { useEffect, useState } from 'react';
import { post, put } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Alert, Badge, Button, Card, ErrorNote, Input, Loading, PageTitle, Select, Textarea } from '@/components/ui';

interface Settings { maintenance: { enabled: boolean; level: 'info' | 'warn'; textEn: string; textHi: string }; flags: Record<'publicSearch' | 'tamperReports' | 'bulkRegister' | 'selfServiceDataRequests', boolean>; lifecycle: { reminderDays: number[]; dueForRenewalDays: number; applicationExpiryDays: number; visitReminderHours: number; unscheduledAlertHours: number } }
interface Run { status: string; trigger: string; startedAt: string; finishedAt: string | null; result: unknown; error: string | null }
interface Sys { settings: Settings; jobs: { schedulerOn: boolean; failedLast24h: number; jobs: { name: string; description: string; cron: string; last: Run | null }[]; recent: { id: number; job: string; trigger: string; status: string; startedAt: string; error: string | null }[] } }
const FLAGS: Record<string, [string, string]> = { publicSearch: ['Public search page', 'Anyone can look an instrument up by number, category and area.'], tamperReports: ['Public tamper reports', 'Anyone can report a suspected tampered seal or certificate.'], bulkRegister: ['Bulk registration (CSV)', 'Owners can register many instruments from one file.'], selfServiceDataRequests: ['Data requests by owners', 'Owners can ask for a copy, correction or erasure of their data.'] };

export default function System() {
  const sys = useFetch<Sys>('/admin/system'); const [m, setM] = useState<Settings['maintenance'] | null>(null); const [lc, setLc] = useState<Settings['lifecycle'] | null>(null); const [days, setDays] = useState('');
  const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => { if (sys.data && !m) { setM(sys.data.settings.maintenance); setLc(sys.data.settings.lifecycle); setDays(sys.data.settings.lifecycle.reminderDays.join(', ')); } }, [sys.data, m]);
  const save = async (key: string, body: unknown, ok: string) => { setBusy(key); setErr(null); setMsg(''); try { await put(`/admin/system/settings/${key}`, body); setMsg(ok); await sys.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  const run = async (name: string) => { setBusy('run' + name); setErr(null); setMsg(''); try { await post(`/admin/system/jobs/${name}/run`, {}, true); setMsg(`${name} ran.`); await sys.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  const s = sys.data;
  return (
    <div className="space-y-6"><PageTitle>System</PageTitle>
      {sys.loading && !s && <Loading />}<ErrorNote error={sys.error} /><ErrorNote error={err} />{msg && <p role="status" className="text-sm text-ok">{msg}</p>}
      {s && m && lc && <>
        <Card className="space-y-3"><h2 className="font-semibold">Notice banner</h2><p className="text-sm text-muted">Shows at the top of every page, for example before planned downtime.</p>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="size-5" checked={m.enabled} onChange={(e) => setM({ ...m, enabled: e.target.checked })} /> Show the banner</label>
          <Select label="Style" value={m.level} onChange={(e) => setM({ ...m, level: e.target.value as 'info' | 'warn' })}><option value="info">Information</option><option value="warn">Warning</option></Select>
          <Textarea label="Text in English" value={m.textEn} maxLength={300} onChange={(e) => setM({ ...m, textEn: e.target.value })} /><Textarea label="Text in Hindi" lang="hi" value={m.textHi} maxLength={300} onChange={(e) => setM({ ...m, textHi: e.target.value })} />
          <Button loading={busy === 'maintenance'} onClick={() => save('maintenance', m, 'Banner saved.')}>Save banner</Button></Card>
        <Card className="space-y-3"><h2 className="font-semibold">Features</h2>
          <ul className="space-y-2">{Object.entries(FLAGS).map(([k, [t, d]]) => <li key={k}><label className="flex min-h-11 items-start gap-3"><input type="checkbox" className="mt-1 size-5" checked={s.settings.flags[k as keyof Settings['flags']]} disabled={!!busy} onChange={(e) => save('flags', { ...s.settings.flags, [k]: e.target.checked }, `${t} ${e.target.checked ? 'switched on' : 'switched off'}.`)} /><span><span className="font-medium">{t}</span><span className="block text-sm text-muted">{d}</span></span></label></li>)}</ul></Card>
        <Card className="space-y-3"><h2 className="font-semibold">Reminders and deadlines</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Renewal reminders, days before expiry" value={days} hint="Separate with commas, for example 60, 30, 15, 7, 1" onChange={(e) => setDays(e.target.value)} />
            <Input label="Mark as due for renewal, days before" type="number" min={1} max={365} value={lc.dueForRenewalDays} onChange={(e) => setLc({ ...lc, dueForRenewalDays: +e.target.value })} />
            <Input label="Applications expire after, days" type="number" min={1} max={180} value={lc.applicationExpiryDays} onChange={(e) => setLc({ ...lc, applicationExpiryDays: +e.target.value })} />
            <Input label="Visit reminder, hours before" type="number" min={1} max={72} value={lc.visitReminderHours} onChange={(e) => setLc({ ...lc, visitReminderHours: +e.target.value })} />
            <Input label="Alert if not scheduled after, hours" type="number" min={1} max={168} value={lc.unscheduledAlertHours} onChange={(e) => setLc({ ...lc, unscheduledAlertHours: +e.target.value })} /></div>
          <Button loading={busy === 'lifecycle'} onClick={() => save('lifecycle', { ...lc, reminderDays: [...new Set(days.split(/[ ,]+/).filter(Boolean).map(Number))].sort((a, b) => b - a) }, 'Saved.')}>Save</Button></Card>
        <Card className="space-y-3"><h2 className="font-semibold">Background jobs</h2>
          {!s.jobs.schedulerOn && <Alert tone="warn">The scheduler is not running on this server. Jobs can still be run by hand below.</Alert>}
          {s.jobs.failedLast24h > 0 && <Alert tone="danger">{s.jobs.failedLast24h} job run(s) failed in the last 24 hours.</Alert>}
          <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Jobs</caption>
            <thead><tr>{['Job', 'Schedule', 'Last run', 'Result', ''].map((h, i) => <th key={i} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h || <span className="sr-only">Run</span>}</th>)}</tr></thead>
            <tbody>{s.jobs.jobs.map((j) => (
              <tr key={j.name} className="border-b border-line/60 align-top"><td className="px-2 py-1.5"><b>{j.name}</b><div className="text-xs text-muted">{j.description}</div></td><td className="px-2 py-1.5 font-mono text-xs">{j.cron}</td>
                <td className="px-2 py-1.5">{j.last ? <><Badge tone={j.last.status === 'OK' || j.last.status === 'SUCCEEDED' ? 'ok' : j.last.status === 'FAILED' ? 'danger' : 'info'}>{j.last.status.toLowerCase()}</Badge><div className="text-xs text-muted">{fmtDate(j.last.startedAt)} · {j.last.trigger.toLowerCase()}</div></> : 'never'}</td>
                <td className="max-w-64 break-words px-2 py-1.5 text-xs">{j.last?.error ?? (j.last?.result ? JSON.stringify(j.last.result) : '—')}</td>
                <td className="px-2 py-1.5"><Button variant="secondary" loading={busy === 'run' + j.name} onClick={() => run(j.name)}>Run now</Button></td></tr>))}</tbody></table></div></Card>
      </>}
    </div>
  );
}
