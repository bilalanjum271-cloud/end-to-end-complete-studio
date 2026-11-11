import 'server-only';
import { cookies, headers } from 'next/headers';
import { dirOf, isLocale, translator, type Locale } from './i18n';

export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export const AT = 'xs_at';
export const RT = 'xs_rt';

export async function prefs() {
  const jar = await cookies();
  const raw = jar.get('xs_locale')?.value;
  let locale: Locale = 'en';
  if (isLocale(raw)) locale = raw;
  else {
    const accept = (await headers()).get('accept-language') ?? '';
    const first = accept.split(',')[0]?.slice(0, 2);
    if (isLocale(first)) locale = first;
  }
  const theme = jar.get('xs_theme')?.value === 'light' ? 'light' : 'dark';
  return { locale, dir: dirOf(locale), theme, t: translator(locale) } as const;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Calls the cell gateway from the server. Forwards the caller's IP so per-IP limits apply to the real client. */
export async function gw<T>(path: string, init: { method?: string; body?: unknown; token?: string; revalidate?: number } = {}): Promise<T> {
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || h.get('x-real-ip') || '127.0.0.1';
  let res: Response;
  try {
    res = await fetch(GATEWAY + path, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json', 'x-forwarded-for': ip,
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(8000),
      ...(init.revalidate ? { next: { revalidate: init.revalidate } } : { cache: 'no-store' as const }),
    });
  } catch {
    throw new ApiError(503, 'unavailable', 'gateway unreachable');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.error?.message ?? (Array.isArray(data?.message) ? data.message.join('; ') : data?.message) ?? res.statusText;
    throw new ApiError(res.status, data?.error?.code ?? String(res.status), msg);
  }
  return data as T;
}

export async function accessToken(): Promise<string | undefined> {
  return (await cookies()).get(AT)?.value;
}

export interface Me {
  user: { id: string; email: string; name: string; platform_role: string };
  current_workspace_id: string;
  role: string;
  workspaces: { id: string; name: string; plan_id: string; role: string }[];
}
export interface Balance { available: number; reserved: number; spent: number }
export interface Plan {
  id: string; name: string; monthly_price_cents: number; monthly_credits: number; max_revision_rounds: number;
  max_video_seconds: number; max_concurrent_jobs: number; queue_priority: number; max_seats: number; watermark: boolean;
}

// Used when the gateway is unreachable at build or request time, so pricing always renders. Mirrors scripts/seed.mjs.
export const FALLBACK_PLANS: Plan[] = [
  { id: 'starter', name: 'Starter', monthly_price_cents: 0, monthly_credits: 300, max_revision_rounds: 1, max_video_seconds: 60, max_concurrent_jobs: 1, queue_priority: 10, max_seats: 1, watermark: true },
  { id: 'creator', name: 'Creator', monthly_price_cents: 2900, monthly_credits: 3000, max_revision_rounds: 3, max_video_seconds: 600, max_concurrent_jobs: 3, queue_priority: 50, max_seats: 3, watermark: false },
  { id: 'studio', name: 'Studio', monthly_price_cents: 9900, monthly_credits: 12000, max_revision_rounds: 5, max_video_seconds: 1800, max_concurrent_jobs: 10, queue_priority: 90, max_seats: 15, watermark: false },
];
