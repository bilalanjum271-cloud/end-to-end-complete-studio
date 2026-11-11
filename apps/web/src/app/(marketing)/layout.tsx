import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@xen-studio/ui';
import { Logo } from '@/components/logo';
import { LocaleSelect, ThemeToggle } from '@/components/prefs';
import { prefs } from '@/lib/server';

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const { t, theme } = await prefs();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <nav aria-label={t('nav.product')} className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Xen Studio"><Logo /></Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex"><Link href="/pricing">{t('nav.pricing')}</Link></Button>
            <Button asChild variant="ghost" size="sm"><Link href="/login">{t('nav.login')}</Link></Button>
            <Button asChild variant="primary" size="sm"><Link href="/signup">{t('nav.start')}</Link></Button>
          </div>
        </nav>
      </header>
      <main id="main" className="flex-1">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex flex-col gap-2">
            <Logo />
            <p className="text-sm text-fg-subtle">© {new Date().getFullYear()} Xen Studio. {t('footer.rights')}</p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/pricing" className="text-sm text-fg-muted hover:text-fg sm:hidden">{t('nav.pricing')}</Link>
            <LocaleSelect />
            <ThemeToggle initial={theme} />
          </div>
        </div>
      </footer>
    </div>
  );
}
