'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Key } from '@/lib/i18n';
import { ApiError, AT, RT, gw } from '@/lib/server';

export interface AuthState { error?: Key; fields?: { name?: boolean; email?: boolean; password?: boolean }; values?: { name?: string; email?: string } }
interface Tokens { access_token: string; refresh_token: string; expires_in: number }

const secure = process.env.NODE_ENV === 'production';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function startSession(t: Tokens) {
  const jar = await cookies();
  jar.set(AT, t.access_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: t.expires_in });
  jar.set(RT, t.refresh_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30 });
}

function failure(err: unknown, values: AuthState['values'], onConflict: Key): AuthState {
  if (err instanceof ApiError) {
    if (err.status === 401) return { error: 'auth.error.credentials', values };
    if (err.status === 409) return { error: onConflict, values, fields: { email: true } };
    if (err.status === 429) return { error: 'auth.error.rate', values };
    if (err.status === 400) return { error: 'auth.error.invalid', values };
  }
  return { error: 'auth.error.unavailable', values };
}

// Only same-site relative paths are accepted as a post-login destination.
const safeNext = (v: FormDataEntryValue | null) => (typeof v === 'string' && /^\/app(\/[\w\-/]*)?$/.test(v) ? v : '/app/video');

export async function login(_: AuthState, form: FormData): Promise<AuthState> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const values = { email };
  if (!EMAIL.test(email) || !password) return { error: 'auth.error.invalid', values, fields: { email: !EMAIL.test(email), password: !password } };
  try {
    await startSession(await gw<Tokens>('/v1/auth/login', { method: 'POST', body: { email, password } }));
  } catch (err) {
    return failure(err, values, 'auth.error.credentials');
  }
  redirect(safeNext(form.get('next')));
}

export async function signup(_: AuthState, form: FormData): Promise<AuthState> {
  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const values = { name, email };
  const fields = { name: !name, email: !EMAIL.test(email), password: password.length < 10 };
  if (fields.name || fields.email || fields.password) return { error: 'auth.error.invalid', values, fields };
  try {
    await startSession(await gw<Tokens>('/v1/auth/signup', { method: 'POST', body: { name, email, password } }));
  } catch (err) {
    return failure(err, values, 'auth.error.exists');
  }
  redirect('/app/video');
}

export async function logout() {
  const jar = await cookies();
  const refresh = jar.get(RT)?.value;
  if (refresh) await gw('/v1/auth/logout', { method: 'POST', body: { refresh_token: refresh } }).catch(() => undefined);
  jar.delete(AT);
  jar.delete(RT);
  redirect('/login');
}
