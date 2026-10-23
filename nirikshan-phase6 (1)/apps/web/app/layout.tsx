import type { Metadata, Viewport } from 'next';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { SessionProvider } from '@/lib/session';
import { Shell } from '@/components/Shell';

export const metadata: Metadata = { title: { default: 'Nirikshan', template: '%s · Nirikshan' }, description: 'Online verification for legal metrology. A demonstration system with synthetic data.' };
/** Pages are rendered per request so each one can carry that request's CSP nonce. */
export const dynamic = 'force-dynamic';
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0E7C7B' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <I18nProvider><SessionProvider><Shell>{children}</Shell></SessionProvider></I18nProvider>
      </body>
    </html>
  );
}
