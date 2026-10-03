---
title: "Run a discovered flow"
description: "Turn descriptors into registered durable flows: register the delegates a project's flows name, build the catalog, and hand the whole registry to a Node host."
sidebar:
  order: 3
---

`Executable` is the bridge from a descriptor to something the engine can drive.
It loads the body, resolves the delegate, and returns a durable flow plus the
layer that registers it. [Delegation](../concepts/delegation.md) explains the
model; this guide is the wiring.

## Register the flows a descriptor may delegate to

A delegate is any `@smthrs/flow` flow whose payload is `Executable.Invocation`.
The contract is structural, so a `Flow.make` value satisfies it and so does a
test double:

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import * as Schema from "effect/Schema"

/** The driver every model-backed descriptor falls back to. */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  body: (invocation) => Node.succeed(invocation.prompt)
})

/** A named delegate a descriptor reaches with `flows: [shell]`. */
const Shell = Flow.make("shell", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  body: (invocation) => Node.succeed(invocation.input)
})
```

The tag is what a descriptor's `flows` entry names. `Executable.defaultAgent`
is the name a descriptor falls back to when it names none, and
`Options.agent` renames it for a host that calls its driver something else.

## Build the catalog

Metadata discovery can display literal primitive payload fields without
evaluating their module. Dynamic schemas and refinements remain unavailable
in that view. Planning and starting a run load the actual module decoder and
reject invalid input before creating a plan or admitting a run.

`Executable.catalog(options)` builds every descriptor the host can run and
reports the rest:

```ts
import * as Effect from "effect/Effect"

const built = Effect.gen(function*() {
  const catalog = yield* Executable.catalog({ delegates: [Agent, Shell] })
  console.log(`runnable: ${catalog.executables.map((one) => one.descriptor.name).join(", ")}`)
  for (const refusal of catalog.refused) {
    console.log(`${refusal.flow}: ${refusal.code}: ${refusal.message}`)
  }
})
```

Nothing here raises. A delegate only another host registers
(`missing_delegate`, `ambiguous_delegate`) and a defect in the entry itself
(`body_unavailable`, `invalid_module`) are both reported rather than thrown,
because one broken file must not take every unrelated flow down with it. The codes are what separate the two kinds: the first pair is a
statement about this host, the second is a defect in the flow.

For measured project helpers, use relative static imports or package `imports`
keys with one static file target. Transitive static imports and cycles share the
measured closure. Refresh after an edit; an old descriptor is refused before
any module is evaluated.

Discovery also measures literal `import()` and `require()` project helpers and
mapped aliases. Admission refuses those runtime loads, tsconfig aliases and
conditional mappings without one static target with `body_unavailable`: the
host module cache cannot guarantee fresh measured bytes, and deferred loads
can outlive temporary module cleanup. Installed packages without project
mappings and Node/Bun builtins remain host dependencies.

## Register everything runnable

`Executable.layer(options)` is the layer a host passes as its registration
phase. It registers every runnable flow, logs a warning naming each refusal,
and provides the whole `Catalog` as a service, so a command that lists or
diagnoses flows reads the same refusals the registration acted on:

```ts
import { Action } from "@smthrs/flow"
import * as Layer from "effect/Layer"

const registration = Executable.layer({ delegates: [Agent, Shell] }).pipe(
  Layer.provideMerge(Action.layerImplementations)
)
```

The layer requires the flow runtime it registers with, the action
implementation table a bridged dispatch resolves through, and the `Crypto` the
bridge derives a child execution id with. `Executable.Registration` is that
requirement as one type.

## Module action implementations

A `flows/<name>/flow.ts` module default-exports its `@smthrs/flow` declaration
and may also export `layer`, an Effect `Layer` containing its implementations:

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"

const Greet = Action.make("greeting/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

export const layer = Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`))

export default Flow.make("greeting", {
  description: "Greet the caller.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { name: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Greet.name }, (payload) => Greet.call(payload))
})
```

Use `Layer.mergeAll(...)` for multiple `Declared.toLayer(...)` and
`AgentAction.layer` values. The host owns `Action.Implementations`; export the
implementation layers directly. Providing `Action.layerImplementations` inside
the module creates a second action table and is unsupported. An exported
replacement table is refused at load as `invalid_layer`.
Loading builds the exported layer once in a child
scope of the host, with a module-local action implementation table. Action
lookup selects the module's implementations before the host's; independently
executed child flows retain their own registrations.
Registering `executable.layer` supplies that context to both the module and
its input adapter. Keep registration and execution inside the scoped host that
loaded the executable. Rebuilding its registration does not close the shared
module resources; the loading host owns them. Refresh replaces the implementation
scope together with the flow.
A module load with `layer` therefore needs a scoped host context with the
runtime already available; metadata discovery needs neither.

The local CLI and TUI provide the guarded `FileSystem`, `Path`,
`ChildProcessSpawner`, `HttpClient`, and the `AgentAction.layer` services:
`Agent`, `AgentAction.Host`, `SeatResolver`, `Sandbox`, `Steering.Source`,
`Crypto`, `Budget`, `QuotaClassifier`, `Evaluator`, and `FlowRuntime`.
Library hosts supply their own implementations of the services they support.
Provide any additional dependencies inside the exported layer.

A missing construction-time service produces `ExecutableError` code
`missing_service`, naming the flow and service key. An invalid `layer` export
produces `invalid_layer`; other construction failures produce `layer_failed`.
They appear in `Catalog.refused` without taking down unrelated flows.

Acquire handler dependencies during layer construction with `Layer.unwrap`
or `Layer.effect` to have them validated at load. No action body runs during
loading, so a service requested only inside a handler is refused when that
action first runs: the action dies with the same `missing_service`
`ExecutableError`, naming the flow, the service key and the action.

## Rebuild one entry while serving

A flow written or edited after the host started is a descriptor with no
executable: the catalog it would come from was built once. `Executable.layer`
also provides `Executable.Refresh`, which rebuilds one entry in place.

```ts
import * as Effect from "effect/Effect"

const rebuild = Effect.gen(function*() {
  const refresh = yield* Executable.Refresh
  const outcome = yield* refresh.flow("authored")
  // "Registered" | "Refused" | "Removed" | "Fixed"
  return outcome._tag
})
```

It rescans discovery, loads that flow's body from the bytes now on disk,
registers it, and swaps it into the catalog. The `Catalog` service object does
not change, so readers that took it at startup see the new entry. The previous
body stays registered until the new one is, and refreshes are serialized.

A host that serves part of its catalog out of its own measured bundle passes
`refreshable` to hold those entries fixed:

```ts
const registration = Executable.layer({
  delegates: [Agent, Shell],
  refreshable: (descriptor) => descriptor.provenance.pack === undefined
})
```

`refresh.flow` answers `Fixed` for those and leaves the catalog alone. A host
that assembles its catalog itself — several sources, or a loader per source —
uses `Executable.layerRefreshable(built, options)` instead, which adds the
live `Catalog` and the `Refresh` without registering anything twice.

## Hand the registry to a Node host

`Registry.layerProject({ root, packs })` is the registry a Node host
discovers a project in: `<root>/flows/**` first, then every installed pack,
under one refreshable first-found registry.

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Registry from "@smthrs/registry/Registry"

const host = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: process.cwd(),
    owner: { hostId: "local" }
  },
  registration,
  Registry.layerProject({ root: process.cwd() })
)
```

The host builds the registry between the engine and the registration phase, so
`Executable.layer` has both the catalog and a live engine in hand. After that,
running a discovered flow by name reaches a registered durable flow instead of
an empty catalog.

A project with no `flows/` directory is not a failure: it has no flows yet,
which is the state [`smthrs init`](/cli/init) leaves behind.
`layerProject` checks for that optional directory on every scan. Creating the
first flow or removing and recreating the directory is reflected by `refresh()`.
A pack that declares a flows directory it does not ship is a broken installation and fails the layer as
`RegistryError { code: "invalid_pack" }` naming the pack, instead of quietly
emptying the registry the project's own flows were in.

## Build one executable at a time

Two constructors build a single flow, for a host that already knows which one
it wants:

```ts
import * as Registry from "@smthrs/registry/Registry"

const one = Executable.fromRegistry("review", { delegates: [Agent, Shell] })
const same = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  return yield* Executable.fromDescriptor(yield* catalog.get("review"), { delegates: [Agent, Shell] })
})
```

Both fail rather than report, which is what a single named launch wants: an
operator asking for one flow should be told why it will not run. The two halves
fail differently. Looking the name up fails with
`RegistryError { code: "not_found" }`, naming the method that asked, so
`fromRegistry` on an unknown name never reaches the bridge. Lowering and
loading a descriptor the registry did hold fails with `ExecutableError`. See
[Troubleshooting](../troubleshooting.md).

## Supply your own module loader

`Options.load` replaces the default dynamic `import` of the file a module
descriptor points at. A bundled host, or a test that needs a module no file can
contain, supplies its own:

```ts
const options: Executable.Options = {
  delegates: [Agent, Shell],
  load: (path) => Effect.succeed({ default: modulesByPath[path] })
}
```

The loader receives a filesystem path, not a specifier.
`Executable.fileSpecifier(path)` is the conversion the default loader makes,
exported so a custom loader can make the same one without depending on
`node:url`. It escapes what `pathToFileURL` escapes, which matters because a
`#` or `?` in a directory name is both a legal filename character and URL
syntax: concatenating one unescaped truncates the specifier and imports the
wrong module, or none.

A module must default-export a tagged `@smthrs/flow` value or a schema/metadata record. Anything else is
`ExecutableError { code: "invalid_module" }`.
