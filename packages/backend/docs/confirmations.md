---
title: "Person confirmations"
description: "Private approval storage, session decisions and unavailable dispatch boundaries on an install."
---

Person confirmations use `approvals`, with a nullable agent-session reference
and a requesting member, immutable credential identity, command, subject and
revision. Review & merge also carries generation and reviewed PR head. Legacy
repository approval endpoints exclude these rows; they continue to serve run
waits.

The install mounts `GET /api/confirmations` for the caller's rows. Browser
sessions receive the full projection; eligible delegated credentials receive
only `id` and `state`. Run and machine credentials cannot read the projection.
`confirmations:<member-id>` is a private browser-session live topic; other
members and delegated subscribers are refused.

`POST /api/confirmations/{id}/deny` requires the requesting member's browser
session and current permission for the bound command. It transitions pending
to rejected using the existing pending-row CAS. The browser credential and
Idempotency-Key bind a denial receipt; a retry returns the receipt, and reuse
for another confirmation or action returns `409 idempotency_mismatch`.
An elapsed expiry settles pending to expired before a decision.

`ApprovalsService` also implements delegated creation and session approval for
appending a TODO and dropping an unmerged TODO. The command policy is generated
from the same Operation descriptors as the CLI and model host. Explicit creation
and eligible command dispatch share this service; the TODO control route shares
its body resolver with the dispatcher.

Creation stores the exact canonical input and subject revision without changing
the TODO. Its identity combines the install repository, immutable requesting
credential and Idempotency-Key. An identical retry returns the current state;
reusing the key for another request conflicts. The model host accepts all four
confirmation states but retains only the confirmation ID and state.

Approval reloads the person's session and membership after acquiring the
repository, credential and subject locks. It runs the existing TODO service in
a savepoint inside the approval transaction, then commits the pending-row CAS
and TODO effect together. A failed CAS rolls back the TODO, its scheduling and
its durable events. Revision changes expire the confirmation. A finished agent
turn does not prevent its person from approving later with a fresh session.
Cancellation needs no action consumer and grants no execution authority.

The install composes the real TODO consumer for append and drop. Its browser
reads the caller's private rows into ApprovalCard and the shared ConfirmView.
Approve and Cancel use the person-only approval flows, persist one key per
press, and continue in the background. A 202 does not finish the toast; the
TODO subject's terminal observation does. Reload reconnects admitted progress,
and changed identities discard late responses. Private card payloads never
enter the model's recent-card context.

The composed HTTP test exercises request, private projection, approval, denial
and replay without a test-only confirmation service override. The browser
journey uses the composed install router, PostgreSQL and private live transport
without browser API mocks. Merge and real-machine acceptance remain separate.
Missing consumers return `503 infra/confirmation_unavailable` and leave pending
rows unchanged. Issue-derived TODOs, non-append placement and other commands,
including Review & merge, still require their qualified consumers.
