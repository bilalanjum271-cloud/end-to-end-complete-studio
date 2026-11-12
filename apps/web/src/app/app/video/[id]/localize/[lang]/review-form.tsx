'use client';
import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { Localization } from '@/lib/projects';
import { approveLocalization } from '../../../actions';

export function ReviewForm({ id, lang, loc }: { id: string; lang: string; loc: Localization }) {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [lines, setLines] = useState(loc.lines);
  const [busy, start] = useTransition();
  const editable = loc.status === 'in_review';
  return (
    <div className="flex flex-col gap-6">
      <div className="hidden grid-cols-[2rem_1fr_1fr] gap-4 px-4 text-xs font-medium tracking-wide text-fg-subtle uppercase md:grid">
        <span /><span>{t('loc.original')}</span><span>{t('loc.translation')}</span>
      </div>
      <ol className="flex flex-col gap-2">
        {loc.source_lines.map((src, i) => (
          <li key={i} className="grid gap-2 rounded-lg bg-surface-1 p-4 md:grid-cols-[2rem_1fr_1fr] md:gap-4">
            <span className="font-mono text-sm text-fg-subtle tabular-nums">{String(i + 1).padStart(2, '0')}</span>
            <p className="text-base text-fg-muted" dir="auto">{src}</p>
            <div>
              <label htmlFor={`line-${i}`} className="sr-only">{`${t('loc.translation')} ${i + 1}`}</label>
              <textarea id={`line-${i}`} lang={lang} dir="auto" rows={3} value={lines[i]} readOnly={!editable} maxLength={2000}
                onChange={(e) => setLines((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
                className="w-full resize-y rounded-md border border-line bg-surface-2 p-2 text-md leading-relaxed text-fg focus:border-focus focus:outline-none read-only:border-transparent" />
            </div>
          </li>
        ))}
      </ol>
      {loc.glossary.length ? (
        <section className="rounded-lg bg-surface-1 p-4">
          <h2 className="text-sm font-medium text-fg-muted">{t('loc.glossary.applied')}</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {loc.glossary.map((g) => <li key={g.source} className="rounded-full bg-surface-2 px-3 py-1 text-sm text-fg" dir="auto">{g.source} → {g.target}</li>)}
          </ul>
        </section>
      ) : null}
      {editable ? (
        <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-line bg-bg/90 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
          <Button variant="generate" size="lg" loading={busy} disabled={lines.some((l) => !l.trim())} icon={<Check className="size-4" aria-hidden />}
            onClick={() => start(async () => {
              const r = await approveLocalization(id, lang, lines);
              if (r.ok) router.push(`/app/video/${id}`);
              else toast({ title: r.status === 402 ? t('project.nocredits') : t('project.action.error'), tone: 'error' });
            })}>{t('loc.approve')}</Button>
        </div>
      ) : <p className="text-base text-fg-muted">{t('loc.done', { status: t(`loc.status.${loc.status}`).toLowerCase() })}</p>}
    </div>
  );
}
