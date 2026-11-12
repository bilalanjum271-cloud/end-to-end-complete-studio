-- Phase 2: Script-to-Video. Tables follow the "Database schema" section of the Master Stack
-- document. Every table leads its primary key with workspace_id (tenant isolation, partitioning).

CREATE TABLE IF NOT EXISTS projects (
  workspace_id    UUID NOT NULL,
  id              UUID NOT NULL,
  dashboard_type  TEXT NOT NULL CHECK (dashboard_type IN ('video','animation','ar','vr','xr')),
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  language        TEXT NOT NULL DEFAULT 'en',
  target_seconds  INT  NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('moderating','blocked','insufficient_credits','writing_script',
                    'awaiting_approval','generating','in_review','completed','failed','cancelled')),
  error           TEXT,
  estimate_credits BIGINT NOT NULL,
  reservation_id  UUID,
  script_version  INT NOT NULL DEFAULT 0,
  render_version  INT NOT NULL DEFAULT 0,
  revision_round  INT NOT NULL DEFAULT 0,
  max_revisions   INT NOT NULL,           -- snapshot of the plan limit when the project was created
  watermark       BOOL NOT NULL,
  created_by      UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_idem_key ON projects (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS projects_recent_idx ON projects (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scripts (
  workspace_id UUID NOT NULL,
  project_id   UUID NOT NULL,
  version      INT  NOT NULL,
  title        TEXT NOT NULL,
  research     JSONB NOT NULL DEFAULT '[]',     -- cited notes from the research step
  status       TEXT NOT NULL CHECK (status IN ('draft','approved','rejected')),
  approved_by  UUID,
  provider     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, version)
);

CREATE TABLE IF NOT EXISTS scenes (
  workspace_id   UUID NOT NULL,
  project_id     UUID NOT NULL,
  script_version INT  NOT NULL,
  position       INT  NOT NULL,
  narration      TEXT NOT NULL,
  visual_prompt  TEXT NOT NULL DEFAULT '',
  style_profile_id UUID,
  seed           BIGINT NOT NULL DEFAULT 0,
  voice_status   TEXT NOT NULL DEFAULT 'queued' CHECK (voice_status IN ('queued','running','succeeded','failed')),
  visual_status  TEXT NOT NULL DEFAULT 'queued' CHECK (visual_status IN ('queued','running','succeeded','failed')),
  duration_ms    INT NOT NULL DEFAULT 0,
  voice_key      TEXT,
  visual_key     TEXT,
  qc_score       REAL,
  generation     INT NOT NULL DEFAULT 0,          -- bumps each time the scene is regenerated
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, script_version, position)
);

CREATE TABLE IF NOT EXISTS jobs (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  project_id   UUID NOT NULL,
  scene_position INT,
  type         TEXT NOT NULL,                     -- moderation, research, script, voice, visual, assembly, qc
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  cost_microusd BIGINT NOT NULL DEFAULT 0,
  attempts     INT NOT NULL DEFAULT 1,
  duration_ms  INT NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs (workspace_id, project_id);

CREATE TABLE IF NOT EXISTS renders (
  workspace_id UUID NOT NULL,
  project_id   UUID NOT NULL,
  version      INT  NOT NULL,
  format       TEXT NOT NULL DEFAULT '16:9',
  storage_key  TEXT NOT NULL,
  subtitles_key TEXT NOT NULL,
  provenance_key TEXT NOT NULL,
  duration_ms  INT NOT NULL,
  qc_score     REAL NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, version)
);

CREATE TABLE IF NOT EXISTS revisions (
  workspace_id UUID NOT NULL,
  project_id   UUID NOT NULL,
  round_number INT  NOT NULL,
  feedback     TEXT NOT NULL DEFAULT '',
  scene_ids    JSONB NOT NULL,                    -- scene positions regenerated in this round
  requested_by UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, round_number)
);

CREATE TABLE IF NOT EXISTS moderation_events (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  subject_type TEXT NOT NULL,                     -- prompt, script, render
  subject_id   TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('allowed','blocked','flagged')),
  reason       TEXT NOT NULL DEFAULT '',
  provider     TEXT NOT NULL,
  reviewer_id  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
