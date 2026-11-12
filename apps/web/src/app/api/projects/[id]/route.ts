import { NextResponse } from 'next/server';
import { ApiError, accessToken, gw } from '@/lib/server';

// Polled by the project screen for live progress. (WebSocket push replaces polling when the realtime gateway lands.)
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    return NextResponse.json(await gw(`/v1/projects/${id}`, { token: await accessToken() }), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: 'unavailable' }, { status: err instanceof ApiError ? err.status : 502 });
  }
}
