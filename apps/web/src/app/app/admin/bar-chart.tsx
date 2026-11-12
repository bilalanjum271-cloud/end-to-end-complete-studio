'use client';
import { useId, useState } from 'react';
import { useI18n } from '@/components/i18n-provider';

export interface Point { day: string; value: number }

/**
 * Single-series daily bars. One accent hue (validated for contrast on both themes), thin bars with a
 * 2px surface gap and 4px rounded tops anchored to the baseline, recessive gridlines, per-bar hover and
 * focus tooltip, and a table view so no value depends on hovering.
 */
export function BarChart({ title, data, format }: { title: string; data: Point[]; format: (v: number) => string }) {
  const { t, locale } = useI18n();
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = niceMax(max);
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const label = (d: Point) => day.format(new Date(`${d.day}T00:00:00Z`));
  const total = data.reduce((n, d) => n + d.value, 0);
  return (
    <figure className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:p-6" aria-labelledby={`${id}-t`}>
      <figcaption className="flex items-baseline justify-between gap-4">
        <span id={`${id}-t`} className="text-base font-medium text-fg">{title}</span>
        <span className="font-mono text-sm text-fg-muted tabular-nums">{format(total)}</span>
      </figcaption>
      <div className="relative h-40" onPointerLeave={() => setActive(null)}>
        {[0, 0.5, 1].map((f) => (
          <div key={f} aria-hidden className="absolute inset-x-0 flex items-center gap-2" style={{ bottom: `${f * 100}%`, transform: 'translateY(50%)' }}>
            <span className="w-10 shrink-0 text-end font-mono text-xs text-fg-subtle tabular-nums">{format(nice * f)}</span>
            <span className={`h-px flex-1 ${f === 0 ? 'bg-line-strong' : 'bg-line'}`} />
          </div>
        ))}
        <div className="absolute inset-y-0 start-12 end-0 flex items-end gap-0.5">
          {data.map((d, i) => (
            <button key={d.day} type="button" aria-label={`${label(d)}: ${format(d.value)}`}
              onPointerEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
              className="group relative flex h-full flex-1 items-end focus-visible:outline-offset-0">
              <span className={`w-full rounded-t-[4px] transition-colors duration-150 ${active === i ? 'bg-accent-hover' : 'bg-accent'}`}
                style={{ height: `${(d.value / nice) * 100}%`, minHeight: d.value > 0 ? 2 : 0 }} />
              {active === i ? (
                <span role="tooltip" className="pointer-events-none absolute bottom-full start-1/2 z-10 mb-2 -translate-x-1/2 rounded-md border border-line bg-surface-3 px-2 py-1 text-start whitespace-nowrap shadow-2 rtl:translate-x-1/2">
                  <span className="block font-mono text-sm font-semibold text-fg tabular-nums">{format(d.value)}</span>
                  <span className="block text-xs text-fg-muted">{label(d)}</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-between ps-12 text-xs text-fg-subtle" aria-hidden>
        <span>{data[0] ? label(data[0]) : ''}</span><span>{data.at(-1) ? label(data.at(-1)!) : ''}</span>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">{t('admin.chart.table')}</summary>
        <table className="mt-2 w-full">
          <caption className="sr-only">{title}</caption>
          <thead><tr className="text-xs text-fg-subtle"><th scope="col" className="py-1 text-start font-medium">{t('admin.col.day')}</th><th scope="col" className="py-1 text-end font-medium">{t('admin.col.value')}</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.day} className="border-t border-line"><td className="py-1 text-fg-muted">{label(d)}</td><td className="py-1 text-end font-mono text-fg tabular-nums">{format(d.value)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
