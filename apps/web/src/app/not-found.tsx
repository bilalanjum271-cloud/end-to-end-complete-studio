import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '@xen-studio/ui';
import { prefs } from '@/lib/server';

export default async function NotFound() {
  const { t } = await prefs();
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl items-center px-4">
      <EmptyState className="w-full" icon={<Compass className="size-6" aria-hidden />} title={t('notfound.title')} description={t('notfound.body')}
        action={<Button asChild variant="primary"><Link href="/">{t('notfound.home')}</Link></Button>} />
    </main>
  );
}
