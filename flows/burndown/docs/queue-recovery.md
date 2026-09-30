# Queue recovery

The `burndown` flow accepts an optional `ready` array of complete
`{ assignment, result }` pairs using the schemas in `../schema.ts`. Supply the
original assignment key and issue bundle, and a `ready` result containing the
prepared commits in issue order. Start through the normal public flow entry;
it feeds those members into the existing merge queue. Claims must still belong
to `burndown-<assignment.key>` on the queue host. This entry does not transfer
claims or require editing the engine database.

With `BURNDOWN_LAND=off`, READY members remain pending and the run stays active.
After landing is enabled, successful members leave the queue. A failed landing
retains its full assignment, result and failure evidence until a repair worker
starts. Repair preserves the claim owner and passes that evidence to the worker,
using a new execution identity. Refused claims or launches leave the member
pending for a later round. Completion requires running workers, READY members,
quarantined members and selected pending work to drain.

Open issues skipped by dispatch filters or held by another worker remain
pending. Only current `will-only` labels on unclaimed issues permit Will-only
completion; historical classifications do not. Unknown quota keeps observation
retryable and never produces an all-accounts-exhausted notice. Reset recovery
rechecks usage on the normal tick, or within ten minutes of measured exhaustion.
Claim helpers default to the host repository; `BURNDOWN_ISSUE_CLAIM_SCRIPT` can name
an explicit compatible helper.
