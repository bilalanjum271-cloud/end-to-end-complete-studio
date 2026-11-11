'use client';
import { TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <main id="main" className="mx-auto flex min-h-[70dvh] max-w-xl items-center px-4">
      <EmptyState className="w-full" icon={<TriangleAlert className="size-6" aria-hidden />} title={t('error.title')}
        description={`${t('error.body')}${error.digest ? ` (${error.digest})` : ''}`}
        action={<Button variant="primary" onClick={reset}>{t('error.retry')}</Button>} />
    </main>
  );
}
