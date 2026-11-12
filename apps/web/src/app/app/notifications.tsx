'use client';
import Link from 'next/link';
import { Bell, BellOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, EmptyState } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { Notice } from '@/lib/projects';
import { markNotificationsRead } from './video/actions';

/** In-app feed. Polls every 20 s while the tab is visible (push over WebSocket replaces this later). */
export function NotificationBell() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<{ unread: number; notifications: Notice[] }>({ unread: 0, notifications: [] });

  const load = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (res.ok) setFeed(await res.json());
    } catch { /* offline: keep the last feed */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 20_000);
    document.addEventListener('visibilitychange', load);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [load]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load(); // always show the latest when the drawer opens, not the last poll
    if (next && feed.unread > 0) {
      setFeed((f) => ({ ...f, unread: 0 })); // optimistic
      void markNotificationsRead().then(load);
    }
    if (!next) setFeed((f) => ({ ...f, notifications: f.notifications.map((n) => ({ ...n, read: true })) }));
  };
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={t('notif.title')}
      trigger={
        <Button variant="ghost" size="icon" className="relative" aria-label={t('notif.open', { n: feed.unread })}>
          <Bell className="size-4" aria-hidden />
          {feed.unread > 0 ? <span aria-hidden className="absolute end-1 top-1 size-2 rounded-full bg-accent" /> : null}
        </Button>
      }>
      {feed.notifications.length === 0 ? (
        <EmptyState icon={<BellOff className="size-6" aria-hidden />} title={t('notif.empty')} description={t('notif.empty.body')} />
      ) : (
        <ul className="flex flex-col gap-1">
          {feed.notifications.map((n) => (
            <li key={n.id}>
              <Link href={n.link || '/app/video'} onClick={() => setOpen(false)} className="flex gap-3 rounded-md p-3 hover:bg-surface-2">
                <span aria-hidden className={`mt-2 size-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-accent'}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-base ${n.read ? 'text-fg-muted' : 'font-medium text-fg'}`} dir="auto">{n.title}</span>
                  <time dateTime={n.created_at} className="text-xs text-fg-subtle">{when.format(new Date(n.created_at))}</time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
