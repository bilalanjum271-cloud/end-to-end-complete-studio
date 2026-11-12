'use server';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Key } from '@/lib/i18n';
import { ApiError, accessToken, gw } from '@/lib/server';

export interface ComposeState { error?: Key; prompt?: string }

export async function createProject(_: ComposeState, form: FormData): Promise<ComposeState> {
  const prompt = String(form.get('prompt') ?? '').trim();
  if (prompt.length < 10) return { error: 'video.error.prompt', prompt };
  let id: string;
  try {
    const res = await gw<{ id: string }>('/v1/projects', {
      method: 'POST', token: await accessToken(),
      // The key is minted when the form renders, so a double submit creates one project, not two.
      headers: { 'idempotency-key': String(form.get('idem') || randomUUID()) },
      body: { prompt, language: String(form.get('language') || 'en'), target_seconds: Number(form.get('seconds') || 30) },
    });
    id = res.id;
  } catch (err) {
    return { error: err instanceof ApiError && err.status === 403 ? 'video.error.plan' : 'video.error.generic', prompt };
  }
  redirect(`/app/video/${id}`);
}

async function post(id: string, path: string, body: unknown): Promise<{ ok: boolean }> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false };
  try {
    await gw(`/v1/projects/${id}/${path}`, { method: 'POST', token: await accessToken(), body });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export const approveScript = async (id: string, edits: { position: number; narration: string }[]) => post(id, 'script/approve', { edits });
export const regenerateScript = async (id: string, feedback: string) => post(id, 'script/regenerate', { feedback });
export const cancelProject = async (id: string) => post(id, 'cancel', {});
export const acceptVideo = async (id: string) => post(id, 'review', { action: 'accept' });
export const reviseScenes = async (id: string, positions: number[], feedback: string) => post(id, 'review', { action: 'revise', scene_positions: positions, feedback });

export async function requestExport(id: string, version: number, format: '9:16' | '1:1'): Promise<{ ok: boolean }> {
  if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(version)) return { ok: false };
  try {
    await gw(`/v1/projects/${id}/renders/${version}/exports`, { method: 'POST', token: await accessToken(), body: { format } });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function markNotificationsRead(): Promise<void> {
  await gw('/v1/notifications/read', { method: 'POST', token: await accessToken(), body: {} }).catch(() => undefined);
}
