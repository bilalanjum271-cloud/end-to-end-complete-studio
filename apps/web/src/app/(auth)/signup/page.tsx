import type { Metadata } from 'next';
import { prefs } from '@/lib/server';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Create your account' };

export default async function Signup() {
  const { t } = await prefs();
  return (
    <>
      <h1 className="text-lg font-semibold text-fg">{t('auth.signup.title')}</h1>
      <p className="mt-2 mb-8 text-base text-fg-muted">{t('auth.signup.body')}</p>
      <AuthForm mode="signup" />
    </>
  );
}
