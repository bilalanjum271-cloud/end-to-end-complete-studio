# Xen Studio — build progress

Resume rule: continue from the **first unchecked item**. A box is ticked only if the thing was actually run
and passed; "written, not run" items stay unchecked with a note. Last updated: 2026-11-12 (session 4).

## Blockers a human must resolve
- Note on order: the remaining Phase 1 and Phase 2 items need Docker (Kafka, Temporal, MinIO, Helm) or real provider
  keys, neither of which exists in the build sandbox. They stay unchecked; work continued with items that can be run and verified.
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
- [x] Real provider adapters, switched on by API keys: OpenAI + Anthropic (LLM), OpenAI (moderation), ElevenLabs + OpenAI (TTS),
      OpenAI Images + Stability (visuals, animated push-in), Resend (email), Meshy (text-to-3D), web page ingestion.
      Tested against simulated vendor responses (request shape, parsing, cost, failover, 429/5xx/timeouts); **never called a real API**
- [ ] Live verification with real keys (add keys to `.env`, run one video per provider, compare quality and cost)
- [ ] Vision-based QC adapter; a text-to-video provider (Runway / Kling / Veo) — the visual capability uses still images today
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

## Phase 3 — Localization and publishing  (built and verified on mocks, except platform upload)

### Done and verified
- [x] Title / description / tags generation and a thumbnail image with each render
- [x] Multi-format export: 9:16 and 1:1 (centre-crop), idempotent background jobs
- [x] Subtitle export (SRT and VTT)
- [x] Notifications: in-app feed, email and push through provider interfaces, delivery log, no duplicates
- [x] **Localization**: glossary per language (case-insensitive upsert), translation through the LLM capability with
      glossary terms enforced, **human review queue** with side-by-side line editing, approval reserves credits, dubbed
      render reuses the original visuals and holds the last frame when dubbed speech runs longer, language-tagged
      subtitle track, credits debited on success / refunded on failure, plan language limit — 2 end-to-end tests
- [x] UI: languages panel on each video, review page, glossary manager, review queue on the studio page

### Not built (in order)
- [ ] Scheduled upload to YouTube, TikTok, Facebook, Instagram — needs a developer app and OAuth credentials per platform
- [ ] Real push (FCM / APNs); notification preferences; email templates per locale
- [ ] Subject-aware reframing; burned-in captions option
- [ ] Mock translation only tags lines (`[ur] …`); real translation needs an LLM key

## Phase 4 — Big data layer and Admin dashboard  (admin built and verified; big-data engines written, not run)

### Done and verified
- [x] **Admin & Analytics API** (staff only; platform role re-checked in the database on every call, spoofed headers
      rejected): users, plan revenue, credits granted / spent / reserved / refunded, video minutes, provider cost and
      **cost per video minute**, daily series, per-provider jobs / failure rate / cost / latency, queues, moderation
- [x] Moderation queue with uphold / overturn (audited); a decision on a **rights hold** resumes or stops the project
- [x] User search and suspend / reactivate (sessions revoked, audited, staff cannot act on peers)
- [x] **Admin UI**: KPI tiles, three daily bar charts (hover/focus tooltips, table view, contrast-validated), provider
      table, queues, moderation queue, user table — rendered and checked in a browser
- [x] **Outbox → event bus relay** (at-least-once, `SKIP LOCKED` for many relays, retried on sink failure); Kafka sink
      written, JSON-lines lake sink tested; runs in the local stack
- [x] `scripts/make-staff.mjs` to grant staff access

### Written, not run (no engines in the build sandbox)
- [ ] ClickHouse schema with Kafka ingest and materialized views (`infra/analytics/clickhouse`)
- [ ] Flink SQL live signals: provider cost spikes, credit burn, refund ratio, signup bursts (`infra/analytics/flink`)
- [ ] Iceberg raw zone + dbt staging/marts incl. unit economics + data-quality tests (`infra/analytics/dbt`)
- [ ] Airflow daily DAG with freshness, build, catalog/lineage (`infra/analytics/airflow`)
- [ ] Kafka sink of the relay (needs a broker)

## Phase 5 — Animation Studio  (built and verified on mocks)

### Done and verified
- [x] Start from your own text (adapted, never invented around) or a link to content you own
- [x] **Rights record** stored before any link is processed (exact attestation text, user, IP); attestation required
- [x] Copyright screen: catalog links held for **human rights review** in the Admin queue; staff decision resumes or blocks;
      no credits reserved while held — tested end to end
- [x] Style profiles (4 presets: flat, paper, watercolor, ink noir) applied to every scene
- [x] Character sheets: named characters keep one seed and their description in every scene they appear in
- [x] Music bed (calm / uplifting / tense) mixed under narration with sidechain ducking and loudness normalization
- [x] **Consent records** for voice / face cloning; a cloned voice is refused without an unrevoked consent record
- [x] Animation dashboard UI (text / link modes, style picker, characters, music) — driven end to end in a browser
- [x] 3 end-to-end tests (styled render verified by frame colour and audio level; link + rights review; consent)

### Not built
- [ ] Avatars and lip-sync (needs an avatar model, e.g. HeyGen / D-ID / self-hosted); voice cloning itself (needs ElevenLabs voice cloning)
- [ ] Copyright fingerprinting vendor (mock flags catalog hosts only); video and audio file uploads as sources
- [ ] Real music / SFX model; custom style profiles UI (API supports workspace profiles)
- [ ] Mock "animation" is moving shapes in the style palette; real animation needs an image or video model

## Phase 6 — Platform features  (billing and teams built; the rest not started)

### Done and verified
- [x] **Billing**: Stripe behind a payment-provider interface (REST, no SDK) + a mock provider with a local checkout page;
      plan changes only from a **signature-verified webhook** (Stripe scheme, 5-minute tolerance, tampering rejected),
      exactly once per event; one credit grant per billing period; cancel downgrades to Starter — 4 tests
- [x] **Regional pricing** (purchasing-power multipliers; regional Stripe prices `STRIPE_PRICE_PRO_PK` etc. when configured)
- [x] **Team settings UI**: add members, change roles, remove (owner / admin rules enforced by the API), plan and upgrade
- [x] Interface translations EN / AR / UR with RTL (key-parity test); keyboard navigation and contrast tested

### Not built
- [ ] Brand kits, templates, asset library, search (OpenSearch, Qdrant), real-time collaboration
- [ ] Public API keys, webhooks and SDK; referral program; support tools; internal admin tools beyond Phase 4
- [ ] React Native mobile app
- [ ] Customer portal (invoices, payment method), proration, taxes; country verification for regional prices (see D-043)

## Phase 7 — XR  (asset pipeline, editor and export built; XR sessions unverified on devices)

### Done and verified
- [x] **Shared 3D asset pipeline**: prompt → moderation → credits reserved → text-to-3D capability → **GLB validated**
      → stored → debited (refunded on failure); queued, never synchronous. Mock builds real glTF 2.0 files from primitives
- [x] Scenes for AR / VR / MR-XR with nodes, transforms, environment and **spatial-audio sources**; autosave with
      **optimistic concurrency** (stale tab gets 409); assets from other tenants rejected
- [x] **Device export**: whole scene merged into one GLB with transforms and audio metadata (validated), Studio plan only
- [x] **In-browser scene editor** (three.js): library, add, select, move/rotate/scale gizmo, inspector, environment,
      positional-audio preview, autosave, export; **Enter VR / View in AR** via WebXR when a device supports it
- [x] AR, VR and MR/XR studio dashboards; plan gating (none / preview / full) — 2 API tests + browser run

### Not built or not verified
- [ ] WebXR sessions have **not** been tested on a headset or phone (no device here)
- [ ] Multi-user sessions; cloud streaming; Unity + OpenXR / AR Foundation project; USD/USDZ export
- [ ] Real text-to-3D quality (Meshy adapter written and tested against simulated responses only)

## Phase 8 — Scale and hardening  (documents and scripts written; nothing run at scale)

- [x] Capacity model `docs/capacity.md` for 1M / 10M / 100M / 1B concurrent users — **assumption-based**, every
      constant marked and replaceable with k6 results
- [x] Runbooks: deploy, rollback, incident, disaster recovery (with a ledger reconciliation query that returns zero
      mismatches on all test data)
- [ ] k6 scripts written (`infra/k6`), **not run**
- [ ] Self-hosted model serving with GPU autoscaling; multi-region active-active; cell provisioning automation
- [ ] Helm charts, Terraform modules, ArgoCD, service mesh policy
- [ ] Chaos tests; security review; data export and deletion for compliance; enterprise SSO / SCIM / white-label; status page
- [ ] Disaster-recovery drills

## What is mocked, untested, or needs a human
| Item | State |
|---|---|
| AI providers | **Mocked until you add keys.** With no keys: template scripts, robotic local English voice, title-card / shape visuals, tagged (not translated) lines, primitive 3D models, synthesized music. Real adapters exist for OpenAI, Anthropic, ElevenLabs, Stability, Meshy, Resend and switch on automatically per key (`MODEL_ROUTER_MODE=auto`) |
| Payments | Mock checkout until `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_PRO` / `STRIPE_PRICE_STUDIO` are set |
| Temporal | Workflow adapter written, never run (see Phase 2) |
| Storage | Local directory behind a storage interface; S3/MinIO adapter not written |
| CockroachDB / ScyllaDB / Kafka / Temporal / MinIO | Configured in compose; never started in the build sandbox |
| Go dependencies | Fetched with `GOPROXY=direct` and no checksum DB (sandbox blocked proxy.golang.org). Run `go mod verify` once on a normal network |
| Real keys later | LLM/TTS/video providers, Stripe, SMTP/push, YouTube/TikTok/Meta developer apps, cloud account for Terraform, XR devices |
| Scale claims | Nothing has been load-tested. 1B concurrent users is a design target, not a measured result |
