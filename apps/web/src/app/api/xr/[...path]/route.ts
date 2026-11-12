import { GATEWAY, accessToken } from '@/lib/server';

// Session-cookie proxy for the XR editor (assets, scenes, export). Only /v1/xr/* paths are reachable.
const SAFE = /^(assets|scenes)(\/[0-9a-f-]{36}(\/(model\.glb|export\.glb))?)?$/;

async function forward(req: Request, path: string[]): Promise<Response> {
  const p = path.join('/');
  if (!SAFE.test(p)) return new Response('Not found', { status: 404 });
  const token = await accessToken();
  if (!token) return new Response('Unauthorized', { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  for (const h of ['content-type', 'idempotency-key']) { const v = req.headers.get(h); if (v) headers[h] = v; }
  const url = new URL(req.url);
  const res = await fetch(`${GATEWAY}/v1/xr/${p}${url.search}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text(), cache: 'no-store' });
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-disposition', 'cache-control']) { const v = res.headers.get(h); if (v) out.set(h, v); }
  return new Response(res.body, { status: res.status, headers: out });
}

type Ctx = { params: Promise<{ path: string[] }> };
export const GET = async (req: Request, { params }: Ctx) => forward(req, (await params).path);
export const POST = async (req: Request, { params }: Ctx) => forward(req, (await params).path);
export const PUT = async (req: Request, { params }: Ctx) => forward(req, (await params).path);
