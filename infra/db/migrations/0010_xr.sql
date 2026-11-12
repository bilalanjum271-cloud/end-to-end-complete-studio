-- Phase 7: shared 3D asset pipeline and XR scenes (AR / VR / MR-XR studios).
CREATE TABLE IF NOT EXISTS xr_assets (
  workspace_id  UUID NOT NULL,
  id            UUID NOT NULL,
  prompt        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','generating','ready','failed','blocked')),
  storage_key   TEXT,
  provider      TEXT NOT NULL DEFAULT '',
  triangles     INT NOT NULL DEFAULT 0,
  bounds        JSONB,                 -- {"min":[x,y,z],"max":[x,y,z]} in metres
  credits       BIGINT NOT NULL DEFAULT 0,
  reservation_id UUID,
  error         TEXT,
  created_by    UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS xr_assets_idem ON xr_assets (workspace_id, idempotency_key);

CREATE TABLE IF NOT EXISTS xr_scenes (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('ar','vr','xr')),
  name         TEXT NOT NULL,
  scene        JSONB NOT NULL DEFAULT '{"nodes":[],"environment":"studio"}',
  version      INT NOT NULL DEFAULT 1,  -- optimistic concurrency for autosave from several tabs
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
