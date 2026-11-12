'use client';
import { useI18n } from '@/components/i18n-provider';
import { BarChart, type Point } from './bar-chart';

/** Charts live in a client component so their number formatters (functions) never cross the server boundary. */
export function ChartFormat({ signups, cost, credits }: { signups: Point[]; cost: Point[]; credits: Point[] }) {
  const { t, locale } = useI18n();
  const int = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const usd = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <BarChart title={t('admin.chart.signups')} data={signups} format={(v) => int.format(v)} />
      <BarChart title={t('admin.chart.cost')} data={cost} format={(v) => usd.format(v)} />
      <BarChart title={t('admin.chart.credits')} data={credits} format={(v) => int.format(v)} />
    </div>
  );
}
