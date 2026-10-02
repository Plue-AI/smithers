---
title: "@smthrs/control"
description: "The control plane for durable agent runs: plan work, approve it, start it, watch it, steer it, and stop it, from any process, with every decision recorded beside the state it changed."
---

`@smthrs/control` is the control plane for durable agent runs. It is one
TypeScript service, `Control`, with ten operations: `plan`, `run`, `approve`,
`deny`, `steer`, `signal`, `cancel`, `resume`, `list`, and `watch`. A command
line, a gateway, an MCP server, or a dashboard calls those operations when a
person or another agent asks for something to start, stop, or change.

## The problem it solves

Agent work that runs for hours outlives the process that started it. By the
time somebody wants to approve a deployment, cancel a run that is going
nowhere, or ask what a run is waiting on, the process that could have answered
from memory may be gone, and the run itself may be owned by a different machine.

`Control` answers from persisted evidence instead, and it holds three promises
while doing it:

- **Every mutation is idempotent under a key you choose.** A retried cancel, a
  redelivered webhook, and a double-clicked approve are each one mutation, and
  the second ask answers with the first one's receipt.
- **Every mutation is attributed and journaled.** The plane stamps the
  principal it authenticated, not the one a caller claimed, and writes the
  journal entry in the same commit as the state change, so "who asked for this,
  and when did it take effect?" still has an answer a week later.
- **Nothing here executes a flow.** `Control` is authority, not execution. That
  split is what lets one plane answer for runs that several processes own, on
  machines it cannot reach, in a database it shares with an engine it never
  imports.

Reach for this package when you are building the thing operators and agents
point at. Reach for the command line instead when you want to drive runs from a
shell.

## How it relates to the smthrs CLI

[`@smthrs/cli`](/api/cli) is the `smthrs` command line, and it is a host over
this package. `smthrs flow plan`, `smthrs approvals approve`, `smthrs flow execute`,
`smthrs runs list`, and `smthrs runs cancel` are each one call into the `Control` service defined here and
into nothing else, which is why the same command answers the same way against a
local project directory and against a remote plane: run the CLI with `--remote`
and it provides `ControlClient.layer` in place of the in-process
implementation, and no verb notices the difference.

That relationship runs in one direction. `@smthrs/cli` depends on
`@smthrs/control`; this package knows nothing about a terminal. Install
[`@smthrs/cli`](/api/cli) when a person drives runs from a shell, and it is
also the top-level package the rest of Smithers sits under, so start there if
you are new. Install `@smthrs/control` when you are writing a host of your own:
a gateway, an MCP server, a supervisor, a dashboard, or a CI job that needs to
plan a run, decide an approval, or watch a journal it did not write.

Flow authors reach this package only where a step consults a durable decision,
as an in-run approval does.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

The package needs
Node.js 26.4.0 or later. For the collaborator packages a working composition
adds, see [Installation](./installation.md).

## The smallest real program

Plan a flow, then ask to run it. A plan starts undecided, so the launch parks
instead of starting anything:

```ts
import { Control } from "@smthrs/control/Control"
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as Effect from "effect/Effect"

/** One flow this plane may be asked to plan. */
const Deploy: ControlRuntime.MemoryFlow = {
  flowId: "quickstart/Deploy",
  description: "Deploys one build",
  deployClass: true,
  envelope: { capabilities: ["process:spawn"], flows: [], budget: {} }
}

const program = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "quickstart/Deploy", input: { build: "v1.4.0" } })
  return yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "deploy:v1.4.0"
  })
})

// { _tag: "Parked", receiptId: "deploy:v1.4.0", planId: "plan-1", status: "waiting-approval" }
console.log(
  await Effect.runPromise(program.pipe(Effect.provide(TestControl.layer({ flows: [Deploy] }))))
)
```

The [Quickstart](./quickstart.md) carries this through approval, launch,
listing, and a watch, with no database and no engine.

## The three seams

`Control` keeps its promises through four ports, and a host chooses an
implementation of each:

- `ControlRuntime` is the persistence port: plans, approval tokens, grants,
  idempotency records, and the fenced run rows. `ControlRuntime.layerMemory` is
  the deterministic in-memory one; `SqlControlRuntime.layer` is the durable one
  over a SQL database and the fenced run store.
- `ControlExecutor` is the execution port: the plane hands a launch, a cancel,
  a signal, or a resume to a real engine and learns only what the engine did
  with it. A composition that provides none records and observes but starts
  nothing, which is the right shape for a monitor or a read-only dashboard.
- `DispatchReader` is the trigger read port: `list` answers the `triggers` and
  `fires` variants through it. A composition that provides none still lists
  flows and runs, and refuses those two variants with a typed `InvalidInput`
  rather than an empty page.
- `ControlServer` and `ControlClient` are the transport: the same `Control`
  vtable served as RPC and projected back on the other side of a wire. A caller
  handed either one cannot tell which it has.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/control/<Module>`:

| Namespace                               | What it is                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Control`                               | The service: `plan`, `run`, `approve`, `deny`, `steer`, `signal`, `cancel`, `resume`, `list`, `watch`.                                    |
| `ControlSchema`                         | The serializable values both halves of the wire decode: `PlanCard`, `RunSummary`, `Receipt`, `SteerMessage`, and the RPC request schemas. |
| `ControlError`                          | Every stable failure the plane emits, as classes and as one membership schema.                                                            |
| `ControlLive`                           | The in-process implementation over `ControlRuntime`, the journal, the notification queue, and the registry.                               |
| `ControlRuntime`                        | The persistence port, plus `layerMemory`, its deterministic in-memory implementation.                                                     |
| `SqlControlRuntime`                     | The durable persistence adapter over a SQL database and the fenced run store.                                                             |
| `ControlExecutor`                       | The execution port: launch, cancel, signal, resume, and the park settlement a cancel needs.                                               |
| `DispatchReader`                        | The trigger read port: the registered triggers and the fire ledger `list` pages, plus `layerNone` for a host without a store.             |
| `ControlRpcs`                           | The ten remote procedures, the authentication middleware, and a bearer authenticator.                                                     |
| `ScopedToken`                           | Scoped, expiring tokens minted under a bearer credential: named procedures, an optional run or flow, and an expiry.                       |
| `ControlServer`                         | The RPC handlers and the HTTP plus WebSocket mount.                                                                                       |
| `ControlClient`                         | The RPC client projected back into the `Control` interface.                                                                               |
| `Lineage`                               | How a run came to exist: `child`, `fork`, or `continuation`, derived from run rows and journal entries.                                   |
| `Cancellation`                          | Who cancelled a run, why, and whether it was swept up in an ancestor's cascade.                                                           |
| `Steering`                              | The steer lifecycle: the enqueue the plane records and the delivery it derives from the queue.                                            |
| `Monitor`                               | Run health as a pure classification, and the beat loop that acts on it.                                                                   |
| `Channels`                              | Verified ingress: an external request becomes a control mutation, once.                                                                   |
| `WebhookChannel`                        | A schema-declared webhook channel and its bounded HTTP handler.                                                                           |
| `Credential`                            | The credential boundary: only a reference crosses it, never a secret.                                                                     |
| `CredentialStore`, `CredentialCipher`   | The persistence and encryption ports behind it.                                                                                           |
| `SqlCredentialStore`, `WebCryptoCipher` | Their durable and AES-256-GCM adapters.                                                                                                   |
| `Migrations`                            | The package's namespaced migration set and the layer that runs it.                                                                        |
| `SystemFlows`                           | The reserved CLI verb to flow-id catalog, and which of those a runtime may plan.                                                          |

Every export of every namespace, with its signature, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, import forms, and the
  packages a runnable composition adds.
- [Quickstart](./quickstart.md): plan, approve, launch, list, and watch, in one
  in-memory program.
- Concepts: [authority, not execution](./concepts/authority.md),
  [receipts and idempotency](./concepts/receipts.md),
  [ownership, fences, and claims](./concepts/ownership.md),
  [journal projections](./concepts/projections.md),
  [run lineage](./concepts/lineage.md), and
  [cancellation attribution](./concepts/cancellation.md).
- Guides: [gate work behind an approval](./guides/approvals.md),
  [find runs](./guides/list-runs.md), [watch a run](./guides/watch-a-run.md),
  [steer a run](./guides/steer-a-run.md),
  [signal a waiting run](./guides/signal-a-run.md),
  [cancel and restart a run](./guides/cancel-and-resume.md),
  [store control state in a database](./guides/durable-storage.md),
  [connect an execution engine](./guides/implement-an-executor.md),
  [serve the plane over RPC](./guides/serve-over-rpc.md),
  [monitor and heal a run](./guides/monitor-runs.md),
  [accept a webhook](./guides/ingest-a-webhook.md),
  [store a credential](./guides/store-credentials.md), and
  [test against the plane](./guides/testing.md).
- [Troubleshooting](./troubleshooting.md): the refusals this package reports,
  what causes them, and what to change.
- [`@smthrs/cli`](/api/cli): the `smthrs` command line built on this service,
  and the package the rest of Smithers sits under.
