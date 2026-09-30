# Burndown queue contract

The public flow accepts full READY assignment/result pairs for standalone-worker
recovery through the existing merge queue. A READY bundle belongs to one configured
repository; require owner/name assignment identities and resolve configured short
names through the existing issue selection contract before admission. Never edit
engine state by hand.
READY and quarantined members retain assignment, result, and claim identity
across rounds. Incomplete READY bundles enter quarantine, never landing. Missing
worker executions retain failure diagnostics and retry cooldown. Poll defects
keep the worker running and its claims held; cancellation remains cancellation. Completion
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

Retained Cloud handoff anchors reconstructed commits to the verified artifact
base, independent of the shared checkout parent. Extract only artifact paths;
leave shared work, protected bookmarks and prepared revisions intact. The queue
owns subsequent rebasing, including conflicts with newer main changes. Preserve
current main bytes during historical extraction; refuse uncommitted owned edits
and conflicting prepared local work. Complete retained mappings qualify against
the artifact alone without touching shared paths.

A pushed change is separate from issue completion. Final exact-revision
review assesses the entire current issue against executed evidence and emits one
typed disposition per issue. Complete closes only satisfied acceptance; landed
prerequisites stay open with concrete issue-backed remaining requirements.
Missing or contradictory evidence never completes. Persist acceptance before
push and the confirmed push before issue writes. Receipt failures retain original
READY work for receipt replay, never a new coding repair or duplicate push.

The dashboard requires an explicit watched run and report directory. Read selected
engine ancestry and lineage through read-only SQLite; never reconcile stores or
select a newest run. Report/log evidence requires a matching canonical host/run
scope receipt. Missing, stale, corrupt or foreign evidence stays unknown; port
collisions fail and never adopt another dashboard.
Dashboard snapshots use a short read-only SQLite transaction over the selected
lineage and close it after each read, including WAL-mode stores. Never write
logical engine/control data, reconcile through the CLI, checkpoint or change
journal mode. Normal SQLite shared-memory and read-lock coordination is allowed;
never use immutable reads or unlocked database/WAL copies for changing stores.
Busy, corrupt and missing evidence remains visibly unknown.
