'use client';
import { Languages, Moon, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Select } from '@xen-studio/ui';
import { LOCALES, LOCALE_NAMES, type Locale } from '@/lib/i18n';
import { useI18n } from './i18n-provider';

const YEAR = 60 * 60 * 24 * 365;
const setCookie = (name: string, value: string) => { document.cookie = `${name}=${value}; path=/; max-age=${YEAR}; samesite=lax`; };

export function toggleTheme(): 'dark' | 'light' {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  setCookie('xs_theme', next);
  return next;
}

export function ThemeToggle({ initial }: { initial: 'dark' | 'light' }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState(initial);
  return (
    <Button variant="ghost" size="icon" aria-label={t('app.theme.toggle')} title={t('app.theme.toggle')} onClick={() => setTheme(toggleTheme())}>
      {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </Button>
  );
}

export function LocaleSelect() {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <div className="flex items-center gap-2">
      <Languages className="size-4 text-fg-subtle" aria-hidden />
      <Select label={t('footer.language')} hideLabel value={locale} className="h-8 min-w-28 text-sm"
        options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
        onValueChange={(v) => { setCookie('xs_locale', v as Locale); router.refresh(); }} />
    </div>
  );
}
