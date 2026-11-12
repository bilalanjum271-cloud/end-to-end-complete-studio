import type { Metadata } from 'next';
import { XrStudioPage } from '@/components/xr/studio-page';

export const metadata: Metadata = { title: 'VR Studio' };

export default function Page() {
  return <XrStudioPage kind="vr" />;
}
