import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Localization } from '@/lib/projects';
import { ApiError, accessToken, gw, prefs } from '@/lib/server';
import { ReviewForm } from './review-form';

export const metadata: Metadata = { title: 'Translation review' };

export default async function LocalizationReview({ params }: { params: Promise<{ id: string; lang: string }> }) {
  const { id, lang } = await params;
  const { t, locale } = await prefs();
  if (!/^[a-z]{2}$/.test(lang)) notFound();
  let loc: Localization;
  try {
    loc = await gw<Localization>(`/v1/projects/${id}/localizations/${lang}`, { token: await accessToken() });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const name = new Intl.DisplayNames([locale], { type: 'language' }).of(lang) ?? lang;
  return (
    <div className="flex flex-col gap-6">
      <Link href={`/app/video/${id}`} className="inline-flex w-fit items-center gap-2 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden /><span dir="auto">{loc.project_title}</span>
      </Link>
      <header>
        <h1 className="text-xl font-semibold text-fg">{t('loc.page.title', { lang: name })}</h1>
        <p className="mt-2 max-w-2xl text-base text-fg-muted">{t('loc.page.body', { credits: loc.estimate_credits })}</p>
        {loc.provider.startsWith('mock') ? <p className="mt-2 max-w-2xl text-sm text-warning">{t('loc.mock')}</p> : null}
      </header>
      <ReviewForm id={id} lang={lang} loc={loc} />
    </div>
  );
}
