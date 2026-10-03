---
title: "@smthrs/flow"
description: "Declare durable workflows in TypeScript: an action is a named step with schemas, a flow is a pure plan over those steps, and a re-run replays what already finished instead of doing it again."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/README.md"
---

`@smthrs/flow` is the authoring model for durable workflows in TypeScript. You
declare each step as an **action**: a stable name and the schemas on either side
of it, with no code. You compose those declarations into a **flow** whose body is
a pure function that builds a plan. The code that does the work attaches
separately, as an Effect layer.

The package carries no engine. It declares the `FlowRuntime` port that an engine
implements, so the whole authoring surface bundles for a browser and a test can
swap the runtime for a fixture without touching a declaration.

## What it solves

A job that calls a model, spawns a build, uploads an artifact, or waits on a
person cannot afford to start over when the process dies. Recovering by hand
means writing your own checkpoint table, your own idempotency keys, and your own
"did this already run" branch around every call.

A pure flow body builds the plan before anything runs. With complete callback
captures and stable admission, unchanged source, captures, declarations, and
payload reproduce the same plan keys across processes. An engine records each
step as it settles, so a re-run under the same execution id reads the recorded
result rather than
repeating the work, on this process and on the next one. The same property is
what lets the engine retry a step, cache it, park a run on a timer or a human
answer for a week, and put one step on another machine, none of which the flow's
author arranges.

Reach for it when a program has steps you cannot afford to run twice, waits
longer than a process lifetime, or a failure you want resumed rather than
restarted. Skip it when a plain `Effect` retry loop covers the whole problem.

## Install

Not on npm yet; see [Installation](/installation/#use-the-libraries).

Node.js 26.4.0 or later. [Installation](/installation/) covers the import
forms, and what each companion package supplies.

## Declare a flow and run it

This program declares one recorded step, attaches its implementation, and runs
the flow on the in-memory engine:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** A step declaration is data: a stable tag and the schemas either side of it. */
const Summarize = Action.make("digest/Summarize", {
  payload: { url: Schema.String },
  success: Schema.String
})

/** A flow body records nodes. `Summarize.call` plans a step and runs nothing. */
const Digest = Flow.make("digest/Digest", {
  payload: { url: Schema.String },
  success: Schema.String,
  body: Node.capture(
    { action: Summarize.name, implementationVersion: "digest/v1" },
    (payload) => Summarize.call(payload)
  )
})

/** The code arrives separately, filed against the tag by `toLayer`. */
const layer = Interpreter.layerWithImplementations(
  Digest,
  Summarize.toLayer(({ url }) => Effect.succeed(`A summary of ${url}.`))
).pipe(
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const main = Digest.execute(
  { url: "https://example.com/post" },
  { executionId: "digest-example-post" }
).pipe(Effect.orDie, Effect.provide(layer))

console.log(await Effect.runPromise(main))
```

`Node.capture` declares every semantic value outside the callback source,
including a version for imported behavior. JavaScript cannot verify that the
record is complete. `Interpreter.layerWithImplementations` defaults to stable
callback admission and refuses uncaptured callbacks before dispatch. The
lower-level `Graph.build` and `Interpreter.layer` default to `process-local`,
which makes no cross-process callback identity guarantee. Changed source,
captures, or implementation versions require a newly planned run.

Run it and the implementation runs once. Run the same execution id again and it
does not: the engine finds the execution that already settled and answers with
its recorded result. Swap `FlowEngine.layerMemory` for the SQLite-backed engine
in [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) and the same behavior survives a
restart, with nothing above the swap changing.

## How this relates to @smthrs/flows

[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the whole Smithers durable flow engine in one
dependency. It re-exports this package alongside the engine, the journal, the
store, and the rest, and it adds the modules a Node program needs to run flows
for real: `NodeRuntime`, which stands a durable engine up over local SQLite, and
`SandboxedFlow`, which runs a child flow on a machine you provision. Install
`@smthrs/flows` when you want a host that runs flows. Install `@smthrs/flow`
alone when you only want to declare them, which is the case for a library that
publishes flows for someone else to run, and for anything that has to bundle for
a browser.

Above both sits [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), the `smthrs` command. It is this
engine as a program rather than a library: it finds the flows in a project, plans
them, takes an approval, runs them, and reads their events back. Reach for it
when the thing running your flows is a shell or a CI job rather than your own
program.

## Where to go next

- [Installation](/installation/): the pinned `effect` version, the subpath
  exports, and the packages a runnable composition adds.
- [Quickstart](/quickstart/): the same program end to end, including what
  happens on the second run.
- [Flows and actions](/concepts/flows-and-actions/): the two nouns, the two
  forms of action, and why an implementation attaches as a layer.
- [Bodies are plans](/concepts/bodies-and-plans/): what a body may not do,
  and why that restriction is what makes replay work.
- [Execution identity](/concepts/execution-identity/): how a run gets its id
  and how one dispatch gets its step key.
- [Suspension and replay](/concepts/suspension-and-replay/): the three
  results a round settles with, and what parking on a durable wait costs.
- [Compose a body from branches and fan-out](/guides/build-a-body/):
  sequencing, parallelism, branches, and recovering from a typed failure.
- [Retry a failing action](/guides/retry-a-failing-action/): policy values,
  non-retryable tags, and where the decision is made.
- [Ask a person for a decision](/guides/ask-a-person/): a human answer as a
  typed, durable step with a deadline.
- [Run an external job](/guides/run-an-external-job/): retained workers, durable probes,
  replacement generations and cancellation.
- [Testing](/testing/): topology, interpretation, and execution, and which
  level a given assertion belongs at.
- [API reference](/reference/api/): every public export, with the export tables in the
  [export reference](/reference/flow/).
- [Troubleshooting](/troubleshooting/): every refusal this package raises,
  sorted by the symptom you see.
