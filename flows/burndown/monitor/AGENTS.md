# Monitor inspection contract

Run every Smithers inspection through the watched checkout's
`packages/smithers/bin/smithers.mjs` using the observer's absolute Node executable.
Require the entry's real path to remain inside the watched checkout. Missing or
escaped entries produce unknown/unhealthy evidence; never fall back to global
`smthrs` or mutable observer source. Pass the canonical watched root explicitly
and clear inherited routing and Node loader overrides. The operator supplies a
frozen checkout with its own pinned dependencies. Preserve read-only inspection,
bounded execution, retained reports, and retries until confirmed terminal status.

Ground health in the watched root public durable journal and selected descendant
action/queue receipts. Wrapper turn counters and status notes never establish a
stall or authorize cancellation. Running long checks and scheduled waits are
distinct from failed checks and missing evidence. Preserve bounded, redacted
receipts and fail closed on incomplete inspections.

Evaluate the current round frontier; historical failures must not poison later
rounds. Skipped checks are unknown until successful completion confirms an untaken
branch, deferred checks are pending, and missing
current results remain partial/unknown. Flag overdue timers after two cadence
intervals without advising cancellation.

Use only `runs inspect` and non-following `runs logs` for status and journal
evidence. `show` and `devtools` reconcile history gaps and may write to stores.
The current round observation determines lineage liveness. A completed root
row is a handoff, not proof that later rounds ended. Completion requires a
current terminal round and its typed successful Complete result or explicit done
receipt. A Handoff result never confirms completion; incomplete lineage retries.
