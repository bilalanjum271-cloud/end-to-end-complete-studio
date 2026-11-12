-- Phase 3 (first slice): publish packaging, multi-format exports, notifications.

CREATE TABLE IF NOT EXISTS publish_packages (
  workspace_id   UUID NOT NULL,
  project_id     UUID NOT NULL,
  render_version INT  NOT NULL,
  titles         JSONB NOT NULL,          -- candidate titles, best first
  description    TEXT NOT NULL,
  tags           JSONB NOT NULL,
  thumbnail_key  TEXT,
  provider       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, render_version)
);

CREATE TABLE IF NOT EXISTS exports (
  workspace_id   UUID NOT NULL,
  project_id     UUID NOT NULL,
  render_version INT  NOT NULL,
  format         TEXT NOT NULL CHECK (format IN ('9:16','1:1')),   -- 16:9 is the render itself
  status         TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  storage_key    TEXT,
  error          TEXT,
  requested_by   UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, render_version, format)
);

CREATE TABLE IF NOT EXISTS notifications (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  user_id      UUID NOT NULL,
  kind         TEXT NOT NULL,             -- script_ready, video_ready, generation_failed, export_ready
  project_id   UUID,
  title        TEXT NOT NULL,
  link         TEXT NOT NULL DEFAULT '',
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS notifications_feed_idx ON notifications (workspace_id, user_id, created_at DESC);

-- Delivery log: one row per channel attempt (in-app, email, push).
CREATE TABLE IF NOT EXISTS notification_deliveries (
  workspace_id    UUID NOT NULL,
  notification_id UUID NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('in_app','email','push')),
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, notification_id, channel)
);
