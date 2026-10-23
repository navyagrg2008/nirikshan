'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { post } from '@/lib/api';
import { fmtDate, useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { Badge, Empty, ErrorNote, Loading, PageTitle, Button } from '@/components/ui';

interface N { id: string; event: string; title: string; body: string; deepLink: string | null; readAt: string | null; createdAt: string }
export default function Alerts() {
  const { t, lang } = useI18n(); const q = useFetch<{ unread: number; items: N[] }>('/notifications');
  useEffect(() => () => {}, []);
  const markAll = async () => { await post('/notifications/read-all'); await q.reload(); };
  const read = async (n: N) => { if (!n.readAt) { await post(`/notifications/${n.id}/read`); await q.reload(); } };
  return (
    <div className="mx-auto max-w-2xl"><PageTitle actions={q.data && q.data.unread > 0 ? <Button variant="secondary" onClick={markAll}>Mark all read</Button> : undefined}>{t('nav.alerts')}</PageTitle>
      {q.loading && !q.data && <Loading />}<ErrorNote error={q.error} />{q.data?.items.length === 0 && <Empty>No alerts yet.</Empty>}
      <ul className="space-y-2">{q.data?.items.map((n) => <li key={n.id} className={`rounded-xl border p-4 ${n.readAt ? 'border-line bg-surface' : 'border-primary border-l-4 bg-surface'}`}>
        <div className="flex items-start justify-between gap-3"><div><p className="font-medium">{n.title} {!n.readAt && <Badge tone="info">New</Badge>}</p><p className="text-sm text-muted">{n.body}</p></div><time className="shrink-0 text-xs text-muted">{fmtDate(n.createdAt, lang)}</time></div>
        <div className="mt-2 flex gap-3 text-sm">{n.deepLink && <Link className="text-primary underline" href={n.deepLink} onClick={() => read(n)}>Open</Link>}{!n.readAt && <button className="text-primary underline" onClick={() => read(n)}>Mark read</button>}</div></li>)}</ul></div>
  );
}
