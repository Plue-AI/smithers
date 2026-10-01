---
title: "API reference"
description: "Every public export of @smthrs/flows: the barrel's namespaces and flat authoring names, the NodeRuntime composition roots and their options, and the SandboxedFlow runner with its errors, limits, and schemas."
---

`@smthrs/flows` has three public entry points.

| Entry point                   | Contents                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `@smthrs/flows`               | The barrel: twenty engine packages re-exported, plus `namespaces`. Browser-safe. |
| `@smthrs/flows/Runtime`       | Shared engine/storage composition over injected Effect SQL and host services.    |
| `@smthrs/flows/NodeRuntime`   | Native Node composition, preserving the existing API.                            |
| `@smthrs/flows/BunRuntime`    | Native Bun composition using the Bun SQL adapter.                                |
| `@smthrs/flows/SandboxedFlow` | Running a child flow's own code inside a provisioned machine. Node-only.         |

```ts
import { Action, Flow, Kernel, RunStore } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
```

`@smthrs/flows/internal/*` and `@smthrs/flows/*/index` are blocked in the export
map and are not public.

Durable execution is supported on Node.js 26.4.0 or later with local SQLite.
The root entry point bundles for browsers, which buys authoring and inspection;
it does not make a browser a durable host, and supplying another SQL client does
not change that.

## Example

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Layer, Schema } from "effect"
const Greet = Action.make("demo/Greet", { payload: { name: Schema.String }, success: Schema.String })
const Hello = Flow.make("demo/Hello", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})
const code = Interpreter.layer(Hello).pipe(
  Layer.provideMerge(Greet.toLayer(({ name }) => Effect.succeed(`hi ${name}`))),
  Layer.provideMerge(Action.layerImplementations)
)
const host = NodeRuntime.layerHost(
  { filename: ".flows/engine.db", workspaceRoot: ".", owner: { hostId: "demo" } },
  code
)
console.log(
  await Effect.runPromise(
    Hello.execute({ name: "ada" }, { executionId: "demo-1" }).pipe(Effect.provide(host), Effect.scoped)
  )
)
```

## The barrel

### Namespace exports

Each engine package is re-exported as a namespace, so a package's own module is
one level below it (`Journal.SqlJournal.layer`).

| Namespace       | Package                                       |
| --------------- | --------------------------------------------- |
| `Artifacts`     | [`@smthrs/artifacts`](/api/artifacts)         |
| `Canonical`     | [`@smthrs/canonical`](/api/canonical)         |
| `Capability`    | [`@smthrs/capability`](/api/capability)       |
| `Crypto`        | [`@smthrs/crypto`](/api/crypto)               |
| `Database`      | [`@smthrs/database`](/api/database)           |
| `Engine`        | [`@smthrs/engine`](/api/engine)               |
| `EngineStore`   | [`@smthrs/engine-store`](/api/engine-store)   |
| `Jj`            | [`@smthrs/jj`](/api/jj)                       |
| `Journal`       | [`@smthrs/journal`](/api/journal)             |
| `Kernel`        | [`@smthrs/kernel`](/api/kernel)               |
| `Keys`          | [`@smthrs/keys`](/api/keys)                   |
| `Observability` | [`@smthrs/observability`](/api/observability) |
| `Plan`          | [`@smthrs/plan`](/api/plan)                   |
| `PlanStore`     | [`@smthrs/plan-store`](/api/plan-store)       |
| `RunStore`      | [`@smthrs/run-store`](/api/run-store)         |
| `Sandbox`       | [`@smthrs/sandbox`](/api/sandbox)             |
| `StepCache`     | [`@smthrs/step-cache`](/api/step-cache)       |
| `Sync`          | [`@smthrs/sync`](/api/smithers-sync)          |

Namespacing is what preserves constructors like
`Kernel.ChildProcessSpawner.layerNoop` and `RunStore.RunStore.layer`. The
`Capability` namespace owns exact-resource bounds, the pattern grammar, and
permission failures; `Plan` owns step identity, graph compilation, and static
effect declarations, with `PlanStore` holding the append-only rows they are
recorded in; `Journal` owns the append-only event record
every durable run replays from and the redaction rules that keep a credential
out of both a committed row and a log line.

### Flat exports

[`@smthrs/flow`](/api/flow) is re-exported flat, so all sixteen authoring names
sit at the top level: `Action`, `DurableClock`, `DurableDeferred`,
`DurableQueue`, `Fault`, `Flow`, `FlowRuntime`, `Graph`, `HumanTask`,
`Interpreter`, `Poll`, `RetryPolicy`, `Sleep`, `Stall`, `StepIdentity`, and
`WaitFor`.

`TimeTravel` from [`@smthrs/time-travel`](/api/time-travel) is the second flat
export, and it is a service key rather than a namespace:

```ts
import { TimeTravel } from "@smthrs/flows"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
})
```

`TimeTravel.layer` provides it. The rest of that package, including `Frame`,
`TimeTravelStore`, and `EffectBoundary`, is reached through
`@smthrs/time-travel` directly.

The `@smthrs/platform-*` bundles are deliberately absent. A program chooses
[`@smthrs/platform-node`](/api/platform-node),
[`@smthrs/platform-bun`](/api/platform-bun), or
[`@smthrs/platform-browser`](/api/platform-browser) directly.

### `namespaces`

```ts
const namespaces: ReadonlyArray<string>
```

The sorted list of every name this barrel exports, covering both the per-package
namespaces and the flat authoring names. It is the package's one runtime value,
and it names the whole engine: enumerate it to build a documentation index or a
conformance check over the surface you depend on.

## NodeRuntime

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
```

The supported Node composition. Importing this module opens `node:sqlite`
through `@smthrs/database/node/NodeDatabase`, which is why the browser-safe root
does not re-export it.

Construction is ordered by layer dependency: the SQLite parent directory is
created before the database opens, migrations finish before any store is built,
the engine is built over those stores, and `registerFlows` finishes before the
resulting services are exposed. A persisted run therefore cannot resume through
a composition before its flow has been registered.

### `Options`

Configuration for `make` and `layer`.

On native Node and Bun hosts, `filename` may be outside `workspaceRoot`.
The host creates its parent directory even when the injected filesystem refuses
that path. Keeping the database outside a served checkout prevents engine
writes from changing the working-copy tree. `workspaceRoot` still confines
flow file actions; the database path is trusted host configuration.

| Field              | Type                                               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filename`         | `string`                                           | SQLite database filename. Resolved to an absolute path at the call; its parent directory is created recursively.                                                                                                                                                                                                                                                                                                                      |
| `workspaceRoot`    | `string`                                           | The workspace file actions may read or mutate. Resolved to an absolute path at the call.                                                                                                                                                                                                                                                                                                                                              |
| `owner`            | `{ hostId: string }`                               | Stable identity of this engine host.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isAlive`          | `Ownership.LivenessCheck`                          | Whether a previously recorded owner is still alive. Required, and a stub is not an answer: a check that returns `false` without asking makes the engine steal runs out of live processes. Receives the claim context as well as the owner.                                                                                                                                                                                            |
| `canExecute`       | `(row) => Effect<boolean>` (optional)              | Routes shared-store runs to the host configured for their workspace. Checked before claiming a run, including automatic wakes.                                                                                                                                                                                                                                                                                                        |
| `requestResume`    | `(executionId, reason) => Effect<void>` (optional) | Records that the engine has asked a PARKED execution to resume: `"deferred"`, `"clock"`, or `"parent"`. A control plane that refuses to re-enter a parked run nobody asked for reads it to tell an engine wake from its own heartbeat sweep.                                                                                                                                                                                          |
| `cacheEnvironment` | `Action.CacheEnvironment`                          | Optional. The complete runtime environment a sealed step's recorded result may be reused under. Absent by default, which keeps every sealed key scoped to its own run.                                                                                                                                                                                                                                                                |
| `sourceRevision`   | `string \| (() => string \| undefined)`            | Optional. The revision of the tree this host read its flows out of, which every recorded graph page carries beside the declaration sites, so a reader opens the declared file at that revision and not at whatever is on disk. A host that only learns the answer after this call declares a reader instead of a string; it is asked once per recorded page, and an answer that is not a revision records nothing. Absent by default. |

`Ownership.sameHostPidProbe` from [`@smthrs/run-store`](/api/run-store) probes
the process table only for the claim context's host (`context.claimant.hostId`).
It returns `false` (treated as dead) for an owner on another host, allowing
takeover once that owner's lease has expired. A fresh heartbeat still blocks
takeover. To preserve foreign-host owners, use `HostLiveness.isAlive({ hostId })`
from [`@smthrs/platform-node`](/api/platform-node), which returns `true` for
foreign hosts, or supply a distributed liveness check. `HostLiveness.isAlive`
is the `layerHost` default and refuses foreign-host takeover even after lease
expiry. A multi-process deployment answers from its supervisor or lease system.

#### Cross-run step cache reuse

A sealed action that declares an idempotency key, an implementation version and
a `hard` `fileBoundary` publishes its result to the step cache. Whether a later
run can read that result back is decided by `cacheEnvironment`.

While it is absent the engine folds the execution id into the step key, so each
run records its result under an address no other run can spell and nothing is
reused across runs. This is the default because the engine cannot derive the
value: it names the semantic runtime layers and the effective capability groups
a result was computed under, and only the host knows both. Declare it and a
second run addresses the first run's row, replays the recorded outputs, and
never enters the body again.

Declare it only when every machine that shares this database would have
produced the same bytes under the layers named. The engine still re-measures a
step's declared read set before serving a hit and refuses one whose declaration
no longer matches the host, but it cannot check a claim about a toolchain, a
model route, or a code version that the layers failed to name. A host that
cannot enumerate its environment leaves the field out. An incomplete value is
refused with `RuntimeConfigurationError` at construction, because it is cache
key material.

### `RuntimeConfigurationError`

```ts
class RuntimeConfigurationError extends Schema.TaggedError("@smthrs/flows/RuntimeConfigurationError")({
  code: "invalid_runtime_configuration"
  field: string
  message: string
})
```

Thrown synchronously by `storage`, `make`, `layer`, and `layerHost` for invalid
construction input. `field` names the single option that was wrong, so an
embedder can distinguish an empty `filename` from an empty `owner.hostId`
without parsing the message. Nothing is created before it is thrown: no database
is opened and no signal listener is installed.

### `storage`

```ts
const storage: (filename: string, workspaceRoot?: string) => Layer<...>
```

Provides the migrated database, the durable stores (`SqlJournal`, `RunStore`,
`AttemptStore`, `CacheStore`, `DurableEngineState`), the `OwnerIdentity` minter,
the `Workspace`, and a filesystem `ArtifactStore`, and constructs no engine.

`workspaceRoot` defaults to the database file's own directory. The journal queue
is created with capacity 1,024 and `overflow: "reject"`. Artifacts live beside
the database under `objects/`, so a database at `<root>/.flows/engine.db` stores
blobs in `<root>/.flows/objects`.

This is the lower-level seam for an integration that builds another
engine-backed service over the same storage context. Application entry points
normally use `layer` or `layerHost`.

### `make`

```ts
const make: (
  options: Options,
  stepBoundary: Layer<StepBoundary.Service, E1, R1>,
  workspaceSandbox: Layer<WorkspaceSandbox.Service, E2, R2>,
  registerFlows: Layer<A, E3, R3>,
  registry?: Layer<A4, E4, R4>
) => Effect<Context<...>, ..., Crypto | FileSystem | Jj | Scope>
```

Builds the production service context in the current scope and returns it. The
caller selects the filesystem boundary and workspace sandbox layers and supplies
a registration layer, typically a merge of action implementation layers and
`Interpreter.layer(flow)`. `Jj`, Effect's `FileSystem`, and Effect's `Crypto`
remain requirements. Closing the surrounding scope closes the database, the
journal writer, the sweeper, and the active engine fibers through their existing
finalizers.

### `layer`

```ts
const layer: (
  options: Options,
  stepBoundary: Layer<StepBoundary.Service, E1, R1>,
  workspaceSandbox: Layer<WorkspaceSandbox.Service, E2, R2>,
  registerFlows: Layer<A, E3, R3>,
  registry?: Layer<A4, E4, R4>
) => Layer<..., ..., Crypto | FileSystem | Jj>
```

The same composition as a scoped `Layer`. `registerFlows` is the final startup
phase rather than a layer merged beside the engine, which serializes the
durability-sensitive order. Shutdown is scope closure; this function installs no
process or signal handlers.

`registry` is the optional catalog the registration phase reads from. A host that
discovers its flows rather than listing them passes
[`@smthrs/registry`](/api/registry)'s `Registry.layerProject({ root })`, and
builds `registerFlows` from `Executable.layer(...)`. The registry is provided
beneath registration and above the engine, so every discovered flow is
registered before the runtime accepts a launch. Omitting it is exactly the
registry-free behavior.

`make`, `layer`, and `layerHost` require the registry argument when its type
parameters name a service, error, or requirement. Omitting it is valid only
when all three registry types are `never`.

### `HostOptions`

Configuration for `layerHost`. Only `filename`, `workspaceRoot`, and `owner` are
required.

| Field               | Type                                               | Default                            | Meaning                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filename`          | `string`                                           | required                           | SQLite database filename. Its parent directory is created recursively.                                                                                                                               |
| `workspaceRoot`     | `string`                                           | required                           | The project workspace, resolved once while the host is constructed. Every Jj operation stays bound to that root.                                                                                     |
| `owner`             | `{ hostId: string }`                               | required                           | Stable identity of this engine host.                                                                                                                                                                 |
| `isAlive`           | `Ownership.LivenessCheck`                          | `HostLiveness.isAlive({ hostId })` | Whether a recorded owner is still alive. The default answers from this machine's process table and never declares another host's owner dead.                                                         |
| `rules`             | `GrantStore.MakeOptions["rules"]`                  | none                               | The capability rules this host grants without asking. The grant store is unattended, so a capability no rule allows is denied rather than escalated. Accepts a flat rule list or a list of rulesets. |
| `signals`           | `ReadonlyArray<NodeJS.Signals>`                    | `["SIGINT", "SIGTERM"]`            | The signals that shut the runtime down. An empty list installs no handler at all.                                                                                                                    |
| `shutdownTimeoutMs` | `number`                                           | `defaultShutdownTimeoutMs`         | How long a graceful shutdown may take before the host leaves with the signal's own exit code.                                                                                                        |
| `containment`       | `ContainedSpawner.Options & ProcessReaper.Options` | none                               | Process containment and reaping options for the host spawner.                                                                                                                                        |
| `canExecute`        | `(row) => Effect<boolean>`                         | none                               | The same shared-store routing check as the runtime `Options` field.                                                                                                                                  |
| `cacheEnvironment`  | `Action.CacheEnvironment`                          | none                               | The same cross-run cache environment as the runtime `Options` field, provided under the engine.                                                                                                      |
| `sourceRevision`    | `string \| (() => string \| undefined)`            | none                               | The same source revision declaration as the runtime `Options` field, recorded on every graph page.                                                                                                   |

Every option is validated and snapshotted at the call. Rule arrays, rule
objects, signal lists, and containment callbacks are all copied, and relative
paths are resolved against the working directory as it stood at the call, so
mutating the options object afterward changes nothing.

### `defaultShutdownTimeoutMs`

```ts
const defaultShutdownTimeoutMs: 30_000
```

How long a graceful shutdown may take before the host leaves anyway.

### `maximumShutdownTimeoutMs`

```ts
const maximumShutdownTimeoutMs: 2_147_483_647
```

The largest delay Node accepts without truncating it to a one-millisecond timer,
and the upper bound `shutdownTimeoutMs` is validated against.

### `signalExitCode`

```ts
const signalExitCode: (signal: NodeJS.Signals) => number
```

The status a process ended by `signal` exits with, which is 128 plus the
signal number: `130` for `SIGINT`, `143` for `SIGTERM`. A host that installs a handler
owes its supervisor the answer the default behavior would have given.

### `layerHost`

```ts
const layerHost: (
  options: HostOptions,
  registerFlows: Layer<A, E, R>,
  registry?: Layer<A2, E2, R2>
) => Layer<...>
```

Provides the whole Node host, storage, kernel, and engine from one call. The
returned layer has no requirements of its own; the registration and registry
arguments may still declare theirs.

What it adds over `layer`:

- The complete Node host from [`@smthrs/platform-node`](/api/platform-node) with
  process containment on. A spawned process gets its own process group, is
  signalled and then killed when its action's scope closes, and is recorded in
  the `ProcessLedger` so the next incarnation of this host reaps whatever a
  crash left running.
- The kernel's guarded `Host` surface over an unattended `GrantStore`, so an
  action reaches the host through the capability check rather than around it.
  Engine snapshot bookkeeping uses a distinct private `Jj` service, so it grants
  no repository authority to the action context.
- The default `StepBoundary` and the filesystem `WorkspaceSandbox`, the pairing
  that makes a sealed action's result eligible for the step cache.
- Signal handling. `SIGINT` or `SIGTERM` closes the runtime scope, releasing
  every run this host owns for another host to reclaim. A second signal, or a
  shutdown that outlasts `shutdownTimeoutMs`, leaves with the signal's own exit
  code instead of waiting on a finalizer that is not coming back.

A program that needs a different host, a different policy, or no signals at all
composes `layer` itself; nothing here is reachable only through this function.

## SandboxedFlow

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
```

Runs a child flow's own code inside a machine a `Sandbox.Provider` provisions.
`Sandbox.layerHost` from [`@smthrs/sandbox`](/api/sandbox) places a body's side
effects on a machine while its TypeScript keeps running in the engine host; this
module is the tier above that, where the child's own code executes in the guest.
It is Node-only: it bundles with esbuild and it starts a guest runtime.

```ts
const run = Effect.gen(function*() {
  const result = yield* SandboxedFlow.execute(Child, { n: 31 }, {
    provider,
    session: "child-1",
    entry: new URL("./child.ts", import.meta.url),
    runtime: "node",
    captureWork: true
  })
  // result.output is Child's success value, decoded through Child's own schema.
  // result.work is the Sandbox.Work git patch the guest left in its checkout.
  return result
})
```

`provider` is a `Sandbox.Provider` value you pass in: there is no string
registry, no lookup by name, and no environment variable default. The authoring
is `Flow.make` and `Action.make`, so a sandboxed child is declared the same way
every other flow is.

The runner protocol, the guest composition, the image requirements, and the
session key's exclusivity are on
[The sandboxed runner protocol](./concepts/runner-protocol.md).

### `SandboxedFlowError`

```ts
class SandboxedFlowError extends Schema.TaggedError("@smthrs/flows/SandboxedFlowError")({
  code:
    | "bundle_failed"
    | "session_failed"
    | "guest_failed"
    | "flow_failed"
    | "result_unreadable"
    | "result_invalid"
    | "result_overflow"
    | "diff_overflow"
    | "capture_failed"
    | "deadline_exceeded"
  message: string
  cause?: unknown
})
```

The failure type every protocol refusal in this module raises.

| `code`              | Meaning                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle_failed`     | The entry module could not be bundled.                                                                                                                |
| `session_failed`    | The provider could not acquire the machine, or a file or process operation on it failed.                                                              |
| `guest_failed`      | The guest runtime exited non-zero, including exit 126 or 127 for a runtime the image does not contain.                                                |
| `flow_failed`       | The child flow ran and reported a failure, including an entry that exports no flow of the requested tag.                                              |
| `result_unreadable` | The guest exited 0 but wrote no result, or one that is not the protocol's JSON, belongs to another attempt, or echoes a different capability ceiling. |
| `result_invalid`    | The result's `output` does not decode through the flow's success schema.                                                                              |
| `result_overflow`   | The result file exceeds `Limits.resultBytes`.                                                                                                         |
| `diff_overflow`     | The captured patch exceeds `Limits.diffBytes`.                                                                                                        |
| `capture_failed`    | Git refused the capture. The message starts with `not_a_repository`, `base_unresolved`, or `capture_failed`, the `Sandbox.CaptureError` reason.       |
| `deadline_exceeded` | The whole session outlived `ExecuteOptions.timeout`.                                                                                                  |

Messages quote the tail of the guest's stdout and stderr where they help, cut at
4 KiB and marked when they were cut. A child's typed error arrives as its tag and
its own fields, not as a stack trace into the bundle.

### `ExecuteError`

```ts
const ExecuteError: Schema.Union<[typeof SandboxedFlowError, typeof PermissionDenied]>
type ExecuteError = SandboxedFlowError | PermissionDenied
```

Every typed failure of a sandboxed execution. A child that needed a capability
the caller's ceiling does not hold fails with the kernel's own
`PermissionDenied` from `@smthrs/capability/Permission`, the same typed error a
local run of the child fails with.

### `Limits` and `ResolvedLimits`

```ts
interface Limits {
  readonly resultBytes?: number | undefined
  readonly diffBytes?: number | undefined
}

interface ResolvedLimits {
  readonly resultBytes: number
  readonly diffBytes: number
}
```

Bounds on what comes back from the guest. An omitted or `undefined` bound keeps
its default.

### `defaultLimits`

```ts
const defaultLimits: ResolvedLimits
```

| Bound         | Default | What it caps                     |
| ------------- | ------- | -------------------------------- |
| `resultBytes` | 5 MiB   | The result JSON the guest wrote. |
| `diffBytes`   | 100 MiB | The captured patch.              |

Limits are inclusive and count UTF-8 bytes, not characters. `resultBytes`
includes the complete JSON envelope. Result metadata can reject an oversized
file before transfer, and the read stops at the byte budget plus one. Native
filesystem streams receive `bytesToRead`; other providers use guest `head -c`,
which the image must supply. `diffBytes` bounds what the result carries into
the journal; the capture reads the whole patch before the bound is checked.

Guest stdout and stderr are drained concurrently with fixed-size diagnostic
tails retaining at most 4 KiB each, plus a truncation marker. Redaction runs during collection; when a credential
continues beyond a retained segment, the rest of that line is omitted. An
overlong unfinished quoted credential suppresses the rest of that stream.

### `ExecuteOptions`

| Field         | Type               | Default         | Meaning                                                                                                                                                                                                                        |
| ------------- | ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`    | `Sandbox.Provider` | required        | The provider that provisions the machine. A value, never a name.                                                                                                                                                               |
| `session`     | `string`           | required        | The session key the machine is acquired under. An exclusive claim: two live executions with one key share a machine, and the first to finish tears it down under the other. Reusing a key is what resume looks like.           |
| `entry`       | `URL \| string`    | required        | The module to bundle: a `file:` URL or an absolute path. It must export the flow being executed, under any name, and may export `layer`, an Effect `Layer` providing the implementations of the actions the flow's body names. |
| `runtime`     | `string`           | `"node"`        | The guest executable that runs the bundle: `"node"`, `"bun"`, or an executable path. Each path is quoted as one shell word. Use a wrapper script for flags.                                                                    |
| `captureWork` | `boolean`          | `false`         | Whether to capture the workdir's changes as a `Sandbox.Work`. The workdir must be the top of a git work tree with `git` on the guest's `PATH`.                                                                                 |
| `limits`      | `Limits`           | `defaultLimits` | Bounds on the result and the patch.                                                                                                                                                                                            |
| `timeout`     | `Duration.Input`   | 10 minutes      | The wall-clock budget for the whole session, acquisition through result readback. Uses platform timers, including chunked timers for long finite budgets. `Duration.infinity` disables the deadline.                           |

### `Result`

```ts
interface Result<A> {
  readonly output: A
  /** The workspace's work, or null when captureWork was off. */
  readonly work: Sandbox.Work | null
  /** The ceiling the guest enforced, as normalized any-of groups. No groups is unrestricted; null is no receipt. */
  readonly capabilityCeiling: ReadonlyArray<ReadonlyArray<CapabilityPattern>> | null
}

const CapturedWork: Schema.NullOr<typeof Sandbox.Work> // decodes a missing key as null
const EnforcedCeiling: Schema.NullOr<Schema.Array<Schema.Array<typeof CapabilityPattern>>> // decodes a missing key as null
```

`work` is `Sandbox.Work` from [`@smthrs/sandbox`](/api/sandbox): `Changed`
with a `git diff --binary` patch from `base`, or `Unchanged`. It is plain
tagged JSON, so the journal records it, and `SandboxMerge.apply` lands it on
the host.
`capabilityCeiling` is the receipt of the authority the child ran under. A
result journaled before ceilings crossed the machine boundary has no receipt
and decodes as `null`, which is not a claim of unrestricted authority.

### `resultSchema` and `ResultSchema`

```ts
type ResultSchema<Success extends Schema.Top> = Schema.Struct<{
  readonly output: Success
  readonly work: typeof CapturedWork
  readonly capabilityCeiling: typeof EnforcedCeiling
}>

const resultSchema: <Success extends Schema.Top>(success: Success) => ResultSchema<Success>
```

Builds the `Result` schema over a flow's success schema. This is what a parent
flow declares as its own `success` when its body is one sandboxed call.

### `execute`

```ts
const execute: <Tag, Payload, Success, Error, Requires>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  payload: Payload["Type"],
  options: ExecuteOptions
) => Effect<Result<Success["Type"]>, ExecuteError>
```

Runs `flow` with `payload` inside a machine `options.provider` provisions. The
session is acquired for the duration of the call and released when it returns,
so a normal completion tears the machine down and only a host crash leaves one
behind for a later execution with the same session key to reattach.

`payload` is the decoded payload, encoded through the flow's payload schema for
the wire. A value the schema's own JSON codec refuses is a programmer error and
dies, the same posture `Flow.executionId` takes.

The guest runs the child under the caller's current capability authority
intersected with the child's own declaration, and can only narrow it. See
[capability ceilings](./concepts/runner-protocol.md#capability-ceilings).

With `captureWork`, the base is the workdir's `HEAD`, resolved with
`Sandbox.resolveBase` as soon as the session is acquired, and the work is
captured with `Sandbox.capture` before the session is released. A workdir that
is not a git repository fails with `capture_failed` before the guest runs; this
replaces the stat snapshot that once listed changed files in any directory. See
[Capture the work a sandboxed child did](./guides/collect-a-workspace-diff.md).

### `SandboxedAction` and `action`

```ts
type SandboxedAction<Tag, Payload, Success> = Action.Declared<
  Tag,
  Payload,
  ResultSchema<Success>,
  typeof ExecuteError
>

function action<Tag, Payload, Success, Error, Requires, const Name extends string>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: { readonly name: Name }
): SandboxedAction<Name, Payload, Success>
function action<Tag, Payload, Success, Error, Requires, const Name extends string = never>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options?: { readonly name?: Name | undefined }
): SandboxedAction<Name | `${Tag}/sandboxed`, Payload, Success>
```

Declares the durable action a parent flow calls to run `flow` in a sandbox. Its
payload schema is the flow's, its success schema is `resultSchema` over the
flow's, and its error schema is `ExecuteError`. The tag is
`<flow tag>/sandboxed` unless `options.name` says otherwise. Both forms preserve
the literal name, so providing one declaration's implementation cannot satisfy
a differently named declaration. An optional name retains both possible tags.

From the parent's point of view the whole sandboxed execution is one action: the
engine journals one attempt, applies one retry policy, and replays one recorded
result.

### `ExecuteContext`

```ts
interface ExecuteContext<Payload> {
  readonly payload: Payload
  readonly executionId: string
  readonly callId: string
}
```

What `toLayer` hands an options function: the decoded payload, the parent
execution's id, and the engine's invocation key as `callId`. Combine `executionId`
and `callId` for a session key exclusive to this call, including parallel calls
with identical payloads. `callId` is preserved across retries and resume.
A runtime that supplies no `Action.CurrentInvocationKey` is refused as a defect
before acquiring a session.

### `toLayer`

```ts
const toLayer: <ActionTag, Tag, Payload, Success, Error, Requires>(
  declared: SandboxedAction<ActionTag, Payload, Success>,
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: ExecuteOptions | ((context: ExecuteContext<Payload["Type"]>) => ExecuteOptions)
) => Layer<Action.Requirement<ActionTag>, never, FlowRuntime | ...>
```

Implements an `action` declaration with `execute`. `options` is either the
placement itself or a function of the call's `ExecuteContext`:

```ts
SandboxedFlow.toLayer(RunChild, Child, ({ executionId, callId }) => ({
  provider,
  session: `child:${executionId}:${callId}`,
  entry: new URL("./child.ts", import.meta.url)
}))
```

Compose the returned layer beside `Interpreter.layer(parent)` over one
`Action.layerImplementations`, exactly as any other action implementation.

## See also

Each namespace in the table above has its own API reference, reached through the
links there. [`@smthrs/cli`](/api/cli) is this engine as the `smthrs` command
line, which builds its own durable engine through `NodeRuntime`. Depend on
individual `@smthrs` packages rather than this barrel when a smaller dependency
surface is worth the extra imports.
