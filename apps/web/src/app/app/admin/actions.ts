'use server';
import { revalidatePath } from 'next/cache';
import { accessToken, gw } from '@/lib/server';

const UUID = /^[0-9a-f-]{36}$/;

export async function reviewModeration(ws: string, id: string, status: 'upheld' | 'overturned'): Promise<{ ok: boolean }> {
  if (!UUID.test(ws) || !UUID.test(id)) return { ok: false };
  try {
    await gw(`/v1/admin/moderation/${ws}/${id}`, { method: 'POST', token: await accessToken(), body: { status, note: '' } });
  } catch {
    return { ok: false };
  }
  revalidatePath('/app/admin');
  return { ok: true };
}

export async function setUserStatus(id: string, status: 'active' | 'suspended', reason: string): Promise<{ ok: boolean }> {
  if (!UUID.test(id) || reason.trim().length < 3) return { ok: false };
  try {
    await gw(`/v1/admin/users/${id}/status`, { method: 'POST', token: await accessToken(), body: { status, reason: reason.trim() } });
  } catch {
    return { ok: false };
  }
  revalidatePath('/app/admin');
  return { ok: true };
}
