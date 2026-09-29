---
title: Workspace commands
description: Admit, inspect and cancel long-running workspace commands.
---

## Admit and poll

Under `/api/repos/{owner}/{repo}/workspaces/{id}`:

- `POST /command-runs` accepts `operation_id`, `args`, and optional `directory`
  and `environment`. It returns HTTP 202 with `operationId`, `requestId`,
  `state`, and `acceptedAt` after PostgreSQL admission, before runtime work.
- `GET /command-runs/{operationId}` returns `state` and, after completion,
  `result` with `exit_code`, `stdout`, `stderr`, and `output_truncated`.
- `POST /command-runs/{operationId}/cancel` records cancellation. HTTP 202
  means cancellation is pending; poll until the state is terminal.

```json
{"operation_id":"tests-1","args":["/bin/bash","-lc","pnpm test"]}
```

Repeat admission with the same ID and input to obtain the same receipt.
Different input returns 409. Receipts are scoped to the requesting account,
repository, and workspace. Polling checks current read access; admission and
cancellation require write access. Execution rechecks the active account,
repository permission, and workspace grant before calling the runtime.

Output becomes available at exit. Stored streams use base64 so NUL bytes survive
PostgreSQL JSONB; the API decodes them back to strings. Each output stream is bounded to 256 KiB in the
receipt; runtime adapters may impose a smaller bound. A nonzero command exit
still produces a completed receipt with its exit code. Runtime errors produce
`failed`; a lost execution lease produces `uncertain`. Neither state claims a
successful command. Commands have a 60-minute execution guard.

Command arguments, directory, and environment are encrypted with the backend's
configured secret codec before storage. Keep that key available for execution
and reattachment. Receipts and command output remain in PostgreSQL; do not
print secrets. There is no automatic receipt expiry.

The command worker has 32 slots, a two-minute lease, and one-second heartbeat
checks. Accepted commands wait when those slots are occupied. Transient
heartbeat failures retry only within the last confirmed lease; an outage past
that lease interrupts execution and produces an unknown outcome.

The worker uses the shared PostgreSQL jobs store independently of Flow-host
configuration. It fences non-idempotent effects before execution, so an
ambiguous launch is never retried automatically. Requests survive API-process
exit; interrupted execution may have partial effects and must be inspected
before submitting a new ID. Cancellation propagates to the runtime context and
is acknowledged after confirmed termination. A failed guest kill remains
uncertain; it does not produce a cancelled receipt. Runtime adapters must return
`workspace.ErrCommandCancelled` only after termination is confirmed; a
cancelled HTTP connection is insufficient. Hosted adapters that cannot provide
that proof leave cancellation uncertain until the infrastructure supplies it. Abrupt worker loss can leave an
uncertain outcome rather than a confirmed cancellation.

Hosted runtime adapters route to the VM's owning host. The trusted local
process runtime is used by the combined backend on one machine; it is not a
shared filesystem execution service for arbitrary replicas.

## CLI and agents

`smthrs workspace exec` uses these endpoints for both human and agent callers.
`--exec-id` supplies the retry identity. Ctrl-C and `--timeout` request
cancellation; network errors preserve the ID for reattachment. Interactive
input uses `workspace ssh` or `workspace shell`.

The synchronous `/commands` endpoint and SSH log-file command runner are
removed. API clients must use admission followed by polling.
