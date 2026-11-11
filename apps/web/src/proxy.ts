// Next.js proxy (middleware): gates /app and keeps the session fresh.
// Tokens live in httpOnly cookies; the web tier itself holds no session state.
import { NextResponse, type NextRequest } from 'next/server';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const AT = 'xs_at';
const RT = 'xs_rt';
const secure = process.env.NODE_ENV === 'production';

function expiresSoon(jwt: string | undefined): boolean {
  if (!jwt) return true;
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    return true;
  }
}

export async function proxy(req: NextRequest) {
  const access = req.cookies.get(AT)?.value;
  const refresh = req.cookies.get(RT)?.value;
  const { pathname } = req.nextUrl;
  const authPage = pathname === '/login' || pathname === '/signup';

  if (!expiresSoon(access)) {
    return authPage ? NextResponse.redirect(new URL('/app/video', req.url)) : NextResponse.next();
  }
  if (refresh) {
    try {
      const res = await fetch(`${GATEWAY}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '127.0.0.1' },
        body: JSON.stringify({ refresh_token: refresh }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
        // Make the new token visible to this request's server components, and persist it for the browser.
        const headers = new Headers(req.headers);
        const others = req.cookies.getAll().filter((c) => c.name !== AT && c.name !== RT).map((c) => `${c.name}=${c.value}`);
        headers.set('cookie', [...others, `${AT}=${t.access_token}`, `${RT}=${t.refresh_token}`].join('; '));
        const out = authPage ? NextResponse.redirect(new URL('/app/video', req.url)) : NextResponse.next({ request: { headers } });
        out.cookies.set(AT, t.access_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: t.expires_in });
        out.cookies.set(RT, t.refresh_token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30 });
        return out;
      }
    } catch {
      // gateway unreachable: fall through and treat as signed out for this request
    }
  }
  if (authPage) return NextResponse.next();
  const login = new URL('/login', req.url);
  login.searchParams.set('next', pathname);
  const out = NextResponse.redirect(login);
  out.cookies.delete(AT);
  out.cookies.delete(RT);
  return out;
}

export const config = { matcher: ['/app/:path*', '/login', '/signup'] };
