'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { get } from '@/lib/api';
import { Seal } from './ui';

/** Notice from the admin (planned downtime and the like), refreshed every minute. Announced politely to screen readers. */
function Maintenance() {
  const { lang } = useI18n(); const [m, setM] = useState<{ level: string; textEn: string; textHi: string } | null>(null);
  useEffect(() => { let on = true; const load = () => get<{ maintenance: { level: string; textEn: string; textHi: string } | null }>('/public/system').then((r) => { if (on) setM(r.maintenance); }).catch(() => undefined); void load(); const i = setInterval(load, 60_000); return () => { on = false; clearInterval(i); }; }, []);
  if (!m) return null; const text = lang === 'hi' && m.textHi ? m.textHi : m.textEn;
  return <div role="status" className={`border-b-4 bg-surface px-4 py-3 text-center text-sm font-medium ${m.level === 'warn' ? 'border-warn text-warn' : 'border-primary text-ink'}`}>{text}</div>;
}

type NavItem = { href: string; key?: Parameters<ReturnType<typeof useI18n>['t']>[0]; label?: [string, string] };
const NAV: Record<string, NavItem[]> = {
  OWNER: [{ href: '/owner/dashboard', key: 'nav.home' }, { href: '/owner/instruments', key: 'nav.instruments' }, { href: '/owner/applications', key: 'nav.applications' }, { href: '/owner/certificates', key: 'nav.certificates' }, { href: '/owner/notices', key: 'nav.alerts' }, { href: '/owner/settings', key: 'nav.settings' }],
  OFFICER: [{ href: '/officer/dashboard', key: 'nav.home' }, { href: '/officer/queue', key: 'nav.queue' }, { href: '/officer/cases', key: 'nav.cases' }, { href: '/officer/decisions', key: 'nav.decisions' }, { href: '/officer/certificates', key: 'nav.certificates' }, { href: '/officer/schedule', key: 'nav.schedule' }, { href: '/officer/inspectors', key: 'nav.inspectors' }, { href: '/officer/settings', key: 'nav.settings' }],
  ADMIN: [{ href: '/admin/dashboard', key: 'nav.home' }, { href: '/admin/users', key: 'nav.users' }, { href: '/admin/masterdata', key: 'nav.masterdata' }, { href: '/admin/audit', key: 'nav.audit' }, { href: '/admin/certificates', key: 'nav.certificates' }, { href: '/officer/queue', key: 'nav.queue' }],
};
NAV.OWNER!.push({ href: '/owner/grievances', label: ['Complaints', 'शिकायतें'] });
NAV.TRADER = [...NAV.OWNER!.slice(0, -1), { href: '/owner/services', label: ['Repair jobs', 'मरम्मत कार्य'] }, NAV.OWNER![NAV.OWNER!.length - 1]!]; NAV.OFFICER!.splice(NAV.OFFICER!.length - 1, 0, { href: '/officer/enforcement', label: ['Enforcement', 'प्रवर्तन'] }, { href: '/officer/reports', label: ['Reports', 'रिपोर्ट'] });
NAV.SENIOR_OFFICER = NAV.OFFICER!;
NAV.ADMIN!.splice(NAV.ADMIN!.length, 0, { href: '/admin/rules', label: ['Rule sets', 'नियम-समूह'] }, { href: '/admin/reports', label: ['Reports', 'रिपोर्ट'] }, { href: '/admin/system', label: ['System', 'सिस्टम'] }, { href: '/admin/privacy', label: ['Privacy', 'निजता'] }, { href: '/admin/migration', label: ['Import', 'आयात'] }); NAV.INSPECTOR = [{ href: '/inspector/dashboard', key: 'nav.home' }, { href: '/inspector/history', key: 'nav.history' }, { href: '/inspector/settings', key: 'nav.settings' }];

export function Shell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n(); const { me, signOut } = useSession(); const path = usePathname(); const [dark, setDark] = useState(false);
  useEffect(() => { try { const s = localStorage.getItem('nrk_theme'); const d = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; setDark(d); document.documentElement.dataset.theme = d ? 'dark' : 'light'; } catch { /* default light */ } }, []);
  const toggle = () => { const d = !dark; setDark(d); document.documentElement.dataset.theme = d ? 'dark' : 'light'; try { localStorage.setItem('nrk_theme', d ? 'dark' : 'light'); } catch { /* ignore */ } };
  const links: NavItem[] = me ? (NAV[me.role] ?? []) : [{ href: '/', key: 'nav.home' }, { href: '/rules', key: 'nav.rules' }, { href: '/notices', key: 'nav.notices' }, { href: '/validate', key: 'nav.validate' }, { href: '/search', label: ['Search', 'खोज'] }, { href: '/help', key: 'nav.help' }];
  return (
    <>
      <a href="#main" className="skip">{t('nav.skip')}</a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href={me?.home ?? '/'} className="flex items-center gap-2 font-semibold"><Seal size={32} /><span className="text-lg">{t('app.name')}</span></Link>
          <nav aria-label="Main" className="flex flex-1 flex-wrap gap-1 text-sm">
            {links.map((l) => <Link key={l.href} href={l.href} aria-current={path === l.href || path.startsWith(l.href + '/') ? 'page' : undefined} className="min-h-11 content-center rounded-lg px-3 hover:bg-primary-soft aria-[current=page]:bg-primary-soft aria-[current=page]:font-semibold">{l.label ? l.label[lang === 'hi' ? 1 : 0] : t(l.key!)}</Link>)}
          </nav>
          <div className="flex items-center gap-1 text-sm">
            <button onClick={() => setLang(lang === 'en' ? 'hi' : 'en')} lang={lang === 'en' ? 'hi' : 'en'} className="min-h-11 rounded-lg px-3 hover:bg-primary-soft">{t('common.lang')}</button>
            <button onClick={toggle} aria-pressed={dark} className="min-h-11 rounded-lg px-3 hover:bg-primary-soft">{t('common.theme')}</button>
            {me ? <button onClick={signOut} className="min-h-11 rounded-lg border border-line px-3 hover:bg-primary-soft">{t('nav.logout')}</button>
              : <><Link href="/login" className="min-h-11 content-center rounded-lg px-3 hover:bg-primary-soft">{t('nav.login')}</Link><Link href="/register" className="min-h-11 content-center rounded-lg bg-primary px-3 font-medium text-primary-ink">{t('nav.register')}</Link></>}
          </div>
        </div>
      </header>
      <Maintenance />
      <main id="main" tabIndex={-1} className="mx-auto min-h-[60vh] max-w-6xl px-4 py-8">{children}</main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-3 px-4 py-6 text-sm text-muted">
          <p>{t('app.tag')} · {t('common.nofee')}</p>
          <p className="flex gap-4"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/accessibility">Accessibility</Link><Link href="/report">{lang === 'hi' ? 'छेड़छाड़ की सूचना' : 'Report tampering'}</Link></p>
        </div>
      </footer>
    </>
  );
}
