'use client';
import { use } from 'react';
import Link from 'next/link';
import { useFetch } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { fmtDay, fmtTime } from '@/lib/cases';
import { Button, Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface Sheet { date: string; stops: { order: number; applicationNo: string; start: string; end: string; category: string; instrumentNo: string; area: string; address: string | null; accessHours: string | null; contact: { name: string; phone?: string } | null }[] }
export default function Route({ params }: { params: Promise<{ id: string; date: string }> }) {
  const { id, date } = use(params); const { lang } = useI18n(); const q = useFetch<Sheet>(`/officer/inspectors/${id}/route-sheet?date=${date}`);
  return (
    <div className="mx-auto max-w-3xl"><Link href="/officer/inspectors" className="text-sm text-primary underline print:hidden">← Inspectors</Link>
      <PageTitle actions={<Button variant="secondary" className="print:hidden" onClick={() => window.print()}>Print</Button>}>Route sheet · {fmtDay(date, lang)}</PageTitle>
      <p className="mb-4 text-xs text-muted">Contains premises addresses. Handle as personal data. Viewing is recorded in the audit trail.</p>
      {q.loading && <Loading />}<ErrorNote error={q.error} />{q.data?.stops.length === 0 && <Empty>No visits on this day.</Empty>}
      <ol className="space-y-3">{q.data?.stops.map((s) => <li key={s.order} className="rounded-xl border border-line bg-surface p-4"><p className="font-semibold">{s.order}. {fmtTime(s.start, lang)} – {fmtTime(s.end, lang)} · {s.applicationNo}</p><p className="text-sm">{s.category} · {s.instrumentNo}</p><p className="text-sm">{s.address ?? 'Address not on file'} ({s.area})</p>
        <p className="text-xs text-muted">{s.accessHours ? `Open: ${s.accessHours}. ` : ''}{s.contact ? `Contact: ${s.contact.name}${s.contact.phone ? ', ' + s.contact.phone : ''}` : ''}</p></li>)}</ol>
    </div>
  );
}
