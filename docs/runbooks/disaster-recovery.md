# Runbook: disaster recovery

**Status:** procedure only. No multi-region deployment exists yet; nothing here has been drilled.

| Failure | Blast radius | Recovery |
|---|---|---|
| One pod / node | none (stateless, replicated) | automatic |
| One cell's region | that cell's workspaces | promote the cell's replica region (distributed SQL survives a region loss with 3-region placement); repoint the cell's endpoint in the cell router |
| Redis | rate limits become per-pod (degraded, tested) | restore; no data loss (Redis holds no source of truth) |
| Kafka | events queue in the SQL outbox (tested: relay retries) | restore; the relay drains the backlog in order |
| Object storage | media temporarily unavailable | cross-region replication on the media bucket; serve from the replica |
| Bad deploy | see rollback.md | |
| Data corruption | one workspace or more | point-in-time restore of the affected key range into a side database, then copy the workspace's rows back |

**Targets (to be validated by drills):** RPO ≤ 1 minute for SQL (synchronous replication), ≤ 15 minutes for
media; RTO ≤ 30 minutes for a full region.

**Drill (quarterly):** pick a staging cell, kill its primary region, time the recovery, verify that ledger balances
equal the sum of `credit_transactions` for every workspace in the cell:

```sql
SELECT a.workspace_id FROM credit_accounts a
LEFT JOIN (SELECT workspace_id,
                  SUM(CASE type WHEN 'grant' THEN amount WHEN 'refund' THEN amount WHEN 'reserve' THEN -amount ELSE 0 END) AS available
             FROM credit_transactions GROUP BY workspace_id) t USING (workspace_id)
WHERE a.available <> COALESCE(t.available, 0);   -- must return no rows
```
