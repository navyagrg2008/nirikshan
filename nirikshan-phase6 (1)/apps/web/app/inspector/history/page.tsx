'use client';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/cases';
import { recLabel, useTr, verdictLabel, verdictTone } from '@/lib/inspection';
import { Badge, Card, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface H { id: string; status: string; submittedAt: string | null; scheduledAt: string; recommendation: string | null; overall: string | null }
export default function Page() {
  const { tr, lang } = useTr(); const hi = lang === 'hi'; const q = useFetch<H[]>('/inspector/history');
  return (
    <div><PageTitle>{tr('Past visits', 'पिछले दौरे')}</PageTitle>{q.loading && !q.data && <Loading />}<ErrorNote error={q.error} />
      {q.data?.length === 0 && <Empty>{tr('Nothing here yet.', 'यहाँ अभी कुछ नहीं है।')}</Empty>}
      <ul className="space-y-3">{q.data?.map((h) => (
        <li key={h.id}><Card className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">{fmtDateTime(h.submittedAt ?? h.scheduledAt, lang)}</p><p className="text-sm text-muted">{h.status === 'SUBMITTED' ? recLabel(h.recommendation, hi) : h.status === 'NO_SHOW' ? tr('Visit did not happen', 'दौरा नहीं हुआ') : tr('Replaced by a newer visit', 'नए दौरे से बदला गया')}</p></div>
          <div className="flex items-center gap-3">{h.overall && <Badge tone={verdictTone(h.overall)}>{verdictLabel(h.overall, hi)}</Badge>}{h.status === 'SUBMITTED' && <Link href={`/inspector/visits/${h.id}`} className="min-h-11 content-center text-primary underline">{tr('Open', 'खोलें')}</Link>}</div></Card></li>))}</ul>
    </div>
  );
}
