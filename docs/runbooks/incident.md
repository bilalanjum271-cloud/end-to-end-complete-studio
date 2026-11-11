# Runbook: incident response (Phase 1 services)

1. **Triage** — open the Grafana "Cell overview" dashboard. Which alert fired, which service, which cell?
2. **Stabilise before diagnosing.** Roll back the last deploy if it correlates. Otherwise:

| Alert | What it means | First action |
|---|---|---|
| GatewayShedding <a id="overload"></a> | The cell is at its in-flight ceiling; low-priority traffic is being refused with 503 + Retry-After | Scale gateway and the slow upstream; if the cell is saturated, mark it `draining` in the cell router so new workspaces go elsewhere |
| UpstreamBreakerOpen | An upstream returned 5 consecutive 5xx / timeouts; the gateway rejects for 10s then probes | Check that upstream's `/readyz` and logs; the breaker closes by itself after one good probe |
| RateLimiterDegraded | Redis is unreachable; limits are enforced per pod, not globally | Restore Redis. Traffic keeps flowing; limits are looser by a factor of the replica count |
| HighErrorRate | >2% 5xx for 5 minutes | Find the request ids in logs (`request_id`, `trace`), check the database |
| ServiceDown | Scrape target is down | Restart; check readiness dependencies |

3. **Credits safety.** Ledger writes are idempotent. Retrying any reserve, commit, release or grant with the same
   `Idempotency-Key` is always safe and never moves credits twice. Stuck `held` reservations can be released
   with `POST /internal/v1/workspaces/{ws}/reservations/{id}/release`.
4. **Drain a cell:** `PUT /internal/v1/cells/{id}` with `"status":"draining"`. Existing workspaces stay; new ones go elsewhere.
5. **After:** write the timeline, root cause and follow-ups within two working days.
