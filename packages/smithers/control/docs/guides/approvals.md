---
title: "Gate work behind an approval"
description: "Take a plan approval before a run starts, and a node approval inside a run that already started: what each gate pins, how a step registers its own request, and what a decision restarts."
sidebar:
  order: 1
---

Two gates carry an approval, and they are different mechanisms worth keeping
apart. A **plan approval** decides whether a run starts. A **node approval**
decides something inside a run that already started.

Both are decided with the same two verbs, `approve` and `deny`, and both pin
what was reviewed with a digest and an envelope, so a decision cannot be
re-aimed at a different request afterwards.

## Who may decide

An approval payload identifies the request; it is not permission to decide it.
Authentication supplies a trusted `Principal`, while `ApprovalAuthority` supplies
the independent host policy. `Control.approve` and `deny` check that policy before
target reads or receipt replay, and the runtime checks it again at resolution.
Refusal is `Unauthorized`; unavailable policy storage fails closed with
`PersistenceError`.

The default policy recognizes only the fixed local identity `local/operator`.
The memory adapter's own default also recognizes its `memory/test` identity, and
no production policy does. A custom `principal` option,
an actor's `kind`, or a valid bearer credential does not delegate approval.
Hosts may replace the policy explicitly:

```ts
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import { Effect } from "effect"

const runtime = Effect.gen(function*() {
  const approvalAuthority = yield* ApprovalAuthority.make([
    {
      principal: { id: "local", kind: "operator" },
      scopes: ["once", "run", "remembered"],
      targets: ["Plan", "Node"]
    },
    {
      principal: { id: "release-bot", kind: "agent" },
      scopes: ["once"],
      targets: ["Node"]
    }
  ])
  return yield* SqlControlRuntime.make({ approvalAuthority })
})
```

Delegations bind an exact identity tuple, target kind, and approval scope. Scopes
are not hierarchical. A delegated actor may deny its listed target kinds without
installing any grant. Delegation is reusable: `scopes: ["once"]` permits
once-scoped grants; it is not a single-use delegation. A custom host policy must
enforce expiry, revocation, or one-use delegation when needed.
A custom `ApprovalAuthority.Service` can additionally
restrict specific runs, plans, or envelopes. Keep that policy bounded and safe
inside the writer transaction; never invoke Control recursively from it.

Transport adapters must authenticate identities and overwrite caller-supplied
principal fields. Direct Control/runtime references and database access are
trusted host capabilities, not endpoints for untrusted input. In particular,
`installBulkGrant` is a storage port, not an authorization API. Use Control for
an atomic durable decision, grant, journal entry, and receipt.

Default MCP surfaces omit approval decisions and auto-approving starts. The
compatibility server requires both host tool exposure and a separately delegated
agent identity. Delegating an agent to approve is automated approval, not an
independent human review. None of these checks sandboxes a caller that already
has arbitrary host shell, code execution, or direct database write access.
On loopback, `smthrs serve` prints a fresh per-session approval token to
stderr (even with `--quiet`). Send `Authorization: Bearer <token>` to approve,
deny, or answer a human wait over `/rpc` or `/projections`, HTTP or WebSocket.
Calls without that token retain read access, but cannot decide approvals.
Keep the token away from agents: a caller holding it has operator approval authority.
A network bind still requires the configured bearer credential for all protected calls.

## Gate the launch: a plan approval

`plan` produces the reviewable card. `run` against an undecided plan starts
nothing and says so:

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"

const gate = Effect.gen(function*() {
  const control = yield* Control

  const card = yield* control.plan({ flowId: "ops/Deploy", input: { build: "v1.4.0" } })

  const launch = {
    _tag: "Plan" as const,
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope
  }

  // { _tag: "Parked", planId, status: "waiting-approval" }
  yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })

  // The card carries the exact approval payload, so a reviewer resubmits it
  // unchanged rather than reconstructing authority on the client.
  yield* control.approve(card.approval)

  // Now the same call launches.
  return yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })
})
```

Deny it instead and the launch refuses with `PlanDenied` rather than parking.
A denied plan cannot be revived: create and approve a new plan.

### What the card pins

`PlanCard.digest` covers the flow id, the decoded input, the envelope, the
deploy-class flag, and the digest of the persisted plan. `nodes` is the keyed
node graph the plan phase produced, and it is part of the digest because
"approve this flow with this input" and "approve this graph of keyed work" are
different promises: a change that re-keys a node changes what will run, and an
approval taken against the old graph must not authorize the new one. A host
that has not built a graph reports an empty one and loses nothing.

`Envelope` is the authority itself: the capabilities, the collaborator flows,
the budget, and the placement being granted.

| Submitted value differs from the stored one | Failure                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `digest`                                    | `PlanDigestMismatch`, carrying `expected` and `actual`                |
| `envelope`                                  | `EnvelopeMismatch`, compared by canonical bytes rather than key order |

`GrantScope` says how long the grant lasts: `once`, `run`, or `remembered`. The
card defaults to `run`.

## Gate a step: a node approval

A node approval belongs to a run that already exists, and the _step_ registers
it. Nothing outside the run asks for it, so `approve` can only decide a request
a step actually made.

The step registers the token and handles its explicit `Pending`, `Approved`, or
`Denied` tag. Only approval may open the gate:

```ts
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Action, DurableDeferred, FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** The step that asks, declared like any other. */
const Clearance = Action.make("ops/Clearance", {
  payload: { requestId: Schema.String },
  success: Schema.String,
  error: Schema.Union([ControlRuntime.ApprovalPending, ControlRuntime.ApprovalDenied])
})

/**
 * The wait point the park awaits. Nothing ever completes it, which is the
 * point: an approval is not a value arriving, it is a decision recorded
 * somewhere else. The wake is the run being re-driven, and the step reads the
 * decision off the token rather than off this deferred.
 */
const clearanceGate = DurableDeferred.make("Approval/ship-clearance", { success: Schema.Json })

/** The exact request this step registers and an operator decides. */
const request = (runId: string): Extract<ControlSchema.ApprovalTarget, { readonly _tag: "Node" }> => ({
  _tag: "Node",
  runId: runId as ControlSchema.RunId,
  requestId: "ship-clearance",
  digest: "ops/Ship:clearance",
  envelope: { capabilities: [], flows: [], budget: {} }
})

const clearance = Clearance.toLayer(({ requestId }) =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const runtime = yield* ControlRuntime.ControlRuntime
    const target = request(instance.executionId)
    let token = yield* Effect.orDie(runtime.registerApproval(target))
    if (token._tag === "Pending") {
      yield* FlowRuntime.annotateWaiting({ reason: "approval", token: requestId })
      yield* DurableDeferred.await(clearanceGate)
      // Completing a wait point is not approval. Read the durable answer.
      token = yield* Effect.orDie(runtime.registerApproval(target))
    }
    return (yield* ControlRuntime.requireApproved(token)).tokenId
  })
)
```

`registerApproval` is idempotent. It creates the token on the first attempt and
answers the existing one afterwards. `requireApproved` succeeds only for
`Approved`, fails with `ApprovalDenied` on denial, and fails with
`ApprovalPending` if no decision exists. Include these errors in the enclosing
flow's error schema. Use `Node.andThen(clearance, next)` to gate all of `next`.
Both terminal tags carry `decisionPrincipal` and `decidedAt`; `Approved` also
carries the installed grant's `scope`. A denied token cannot be changed to
approved. A changed target digest or envelope is refused.

The token describes a decision; it is not an authentication credential and
`requireApproved` does not install permissions or establish who may approve.
Keep approval authority separate from permission to execute a workflow.

### Upgrading an unfinished run

Migration 6004 adds explicit durable decisions. Old pending tokens remain
pending. An old resolved token did not retain whether it was approved or
denied, so reads fail with an actionable `PersistenceError` instead of guessing
from grants or journal projections. Preserve the database for review and use a
new run with a new approval request. This is refusal, not automatic migration of
unfinished executions. The action and flow error schema changes also require
newly planned/approved work; they do not retrofit old cached action results.

The complete example, with the two drives around the decision, is
[`examples/src/18-approval-and-signal.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/18-approval-and-signal.ts).

### Decide it from outside the run

```ts
const receipt = yield * control.approve({
  target: request("run-17"),
  scope: "once",
  idempotencyKey: "approve:ship-clearance"
})
```

The node digest is deliberately not the plan's. The two gates are separate
mechanisms, and a run that was never planned still has steps worth gating.

## What a decision does

For a new decision, the adapter contract follows this order:

| Step                           | Plan target                                                                    | Node target                                                 |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Authenticate and authorize     | Authenticate the principal; `authorizeApproval` before reads or receipt replay | same                                                        |
| Look the token up              | `lookupApproval` refuses an unknown or already-resolved token                  | same                                                        |
| Resolve the token              | `resolveApproval` exactly once, with an authority recheck                      | same                                                        |
| Install the grant, on approval | `installBulkGrant` with the submitted envelope and scope                       | same                                                        |
| Journal the decision           | `control.approval.approved` or `.denied` on `plan:<planId>`                    | the same kinds, on the run                                  |
| Record the restart             | nothing to restart                                                             | records a resume delegation, journals `control.run.resumed` |

Commit the decision, grant, journal entry, receipt, and any node resume delegation
atomically. Resolution must not require an installed grant or a flushed journal
decision. An authority refusal at resolution prevents grant installation.

A decision on a node target restarts the run the ask parked, in the same call.
Nothing else wakes that run: without the restart it would sit at
`waiting-approval` holding a decision it never reads, and a denial it never
learns about would decide nothing.

The restart is _recorded_, not performed, and the deciding plane does not claim
the row. See [a resume is a delegation before it is a claim](../concepts/ownership.md).

A decision on a run that has already settled answers `Terminal` and decides
nothing, read before the idempotency replay so the answer describes the run
rather than an earlier call.

## Refusals

| Failure              | Cause                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `Unauthorized`       | The authenticated caller lacks approval authority for this target/scope. |
| `PlanNotFound`       | No plan or node token with this id. Its `message` names the next action. |
| `PlanDenied`         | The plan was denied. Create and approve a new one.                       |
| `PlanDigestMismatch` | The submitted digest is not the stored one.                              |
| `EnvelopeMismatch`   | The submitted envelope is not the stored one.                            |
| `AlreadyResolved`    | This token already carries a terminal decision.                          |
| `RunNotFound`        | A node target names a run this plane cannot find.                        |

`AlreadyResolved` is also the durable evidence that a decision stuck: a second
`lookupApproval` on a decided token refuses rather than answering.

## Where to go next

- [Receipts and idempotency](../concepts/receipts.md): why the launch and the
  retry share one key.
- [Ownership, fences, and claims](../concepts/ownership.md): what the recorded
  resume reaches.
- [Plan, approve, run on smithers.sh](/docs/guides/plan-approve-run/): the same
  gate from the CLI.
