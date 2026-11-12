'use client';
import { Ban, Check, CircleAlert, Coins, Copy, Crop, Download, FileText, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { Button, EmptyState, Input, Progress, Skeleton, StatusBadge, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import { ACTIVE, badgeFor, type Project, type StepStatus } from '@/lib/projects';
import { acceptVideo, approveScript, cancelProject, regenerateScript, requestExport, reviseScenes } from '../actions';

const stepBadge: Record<StepStatus, 'queued' | 'running' | 'succeeded' | 'failed'> = { queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed' };

function Copyable({ label, items }: { label: string; items: string[] }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-muted">{label}</h3>
      <ul className="flex flex-col gap-1">
        {items.map((text) => (
          <li key={text} className="flex items-start gap-2 rounded-md bg-surface-2 p-2 ps-3">
            <p className="min-w-0 flex-1 py-1 text-base whitespace-pre-line text-fg" dir="auto">{text}</p>
            <Button variant="ghost" size="icon" aria-label={`${t('package.copy')}: ${text.slice(0, 40)}`}
              onClick={() => navigator.clipboard.writeText(text).then(() => toast({ title: t('package.copied'), tone: 'success' }), () => toast({ title: t('project.action.error'), tone: 'error' }))}>
              <Copy className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectView({ initial }: { initial: Project }) {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const reduce = useReducedMotion();
  const [p, setP] = useState(initial);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [feedback, setFeedback] = useState('');
  const [expect, setExpect] = useState<string | null>(null); // optimistic: keep polling until the status moves on
  const [busy, start] = useTransition();

  const exporting = p.exports?.some((e) => e.status === 'queued' || e.status === 'running') ?? false;
  const live = ACTIVE.includes(p.status) || expect !== null || exporting;
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/projects/${p.id}`, { cache: 'no-store' });
        if (res.status === 401) return router.refresh();
        if (res.ok && !stop) {
          const next = (await res.json()) as Project;
          setP(next);
          if (expect === 'export') { if (next.exports.length) setExpect(null); }
          else if (expect && (next.status !== expect || next.render_version !== p.render_version || next.script_version !== p.script_version)) setExpect(null);
        }
      } catch { /* transient: next tick retries */ }
    };
    const timer = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(timer); };
  }, [live, p.id, p.render_version, p.script_version, expect, router]);

  const run = (fn: () => Promise<{ ok: boolean }>, from: string) =>
    start(async () => {
      const res = await fn();
      if (res.ok) { setExpect(from); setSelected([]); setFeedback(''); router.refresh(); }
      else toast({ title: t('project.action.error'), tone: 'error' });
    });

  const version = p.render_version;
  const media = (file: string) => `/api/media/${p.id}/${version}/${file}`;
  const waiting = busy || (expect !== null && expect !== 'export');

  let body: ReactNode;
  if (p.status === 'moderating' || p.status === 'writing_script') {
    body = (
      <div className="flex flex-col gap-4" aria-busy="true">
        <p className="text-base text-fg-muted" role="status">{t('project.writing')}</p>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  } else if (p.status === 'awaiting_approval') {
    body = (
      <div className="flex flex-col gap-6">
        <div>
          <h2 className="text-md font-semibold text-fg">{t('project.script')}</h2>
          <p className="mt-1 text-base text-fg-muted">{t('project.script.body')}</p>
        </div>
        <ol className="flex flex-col gap-2">
          {p.scenes.map((s) => (
            <li key={s.position} className="flex gap-4 rounded-lg bg-surface-1 p-4">
              <span className="pt-2 font-mono text-sm text-fg-subtle tabular-nums">{String(s.position).padStart(2, '0')}</span>
              <div className="min-w-0 flex-1">
                <label htmlFor={`scene-${s.position}`} className="sr-only">{t('project.scene', { n: s.position })}</label>
                <textarea id={`scene-${s.position}`} dir="auto" rows={2} defaultValue={s.narration} maxLength={2000}
                  onChange={(e) => setEdits((cur) => ({ ...cur, [s.position]: e.target.value }))}
                  className="w-full resize-y rounded-md border border-transparent bg-transparent p-2 text-md leading-relaxed text-fg hover:border-line focus:border-focus focus:outline-none" />
                <p className="px-2 text-sm text-fg-subtle" dir="auto">{s.visual_prompt}</p>
              </div>
            </li>
          ))}
        </ol>
        {p.script?.research.length ? (
          <details className="rounded-lg bg-surface-1 p-4">
            <summary className="cursor-pointer text-base font-medium text-fg">{t('project.research')}</summary>
            <ul className="mt-4 flex flex-col gap-2 text-base text-fg-muted">
              {p.script.research.map((r) => <li key={r.source}>{r.note} <span className="font-mono text-xs text-fg-subtle">{r.source}</span></li>)}
            </ul>
          </details>
        ) : null}
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
          <Input label={t('project.feedback')} placeholder={t('project.feedback.placeholder')} value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={2000} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <p className="flex flex-1 items-center gap-2 text-sm text-fg-muted"><Coins className="size-4 shrink-0 text-accent-text" aria-hidden />{t('project.approve.cost', { credits: p.estimate_credits })}</p>
            <Button variant="ghost" disabled={waiting} onClick={() => run(() => cancelProject(p.id), 'awaiting_approval')}>{t('project.cancel')}</Button>
            <Button disabled={waiting} icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => run(() => regenerateScript(p.id, feedback), 'awaiting_approval')}>{t('project.regenerate.script')}</Button>
            <Button variant="generate" size="lg" loading={waiting} icon={<Sparkles className="size-4" aria-hidden />}
              onClick={() => run(() => approveScript(p.id, Object.entries(edits).filter(([, v]) => v.trim()).map(([k, v]) => ({ position: Number(k), narration: v.trim() }))), 'awaiting_approval')}>
              {t('project.approve')}
            </Button>
          </div>
        </div>
      </div>
    );
  } else if (p.status === 'generating') {
    body = (
      <div className="flex flex-col gap-6">
        <Progress label={t('project.generating')} value={p.progress.percent}
          detail={`${p.progress.percent}% · ${t('project.left', { seconds: p.progress.estimated_seconds_left })} · ${p.estimate_credits} ${t('app.credits').toLowerCase()}`} />
        <ol className="flex flex-col gap-2" aria-live="polite">
          {p.scenes.map((s) => (
            <li key={s.position} className="flex flex-col gap-2 rounded-lg bg-surface-1 p-4 sm:flex-row sm:items-center sm:gap-4">
              <span className="font-mono text-sm text-fg-subtle tabular-nums">{String(s.position).padStart(2, '0')}</span>
              <p className="min-w-0 flex-1 truncate text-base text-fg" dir="auto">{s.narration}</p>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={stepBadge[s.voice_status]} label={`${t('project.voice')}: ${t(`project.step.${s.voice_status}`)}`} />
                <StatusBadge status={stepBadge[s.visual_status]} label={`${t('project.visual')}: ${t(`project.step.${s.visual_status}`)}`} />
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  } else if (p.status === 'in_review' || p.status === 'completed') {
    const reviewing = p.status === 'in_review';
    const total = p.scenes.reduce((n, s) => n + s.duration_ms, 0) || 1;
    body = (
      <div className="flex flex-col gap-6">
        <video key={version} controls playsInline preload="metadata" className="aspect-video w-full rounded-xl bg-surface-1 shadow-2" src={media('video.mp4')}>
          <track kind="captions" src={media('subtitles.vtt')} srcLang={p.language} label={t('project.captions')} default />
        </video>
        {/* timeline: one block per scene, width proportional to its duration; select to regenerate */}
        <div role="group" aria-label={t('project.review')} className="flex gap-1">
          {p.scenes.map((s) => {
            const on = selected.includes(s.position);
            return (
              <button key={s.position} type="button" disabled={!reviewing || p.revisions_left <= 0} aria-pressed={on} title={s.narration}
                onClick={() => setSelected((cur) => (on ? cur.filter((x) => x !== s.position) : [...cur, s.position]))}
                style={{ flexGrow: s.duration_ms / total, flexBasis: 0 }}
                className={`flex h-12 min-w-8 items-center justify-center rounded-md border font-mono text-sm tabular-nums transition-colors duration-150 disabled:cursor-default ${on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line bg-surface-1 text-fg-muted enabled:hover:border-line-strong'}`}>
                {on ? <Check className="size-4" aria-hidden /> : s.position}
                <span className="sr-only">{t('project.scene', { n: s.position })}</span>
              </button>
            );
          })}
        </div>
        {reviewing ? (
          <div className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:p-6">
            <div>
              <h2 className="text-md font-semibold text-fg">{t('project.review')}</h2>
              <p className="mt-1 text-base text-fg-muted">
                {p.revisions_left > 0 ? `${t('project.review.body')} ${t('project.rounds', { used: p.revision_round, max: p.max_revisions })}.` : t('project.rounds.none')}
              </p>
            </div>
            {p.revisions_left > 0 ? (
              <Input label={t('project.feedback')} placeholder={t('project.feedback.placeholder')} value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={2000} />
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {p.revisions_left > 0 ? (
                <Button disabled={waiting || selected.length === 0} icon={<RefreshCw className="size-4" aria-hidden />}
                  onClick={() => run(() => reviseScenes(p.id, selected, feedback), 'in_review')}>{t('project.revise')}{selected.length ? ` (${selected.length})` : ''}</Button>
              ) : null}
              <Button variant="primary" loading={waiting} icon={<Check className="size-4" aria-hidden />} onClick={() => run(() => acceptVideo(p.id), 'in_review')}>{t('project.accept')}</Button>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-base text-fg-muted"><Check className="size-4 text-accent-text" aria-hidden />{t('project.completed', { credits: p.estimate_credits })}</p>
        )}
        <section aria-labelledby="formats" className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:p-6">
          <div>
            <h2 id="formats" className="text-md font-semibold text-fg">{t('export.title')}</h2>
            <p className="mt-1 text-base text-fg-muted">{t('export.body')}</p>
          </div>
          <div className="flex flex-wrap gap-2" aria-live="polite">
            {(['9:16', '1:1'] as const).map((format) => {
              const ex = p.exports.find((e) => e.format === format);
              if (ex?.status === 'succeeded') {
                return <Button key={format} asChild><a href={media(`export-${format.replace(':', 'x')}.mp4`)} download><Download className="size-4" aria-hidden />{t('export.download', { format })}</a></Button>;
              }
              const working = ex?.status === 'queued' || ex?.status === 'running';
              return (
                <Button key={format} loading={working} disabled={busy} icon={<Crop className="size-4" aria-hidden />}
                  onClick={() => start(async () => { const r = await requestExport(p.id, version, format); if (r.ok) setExpect('export'); else toast({ title: t('project.action.error'), tone: 'error' }); })}>
                  {t(working ? 'export.working' : ex?.status === 'failed' ? 'export.failed' : 'export.create', { format })}
                </Button>
              );
            })}
          </div>
        </section>
        {p.package ? (
          <section aria-labelledby="package" className="flex flex-col gap-6 rounded-lg bg-surface-1 p-4 sm:p-6">
            <div>
              <h2 id="package" className="text-md font-semibold text-fg">{t('package.title')}</h2>
              <p className="mt-1 text-base text-fg-muted">{t('package.body')}</p>
            </div>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
              {p.package.has_thumbnail ? (
                <a href={media('thumbnail.jpg')} download={`thumbnail-v${version}.jpg`} className="group flex flex-col gap-2" aria-label={t('package.thumbnail.download')}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, per-user media */}
                  <img src={media('thumbnail.jpg')} alt={t('package.thumbnail')} width={1280} height={720} loading="lazy" className="aspect-video w-full rounded-md bg-surface-2 object-cover" />
                  <span className="text-sm text-fg-muted group-hover:text-fg">{t('package.thumbnail.download')}</span>
                </a>
              ) : null}
              <div className="flex min-w-0 flex-col gap-6">
                <Copyable label={t('package.titles')} items={p.package.titles} />
                <Copyable label={t('package.description')} items={[p.package.description]} />
                <Copyable label={t('package.tags')} items={[p.package.tags.join(', ')]} />
              </div>
            </div>
          </section>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild><a href={media('download.mp4')} download><Download className="size-4" aria-hidden />{t('project.download')}</a></Button>
          <Button asChild variant="ghost"><a href={media('subtitles.srt')} download={`subtitles-v${version}.srt`}><FileText className="size-4" aria-hidden />{t('project.subtitles')}</a></Button>
          <Button asChild variant="ghost"><a href={media('provenance.json')} target="_blank" rel="noreferrer"><ShieldCheck className="size-4" aria-hidden />{t('project.provenance')}</a></Button>
        </div>
      </div>
    );
  } else if (p.status === 'blocked') {
    body = <EmptyState icon={<Ban className="size-6" aria-hidden />} title={t('project.blocked')} description={t('project.blocked.body', { reason: p.error ?? '' })} />;
  } else if (p.status === 'insufficient_credits') {
    body = <EmptyState icon={<Coins className="size-6" aria-hidden />} title={t('project.nocredits')} description={t('project.nocredits.body', { credits: p.estimate_credits })} />;
  } else if (p.status === 'cancelled') {
    body = <EmptyState icon={<Ban className="size-6" aria-hidden />} title={t('project.cancelled')} description={t('project.cancelled.body')} />;
  } else {
    body = <EmptyState icon={<CircleAlert className="size-6" aria-hidden />} title={t('project.failed')} description={t('project.failed.body')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="min-w-0 flex-1 text-xl font-semibold text-fg" dir="auto">{p.title}</h1>
        <StatusBadge status={badgeFor[p.status]} label={t(`status.${p.status}`)} />
      </header>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={p.status} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -8 }}
          transition={{ duration: reduce ? 0 : 0.2, ease: [0.2, 0, 0, 1] }}>
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
