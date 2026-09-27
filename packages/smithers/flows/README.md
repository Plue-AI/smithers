# @smthrs/flows

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://flows.smithers.sh

The whole [Smithers](https://smithers.sh) durable flow engine in one dependency.
It re-exports every engine package under a single import, and it adds the two
modules a Node program needs to run flows for real: `NodeRuntime`, which stands
a durable engine up over SQLite or PostgreSQL, and `SandboxedFlow`, which runs a child
flow's own code on a machine you provision.

A flow records each step in a journal as it completes, so a process that dies
mid-flight replays what already finished and resumes at the first step that did
not.

## Availability

`@smthrs/flows` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](https://flows.smithers.sh/installation/) covers how to depend on
it from a checkout, the Node.js and `effect` versions it requires, and the
platform packages the barrel leaves to you.

## A flow that survives a restart

This program declares one recorded step, runs it on a durable host, and prints
the result.

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
the engine answers a completed one from the journal on disk.

## What the barrel exports

[`@smthrs/flow`](https://flow.smithers.sh) is re-exported flat, so `Action`,
`DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`, `FlowRuntime`,
`Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`,
`StepIdentity`, and `WaitFor` sit at the top level. Writing a flow is the point
of the library, and `Flows.Flow.Flow.make` would be noise.

Every other engine package is a namespace, the way `effect`'s own index does
it, so `Kernel.ChildProcessSpawner.layerNoop` and `RunStore.RunStore.layer`
still read as themselves rather than collapsing into one shared namespace.
`namespaces` is the sorted runtime list of every name the barrel exports, and
the [API reference](https://flows.smithers.sh/reference/api/) has the full
table. Depend on an individual engine package instead when a narrower
dependency surface is worth the extra imports.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle
is chosen by the program that runs, not by the library it depends on. Platform
implementations and test doubles are imported from their own packages, among
them `@smthrs/platform-node`, `@smthrs/testing/TestHost`,
`@smthrs/database/node/NodeDatabase`, and `@smthrs/journal/test/TestJournal`.

## Bundling is not durable execution

The root entry point bundles for a browser, and so does every package root it
re-exports. What bundles is authoring and inspection: declaring flows, reading a
plan, decoding a journal event.
[Installation](https://flows.smithers.sh/installation/) names which entry points
carry that guarantee, and
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh) is the host a
tab runs them on.

[RC support matrix](https://smithers.sh/docs/reference/support-matrix/) lists runtime evidence limits.

Durable execution is provided by the Node and Bun compositions over SQLite or
PostgreSQL. See [database configuration](./database/docs/concepts/sqlite-only.md)
for selection, schema identity, and transaction guarantees.
The shared engine consumes injected Effect services. Browser-safe authoring and
inspection do not establish browser or edge durable execution. Native drivers
remain explicit subpaths so the root does not import `node:sqlite` or `bun:sqlite`.
See [runtime portability](./docs/concepts/runtime-portability.md) for the contract
and the native cross-runtime restart regression.

## The Node runtime

`@smthrs/flows/NodeRuntime` is the module a host program calls to stand a
durable engine up. `layerHost` decides the whole composition; `layer`, `make`,
and `storage` hand progressively more of it back to the caller.

The driver-neutral root installs no platform adapter. Select these optional
prerequisites before importing `NodeRuntime`: `@smthrs/platform-node`, `@effect/platform-node`,
`@effect/platform-node-shared`, and `@effect/sql-sqlite-node`. Not on npm yet; see
[Installation](https://smithers.sh/docs/installation/#use-the-libraries).

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "local-worker" }
  },
  registerFlows
)
```

That call adds the contained Node host, the kernel's guarded host surface over
an unattended grant store, the default step boundary and workspace sandbox, a
process-table liveness probe, and signal handling that releases every run the
host owns before it shuts down.
[Stand up a durable Node runtime](https://flows.smithers.sh/guides/stand-up-a-node-runtime/)
compares the four entry points and says which one a given program should call.

## Documentation

The published site is https://flows.smithers.sh.

- [Quickstart](https://flows.smithers.sh/quickstart/): one flow end to end on a
  real durable engine, including the capability its body needs.
- [The aggregate surface](https://flows.smithers.sh/concepts/aggregate-surface/):
  why the authoring names are flat, the infrastructure packages are namespaces,
  and the platform bundles are absent.
- [Run a child flow in a sandbox](https://flows.smithers.sh/guides/run-a-child-flow-in-a-sandbox/):
  the tier where the child's own code executes on another machine.
- [API reference](https://flows.smithers.sh/reference/api/): every public
  export, with the options each entry point takes.
- [Troubleshooting](https://flows.smithers.sh/troubleshooting/): every typed
  refusal these modules raise, and what to change.

## Runtime portability is a required contract

The engine and product flows are platform-independent Effect programs. Node and Bun
provide different SQL and host layers to the same runtime, migrations, journal,
stores, cache, and recovery logic. A Node subprocess is not a Bun compatibility
mechanism. Keep filesystem, process, crypto, HTTP and SQL access behind their
existing Effect services, selected at the executable's composition root.

`@smthrs/flows/Runtime` consumes an injected Effect `SqlClient` and host services.
`@smthrs/flows/NodeRuntime` and `@smthrs/flows/BunRuntime` select matching native
services. Database adapters are `@smthrs/database/node/NodeDatabase` and
`@smthrs/database/bun/BunDatabase`; both share the schema guard, startup retry
policy and `DurableWriter`. Domain code must not open an extra database or create
its own command, job, event, or locking ledger around the durable engine.

Runtime parity must be demonstrated by the same execute, persist, restart, resume
and cancellation scenarios, including opening a Node-created database in Bun and
vice versa. A browser-safe import alone does not prove durable browser execution.

For a Bun executable, install `@smthrs/platform-bun`, `@effect/platform-bun`,
`@effect/platform-node-shared`, and `@effect/sql-sqlite-bun`. Not on npm yet; see
[Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Then use `BunRuntime.layerHost` with the same options and registered flows.
