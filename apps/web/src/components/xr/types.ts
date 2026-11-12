export type XrKind = 'ar' | 'vr' | 'xr';
export interface XrAsset { id: string; prompt: string; status: 'queued' | 'generating' | 'ready' | 'failed' | 'blocked'; triangles: number; error: string | null }
export interface XrNode { id: string; asset_id: string; position: [number, number, number]; rotation: [number, number, number]; scale: number;
  audio?: { kind: 'ambient' | 'music' | 'voice'; volume: number; ref_distance: number } | null }
export interface XrSceneDoc { nodes: XrNode[]; environment: 'studio' | 'outdoor' | 'night' | 'passthrough' }
export interface XrScene { id: string; kind: XrKind; name: string; scene: XrSceneDoc; version: number; updated_at: string }
