'use client';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime, typeLabel } from '@/lib/cases';
import { recLabel, verdictLabel, verdictTone } from '@/lib/inspection';
import { Badge, Card, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface P { id: string; applicationNo: string; status: string; type: string; category: string; instrumentNo: string; area: string; submittedAt: string | null; overall: string | null; recommendation: string | null; sla: null | { dueAt: string; state: 'BREACHED' | 'AT_RISK' | 'ON_TRACK' }; waitingForSecondApprover: boolean; firstApproverIsMe: boolean; canAct: boolean }
const SLA = { BREACHED: ['Overdue', 'danger'], AT_RISK: ['Due soon', 'warn'], ON_TRACK: ['On time', 'ok'] } as const;
export default function Page() {
  const { lang } = useI18n(); const q = useFetch<P[]>('/officer/decisions');
  return (
    <div><PageTitle>Decisions waiting</PageTitle>{q.loading && !q.data && <Loading />}<ErrorNote error={q.error} />
      {q.data?.length === 0 && <Empty>No cases are waiting for a decision.</Empty>}
      <ul className="space-y-3">{q.data?.map((c) => (
        <li key={c.id}><Card className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-semibold">{c.applicationNo} <span className="font-normal text-muted">· {typeLabel(c.type, lang)} · {c.category} · {c.instrumentNo}</span></p>
          <p className="text-sm text-muted">{c.area}{c.submittedAt ? ` · inspected ${fmtDateTime(c.submittedAt, lang)}` : ''}{c.recommendation ? ` · inspector: ${recLabel(c.recommendation)}` : ''}</p>
          <div className="mt-1 flex flex-wrap gap-2">{c.overall && <Badge tone={verdictTone(c.overall)}>{verdictLabel(c.overall)}</Badge>}{c.sla && <Badge tone={SLA[c.sla.state][1]}>{SLA[c.sla.state][0]}</Badge>}{c.status === 'REFERRED' && <Badge tone="warn">Referred{c.canAct ? '' : ' (senior officer decides)'}</Badge>}{c.waitingForSecondApprover && <Badge tone="info">{c.firstApproverIsMe ? 'You approved first. Waiting for another officer' : 'Needs your second approval'}</Badge>}</div></div>
          <Link href={`/officer/cases/${c.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-ink">Open</Link></Card></li>))}</ul>
    </div>
  );
}
