---
title: "@smthrs/engine"
description: "The runtime that executes @smthrs/flow flows: it records every step, answers a repeated submission with the recorded result instead of running the work twice, resumes a parked run, and derives RPC and HTTP transports from flow declarations."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/README.md"
---

`@smthrs/engine` is the runtime that executes durable flows. A flow, written
with [`@smthrs/flow`](https://flow.smithers.sh/reference/api/), declares what should happen; this package
makes it happen, records every step it took, and picks the run back up after it
parks waiting on something, after a crash, and after a process restart.

## The problem it solves

Retrying a job that already charged a card, resuming work after a deploy killed
the process, waiting three days for a human approval without holding a thread
open: these are one problem, and a retry loop around a function does not solve
it. Something has to remember what already ran.

This package is that memory. It records each action dispatch under a derived
step identity, so a re-drive finds the recorded outcome instead of dispatching
again. It names each execution by a caller-supplied id, so a client that times
out and resubmits joins the run it already started rather than starting a second
one. Retries, parked runs, cancellation, and handoffs to a following round are
all decided here, in one place, and they behave the same whether the state lives
in a process or in a database.

Reach for it when you need a program to survive the process that started it, and
when running a step twice would be worse than running it late.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Node 26.4.0 or later, plus a platform crypto service.

Everything here is built on [Effect](https://effect.website). Flows, actions,
and the engine itself are Effect values, you compose them as layers, and the
program below is Effect code end to end. `effect` is a peer dependency, and
this release pins one exact version: see [Installation](/installation/) for
that pin and for the four things a runnable composition provides.

## Run a flow twice, compile once

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Compile = Action.make("build/Compile", {
  payload: { target: Schema.String },
  success: Schema.String
})

const Build = Flow.make("build/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

let compiles = 0

const BuildLayer = Layer.mergeAll(
  Compile.toLayer(({ target }) =>
    Effect.sync(() => {
      compiles = compiles + 1
      return `${target}.js`
    })
  ),
  Interpreter.layer(Build)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const program = Effect.gen(function*() {
  const first = yield* Build.execute({ target: "app" }, { executionId: "build-app-1" })
  const second = yield* Build.execute({ target: "app" }, { executionId: "build-app-1" })
  return { first, second, compiles }
}).pipe(Effect.orDie, Effect.provide(BuildLayer))

Effect.runPromise(program).then(console.log)
```

It prints:

```text
{ first: 'app.js', second: 'app.js', compiles: 1 }
```

Both submissions answered `app.js`, and only the first one compiled. The second
joined the run that already owned `build-app-1` and replayed its recorded
result. That is the guarantee, in one file, with no database configured.

`FlowEngine.layerMemory` keeps its state for the life of its layer scope, which
makes it a deterministic runtime for tests and local development.
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) implements the same contract over a
durable journal, and swapping that one layer is the only change a program makes
to keep its runs after the process exits.

## What the package exports

| Namespace         | What it gives you                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine`      | The runtime: the in-memory `layerMemory`, the `Encoded` contract a durable store implements, and the identity, retry, suspension, and round machinery above it. |
| `FlowProxy`       | RPC and HTTP definitions derived from a list of flows, so one process can execute a flow that another process declared.                                         |
| `FlowProxyServer` | The layers that bind those derived definitions to a running engine.                                                                                             |

Full signatures are in the [API reference](/reference/api/).

## How this fits with @smthrs/flows

`@smthrs/engine` is one package of a larger durable flow engine.
[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the barrel that re-exports the whole engine as
namespaces: this runtime, the flow-authoring package, the durable store, the
journal, and the rest. It re-exports this package as `Engine`, so
`Engine.FlowEngine.layerMemory` from the barrel is the same layer
`FlowEngine.layerMemory` names here. Install `@smthrs/engine` when you want the
runtime and its transports alone, and `@smthrs/flows` when one dependency for
the whole engine is the better trade.

Its sibling is [`@smthrs/flow`](https://flow.smithers.sh/reference/api/), the package you author against:
`Flow`, `Action`, `DurableDeferred`, `DurableClock`, and `RetryPolicy` are all
declared there. It defines `FlowRuntime` as a port and ships no implementation.
This package is the implementation.

Above all of them sits [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), the `smthrs` command line
these packages are built for: it plans, approves, runs, and inspects durable
flows through one control plane. Nothing here needs it. The CLI is what a
finished product on top of this engine looks like, and it is the place to start
if you want the whole system rather than the runtime.

## Where to go next

- [Installation](/installation/): the packages, the version pin, and the
  services a composition provides.
- [Quickstart](/quickstart/): the program above, built up one layer at a
  time.
- [The port and the seam](/concepts/port-and-seam/): why the engine is two
  layers, and what a store has to implement.
- [Execution identity](/concepts/execution-identity/) and
  [Step identity](/concepts/step-identity/): the two names that decide what a
  replay finds.
- [Retries and attempts](/concepts/retries/),
  [Suspension and cancellation](/concepts/suspension/), and
  [Trampoline rounds](/concepts/trampoline-rounds/): what the engine does
  when a step fails, parks, or hands off.
- [Place a child flow on another engine](/guides/place-a-child-on-another-engine/):
  bind a placement to another engine's served group with `Hosts`.
- [Serve flows over RPC or HTTP](/guides/serve-flows/) and
  [Test flows on the in-memory engine](/guides/test-in-memory/): the two
  things most programs do next.
- [Troubleshooting](/troubleshooting/): every refusal and warning, with the
  fix.
