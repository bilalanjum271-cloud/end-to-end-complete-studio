# Analytics and big-data layer (Phase 4)

**Status: written, not run.** None of these engines could run in the build sandbox. The event
contract they consume *is* real and tested: `services/studio/xen_studio/events/relay.py` moves every
outbox row to Kafka (or, locally, to date-partitioned JSON lines under `.lake/`).

```
services ──(outbox, same transaction)──► relay ──► Kafka topics (docs/source, "Kafka topics")
                                                    │
               ┌────────────────────────────────────┼─────────────────────────────┐
               ▼                                    ▼                             ▼
     Flink: live cost + fraud signals     Kafka Connect → Iceberg (S3)     ClickHouse Kafka engine
     (flink/live_cost_fraud.sql)          raw zone, partitioned by day     (clickhouse/schema.sql)
               │                                    │                             │
               ▼                                    ▼                             ▼
     alerts + fraud flags topic            Spark / dbt marts (dbt/)        admin dashboards (<1 s)
                                           orchestrated by Airflow (airflow/)
```

| Piece | File | What it does |
|---|---|---|
| ClickHouse | `clickhouse/schema.sql` | Kafka-engine ingest tables, `events` MergeTree partitioned by month and ordered by (workspace, time), materialized views for cost per minute and daily revenue |
| Flink SQL | `flink/live_cost_fraud.sql` | 1-minute tumbling windows: provider cost per workspace, credit burn spikes, signup bursts per IP block, refund-rate anomalies |
| dbt | `dbt/` | staging models over the Iceberg raw zone, marts for revenue, unit economics (cost per video minute, the number the Master Stack says to measure before pricing), retention |
| Airflow | `airflow/xen_daily.py` | daily: dbt build → data-quality tests → publish marts; fails loudly on freshness or row-count anomalies |
| Data quality | dbt tests | uniqueness of event ids, non-null keys, accepted values, freshness < 2 h |
| Catalog and lineage | dbt docs + OpenLineage (Airflow provider) | lineage from topic to mart is emitted per run |

The Admin dashboard reads the operational database today (`/v1/admin/overview`). When event volume
makes that expensive, the same endpoint switches to ClickHouse; the response shape does not change.
