'use client';
import Link from 'next/link';
import { CircleAlert } from 'lucide-react';
import { useActionState } from 'react';
import { Button, Input } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import { login, signup, type AuthState } from './actions';

export function AuthForm({ mode, next }: { mode: 'login' | 'signup'; next?: string }) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState<AuthState, FormData>(mode === 'login' ? login : signup, {});
  const invalid = state.error === 'auth.error.invalid';
  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state.error && !invalid ? (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-base text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{t(state.error)}
        </p>
      ) : null}
      {mode === 'signup' ? (
        <Input label={t('auth.name')} name="name" autoComplete="name" required defaultValue={state.values?.name}
          error={state.fields?.name ? t('auth.error.invalid') : undefined} />
      ) : null}
      <Input label={t('auth.email')} name="email" type="email" autoComplete="email" inputMode="email" required dir="ltr"
        defaultValue={state.values?.email} error={state.fields?.email ? t(invalid ? 'auth.error.invalid' : state.error!) : undefined} />
      <Input label={t('auth.password')} name="password" type="password" required dir="ltr"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        hint={mode === 'signup' ? t('auth.password.hint') : undefined}
        error={state.fields?.password ? t(mode === 'signup' ? 'auth.password.hint' : 'auth.error.invalid') : undefined} />
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        {t(mode === 'login' ? 'auth.login.submit' : 'auth.signup.submit')}
      </Button>
      <p className="text-center text-base text-fg-muted">
        {t(mode === 'login' ? 'auth.login.switch' : 'auth.signup.switch')}{' '}
        <Link href={mode === 'login' ? '/signup' : '/login'} className="font-medium text-accent-text underline-offset-4 hover:underline">
          {t(mode === 'login' ? 'auth.login.switch.link' : 'auth.signup.switch.link')}
        </Link>
      </p>
    </form>
  );
}
