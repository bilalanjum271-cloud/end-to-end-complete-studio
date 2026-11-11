import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@xen-studio/ui';
import { FALLBACK_PLANS, gw, prefs, type Plan } from '@/lib/server';

export const metadata: Metadata = { title: 'Pricing' };

export default async function Pricing() {
  const { t, locale } = await prefs();
  const plans = await gw<{ plans: Plan[] }>('/v1/plans', { revalidate: 300 }).then((r) => r.plans).catch(() => FALLBACK_PLANS);
  const num = new Intl.NumberFormat(locale);
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-2xl leading-tight font-semibold text-fg">{t('pricing.title')}</h1>
        <p className="mt-4 text-md text-fg-muted">{t('pricing.body')}</p>
      </div>
      <ul className="mt-12 grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const featured = p.id === 'creator';
          const priority = p.queue_priority >= 80 ? 'pricing.priority.high' : p.queue_priority >= 40 ? 'pricing.priority.mid' : 'pricing.priority.low';
          const lines = [
            t('pricing.credits', { n: num.format(p.monthly_credits) }),
            t('pricing.rounds', { n: p.max_revision_rounds }),
            t('pricing.length', { n: Math.round(p.max_video_seconds / 60) }),
            t('pricing.concurrent', { n: p.max_concurrent_jobs }),
            t('pricing.seats', { n: p.max_seats }),
            t(priority),
            t(p.watermark ? 'pricing.watermark' : 'pricing.nowatermark'),
          ];
          return (
            <li key={p.id} className={`flex flex-col rounded-xl bg-surface-1 p-6 sm:p-8 ${featured ? 'ring-1 ring-accent' : 'border border-line'}`}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-fg">{p.name}</h2>
                {featured ? <span className="rounded-full bg-accent-soft px-2 py-1 text-xs font-medium text-accent-text">{t('pricing.popular')}</span> : null}
              </div>
              <p className="mt-4 flex items-baseline gap-2">
                <span className="text-2xl font-semibold text-fg tabular-nums">{p.monthly_price_cents === 0 ? t('pricing.free') : money.format(p.monthly_price_cents / 100)}</span>
                {p.monthly_price_cents > 0 ? <span className="text-base text-fg-subtle">{t('pricing.month')}</span> : null}
              </p>
              <ul className="mt-8 flex flex-1 flex-col gap-3">
                {lines.map((l) => (
                  <li key={l} className="flex items-start gap-2 text-base text-fg-muted"><Check className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />{l}</li>
                ))}
              </ul>
              <Button asChild variant={featured ? 'primary' : 'secondary'} className="mt-8 w-full">
                <Link href={`/signup?plan=${p.id}`}>{t('pricing.choose', { plan: p.name })}</Link>
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="mt-8 text-center text-base text-fg-muted">{t('pricing.enterprise')}</p>
    </section>
  );
}
