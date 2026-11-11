import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ApiError, accessToken, gw, prefs, type Balance, type Me } from '@/lib/server';
import { Shell } from './shell';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const token = await accessToken();
  if (!token) redirect('/login');
  const { theme } = await prefs();
  let me: Me;
  try {
    me = await gw<Me>('/v1/me', { token });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) redirect('/login');
    throw err;
  }
  // Credits are secondary: if the ledger is slow or down, the shell still renders (graceful degradation).
  const credits = await gw<Balance>('/v1/credits', { token }).then((b) => b.available).catch(() => null);
  const ws = me.workspaces.find((w) => w.id === me.current_workspace_id) ?? me.workspaces[0];
  return (
    <Shell user={{ name: me.user.name, email: me.user.email }} workspace={{ name: ws?.name ?? '', plan: ws?.plan_id ?? '' }} credits={credits} theme={theme}>
      {children}
    </Shell>
  );
}
