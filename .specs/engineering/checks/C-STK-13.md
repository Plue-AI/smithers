# C-STK-13 Pre-approved TODOs merge only when MergeReady holds

Folded into T-STK-04’s tests, including maintainer-applier preservation and pre-approval races.

The composed rebase/check integration is
`TestTodoPreapprovalProductionRebaseComposed` in
`packages/backend/internal/compose/todo_preapproval_rebase_integration_test.go`.
Run with `SMITHERS_PREAPPROVAL_REBASE_REHEARSAL=1` and the real PostgreSQL
test URL. It creates both TODOs and their attributed pre-approvals through
HTTP, lets production workers rebase and verify after the preceding squash,
and delivers duplicate signed check hints before asserting ordered,
exactly-once merges at the current heads. It retains the GitHub write log,
candidate/check rows and HTTP evidence under `.artifacts/checks/C-STK-13/rehearsal/`.
Linux process rehearsals do not qualify the reference Mac mini journeys.
