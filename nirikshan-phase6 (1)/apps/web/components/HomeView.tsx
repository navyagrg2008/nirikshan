'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useFetch, fmtDate } from '@/lib/hooks';
import { Card, Seal } from '@/components/ui';

export interface Stats { instrumentsRegistered: number; instrumentsVerified: number; divisionsCovered: number }
export interface HomeNotice { id: string; title: string; titleHi: string | null; tag: string | null; publishedAt: string }

export default function HomeView({ initialStats, initialNotices }: { initialStats: Stats | null; initialNotices: HomeNotice[] | null }) {
  const { t, lang } = useI18n(); const stats = useFetch<Stats>('/public/stats', initialStats); const notices = useFetch<HomeNotice[]>('/public/notices?limit=5', initialNotices);
  const nf = new Intl.NumberFormat(lang === 'hi' ? 'hi-IN' : 'en-IN');
  return (
    <div className="space-y-12">
      <section className="grid items-center gap-8 md:grid-cols-[1.4fr_1fr]">
        <div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">{t('home.title')}</h1>
          <p className="mt-4 max-w-xl text-lg text-muted">{t('home.sub')}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/register" className="min-h-11 content-center rounded-lg bg-primary px-5 font-medium text-primary-ink">{t('home.cta.register')}</Link>
            <Link href="/login" className="min-h-11 content-center rounded-lg border border-line bg-surface px-5 font-medium">{t('home.cta.login')}</Link>
          </div>
        </div>
        <Card className="text-center">
          <div className="mx-auto w-fit"><Seal size={72} /></div>
          <h2 className="mt-3 font-semibold">{t('home.search')}</h2>
          <p className="mt-1 text-sm text-muted">{t('home.search.soon')}</p>
          <form action="/validate" method="get" className="mt-4 space-y-2"><input name="cert" aria-label={t('home.search')} placeholder="NRK/CERT/…" required minLength={8} maxLength={40} className="min-h-11 w-full rounded-lg border border-line bg-surface px-3" /><button className="min-h-11 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-ink">{t('home.search')}</button></form>
        </Card>
      </section>

      <section aria-labelledby="how">
        <h2 id="how" className="mb-4 text-xl font-semibold">{t('home.how')}</h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {([['home.how1', 'home.how1d'], ['home.how2', 'home.how2d'], ['home.how3', 'home.how3d']] as const).map(([a, b], i) => (
            <li key={a}><Card className="h-full"><span className="grid size-8 place-items-center rounded-full bg-primary-soft font-semibold text-primary">{i + 1}</span><h3 className="mt-3 font-semibold">{t(a)}</h3><p className="mt-1 text-sm text-muted">{t(b)}</p></Card></li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="stats" className="grid gap-8 md:grid-cols-2">
        <div>
          <h2 id="stats" className="mb-4 text-xl font-semibold">{t('home.stats')}</h2>
          <ul className="grid grid-cols-3 gap-3">
            {stats.data && ([[stats.data.instrumentsRegistered, 'Registered'], [stats.data.instrumentsVerified, 'Verified'], [stats.data.divisionsCovered, 'Divisions']] as const).map(([n, l]) => (
              <li key={l}><Card className="p-4"><p className="text-2xl font-bold">{nf.format(n)}</p><p className="text-xs text-muted">{l}</p></Card></li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Demonstration data only.</p>
        </div>
        <div>
          <h2 className="mb-4 text-xl font-semibold">{t('home.notices')}</h2>
          {notices.data?.length === 0 && <p className="text-muted">{t('home.nonotices')}</p>}
          <ul className="space-y-2">{notices.data?.map((n) => <li key={n.id} className="flex justify-between gap-3 border-b border-line pb-2"><span>{lang === 'hi' && n.titleHi ? n.titleHi : n.title}</span><time className="shrink-0 text-sm text-muted">{fmtDate(n.publishedAt, lang)}</time></li>)}</ul>
          <Link href="/notices" className="mt-3 inline-block text-primary underline">{t('nav.notices')} →</Link>
        </div>
      </section>
    </div>
  );
}
