-- Phase 4: admin review of moderation decisions.
ALTER TABLE moderation_events ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'none'
  CHECK (review_status IN ('none','upheld','overturned'));
ALTER TABLE moderation_events ADD COLUMN IF NOT EXISTS review_note TEXT;
CREATE INDEX IF NOT EXISTS moderation_queue_idx ON moderation_events (decision, review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at);
CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at);
