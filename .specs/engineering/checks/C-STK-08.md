# C-STK-08 Independent waits give the §4.1.0a state; resume leaves Starting; merges on GitHub win

Folded into T-STK-01's tests (minimal-code synthesis, 2026-10-03).

## Guest qualification

Sequence 3 jointly exercises T-STK-08: Stop and engine park, main sync and native conflict, member file repair and Done, then same-run Resume through queued, starting and working. The reference entry uses the existing approved-bundle microVM composition without a process fallback.

From `packages/backend`, run:

```sh
SMITHERS_TODO_FOLDED_CONFLICT_MICROVM=1 SMITHERS_CHECK_BUNDLE=<approved-installed-bundle> \
  go test -p 4 ./internal/compose -run '^TestTodoFoldedPausedConflictResumeMicroVM$' -count=1 -v -timeout=20m
```

Requires the reference Mac, installed smithers-machined, native repository helper and PostgreSQL with a private test namespace. Linux process receipts do not qualify guest isolation or reference timing. Human/GitHub acceptance and the attachment latency receipt remain separate requirements.
