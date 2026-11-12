import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BookA, Clapperboard, Languages, TriangleAlert } from 'lucide-react';
import { EmptyState, StatusBadge } from '@xen-studio/ui';
import { badgeFor, type Meta, type ProjectSummary } from '@/lib/projects';
import { accessToken, gw, prefs } from '@/lib/server';
import { Composer } from './composer';

export const metadata: Metadata = { title: 'Script-to-Video' };

export default async function VideoStudio() {
  const { t, locale } = await prefs();
  const token = await accessToken();
  let meta: Meta, projects: ProjectSummary[], queue: { project_id: string; language: string; title: string }[];
  try {
    [meta, { projects }, { items: queue }] = await Promise.all([gw<Meta>('/v1/projects/meta', { token }), gw<{ projects: ProjectSummary[] }>('/v1/projects', { token }),
      gw<{ items: { project_id: string; language: string; title: string }[] }>('/v1/review-queue', { token })]);
  } catch {
    // Graceful degradation: the studio service is down or slow; the rest of the app keeps working.
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-xl font-semibold text-fg">{t('studio.video')}</h1>
        <EmptyState icon={<TriangleAlert className="size-6" aria-hidden />} title={t('video.unavailable')} description={t('video.unavailable.body')} />
      </div>
    );
  }
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="new" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h1 id="new" className="text-xl font-semibold text-fg">{t('studio.video')}</h1>
          <Link href="/app/video/glossary" className="inline-flex items-center gap-2 text-sm text-fg-muted hover:text-fg"><BookA className="size-4" aria-hidden />{t('glossary.link')}</Link>
        </div>
        <Composer meta={meta} idem={randomUUID()} />
      </section>
      {queue.length ? (
        <section aria-labelledby="queue" className="flex flex-col gap-2">
          <h2 id="queue" className="text-md font-semibold text-fg">{t('loc.queue')}</h2>
          <ul className="flex flex-wrap gap-2">
            {queue.map((q) => (
              <li key={`${q.project_id}-${q.language}`}>
                <Link href={`/app/video/${q.project_id}/localize/${q.language}`} className="inline-flex h-10 items-center gap-2 rounded-md bg-surface-1 px-3 text-base text-fg hover:bg-surface-2">
                  <Languages className="size-4 text-warning" aria-hidden /><span dir="auto">{t('loc.queue.item', { title: q.title.slice(0, 40), lang: names.of(q.language) ?? q.language })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="yours" className="flex flex-col gap-4">
        <h2 id="yours" className="text-md font-semibold text-fg">{t('video.yours')}</h2>
        {projects.length === 0 ? (
          <EmptyState icon={<Clapperboard className="size-6" aria-hidden />} title={t('video.empty')} description={t('video.empty.body')} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/app/video/${p.id}`} className="group flex h-full flex-col gap-4 rounded-lg bg-surface-1 p-2 transition-colors duration-150 hover:bg-surface-2">
                  <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-surface-2 group-hover:bg-surface-3">
                    {p.render_version > 0 ? (
                      <video src={`/api/media/${p.id}/${p.render_version}/video.mp4#t=1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden className="size-full object-cover" />
                    ) : (
                      <Clapperboard className="size-8 text-fg-subtle" aria-hidden />
                    )}
                  </div>
                  <div className="flex flex-col gap-2 px-2 pb-2">
                    <h3 className="line-clamp-2 text-base font-medium text-fg" dir="auto">{p.title}</h3>
                    <div className="flex items-center justify-between gap-2">
                      <time dateTime={p.created_at} className="text-xs text-fg-subtle">{when.format(new Date(p.created_at))}</time>
                      <StatusBadge status={badgeFor[p.status]} label={t(`status.${p.status}`)} />
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
