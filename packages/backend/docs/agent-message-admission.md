---
title: "Chat message admission"
description: "Durable acceptance and dispatch recovery for repository chat messages."
---

## Acceptance

The repository chat message API commits a user message, its parts, and its
execution request in one PostgreSQL transaction before returning HTTP 201.
The saved input includes the provider, transport, changeset, and allowed paths.
Finding repairs, conflict repairs, and returned landing reviews use the same
admission boundary.
HTTP 201 means accepted; execution runs in a background worker.

A pending or uncertain dispatch prevents another user message from starting
parallel execution in the same chat. An admission failure rolls back the
message and returns an error. Assistant, tool, and system messages do not
request execution.

## Recovery

The worker consumes only `agent-run-dispatch` requests. A replacement process
can claim an accepted request without the original API process. Expired leases
before dispatch are recoverable; temporary capacity refusals retry before any
execution effects. Workspace capacity uses the workspace service's existing
quota check before run creation. Capacity changes after run creation can leave
a partial dispatch, which remains uncertain until reconciliation. Shutdown before execution leaves the request recoverable. Deterministic plan
or runtime refusals fail without recording an execution effect. Closing the chat
settles a queued request without dispatching it. Before run creation, the worker
persists an external-effect marker: a crash or dispatch failure after this marker records an
`uncertain` outcome and prevents automatic redelivery. An operator must
reconcile that outcome before retrying, because provisioning is not idempotent.

Preflight failures remain in the durable request receipt. A completed dispatch
receipt records the execution identity; it does not mean the execution finished.
Credentials are never included in these receipts.

## Resolve an uncertain dispatch

List requests that need reconciliation:

```sql
SELECT tenant_id, principal_id, request_id, payload->>'SessionID' AS chat
FROM product_job_requests
WHERE operation = 'agent-run-dispatch' AND state = 'uncertain';
```

First stop the old dispatcher and inspect the associated run and provider
resources. Stop or clean up abandoned resources before recording a failed or
cancelled dispatch; record completed only when dispatch actually succeeded.
The database operator can then record that evidence:

```bash
SMITHERS_DATABASE_URL="$DATABASE_URL" go run ./packages/backend/cmd/resolve-agent-message \
  --repository 123 --user 456 --message 789 --outcome failed \
  --evidence 'Old dispatcher exited; abandoned VM removed; no live run remains'
```

The command accepts `completed`, `failed`, or `cancelled` only for an uncertain
request. It records the evidence and releases its admission block without
launching execution. A live associated run still prevents a new message. A
failed or cancelled request can be followed by a new user message once cleanup
is complete.
