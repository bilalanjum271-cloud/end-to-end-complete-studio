# Runbook: rollback

1. **Stop the wave.** Pause the rollout; cells already upgraded keep serving.
2. **Roll back images**, not the database: redeploy the previous SHA to affected cells. Because migrations are
   backward compatible (see deploy.md), the previous code runs against the new schema.
3. **Credits are safe to retry.** Any job that failed mid-deploy is retried or refunded by its workflow; ledger
   writes are idempotent, so repeated reserve/commit/release calls never double-charge.
4. **Never roll back a migration in a hurry.** If a migration itself is wrong, write a forward fix.
5. **Stuck reservations** (held > 24 h): list with
   `SELECT workspace_id, id, amount FROM credit_reservations WHERE status='held' AND created_at < now() - interval '24 hours';`
   and release each through `POST /internal/v1/workspaces/{ws}/reservations/{id}/release` with key `manual-release:{id}`.
