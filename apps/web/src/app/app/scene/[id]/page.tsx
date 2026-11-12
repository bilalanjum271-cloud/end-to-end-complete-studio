import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { XrAsset, XrScene } from '@/components/xr/types';
import { ApiError, accessToken, gw } from '@/lib/server';
import { EditorLoader } from './loader';

export const metadata: Metadata = { title: 'Scene editor' };

export default async function SceneEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await accessToken();
  let scene: XrScene, assets: XrAsset[];
  try {
    [scene, { assets }] = await Promise.all([gw<XrScene>(`/v1/xr/scenes/${id}`, { token }), gw<{ assets: XrAsset[] }>('/v1/xr/assets', { token })]);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
  return <EditorLoader scene={scene} assets={assets.filter((a) => a.status === 'ready')} />;
}
