---
title: "@smthrs/flows"
description: "The whole Smithers durable flow engine in one dependency: declare flows and actions, run them on a native host over SQLite or PostgreSQL, and resume them after a crash."
---

`@smthrs/flows` is one package that carries the whole durable flow engine
behind [Smithers](https://smithers.sh/docs/). It re-exports every engine
package under a single import, and it adds the two modules a Node program needs
to run flows for real: `NodeRuntime`, which stands a durable engine up over
local SQLite, and `SandboxedFlow`, which runs a child flow's own code on a
machine you provision.

## What it solves

A job that calls a model, spawns a build, or waits on a person cannot afford to
start over when the process dies. A Smithers flow records each step in a journal
as it completes, so a restart replays what already finished and resumes at the
first step that did not. Steps are declared as schemas rather than written as
calls, which is what lets the engine cache them, retry them, replay them, and
put one of them on another machine without the flow's author arranging any of
it.

The engine behind that is twenty packages, each with its own seam. Wiring
twenty dependencies by hand is the boring part of composing a host, so this
package collapses it: one dependency, one import, and one call that builds the
whole composition.

## Install

`@smthrs/flows` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](./installation.md) covers how to depend on it from a checkout,
the import forms, the platform packages the barrel leaves to you, and when to
depend on individual engine packages instead.

Durable execution uses a Node.js 26.4.0+ or Bun 1.4.0+ host composition. The API is
[Effect](https://effect.website) throughout: a flow declares its payload and
result as Effect schemas, an action's implementation is an `Effect`, and a host
is a `Layer` you provide. The example below is a complete Effect program, and
Effect's own documentation is where to start if those three names are new.

## Run a flow that survives a restart

This program declares one recorded step, runs it on a durable host, and prints
the result:

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** A step declaration is data: a name and the schemas either side of it. */
const FetchReadme = Action.make("demo/FetchReadme", {
  payload: { repo: Schema.String },
  success: Schema.Number
})

/** A flow is a plan over declarations, compiled before any of it runs. */
const CountBytes = Flow.make("demo/CountBytes", {
  payload: { repo: Schema.String },
  success: Schema.Number,
  body: (payload) => FetchReadme.call(payload)
})

/** The code arrives as a layer, separately from the declaration. */
const registerFlows = Interpreter.layer(CountBytes).pipe(
  Layer.provideMerge(
    FetchReadme.toLayer(({ repo }) =>
      Effect.promise(async () => {
        const response = await fetch(`https://api.github.com/repos/${repo}/readme`)
        return (await response.text()).length
      })
    )
  ),
  Layer.provideMerge(Action.layerImplementations)
)

/** One call builds the database, the journal, the guarded host, and the engine. */
const host = NodeRuntime.layerHost(
  { filename: ".flows/engine.db", workspaceRoot: ".", owner: { hostId: "demo" } },
  registerFlows
)

const main = CountBytes.execute({ repo: "smithersai/smithers" }, { executionId: "demo-1" })
  .pipe(Effect.provide(host), Effect.scoped)

console.log(await Effect.runPromise(main))
```

Run it once and it calls GitHub. Run it a second time, unchanged, and it prints
the same number without calling GitHub: `executionId` names one execution, and
the engine answers a completed one from the journal on disk. That is durability
in one line of behavior, and everything else here is built on it.

The [Quickstart](./quickstart.md) takes the same program further: it reads a
file through the guarded host, which means granting the one capability the body
needs and seeing what happens when you leave the grant out.

## How this relates to the smthrs command line

[`@smthrs/cli`](/api/cli) is this engine as a program you run rather than a
library you compose. Its `smthrs` command finds the flows in a project, plans
them, takes an approval, runs them, and reads their events back, and it builds
its durable engine through `@smthrs/flows/NodeRuntime`, the same module the
example above calls. Choose the CLI when you want to run flows from a shell or
a CI job. Choose `@smthrs/flows` when the program that runs them is yours.

Reach for a single engine package instead of the barrel when you want a
narrower dependency: [`@smthrs/flow`](/api/flow) declares flows and actions,
[`@smthrs/engine`](/api/engine) executes them, and
[`@smthrs/sandbox`](/api/sandbox) provisions machines. The barrel is a
packaging convenience, not a new layer of API, which is why nothing in it is
reachable only through it.

## Next steps

- [Installation](./installation.md): how to depend on the package, the Node and
  `effect` requirements, the import forms, and the platform packages you choose
  yourself.
- [Quickstart](./quickstart.md): one flow end to end on a real durable engine.
- [Stand up a durable Node runtime](./guides/stand-up-a-node-runtime.md): the
  four `NodeRuntime` entry points, and which one a given program should call.
- [Run a child flow in a sandbox](./guides/run-a-child-flow-in-a-sandbox.md):
  the tier where the child's own code executes on another machine.
- [The aggregate surface](./concepts/aggregate-surface.md): why the authoring
  names are flat, the infrastructure packages are namespaces, and the platform
  bundles are absent.
- [API reference](./api.md): every public export.
- [Troubleshooting](./troubleshooting.md): every typed refusal these modules
  raise, and what to change.
