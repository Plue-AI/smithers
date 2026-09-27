# @smthrs/flow

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://flow.smithers.sh

`@smthrs/flow` is the authoring model for durable workflows in TypeScript. You
declare each step as an **action**: a stable name and the schemas on either side
of it, with no code. You compose those declarations into a **flow** whose body is
a pure function that builds a plan. The code that does the work attaches
separately, as an Effect layer.

The package carries no engine. It declares the `FlowRuntime` port that an engine
implements, so the whole authoring surface bundles for a browser and a test can
swap the runtime for a fixture without touching a declaration.
[`@smthrs/engine`](https://engine.smithers.sh) implements that port;
[`@smthrs/engine-store`](https://engine-store.smithers.sh) makes it durable.

## Why

A job that calls a model, spawns a build, uploads an artifact, or waits on a
person cannot afford to start over when the process dies. Recovering by hand
means writing your own checkpoint table, your own idempotency keys, and your own
"did this already run" branch around every call.

A flow builds its plan before anything runs. Reproducible keys require callbacks
whose source and complete semantic captures are stable. `Node.capture` declares
those captures; the canonical `Interpreter.layerWithImplementations` composition
refuses callbacks with process-local identity before dispatch. An engine records
each step as it settles, so a re-run
under the same execution id reads the recorded result rather than repeating the
work. The same property is what lets the engine retry a step, cache it, park a
run on a timer or a human answer for a week, and put one step on another machine,
none of which the flow's author arranges.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Node.js 26.4.0 or later. `effect` is a peer at exactly `4.0.0-rc.115`: two copies of
`effect` in one program are two sets of service tags.

Running a flow adds an engine and a platform crypto service.

## Declare a flow and run it

This program declares one recorded step, attaches its implementation, and runs
the flow on the in-memory engine.

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
  implementationVersion: "summarize/v1",
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
  Summarize.toLayer(
    ({ url }) => Effect.succeed(`A summary of ${url}.`),
    { implementationVersion: "summarize/v1" }
  )
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

Run it and the implementation runs once. Run the same execution id again and it
does not: the engine finds the execution that already settled and answers with
its recorded result. Swap `FlowEngine.layerMemory` for the SQLite-backed engine
in `@smthrs/engine-store` and the same behavior survives a restart, with nothing
above the swap changing.

Forgetting an implementation is a compile error rather than a run that dies
partway through. `Summarize.call(payload)` puts a requirement in the node's type,
`Flow.make` reads the union of those off the node its body returns, and
`Summarize.toLayer(...)` is what discharges it.

## Callback identity and persisted compatibility

Use `Node.capture` for flow bodies, `Node.map` callbacks, `Node.branch` predicates,
and `Node.bindPlanned` builders. Validate external configuration with its schema
first, then close over the exact record passed to `Node.capture`; it is deeply
frozen. Include every semantic value, including payload fields used by a nested
callback and an explicit version for imported implementation behavior. JavaScript
cannot inspect closures, so the library cannot prove that a capture declaration
is complete. Capturing `{}` is valid only when no semantic state outside the
callback source affects its behavior.

`Graph.build(flow, payload, { callbackIdentity: "stable" })` reports unstable
callback sites and `Graph.drafts` refuses them. `Interpreter.layerWithImplementations`
uses that policy by default and rejects the graph before any action dispatch.
The lower-level `Graph.build`, `Interpreter.interpret`, and `Interpreter.layer`
default to `process-local` for compatibility; they make no reproducible callback
identity guarantee unless `callbackIdentity: "stable"` is selected. An explicit
`process-local` option is available on the canonical composition for experimentation.

Existing `sha256-source-captures/v4`, `sha256-source-ephemeral/v4`, and step-key
encodings remain unchanged. Equal source and captures reproduce identity across
processes. Changed source, captures, or captured implementation version require
a newly planned run; this check does not migrate or reapprove existing plans.
Action implementations use a separate `implementationVersion` contract.
Canonical `Interpreter.layerWithImplementations` requires it for sealed actions
that declare an idempotency key, because those actions can reuse recorded content.
Declare the version on `Action.make`, and attest the same version in `toLayer`.
A missing or different registration version is refused. The interpreter also
checks each graph declaration against the registry before dispatching any action,
including actions in untaken branches. The declared version enters plan material,
sealed result keys, and ordinal invocation scopes. Object-form idempotency keys
remain rename-stable; their caller-owned input cannot override the explicit
implementation version.

The version is a semantic compatibility declaration. Cover the handler and every
service/configuration change that can affect its result. Equal versions authorize
reuse even if JavaScript source changed. Different versions require a new plan
and execution ID; this is not an upgrade API for an already persisted run. Existing
completed executions keep their recorded outcomes. Omitted versions preserve
legacy key material exactly and do not infer handler identity from source.
The low-level `Interpreter.layer` and `Interpreter.interpret` retain this legacy
behavior: equal identity inputs can return the old handler's recorded result
after its code changes. Selecting stable callback identity alone does not change
that handler-reuse contract.

Canonical version admission is independent of `callbackIdentity`; choosing
`process-local` callbacks cannot bypass it. Keyless sealed actions use run-local
invocation keys, while compensable and irreversible actions do not use content-key
caching, so those declarations may omit a version. The canonical interpreter also
refuses detached action nodes whose declarations are unavailable for checking.
No policy can verify that an author's semantic version declaration is complete.

## What is in the package

Every namespace below is exported from the root and from a matching
`@smthrs/flow/*` subpath.

| Namespace         | Role                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `Flow`            | Declares a durable program and its execute, poll, interrupt, resume, and rollback API.  |
| `Action`          | Declares one recorded step: schemas, tier, idempotency identity, retry policy, caching. |
| `Graph`           | Builds the plan a body describes, before any of it runs.                                |
| `Interpreter`     | Drives that plan, and registers a flow with the runtime.                                |
| `FlowRuntime`     | The execution port this package declares and an engine implements.                      |
| `DurableDeferred` | A persisted promise a flow awaits across process restarts, completed by token.          |
| `DurableClock`    | A timer that eventually completes a `DurableDeferred`.                                  |
| `DurableQueue`    | Sends work to a persisted worker and awaits its result.                                 |
| `Sleep`           | The system timer, declared as an ordinary action.                                       |
| `WaitFor`         | The system wait point, declared as an ordinary action.                                  |
| `Poll`            | The durable poller: attempts as rounds, waits as durable timers.                        |
| `Stall`           | The stall breaker: ends rounds whose tree, failing checks, or output held still.        |
| `HumanTask`       | Asking a person something, with validation, re-asking, and a deadline.                  |
| `RetryPolicy`     | Data describing when a runtime should retry a failed action.                            |
| `StepIdentity`    | The one canonical derivation of ordinal step identity.                                  |

## Documentation

Full documentation is at [flow.smithers.sh](https://flow.smithers.sh).

- [Quickstart](https://flow.smithers.sh/quickstart/): the program above end to
  end, including what happens on the second run.
- [Flows and actions](https://flow.smithers.sh/concepts/flows-and-actions/): the
  two nouns, and why an implementation attaches as a layer.
- [Bodies are plans](https://flow.smithers.sh/concepts/bodies-and-plans/): what a
  body may not do, and why that restriction is what makes replay work.
- [Guides](https://flow.smithers.sh/guides/build-a-body/): composing a body,
  retries, durable waits, human decisions, child flows, and rollback.
- [API reference](https://flow.smithers.sh/reference/api/): every public export.
- [Testing](https://flow.smithers.sh/testing/): topology, interpretation, and
  execution, and which level a given assertion belongs at.

## License

MIT. See `LICENSE`.

`Action.InfraInterrupt` is an explicit adapter marker for `interruptRetryPolicy`; ordinary fiber interruption is never converted to it.
