-- Flink SQL: live cost and fraud signals. Written, not run.
-- Output goes to the `ops.signals` topic, consumed by alerting and by the admin dashboard.

CREATE TABLE events (
  event_id STRING, workspace_id STRING, topic STRING, event_type STRING,
  created_at TIMESTAMP_LTZ(3), payload STRING,
  WATERMARK FOR created_at AS created_at - INTERVAL '10' SECOND
) WITH ('connector' = 'kafka', 'topic-pattern' = '(job|credits|user)\..*', 'properties.bootstrap.servers' = 'kafka:9092',
        'properties.group.id' = 'flink-signals', 'scan.startup.mode' = 'latest-offset', 'format' = 'json');

CREATE TABLE signals (
  window_end TIMESTAMP_LTZ(3), signal STRING, workspace_id STRING, value DOUBLE, threshold DOUBLE
) WITH ('connector' = 'kafka', 'topic' = 'ops.signals', 'properties.bootstrap.servers' = 'kafka:9092', 'format' = 'json');

-- Provider spend per workspace per minute: catches runaway jobs and leaked API keys.
INSERT INTO signals
SELECT window_end, 'provider_cost_spike', workspace_id, cost_usd, 5.0
FROM (
  SELECT window_end, workspace_id, SUM(CAST(JSON_VALUE(payload, '$.cost_microusd') AS BIGINT)) / 1e6 AS cost_usd
  FROM TABLE(TUMBLE(TABLE events, DESCRIPTOR(created_at), INTERVAL '1' MINUTE))
  WHERE topic IN ('job.completed', 'job.failed')
  GROUP BY window_start, window_end, workspace_id
) WHERE cost_usd > 5.0;

-- Credit burn: more than 500 credits reserved in 5 minutes by one workspace.
INSERT INTO signals
SELECT window_end, 'credit_burn', workspace_id, credits, 500
FROM (
  SELECT window_end, workspace_id, SUM(CAST(JSON_VALUE(payload, '$.amount') AS BIGINT)) AS credits
  FROM TABLE(HOP(TABLE events, DESCRIPTOR(created_at), INTERVAL '1' MINUTE, INTERVAL '5' MINUTE))
  WHERE topic = 'credits.reserved'
  GROUP BY window_start, window_end, workspace_id
) WHERE credits > 500;

-- Refund ratio: a workspace whose jobs keep failing (provider abuse or a broken integration).
INSERT INTO signals
SELECT window_end, 'refund_ratio', workspace_id, refunded * 1.0 / NULLIF(reserved, 0), 0.5
FROM (
  SELECT window_end, workspace_id,
         SUM(CASE WHEN topic = 'credits.refunded' THEN 1 ELSE 0 END) AS refunded,
         SUM(CASE WHEN topic = 'credits.reserved' THEN 1 ELSE 0 END) AS reserved
  FROM TABLE(TUMBLE(TABLE events, DESCRIPTOR(created_at), INTERVAL '15' MINUTE))
  WHERE topic IN ('credits.refunded', 'credits.reserved')
  GROUP BY window_start, window_end, workspace_id
) WHERE reserved >= 5 AND refunded * 1.0 / reserved > 0.5;

-- Signup burst from one /24 (user.activity events carry the gateway's client ip prefix).
INSERT INTO signals
SELECT window_end, 'signup_burst', ip_prefix, CAST(n AS DOUBLE), 20
FROM (
  SELECT window_end, JSON_VALUE(payload, '$.ip_prefix') AS ip_prefix, COUNT(*) AS n
  FROM TABLE(TUMBLE(TABLE events, DESCRIPTOR(created_at), INTERVAL '10' MINUTE))
  WHERE topic = 'user.activity' AND event_type = 'signup'
  GROUP BY window_start, window_end, JSON_VALUE(payload, '$.ip_prefix')
) WHERE n > 20;
