# Xen Studio — build progress

Resume rule: continue from the **first unchecked item**. A box is ticked only if the thing was actually run
and passed; "written, not run" items stay unchecked with a note. Last updated: 2026-11-12.

## Blockers a human must resolve
- [x] "Complete Master Stack" document received (stored at `docs/source/complete-master-stack.pdf`). Phase 1 was
      reconciled against it: plans, schema names, Kafka topics (DECISIONS.md D-023…D-027).
- [ ] **Link GitHub to Claude** (Settings → Connectors) so the repo `bilalanjum271-cloud/end-to-end-complete-studio`
      can be pushed to. Until then the code is delivered as a zip with full git history.
- [ ] **Run the Temporal path once on a machine with Docker** (see "Phase 2 → Written but NOT run").

## Phase 1 — Foundation  (in progress: core verified, infra-as-code remaining)

File plan: `/packages/ui` design system · `/apps/web` Next.js app · `/services/{gateway,ledger,cell-router}` Go ·
`/services/identity` NestJS · `/packages/go/platform` shared Go · `/infra/{db,kafka,compose,monitoring,docker}` ·
`/scripts` migrate/seed/dev/e2e · `/.github/workflows/ci.yml` · `/docs`.

### Done and verified (ran in the build sandbox: PostgreSQL 16, Redis 7, Go 1.24, Node 22)
- [x] Monorepo layout (`/apps /services /workers /packages /infra /data /xr /docs`), pnpm workspace, single Go module
- [x] Distributed-SQL schema + migrations (`infra/db/migrations`), idempotent runner, seed data — applied twice cleanly
- [x] Plans per the Master Stack draft table: Starter / Pro / Studio — video minutes 20 / 100 / 500 (10 credits per minute),
      revision rounds 2 / 5 / 5, max length 3 / 15 / 60 min, seats 1 / 5 / 25, resolution, languages, voice clones, channels, API, watermark
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
- [x] Master Stack alignment migration (`0003`): `credit_transactions` ledger table, plan limit columns, `workspaces.owner_id/region`, `subscriptions`
- [x] Ledger writes a `credits.reserved / debited / refunded / granted` outbox event in the same transaction as each entry (tested)
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

## Phase 2 — Script-to-Video Studio  (core flow built and verified with mock providers)

File plan: `services/studio/xen_studio/{router,pipeline,api}` (Python) · `infra/db/migrations/0004` ·
`apps/web/src/app/app/video` · gateway route `/v1/projects`.

### Done and verified
- [x] Schema for projects, scripts, scenes, jobs, renders, revisions, moderation_events (Master Stack tables), applied
- [x] **Model Router**: provider interface per capability (moderation, LLM, TTS, visual, QC), ordered adapters, automatic
      failover, per-provider circuit breaker with cooldown probe, language routing, cost reporting, `provider.health`
      events — 7 tests. Two mock providers per capability so the platform runs with no API keys
- [x] **Pipeline** (one flow definition, host-agnostic): prompt moderation → cost estimate → credit reservation →
      research → script → **pause for approval** (edit lines / rewrite / cancel) → per-scene voice ‖ visuals → automated QC with
      retry → FFmpeg assembly (stitch, EBU R128 loudness, subtitle track, SRT + VTT, watermark by plan) → output
      moderation → provenance manifest → **pause for review** → scene-level regeneration with the plan's revision-round
      limit → accept → debit. Any failure refunds the reservation
- [x] **Project API** behind the gateway: estimate, idempotent create, list, detail with per-scene progress, approve,
      rewrite, review (accept / revise), cancel, video (seekable), subtitles, provenance. Tenant-scoped; editor role to write
- [x] **Phase 2 end-to-end test** (`pytest` in `services/studio`, 5 scenarios, real API + real FFmpeg + real PostgreSQL +
      real Go ledger): full prompt → reviewed MP4 with exact credit accounting and the Starter 2-round limit; blocked
      prompt spends nothing; total provider outage refunds; single-provider outage fails over and still delivers;
      plan length limit, roles, gateway-only access, insufficient credits
- [x] **Dashboard UI**: composer with live cost estimate, project grid, script approval with inline line editing and
      research notes, live per-scene progress (voice / visuals, time left, credits), review player with captions,
      proportional scene timeline for selecting scenes to regenerate, downloads (MP4, SRT, provenance), designed
      blocked / failed / cancelled / no-credits states. Driven end to end in a real browser; in the visual regression suite
- [x] Outbox events on the document's topics: `script.requested/generated/approved`, `moderation.decisions`,
      `job.completed/failed`, `qc.scored`, `render.completed`, `review.submitted`, `project.events`

### Written but NOT run
- [ ] **Temporal host** (`pipeline/temporal_workflow.py`, `pipeline/worker.py`). The build sandbox could not run a
      Temporal server, so verified runs use the in-process host (`ORCHESTRATOR=local`), which is not durable across
      restarts. The flow logic and all activities are shared and tested; only the thin Temporal adapter is unverified.
      To verify: `docker compose … up -d temporal`, `ORCHESTRATOR=temporal`, start `python -m xen_studio.pipeline.worker`,
      run the UI flow, then tick this box

### Not built yet (remaining Phase 2 work, in order)
- [ ] Real provider adapters (LLM, ElevenLabs / Google / Azure TTS, video aggregator, image, moderation, vision QC) — need API keys
- [ ] Web research with cited sources (mock returns placeholder notes); script structure presets per format
- [ ] WebSocket live progress via Kafka (UI polls every 1.5 s today); job state in ScyllaDB
- [ ] S3 storage backend + CDN signed URLs + HLS/DASH ladder (local-directory storage today)
- [ ] Cryptographic C2PA signing (manifest is written unsigned; needs a signing certificate); invisible watermark
- [ ] Timeline editor beyond scene selection (trim, reorder, swap voice or music); version history restore UI
- [ ] Burned-in subtitles option; forced alignment for word-level timing
- [ ] Per-plan and per-user budget caps beyond the credit balance; priority queues per plan for generation
- [ ] Cancel during generation; charge policy for revision rounds (currently free within the reservation)
- [ ] Human trust-and-safety queue and appeals; real-person and age rules
- [ ] OpenAPI export for the studio service (FastAPI serves it at `/docs`); metrics and traces for the Python service

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
| AI providers | **All mocked.** Scripts come from templates, not a language model. English narration is a local robotic voice (FFmpeg flite); other languages get a placeholder tone. Visuals are title cards, not generated video. Real output quality needs provider keys |
| Temporal | Workflow adapter written, never run (see Phase 2) |
| Storage | Local directory behind a storage interface; S3/MinIO adapter not written |
| CockroachDB / ScyllaDB / Kafka / Temporal / MinIO | Configured in compose; never started in the build sandbox |
| Go dependencies | Fetched with `GOPROXY=direct` and no checksum DB (sandbox blocked proxy.golang.org). Run `go mod verify` once on a normal network |
| Real keys later | LLM/TTS/video providers, Stripe, SMTP/push, YouTube/TikTok/Meta developer apps, cloud account for Terraform, XR devices |
| Scale claims | Nothing has been load-tested. 1B concurrent users is a design target, not a measured result |
