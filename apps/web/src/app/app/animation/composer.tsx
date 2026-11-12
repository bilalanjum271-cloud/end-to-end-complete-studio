'use client';
import { CircleAlert, Plus, Sparkles, X } from 'lucide-react';
import { useActionState, useMemo, useState } from 'react';
import { Button, Input, Select, Textarea } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { Meta, StyleProfile } from '@/lib/projects';
import { createAnimation, type AnimState } from '../video/actions';

const LENGTHS = [15, 30, 60, 120, 180, 300, 600];
const hex = (c: string) => `#${c.replace(/^0x/, '')}`;

export function AnimationComposer({ meta, styles, idem }: { meta: Meta; styles: StyleProfile[]; idem: string }) {
  const { t, locale } = useI18n();
  const [state, action, pending] = useActionState<AnimState, FormData>(createAnimation, {});
  const [mode, setMode] = useState<'text' | 'link'>(state.values?.mode === 'link' ? 'link' : 'text');
  const [style, setStyle] = useState(state.values?.style ?? styles[0]?.id ?? '');
  const [music, setMusic] = useState('calm');
  const [seconds, setSeconds] = useState('30');
  const [language, setLanguage] = useState<string>(meta.languages.includes(locale) ? locale : 'en');
  const [chars, setChars] = useState<{ name: string; description: string }[]>([]);
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
  const credits = Math.max(1, Math.ceil((Number(seconds) / 60) * meta.credits_per_minute));
  const err = state.error;
  return (
    <form action={action} className="flex flex-col gap-6 rounded-xl bg-surface-1 p-4 sm:p-6">
      {[['idem', idem], ['mode', mode], ['style', style], ['music', music], ['seconds', seconds], ['language', language], ['characters', JSON.stringify(chars)]].map(([n, v]) => (
        <input key={n} type="hidden" name={n} value={v} />
      ))}
      <div role="radiogroup" aria-label={t('anim.mode')} className="inline-flex w-fit rounded-md bg-surface-2 p-1">
        {(['text', 'link'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
            className={`h-8 rounded-sm px-3 text-sm font-medium transition-colors duration-150 ${mode === m ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg'}`}>
            {t(m === 'text' ? 'anim.mode.text' : 'anim.mode.link')}
          </button>
        ))}
      </div>
      {mode === 'text' ? (
        <Textarea label={t('anim.text')} name="text" rows={5} maxLength={20000} defaultValue={state.values?.text} placeholder={t('anim.text.placeholder')}
          error={err === 'video.error.prompt' ? t(err) : undefined} />
      ) : (
        <div className="flex flex-col gap-4">
          <Input label={t('anim.url')} name="url" type="url" inputMode="url" dir="ltr" placeholder="https://" defaultValue={state.values?.url} hint={t('anim.url.hint')}
            error={err === 'auth.error.invalid' ? t(err) : undefined} />
          <label className="flex items-start gap-3 rounded-md bg-surface-2 p-3 text-sm text-fg-muted">
            <input type="checkbox" name="rights" className="mt-0.5 size-4 accent-[var(--xs-accent)]" defaultChecked={state.values?.rights === 'on'} aria-invalid={err === 'anim.rights.required' || undefined} />
            <span>{t('anim.rights')}</span>
          </label>
        </div>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-fg">{t('anim.style')}</legend>
        <div role="radiogroup" aria-label={t('anim.style')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {styles.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={style === s.id} onClick={() => setStyle(s.id)}
              className={`flex flex-col gap-2 rounded-md border p-2 text-start transition-colors duration-150 ${style === s.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}>
              <span aria-hidden className="flex h-12 overflow-hidden rounded-sm">
                {s.palette.map((c, i) => <span key={c} style={{ background: hex(c), flexGrow: i === 0 ? 3 : 1 }} />)}
              </span>
              <span className="text-sm font-medium text-fg">{s.name}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg">{t('anim.characters')}</legend>
        <p className="text-sm text-fg-subtle">{t('anim.characters.hint')}</p>
        {chars.map((c, i) => (
          <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-48"><Input label={t('anim.character.name')} value={c.name} maxLength={40} onChange={(e) => setChars((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></div>
            <div className="flex-1"><Input label={t('anim.character.desc')} value={c.description} maxLength={300} onChange={(e) => setChars((cs) => cs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></div>
            <Button type="button" variant="ghost" size="icon" className="mb-1" aria-label={t('anim.character.remove', { name: c.name || String(i + 1) })} onClick={() => setChars((cs) => cs.filter((_, j) => j !== i))}><X className="size-4" aria-hidden /></Button>
          </div>
        ))}
        {chars.length < 8 ? <Button type="button" variant="ghost" size="sm" className="w-fit" icon={<Plus className="size-4" aria-hidden />} onClick={() => setChars((cs) => [...cs, { name: '', description: '' }])}>{t('anim.character.add')}</Button> : null}
      </fieldset>
      {err && !['video.error.prompt', 'auth.error.invalid'].includes(err) ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-base text-danger"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{t(err)}</p>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <Select label={t('anim.music')} value={music} onValueChange={setMusic} className="sm:w-36"
          options={(['none', 'calm', 'uplifting', 'tense'] as const).map((m) => ({ value: m, label: t(`anim.music.${m}`) }))} />
        <Select label={t('video.language')} value={language} onValueChange={setLanguage} className="sm:w-40" options={meta.languages.map((l) => ({ value: l, label: names.of(l) ?? l }))} />
        <Select label={t('video.length')} value={seconds} onValueChange={setSeconds} className="sm:w-28"
          options={LENGTHS.filter((s) => s <= meta.max_video_seconds).map((s) => ({ value: String(s), label: s < 60 ? `${s}s` : `${s / 60} min` }))} />
        <p className="flex-1 pb-2 font-mono text-sm text-fg-muted tabular-nums sm:text-end" aria-live="polite">{t('video.estimate', { credits, seconds: Math.max(5, Math.floor(Number(seconds) / 3)) })}</p>
        <Button type="submit" variant="generate" size="lg" loading={pending} icon={<Sparkles className="size-4" aria-hidden />}>{t('anim.generate')}</Button>
      </div>
    </form>
  );
}
