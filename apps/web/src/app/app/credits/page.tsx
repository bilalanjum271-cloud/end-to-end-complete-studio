import type { Metadata } from 'next';
import { Coins, TriangleAlert } from 'lucide-react';
import { EmptyState, Table } from '@xen-studio/ui';
import type { Key } from '@/lib/i18n';
import { accessToken, gw, prefs, type Balance } from '@/lib/server';

export const metadata: Metadata = { title: 'Credits' };

interface Entry { id: string; type: 'grant' | 'reserve' | 'debit' | 'refund'; amount: number; reason?: string; job_id?: string; available_after: number; created_at: string }

export default async function Credits() {
  const { t, locale } = await prefs();
  const token = await accessToken();
  const num = new Intl.NumberFormat(locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  let balance: Balance, entries: Entry[];
  try {
    [balance, { entries }] = await Promise.all([gw<Balance>('/v1/credits', { token }), gw<{ entries: Entry[] }>('/v1/credits/ledger?limit=100', { token })]);
  } catch {
    return (
      <div className="flex flex-col gap-8">
        <h1 className="text-xl font-semibold text-fg">{t('credits.title')}</h1>
        <EmptyState icon={<TriangleAlert className="size-6" aria-hidden />} title={t('credits.unavailable')} description={t('credits.unavailable.body')} />
      </div>
    );
  }
  const stats: [Key, number][] = [['credits.available', balance.available], ['credits.reserved', balance.reserved], ['credits.spent', balance.spent]];
  const sign = (e: Entry) => (e.type === 'grant' || e.type === 'refund' ? '+' : '−');
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold text-fg">{t('credits.title')}</h1>
      <dl className="grid gap-4 sm:grid-cols-3">
        {stats.map(([k, v], i) => (
          <div key={k} className="rounded-lg bg-surface-1 p-6">
            <dt className="text-sm text-fg-muted">{t(k)}</dt>
            <dd className={`mt-2 font-mono text-xl tabular-nums ${i === 0 ? 'text-fg' : 'text-fg-muted'}`}>{num.format(v)}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="ledger" className="flex flex-col gap-4">
        <h2 id="ledger" className="text-md font-semibold text-fg">{t('credits.ledger')}</h2>
        {entries.length === 0 ? (
          <EmptyState icon={<Coins className="size-6" aria-hidden />} title={t('credits.empty')} description={t('credits.empty.body')} />
        ) : (
          <Table caption={t('credits.ledger')} rows={entries} rowKey={(e) => e.id} columns={[
            { key: 'when', header: t('credits.col.when'), cell: (e) => <time dateTime={e.created_at}>{when.format(new Date(e.created_at))}</time> },
            { key: 'type', header: t('credits.col.type'), cell: (e) => t(`credits.type.${e.type}`) },
            { key: 'reason', header: t('credits.col.reason'), cell: (e) => <span className="text-fg-muted">{e.reason || e.job_id || '—'}</span> },
            { key: 'amount', header: t('credits.col.amount'), align: 'end', mono: true, cell: (e) => <span dir="ltr">{sign(e)}{num.format(e.amount)}</span> },
            { key: 'balance', header: t('credits.col.balance'), align: 'end', mono: true, cell: (e) => num.format(e.available_after) },
          ]} />
        )}
      </section>
    </div>
  );
}
