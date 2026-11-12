export type ProjectStatus = 'moderating' | 'blocked' | 'insufficient_credits' | 'writing_script' | 'awaiting_approval' | 'generating' | 'in_review' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ProjectSummary {
  id: string; title: string; prompt: string; language: string; target_seconds: number; status: ProjectStatus; error: string | null;
  estimate_credits: number; script_version: number; render_version: number; revision_round: number; max_revisions: number; created_at: string;
}
export interface Scene { position: number; narration: string; visual_prompt: string; voice_status: StepStatus; visual_status: StepStatus; duration_ms: number; generation: number }
export interface Project extends ProjectSummary {
  script: { version: number; title: string; status: string; research: { note: string; source: string }[] } | null;
  scenes: Scene[];
  renders: { version: number; duration_ms: number; qc_score: number }[];
  progress: { percent: number; steps_done: number; steps_total: number; estimated_seconds_left: number };
  revisions_left: number;
  package: { titles: string[]; description: string; tags: string[]; has_thumbnail: boolean } | null;
  exports: { format: '9:16' | '1:1'; status: 'queued' | 'running' | 'succeeded' | 'failed' }[];
}
export interface Notice { id: string; kind: string; title: string; link: string; read: boolean; created_at: string }
export interface Meta { languages: string[]; max_video_seconds: number; max_revisions: number; credits_per_minute: number }

export const ACTIVE: ProjectStatus[] = ['moderating', 'writing_script', 'generating'];
export const badgeFor: Record<ProjectStatus, 'queued' | 'running' | 'succeeded' | 'failed' | 'review' | 'draft'> = {
  moderating: 'running', writing_script: 'running', generating: 'running', awaiting_approval: 'review', in_review: 'review',
  completed: 'succeeded', failed: 'failed', blocked: 'failed', insufficient_credits: 'failed', cancelled: 'draft',
};
