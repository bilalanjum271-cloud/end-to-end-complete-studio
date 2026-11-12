'use server';
import { createHmac } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, accessToken, gw } from '@/lib/server';

const UUID = /^[0-9a-f-]{36}$/;
const ROLES = ['admin', 'editor', 'viewer'];

export async function addMember(_: { error?: string; ok?: number }, form: FormData): Promise<{ error?: string; ok?: number }> {
  const ws = String(form.get('ws') ?? '');
  const email = String(form.get('email') ?? '').trim();
  const role = String(form.get('role') ?? 'editor');
  if (!UUID.test(ws) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !ROLES.includes(role)) return { error: 'Enter a valid email.' };
  try {
    await gw(`/v1/workspaces/${ws}/members`, { method: 'POST', token: await accessToken(), body: { email, role } });
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Could not add the member.' };
  }
  revalidatePath('/app/settings');
  return { ok: Date.now() };
}

export async function changeRole(ws: string, user: string, role: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(ws) || !UUID.test(user) || ![...ROLES, 'owner'].includes(role)) return { ok: false };
  try {
    await gw(`/v1/workspaces/${ws}/members/${user}`, { method: 'PATCH', token: await accessToken(), body: { role } });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : undefined };
  }
  revalidatePath('/app/settings');
  return { ok: true };
}

export async function removeMember(ws: string, user: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(ws) || !UUID.test(user)) return { ok: false };
  try {
    await gw(`/v1/workspaces/${ws}/members/${user}`, { method: 'DELETE', token: await accessToken() });
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : undefined };
  }
  revalidatePath('/app/settings');
  return { ok: true };
}

export async function startCheckout(plan: 'pro' | 'studio'): Promise<{ error?: string }> {
  let url: string;
  try {
    url = (await gw<{ url: string }>('/v1/billing/checkout', { method: 'POST', token: await accessToken(), body: { plan_id: plan } })).url;
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : 'Checkout is unavailable right now.' };
  }
  redirect(url);
}

/**
 * Local stand-in for Stripe: posts the same kind of signed webhook Stripe would send, through the public gateway route.
 * Disabled whenever real Stripe keys are configured (the identity service then rejects the mock signature anyway).
 */
export async function completeMockCheckout(form: FormData): Promise<void> {
  const ws = String(form.get('workspace') ?? '');
  const plan = String(form.get('plan') ?? '');
  const session = String(form.get('session') ?? '');
  if (!UUID.test(ws) || !['pro', 'studio'].includes(plan) || !/^mock_cs_[0-9a-f-]{36}$/.test(session)) redirect('/app/settings?billing=canceled');
  const secret = `mock-billing:${process.env.INTERNAL_SERVICE_TOKEN ?? ''}`;
  const raw = JSON.stringify({ id: `evt_${session}`, type: 'paid', workspace_id: ws, plan_id: plan, subscription: `sub_${session}` });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  await gw('/v1/billing/webhook', { method: 'POST', body: JSON.parse(raw), headers: { 'stripe-signature': sig } }).catch(() => undefined);
  redirect('/app/settings?billing=success');
}
