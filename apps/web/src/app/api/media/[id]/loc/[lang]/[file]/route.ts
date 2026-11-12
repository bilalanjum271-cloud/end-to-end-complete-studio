import { GATEWAY, accessToken } from '@/lib/server';

const FILES = new Set(['video.mp4', 'subtitles.srt', 'subtitles.vtt']);

export async function GET(req: Request, { params }: { params: Promise<{ id: string; lang: string; file: string }> }) {
  const { id, lang, file } = await params;
  if (!FILES.has(file) || !/^[0-9a-f-]{36}$/.test(id) || !/^[a-z]{2}$/.test(lang)) return new Response('Not found', { status: 404 });
  const token = await accessToken();
  if (!token) return new Response('Unauthorized', { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const res = await fetch(`${GATEWAY}/v1/projects/${id}/localizations/${lang}/${file}`, { headers, cache: 'no-store' });
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  if (file === 'video.mp4') out.set('content-disposition', `attachment; filename="xen-studio-${id.slice(0, 8)}-${lang}.mp4"`);
  return new Response(res.body, { status: res.status, headers: out });
}
