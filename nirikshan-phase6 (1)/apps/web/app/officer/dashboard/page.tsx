'use client';
import { useFetch } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Dash, Section, Stat, Trend } from '@/components/Dashboard';
import { ErrorNote, Loading, PageTitle } from '@/components/ui';

interface V { queues: { accounts: number; duplicates: number; transfers: number; deregistrations: number; grievances: number; tamperReports: number }; work: { documentsToCheck: number; toSchedule: number; decisionsWaiting: number; visitsNext7Days: number }; deadlines: { breached: number; atRisk: number };
  compliance: { expiringIn30Days: number; expiredNotInDrive: number; activeDrives: number }; pipeline: { status: string; count: number }[]; trend: { week: string; applications: number; certificates: number }[] }
const nice = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
interface S { counts: Record<string, number>; overdue: number; atRisk: number; needsReview: number; rescheduleRequests: number }

export default function Page() {
  const { me } = useSession(); const staff = me?.role !== 'INSPECTOR';
  const v = useFetch<V>(staff ? '/officer/dashboard' : null);
  const a = useFetch<unknown[]>(staff ? null : '/officer/accounts'); const s = useFetch<S>(staff ? null : '/officer/cases/summary');
  if (!staff) return <Dash title="Today"><li><Stat n={a.data?.length ?? '…'} label="Accounts waiting for approval" href="/officer/queue" /></li><li><Stat n={s.data?.counts.APPLIED ?? '…'} label="Cases waiting for document check" href="/officer/cases" /></li></Dash>;
  const d = v.data; const n = (x: number | undefined) => x ?? '…';
  return (
    <div><PageTitle>Today</PageTitle>
      {v.loading && !d && <Loading />}<ErrorNote error={v.error} />
      {d && <>
        <Section title="Waiting for a decision from you">
          <li><Stat n={d.queues.accounts} label="Accounts to approve" href="/officer/queue?tab=accounts" tone={d.queues.accounts ? 'warn' : undefined} /></li>
          <li><Stat n={d.queues.transfers} label="Transfers and address changes" href="/officer/queue?tab=transfers" tone={d.queues.transfers ? 'warn' : undefined} /></li>
          <li><Stat n={d.queues.deregistrations} label="De-registrations" href="/officer/queue?tab=deregistration" tone={d.queues.deregistrations ? 'warn' : undefined} /></li>
          <li><Stat n={d.queues.duplicates} label="Duplicate overrides" href="/officer/queue?tab=duplicates" /></li>
          <li><Stat n={d.queues.grievances} label="Grievances open" href="/officer/queue?tab=grievances" tone={d.queues.grievances ? 'warn' : undefined} /></li>
          <li><Stat n={d.queues.tamperReports} label="Tamper reports open" href="/officer/queue?tab=tamper" tone={d.queues.tamperReports ? 'warn' : undefined} /></li>
        </Section>
        <Section title="Cases in progress">
          <li><Stat n={n(d.work.documentsToCheck)} label="Documents to check" href="/officer/cases" /></li>
          <li><Stat n={d.work.toSchedule} label="Visits to schedule" href="/officer/cases" /></li>
          <li><Stat n={d.work.decisionsWaiting} label="Inspected, decision waiting" href="/officer/decisions" /></li>
          <li><Stat n={d.work.visitsNext7Days} label="Visits in the next 7 days" href="/officer/schedule" /></li>
        </Section>
        <Section title="Deadlines">
          <li><Stat n={d.deadlines.breached} label="Past deadline" href="/officer/cases" tone={d.deadlines.breached ? 'warn' : undefined} /></li>
          <li><Stat n={d.deadlines.atRisk} label="Close to deadline" href="/officer/cases" tone={d.deadlines.atRisk ? 'warn' : undefined} /></li>
        </Section>
        <Section title="Compliance">
          <li><Stat n={d.compliance.expiringIn30Days} label="Certificates ending in 30 days" href="/officer/reports" /></li>
          <li><Stat n={d.compliance.expiredNotInDrive} label="Lapsed, not yet in a drive" href="/officer/enforcement" tone={d.compliance.expiredNotInDrive ? 'warn' : undefined} /></li>
          <li><Stat n={d.compliance.activeDrives} label="Enforcement drives running" href="/officer/enforcement" /></li>
        </Section>
        {d.pipeline.length > 0 && <Section title="Open applications by stage">{d.pipeline.map((p) => <li key={p.status}><Stat n={p.count} label={nice(p.status)} /></li>)}</Section>}
        <Trend rows={d.trend} />
      </>}
    </div>
  );
}
