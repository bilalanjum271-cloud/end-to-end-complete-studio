import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <Link href="/" aria-label="Xen Studio" className="mb-8"><Logo /></Link>
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface-1 p-6 shadow-2 sm:p-8">{children}</div>
    </main>
  );
}
