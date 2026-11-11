import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@xen-studio/ui'],
  poweredByHeader: false,
  // The Docker image sets NEXT_OUTPUT=standalone; `next start` is used for local production runs.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  experimental: { optimizePackageImports: ['lucide-react', '@xen-studio/ui'] },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};
export default config;
