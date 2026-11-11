'use client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Key, Locale, T } from '@/lib/i18n';

const Ctx = createContext<{ t: T; locale: Locale; dir: 'ltr' | 'rtl' }>({ t: (k) => k, locale: 'en', dir: 'ltr' });
export const useI18n = () => useContext(Ctx);

export function I18nProvider({ dict, locale, dir, children }: { dict: Record<Key, string>; locale: Locale; dir: 'ltr' | 'rtl'; children: ReactNode }) {
  const value = useMemo(() => {
    const t: T = (key, vars) => {
      let s = dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    return { t, locale, dir };
  }, [dict, locale, dir]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
