-- The number the Master Stack says to measure before setting prices: provider cost per delivered video minute.
with jobs as (
  select date(created_at) as day, sum(cast(json_extract_scalar(payload, '$.cost_microusd') as bigint)) / 1e6 as provider_cost_usd
  from {{ ref('stg_events') }} where topic in ('job.completed', 'job.failed') group by 1
), renders as (
  select date(created_at) as day, sum(cast(json_extract_scalar(payload, '$.duration_ms') as bigint)) / 60000.0 as minutes
  from {{ ref('stg_events') }} where topic = 'render.completed' group by 1
), credits as (
  select date(created_at) as day, sum(cast(json_extract_scalar(payload, '$.amount') as bigint)) as credits_debited
  from {{ ref('stg_events') }} where topic = 'credits.debited' group by 1
)
select r.day, r.minutes, j.provider_cost_usd, c.credits_debited,
       j.provider_cost_usd / nullif(r.minutes, 0) as cost_per_minute_usd
from renders r left join jobs j using (day) left join credits c using (day)
