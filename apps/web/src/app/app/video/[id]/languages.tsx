'use client';
import Link from 'next/link';
import { Download, Languages as LanguagesIcon } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { Button, Select, StatusBadge, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { LocStatus, Project } from '@/lib/projects';
import { requestLocalization } from '../actions';

const LANGS = ['en', 'ur', 'ar', 'es', 'fr', 'de', 'hi', 'pt', 'id', 'tr'];
const badge: Record<LocStatus, 'running' | 'review' | 'succeeded' | 'failed'> = { translating: 'running', in_review: 'review', rendering: 'running', ready: 'succeeded', failed: 'failed' };

export function Languages({ p, onStarted }: { p: Project; onStarted: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [busy, start] = useTransition();
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
  const taken = new Set([p.language, ...p.localizations.map((l) => l.language)]);
  const choices = LANGS.filter((l) => !taken.has(l));
  const [lang, setLang] = useState(choices[0] ?? '');
  return (
    <section aria-labelledby="languages" className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:p-6">
      <div>
        <h2 id="languages" className="text-md font-semibold text-fg">{t('loc.title')}</h2>
        <p className="mt-1 text-base text-fg-muted">{t('loc.body')}</p>
      </div>
      {p.localizations.length ? (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {p.localizations.map((l) => (
            <li key={l.language} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 p-2 ps-3">
              <span className="min-w-0 flex-1 text-base text-fg">{names.of(l.language) ?? l.language}</span>
              <StatusBadge status={badge[l.status]} label={t(`loc.status.${l.status}`)} />
              {l.status === 'in_review' ? <Button asChild size="sm" variant="primary"><Link href={`/app/video/${p.id}/localize/${l.language}`}>{t('loc.review')}</Link></Button> : null}
              {l.status === 'ready' ? (
                <Button asChild size="sm"><a href={`/api/media/${p.id}/loc/${l.language}/video.mp4`}><Download className="size-4" aria-hidden />{t('loc.download')}</a></Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-fg-subtle">{t('loc.empty')}</p>}
      {choices.length ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Select label={t('loc.language')} value={lang} onValueChange={setLang} className="sm:w-48" options={choices.map((l) => ({ value: l, label: names.of(l) ?? l }))} />
          <Button loading={busy} icon={<LanguagesIcon className="size-4" aria-hidden />}
            onClick={() => start(async () => { const r = await requestLocalization(p.id, lang); if (r.ok) onStarted(); else toast({ title: t('project.action.error'), tone: 'error' }); })}>
            {t('loc.translate')}
          </Button>
          <Link href="/app/video/glossary" className="text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline sm:ms-auto sm:pb-2">{t('glossary.link')}</Link>
        </div>
      ) : null}
    </section>
  );
}
