'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, PageTitle } from './ui';
export function Stat({ n, label, href, tone }: { n: ReactNode; label: string; href?: string; tone?: 'warn' }) {
  const inner = <Card className={`h-full p-4 ${tone === 'warn' ? 'border-warn' : ''}`}><p className="text-3xl font-bold">{n}</p><p className="text-sm text-muted">{label}</p></Card>;
  return href ? <Link href={href} className="block h-full rounded-xl [&>section]:hover:border-primary">{inner}</Link> : inner;
}
export function Dash({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return <div><PageTitle>{title}</PageTitle><ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>{note && <p className="mt-6 text-sm text-muted">{note}</p>}</div>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = 's-' + title.toLowerCase().replace(/\W+/g, '-');
  return <section aria-labelledby={id} className="mt-8"><h2 id={id} className="mb-3 text-lg font-semibold">{title}</h2><ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</ul></section>;
}

/** Eight weeks of applications and certificates. Each bar carries its number as text, and a table follows for screen readers. */
export function Trend({ rows }: { rows: { week: string; applications: number; certificates: number }[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.applications, r.certificates]));
  return (
    <Card className="mt-8">
      <h2 className="mb-1 text-lg font-semibold">Last 8 weeks</h2>
      <p className="mb-3 text-xs text-muted">Applications received and certificates issued, by week starting on the date shown.</p>
      <div aria-hidden className="grid grid-cols-8 gap-2">
        {rows.map((r) => (
          <div key={r.week} className="flex flex-col items-center gap-1 text-xs">
            <div className="flex h-28 items-end gap-1">
              <div className="flex flex-col items-center justify-end"><span>{r.applications}</span><div className="w-4 rounded-t bg-primary" style={{ height: `${(r.applications / max) * 88}px`, minHeight: 2 }} /></div>
              <div className="flex flex-col items-center justify-end"><span>{r.certificates}</span><div className="w-4 rounded-t border-2 border-primary bg-surface" style={{ height: `${(r.certificates / max) * 88}px`, minHeight: 2 }} /></div>
            </div>
            <span className="text-muted">{r.week.slice(5)}</span>
          </div>
        ))}
      </div>
      <p aria-hidden className="mt-2 flex gap-4 text-xs text-muted"><span><span className="mr-1 inline-block size-3 rounded-sm bg-primary align-middle" />Applications</span><span><span className="mr-1 inline-block size-3 rounded-sm border-2 border-primary align-middle" />Certificates</span></p>
      <table className="sr-only"><caption>Applications and certificates per week</caption><thead><tr><th scope="col">Week starting</th><th scope="col">Applications</th><th scope="col">Certificates</th></tr></thead><tbody>{rows.map((r) => <tr key={r.week}><th scope="row">{r.week}</th><td>{r.applications}</td><td>{r.certificates}</td></tr>)}</tbody></table>
    </Card>
  );
}
