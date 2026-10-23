'use client';
import { useRef, useState } from 'react';
import { api, download, post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface Report { id: string; total: number; valid: number; invalid: number; problemsByKind: Record<string, number>; problems: { row: number; field: string; code: string }[]; moreProblems: number; canCommit: boolean }
interface Job { id: string; filename: string; status: string; total: number; valid: number; invalid: number; result: { instruments?: number; newOwnerAccounts?: number; existingOwners?: number; skipped?: number } | null; createdAt: string; committedAt: string | null }
const PROBLEM: Record<string, string> = { REQUIRED: 'is missing', INVALID: 'is not valid', DUPLICATE_IN_FILE: 'appears twice in this file', ALREADY_REGISTERED: 'is already registered', UNKNOWN_CATEGORY: 'category not found', UNKNOWN_AREA: 'area not found', NO_MATCHING_BAND: 'no capacity band fits', 'valid_till:BEFORE_VERIFICATION': 'ends before it was verified' };

export default function Migration() {
  const jobs = useFetch<{ items: Job[] }>('/admin/migration/jobs'); const file = useRef<HTMLInputElement>(null);
  const [rep, setRep] = useState<Report | null>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(''); const [msg, setMsg] = useState('');
  const upload = async () => {
    const f = file.current?.files?.[0]; if (!f) return; setBusy('v'); setErr(null); setMsg(''); setRep(null);
    try { const fd = new FormData(); fd.append('file', f); setRep(await api<Report>('/admin/migration/validate', { method: 'POST', form: fd })); await jobs.reload(); } catch (e) { setErr(e); } finally { setBusy(''); }
  };
  const act = async (what: 'commit' | 'discard', id: string) => { setBusy(what + id); setErr(null); setMsg(''); try { await post(`/admin/migration/jobs/${id}/${what}`, {}, true); setMsg(what === 'commit' ? 'Import finished.' : 'Import discarded.'); if (rep?.id === id) setRep(null); await jobs.reload(); } catch (e) { setErr(e); } finally { setBusy(''); } };
  return (
    <div className="space-y-6"><PageTitle>Import old records</PageTitle>
      <p className="max-w-prose text-sm text-muted">Bring in instruments from the old paper or spreadsheet registry. The file is checked first and nothing is saved until you confirm. Each owner gets an invited account; they claim it by registering with the same mobile number. Imported instruments get no certificate, so they must be verified afresh.</p>
      <Card className="space-y-3"><h2 className="font-semibold">1. Check a file</h2>
        <Button variant="secondary" onClick={() => download('/admin/migration/template.csv', 'legacy-import-template.csv').catch(setErr)}>Download the CSV template</Button>
        <div><label htmlFor="mf" className="mb-1 block text-sm font-medium">CSV file (up to 5,000 rows, 2 MB)</label><input id="mf" ref={file} type="file" accept=".csv,text/csv" className="block min-h-11 w-full text-sm" /></div>
        <Button loading={busy === 'v'} onClick={upload}>Check file</Button><ErrorNote error={err} />{msg && <p role="status" className="text-sm text-ok">{msg}</p>}
      </Card>
      {rep && (
        <Card className="space-y-3"><h2 className="font-semibold">2. Check result</h2>
          <p className="text-sm"><b>{rep.valid}</b> of {rep.total} rows are good. <b>{rep.invalid}</b> have problems and will be left out.</p>
          {Object.keys(rep.problemsByKind).length > 0 && <ul className="list-disc pl-5 text-sm">{Object.entries(rep.problemsByKind).map(([k, n]) => <li key={k}>{n} × {k.replace(':', ' ')}</li>)}</ul>}
          {rep.problems.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">First problems found</caption><thead><tr>{['Row', 'Column', 'Problem'].map((h) => <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h}</th>)}</tr></thead>
            <tbody>{rep.problems.map((p, i) => <tr key={i} className="border-b border-line/60"><td className="px-2 py-1.5">{p.row}</td><td className="px-2 py-1.5">{p.field}</td><td className="px-2 py-1.5">{PROBLEM[`${p.field}:${p.code}`] ?? PROBLEM[p.code] ?? p.code}</td></tr>)}</tbody></table></div>}
          {rep.moreProblems > 0 && <p className="text-sm text-muted">and {rep.moreProblems} more. Download the full list.</p>}
          <div className="flex flex-wrap gap-2">{rep.invalid > 0 && <Button variant="secondary" onClick={() => download(`/admin/migration/jobs/${rep.id}/errors.csv`, 'import-problems.csv').catch(setErr)}>Download all problems</Button>}
            {rep.canCommit ? <Button loading={busy === 'commit' + rep.id} onClick={() => act('commit', rep.id)}>Import {rep.valid} good rows</Button> : <Alert tone="warn">No good rows to import. Fix the file and check it again.</Alert>}
            <Button variant="ghost" onClick={() => act('discard', rep.id)}>Discard</Button></div>
        </Card>
      )}
      <section aria-labelledby="hist" className="space-y-3"><h2 id="hist" className="font-semibold">Earlier imports</h2>
        {jobs.loading && !jobs.data && <Loading />}{jobs.data?.items.length === 0 && <Empty>No imports yet.</Empty>}
        {jobs.data?.items.map((j) => (
          <Card key={j.id} className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{j.filename} <Badge tone={j.status === 'COMMITTED' ? 'ok' : j.status === 'VALIDATED' ? 'warn' : 'muted'}>{j.status === 'VALIDATED' ? 'waiting for your go-ahead' : j.status.toLowerCase()}</Badge></h3><span className="text-xs text-muted">{fmtDate(j.committedAt ?? j.createdAt)}</span></div>
            <p className="text-sm text-muted">{j.total} rows · {j.valid} good · {j.invalid} with problems{j.result && ` · ${j.result.instruments ?? 0} imported, ${j.result.newOwnerAccounts ?? 0} new owner accounts, ${j.result.skipped ?? 0} skipped`}</p>
            {j.status === 'VALIDATED' && rep?.id !== j.id && <div className="flex gap-2"><Button loading={busy === 'commit' + j.id} onClick={() => act('commit', j.id)}>Import</Button><Button variant="ghost" onClick={() => act('discard', j.id)}>Discard</Button></div>}</Card>))}
      </section>
    </div>
  );
}
