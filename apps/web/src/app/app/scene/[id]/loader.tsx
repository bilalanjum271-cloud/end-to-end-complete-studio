'use client';
import dynamic from 'next/dynamic';
import { Skeleton } from '@xen-studio/ui';
import type { XrAsset, XrScene } from '@/components/xr/types';

// three.js is client-only and large: it loads with this route, never in the shared bundle.
const SceneEditor = dynamic(() => import('@/components/xr/scene-editor').then((m) => m.SceneEditor), {
  ssr: false, loading: () => <Skeleton className="h-[70dvh] w-full" />,
});

export function EditorLoader(props: { scene: XrScene; assets: XrAsset[] }) {
  return <SceneEditor {...props} />;
}
