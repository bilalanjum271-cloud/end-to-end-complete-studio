'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, ShieldCheck } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button, Dialog, EmptyState, Input, StatusBadge, Table, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import { reviewModeration, setUserStatus } from './actions';

export interface ModItem { workspace_id: string; id: string; subject_type: string; decision: string; reason: string; provider: string; workspace_name: string; title: string | null; prompt: string | null; created_at: string }
export interface AdminUser { id: string; email: string; name: string; status: string; platform_role: string; created_at: string; projects: number; workspaces: { name: string; plan: string }[] }

export function ModerationQueue({ items }: { items: ModItem[] }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [done, setDone] = useState<string[]>([]);
  const [, start] = useTransition();
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const rows = items.filter((i) => !done.includes(i.id));
  if (!rows.length) return <EmptyState icon={<ShieldCheck className="size-6" aria-hidden />} title={t('admin.moderation.empty')} description={t('admin.moderation.empty.body')} />;
  const act = (i: ModItem, status: 'upheld' | 'overturned') => {
    setDone((d) => [...d, i.id]);
    start(async () => {
      const r = await reviewModeration(i.workspace_id, i.id, status);
      if (r.ok) toast({ title: t('admin.reviewed'), tone: 'success' });
      else { setDone((d) => d.filter((x) => x !== i.id)); toast({ title: t('project.action.error'), tone: 'error' }); }
    });
  };
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((i) => (
        <li key={i.id} className="flex flex-col gap-2 rounded-lg bg-surface-1 p-4 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={i.decision === 'blocked' ? 'failed' : 'review'} label={`${i.decision} · ${i.reason}`} />
              <span className="text-sm text-fg-muted">{i.workspace_name} · {i.subject_type} · {i.provider}</span>
            </div>
            <p className="mt-2 line-clamp-3 text-base text-fg" dir="auto">{i.prompt ?? i.title ?? i.id}</p>
            <time dateTime={i.created_at} className="text-xs text-fg-subtle">{when.format(new Date(i.created_at))}</time>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => act(i, 'overturned')}>{t('admin.overturn')}</Button>
            <Button size="sm" variant="primary" onClick={() => act(i, 'upheld')}>{t('admin.uphold')}</Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function UsersPanel({ users, query }: { users: AdminUser[]; query: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');
  const [busy, start] = useTransition();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const change = (u: AdminUser, status: 'active' | 'suspended', why: string) => start(async () => {
    const r = await setUserStatus(u.id, status, why);
    if (r.ok) { setTarget(null); setReason(''); router.refresh(); } else toast({ title: t('project.action.error'), tone: 'error' });
  });
  return (
    <div className="flex flex-col gap-4">
      <form role="search" className="flex items-end gap-2 sm:max-w-md" onSubmit={(e) => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get('q') ?? '');
        const next = new URLSearchParams(params);
        if (q) next.set('q', q); else next.delete('q');
        router.push(`/app/admin?${next}`);
      }}>
        <div className="flex-1"><Input label={t('admin.users.search')} name="q" defaultValue={query} type="search" /></div>
        <Button type="submit" size="icon" className="mb-1" aria-label={t('admin.users.search')}><Search className="size-4" aria-hidden /></Button>
      </form>
      <Table caption={t('admin.users')} rows={users} rowKey={(u) => u.id} columns={[
        { key: 'user', header: t('admin.col.user'), cell: (u) => <span className="flex flex-col"><span className="text-fg">{u.name}{u.platform_role !== 'user' ? <span className="ms-2 text-xs text-accent-text">{u.platform_role}</span> : null}</span><span className="text-sm text-fg-muted" dir="ltr">{u.email}</span></span> },
        { key: 'ws', header: t('admin.col.workspaces'), cell: (u) => <span className="text-sm text-fg-muted">{u.workspaces.map((w) => `${w.name} (${w.plan})`).join(', ')}</span> },
        { key: 'projects', header: t('admin.col.projects'), align: 'end', mono: true, cell: (u) => u.projects },
        { key: 'joined', header: t('admin.col.joined'), cell: (u) => <time dateTime={u.created_at} className="text-sm text-fg-muted">{date.format(new Date(u.created_at))}</time> },
        { key: 'status', header: t('admin.col.status'), cell: (u) => <StatusBadge status={u.status === 'active' ? 'succeeded' : 'failed'} label={t(u.status === 'active' ? 'admin.status.active' : 'admin.status.suspended')} /> },
        { key: 'act', header: '', align: 'end', cell: (u) => u.platform_role !== 'user' ? null : u.status === 'active'
          ? <Button size="sm" variant="ghost" onClick={() => setTarget(u)}>{t('admin.suspend')}</Button>
          : <Button size="sm" variant="ghost" loading={busy} onClick={() => change(u, 'active', 'reactivated by staff')}>{t('admin.reactivate')}</Button> },
      ]} />
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)} title={t('admin.suspend.confirm', { name: target?.name ?? '' })} description={t('admin.suspend.body')}
        footer={<><Button variant="ghost" onClick={() => setTarget(null)}>{t('admin.cancel')}</Button>
          <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => target && change(target, 'suspended', reason)}>{t('admin.suspend')}</Button></>}>
        <Input label={t('admin.suspend.reason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Dialog>
    </div>
  );
}
