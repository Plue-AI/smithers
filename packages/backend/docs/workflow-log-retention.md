---
title: Workflow log retention
description: How long Smithers keeps workflow output.
---

Smithers retains workflow output until 30 days after the run completes.
Active runs keep their output. Older entries from completed runs are deleted
when background workers start and once an hour afterward. Entries and runs
exactly at the retention cutoff remain until a later sweep.

Each database batch deletes at most 1,000 entries from one run, for both step
and run-level output. A sweep uses a fixed cutoff and stops after 30 seconds;
any remaining backlog is retried at the next sweep. Locked runs are skipped
and retried later. Deletion releases the run's log budget through existing
database accounting triggers.

Apply product migrations before starting the updated backend. On an existing
installation, build the indexes online before applying migration 73 to avoid
blocking log writes during index construction. Run each statement outside a
transaction; the migration then reuses these indexes.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_runs_log_retention
ON workflow_runs (completed_at, id)
WHERE status IN ('success', 'failure', 'cancelled');
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_logs_retention
ON workflow_logs (workflow_run_id, created_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_run_logs_retention
ON workflow_run_logs (workflow_run_id, created_at, id);
```

If an online build is interrupted, inspect `pg_index.indisvalid`, drop any
invalid index with `DROP INDEX CONCURRENTLY`, and retry before migration.
Sweep failures are logged and increment
`smithers_cleanup_sweep_failures_total{cleaner="workflow_log"}`.
