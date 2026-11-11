import Link from 'next/link';
import { BadgeCheck, Coins, ReceiptText, Sparkles } from 'lucide-react';
import { Button, Progress, StatusBadge } from '@xen-studio/ui';
import { STUDIOS } from '@/lib/studios';
import { prefs } from '@/lib/server';
import type { T } from '@/lib/i18n';

/** A static, media-first picture of the product: preview on top, scene timeline below. */
function ProductPreview({ t }: { t: T }) {
  const scenes = [
    { n: 1, s: 'succeeded' as const, w: 'basis-[14%]' }, { n: 2, s: 'succeeded' as const, w: 'basis-[20%]' }, { n: 3, s: 'running' as const, w: 'basis-[18%]' },
    { n: 4, s: 'queued' as const, w: 'basis-[16%]' }, { n: 5, s: 'queued' as const, w: 'basis-[18%]' }, { n: 6, s: 'queued' as const, w: 'basis-[14%]' },
  ];
  const label = { succeeded: t('preview.ready'), running: t('preview.rendering'), queued: t('preview.queued') };
  return (
    <div role="img" aria-label={t('preview.label')} className="rounded-xl border border-line bg-surface-1 p-2 shadow-3 sm:p-4">
      <div className="relative aspect-video overflow-hidden rounded-lg bg-surface-2">
        <svg viewBox="0 0 160 90" className="absolute inset-0 size-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <rect width="160" height="90" fill="var(--xs-surface-2)" />
          <circle cx="118" cy="26" r="11" fill="var(--xs-accent)" opacity="0.9" />
          <path d="M0 68 L28 44 L52 62 L84 34 L118 60 L140 48 L160 58 V90 H0Z" fill="var(--xs-surface-3)" />
          <path d="M0 78 L36 60 L70 74 L104 56 L160 76 V90 H0Z" fill="var(--xs-line-strong)" />
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-3 sm:p-4">
          <p className="max-w-[70%] rounded-md bg-overlay px-3 py-2 text-xs text-fg sm:text-sm" dir="auto">In 1908, something flattened two thousand square kilometres of forest.</p>
          <span className="rounded-sm bg-overlay px-2 py-1 font-mono text-xs text-fg tabular-nums">00:14 / 01:02</span>
        </div>
      </div>
      <div className="mt-2 flex gap-1 sm:mt-4 sm:gap-2">
        {scenes.map((sc) => (
          <div key={sc.n} className={`${sc.w} min-w-0 grow rounded-md border border-line bg-surface-2 p-2`}>
            <div className={`h-8 rounded-sm sm:h-12 ${sc.s === 'succeeded' ? 'bg-accent-soft' : 'bg-surface-3'}`} />
            <div className="mt-2 hidden items-center justify-between gap-1 md:flex">
              <span className="truncate text-xs text-fg-subtle">{t('preview.scene')} {sc.n}</span>
              <StatusBadge status={sc.s} label={label[sc.s]} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 px-1 pb-1"><Progress label={`${t('preview.scene')} 3 · ${t('preview.rendering')}`} value={42} detail={t('preview.estimate')} /></div>
    </div>
  );
}

export default async function Home() {
  const { t } = await prefs();
  const steps = [1, 2, 3, 4] as const;
  const trust = [{ icon: ReceiptText, k: 'trust.1' as const }, { icon: Coins, k: 'trust.2' as const }, { icon: BadgeCheck, k: 'trust.3' as const }];
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium text-accent-text">{t('brand.tagline')}</p>
          <h1 className="mt-4 text-2xl leading-[1.05] font-semibold text-fg sm:text-3xl">{t('hero.title')}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-md text-fg-muted">{t('hero.body')}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Button asChild variant="generate" size="lg"><Link href="/signup"><Sparkles className="size-4" aria-hidden />{t('hero.cta')}</Link></Button>
            <Button asChild variant="ghost" size="lg"><Link href="/pricing">{t('hero.secondary')}</Link></Button>
          </div>
          <p className="mt-4 text-sm text-fg-subtle">{t('hero.note')}</p>
        </div>
        <div className="mx-auto mt-12 max-w-5xl sm:mt-16"><ProductPreview t={t} /></div>
      </section>

      <section aria-labelledby="how" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <h2 id="how" className="max-w-xl text-xl font-semibold text-fg">{t('how.title')}</h2>
          <ol className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((n) => (
              <li key={n} className="flex flex-col gap-2">
                <span className="font-mono text-sm text-accent-text tabular-nums">0{n}</span>
                <h3 className="text-md font-semibold text-fg">{t(`how.${n}`)}</h3>
                <p className="text-base text-fg-muted">{t(`how.${n}.body`)}</p>
              </li>
            ))}
          </ol>
          <ul className="mt-12 flex flex-col gap-4 border-t border-line pt-8 sm:flex-row sm:gap-8">
            {trust.map(({ icon: Icon, k }) => (
              <li key={k} className="flex items-center gap-2 text-base text-fg-muted"><Icon className="size-4 shrink-0 text-accent-text" aria-hidden />{t(k)}</li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="studios" className="border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <h2 id="studios" className="text-xl font-semibold text-fg">{t('studios.title')}</h2>
          <p className="mt-2 text-md text-fg-muted">{t('studios.body')}</p>
          <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STUDIOS.map(({ slug, name, body, icon: Icon }) => (
              <li key={slug} className="rounded-lg bg-surface-1 p-6">
                <Icon className="size-6 text-fg-muted" aria-hidden />
                <h3 className="mt-4 text-md font-semibold text-fg">{t(name)}</h3>
                <p className="mt-2 text-base text-fg-muted">{t(body)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-8 px-4 py-16 text-center sm:px-6 sm:py-24">
          <h2 className="text-xl font-semibold text-fg sm:text-2xl">{t('cta.title')}</h2>
          <Button asChild variant="generate" size="lg"><Link href="/signup"><Sparkles className="size-4" aria-hidden />{t('hero.cta')}</Link></Button>
        </div>
      </section>
    </>
  );
}
