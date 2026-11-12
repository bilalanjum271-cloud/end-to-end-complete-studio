-- Phase 5: Animation Studio. Rights records for link ingestion, consent records for voice/face
-- cloning, style profiles, and per-project animation settings.

CREATE TABLE IF NOT EXISTS rights_records (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  source_url   TEXT NOT NULL,
  attestation  TEXT NOT NULL,          -- the exact statement the user confirmed
  user_id      UUID NOT NULL,
  ip           TEXT,
  check_result TEXT NOT NULL DEFAULT 'pending' CHECK (check_result IN ('pending','clear','needs_review','rejected')),
  check_reason TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS consent_records (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('voice_clone','face_clone')),
  subject_name TEXT NOT NULL,          -- the person whose voice or face is cloned
  statement    TEXT NOT NULL,
  evidence_key TEXT,                   -- signed release or recorded consent clip
  granted_by   UUID NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS style_profiles (
  workspace_id UUID NOT NULL,          -- 00000000-0000-0000-0000-000000000000 = built-in preset
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  look         TEXT NOT NULL,          -- appended to every visual prompt
  palette      JSONB NOT NULL,         -- hex colors, first is the background
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
INSERT INTO style_profiles (workspace_id, id, name, look, palette) VALUES
  ('00000000-0000-0000-0000-000000000000', 'flat', 'Flat 2D', 'flat 2D vector animation, clean shapes, soft shadows', '["0x14213d","0xfca311","0xe5e5e5"]'),
  ('00000000-0000-0000-0000-000000000000', 'paper', 'Paper cut-out', 'layered paper cut-out animation, visible texture, warm light', '["0x3d2c2e","0xe9c46a","0xf4a261"]'),
  ('00000000-0000-0000-0000-000000000000', 'watercolor', 'Watercolor', 'hand-painted watercolor animation, gentle bleeds, pastel tones', '["0x22333b","0x7fb4ff","0xc6dabf"]'),
  ('00000000-0000-0000-0000-000000000000', 'noir', 'Ink noir', 'high-contrast ink illustration, deep shadows, single accent color', '["0x0b0b0c","0xf2706b","0xeceef1"]')
ON CONFLICT DO NOTHING;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'prompt' CHECK (source_type IN ('prompt','text','link'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rights_record_id UUID;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS style_profile TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS characters JSONB NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS music TEXT NOT NULL DEFAULT 'none' CHECK (music IN ('none','calm','uplifting','tense'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS voice TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS consent_record_id UUID;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('moderating','blocked','insufficient_credits','ingesting','rights_review',
  'writing_script','awaiting_approval','generating','in_review','completed','failed','cancelled'));
