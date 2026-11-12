'use client';
import { CircleAlert, Sparkles } from 'lucide-react';
import { useActionState, useMemo, useState } from 'react';
import { Button, Select, Textarea } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { Meta } from '@/lib/projects';
import { createProject, type ComposeState } from './actions';

const LENGTHS = [15, 30, 60, 120, 180, 300, 600, 900];

export function Composer({ meta, idem }: { meta: Meta; idem: string }) {
  const { t, locale } = useI18n();
  const [state, action, pending] = useActionState<ComposeState, FormData>(createProject, {});
  const [seconds, setSeconds] = useState('30');
  const [language, setLanguage] = useState<string>(meta.languages.includes(locale) ? locale : 'en');
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
  const credits = Math.max(1, Math.ceil((Number(seconds) / 60) * meta.credits_per_minute));
  const fmt = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
  return (
    <form action={action} className="flex flex-col gap-4 rounded-xl bg-surface-1 p-4 sm:p-6">
      <input type="hidden" name="idem" value={idem} />
      <input type="hidden" name="seconds" value={seconds} />
      <input type="hidden" name="language" value={language} />
      <Textarea label={t('video.prompt')} name="prompt" required minLength={10} maxLength={4000} rows={3} defaultValue={state.prompt}
        placeholder={t('video.prompt.placeholder')} hint={t('video.prompt.hint')} error={state.error === 'video.error.prompt' ? t(state.error) : undefined} />
      {state.error && state.error !== 'video.error.prompt' ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-base text-danger"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{t(state.error)}</p>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <Select label={t('video.language')} value={language} onValueChange={setLanguage} className="sm:w-44"
          options={meta.languages.map((l) => ({ value: l, label: names.of(l) ?? l }))} />
        <Select label={t('video.length')} value={seconds} onValueChange={setSeconds} className="sm:w-32"
          options={LENGTHS.filter((s) => s <= meta.max_video_seconds).map((s) => ({ value: String(s), label: fmt(s) }))} />
        <p className="flex-1 pb-2 font-mono text-sm text-fg-muted tabular-nums sm:text-end" aria-live="polite">
          {t('video.estimate', { credits, seconds: Math.max(5, Math.floor(Number(seconds) / 3)) })}
        </p>
        <Button type="submit" variant="generate" size="lg" loading={pending} icon={<Sparkles className="size-4" aria-hidden />}>{t('video.generate')}</Button>
      </div>
    </form>
  );
}
