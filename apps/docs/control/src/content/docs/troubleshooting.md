---
title: "Troubleshooting"
description: "The refusals @smthrs/control reports, the symptom each one shows up as, what causes it, and what to change: typed failures, unexpected receipts, and empty projections."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/troubleshooting.md"
---

Every failure this package reports is a typed class with a stable `code` a
client may branch on. `ControlError.ControlErrorSchema` is the single
membership list, and `ControlClient.isControlError` is derived from it.

## Typed failures

### `PlanNotFound` (`plan_not_found`)

No plan or node approval token with this id. The message names the next action:
create the plan again before approving or launching it.

A common cause is a plane that restarted on `ControlRuntime.layerMemory`.
Nothing that runtime decides survives the process. Move to
[`SqlControlRuntime`](/guides/durable-storage/).

### `PlanDenied` (`plan_denied`)

The plan was denied and cannot be launched. A denial is terminal: create and
approve a new plan rather than trying to revive this one.

### `PlanDigestMismatch` (`plan_digest_mismatch`)

The submitted digest is not the stored one, and the failure carries both.
Resubmit the card unchanged: `card.approval` and `card.digest` are the exact
values the plan phase produced. Rebuilding an approval payload on the client is
how the two drift apart.

If the digests differ for the _same_ input, something in the plan changed:
the envelope, the deploy-class flag, or the keyed node graph. That is the check
working.

### `EnvelopeMismatch` (`envelope_mismatch`)

The submitted envelope is not the stored one. Envelopes are compared by
canonical bytes, so key order does not matter but a missing or extra capability
does. Pass `card.envelope` through unchanged.

### `AlreadyResolved` (`already_resolved`)

This approval token already carries a terminal decision. A second decision is
refused rather than overwriting the first, so this is also the durable evidence
that the first decision stuck.

### `FlowNotFound` (`flow_not_found`)

The runtime has no flow with this id. The control plane's catalog and the
engine's registrations are separate on purpose: one is what may be planned, the
other is what may be executed. Add the flow to the runtime's `flows` option, or
to the registry the plane lists from.

### `RunNotFound` (`run_not_found`)

This plane has no such run. Two causes are worth separating:

- The run id is wrong. Confirm it with [`list`](/guides/list-runs/).
- The run exists in the _engine's_ database and this plane keeps its own. See
  [two run tables, one journal](/concepts/authority/).

### `ClaimLost` (`claim_lost`)

A live peer holds the run, or the fence you presented has been superseded. A
run at `running`, or at the `accepted` a claim writes, is being driven by
another process, so there is nothing to restart.

Do not retry in a loop. Read the run's `ownerId` and `parkedBy`, and see
[Ownership, fences, and claims](/concepts/ownership/).

### `NoMatchingWait` (`no_matching_wait`)

The signal named a wait point the run does not have open. The message says
which run and which name; `smthrs runs show <run>` shows what it waits for. The run is
parked on something else, so completing this wait would deliver nothing.

### `InvalidInput` (`invalid_input`)

The request did not satisfy its schema or a stated precondition. The `issue`
field names the path. The ones you will actually meet:

| `issue`                                                                                   | Fix                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `afterSequence: a watch cursor resumes one run, so it requires runId`                     | Scope the watch. Sequences are partition-local.                                      |
| `limit: must be an integer between 1 and 500, received 0`                                 | Use a page size in range, or omit it for 100.                                        |
| `cursor: must be a cursor this listing returned, received "..."`                          | Pass back `nextCursor` verbatim.                                                     |
| `message.runId: must be "run-17", received "run-18"`                                      | The steer's envelope and the call must name one run.                                 |
| `<operation>: contains an accessor` (or a cycle, a non-plain object, a non-finite number) | Pass plain JSON data. The identity boundary refuses anything it cannot copy inertly. |
| `<operation>.idempotencyKey: must be 1 to 1024 well-formed characters`                    | Shorten the key, or remove the lone surrogate or NUL.                                |
| `webhook body: declared N bytes exceeds the M byte limit`                                 | Raise the mount's ceiling, or send less.                                             |

### `Unauthorized` (`unauthorized`)

No usable credential. The bearer authenticator fails closed the same way for a
missing, malformed, empty, or incorrect token, so the response never says which.
Check that the client's `credential` and the server's `token` are the same
string.

`Credential` also reports `Unauthorized` for a credential that does not exist,
deliberately indistinguishable from one the caller may not have.

### `Unavailable` (`unavailable`)

The operation is not implemented in this composition. `feature` names the verb
or capability that is missing, and `ticket` is a constant identifier for the
integration behind it, stable enough to group reports by.

| `feature`                                     | Cause                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| any `Control` verb                            | `Control.layerNoop` is provided. Provide `ControlLive.layer`.      |
| `watch`                                       | The composition has no open journal.                               |
| `credential storage`, `credential encryption` | A noop store or cipher is provided, or the host has no Web Crypto. |
| `channel "<name>" is not registered`          | Call `channels.register` before the first request arrives.         |

### `CredentialConflict` (`credential_conflict`)

Two rotations raced, and this one read the older version. The failure carries
`expectedVersion` and `actualVersion`. Re-read the record and rotate again.

A `rotate` with `expected` also fails this way, with both versions equal, when
the stored secret is no longer `expected`: another writer already replaced it.

### `LaunchFailed` (`launch_failed`)

The executor refused or could not start the run. The plane settles the run row
as `failed` and journals `control.run.failed` with the cause, so the run does
not survive as an unlaunched row no verb can end. The admission receipt remains;
inspect that run before an explicit retry with a new idempotency key.

### `PersistenceError` (`persistence_failed`)

A store operation failed. `operation` names what was being attempted and
`cause` keeps the driver's own error. A `<operation>.idempotency` operation
means the mutation and its receipt could not be committed atomically.

Operation `watch` means a journal read failed while serving a watch.
Operation `credential.open` means a stored credential did not open: its nonce
is malformed, or its ciphertext failed authentication because the key is not
the one that sealed it, its metadata changed, or its bytes were tampered with.

### `TransportError` (`transport_error`)

The request failed before a declared control response reached the caller. Only
`retryable` transport phases are worth resending, and only when the mutation
carries an idempotency key that makes replay safe. See
[Serve the control plane over RPC](/guides/serve-over-rpc/).

## Receipts that surprise people

### `run` answered `Parked`, and nothing started

The plan is undecided. That is the approval gate working: approve
`card.approval` and call `run` again with the same key. See
[Gate work behind an approval](/guides/approvals/).

### `cancel` answered `Terminal`, not `Accepted`

The run settled. Either it had already finished, or this call interrupted it
and it is now `cancelled`. Both are the true answer about the run;
`Accepted` is what you get when a live peer will act on the durable request
instead.

### A retry answered `Conflict`

The key already names a different mutation. The fingerprint is a digest of the
operation, the actor, and the decoded request, so any change to the request
under one key is a conflict. Use a new key for a new intent.

### `resume` answered `Terminal` for a run that looks parked

The plane read the run's terminality before the idempotency replay, so this is
the run's current state rather than a recorded answer. If the plane's row
disagrees with what you see elsewhere, the two are different databases.

## Projections that come back empty

### `waitingReason`, `origin`, and `cancellation` are always absent

Those fields are read from the engine's own columns and journal entries, so
they need the control runtime and the engine to share one database. The
[`smthrs` CLI](https://cli.smithers.sh/reference/api/) keeps `.flows/control.db` and `.flows/engine.db`
apart, and the fields are empty there by design. See
[Store control state in a database](/guides/durable-storage/).

They are also absent on `ControlRuntime.layerMemory`, which has no engine to
read.

### `steering.pending` is absent

The notification queue could not answer. The field is left absent rather than
guessed, because "not known" is representable and it is the truth.

### `watch` returned nothing for a run that exists

A watch of an empty partition is empty, not an error. Check that the run id is
the _execution_ id the engine journals under, which is the id the `Accepted`
receipt carried.

## Where to go next

- [Receipts and idempotency](/concepts/receipts/): why a second ask answers
  what it answers.
- [Ownership, fences, and claims](/concepts/ownership/): the model behind
  `ClaimLost` and `parkedBy`.
- [Errors on smithers.sh](https://smithers.sh/docs/reference/errors/): the same codes as an
  operator meets them.
