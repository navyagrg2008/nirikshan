'use client';
import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Alert, Button, Empty, ErrorNote, Input, Loading, PageTitle } from '@/components/ui';

interface Ev { id: number; at: string; actorRole: string | null; action: string; entityType: string | null; entityId: string | null; requestId: string | null; hash: string }
export default function Audit() {
  const { t } = useI18n(); const [items, setItems] = useState<Ev[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [err, setErr] = useState<unknown>(null); const [action, setAction] = useState(''); const [chain, setChain] = useState<{ intact: boolean; checked: number; firstBadId: number | null } | null>(null);
  const load = useCallback(async (reset: boolean, cur?: string | null) => {
    setLoading(true); setErr(null);
    try { const p = new URLSearchParams({ limit: '50' }); if (action.trim()) p.set('action', action.trim()); if (!reset && cur) p.set('cursor', cur); const r = await get<{ items: Ev[]; nextCursor: string | null }>(`/audit?${p}`); setItems((x) => (reset ? r.items : [...x, ...r.items])); setCursor(r.nextCursor); } catch (e) { setErr(e); } finally { setLoading(false); }
  }, [action]);
  useEffect(() => { const id = setTimeout(() => void load(true), 300); return () => clearTimeout(id); }, [load]);
  const verify = async () => { setErr(null); try { setChain(await post('/admin/audit/verify-chain')); } catch (e) { setErr(e); } };
  return (
    <div><PageTitle actions={<Button variant="secondary" onClick={verify}>Verify chain</Button>}>{t('nav.audit')}</PageTitle>
      {chain && <div className="mb-4"><Alert tone={chain.intact ? 'ok' : 'danger'}>{chain.intact ? `Chain intact. ${chain.checked} events checked.` : `Chain broken at event ${chain.firstBadId}.`}</Alert></div>}
      <div className="mb-4 max-w-sm"><Input label="Filter by action prefix" placeholder="e.g. auth." value={action} onChange={(e) => setAction(e.target.value)} /></div><ErrorNote error={err} />
      {!loading && items.length === 0 && <Empty>No events.</Empty>}
      {items.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">Audit events</caption><thead className="bg-primary-soft"><tr>{['#', 'Time', 'Role', 'Action', 'Entity', 'Hash'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
        <tbody>{items.map((e) => <tr key={e.id} className="border-t border-line"><td className="p-3">{e.id}</td><td className="p-3 whitespace-nowrap">{new Date(e.at).toLocaleString('en-IN')}</td><td className="p-3">{e.actorRole ?? 'system'}</td><td className="p-3 font-medium">{e.action}</td><td className="p-3">{e.entityType}</td><td className="p-3 font-mono text-xs">{e.hash}</td></tr>)}</tbody></table></div>}
      {loading && <Loading />}{cursor && !loading && <Button variant="secondary" className="mt-4" onClick={() => load(false, cursor)}>Load more</Button>}
    </div>
  );
}
