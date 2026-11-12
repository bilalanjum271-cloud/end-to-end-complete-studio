import type { Metadata } from 'next';
import { Lock } from 'lucide-react';
import { EmptyState, Table } from '@xen-studio/ui';
import { ApiError, accessToken, gw, prefs } from '@/lib/server';
import type { Point } from './bar-chart';
import { ChartFormat } from './format';
import { ModerationQueue, UsersPanel, type AdminUser, type ModItem } from './panels';

export const metadata: Metadata = { title: 'Admin & Analytics' };

interface Overview {
  users: { total: number; new_7d: number }; mrr_cents: number; days: number;
  plans: { id: string; name: string; monthly_price_cents: number; workspaces: number }[];
  credits: { granted: number; spent: number; refunded: number; reserved: number };
  videos: { renders: number; minutes: number; provider_cost_usd: number; cost_per_minute_usd: number | null };
  series: { signups: Point[]; provider_cost_usd: Point[]; credits_spent: Point[] };
  providers: { type: string; provider: string; jobs: number; failure_rate: number; cost_usd: number; avg_ms: number }[];
  queues: { projects: Record<string, number>; localization_review: number; exports: { active: number; failed: number }; moderation_pending: number; outbox_backlog: number };
}

export default async function Admin({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { t, locale } = await prefs();
  const token = await accessToken();
  const { q = '' } = await searchParams;
  let o: Overview, users: AdminUser[], items: ModItem[];
  try {
    [o, { users }, { items }] = await Promise.all([
      gw<Overview>('/v1/admin/overview?days=14', { token }),
      gw<{ users: AdminUser[] }>(`/v1/admin/users?limit=50&q=${encodeURIComponent(q)}`, { token }),
      gw<{ items: ModItem[] }>('/v1/admin/moderation', { token }),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return (
        <div className="flex flex-col gap-8">
          <h1 className="text-xl font-semibold text-fg">{t('admin.title')}</h1>
          <EmptyState icon={<Lock className="size-6" aria-hidden />} title={t('admin.title')} description={t('app.admin.restricted')} />
        </div>
      );
    }
    throw err;
  }
  const num = new Intl.NumberFormat(locale);
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const kpis = [
    { label: t('admin.kpi.users'), value: num.format(o.users.total), note: t('admin.kpi.users.new', { n: num.format(o.users.new_7d) }) },
    { label: t('admin.kpi.mrr'), value: usd.format(o.mrr_cents / 100), note: t('admin.kpi.mrr.note') },
    { label: t('admin.kpi.minutes'), value: num.format(o.videos.minutes), note: `${num.format(o.videos.renders)} renders` },
    { label: t('admin.kpi.cost'), value: usd.format(o.videos.provider_cost_usd), note: o.videos.cost_per_minute_usd === null ? t('admin.kpi.cpm.none') : t('admin.kpi.cpm', { v: usd.format(o.videos.cost_per_minute_usd) }) },
    { label: t('admin.kpi.credits'), value: num.format(o.credits.spent), note: t('admin.kpi.credits.note', { r: num.format(o.credits.reserved), f: num.format(o.credits.refunded) }) },
  ];
  const p = o.queues.projects;
  const queues = [
    [t('admin.q.generating'), (p.generating ?? 0) + (p.writing_script ?? 0) + (p.moderating ?? 0)], [t('admin.q.awaiting'), p.awaiting_approval ?? 0],
    [t('admin.q.review'), p.in_review ?? 0], [t('admin.q.loc'), o.queues.localization_review], [t('admin.q.exports'), o.queues.exports.active],
    [t('admin.q.moderation'), o.queues.moderation_pending], [t('admin.q.outbox'), o.queues.outbox_backlog],
  ] as const;
  return (
    <div className="flex flex-col gap-12">
      <header>
        <h1 className="text-xl font-semibold text-fg">{t('admin.title')}</h1>
        <p className="mt-2 text-base text-fg-muted">{t('admin.body', { days: o.days })}</p>
      </header>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-lg bg-surface-1 p-4">
            <dt className="text-sm text-fg-muted">{k.label}</dt>
            <dd className="mt-2 font-mono text-xl text-fg tabular-nums">{k.value}</dd>
            <dd className="mt-1 text-xs text-fg-subtle">{k.note}</dd>
          </div>
        ))}
      </dl>
      <ChartFormat signups={o.series.signups} cost={o.series.provider_cost_usd} credits={o.series.credits_spent} />
      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <section aria-labelledby="providers" className="flex min-w-0 flex-col gap-4">
          <h2 id="providers" className="text-md font-semibold text-fg">{t('admin.providers')}</h2>
          <Table caption={t('admin.providers')} rows={o.providers} rowKey={(r) => `${r.type}-${r.provider}`} columns={[
            { key: 'type', header: t('admin.col.type'), cell: (r) => r.type },
            { key: 'provider', header: t('admin.col.provider'), cell: (r) => r.provider },
            { key: 'jobs', header: t('admin.col.jobs'), align: 'end', mono: true, cell: (r) => num.format(r.jobs) },
            { key: 'fail', header: t('admin.col.failure'), align: 'end', mono: true, cell: (r) => <span className={r.failure_rate > 0.05 ? 'text-danger' : ''}>{(r.failure_rate * 100).toFixed(1)}%</span> },
            { key: 'cost', header: t('admin.col.cost'), align: 'end', mono: true, cell: (r) => r.cost_usd.toFixed(4) },
            { key: 'lat', header: t('admin.col.latency'), align: 'end', mono: true, cell: (r) => `${(r.avg_ms / 1000).toFixed(1)}s` },
          ]} />
        </section>
        <div className="flex flex-col gap-8">
          <section aria-labelledby="queues" className="flex flex-col gap-4">
            <h2 id="queues" className="text-md font-semibold text-fg">{t('admin.queues')}</h2>
            <dl className="flex flex-col rounded-lg bg-surface-1 p-2">
              {queues.map(([label, n]) => (
                <div key={label} className="flex items-center justify-between gap-4 rounded-md px-2 py-2">
                  <dt className="text-sm text-fg-muted">{label}</dt><dd className="font-mono text-base text-fg tabular-nums">{num.format(n)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="plans" className="flex flex-col gap-4">
            <h2 id="plans" className="text-md font-semibold text-fg">{t('admin.plans')}</h2>
            <dl className="flex flex-col rounded-lg bg-surface-1 p-2">
              {o.plans.map((pl) => (
                <div key={pl.id} className="flex items-center justify-between gap-4 rounded-md px-2 py-2">
                  <dt className="text-sm text-fg-muted">{pl.name}</dt><dd className="font-mono text-base text-fg tabular-nums">{num.format(pl.workspaces)}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
      <section aria-labelledby="moderation" className="flex flex-col gap-4">
        <h2 id="moderation" className="text-md font-semibold text-fg">{t('admin.moderation')}</h2>
        <ModerationQueue items={items} />
      </section>
      <section aria-labelledby="users" className="flex flex-col gap-4">
        <h2 id="users" className="text-md font-semibold text-fg">{t('admin.users')}</h2>
        <UsersPanel users={users} query={q} />
      </section>
    </div>
  );
}
