-- Phase 3: localization with glossary and human review.

CREATE TABLE IF NOT EXISTS glossary_terms (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  language     TEXT NOT NULL,           -- target language this rule applies to
  source       TEXT NOT NULL,           -- term as written in the source script
  target       TEXT NOT NULL,           -- required rendering (same as source = "do not translate")
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS glossary_unique ON glossary_terms (workspace_id, language, lower(source));

CREATE TABLE IF NOT EXISTS localizations (
  workspace_id    UUID NOT NULL,
  project_id      UUID NOT NULL,
  language        TEXT NOT NULL,
  render_version  INT  NOT NULL,        -- the source render whose visuals are reused
  status          TEXT NOT NULL CHECK (status IN ('translating','in_review','rendering','ready','failed')),
  source_lines    JSONB NOT NULL DEFAULT '[]',
  lines           JSONB NOT NULL DEFAULT '[]',
  provider        TEXT NOT NULL DEFAULT '',
  reviewed_by     UUID,
  credits         BIGINT NOT NULL DEFAULT 0,
  reservation_id  UUID,
  storage_key     TEXT,
  subtitles_key   TEXT,
  error           TEXT,
  requested_by    UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, language)
);
CREATE INDEX IF NOT EXISTS localizations_queue_idx ON localizations (workspace_id, status, updated_at);
