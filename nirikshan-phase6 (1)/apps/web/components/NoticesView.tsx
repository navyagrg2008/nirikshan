'use client';
import { useI18n } from '@/lib/i18n';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Badge, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';
export interface Notice { id: string; title: string; titleHi: string | null; tag: string | null; publishedAt: string }
export default function NoticesView({ initial }: { initial: Notice[] | null }) {
  const { t, lang } = useI18n(); const n = useFetch<Notice[]>('/public/notices?limit=50', initial);
  return (
    <div><PageTitle>{t('nav.notices')}</PageTitle>
      {n.loading && <Loading />}<ErrorNote error={n.error} />
      {n.data?.length === 0 && <Empty>{t('home.nonotices')}</Empty>}
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{n.data?.map((x) => <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 p-4"><span>{lang === 'hi' && x.titleHi ? x.titleHi : x.title} {x.tag && <Badge tone="info">{x.tag}</Badge>}</span><time className="text-sm text-muted">{fmtDate(x.publishedAt, lang)}</time></li>)}</ul>
    </div>
  );
}
