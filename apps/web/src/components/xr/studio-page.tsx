import Link from 'next/link';
import { Box, Glasses, Layers, TriangleAlert } from 'lucide-react';
import { EmptyState } from '@xen-studio/ui';
import { ApiError, accessToken, gw, prefs } from '@/lib/server';
import { AssetLibrary, NewScene } from './studio-panels';
import type { XrAsset, XrKind, XrScene } from './types';

const ICON = { ar: Box, vr: Glasses, xr: Layers } as const;
const NAME = { ar: 'studio.ar', vr: 'studio.vr', xr: 'studio.xr' } as const;

export async function XrStudioPage({ kind }: { kind: XrKind }) {
  const { t, locale } = await prefs();
  const token = await accessToken();
  const Icon = ICON[kind];
  let scenes: XrScene[], assets: XrAsset[];
  try {
    [{ scenes }, { assets }] = await Promise.all([gw<{ scenes: XrScene[] }>(`/v1/xr/scenes?kind=${kind}`, { token }), gw<{ assets: XrAsset[] }>('/v1/xr/assets', { token })]);
  } catch (err) {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-xl font-semibold text-fg">{t(NAME[kind])}</h1>
        <EmptyState icon={<TriangleAlert className="size-6" aria-hidden />} title={t(NAME[kind])}
          description={err instanceof ApiError && err.status === 403 ? t('video.error.plan') : t('video.unavailable.body')} />
      </div>
    );
  }
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t(NAME[kind])}</h1>
          <p className="mt-2 max-w-2xl text-base text-fg-muted">{t(`xr.${kind}.body`)}</p>
        </div>
        <NewScene kind={kind} />
      </header>
      <section aria-labelledby="scenes" className="flex flex-col gap-4">
        <h2 id="scenes" className="text-md font-semibold text-fg">{t('xr.scenes')}</h2>
        {scenes.length === 0 ? <EmptyState icon={<Icon className="size-6" aria-hidden />} title={t('xr.empty')} description={t('xr.empty.body')} /> : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scenes.map((s) => (
              <li key={s.id}>
                <Link href={`/app/scene/${s.id}`} className="flex h-full flex-col gap-2 rounded-lg bg-surface-1 p-4 transition-colors duration-150 hover:bg-surface-2">
                  <span className="flex aspect-video items-center justify-center rounded-md bg-surface-2"><Icon className="size-8 text-fg-subtle" aria-hidden /></span>
                  <span className="text-base font-medium text-fg" dir="auto">{s.name}</span>
                  <span className="flex justify-between text-xs text-fg-subtle"><span>{s.scene.nodes.length} · {t(`xr.env.${s.scene.environment}`)}</span><time dateTime={s.updated_at}>{when.format(new Date(s.updated_at))}</time></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="assets" className="flex flex-col gap-4">
        <h2 id="assets" className="text-md font-semibold text-fg">{t('xr.assets')}</h2>
        <AssetLibrary initial={assets} />
      </section>
    </div>
  );
}
