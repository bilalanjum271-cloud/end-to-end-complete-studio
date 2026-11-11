import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Lock } from 'lucide-react';
import { EmptyState, StatusBadge } from '@xen-studio/ui';
import { translator } from '@/lib/i18n';
import { STUDIOS } from '@/lib/studios';
import { accessToken, gw, prefs, type Me } from '@/lib/server';

type Props = { params: Promise<{ studio: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { studio } = await params;
  const s = STUDIOS.find((x) => x.slug === studio);
  return { title: s ? translator('en')(s.name) : 'Not found' };
}

export default async function StudioPage({ params }: Props) {
  const { studio: slug } = await params;
  const studio = STUDIOS.find((s) => s.slug === slug);
  if (!studio) notFound();
  const { t } = await prefs();
  const Icon = studio.icon;
  const name = t(studio.name);

  let restricted = false;
  if (slug === 'admin') {
    const me = await gw<Me>('/v1/me', { token: await accessToken() });
    restricted = me.user.platform_role === 'user';
  }
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{name}</h1>
          <p className="mt-2 max-w-2xl text-base text-fg-muted">{t(studio.body)}</p>
        </div>
        <StatusBadge status="soon" label={t('app.soon')} />
      </header>
      {restricted ? (
        <EmptyState icon={<Lock className="size-6" aria-hidden />} title={name} description={t('app.admin.restricted')} />
      ) : (
        <EmptyState icon={<Icon className="size-6" aria-hidden />} title={t('app.soon.title', { name })} description={t('app.soon.body')} />
      )}
    </div>
  );
}
