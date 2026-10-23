'use client';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { fmtDateTime, fmtWindow } from '@/lib/cases';
import { useTr } from '@/lib/inspection';
import { Badge, Card, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface V { id: string; status: string; start: string; end: string; applicationNo: string; type: string; category: string; categoryHi: string | null; instrumentNo: string; area: string; draftSavedAt: string | null }
export default function Page() {
  const { tr, lang } = useTr(); const q = useFetch<V[]>('/inspector/visits');
  return (
    <div><PageTitle>{tr('Your visits', 'आपके दौरे')}</PageTitle>{q.loading && !q.data && <Loading />}<ErrorNote error={q.error} />
      {q.data?.length === 0 && <Empty>{tr('No visits are assigned to you right now.', 'अभी आपको कोई दौरा नहीं सौंपा गया है।')}</Empty>}
      <ul className="space-y-3">{q.data?.map((v) => (
        <li key={v.id}><Card className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">{fmtWindow(v.start, v.end, lang)}</p><p className="text-sm text-muted">{v.applicationNo} · {lang === 'hi' && v.categoryHi ? v.categoryHi : v.category} · {v.instrumentNo} · {v.area}</p>
          <div className="mt-1 flex flex-wrap gap-2">{v.status === 'IN_PROGRESS' && <Badge tone="info">{tr('In progress', 'चल रहा है')}</Badge>}{v.draftSavedAt && <Badge tone="warn">{tr('Draft saved', 'ड्राफ़्ट सेव')} {fmtDateTime(v.draftSavedAt, lang)}</Badge>}</div></div>
          <Link href={`/inspector/visits/${v.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-ink">{v.status === 'IN_PROGRESS' ? tr('Continue', 'जारी रखें') : tr('Open', 'खोलें')}</Link></Card></li>))}</ul>
    </div>
  );
}
