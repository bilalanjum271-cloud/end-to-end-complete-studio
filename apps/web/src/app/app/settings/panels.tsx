'use client';
import { UserPlus, X } from 'lucide-react';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { Button, Input, Select, Table, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { Plan } from '@/lib/server';
import { addMember, changeRole, removeMember, startCheckout } from './actions';

export interface Member { id: string; email: string; name: string; role: 'owner' | 'admin' | 'editor' | 'viewer' }
const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 } as const;

export function TeamPanel({ workspaceId, members, meId, myRole }: { workspaceId: string; members: Member[]; meId: string; myRole: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [state, action, pending] = useActionState(addMember, {});
  const [role, setRole] = useState('editor');
  const [hidden, setHidden] = useState<string[]>([]);
  const [, start] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const canManage = RANK[myRole as keyof typeof RANK] >= RANK.admin;
  useEffect(() => { if (state.ok) { form.current?.reset(); toast({ title: t('settings.member.added'), tone: 'success' }); } }, [state.ok, toast, t]);
  const roleOptions = (['owner', 'admin', 'editor', 'viewer'] as const).filter((r) => r !== 'owner' || myRole === 'owner').map((r) => ({ value: r, label: t(`settings.role.${r}`) }));
  return (
    <div className="flex flex-col gap-4">
      {canManage ? (
        <form ref={form} action={action} className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:flex-row sm:items-end sm:p-6">
          <input type="hidden" name="ws" value={workspaceId} />
          <input type="hidden" name="role" value={role} />
          <div className="flex-1"><Input label={t('settings.invite.email')} name="email" type="email" required dir="ltr" error={state.error} /></div>
          <Select label={t('settings.invite.role')} value={role} onValueChange={setRole} className="sm:w-36" options={roleOptions.filter((o) => o.value !== 'owner')} />
          <Button type="submit" variant="primary" loading={pending} icon={<UserPlus className="size-4" aria-hidden />}>{t('settings.invite')}</Button>
        </form>
      ) : null}
      <Table caption={t('settings.team')} rows={members.filter((m) => !hidden.includes(m.id))} rowKey={(m) => m.id} columns={[
        { key: 'member', header: t('settings.col.member'), cell: (m) => <span className="flex flex-col"><span className="text-fg">{m.name}{m.id === meId ? <span className="ms-2 text-xs text-fg-subtle">({t('settings.you')})</span> : null}</span><span className="text-sm text-fg-muted" dir="ltr">{m.email}</span></span> },
        { key: 'role', header: t('settings.col.role'), cell: (m) => canManage && m.id !== meId && (m.role !== 'owner' || myRole === 'owner') ? (
            <Select label={t('settings.col.role')} hideLabel value={m.role} className="h-8 w-32 text-sm" options={roleOptions}
              onValueChange={(r) => start(async () => { const res = await changeRole(workspaceId, m.id, r); if (!res.ok) toast({ title: res.error ?? t('project.action.error'), tone: 'error' }); })} />
          ) : t(`settings.role.${m.role}`) },
        { key: 'act', header: '', align: 'end', cell: (m) => canManage && m.id !== meId && (m.role !== 'owner' || myRole === 'owner') ? (
            <Button variant="ghost" size="icon" aria-label={t('settings.remove', { name: m.name })} onClick={() => {
              setHidden((h) => [...h, m.id]);
              start(async () => { const res = await removeMember(workspaceId, m.id); if (res.ok) toast({ title: t('settings.member.removed'), tone: 'success' }); else { setHidden((h) => h.filter((x) => x !== m.id)); toast({ title: res.error ?? t('project.action.error'), tone: 'error' }); } });
            }}><X className="size-4" aria-hidden /></Button>
          ) : null },
      ]} />
    </div>
  );
}

export function BillingPanel({ billing, plans, isOwner, locale }: { billing: { plan_id: string; name: string; renews_at: string | null; payment_provider: string };
  plans: (Plan & { regional_price_cents: number })[]; isOwner: boolean; locale: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, start] = useTransition();
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const current = plans.find((p) => p.id === billing.plan_id);
  const upgrades = plans.filter((p) => p.monthly_price_cents > (current?.monthly_price_cents ?? 0));
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-surface-1 p-4 sm:p-6">
      <p className="text-base text-fg">
        {t('settings.billing.current', { plan: billing.name })}{' '}
        {billing.renews_at ? <span className="text-fg-muted">{t('settings.billing.renews', { date: date.format(new Date(billing.renews_at)) })}</span> : null}
      </p>
      {upgrades.length ? (
        <div className="flex flex-wrap gap-2">
          {upgrades.map((p) => (
            <Button key={p.id} variant={p.id === 'pro' ? 'primary' : 'secondary'} disabled={!isOwner} loading={busy}
              onClick={() => start(async () => { const r = await startCheckout(p.id as 'pro' | 'studio'); if (r?.error) toast({ title: r.error, tone: 'error' }); })}>
              {t('settings.billing.upgrade', { plan: p.name })} · {money.format(p.regional_price_cents / 100)}{t('pricing.month')}
            </Button>
          ))}
        </div>
      ) : null}
      {!isOwner ? <p className="text-sm text-fg-subtle">{t('settings.billing.owner')}</p> : null}
      {billing.payment_provider === 'mock' ? <p className="text-sm text-warning">{t('settings.billing.mock')}</p> : null}
    </div>
  );
}
