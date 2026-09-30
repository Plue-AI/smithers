# Burndown queue contract

The public flow accepts full READY assignment/result pairs for standalone-worker
recovery through the existing merge queue. A READY bundle belongs to one configured
repository; reject inconsistent repository identities before admission. Never edit
engine state by hand.
READY and quarantined members retain assignment, result, and claim identity
across rounds. Incomplete READY bundles enter quarantine, never landing. Missing
worker executions retain failure diagnostics and retry cooldown. Completion
requires both queues to drain. Repair keeps the
original claim owner and uses a new execution key for each attempt. Refresh
held claims only after checking ownership and hostname; never take over another
worker's claims. Enforce computed remaining account slots at launch.

Filtered, reserved and claimed open issues remain pending. Only a current
`will-only` GitHub label on an unclaimed issue excludes it from completion.
Historical closure or Will-only receipts are not current open-issue evidence.
Unknown usage or login failures are retryable observations, never proof that
all accounts are exhausted. Claim helpers resolve from the fixed host source
or an explicitly configured compatible path. Reset recovery polls live usage.
