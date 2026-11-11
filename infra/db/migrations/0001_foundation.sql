-- Xen Studio foundation schema.
-- Target: CockroachDB / YugabyteDB (PostgreSQL wire). Verified on PostgreSQL 16.
-- Rules: every tenant row carries workspace_id and it LEADS every primary key, so the
-- distributed SQL engine range-partitions by workspace and a cell can be split by key range.

CREATE TABLE IF NOT EXISTS plans (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  monthly_price_cents  INT  NOT NULL,
  monthly_credits      BIGINT NOT NULL,
  max_revision_rounds  INT  NOT NULL,
  max_video_seconds    INT  NOT NULL,
  max_concurrent_jobs  INT  NOT NULL,
  queue_priority       INT  NOT NULL,          -- higher = served first
  rate_limit_rpm       INT  NOT NULL,          -- per-user requests per minute
  workspace_rate_rpm   INT  NOT NULL,          -- per-workspace requests per minute
  max_seats            INT  NOT NULL,
  watermark            BOOL NOT NULL,
  features             JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  locale         TEXT NOT NULL DEFAULT 'en',
  platform_role  TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user','staff','superadmin')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_key ON workspaces (slug);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id UUID NOT NULL,
  user_id      UUID NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL,
  refresh_hash  TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ── Credits: one mutable summary row + an append-only ledger ──────────────────
CREATE TABLE IF NOT EXISTS credit_accounts (
  workspace_id UUID PRIMARY KEY,
  available    BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved     BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  spent        BIGINT NOT NULL DEFAULT 0 CHECK (spent >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_reservations (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  amount       BIGINT NOT NULL CHECK (amount > 0),
  status       TEXT NOT NULL CHECK (status IN ('held','committed','released')),
  job_id       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  workspace_id     UUID NOT NULL,
  id               UUID NOT NULL,
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('grant','reserve','debit','refund')),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  reservation_id   UUID,
  job_id           TEXT,
  idempotency_key  TEXT NOT NULL,
  reason           TEXT NOT NULL DEFAULT '',
  available_after  BIGINT NOT NULL,
  reserved_after   BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
-- Exactly-once: a retried write with the same key hits this index and returns the first result.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_idem_key ON ledger_entries (workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ledger_created_idx ON ledger_entries (workspace_id, created_at DESC);

-- ── Generic idempotency store for every write endpoint ────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id  UUID NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INT,
  response      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  actor_id     UUID,
  action       TEXT NOT NULL,
  target       TEXT NOT NULL DEFAULT '',
  metadata     JSONB NOT NULL DEFAULT '{}',
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs (workspace_id, created_at DESC);

-- Transactional outbox: rows are written in the same transaction as the state change
-- and relayed to Kafka (topic keyed by workspace_id).
CREATE TABLE IF NOT EXISTS outbox (
  workspace_id UUID NOT NULL,
  id           UUID NOT NULL,
  topic        TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

-- ── Global control plane (lives in the global database, not per cell) ─────────
CREATE TABLE IF NOT EXISTS cells (
  id          TEXT PRIMARY KEY,
  region      TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draining','offline')),
  weight      INT  NOT NULL DEFAULT 100 CHECK (weight >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_cells (
  workspace_id UUID PRIMARY KEY,
  cell_id      TEXT NOT NULL REFERENCES cells(id),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_cells_cell_idx ON workspace_cells (cell_id);
