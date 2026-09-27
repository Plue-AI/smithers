---
title: "Submit an approval from a client"
description: "Read a pending gate, submit Approval.Submit with independent approval authority, and handle its typed refusals."
sidebar:
  order: 4
---

`Approval.Submit` is the one mutation this package declares. Every other
mutation a client makes is [`@smthrs/control`](/api/control) `ControlRpcs`,
mounted unchanged on `/rpc`, so there is exactly one wire definition of `Plan`,
`Run`, `Approve`, `Deny`, `Cancel`, `Signal`, `Steer`, `Resume`, `List`, and
`Watch`.

This one exists because a decision is a composite act a client cannot
assemble safely on its own: the grant has to be recorded and the parked run
delegated to resume, atomically. Control owns that as a single domain command.
The gateway is a transport adapter over it and composes no second mutation.

## Read the gate

The payload a decision needs is published by the `approvals` projection. Do not
build it:

```ts
import { Projections } from "@smthrs/gateway/Projections"
import { Effect } from "effect"

const pending = Effect.gen(function*() {
  const projections = yield* Projections
  // No runId: the workspace inbox, which lists only gates a human still owes
  // an answer to.
  const snapshot = yield* projections.snapshot({ _tag: "approvals" })
  return snapshot.rows
})
```

Each `GatewayProjection.ApprovalRow` carries:

| Field         | Holds                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `runId`       | the run parked on this gate                                           |
| `waitRunId`   | the execution holding the wait, when it is held below `runId`         |
| `requestId`   | the gate's own id                                                     |
| `title`       | the question, as the run asked it                                     |
| `request`     | the whole journaled request payload, for rendering                    |
| `payload`     | the `ControlSchema.ApprovalPayload` a decision submits back unchanged |
| `requestedAt` | when the gate opened                                                  |
| `status`      | `pending`, `approved`, or `denied`                                    |

`payload` is the point. It is the exact `ApprovalTarget.Node` envelope the run
published, carrying the target, the grant scope, and the idempotency key. A
client submits it back byte for byte, so no client reconstructs authority for
itself.

### Gates held by a nested execution

A flow that calls another flow parks the CHILD execution. A `HumanTask` in a
nested flow therefore parks a run an operator has never heard of, while the run
they did open sits at `waiting-approval` with nothing of its own to decide.

The control plane rolls those waits up: `ControlSchema.RunSummary.pendingWaits`
lists every open human wait in a run's tree, and the run's status rolls up with
them, so the ordinary `status: "waiting-approval"` filter finds the root. The
`approvals` projection turns each into a pending row of that root run.
`waitRunId` names the execution actually holding it; the workspace inbox lists
one question once, from the outermost run that carries it.

Such a row asks a QUESTION rather than for a grant, and its `request` says
what kind of answer:

| `request` field | Holds                                                         |
| --------------- | ------------------------------------------------------------- |
| `kind`          | `ask`, `confirm`, `select`, or `json`                         |
| `prompt`        | the question, which is also the row's `title`                 |
| `name`          | the wait point's own name, which `Signal` addresses           |
| `attempt`       | which attempt of a re-asked question this is, counting from 1 |
| `maxAttempts`   | the attempt budget the task declared                          |
| `options`       | the choices, on a `select`                                    |
| `token`         | the durable wait address, for a client that prefers it        |

## Submit the decision

`GatewayRpcs.SubmitApprovalInput` is that payload plus one field:

```json
{
  "_tag": "Request",
  "id": 1,
  "tag": "Approval.Submit",
  "payload": {
    "target": {
      "_tag": "Node",
      "runId": "run-1",
      "requestId": "gate",
      "digest": "gate-digest",
      "envelope": { "capabilities": ["model:call"], "flows": ["ask"], "budget": {} }
    },
    "scope": "run",
    "idempotencyKey": "approve:gate",
    "decision": "approve"
  },
  "headers": []
}
```

Post it to `/projections`, or send it on `/projections/ws`. `decision` is
`"approve"` or `"deny"`; everything else is the row's `payload` spread in
place.

### Answering a question

A gate that asks a question needs the value, not the word: add `answer`.

```json
{
  "target": {
    "_tag": "Node",
    "runId": "run-3",
    "requestId": "coding-clarification#1",
    "digest": "<the row's wait token>",
    "envelope": { "capabilities": [], "flows": [], "budget": {} }
  },
  "scope": "once",
  "idempotencyKey": "answer:run-3:coding-clarification#1",
  "decision": "approve",
  "answer": "the scheduler owns it"
}
```

Shape the answer for the question's `kind`: prose for `ask`, a boolean for
`confirm`, one of `options` for `select`, and the decoded JSON value for
`json`. The mount routes it to `Control.signal`, addressed to `target.runId`
and naming `target.requestId`, and the control plane finds the execution
holding that wait. A denial carries no answer: it refuses the question rather
than answering it, and an unanswered question re-parks or times out on the
task's own budget.

The answer is `GatewayRpcs.SubmitApprovalOutput`: one field, `decision`, the
`ControlSchema.Receipt` that is the receipt for the grant or the refusal. There
is no second call. Approving a parked node delegates its durable resume in the
same command, and denying it records the refusal the same way.

## Who the decision is journaled as

The handler reads the principal the shared `ControlAuth` middleware
authenticated and passes it through, exactly as `ControlServer` stamps it on
`Approve` and `Deny`. This mount is the same decision under a different
payload, so it is answerable to the same operator. A decision journaled under
the composition's default operator would name the wrong one.

Authentication is not approval authority. Control checks its host-owned
`ApprovalAuthority` before mutation or receipt replay, and again at resolution.
A shared bearer authenticates `gateway/bearer`, which is not an approver by
default. The host must explicitly delegate that identity and the requested
scope, or an authorized local operator must decide the gate. Both `/rpc` and
`/projections`, over HTTP and WebSocket, enforce the same policy. Supplying a
principal in the payload cannot override the authenticated actor.

## The failures

`Approval.Submit` answers with exactly the union `Control.approve`,
`Control.deny`, and, for an answer, `Control.signal` declare, because the
handler adds no failure of its own. A member none of them raises would be a
recovery branch no client's code could ever reach.

| Failure              | Means                                                     | What to do                                                   |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `Unauthorized`       | the caller lacks approval authority for this target/scope | ask an authorized operator; do not keep retrying unchanged   |
| `PlanDigestMismatch` | the plan changed since the gate was published             | re-read the gate and show the new plan before deciding again |
| `EnvelopeMismatch`   | the capability envelope is not the one that was approved  | re-read the gate; do not widen the envelope client-side      |
| `AlreadyResolved`    | someone already decided this gate                         | refresh the row; the decision stands                         |
| `PlanNotFound`       | the plan the target names is gone                         | re-plan                                                      |
| `RunNotFound`        | the run the target names is gone                          | drop the gate from the inbox                                 |
| `InvalidInput`       | the payload is not a decidable approval payload           | submit the row's `payload` unchanged                         |
| `PersistenceError`   | the control plane could not write the decision            | retry with the same `idempotencyKey`                         |
| `Unavailable`        | the control plane is not serving this operation           | retry later                                                  |
| `NoMatchingWait`     | the question was answered after the run moved on          | re-read the inbox; somebody answered it, or it timed out     |

Retrying is safe. The payload carries an `idempotencyKey`, so a second
submission of the same decision lands one effect.

## From the command line

The same decision from a terminal is [`smthrs approvals approve`](/cli/approvals) and
`smthrs approvals deny`, which take the same payload the projection
publishes. For the domain semantics behind both, see
[Approvals](/pkg/control/guides/approvals).
