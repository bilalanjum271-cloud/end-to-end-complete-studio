import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, BookA } from 'lucide-react';
import { EmptyState } from '@xen-studio/ui';
import type { GlossaryTerm } from '@/lib/projects';
import { accessToken, gw, prefs } from '@/lib/server';
import { GlossaryEditor } from './editor';

export const metadata: Metadata = { title: 'Glossary' };

export default async function Glossary() {
  const { t } = await prefs();
  const { terms } = await gw<{ terms: GlossaryTerm[] }>('/v1/glossary', { token: await accessToken() });
  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/video" className="inline-flex w-fit items-center gap-2 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />{t('project.back')}
      </Link>
      <header>
        <h1 className="text-xl font-semibold text-fg">{t('glossary.title')}</h1>
        <p className="mt-2 max-w-2xl text-base text-fg-muted">{t('glossary.body')}</p>
      </header>
      <GlossaryEditor terms={terms} />
      {terms.length === 0 ? <EmptyState icon={<BookA className="size-6" aria-hidden />} title={t('glossary.empty')} description={t('glossary.empty.body')} /> : null}
    </div>
  );
}
