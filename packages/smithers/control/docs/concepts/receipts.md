---
title: "Receipts and idempotency"
description: "The five receipts a control mutation can answer, the bounded identity boundary every mutation crosses first, and why cancel and resume read a run's terminality before replaying a recorded receipt."
sidebar:
  order: 2
---

Every control mutation answers a `Receipt` rather than throwing on a second
ask. A receipt is the plane's whole answer to "did my request take effect, and
what happened to it?".

| Receipt          | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `Accepted`       | This call admitted the mutation. Carries `receiptId`, and `runId` when a run exists.    |
| `AlreadyApplied` | An earlier call under this key admitted the mutation. Carries the same `runId`.         |
| `Parked`         | The plan is waiting for an approval. Carries `planId` and `status: "waiting-approval"`. |
| `Conflict`       | The key names a different intent than the one it was first used for. Carries a message. |
| `Terminal`       | The run had already settled. Carries `runId` and the status it settled with.            |

`plan` is the exception: it returns a `PlanCard`, because a plan is a value to
review rather than an outcome to acknowledge.

## The identity boundary

Before a mutation waits on anything, it copies its own input and decodes the
copy. Nothing downstream ever sees the caller's object.

The copy admits only enumerable own data properties, so an accessor, a
`toJSON`, a sparse array, a symbol key, a cycle, a non-plain object, or
ill-formed text is refused with `InvalidInput` before a collaborator is
touched. That is not defensive tidying: a getter that returns one value to the
fingerprint and another to the write is the whole exploit.

The copy is also bounded:

| Bound                               | Value                             |
| ----------------------------------- | --------------------------------- |
| Canonical bytes                     | 4 MiB                             |
| Nesting depth                       | 128                               |
| Total JSON values                   | 100,000                           |
| Total array items and object fields | 100,000                           |
| Idempotency key length              | 1 to 1,024 well-formed characters |

## What a key identifies

The durable key is the operation, the caller's key, and, when a principal is
present, a digest of that principal's stable `kind` and `id`. The stamped
`stampedAt` is deliberately excluded: it is a wall clock, and keeping it made a
bearer authenticated retry of one cancel look like a different mutation under
the same key.

Beside the key the runtime stores a **fingerprint**: a canonical SHA-256 digest
of the operation, the actor's `id` and `kind`, and the decoded mutation with
its two server-stamped `principal` fields removed. A second call whose
fingerprint matches replays the recorded receipt. A second call under the same
key with a different fingerprint answers `Conflict`, which is the honest answer
to "this key already means something else".

Only `input.principal` and `input.message.principal` are removed, and only at
their own depth. A `principal` nested inside a signal payload is part of the
fingerprint, because two signals that differ only there are two different
signals.

## Replay, and the two mutations that do not replay it

For a mutation that changes something once, the recorded receipt is everything:
it is the proof the change was made, and replaying it is the whole guarantee.

`cancel` and `resume` are different, because their receipt is an answer _about
a run_, and the run moves on afterwards. Both read the run's terminality first,
before the idempotency lookup:

- `cancel` runs with replay disabled. A second ask re-executes, reads the run,
  and answers what is true now. A replayed answer would describe the moment of
  the first ask, so a caller could keep cancelling a run that never moved and
  keep being told it was cancelled.
- `resume` reads terminality before the replay for the same reason. Asking to
  restart a completed run must answer `Terminal`, not `AlreadyApplied`, which
  describes an earlier call and says nothing about the run you named.

Cancellation needs no receipt to be idempotent. The run's own terminality is a
stronger guarantee, and it is what the second ask reads.

## Run admission precedes execution

The run row, approval facts, and idempotency receipt commit before the plane
calls the executor. `Accepted` proves admission; the run's current status proves
whether execution started or finished. Another connection can read the committed
run as soon as the executor receives it.

If the executor refuses the launch, the plane records the run as failed and
retains its admission receipt. Repeating the same key returns `AlreadyApplied`
for that run. An explicit retry uses a new key. A failed admission commit never
reaches the executor.

If the admitting process dies after the commit and before the executor takes
the run, the run stays `accepted` under that process. Repeating the same key
once the process's heartbeat lease has lapsed claims the run and launches it,
then answers `AlreadyApplied` as usual. A live admitter keeps its run.

## A parked receipt is not recorded

`run` against an undecided plan answers `Parked` and records nothing. That is
what lets the [Quickstart](../quickstart.md) launch, park, approve, and launch
again under one key: the key was never spent on the refusal.

## Where a key comes from

A caller chooses it, and the choice is a contract with itself:

- A CLI or an operator uses something that names the intent:
  `deploy:v1.4.0`, `cancel:run-17`.
- A [channel](../guides/ingest-a-webhook.md) uses the platform's own delivery
  id, namespaced by the channel, so a webhook redelivery is the same mutation.
- A [monitor](../guides/monitor-runs.md) uses
  `monitor:<monitorId>:<remedy>:<runId>:<beat>`, so two monitors watching one
  run never share a key.

Reusing a key for a different intent is a caller mistake the plane reports
rather than absorbs.

## Where to go next

- [Ownership, fences, and claims](./ownership.md): the other reason a mutation
  refuses.
- [Cancel a run, and restart one](../guides/cancel-and-resume.md): the two
  verbs that read terminality first.
- [Troubleshooting](../troubleshooting.md): what each refusal means in practice.
