-- One row per event from the Iceberg raw zone (written by Kafka Connect), deduplicated on event_id.
select event_id, workspace_id, topic, event_type, cast(created_at as timestamp) as created_at, payload
from (
  select *, row_number() over (partition by event_id order by created_at) as rn
  from {{ source('raw', 'events') }}
)
where rn = 1
