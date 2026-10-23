import { PageTitle } from '@/components/ui';
export const metadata = { title: 'Accessibility' };
export default function Page() {
  return <article className="max-w-2xl space-y-4"><PageTitle>Accessibility</PageTitle>
    <p>We build to WCAG 2.2 level AA: keyboard operation everywhere, visible focus, text that scales, light and dark themes, reduced motion respected, and 44 px touch targets. The portal is in English and Hindi.</p>
    <p>Phase 2 has been checked with automated rules and manual keyboard passes only. A full screen-reader audit is planned before pilot. If something does not work for you, tell us through the Help page.</p></article>;
}
