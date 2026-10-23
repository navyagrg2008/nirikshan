'use client';
import { fmtDate, useFetch } from '@/lib/hooks';
import { Section, Stat, Trend } from '@/components/Dashboard';
import { Alert, ErrorNote, Loading, PageTitle } from '@/components/ui';

interface V { people: { role: string; status: string; count: number }[]; registry: { instruments: { status: string; count: number }[]; openApplications: number; certificatesInForce: number; certificatesIssuedLast30Days: number }; backlogByArea: { area: string; open: number }[];
  health: { schedulerOn: boolean; jobsFailedLast24h: number; auditChain: { status: string; checkedAt: string; intact: boolean | null; entries: number | null } | null; maintenanceBannerOn: boolean }; privacy: { openRequests: number; overdueRequests: number };
  rules: { inForce: { version: number; from: string } | null; pending: { version: number; status: string }[] }; complaints: { grievancesOpen: number; tamperOpen: number }; trend: { week: string; applications: number; certificates: number }[] }
const nice = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export default function Page() {
  const v = useFetch<V>('/admin/dashboard'); const d = v.data;
  const byRole = d ? Object.entries(d.people.reduce<Record<string, number>>((m, p) => ({ ...m, [p.role]: (m[p.role] ?? 0) + p.count }), {})) : [];
  const waiting = d?.people.filter((p) => p.status === 'PENDING_VERIFICATION').reduce((a, p) => a + p.count, 0) ?? 0;
  return (
    <div><PageTitle>Administration</PageTitle>
      {v.loading && !d && <Loading />}<ErrorNote error={v.error} />
      {d && <>
        {d.health.auditChain?.intact === false && <Alert tone="danger">The audit trail check found a break. See System and tell the security contact.</Alert>}
        {d.health.jobsFailedLast24h > 0 && <Alert tone="warn">{d.health.jobsFailedLast24h} background job(s) failed in the last 24 hours.</Alert>}
        <Section title="Health">
          <li><Stat n={d.health.auditChain ? (d.health.auditChain.intact ? 'Intact' : d.health.auditChain.intact === false ? 'Broken' : '—') : 'Not run'} label={d.health.auditChain ? `Audit trail, checked ${fmtDate(d.health.auditChain.checkedAt)}` : 'Audit trail check'} href="/admin/audit" tone={d.health.auditChain?.intact === false ? 'warn' : undefined} /></li>
          <li><Stat n={d.health.schedulerOn ? 'Running' : 'Off'} label="Background scheduler" href="/admin/system" tone={d.health.schedulerOn ? undefined : 'warn'} /></li>
          <li><Stat n={d.health.jobsFailedLast24h} label="Failed jobs, last 24 hours" href="/admin/system" tone={d.health.jobsFailedLast24h ? 'warn' : undefined} /></li>
          <li><Stat n={d.health.maintenanceBannerOn ? 'On' : 'Off'} label="Notice banner" href="/admin/system" /></li>
        </Section>
        <Section title="People">
          <li><Stat n={waiting} label="Accounts pending approval" href="/admin/users" tone={waiting ? 'warn' : undefined} /></li>
          {byRole.map(([r, n]) => <li key={r}><Stat n={n} label={nice(r)} href="/admin/users" /></li>)}
        </Section>
        <Section title="Registry">
          <li><Stat n={d.registry.certificatesInForce} label="Certificates in force" href="/admin/certificates" /></li>
          <li><Stat n={d.registry.certificatesIssuedLast30Days} label="Issued in the last 30 days" /></li>
          <li><Stat n={d.registry.openApplications} label="Open applications" /></li>
          {d.registry.instruments.map((i) => <li key={i.status}><Stat n={i.count} label={`Instruments: ${nice(i.status)}`} /></li>)}
        </Section>
        <Section title="Other">
          <li><Stat n={d.rules.inForce ? `Version ${d.rules.inForce.version}` : 'None'} label={d.rules.pending.length ? `In force. Waiting: version ${d.rules.pending.map((p) => `${p.version} (${nice(p.status).toLowerCase()})`).join(', ')}` : 'Rules in force'} href="/admin/rules" tone={d.rules.pending.length ? 'warn' : undefined} /></li>
          <li><Stat n={d.privacy.openRequests} label={`Data requests open${d.privacy.overdueRequests ? `, ${d.privacy.overdueRequests} past due` : ''}`} href="/admin/privacy" tone={d.privacy.overdueRequests ? 'warn' : undefined} /></li>
          <li><Stat n={d.complaints.grievancesOpen} label="Grievances open" /></li>
          <li><Stat n={d.complaints.tamperOpen} label="Tamper reports open" /></li>
        </Section>
        {d.backlogByArea.length > 0 && <Section title="Busiest areas (open applications)">{d.backlogByArea.map((a) => <li key={a.area}><Stat n={a.open} label={a.area} /></li>)}</Section>}
        <Trend rows={d.trend} />
      </>}
    </div>
  );
}
