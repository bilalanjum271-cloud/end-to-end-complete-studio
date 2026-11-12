-- Aligns the foundation schema with the "Complete Master Stack" document (docs/source):
--   * ledger table is named credit_transactions with fields type / balance_after
--   * plans carry the document's limit columns; tiers are Starter / Pro / Studio
--   * workspaces carry owner_id and region; subscriptions table exists

-- ledger -> credit_transactions
DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries;
ALTER TABLE ledger_entries RENAME TO credit_transactions;
ALTER TABLE credit_transactions RENAME COLUMN entry_type TO type;
ALTER TABLE credit_transactions RENAME COLUMN available_after TO balance_after;
ALTER INDEX ledger_idem_key RENAME TO credit_transactions_idem_key;
ALTER INDEX ledger_created_idx RENAME TO credit_transactions_created_idx;

CREATE OR REPLACE FUNCTION credit_transactions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_transactions is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_transactions_no_update BEFORE UPDATE OR DELETE ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION credit_transactions_immutable();
DROP FUNCTION IF EXISTS ledger_entries_immutable();

-- plans: document limit columns
ALTER TABLE plans RENAME COLUMN max_revision_rounds TO max_revisions;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS video_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_resolution TEXT NOT NULL DEFAULT '720p';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_languages INT;             -- NULL = all supported
ALTER TABLE plans ADD COLUMN IF NOT EXISTS voice_clones INT NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS publish_channels INT;          -- NULL = unlimited
ALTER TABLE plans ADD COLUMN IF NOT EXISTS api_access BOOL NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS animation_access TEXT NOT NULL DEFAULT 'limited';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS xr_access TEXT NOT NULL DEFAULT 'none';

-- the middle tier is "Pro" in the document
INSERT INTO plans (id, name, monthly_price_cents, monthly_credits, max_revisions, max_video_seconds, max_concurrent_jobs,
                   queue_priority, rate_limit_rpm, workspace_rate_rpm, max_seats, watermark)
  SELECT 'pro', 'Pro', monthly_price_cents, monthly_credits, max_revisions, max_video_seconds, max_concurrent_jobs,
         queue_priority, rate_limit_rpm, workspace_rate_rpm, max_seats, watermark
    FROM plans WHERE id = 'creator'
  ON CONFLICT (id) DO NOTHING;
UPDATE workspaces SET plan_id = 'pro' WHERE plan_id = 'creator';
DELETE FROM plans WHERE id = 'creator';

-- workspaces: owner and home region
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_id UUID;
UPDATE workspaces SET owner_id = created_by WHERE owner_id IS NULL;
ALTER TABLE workspaces ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'local';

CREATE TABLE IF NOT EXISTS subscriptions (
  workspace_id  UUID NOT NULL,
  id            UUID NOT NULL,
  plan_id       TEXT NOT NULL REFERENCES plans(id),
  status        TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled')),
  provider      TEXT NOT NULL DEFAULT 'none',
  provider_ref  TEXT,
  renews_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
