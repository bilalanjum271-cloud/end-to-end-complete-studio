# Capacity model

**Status: a model, not a measurement.** No load test has been run yet (k6 and a cluster were not available
while building). Every per-pod number below is an **assumption** marked *(A)*; replace each with the
result of `infra/k6/*.js` and the table recomputes. The structure — what scales with what — is the
deliverable; the constants are placeholders.

## How the system scales

- **Cells.** Each cell is a full copy of the stack (gateway, services, SQL range, Redis, Kafka partitions,
  workers) serving a set of workspaces. The cell router pins each workspace to one cell; adding capacity
  is adding cells (tested: `services/cell-router`, minimal remapping, sticky pins).
- **Stateless tiers** (web, gateway, identity, studio API, ledger) scale on CPU and in-flight requests (HPA/KEDA).
- **Stateful tiers** scale by partition: SQL ranges are keyed by `workspace_id` first; Kafka topics are keyed by
  `workspace_id` / `project_id`; Redis rate-limit keys are one key per bucket (Cluster-safe).
- **GPU work never sits on the request path.** Requests enqueue; workers drain at the rate GPUs allow. More
  users means longer queues per plan priority, not more failures. That is what makes "1B concurrent" a
  question about the *front door*, not about GPUs.

## Assumptions

| Symbol | Meaning | Value |
|---|---|---|
| `c` | Concurrent users | 1M / 10M / 100M / 1B |
| `r` | API requests per concurrent user per second (browsing, polling, autosave) | 0.05 *(A)* — one request every 20 s |
| `w` | Share of requests that write | 0.15 *(A)* |
| `g` | Generations started per concurrent user per hour | 0.02 *(A)* |
| `G_gw` | Gateway pod throughput at p99 < 150 ms (2 vCPU) | 6,000 RPS *(A)* |
| `G_api` | Service pod throughput (identity / studio API, 2 vCPU) | 800 RPS *(A)* |
| `G_led` | Ledger writes per pod | 1,500 /s *(A)* |
| `SQL_w` | Writes per distributed-SQL node (8 vCPU) | 4,000 /s *(A)* |
| `K_p` | Messages per Kafka partition | 5,000 /s *(A)* |
| `cell` | Concurrent users one cell is sized for | 1,000,000 *(A)* |
| `GPU_min` | Video minutes rendered per GPU per hour | 30 *(A)*, depends entirely on the model |

Headroom: every pod count includes 40 % headroom (×1.4) for failover and spikes.

## Per tier

Requests per second `R = c × r`. Writes `W = R × w`. Generations per hour `J = c × g`.

| Concurrent users | 1M | 10M | 100M | 1B |
|---|---:|---:|---:|---:|
| API RPS `R` | 50 k | 500 k | 5 M | 50 M |
| Write RPS `W` | 7.5 k | 75 k | 750 k | 7.5 M |
| Gateway pods `⌈R/G_gw × 1.4⌉` | 12 | 117 | 1,167 | 11,667 |
| Service pods `⌈R/G_api × 1.4⌉` | 88 | 875 | 8,750 | 87,500 |
| Ledger pods (credit writes ≈ 5 % of W) | 1 | 4 | 35 | 350 |
| SQL nodes `⌈W/SQL_w × 1.4⌉` (× 3 replicas) | 3 × 3 | 27 × 3 | 263 × 3 | 2,625 × 3 |
| Kafka partitions (events ≈ 2 × W) `⌈2W/K_p × 1.4⌉` | 5 | 42 | 420 | 4,200 |
| Cells `⌈c / cell⌉` | 1 | 10 | 100 | 1,000 |
| Generations per hour `J` | 20 k | 200 k | 2 M | 20 M |
| GPUs for 1-minute videos `⌈J/GPU_min⌉` | 667 | 6,667 | 66,667 | 666,667 |

## What the numbers say

1. **The front door is not the bottleneck.** 50 M RPS at 1B users is 1,000 cells of ~50 k RPS each — an
   ordinary size for one cell. Nothing in the code is shared across cells except the cell-router lookup,
   which is cached and changes only when a workspace is created or moved.
2. **GPUs are.** At the assumed rate, 1B concurrent users would start 20 M generations an hour, needing
   on the order of 10⁵–10⁶ GPUs — more than exist for one product. In practice the system protects itself:
   generation is queued per plan priority and per-cell GPU quota, so paid plans keep their latency and free
   plans wait. The real lever is cost per video minute, which the admin dashboard now reports.
3. **Per-workspace hot spots** (one huge team) are bounded by per-workspace rate limits and concurrent-job
   limits (plan table), so a single tenant cannot saturate a cell.

## How to replace the assumptions

1. `docker compose -f infra/compose/docker-compose.yml up -d` and `node scripts/dev.mjs --prod` on a known machine size.
2. `k6 run infra/k6/gateway-read.js` and `infra/k6/ledger-write.js`; note RPS at the p99 threshold per pod.
3. Generate 100 videos with real providers; read **cost per video minute** and minutes per GPU-hour from Admin & Analytics.
4. Update the *(A)* values above and re-run the arithmetic.
