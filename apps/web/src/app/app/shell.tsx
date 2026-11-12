'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Coins, LogOut, Menu, Moon, Search } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, CommandPalette, Drawer, Tooltip, type CommandItem } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import { Logo } from '@/components/logo';
import { ThemeToggle, toggleTheme } from '@/components/prefs';
import { STUDIOS } from '@/lib/studios';
import { logout } from '../(auth)/actions';
import { NotificationBell } from './notifications';

export interface ShellProps {
  user: { name: string; email: string };
  workspace: { name: string; plan: string };
  credits: number | null;
  theme: 'dark' | 'light';
  children: ReactNode;
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const reduce = useReducedMotion();
  return (
    <ul className="flex flex-col gap-1">
      {STUDIOS.map(({ slug, name, icon: Icon, shortcut }) => {
        const href = `/app/${slug}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={slug} className="relative">
            {active ? (
              <motion.span layoutId="nav-active" aria-hidden className="absolute inset-0 rounded-md bg-surface-2"
                transition={reduce ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] }} />
            ) : null}
            <Link href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
              className={`relative flex h-10 items-center gap-3 rounded-md px-3 text-base transition-colors duration-150 ${active ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 truncate">{t(name)}</span>
              <kbd className="hidden font-mono text-xs text-fg-subtle uppercase lg:inline" aria-hidden>g {shortcut}</kbd>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Shell({ user, workspace, credits, theme, children }: ShellProps) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const pendingG = useRef(0);

  // "g" then a studio letter jumps to that dashboard (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest('input, textarea, select, [contenteditable=true], [role=dialog]')) return;
      const k = e.key.toLowerCase();
      if (k === 'g') { pendingG.current = Date.now(); return; }
      if (Date.now() - pendingG.current < 1200) {
        const s = STUDIOS.find((x) => x.shortcut === k);
        if (s) { e.preventDefault(); router.push(`/app/${s.slug}`); }
      }
      pendingG.current = 0;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const items = useMemo<CommandItem[]>(() => [
    ...STUDIOS.map(({ slug, name, icon: Icon, shortcut }) => ({
      id: slug, group: t('app.group.navigate'), label: t('app.go', { name: t(name) }), icon: <Icon className="size-4" aria-hidden />,
      shortcut: `G ${shortcut.toUpperCase()}`, keywords: [slug], onSelect: () => router.push(`/app/${slug}`),
    })),
    { id: 'credits', group: t('app.group.navigate'), label: t('app.go', { name: t('app.credits') }), icon: <Coins className="size-4" aria-hidden />, onSelect: () => router.push('/app/credits') },
    { id: 'theme', group: t('app.group.prefs'), label: t('app.theme.toggle'), icon: <Moon className="size-4" aria-hidden />, onSelect: () => { toggleTheme(); router.refresh(); } },
    { id: 'logout', group: t('app.account'), label: t('app.logout'), icon: <LogOut className="size-4" aria-hidden />, onSelect: () => { void logout(); } },
  ], [t, router]);

  const workspaceCard = (
    <div className="rounded-md bg-surface-2 p-3">
      <p className="truncate text-sm font-medium text-fg">{workspace.name}</p>
      <p className="mt-1 text-xs text-fg-subtle capitalize">{workspace.plan}</p>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-6 border-e border-line p-4 md:flex">
        <Link href="/app/video" aria-label="Xen Studio" className="px-2 py-1"><Logo /></Link>
        <nav aria-label={t('app.nav.label')} className="flex-1"><NavList /></nav>
        {workspaceCard}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-bg/85 px-4 backdrop-blur sm:px-6">
          <Drawer open={menu} onOpenChange={setMenu} title="Xen Studio" description={workspace.name}
            trigger={<Button variant="ghost" size="icon" className="md:hidden" aria-label={t('app.menu')}><Menu className="size-4" aria-hidden /></Button>}>
            <nav aria-label={t('app.nav.label')}><NavList onNavigate={() => setMenu(false)} /></nav>
          </Drawer>
          <button type="button" onClick={() => setPalette(true)}
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface-1 px-3 text-base text-fg-subtle transition-colors duration-150 hover:border-line-strong sm:max-w-sm">
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate text-start">{t('app.search')}</span>
            <kbd className="hidden font-mono text-xs sm:inline" aria-hidden>Ctrl K</kbd>
          </button>
          <div className="ms-auto flex items-center gap-1 sm:gap-2">
            <Tooltip content={t('app.credits')}>
              <Button asChild variant="secondary" size="sm">
                <Link href="/app/credits">
                  <Coins className="size-4 text-accent-text" aria-hidden />
                  <span className="font-mono tabular-nums">{credits === null ? '—' : new Intl.NumberFormat(locale).format(credits)}</span>
                  <span className="sr-only">{t('app.credits')}</span>
                </Link>
              </Button>
            </Tooltip>
            <NotificationBell />
            <ThemeToggle initial={theme} />
            <Tooltip content={`${user.name} · ${t('app.logout')}`}>
              <form action={logout}>
                <Button type="submit" variant="ghost" size="icon" aria-label={t('app.logout')}><LogOut className="size-4 rtl:-scale-x-100" aria-hidden /></Button>
              </form>
            </Tooltip>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      </div>

      <CommandPalette open={palette} onOpenChange={setPalette} items={items} placeholder={t('app.search')} />
    </div>
  );
}
