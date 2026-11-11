# Decisions

Choices made where the source document was silent or unavailable. Each can be reversed; none is irreversible.

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D-001 | Built without the "Complete Master Stack" document | It was not attached; the prompt said not to stop | The document is supplied: diff schema, topics and plan limits against it |
| D-002 | Three plans: **Starter** (free, 300 credits, 1 revision round), **Creator** ($29, 3,000, 3 rounds), **Studio** ($99, 12,000, 5 rounds); Enterprise is contact-sales | Prompt: "up to 5 revision rounds (limited by plan)" and a pricing page | Master Stack plan limits |
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
