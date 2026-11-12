import type { Metadata } from 'next';
import { CircleCheck, Info } from 'lucide-react';
import { accessToken, gw, prefs, type Me, type Plan } from '@/lib/server';
import { BillingPanel, TeamPanel, type Member } from './panels';

export const metadata: Metadata = { title: 'Settings' };

interface Billing { plan_id: string; name: string; status: string | null; renews_at: string | null; payment_provider: string }

export default async function Settings({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const { t, locale } = await prefs();
  const token = await accessToken();
  const { billing: flash } = await searchParams;
  const me = await gw<Me>('/v1/me', { token });
  const ws = me.workspaces.find((w) => w.id === me.current_workspace_id) ?? me.workspaces[0];
  const [{ members }, billing, { plans }] = await Promise.all([
    gw<{ members: Member[] }>(`/v1/workspaces/${ws.id}/members`, { token }),
    gw<Billing>('/v1/billing/summary', { token }),
    gw<{ plans: (Plan & { regional_price_cents: number })[] }>('/v1/plans', { token }),
  ]);
  return (
    <div className="flex flex-col gap-12">
      <h1 className="text-xl font-semibold text-fg">{t('settings.title')}</h1>
      {flash === 'success' ? <p role="status" className="flex items-center gap-2 rounded-md bg-accent-soft p-3 text-base text-accent-text"><CircleCheck className="size-4" aria-hidden />{t('settings.billing.success')}</p> : null}
      {flash === 'canceled' ? <p role="status" className="flex items-center gap-2 rounded-md bg-surface-1 p-3 text-base text-fg-muted"><Info className="size-4" aria-hidden />{t('settings.billing.canceled')}</p> : null}
      <section aria-labelledby="billing" className="flex flex-col gap-4">
        <h2 id="billing" className="text-md font-semibold text-fg">{t('settings.billing')}</h2>
        <BillingPanel billing={billing} plans={plans} isOwner={me.role === 'owner'} locale={locale} />
      </section>
      <section aria-labelledby="team" className="flex flex-col gap-4">
        <div>
          <h2 id="team" className="text-md font-semibold text-fg">{t('settings.team')}</h2>
          <p className="mt-1 text-base text-fg-muted">{t('settings.team.body', { workspace: ws.name })}</p>
        </div>
        <TeamPanel workspaceId={ws.id} members={members} meId={me.user.id} myRole={me.role} />
      </section>
    </div>
  );
}
