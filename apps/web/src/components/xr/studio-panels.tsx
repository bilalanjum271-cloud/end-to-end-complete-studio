'use client';
import { Plus, Shapes, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button, Dialog, Input, StatusBadge, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { XrAsset, XrKind } from './types';

export function NewScene({ kind }: { kind: XrKind }) {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, start] = useTransition();
  const create = () => start(async () => {
    const res = await fetch('/api/xr/scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, name: name.trim() }) });
    if (!res.ok) return toast({ title: t('project.action.error'), tone: 'error' });
    router.push(`/app/scene/${(await res.json()).id}`);
  });
  return (
    <Dialog open={open} onOpenChange={setOpen} title={t('xr.new')} trigger={<Button variant="primary" icon={<Plus className="size-4" aria-hidden />}>{t('xr.new')}</Button>}
      footer={<Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>{t('xr.create')}</Button>}>
      <Input label={t('xr.scene.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create(); }} />
    </Dialog>
  );
}

const badge = { queued: 'queued', generating: 'running', ready: 'succeeded', failed: 'failed', blocked: 'failed' } as const;

export function AssetLibrary({ initial }: { initial: XrAsset[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const [assets, setAssets] = useState(initial);
  const [prompt, setPrompt] = useState('');
  const [busy, start] = useTransition();
  const pending = assets.some((a) => a.status === 'queued' || a.status === 'generating');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      const res = await fetch('/api/xr/assets', { cache: 'no-store' });
      if (res.ok) setAssets((await res.json()).assets);
    }, 1500);
    return () => clearInterval(timer);
  }, [pending]);
  const generate = () => start(async () => {
    const res = await fetch('/api/xr/assets', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ prompt: prompt.trim() }) });
    if (!res.ok) return toast({ title: t('project.action.error'), tone: 'error' });
    const a = (await res.json()) as XrAsset;
    setAssets((cur) => [a, ...cur.filter((x) => x.id !== a.id)]);
    setPrompt('');
  });
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-2 rounded-lg bg-surface-1 p-4 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (prompt.trim().length >= 3) generate(); }}>
        <div className="flex-1"><Input label={t('xr.asset.prompt')} placeholder={t('xr.asset.placeholder')} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={600} /></div>
        <Button type="submit" variant="generate" loading={busy} disabled={prompt.trim().length < 3} icon={<Sparkles className="size-4" aria-hidden />}>{t('xr.asset.generate')}</Button>
      </form>
      {assets.length === 0 ? <p className="text-sm text-fg-subtle">{t('xr.assets.empty')}</p> : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-live="polite">
          {assets.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-md bg-surface-1 p-3">
              <Shapes className="size-5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-base text-fg" dir="auto" title={a.error ?? a.prompt}>{a.prompt}</span>
              <StatusBadge status={badge[a.status]} label={t(`xr.asset.status.${a.status}`)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
