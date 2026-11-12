import type { Metadata } from 'next';
import Link from 'next/link';
import { CreditCard } from 'lucide-react';
import { Button } from '@xen-studio/ui';
import { gw, prefs, type Plan } from '@/lib/server';
import { completeMockCheckout } from '../actions';

export const metadata: Metadata = { title: 'Checkout' };

export default async function MockCheckout({ searchParams }: { searchParams: Promise<{ session?: string; workspace?: string; plan?: string }> }) {
  const { t } = await prefs();
  const q = await searchParams;
  const plans = await gw<{ plans: Plan[] }>('/v1/plans', { revalidate: 60 }).then((r) => r.plans).catch(() => [] as Plan[]);
  const plan = plans.find((p) => p.id === q.plan);
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 rounded-xl border border-line bg-surface-1 p-6 shadow-2">
      <CreditCard className="size-6 text-fg-muted" aria-hidden />
      <div>
        <h1 className="text-lg font-semibold text-fg">{t('checkout.title')}</h1>
        <p className="mt-2 text-base text-fg-muted">{t('checkout.body')}</p>
      </div>
      <form action={completeMockCheckout} className="flex flex-col gap-2">
        {(['session', 'workspace', 'plan'] as const).map((k) => <input key={k} type="hidden" name={k} value={q[k] ?? ''} />)}
        <Button type="submit" variant="primary" size="lg">{t('checkout.pay', { plan: plan?.name ?? q.plan ?? '' })}</Button>
        <Button asChild variant="ghost"><Link href="/app/settings?billing=canceled">{t('checkout.cancel')}</Link></Button>
      </form>
    </div>
  );
}
