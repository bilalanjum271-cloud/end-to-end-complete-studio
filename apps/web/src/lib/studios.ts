import { Box, Clapperboard, Glasses, LayoutDashboard, Layers, Wand2, type LucideIcon } from 'lucide-react';
import type { Key } from './i18n';

export interface Studio { slug: string; name: Key; body: Key; icon: LucideIcon; shortcut: string }

/** The six dashboards, in product order. */
export const STUDIOS: Studio[] = [
  { slug: 'video', name: 'studio.video', body: 'studio.video.body', icon: Clapperboard, shortcut: 'v' },
  { slug: 'animation', name: 'studio.animation', body: 'studio.animation.body', icon: Wand2, shortcut: 'a' },
  { slug: 'ar', name: 'studio.ar', body: 'studio.ar.body', icon: Box, shortcut: 'r' },
  { slug: 'vr', name: 'studio.vr', body: 'studio.vr.body', icon: Glasses, shortcut: 'e' },
  { slug: 'xr', name: 'studio.xr', body: 'studio.xr.body', icon: Layers, shortcut: 'x' },
  { slug: 'admin', name: 'studio.admin', body: 'studio.admin.body', icon: LayoutDashboard, shortcut: 'd' },
];
