select date(created_at) as day, workspace_id,
       sum(case when topic = 'credits.granted' then cast(json_extract_scalar(payload, '$.amount') as bigint) else 0 end) as credits_granted,
       sum(case when topic = 'credits.debited' then cast(json_extract_scalar(payload, '$.amount') as bigint) else 0 end) as credits_debited,
       sum(case when topic = 'credits.refunded' then cast(json_extract_scalar(payload, '$.amount') as bigint) else 0 end) as credits_refunded
from {{ ref('stg_events') }}
where topic like 'credits.%'
group by 1, 2
