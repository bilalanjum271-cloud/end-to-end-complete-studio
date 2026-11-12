# Runbook: deploy

**Status:** describes the intended pipeline. CI (`.github/workflows/ci.yml`) is written but has not run;
Helm charts, ArgoCD apps and Terraform are not written yet (see PROGRESS.md, Phase 1 remaining).

Order of operations for one release:

1. **Migrations first, and backward compatible.** Every migration must work with the previous release's code
   (add columns nullable or with defaults; never drop or rename in the same release that stops using them).
   Run `node scripts/migrate.mjs` against each cell's database. It is idempotent and records applied versions.
2. **Images.** CI builds and scans `gateway`, `ledger`, `cell-router`, `identity`, `studio`, `web`; tags are the git SHA.
3. **Canary cell.** Deploy to one cell first. Watch the Cell overview dashboard for 30 minutes: 5xx ratio,
   p99 latency, shed rate, breaker rejections, ledger replay ratio.
4. **Waves.** 10 % of cells, then 50 %, then all, with a 30-minute hold between waves.
5. **Feature flags** gate new user-facing behaviour independently of the deploy (flag service: not built yet).
6. **Workers.** Temporal workers can be deployed at any time: workflow code changes must use Temporal
   versioning (`workflow.patched`) so running workflows replay correctly.
