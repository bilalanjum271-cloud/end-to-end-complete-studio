import { NextResponse } from 'next/server';
import { ApiError, accessToken, gw } from '@/lib/server';

export async function GET() {
  try {
    return NextResponse.json(await gw('/v1/notifications', { token: await accessToken() }), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ unread: 0, notifications: [] }, { status: err instanceof ApiError ? err.status : 502 });
  }
}
