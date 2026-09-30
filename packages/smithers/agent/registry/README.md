# @smthrs/registry

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://registry.smithers.sh

Answers the question "what flows does this project have" without running any of
them. It scans ordered directories into serializable flow descriptors, keeps
every prompt body behind a reference, and hands a host the lookups it needs to
list a catalog, show it to a model, and execute one entry by name.

A flow lives on disk as a directory holding one entry file: a markdown
`flow.mdx`, its Agent Skills spelling `SKILL.md`, or a TypeScript `flow.ts`.
Scanning one produces a `FlowDescriptor`, a plain value you can journal, send
over a wire, or compare against another. The scan reads and hashes each entry
file whole and parses at most its first 64 KiB to find the declaration, so it
imports nothing, and the body stays behind a path plus the SHA-256 digest
measured during the scan.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`effect` is a peer dependency at exactly `4.0.0-rc.115`. `@effect/platform-node`
supplies the `FileSystem` and `Path` implementations the scan walks with; this
package has no platform bindings of its own.

## List what a directory holds

The API is Effect services and layers: build a `Registry` layer over the sources
you want scanned, then run a program that asks that service for the catalog.

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { join } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

const registry = Registry.layer({
  sources: [{ source: "project", root: join(process.cwd(), "flows"), naming: "path" }]
}).pipe(Layer.provide([discovery, platform]))

const main = Effect.gen(function*() {
  const catalog = yield* Registry.Registry

  for (const flow of yield* catalog.list()) {
    console.log(`${flow.name}: ${flow.description}`)
  }

  for (const warning of yield* catalog.warnings()) {
    console.log(`skipped ${warning.path}: ${warning.message}`)
  }
})

await Effect.runPromise(main.pipe(Effect.provide(registry), Effect.orDie))
```

```text
review: Reviews a proposed change and reports concrete correctness and maintainability risks.
skipped /repo/flows/draft/flow.mdx: Markdown flows require a non-empty frontmatter description
```

`list()` and `warnings()` both answer from one complete snapshot and touch no
files. A malformed entry becomes a warning rather than a failure, because a
`flows/` directory is a directory a person edits and one file in it is routinely
mid-edit.

## Public API

The root entry point exports these namespaces; each is also importable from
`@smthrs/registry/<Module>`.

| Module          | What it owns                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| `Descriptor`    | The serializable descriptor, body, schema, source, provenance, budget, and warning models. |
| `Disclosure`    | Projects descriptors to compact entries or Agent Skills XML.                               |
| `Discovery`     | Metadata-only source scanning over `FileSystem` and `Path`.                                |
| `Executable`    | Turns a discovered descriptor into a registered, engine-runnable `@smthrs/flow` flow.      |
| `MarkdownFlow`  | Parses markdown metadata, loads prompt bodies lazily, and renders invocation prompts.      |
| `Pack`          | Reads pack manifests, addresses their contents, and merges packs by origin.                |
| `Registry`      | Ordered discovery, lookup, visibility, lazy body loading, refresh, and warnings.           |
| `RegistryError` | Typed discovery and registry failures and their constructors.                              |

`@smthrs/registry/package.json` is also exported; `internal/*` and nested
`*/index` subpaths are blocked.

## Running a discovered flow

Discovery answers _what flows exist_. `Executable` answers _how one runs_: it
loads the body a descriptor points at, resolves the flow the descriptor
delegates to, and returns a durable flow plus the layer that registers it.

```ts
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Executable, Registry } from "@smthrs/registry"
import { Layer } from "effect"

const registration = Executable.layer({ delegates: [Agent, Shell] }).pipe(
  Layer.provideMerge(Action.layerImplementations)
)

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

`Registry.layerProject({ root, packs })` scans `<root>/flows/**` first, then
every installed pack, under one refreshable first-found registry.
`Executable.layer` registers everything runnable, logs a warning naming each
refusal, and provides the whole `Catalog` as a service, so a host can print what
it declined instead of letting an operator find out from `smthrs flow start <flow>`.

It also provides `Executable.Refresh`. A flow written or edited after the host
started has a descriptor and no executable, and `refresh.flow(name)` rebuilds
that one entry in place — no restart, same `Catalog` service, and the previous
body stays registered until the new one is. `RefreshOptions.refreshable` holds
entries a host serves out of its own measured bundle `Fixed`.

Module discovery measures project helpers without evaluating them. Executable
admission supports relative static imports and package `imports` keys with one
static file target, including transitive imports and cycles. After a helper edit,
refresh discovers a new identity; an old descriptor is refused before import.

Measured project helpers reached through `import()` or `require()`, tsconfig
aliases, or conditional package mappings without one static target are refused
with `body_unavailable` before evaluating the entry. Their host loader cache
cannot guarantee the measured bytes, and deferred loads can outlive temporary
module cleanup. Use supported static imports for those helpers. Installed
packages without a project mapping and Node/Bun builtins retain host trust.

Every delegate receives the same serializable `Invocation` envelope: the flow's
name, the caller's input, the rendered prompt, the declared seat, the lowered
placement, the declared capabilities, and the declared collaborator flows. One
registered driver therefore runs many descriptors.

The bridge retains a delegate's `successSchema` and `errorSchema` through both
inline calls and dispatched, cached calls. Every `Flow.make` value already
provides these codecs; custom structural `Executable.Delegate` implementations
may supply the same optional fields. Omitting them preserves the historical
`Schema.Unknown` JSON-only behavior. Declared transformations and typed errors
therefore encode and replay using the delegate's contract.
The catalog erases static codec service requirements, extending the existing
`Delegate.call`/`execute` service erasure. The delegate's host owns these same
codecs and must supply their services
when registering and executing the catalog; erasure does not make codecs
service-free.

Retaining these codecs changes bridge step keys once, because result schemas
participate in graph and cache identity. Previously recorded bridge rows are
not reused under the corrected keys. A `Flow.make` delegate that declares no
`error` carries `Schema.Never`, and the bridge's error channel is `Never` too.

## Workflow packs

A pack is a directory with a `pack.json` manifest, the shareable unit a project
installs rather than copies. `Registry.layerFromPacks(packs, { runtimeVersion })`
scans a set of installed packs into one registry, folded together by origin, and
every descriptor a pack contributes carries `provenance.pack` with the pack
name, version, and origin, so a catalog entry says where it came from. The
manifest format, the path confinement rules, the content address, and the
compatibility grammar are documented in
[Load workflow packs](https://registry.smithers.sh/guides/load-packs/).

## Documentation

- [Installation](https://registry.smithers.sh/installation/) and
  [Quickstart](https://registry.smithers.sh/quickstart/).
- [Delegation](https://registry.smithers.sh/concepts/delegation/): the delegate
  a descriptor names, and what the runtime does with its declarations.
- [Run a discovered flow](https://registry.smithers.sh/guides/run-a-discovered-flow/):
  the whole composition, from registered delegates to a running host.
- [API reference](https://registry.smithers.sh/reference/api/): every export,
  field, and constructor.
- [Troubleshooting](https://registry.smithers.sh/troubleshooting/): every
  failure code this package raises, and what to change.

Markdown `model` accepts a seat name or a non-empty ordered list, for example
`model: [openai:gpt-6-sol, anthropic:claude-opus-5-5]`. The list's first entry is
primary and the rest are fallbacks. Discovery preserves the order in the
execution identity and invocation; invalid lists produce `invalid_model` and
are not registered.
