'use server';
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
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

const LANG = /^[a-z]{2}$/;

export async function requestLocalization(id: string, language: string): Promise<{ ok: boolean }> {
  if (!/^[0-9a-f-]{36}$/.test(id) || !LANG.test(language)) return { ok: false };
  try {
    await gw(`/v1/projects/${id}/localizations`, { method: 'POST', token: await accessToken(), body: { language } });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function approveLocalization(id: string, language: string, lines: string[]): Promise<{ ok: boolean; status?: number }> {
  if (!/^[0-9a-f-]{36}$/.test(id) || !LANG.test(language)) return { ok: false };
  try {
    await gw(`/v1/projects/${id}/localizations/${language}/approve`, { method: 'POST', token: await accessToken(), body: { lines } });
    return { ok: true };
  } catch (err) {
    return { ok: false, status: err instanceof ApiError ? err.status : 500 };
  }
}

export async function addGlossaryTerm(_: { error?: string }, form: FormData): Promise<{ error?: string; ok?: number }> {
  const body = { language: String(form.get('language') ?? ''), source: String(form.get('source') ?? '').trim(), target: String(form.get('target') ?? '').trim() };
  if (!LANG.test(body.language) || !body.source || !body.target) return { error: 'auth.error.invalid' };
  try {
    await gw('/v1/glossary', { method: 'POST', token: await accessToken(), body });
  } catch {
    return { error: 'project.action.error' };
  }
  revalidatePath('/app/video/glossary');
  return { ok: Date.now() };
}

export async function deleteGlossaryTerm(id: string): Promise<{ ok: boolean }> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false };
  try {
    await gw(`/v1/glossary/${id}`, { method: 'DELETE', token: await accessToken() });
  } catch {
    return { ok: false };
  }
  revalidatePath('/app/video/glossary');
  return { ok: true };
}

export interface AnimState { error?: Key; values?: Record<string, string> }

export async function createAnimation(_: AnimState, form: FormData): Promise<AnimState> {
  const mode = form.get('mode') === 'link' ? 'link' : 'text';
  const values = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const text = String(form.get('text') ?? '').trim();
  const url = String(form.get('url') ?? '').trim();
  if (mode === 'text' && text.length < 10) return { error: 'video.error.prompt', values };
  if (mode === 'link' && !/^https?:\/\/\S+\.\S+/.test(url)) return { error: 'auth.error.invalid', values };
  if (mode === 'link' && form.get('rights') !== 'on') return { error: 'anim.rights.required', values };
  let characters: { name: string; description: string }[] = [];
  try { characters = JSON.parse(String(form.get('characters') || '[]')); } catch { characters = []; }
  let id: string;
  try {
    const res = await gw<{ id: string }>('/v1/projects', {
      method: 'POST', token: await accessToken(), headers: { 'idempotency-key': String(form.get('idem') || randomUUID()) },
      body: {
        dashboard_type: 'animation', source_type: mode, prompt: mode === 'text' ? text : '', source_url: mode === 'link' ? url : null,
        rights_attested: form.get('rights') === 'on', language: String(form.get('language') || 'en'), target_seconds: Number(form.get('seconds') || 30),
        style_profile: String(form.get('style') || '') || null, music: String(form.get('music') || 'none'), characters: characters.filter((c) => c.name.trim()),
      },
    });
    id = res.id;
  } catch (err) {
    return { error: err instanceof ApiError && err.status === 403 ? 'video.error.plan' : 'video.error.generic', values };
  }
  redirect(`/app/video/${id}`);
}
