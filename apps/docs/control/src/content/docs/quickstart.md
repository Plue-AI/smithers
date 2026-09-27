---
title: "Quickstart"
description: "Plan a flow, watch the launch park for approval, approve it, launch it, list the run, and replay the journal, in one in-memory program with no database and no engine."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/quickstart.md"
---

This quickstart drives one plan through the whole gate: a plan card, a refused
launch, an approval, an accepted launch, a listing, and a replay of the run's
journal. The `Control` service is the production one. Only its collaborators
are in memory, so the program is deterministic, needs no database, and starts
no real work.

By the end you will have seen the two answers that make the control plane
usable from a script: a `Receipt` that says what happened, and a `ControlEvent`
stream that says it again from durable evidence.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependency installed. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

## Declare the flow the plane may plan

A control plane plans what its runtime knows about. `MemoryFlow` is that
entry: an id, a description, whether the flow is deploy class, and the
capability envelope an approval binds to.

Create `quickstart.ts`:

```ts
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"

/** One flow this plane may be asked to plan. */
const Deploy: ControlRuntime.MemoryFlow = {
  flowId: "quickstart/Deploy",
  description: "Deploys one build",
  deployClass: true,
  envelope: {
    capabilities: ["process:spawn"],
    flows: [],
    budget: { milliseconds: 60_000 }
  }
}
```

The envelope is the authority a reviewer is being asked to grant. It is part of
the plan digest, so an approval taken on this envelope cannot authorize a
wider one later.

## Plan, launch, approve, launch again

`plan` returns a `PlanCard`: the flow, a canonical summary of the input, the
envelope, the keyed node graph, and a digest over all of it. The card starts
undecided, so the first `run` parks:

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const program = Effect.gen(function*() {
  const control = yield* Control

  const card = yield* control.plan({
    flowId: "quickstart/Deploy",
    input: { build: "v1.4.0" }
  })

  /** The exact plan, digest, and envelope every launch attempt resubmits. */
  const launch = {
    _tag: "Plan" as const,
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope
  }

  // Nothing is approved yet, so this starts nothing and says why.
  const parked = yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })

  // The card carries the exact payload an approval is taken on, including a
  // default idempotency key, so a reviewer resubmits it unchanged.
  yield* control.approve(card.approval)

  // The same call, the same key. Now it launches.
  const accepted = yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })

  // And once more, to show what a retry is worth.
  const replayed = yield* control.run({ ...launch, idempotencyKey: "deploy:v1.4.0" })

  const listed = yield* control.list({ _tag: "runs", filters: {} })
  const runs = listed._tag === "runs" ? listed.items : []

  const events = yield* control.watch({ runId: runs[0]!.runId, follow: false }).pipe(
    Stream.map((event) => event.kind),
    Stream.runCollect
  )

  return { parked, accepted, replayed, runs, events: [...events] }
})
```

## Provide the in-memory stack and run it

`TestControl.layer` bundles the four collaborators `ControlLive` requires: the
deterministic runtime, an in-memory journal, a notification queue over that
journal, and an empty registry. Its executor accepts nothing, which is exactly
the composition a host that only records has.

```ts
import * as TestControl from "@smthrs/control/test/TestControl"

console.log(
  await Effect.runPromise(
    program.pipe(Effect.provide(TestControl.layer({ flows: [Deploy], now: () => 0 })))
  )
)
```

Run the file with your TypeScript runner. The receipts, the listing, and the
journal replay come back like this:

```text
{
  parked: { _tag: 'Parked', receiptId: 'deploy:v1.4.0', planId: 'plan-1', status: 'waiting-approval' },
  accepted: { _tag: 'Accepted', receiptId: 'deploy:v1.4.0', runId: 'run-1' },
  replayed: { _tag: 'AlreadyApplied', receiptId: 'deploy:v1.4.0', runId: 'run-1' },
  runs: [ { runId: 'run-1', flowId: 'quickstart/Deploy', status: 'accepted', ... } ],
  events: [ 'control.run.accepted', 'control.run.pending' ]
}
```

## What just happened

Four things worth naming, because each is a promise the plane keeps everywhere:

- **A launch is not a start.** An undecided plan answers `Parked` with the
  status it is waiting in. Nothing was created, so nothing has to be cleaned
  up. See [Gate work behind an approval](/guides/approvals/).
- **The same key means the same mutation, once.** The launch and the retry
  carry one `idempotencyKey`, and the retry answers `AlreadyApplied` with the
  run the first call created. A parked receipt is deliberately not recorded, so
  the key was still free when the plan became approvable. See
  [Receipts and idempotency](/concepts/receipts/).
- **An approval is bound to what was reviewed.** `card.approval` carries the
  target, the digest, the envelope, and a default key. Submit a different
  digest or a different envelope and the decision is refused rather than
  re-aimed.
- **Every decision left evidence.** `watch` replayed the run's journal from
  durable rows. `control.run.pending` is there because this composition's
  executor declined the launch, so the plane released the run rather than
  claiming to drive it. See [Journal projections](/concepts/projections/).

## Next steps

- [Connect an execution engine](/guides/implement-an-executor/): make
  `control.run` start something real.
- [Store control state in a database](/guides/durable-storage/): keep the
  plans, tokens, and runs across a restart.
- [Serve the control plane over RPC](/guides/serve-over-rpc/): hand this
  same program a client instead of a layer.
- [Authority, not execution](/concepts/authority/): the model the rest of
  the package is built on.
