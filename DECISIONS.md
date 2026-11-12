# Decisions

Choices made where the source document was silent or unavailable. Each can be reversed; none is irreversible.

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D-001 | Phase 1 was first built without the Master Stack document, then reconciled when it arrived (D-023…D-027) | It was not attached at first | Done |
| D-002 | Superseded by D-024 | — | — |
| D-003 | Roles: owner, admin, editor, viewer per workspace; platform roles user / staff / superadmin | Minimum set that supports teams and the Admin dashboard | Master Stack role matrix |
| D-004 | Schema in `infra/db/migrations/0001`; every tenant table's primary key starts with `workspace_id` | Lets distributed SQL range-partition by workspace; makes cell splits a key-range move | Master Stack schema |
| D-005 | Kafka topic names `xen.<domain>.<entity>.v<n>`, keyed by `workspace_id`, each with a `.dlq` | Prompt requirements; catalog in `infra/kafka/topics.yaml` | Master Stack topic list |
| D-006 | **CockroachDB** chosen over YugabyteDB | Prompt allows either; serializable by default suits the ledger; multi-region primitives | — |
| D-007 | Go services use `lib/pq` + `database/sql`, not `pgx` | The build sandbox blocks proxy.golang.org and gopkg.in, which pgx's module graph needs. lib/pq has no dependencies and works with CockroachDB | Swap to pgx on a normal network if pooling features are wanted; store code is driver-agnostic SQL |
| D-008 | Access tokens are HS256 JWTs (15 min) signed by identity, verified by the gateway with a shared secret; refresh tokens are opaque, hashed, rotated, with reuse detection | Simple and stateless for Phase 1 | Phase 8: move to EdDSA with JWKS so gateways never hold a signing key |
| D-009 | Plan limits (rpm, workspace rpm, priority) are carried in the access token | The gateway enforces limits with zero database lookups on the hot path | A plan change takes effect at next token refresh (≤15 min); acceptable |
| D-010 | Temporal uses its own PostgreSQL in local compose | Temporal does not officially support CockroachDB | Production: Temporal Cloud or Cassandra-backed multi-cluster |
| D-011 | Redpanda stands in for Kafka locally | Kafka API-compatible, single binary, built-in schema registry | Production uses Kafka (MSK/Strimzi) with tiered storage and MirrorMaker 2 |
| D-012 | Hand-written Prometheus text exposition in `packages/go/platform/obs` instead of the Prometheus client library | Same sandbox dependency constraint as D-007; keeps the hot path dependency-free | Optional swap later; metric names follow Prometheus conventions |
| D-013 | Password hashing: scrypt (N=32768, r=8, p=1) from Node's standard library | OWASP-acceptable, no native build step | — |
| D-014 | Signup grants plan credits by calling the ledger with idempotency key `workspace-initial-grant:<id>`; an outbox row records `workspace.created` | Exactly-once grant even if the call is retried; the outbox lets a reconciler retry if the ledger was down | When the outbox relay lands, move the grant to a consumer |
| D-015 | Web session = httpOnly, SameSite=Lax cookies; the Next.js proxy refreshes silently; the web tier keeps no session state | Stateless services requirement; tokens never reach browser JavaScript | — |
| D-016 | Typeface Geist (+ Geist Mono); one accent color (jade `#46d6a0` dark / `#0b7a55` light); the only gradient is the sheen on the generate button | Prompt's visual rules | Brand review |
| D-017 | Spacing is an 8px grid with a 4px half-step allowed only for icon/text gaps inside controls | A strict 8px-only rule makes compact controls (badges, 32px buttons) impossible | — |
| D-018 | Locales shipped in Phase 1: English, Arabic, Urdu (latter two RTL) | Proves RTL from the start with two real RTL languages | Add languages in Phase 6 |
| D-019 | Admin & Analytics is visible in navigation to everyone but its content is restricted to platform staff | Prompt asks for navigation to all six dashboards; data must stay staff-only | Phase 4 |
| D-020 | Unbuilt studios show an "In build" state rather than fake controls | No stub UI that pretends to work | Replaced phase by phase |
| D-021 | Load shedding formula: priority p admitted while in-flight < max × (0.5 + p/200) | Sheds anonymous and free traffic first, paid plans last, with one integer comparison | Tune with Phase 8 load tests |
| D-022 | Application services run on the host in local dev (`scripts/dev.mjs`); compose runs infrastructure only | Faster rebuilds; Dockerfiles exist for CI and deployment | — |
| D-023 | Two Kafka topics added beyond the document: `credits.granted` and `workspace.events` | The ledger needs a topic for grants; workspace lifecycle has no topic in the document | — |
| D-024 | Plans follow the document's draft table (Starter / Pro / Studio). **1 video minute = 10 credits**, so 20 / 100 / 500 minutes = 200 / 1,000 / 5,000 credits. Prices ($0 / $29 / $99) are provisional | The document leaves prices open until cost per video minute is measured | After real providers are connected and cost per minute is measured |
| D-025 | Where the document and the build prompt differ, the prompt wins: CockroachDB (doc: PostgreSQL), Go gateway (doc: Kong/Envoy), in-house identity service (doc: Keycloak/Auth0), Qdrant | The prompt is the later, more specific instruction and fixes the stack | SSO in Phase 8 may bring in Keycloak behind the identity service |
| D-026 | The document's 22 services are grouped into fewer deployables for now: `identity` (Auth + Workspace), `ledger`, `studio` (Project, Script, Scene planner, Model router, Voice, Visual, Assembly, Quality check, Review, Moderation, Research as modules) | One team cannot operate 22 services on day one; module boundaries match the document so each can be split out | Split when a module needs independent scaling (first candidates: model router, assembly workers) |
| D-027 | The project API lives in the Python studio service, not NestJS | It shares the pipeline's data access and starts workflows directly; avoids a second Temporal client stack in Phase 2 | Move to a NestJS project service if business logic grows around it |
| D-028 | The workflow is written once (`pipeline/flow.py`) against a small host interface, with a Temporal host and an in-process host | The sandbox could not run Temporal; this keeps one tested definition of the pipeline instead of two | Remove the in-process host from production images once the Temporal path is verified |
| D-029 | Voice for a scene is generated first and the visual is cut to its length; scenes run in parallel with each other | Narration length is only known after synthesis | With real video models, generate fixed-length clips and time-stretch or pad |
| D-030 | Revision rounds regenerate scenes at no extra charge inside the original reservation | Simple and predictable for the first release | Revisit with measured cost per regeneration |
| D-031 | Live progress uses 1.5 s polling through the web tier | No Kafka/WebSocket path could be run in the sandbox | Replace with WebSocket push (Phase 2 remaining) |
| D-032 | Provenance: an unsigned C2PA-shaped manifest plus MP4 metadata and a visible watermark on Starter | Signing needs a certificate and the c2pa toolchain | When a signing certificate is available |
| D-033 | Exports run as a single retried background activity (`RunActivity` workflow on Temporal; a task on the in-process host) | An export is one FFmpeg step; a full workflow adds nothing | — |
| D-034 | Vertical and square exports use centre-crop reframing | Works for any source without a vision model | Subject-aware reframing when real video models are connected |
| D-035 | Notifications are keyed by (project, kind, script version, render version) | A retried activity or a re-delivered event must not notify twice | — |
| D-036 | The notification bell polls every 20 s while the tab is visible | Same reason as D-031 | WebSocket push |
| D-037 | Email and push are capabilities in the model router (`email`, `push`) | Reuses failover, breaker and health reporting for vendors that fail the same way AI vendors do | Split into the Notification service when templates and preferences land |
