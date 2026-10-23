'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, post } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, Badge, Button, Card, ErrorNote, Input, PageTitle } from '@/components/ui';

interface Report { uploadId: string; total: number; valid: number; invalid: number; report: { row: number; ok: boolean; errors: string[] }[] }
export default function Bulk() {
  const { me } = useSession(); const router = useRouter(); const [rep, setRep] = useState<Report | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [ch, setCh] = useState<string | null>(null); const [code, setCode] = useState(''); const [done, setDone] = useState<{ accepted: number; failed: number } | null>(null);
  if (me && me.role !== 'TRADER') return <Alert tone="warn">Bulk upload is for traders and dealers.</Alert>;
  const upload = async (file: File | undefined) => { if (!file) return; setBusy(true); setErr(null); setRep(null); setDone(null); try { const fd = new FormData(); fd.append('file', file); setRep(await api<Report>('/instruments/bulk', { method: 'POST', form: fd })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const send = async () => { setBusy(true); setErr(null); try { setCh((await post<{ challengeId: string }>('/auth/otp/confirm/send')).challengeId); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const commit = async () => { if (!rep || !ch) return; setBusy(true); setErr(null); try { const v = await post<{ verificationToken: string }>('/auth/otp/confirm/verify', { challengeId: ch, code }); setDone(await post('/instruments/bulk/commit', { uploadId: rep.uploadId, confirmToken: v.verificationToken })); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <div className="mx-auto max-w-3xl space-y-4"><PageTitle>Bulk upload</PageTitle>
      <Card className="space-y-3"><p>1. Download the template, fill one row per instrument, save as CSV (up to 1 MB).</p><a href="/api/v1/instruments/bulk/template.csv" className="inline-block min-h-11 content-center rounded-lg border border-line px-4 hover:bg-primary-soft">Download template</a>
        <div className="space-y-1"><label htmlFor="csv" className="block text-sm font-medium">2. Choose your CSV file</label><input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => upload(e.target.files?.[0])} className="block min-h-11 text-sm" disabled={busy} /></div></Card>
      <ErrorNote error={err} />
      {rep && <Card className="space-y-3"><p className="font-medium">{rep.total} rows checked: <span className="text-ok">{rep.valid} ready</span>, <span className="text-danger">{rep.invalid} with problems</span></p>
        {rep.invalid > 0 && <><ul className="max-h-60 space-y-1 overflow-auto text-sm">{rep.report.filter((r) => !r.ok).map((r) => <li key={r.row}>Row {r.row}: {r.errors.map((e) => <Badge key={e} tone="danger">{e}</Badge>)}</li>)}</ul><a className="text-sm text-primary underline" href={`/api/v1/instruments/bulk/${rep.uploadId}/errors.csv`}>Download error list</a></>}
        {rep.valid > 0 && !done && <div className="space-y-3 border-t border-line pt-3"><p className="text-sm text-muted">Only the {rep.valid} ready rows will be registered. Confirm with a code.</p>{!ch ? <Button onClick={send} loading={busy}>Send code</Button> : <><Input label="6-digit code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /><Button onClick={commit} loading={busy} disabled={code.length !== 6}>Register {rep.valid} instruments</Button></>}</div>}
        {done && <Alert tone="ok">Registered {done.accepted} instruments{done.failed ? `, ${done.failed} failed` : ''}. <button className="underline" onClick={() => router.push('/owner/instruments')}>View list</button></Alert>}</Card>}
    </div>
  );
}
