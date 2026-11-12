import { GATEWAY, accessToken } from '@/lib/server';

const FILES: Record<string, string> = { 'video.mp4': 'video', 'download.mp4': 'video?download=1', 'subtitles.srt': 'subtitles.srt', 'subtitles.vtt': 'subtitles.vtt', 'provenance.json': 'provenance' };

// Streams a render from the cell to the browser using the session cookie, forwarding Range so the player can seek.
// In production, renders are served from the CDN with signed URLs; this route is the local/dev path.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; version: string; file: string }> }) {
  const { id, version, file } = await params;
  const target = FILES[file];
  if (!target || !/^[0-9a-f-]{36}$/.test(id) || !/^\d{1,4}$/.test(version)) return new Response('Not found', { status: 404 });
  const token = await accessToken();
  if (!token) return new Response('Unauthorized', { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const res = await fetch(`${GATEWAY}/v1/projects/${id}/renders/${version}/${target}`, { headers, cache: 'no-store' });
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag', 'last-modified']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'private, max-age=3600');
  return new Response(res.body, { status: res.status, headers: out });
}
