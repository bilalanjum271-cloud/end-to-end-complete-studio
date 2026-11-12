-- ClickHouse: real-time analytics store for the Admin dashboard. Written, not run.
CREATE DATABASE IF NOT EXISTS xen;

-- 1. Kafka ingest: one engine table per topic family, all with the relay's envelope.
CREATE TABLE IF NOT EXISTS xen.events_kafka (
  event_id String, workspace_id String, topic String, event_type String, created_at DateTime64(3, 'UTC'), payload String
) ENGINE = Kafka
SETTINGS kafka_broker_list = 'kafka:9092',
         kafka_topic_list = 'project.events,job.completed,job.failed,render.completed,credits.reserved,credits.debited,credits.refunded,credits.granted,moderation.decisions,user.activity',
         kafka_group_name = 'clickhouse-events', kafka_format = 'JSONEachRow', kafka_num_consumers = 8, kafka_skip_broken_messages = 100;

-- 2. Durable store. ReplacingMergeTree on event_id makes the relay's at-least-once delivery idempotent.
CREATE TABLE IF NOT EXISTS xen.events (
  event_id String, workspace_id String, topic LowCardinality(String), event_type LowCardinality(String),
  created_at DateTime64(3, 'UTC'), payload String CODEC(ZSTD(3))
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (workspace_id, created_at, event_id)
TTL toDateTime(created_at) + INTERVAL 25 MONTH TO VOLUME 'cold'
SETTINGS storage_policy = 'hot_cold';

CREATE MATERIALIZED VIEW IF NOT EXISTS xen.events_mv TO xen.events AS SELECT * FROM xen.events_kafka;

-- 3. Pre-aggregations the dashboard reads directly.
CREATE TABLE IF NOT EXISTS xen.provider_cost_daily (
  day Date, provider LowCardinality(String), job_type LowCardinality(String), jobs UInt64, failed UInt64, cost_microusd UInt64
) ENGINE = SummingMergeTree ORDER BY (day, provider, job_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS xen.provider_cost_daily_mv TO xen.provider_cost_daily AS
SELECT toDate(created_at) AS day,
       JSONExtractString(payload, 'provider') AS provider,
       JSONExtractString(payload, 'type') AS job_type,
       count() AS jobs, countIf(topic = 'job.failed') AS failed,
       sum(JSONExtractUInt(payload, 'cost_microusd')) AS cost_microusd
FROM xen.events WHERE topic IN ('job.completed', 'job.failed') GROUP BY day, provider, job_type;

CREATE TABLE IF NOT EXISTS xen.credits_daily (day Date, workspace_id String, granted Int64, debited Int64, refunded Int64)
ENGINE = SummingMergeTree ORDER BY (day, workspace_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS xen.credits_daily_mv TO xen.credits_daily AS
SELECT toDate(created_at) AS day, workspace_id,
       sumIf(JSONExtractInt(payload, 'amount'), topic = 'credits.granted')  AS granted,
       sumIf(JSONExtractInt(payload, 'amount'), topic = 'credits.debited')  AS debited,
       sumIf(JSONExtractInt(payload, 'amount'), topic = 'credits.refunded') AS refunded
FROM xen.events WHERE topic LIKE 'credits.%' GROUP BY day, workspace_id;
