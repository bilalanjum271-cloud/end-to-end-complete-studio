# Xen Studio — build progress

Resume rule: continue from the **first unchecked item**. A box is ticked only if the thing was actually run
and passed; "written, not run" items stay unchecked with a note. Last updated: 2026-11-12.

## Blockers a human must resolve
- [ ] **Attach the "Complete Master Stack" document.** It was not included with the build prompt (both attachments
      were the prompt itself; the folder and the GitHub repo were empty). Schema, Kafka topics and plan limits below
      were therefore chosen from the prompt and are logged in DECISIONS.md (D-001…D-005) for reconciliation.
- [ ] **Link GitHub to Claude** (Settings → Connectors) so the repo `bilalanjum271-cloud/end-to-end-complete-studio`
      can be pushed to. Until then the code lives in this folder only.

## Phase 1 — Foundation  (in progress: core verified, infra-as-code remaining)

File plan: `/packages/ui` design system · `/apps/web` Next.js app · `/services/{gateway,ledger,cell-router}` Go ·
`/services/identity` NestJS · `/packages/go/platform` shared Go · `/infra/{db,kafka,compose,monitoring,docker}` ·
`/scripts` migrate/seed/dev/e2e · `/.github/workflows/ci.yml` · `/docs`.

### Done and verified (ran in the build sandbox: PostgreSQL 16, Redis 7, Go 1.24, Node 22)
- [x] Monorepo layout (`/apps /services /workers /packages /infra /data /xr /docs`), pnpm workspace, single Go module
- [x] Distributed-SQL schema + migrations (`infra/db/migrations`), idempotent runner, seed data — applied twice cleanly
- [x] Plans: Starter / Creator / Studio with credits, revision rounds (1 / 3 / 5), seats, priority, rate limits
- [x] **Credit ledger (Go)**: reserve → debit on success → refund on failure, append-only (DB trigger),
      idempotency key on every write, exactly-once under concurrency — 6 integration tests incl. 60 concurrent
      reserves never overspending and a 25-way same-key retry storm applying once
- [x] **Cell router (Go)**: workspace → cell, weighted rendezvous hashing, sticky pins, drain status — 5 tests
      (balance, weights, minimal remap on cell removal, stickiness when capacity is added, replica agreement)
- [x] **Gateway (Go)**: JWT verification, tenant-header injection (spoof-proof), per-IP / per-user / per-workspace
      token buckets in Redis with in-memory fallback, priority load shedding by plan, per-upstream circuit breaker,
      `/internal` never routed — 7 tests incl. real Redis
- [x] **Identity (NestJS)**: signup, login, refresh rotation with theft detection, logout, workspaces, roles
      (owner/admin/editor/viewer), seat limits, tenant isolation, audit log, outbox rows — 9 integration tests
- [x] OpenAPI for identity generated (`services/identity/openapi.json`, also served at `/docs`)
- [x] Structured JSON logs, request ids, W3C `traceparent` propagation, `/healthz`, `/readyz`, Prometheus `/metrics`
      on the Go services; health/ready on identity
- [x] **Design system** (`packages/ui`): tokens (color, type, 8px spacing, radius, shadow, motion), dark default +
      light theme, Radix components (button, input, textarea, select, dialog, drawer, tabs, table, toast with undo
      action, tooltip, command palette, empty state, skeleton, progress, status badge), Lucide only.
      4 mechanical tests: no hard-coded colors, single icon set / no emoji, light theme covers every token,
      WCAG AA contrast for every text/surface pair in both themes. Storybook builds (`pnpm --filter @xen-studio/ui build-storybook`)
- [x] **Web app**: marketing home, pricing (live from `/v1/plans`, static fallback), login, signup, app shell with
      navigation for all six dashboards, credits page with live ledger, command palette (Ctrl/Cmd+K), `g`+letter
      shortcuts, theme toggle, loading / empty / error / not-found states, httpOnly-cookie session with silent refresh
- [x] Translations from the start: English, Arabic, Urdu; RTL layouts verified (key-parity test, 2 tests)
- [x] Responsive check at 360px and 1440px: no horizontal overflow; Playwright visual regression, 8 tests, baselines
      committed for linux (`apps/web/e2e/__screenshots__`)
- [x] **Phase 1 end-to-end test** (`node scripts/e2e-phase1.mjs`): real gateway + identity + ledger + router,
      11 steps, all pass (signup → credits granted once → auth rejection → reserve/commit → reserve/release/402 →
      tenant isolation → refresh/login/logout → rate limits → cell pinning → metrics)
- [x] Root README with exact run commands, `.env.example`, `scripts/dev.mjs` one-command local start

### Written but NOT run (no Docker daemon in the build sandbox) — verify on your machine, then tick
- [ ] `infra/compose/docker-compose.yml` (CockroachDB, Redis, ScyllaDB, Redpanda + schema registry, Temporal, MinIO
      with lifecycle rules, OTel collector, Prometheus, Grafana) — run `docker compose -f infra/compose/docker-compose.yml up -d`
- [ ] Migrations against **CockroachDB** itself (verified on PostgreSQL 16 only; triggers need CockroachDB ≥ 24.3)
- [ ] Kafka topic catalog + `create-topics.sh` (`infra/kafka`)
- [ ] Prometheus scrape config, 6 alert rules, Grafana "Cell overview" dashboard (`infra/monitoring`)
- [ ] Dockerfiles for all five deployables (`infra/docker`)
- [ ] GitHub Actions CI: lint, vet, tests, e2e, dependency scan, image build + Trivy scan (`.github/workflows/ci.yml`)

### Not built yet (remaining Phase 1 work, in order)
- [ ] Outbox → Kafka relay (rows are written transactionally today; nothing publishes them yet)
- [ ] Temporal worker skeleton + one health workflow (Temporal is only present in compose)
- [ ] Object-storage client package with presigned upload/download and lifecycle tiers
- [ ] OpenAPI specs for ledger and cell-router; per-service READMEs
- [ ] OpenTelemetry trace export from services to the collector (trace ids propagate; spans are not exported)
- [ ] Feature-flag package and staged-rollout config; ArgoCD apps
- [ ] Helm charts (per service, KEDA autoscaling, service mesh policy) and Terraform modules (multi-region)
- [ ] Runbooks: deploy, rollback, incident, disaster recovery (`docs/runbooks` has incident.md only)
- [ ] Lighthouse 95+ run and LCP measurement; screen-reader pass (contrast and keyboard paths are tested)
- [ ] k6 smoke load test per Phase 1 service with throughput per pod
- [ ] Workspace switcher and members screen in the UI (API exists and is tested)
- [ ] Plural-aware strings (pricing currently shows "1 revision round(s)")

## Phase 2 — Script-to-Video Studio
- [ ] Model Router (Python/FastAPI): provider interfaces for LLM, TTS, video, image, moderation; two adapters each + mock; failover
- [ ] Prompt moderation → cost estimate → credit reservation (ledger API is ready)
- [ ] Temporal workflow: research → script → approval signal → scene plan → voice ‖ visuals → FFmpeg assembly + subtitles → QC
- [ ] Job state in ScyllaDB; progress over Kafka → WebSocket gateway
- [ ] Review: scene-level regeneration, revision rounds limited by plan (max 5), export; watermark + C2PA
- [ ] Dashboard UI: composer, script approval, live per-scene progress with time and cost, timeline editor
- [ ] Phase 2 e2e with mock providers

## Phase 3 — Localization and publishing
- [ ] Multi-language scripts and voices, glossary, review queue, subtitle export
- [ ] Title / thumbnail / tags generation; 16:9, 9:16, 1:1 exports
- [ ] Scheduled upload: YouTube, TikTok, Facebook, Instagram (needs developer apps and OAuth credentials)
- [ ] Notifications: email, push, in-app
- [ ] Phase 3 e2e

## Phase 4 — Big data layer and Admin dashboard
- [ ] Events → Iceberg lakehouse; Flink live cost and fraud signals; Spark + dbt aggregates; ClickHouse
- [ ] Airflow, data catalog, data quality checks, lineage
- [ ] Admin UI: users, revenue, cost, queues, moderation queue
- [ ] Phase 4 e2e

## Phase 5 — Animation Studio
- [ ] Link ingestion with rights-confirmation records and copyright detection
- [ ] Style profiles, character consistency, avatars + lip-sync (consent records), music and SFX
- [ ] Phase 5 e2e

## Phase 6 — Platform features
- [ ] Teams UI, brand kits, templates, asset library, search (OpenSearch, Qdrant), real-time collaboration
- [ ] Public API + webhooks + SDK; Stripe billing behind a provider interface, regional pricing; referrals
- [ ] Support and internal admin tools; full translation coverage; accessibility audit; React Native app
- [ ] Phase 6 e2e

## Phase 7 — XR
- [ ] Shared 3D asset pipeline (glTF/USD); in-browser scene editor (Three.js / WebXR)
- [ ] AR Studio, VR Studio, MR/XR Studio: spatial audio, multi-user sessions, cloud streaming, device exports (Unity + OpenXR)
- [ ] Phase 7 e2e

## Phase 8 — Scale and hardening
- [ ] Self-hosted model serving with GPU autoscaling; multi-region active-active; cell provisioning automation
- [ ] k6 load tests per service; `/docs/capacity.md` for 1M / 10M / 100M / 1B concurrent users
- [ ] Chaos tests, security review, compliance (export, deletion, consent, audit), enterprise (SSO, SCIM, white-label)
- [ ] Status page, disaster-recovery drills, final documentation

## What is mocked, untested, or needs a human
| Item | State |
|---|---|
| AI providers | Not built yet (Phase 2). Will ship with mock adapters so everything runs with no keys |
| CockroachDB / ScyllaDB / Kafka / Temporal / MinIO | Configured in compose; never started in the build sandbox |
| Go dependencies | Fetched with `GOPROXY=direct` and no checksum DB (sandbox blocked proxy.golang.org). Run `go mod verify` once on a normal network |
| Real keys later | LLM/TTS/video providers, Stripe, SMTP/push, YouTube/TikTok/Meta developer apps, cloud account for Terraform, XR devices |
| Scale claims | Nothing has been load-tested. 1B concurrent users is a design target, not a measured result |
