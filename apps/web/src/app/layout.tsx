import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';
import { ToastProvider, TooltipProvider } from '@xen-studio/ui';
import { I18nProvider } from '@/components/i18n-provider';
import { DICTIONARIES } from '@/lib/i18n';
import { prefs } from '@/lib/server';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Xen Studio: AI video, animation and XR studio', template: '%s · Xen Studio' },
  description: 'Write a prompt, approve the script, and get a finished video with native-quality narration. Animation, AR, VR and XR in the same workspace.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};
export const viewport: Viewport = { themeColor: [{ media: '(prefers-color-scheme: dark)', color: '#0a0b0d' }], width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, dir, theme, t } = await prefs();
  return (
    <html lang={locale} dir={dir} data-theme={theme} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-surface-3 focus:px-4 focus:py-2">
          {t('nav.skip')}
        </a>
        <I18nProvider dict={DICTIONARIES[locale]} locale={locale} dir={dir}>
          <TooltipProvider delayDuration={300}>
            <ToastProvider>{children}</ToastProvider>
          </TooltipProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
