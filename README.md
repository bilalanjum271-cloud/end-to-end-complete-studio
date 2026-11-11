# Xen Studio

AI content-generation platform: Script-to-Video, Animation, AR, VR, MR/XR and Admin & Analytics in one workspace.
Cell-based, multi-tenant, designed to scale horizontally.

**Status:** Phase 1 (Foundation) core is built and tested. See [PROGRESS.md](PROGRESS.md) for exactly what is done,
what is written but unverified, and what remains. Choices are logged in [DECISIONS.md](DECISIONS.md).

## What runs today

| Piece | Path | Stack |
|---|---|---|
| Web app (marketing, pricing, auth, six-dashboard shell, credits) | `apps/web` | Next.js, TypeScript, Tailwind |
| Design system + Storybook | `packages/ui` | Radix UI, Lucide, design tokens |
| Gateway (auth, rate limits, load shedding, breakers) | `services/gateway` | Go |
| Credit ledger (reserve / debit / refund, append-only, exactly-once) | `services/ledger` | Go |
| Cell router (workspace → cell) | `services/cell-router` | Go |
| Identity (auth, workspaces, roles, plans) | `services/identity` | NestJS |

```
browser → web (Next.js) → gateway ─┬→ identity ─→ SQL
                                   └→ ledger   ─→ SQL        cell-router ─→ global SQL
                              Redis (rate limits)
```

## Run it locally

Requirements: Node 22+, pnpm 10, Go 1.24+, and either Docker or a local PostgreSQL 16 + Redis 7.

```bash
cp .env.example .env            # then set JWT_SECRET and INTERNAL_SERVICE_TOKEN to long random strings
pnpm install

# infrastructure — option A: Docker (CockroachDB, Redis, Kafka, Temporal, MinIO, Prometheus, Grafana)
docker compose -f infra/compose/docker-compose.yml up -d
# option B: your own PostgreSQL + Redis; point DATABASE_URL / GLOBAL_DATABASE_URL / REDIS_URL at them in .env

node scripts/dev.mjs            # builds, migrates, seeds, starts every service + the web app
```

Open http://localhost:3000 and create an account. You land in the app with 300 Starter credits.

## Test it

```bash
# Go services (ledger and Redis tests need the two URLs; they skip without them)
TEST_DATABASE_URL='postgresql://USER:PASS@localhost:5432/xen_studio_test?sslmode=disable' \
TEST_REDIS_URL=redis://localhost:6379 go test ./... -race

# identity, design-system and i18n tests
TEST_DATABASE_URL='postgresql://USER:PASS@localhost:5432/xen_studio_test' pnpm test

# Phase 1 end-to-end: boots the real services and drives the whole flow through the gateway
pnpm --filter @xen-studio/identity build
DATABASE_URL='postgresql://USER:PASS@localhost:5432/xen_studio' node scripts/e2e-phase1.mjs

# visual regression (stack must be running: node scripts/dev.mjs --prod)
pnpm --filter @xen-studio/web test:visual

pnpm --filter @xen-studio/ui storybook      # design system at http://localhost:6006
```

## Repository layout

```
apps/web            Next.js app            services/gateway      Go
packages/ui         design system          services/ledger       Go
packages/go         shared Go platform     services/cell-router  Go
infra/db            migrations             services/identity     NestJS
infra/kafka         topic catalog          infra/compose         local infrastructure
infra/monitoring    Prometheus, Grafana    infra/docker          Dockerfiles
scripts             migrate, seed, dev, e2e
workers, data, xr   reserved for Phases 2, 4, 7
```
