'use client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui';
export default function Error({ reset }: { error: Error; reset: () => void }) {
  const { t } = useI18n();
  return <div className="py-16 text-center"><h1 className="text-2xl font-semibold">{t('err.title')}</h1><p className="mt-2 text-muted">{t('err.generic')}</p><Button className="mt-6" onClick={reset}>OK</Button></div>;
}
