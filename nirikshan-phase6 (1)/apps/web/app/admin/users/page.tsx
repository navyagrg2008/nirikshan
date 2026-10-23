'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { get, post } from '@/lib/api';
import { fmtDate, useAreas } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { Alert, Badge, Button, Card, Empty, ErrorNote, Input, Loading, PageTitle, Select } from '@/components/ui';

interface U { id: string; role: string; status: string; mfaEnrolled: boolean; createdAt: string; lastLoginAt: string | null; nameMasked: string | null; mobileMasked: string | null; emailMasked: string | null }
const STAFF = ['INSPECTOR', 'OFFICER', 'SENIOR_OFFICER', 'ADMIN'];
const ACTIONS: [string, string][] = [['SUSPEND', 'Suspend'], ['REACTIVATE', 'Reactivate'], ['FORCE_PASSWORD_RESET', 'Force password reset'], ['RESET_MFA', 'Reset MFA'], ['REVOKE_SESSIONS', 'Sign out everywhere']];

export default function Users() {
  const { t, lang } = useI18n(); const areas = useAreas(); const [items, setItems] = useState<U[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [err, setErr] = useState<unknown>(null);
  const [role, setRole] = useState(''); const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [show, setShow] = useState(false);
  const load = useCallback(async (reset: boolean, cur?: string | null) => {
    setLoading(true); setErr(null);
    try { const p = new URLSearchParams({ limit: '25' }); if (role) p.set('role', role); if (status) p.set('status', status); if (q.trim()) p.set('q', q.trim()); if (!reset && cur) p.set('cursor', cur);
      const r = await get<{ items: U[]; nextCursor: string | null }>(`/admin/users?${p}`); setItems((x) => (reset ? r.items : [...x, ...r.items])); setCursor(r.nextCursor); } catch (e) { setErr(e); } finally { setLoading(false); }
  }, [role, status, q]);
  useEffect(() => { const id = setTimeout(() => void load(true), 300); return () => clearTimeout(id); }, [load]);
  const act = async (id: string, action: string) => { const reason = action === 'SUSPEND' ? (prompt('Reason for suspending (recorded in the audit trail)') ?? '') : undefined; if (action === 'SUSPEND' && !reason) return; setErr(null); try { await post(`/admin/users/${id}/action`, { action, ...(reason ? { reason } : {}) }); setMsg('Done.'); await load(true); } catch (e) { setErr(e); } };
  return (
    <div><PageTitle actions={<Button onClick={() => setShow(!show)}>{show ? 'Close' : 'Invite staff'}</Button>}>{t('nav.users')}</PageTitle>
      {show && <InviteForm areas={(areas.data ?? []).filter((a) => a.level === 'DIVISION' || a.level === 'ZONE' || a.level === 'CIRCLE')} onDone={(m) => { setMsg(m); setShow(false); void load(true); }} />}
      <div className="my-4 grid gap-3 sm:grid-cols-3"><Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}><option value="">All</option>{['OWNER', 'TRADER', ...STAFF].map((r) => <option key={r}>{r}</option>)}</Select>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['INVITED', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'SUSPENDED'].map((r) => <option key={r}>{r}</option>)}</Select>
        <Input label="Find by exact mobile or email" value={q} onChange={(e) => setQ(e.target.value)} hint="Names are encrypted, so search is exact." /></div>
      {msg && <div className="mb-3"><Alert tone="ok">{msg}</Alert></div>}<ErrorNote error={err} />
      {!loading && items.length === 0 && <Empty>No users match.</Empty>}
      {items.length > 0 && <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full text-left text-sm"><caption className="sr-only">Users</caption><thead className="bg-primary-soft"><tr>{['Name', 'Contact', 'Role', 'Status', 'Last sign-in', 'Actions'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
        <tbody>{items.map((u) => <tr key={u.id} className="border-t border-line align-top"><th scope="row" className="p-3 font-medium">{u.nameMasked ?? '—'}</th><td className="p-3">{u.mobileMasked}<br /><span className="text-muted">{u.emailMasked}</span></td><td className="p-3">{u.role}</td><td className="p-3"><Badge tone={u.status === 'ACTIVE' ? 'ok' : u.status === 'SUSPENDED' || u.status === 'REJECTED' ? 'danger' : 'warn'}>{u.status}</Badge></td><td className="p-3">{fmtDate(u.lastLoginAt, lang)}</td>
          <td className="p-3"><label className="sr-only" htmlFor={`a-${u.id}`}>Action for {u.nameMasked}</label><select id={`a-${u.id}`} className="min-h-11 rounded-lg border border-line bg-surface px-2" value="" onChange={(e) => e.target.value && act(u.id, e.target.value)}><option value="">Choose…</option>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td></tr>)}</tbody></table></div>}
      {loading && <Loading />}{cursor && !loading && <Button variant="secondary" className="mt-4" onClick={() => load(false, cursor)}>Load more</Button>}
    </div>
  );
}

function InviteForm({ areas, onDone }: { areas: { id: string; name: string; level: string }[]; onDone: (m: string) => void }) {
  const [f, setF] = useState({ role: 'OFFICER', fullName: '', email: '', mobile: '' }); const [sel, setSel] = useState<string[]>([]); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post('/admin/users/invite', { role: f.role, fullName: f.fullName, email: f.email, ...(f.mobile ? { mobile: f.mobile } : {}), areaIds: sel }, true); onDone('Invitation sent. The link is valid for 24 hours and works once.'); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <Card><form onSubmit={submit} className="space-y-4"><h2 className="text-lg font-semibold">Invite a staff member</h2><div className="grid gap-4 sm:grid-cols-2"><Select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{STAFF.map((r) => <option key={r}>{r}</option>)}</Select><Input label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required />
      <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /><Input label="Mobile (optional)" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></div>
      {f.role !== 'ADMIN' && <fieldset className="space-y-2"><legend className="text-sm font-medium">Areas they cover</legend><div className="grid gap-1 sm:grid-cols-2">{areas.map((a) => <label key={a.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={sel.includes(a.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} />{a.name} <span className="text-muted">({a.level.toLowerCase()})</span></label>)}</div></fieldset>}
      <ErrorNote error={err} /><Button type="submit" loading={busy}>Send invitation</Button></form></Card>
  );
}
