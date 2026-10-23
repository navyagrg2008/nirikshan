'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, get } from '@/lib/api';
import { fmtDate, useAreas, useFetch } from '@/lib/hooks';
import { useTr } from '@/lib/inspection';
import { Captcha, SITEKEY } from '@/components/ValidateView';
import { Badge, Button, Card, Empty, ErrorNote, Input, PageTitle, Select } from '@/components/ui';

interface Row { certNo: string; holder: string; category: string; capacity: string; accuracyClass: string; area: string; status: string; validTill: string }
interface Res { page: number; hasMore: boolean; items: Row[] }
interface Cat { id: string; name: string }
const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = { VALID: 'ok', EXPIRED: 'muted', SUSPENDED: 'warn', REVOKED: 'danger' };
const LBL: Record<string, [string, string]> = { VALID: ['Valid', 'मान्य'], EXPIRED: ['Expired', 'समाप्त'], SUSPENDED: ['Suspended', 'निलंबित'], REVOKED: ['Revoked', 'रद्द'] };

export default function Search() {
  const { tr, lang } = useTr(); const cats = useFetch<{ categories: Cat[] }>('/catalog/categories'); const areas = useAreas();
  const [f, setF] = useState({ q: '', categoryId: '', areaCode: '', status: '' }); const [res, setRes] = useState<Res | null>(null); const [page, setPage] = useState(1);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [need, setNeed] = useState(false); const [cap, setCap] = useState<string | undefined>();
  const list = cats.data?.categories ?? [];
  const run = async (p: number) => {
    setBusy(true); setErr(null); const q = new URLSearchParams(); if (f.q) q.set('q', f.q.trim()); if (f.categoryId) q.set('categoryId', f.categoryId); if (f.areaCode) q.set('areaCode', f.areaCode); if (f.status) q.set('status', f.status); q.set('page', String(p)); if (cap) q.set('captchaToken', cap);
    try { setRes(await get<Res>(`/public/search?${q}`)); setPage(p); setNeed(false); setCap(undefined); } catch (e) { if (e instanceof ApiError && e.code === 'CAPTCHA_REQUIRED') setNeed(true); setErr(e); setRes(null); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void run(1); };
  const any = !!(f.q.trim() || f.categoryId || f.areaCode);
  return (
    <div className="mx-auto max-w-4xl space-y-4"><PageTitle>{tr('Find a verified instrument', 'सत्यापित उपकरण खोजें')}</PageTitle>
      <p className="text-sm text-muted">{tr('Owner names are partly hidden to protect privacy. To check one certificate in full, use', 'निजता के लिए स्वामी का नाम आंशिक रूप से छिपा है। किसी एक प्रमाणपत्र को पूरा जाँचने के लिए इसका उपयोग करें:')} <Link href="/validate" className="text-primary underline">{tr('Check a certificate', 'प्रमाणपत्र जाँचें')}</Link>.</p>
      <Card><form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Input label={tr('Certificate number or name', 'प्रमाणपत्र संख्या या नाम')} value={f.q} maxLength={60} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select label={tr('Type of instrument', 'उपकरण का प्रकार')} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">{tr('Any', 'कोई भी')}</option>{list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select label={tr('Area', 'क्षेत्र')} value={f.areaCode} onChange={(e) => setF({ ...f, areaCode: e.target.value })}><option value="">{tr('Any', 'कोई भी')}</option>{(areas.data ?? []).filter((a) => a.level !== 'STATE').map((a) => <option key={a.id} value={a.code}>{lang === 'hi' && a.nameHi ? a.nameHi : a.name}</option>)}</Select>
        <Select label={tr('Status', 'स्थिति')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">{tr('Any', 'कोई भी')}</option>{Object.entries(LBL).map(([k, l]) => <option key={k} value={k}>{l[lang === 'hi' ? 1 : 0]}</option>)}</Select>
        {need && <div className="sm:col-span-2"><Captcha onToken={setCap} /></div>}
        <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={!any || (need && !cap && !!SITEKEY)}>{tr('Search', 'खोजें')}</Button>{!any && <span className="ml-3 text-xs text-muted">{tr('Enter a name or number, or choose a type or area.', 'नाम या संख्या डालें, या प्रकार या क्षेत्र चुनें।')}</span>}</div>
      </form></Card>
      <ErrorNote error={err} />
      {res && res.items.length === 0 && <Empty>{tr('Nothing matched.', 'कुछ नहीं मिला।')}</Empty>}
      {res && res.items.length > 0 && (
        <Card><div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{tr('Search results', 'खोज परिणाम')}</caption>
          <thead><tr>{[tr('Certificate', 'प्रमाणपत्र'), tr('Owner', 'स्वामी'), tr('Instrument', 'उपकरण'), tr('Area', 'क्षेत्र'), tr('Status', 'स्थिति'), tr('Valid till', 'मान्य तिथि तक')].map((h) => <th key={h} scope="col" className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">{h}</th>)}</tr></thead>
          <tbody>{res.items.map((r) => <tr key={r.certNo} className="border-b border-line/60"><td className="px-2 py-1.5 font-medium">{r.certNo}</td><td className="px-2 py-1.5">{r.holder}</td><td className="px-2 py-1.5">{r.category}<div className="text-xs text-muted">{r.capacity} · {tr('class', 'श्रेणी')} {r.accuracyClass}</div></td><td className="px-2 py-1.5">{r.area}</td><td className="px-2 py-1.5"><Badge tone={TONE[r.status] ?? 'muted'}>{LBL[r.status]?.[lang === 'hi' ? 1 : 0] ?? r.status}</Badge></td><td className="px-2 py-1.5">{fmtDate(r.validTill, lang)}</td></tr>)}</tbody></table></div>
          <div className="mt-3 flex items-center gap-3"><Button variant="secondary" disabled={page <= 1} onClick={() => run(page - 1)}>{tr('Previous', 'पिछला')}</Button><span className="text-sm text-muted">{tr('Page', 'पृष्ठ')} {page}</span><Button variant="secondary" disabled={!res.hasMore} onClick={() => run(page + 1)}>{tr('Next', 'अगला')}</Button></div></Card>)}
    </div>
  );
}
