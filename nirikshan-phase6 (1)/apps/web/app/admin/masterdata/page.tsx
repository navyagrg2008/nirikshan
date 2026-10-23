'use client';
import { useState } from 'react';
import { patch, post } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Loading, PageTitle, Select } from '@/components/ui';

const masterEntities = ['categories', 'sub-categories', 'accuracy-classes', 'capacity-bands', 'document-types', 'reason-codes', 'holidays', 'notification-templates', 'areas'] as const; // mirrors the API's list
type Row = Record<string, unknown> & { id: string };
const HINT: Record<string, string> = {
  categories: '{ "code": "COUNTER_SCALE", "name_en": "Counter scale", "name_hi": "काउंटर तराजू" }', 'accuracy-classes': '{ "code": "II", "name": "Special accuracy" }',
  'capacity-bands': '{ "category_id": "<uuid>", "min_capacity": "0", "max_capacity": "30", "unit": "kg" }', holidays: '{ "holiday_date": "2026-01-26", "name": "Republic Day" }', 'reason-codes': '{ "code": "DOC_UNCLEAR", "kind": "REJECT", "name_en": "Document unclear" }',
};
export default function MasterData() {
  const { t } = useI18n(); const [entity, setEntity] = useState<string>('categories'); const q = useFetch<Row[]>(`/admin/masterdata/${entity}`); const [json, setJson] = useState(''); const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState<string | null>(null);
  const create = async () => { setErr(null); setMsg(null); try { await post(`/admin/masterdata/${entity}`, JSON.parse(json)); setJson(''); setMsg('Added.'); await q.reload(); } catch (e) { setErr(e instanceof SyntaxError ? new Error('Not valid JSON') : e); } };
  const toggle = async (r: Row) => { setErr(null); try { await patch(`/admin/masterdata/${entity}/${r.id}`, { status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }); await q.reload(); } catch (e) { setErr(e); } };
  const cols = q.data?.[0] ? Object.keys(q.data[0]).filter((k) => !['id', 'created_at', 'updated_at', 'version'].includes(k)).slice(0, 6) : [];
  return (
    <div className="space-y-4"><PageTitle>{t('nav.masterdata')}</PageTitle>
      <Alert tone="info">Changes apply to new records only. Existing instruments keep what they were registered with, and rule versions are pinned.</Alert>
      <Select label="What do you want to manage?" value={entity} onChange={(e) => { setEntity(e.target.value); setJson(''); setErr(null); }}>{masterEntities.map((m) => <option key={m} value={m}>{m}</option>)}</Select>
      {q.loading && <Loading />}<ErrorNote error={q.error} />{q.data?.length === 0 && <Empty>No rows.</Empty>}
      {cols.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">{entity}</caption><thead className="bg-primary-soft"><tr>{cols.map((c) => <th key={c} scope="col" className="p-3">{c}</th>)}<th scope="col" className="p-3"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{q.data!.map((r) => <tr key={r.id} className="border-t border-line">{cols.map((c) => <td key={c} className="p-3">{c === 'status' ? <Badge tone={r[c] === 'ACTIVE' ? 'ok' : 'muted'}>{String(r[c])}</Badge> : String(r[c] ?? '—').slice(0, 60)}</td>)}<td className="p-3">{'status' in r && <Button variant="ghost" onClick={() => toggle(r)}>{r.status === 'ACTIVE' ? 'Retire' : 'Reactivate'}</Button>}</td></tr>)}</tbody></table></div>}
      <Card className="space-y-3"><h2 className="font-semibold">Add a row</h2><label htmlFor="js" className="block text-sm text-muted">Enter the fields as JSON. Example: <code className="break-all">{HINT[entity] ?? 'see the data table columns'}</code></label>
        <textarea id="js" rows={5} value={json} onChange={(e) => setJson(e.target.value)} className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-sm" spellCheck={false} /><ErrorNote error={err} />{msg && <Alert tone="ok">{msg}</Alert>}<Button onClick={create} disabled={!json.trim()}>Add</Button></Card>
    </div>
  );
}
