# @smthrs/engine

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://engine.smithers.sh

The runtime that executes `@smthrs/flow` flows, plus the transport
projections that expose them. It implements `FlowRuntime`, the port
`@smthrs/flow` declares, over a low-level encoded contract, and ships a
volatile in-memory implementation of it; `@smthrs/engine-store` supplies
durable persistence over the same seam.

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Built on [Effect](https://effect.website): flows, actions, and the engine are
Effect values you compose as layers. `effect` is a peer dependency pinned to
one exact version per release, listed under `peerDependencies` in
`package.json`.

## Mental model

A `Flow` is the durable program and `Action` values are its recorded
operations, both defined in `@smthrs/flow`. This package is what runs them.

```text
@smthrs/flow                    @smthrs/engine
  Flow, Action,   ── port ──▶   FlowEngine
  DurableDeferred,  FlowRuntime   records, suspends, resumes
  DurableClock,                        │
  DurableQueue,                        ▼
  RetryPolicy                    Encoded seam
                                 (in-memory here,
                                  durable in engine-store)
```

Everything that decides behavior lives above the seam, in `makeUnsafe`: step
identity, the retry decision, trampoline rounds, and the suspended-resume loop.
Everything below it decides only where state lives. That is what makes
`layerMemory` a real engine rather than a mock, and what lets
`@smthrs/engine-store` swap in durability without changing a single decision.

## The shortest program

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

const BuildLayer = Layer.mergeAll(
  Compile.toLayer(({ target }) => Effect.succeed(`${target}.js`)),
  Interpreter.layer(Build)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const built: Effect.Effect<string> = Build.execute(
  { target: "app" },
  { executionId: "build-app-1" }
).pipe(Effect.orDie, Effect.provide(BuildLayer))
```

Submitting the same `executionId` again returns the recorded result and never
calls `Compile` a second time.

## Public API

The root exports these namespaces, also available from matching
`@smthrs/engine/*` subpaths. The flow-authoring namespaces live in
[`@smthrs/flow`](https://flow.smithers.sh).

| Namespace         | What it is                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine`      | The `Encoded` seam a store implements, the `makeUnsafe` adapter, in-memory `layerMemory`, per-run state `makeInstance`, journal `Lineage`, trampoline `Round`, the compensable `SnapshotBoundary`, and the coded refusals. |
| `FlowProxy`       | Derives an Effect `RpcGroup` or `HttpApiGroup` from a list of flows: execute, discard, and resume per flow.                                                                                                                |
| `FlowProxyServer` | Binds those derived definitions to a running engine.                                                                                                                                                                       |

Full signatures: <https://engine.smithers.sh/reference/api/>.

## Documentation

| Page                                                                           | What it covers                                                   |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [Quickstart](https://engine.smithers.sh/quickstart/)                           | Run a flow, then prove the second submission replays.            |
| [The port and the seam](https://engine.smithers.sh/concepts/port-and-seam/)    | Why the engine is two layers, and what crosses the seam encoded. |
| [Execution identity](https://engine.smithers.sh/concepts/execution-identity/)  | Caller-supplied execution ids, joins, and refused reuses.        |
| [Step identity](https://engine.smithers.sh/concepts/step-identity/)            | Cache keys, invocation keys, and the keyless-dispatch guard.     |
| [Retries and attempts](https://engine.smithers.sh/concepts/retries/)           | The single retry decision point and the durable attempt counter. |
| [Suspension and cancellation](https://engine.smithers.sh/concepts/suspension/) | Parking, the caller's budget, and interrupt semantics.           |
| [Trampoline rounds](https://engine.smithers.sh/concepts/trampoline-rounds/)    | Handoffs, derived round ids, and `maxRounds`.                    |
| [Troubleshooting](https://engine.smithers.sh/troubleshooting/)                 | Every refusal and warning, with the fix.                         |

## In-memory lifetime

`FlowEngine.layerMemory` is a deterministic test and local-development
runtime, not a bounded store. It retains completed executions, action
settlements, deferred results, and clocks until the layer scope closes; there
is no eviction option. It rebuilds a submitted payload through the flow's own
payload schema constructor at admission and again on every re-drive, so caller
or handler mutation cannot rewrite replay state: structs, arrays, and records
the schema declares are copied, and values it declares opaque are shared by
reference. Same-key in-flight actions share one settlement.

`executionId` is caller-supplied identity. A repeated id joins the run that
already owns it and answers with that run's recorded result, so a retried
submission is idempotent; a reuse that names a different flow declaration, or
that arrives with a different payload, is refused with
`ExecutionIdentityConflict`. The derived transports pass the field through from
the request body by default. Set the `executionId` option on either
`FlowProxyServer` layer to apply one `ExecutionIdScope` to execute, discard, and
resume requests before they reach the engine.
