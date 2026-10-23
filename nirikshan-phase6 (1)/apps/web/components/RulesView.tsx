'use client';
import { useI18n } from '@/lib/i18n';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Empty, ErrorNote, Loading, PageTitle } from '@/components/ui';
interface Band { category: string; category_hi: string | null; min_capacity: string; max_capacity: string; capacity_unit: string }
interface Mpe extends Band { class_code: string; direction: string; value: string; unit: string }
interface Itv extends Band { months: number; marginal_months: number | null; grace_days: number }
export interface Rules { ruleSet: { version: string; effectiveFrom: string; effectiveTo: string | null } | null; mpe: Mpe[]; intervals: Itv[] }
export default function RulesView({ initial }: { initial: Rules | null }) {
  const { t, lang } = useI18n(); const r = useFetch<Rules>('/public/rules', initial);
  const cat = (x: Band) => (lang === 'hi' && x.category_hi ? x.category_hi : x.category);
  const range = (x: Band) => `${+x.min_capacity}–${+x.max_capacity} ${x.capacity_unit}`;
  return (
    <div className="space-y-8"><PageTitle>{t('nav.rules')}</PageTitle>
      {r.loading && <Loading />}<ErrorNote error={r.error} />
      {r.data && !r.data.ruleSet && <Empty>No rules are published yet.</Empty>}
      {r.data?.ruleSet && <>
        <p className="text-muted">Rule set <b>{r.data.ruleSet.version}</b>, in force from {fmtDate(r.data.ruleSet.effectiveFrom, lang)}. Demonstration values, not for legal use.</p>
        <section><h2 className="mb-2 text-xl font-semibold">Permissible errors</h2>
          <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line"><table className="w-full text-left text-sm"><caption className="sr-only">Permissible errors</caption>
            <thead className="bg-primary-soft"><tr>{['Category', 'Capacity', 'Class', 'Direction', 'Limit'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
            <tbody>{r.data.mpe.map((m, i) => <tr key={i} className="border-t border-line"><td className="p-3">{cat(m)}</td><td className="p-3">{range(m)}</td><td className="p-3">{m.class_code}</td><td className="p-3">{m.direction}</td><td className="p-3">± {+m.value} {m.unit}</td></tr>)}</tbody></table></div></section>
        <section><h2 className="mb-2 text-xl font-semibold">Verification intervals</h2>
          <div tabIndex={0} role="region" aria-label="Table, scrolls sideways" className="relative overflow-x-auto rounded-xl border border-line"><table className="w-full text-left text-sm"><caption className="sr-only">Verification intervals</caption>
            <thead className="bg-primary-soft"><tr>{['Category', 'Capacity', 'Valid for (months)', 'Grace (days)'].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
            <tbody>{r.data.intervals.map((m, i) => <tr key={i} className="border-t border-line"><td className="p-3">{cat(m)}</td><td className="p-3">{range(m)}</td><td className="p-3">{m.months}</td><td className="p-3">{m.grace_days}</td></tr>)}</tbody></table></div></section>
      </>}
    </div>
  );
}
