import { randomUUID } from 'node:crypto';
import type { Metadata } from 'next';
import Link from 'next/link';
import { TriangleAlert, Wand2 } from 'lucide-react';
import { EmptyState, StatusBadge } from '@xen-studio/ui';
import { badgeFor, type Meta, type ProjectSummary, type StyleProfile } from '@/lib/projects';
import { accessToken, gw, prefs } from '@/lib/server';
import { AnimationComposer } from './composer';

export const metadata: Metadata = { title: 'Animation' };

export default async function AnimationStudio() {
  const { t, locale } = await prefs();
  const token = await accessToken();
  let meta: Meta, projects: ProjectSummary[], profiles: StyleProfile[];
  try {
    [meta, { projects }, { profiles }] = await Promise.all([
      gw<Meta>('/v1/projects/meta', { token }),
      gw<{ projects: ProjectSummary[] }>('/v1/projects?dashboard=animation', { token }),
      gw<{ profiles: StyleProfile[] }>('/v1/style-profiles', { token }),
    ]);
  } catch {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-xl font-semibold text-fg">{t('studio.animation')}</h1>
        <EmptyState icon={<TriangleAlert className="size-6" aria-hidden />} title={t('video.unavailable')} description={t('video.unavailable.body')} />
      </div>
    );
  }
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="new" className="flex flex-col gap-4">
        <div>
          <h1 id="new" className="text-xl font-semibold text-fg">{t('studio.animation')}</h1>
          <p className="mt-2 max-w-2xl text-base text-fg-muted">{t('studio.animation.body')}</p>
        </div>
        <AnimationComposer meta={meta} styles={profiles} idem={randomUUID()} />
      </section>
      <section aria-labelledby="yours" className="flex flex-col gap-4">
        <h2 id="yours" className="text-md font-semibold text-fg">{t('anim.yours')}</h2>
        {projects.length === 0 ? (
          <EmptyState icon={<Wand2 className="size-6" aria-hidden />} title={t('anim.empty')} description={t('anim.empty.body')} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link href={`/app/video/${p.id}`} className="group flex h-full flex-col gap-4 rounded-lg bg-surface-1 p-2 transition-colors duration-150 hover:bg-surface-2">
                  <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-surface-2">
                    {p.render_version > 0
                      ? <video src={`/api/media/${p.id}/${p.render_version}/video.mp4#t=1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden className="size-full object-cover" />
                      : <Wand2 className="size-8 text-fg-subtle" aria-hidden />}
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
