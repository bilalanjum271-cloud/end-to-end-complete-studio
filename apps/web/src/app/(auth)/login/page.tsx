import type { Metadata } from 'next';
import { prefs } from '@/lib/server';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Log in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { t } = await prefs();
  const { next } = await searchParams;
  return (
    <>
      <h1 className="mb-8 text-lg font-semibold text-fg">{t('auth.login.title')}</h1>
      <AuthForm mode="login" next={next} />
    </>
  );
}
