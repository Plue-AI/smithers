---
title: "API reference"
description: "Every public export of @smthrs/registry: the FlowDescriptor model, the Discovery and Registry services, markdown flow compatibility, disclosure projections, the executable bridge, workflow packs, and the typed failures."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/registry/docs/api.md"
---

`@smthrs/registry` exports eight modules from its root entry point, and each is
also importable from `@smthrs/registry/<Module>`:

```ts
import { Descriptor, Discovery, Registry } from "@smthrs/registry"
// or
import * as Registry from "@smthrs/registry/Registry"
```

`@smthrs/registry/internal/*` and `@smthrs/registry/*/index` are not public.
`@smthrs/registry/package.json` is exported.

Services and tags are Effect constructs: a `Layer` provides a service, and an
effect reads it from context. For the authoring model behind flows, actions,
and interpreters, see the [`@smthrs/flow` reference](https://flow.smithers.sh/reference/api/). For the
declaration values a discovered body carries, see the
[`@smthrs/core` reference](https://core.smithers.sh/reference/api/).

| Module                            | What it owns                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| [`Descriptor`](#descriptor)       | The serializable `FlowDescriptor` and every value it is built from.       |
| [`Discovery`](#discovery)         | The service that walks one source root and returns a `SourceScan`.        |
| [`MarkdownFlow`](#markdownflow)   | Markdown and Agent Skills compatibility.                                  |
| [`Registry`](#registry)           | The refreshable, first-found-wins catalog and its layers.                 |
| [`Disclosure`](#disclosure)       | The compact projections a model and an autocomplete list are shown.       |
| [`Executable`](#executable)       | Turning a descriptor into a runnable `@smthrs/flow` value.                |
| [`Pack`](#pack)                   | Manifests, content addresses, compatibility ranges, and merge precedence. |
| [`RegistryError`](#registryerror) | The typed failures and their constructors.                                |

## Example

```ts
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Registry } from "@smthrs/registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const registry = Registry.layerProject({ root: process.cwd() }).pipe(Layer.provide(NodeServices.layer))
const flows = Registry.Registry.use((catalog) => catalog.list())

console.log(await Effect.runPromise(flows.pipe(Effect.provide(registry), Effect.orDie)))
```

## Descriptor

The serializable values discovery produces. Every one of them is a schema, so a
descriptor round-trips through JSON, a journal, or a wire without losing a
field. [Descriptors](/concepts/descriptors/) explains the model.

### Descriptor.FlowDescriptor

```ts
class FlowDescriptor {
  readonly name: string
  readonly description: string
  readonly body: BodyRef
  readonly input: SchemaRef
  readonly output: SchemaRef
  readonly model: Option.Option<ModelSelection>
  readonly flows: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: EffectDeclaration
  readonly placement: Option.Option<Placement>
  readonly sandbox?: SandboxSelection
  readonly modelInvocable: boolean
  readonly budget?: FlowBudget
  readonly path: string
  readonly frontmatter: Record<string, Schema.Json>
  readonly provenance: Provenance
}
```

The discovered metadata for one flow, excluding its unloaded body content.
`frontmatter` retains every declared key verbatim, including keys discovery
does not use. `budget` is absent for a flow that declares none; read it through
`budgetOf` rather than from the field.

`sandbox` is absent for a flow that selects none. Markdown frontmatter selects
one with `sandbox: { provider, network?, cpus?, memoryMib?, timeoutSecs? }`:
`provider` is one of `SandboxProvider` (`aws`, `cloudflare`, `command`,
`container`, `daytona`, `directory`, `just-bash`, `kubernetes`, `microsandbox`,
`vercel`), `network` is `none`, `open`, or `{ allow: [hosts] }` of host names (absent,
the provider's default applies; `microsandbox` then gives no network), `cpus` is a positive
number, and the other limits are positive whole numbers. A selection places the
flow in `sandbox`. An unknown provider or key, a malformed option, or a
`placement` other than `sandbox` refuses the flow with `invalid_sandbox`.

### Descriptor.executionDigest

```ts
const executionDigest: (descriptor: FlowDescriptor) => string | undefined
```

Hashes the descriptor's complete measured source identity and discovered
metadata, including model, parameters, body location, and authority. Hosts
include this identity in the approved plan. It returns `undefined` when the
descriptor has no `body.contentDigest`: the descriptor may be displayed, but
`AgentSession` refuses to execute a prompt without a measured, approved identity.

The repository host also binds its own policy identity to reserved job
descriptors. In source mode it measures every TypeScript file in
`flows/repository`, including the semantic judge and its helpers, together with
the other host sources and prompt bodies. A change to those bytes changes the
job's execution digest; `Registry.loadBody` refuses a previously approved digest
with `execution_changed`. A compiled host uses its bundled artifact digest.

### Descriptor.declarationDigest

```ts
const declarationDigest: (descriptor: FlowDescriptor) => string
```

Hashes one flow's complete declaration. This is the single declaration identity
for `FlowDescriptor`: `@smthrs/chain` keys its catalog entries with it and
`@smthrs/harness` folds it into every call identity, so one declaration is one
number everywhere.

Every top-level field is material. Within `provenance` the only deliberate
exclusion is `pack`, which describes where discovery found the declaration
rather than what the call depends on. `capabilities` is sorted because a set is
what it means; every other array hashes in declaration order. Absent `Option`
and optional fields hash as `null`.

Unlike `executionDigest` this is always defined. It identifies what was
declared, not whether the source bytes were measured, so a descriptor with no
`body.contentDigest` still has a declaration identity to key against.

### Descriptor.SourceScan

```ts
class SourceScan {
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}
```

The result of scanning one source. `entries` is sorted by source path and
`warnings` by path, then code, then message, so two scans of one tree return
identical values.

### Descriptor.Source

```ts
interface Source {
  readonly source: string
  readonly root: string
  readonly naming: "path" | "frontmatter"
  readonly system?: boolean | undefined
  readonly optionalRoot?: boolean | undefined
  readonly confinementRoot?: string | undefined
}
```

One discovery source. `source` is opaque caller-supplied metadata copied onto
each descriptor's provenance. `naming` selects whether a flow's name comes from
its directory path below `root` or from the file's own `name` field.
`system: true` makes a name collision with this source a
`system_collision` failure instead of a first-found resolution.
`optionalRoot: true` returns an empty scan when `root` is absent, checked on
every scan. It does not suppress access failures or a non-directory root.
Sources are required by default; declared pack roots remain required.
`confinementRoot` bounds directories and selected entry files to that root
when the host can resolve the root's real path. `Pack.sources` sets it to the pack
root; ordinary project sources leave it unset.

### Descriptor.Provenance and Descriptor.PackRef

```ts
class Provenance {
  readonly source: string
  readonly root: string
  readonly pack?: PackRef
}

const PackRef: Schema.Struct<{
  name: Schema.NonEmptyString
  version: Schema.NonEmptyString
  origin: Schema.Literals<["local", "installed"]>
}>
```

Where a descriptor came from. `pack` is absent for a descriptor a plain source
produced and present only when a pack manifest named the directory the entry
was found in. `origin` is what decided a name collision between packs, so an
operator reading a descriptor can tell which half of the merge it survived.

### Descriptor.BodyRef, BodyRefMarkdown, BodyRefModule

```ts
class BodyRefMarkdown {
  readonly _tag: "Markdown"
  readonly path: string
  readonly baseDirectory: string
  readonly contentDigest?: string
}

class ModuleImport {
  readonly path: string
  readonly contentDigest?: string
}

class BodyRefModule {
  readonly _tag: "Module"
  readonly path: string
  readonly contentDigest?: string
  readonly imports?: ReadonlyArray<ModuleImport>
}

const BodyRef: Schema.Union<[typeof BodyRefMarkdown, typeof BodyRefModule]>
```

A serializable locator and content address for a body that is loaded only on
demand. `baseDirectory` is the directory a markdown flow's own resource paths
resolve against. `contentDigest` is the SHA-256 of the complete source bytes
measured during discovery, as 64 lowercase hexadecimal characters. Every
constructor supplies it. The field is optional only so a descriptor journaled
by an older version, before the digest existed, still decodes. `Registry.loadBody`
verifies source bytes before returning a prompt or module locator, and
`Executable.fromDescriptor` verifies source before loading it. A missing digest
or mismatch is `body_unavailable`; refresh the registry before loading it.

`contentDigest` measures the ENTRY FILE. `imports` measures what that entry
loads from beside itself: every module reached through a relative specifier
(`import`, `export … from`, `import()`, `require()` or `import.meta.require()`),
transitively, as a path relative to the entry's directory plus the digest of
its bytes. The loader imports the verified entry bytes as a sibling of the
original so those specifiers resolve to the live files, which makes them code
the flow runs, so they ride `Descriptor.executionDigest` and are re-measured
before anything is imported. The field is ABSENT, not empty, when the entry
loads nothing beside itself, so such a module hashes exactly as it did before
the field existed. A bare specifier that a loader maps onto project files is
measured too: a package.json `imports` entry (`#impl`), and a tsconfig or
jsconfig `paths` alias or `baseUrl` in any directory above the entry, followed
through `extends`. The files they name are pinned like relative imports. Other
bare specifiers resolve into installed packages and are not measured. A
`ModuleImport` with no `contentDigest` is a specifier discovery could not pin:
one that resolves to no file, a module it could not read, an `import()` or
`require()` whose target is computed, any `createRequire` or `module` import,
`require` used as a value rather than called, an absolute or `file:`
specifier, a `#` specifier with no relative `imports` target, a self-import of
the flow's own package through `exports`, or a closure past its bound. Its `path` then carries that reason instead of a
location, and `Executable.fromDescriptor` refuses to run such a module.

The pin covers the loads a static scan of the source can read. It is not a
sandbox: a module that hides a load from the scan, for example behind
`eval`, `new Function`, or a member access whose name is computed at run time,
loads a file the pin does not measure. That hiding code is itself in the
digested source the approver reviews.

### Descriptor.FlowBody, FlowBodyPrompt, FlowBodyModule

```ts
class FlowBodyPrompt {
  readonly _tag: "Prompt"
  readonly text: string
  readonly baseDirectory: string
}

class FlowBodyModule {
  readonly _tag: "Module"
  readonly path: string
}

const FlowBody: Schema.Union<[typeof FlowBodyPrompt, typeof FlowBodyModule]>
```

What `Registry.loadBody` returns. A markdown body arrives as its text with the
frontmatter removed; a module body arrives as the path to import.

### Descriptor.SchemaRef and its five variants

```ts
class SchemaRefMarkdownArgs {
  readonly _tag: "MarkdownArgs"
}
class SchemaRefMarkdownOutput {
  readonly _tag: "MarkdownOutput"
}
class SchemaRefModule {
  readonly _tag: "Module"
  readonly path: string
  readonly field: "input" | "output"
}
class SchemaRefNone {
  readonly _tag: "None"
}
class SchemaRefInline {
  readonly _tag: "Inline"
  readonly document: Schema.Json
}

const SchemaRef: Schema.Union<[
  typeof SchemaRefMarkdownArgs,
  typeof SchemaRefMarkdownOutput,
  typeof SchemaRefModule,
  typeof SchemaRefNone,
  typeof SchemaRefInline
]>
```

A serializable locator for a flow's input or output schema.

`MarkdownArgs` and `MarkdownOutput` are the fixed markers every markdown flow
carries: its input is `{ args: string }` and its output is a string. `Module`
records the field location on a module's default `Flow.make` value, so
discovery can name a schema without evaluating the module that defines it.
`None` is a flow that declared neither.

`Inline` is the one variant that carries a schema by value, as a
`Schema.toJsonSchemaDocument` output kept as plain JSON. The other four are
locators; a host that binds a declaration it already holds has the schema
itself and nothing to locate, and a locator pointing at a synthetic path would
be unreadable downstream. Use `Inline` when the binding already has the schema in memory.

`Descriptor.inputDocument(ref)` returns an inline document unchanged or the
JSON Schema document for markdown's required `{ args: string }` input. It
returns `undefined` for an absent reference, `None`, `MarkdownOutput`, or a
`Module` locator. Reading this metadata never evaluates a repository module.

### Descriptor.EffectDeclaration, EffectTier, Placement

```ts
const EffectTier: Schema.Literals<["sealed", "compensable", "irreversible"]>
const Placement: Schema.Literals<["client", "local", "sandbox", "remote"]>

const EffectDeclaration: Schema.Struct<{
  reads: Schema.Array<Schema.String>
  writes: Schema.Array<Schema.String>
  mode: Schema.Literals<["hermetic", "expected"]>
  onConflict: Schema.Literals<["serialize", "lane", "fail"]>
  tier: typeof EffectTier
}>
```

The canonical effect declaration shared with [`@smthrs/core`](https://core.smithers.sh/reference/api/).
`mode: "hermetic"` claims the two path sets are complete, which is what a hard
boundary enforces; `expected` records a deviation rather than refusing the
result. `tier` is the reversibility claim, and it is what decides whether a
result may be reused. See [Declared authority](/concepts/authority/).

`Placement` is the serializable literal a descriptor records.
`Executable` projects it into the `@smthrs/core` tagged value at load time.

### Descriptor.FlowBudget, BudgetCeiling, budgetUnbounded, budgetOf

```ts
const BudgetCeiling: Schema.Int // > 0 and <= Number.MAX_SAFE_INTEGER

const UsdCeiling: Schema.Finite // > 0

const FlowBudget: Schema.Struct<{
  tokens: Schema.optional<typeof BudgetCeiling>
  milliseconds: Schema.optional<typeof BudgetCeiling>
  usd: Schema.optional<typeof UsdCeiling>
  onExceeded: Schema.optional<typeof BudgetOnExceeded>
  deadline: Schema.optional<typeof BudgetCeiling>
}>

const budgetUnbounded: FlowBudget
const budgetOf: (descriptor: FlowDescriptor) => FlowBudget
const deadlineMillis: (value: unknown) => number | undefined
```

The tokens, milliseconds and dollars a flow declares that a control plane
should approve for one of its runs. Tokens and milliseconds are positive safe
integers, so the schema refuses zero, a negative, a fraction, `NaN`, and
anything past `Number.MAX_SAFE_INTEGER`; `usd` is a positive finite amount, so
`0.5` is fifty cents. `deadline` is the milliseconds of wall-clock time one run
may take from its first start, read from the frontmatter's top-level `deadline`.
Every field survives durable JSON unchanged.

`budgetUnbounded` is the budget of a flow that declares no ceiling. It is
a named frozen value rather than a `{}` written at each host, for the same
reason `@smthrs/agent`'s `Budget.layerUnbounded` is a named layer: giving up
spending enforcement is a decision a reader has to be able to see.

`budgetOf` is how a host reads the field. It answers an absent `budget` with
`budgetUnbounded` and returns a frozen copy otherwise, so one host cannot
rewrite the ceiling every other undeclared descriptor reports.

`deadlineMillis` reads a deadline the way frontmatter and `smthrs flow start
--deadline` write one: a duration such as `30 minutes`, or whole milliseconds as
a number or numeric string. Anything that is not a positive safe integer of
milliseconds answers `undefined`.

### Descriptor.DiscoveryWarning and DiscoveryWarningCode

```ts
class DiscoveryWarning {
  readonly code: DiscoveryWarningCode
  readonly path: string
  readonly name?: string
  readonly message: string
  readonly cause?: unknown
}
```

A non-fatal source-discovery diagnostic. Anything a scan can survive is
reported this way rather than raised, and read back through
`registry.warnings()`. The 35 codes are grouped by what they say:

| Group                  | Codes                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naming and description | `missing_description`, `invalid_description`, `missing_name`, `invalid_name`, `directory_name_mismatch`, `name_field_ignored`, `duplicate_name`, `root_level_entry`                                                                                                                                                              |
| Declaration fields     | `unknown_frontmatter_key`, `invalid_allowed_tools`, `invalid_capabilities`, `invalid_budget`, `invalid_deadline`, `invalid_model`, `invalid_model_invocation`, `invalid_placement`, `invalid_sandbox`, `invalid_compatibility`, `invalid_license`, `invalid_metadata`, `unsupported_input_schema`, `unsupported_module_metadata` |
| Authority              | `unprojectable_authority`, `invalid_effect_declaration`, `invalid_effect_tier`                                                                                                                                                                                                                                                   |
| Source shape           | `multiple_entry_files`, `frontmatter_parse_error`, `non_serializable_frontmatter`, `symlink_cycle`, `outside_root`, `max_depth_exceeded`, `entry_too_large`, `unreadable`                                                                                                                                                        |
| Packs                  | `unknown_pack_key`, `shadowed`                                                                                                                                                                                                                                                                                                   |

`service` names a service missing during construction of a module's exported `layer`.
The optional export is built once in a scoped host context; see
[Module action implementations](/guides/run-a-discovered-flow/#module-action-implementations).

Each code, with its cause and its fix, is in
[Diagnose a flow that did not appear](/guides/diagnose-a-missing-flow/).

## Discovery

Portable, metadata-only discovery of markdown and module-backed flows.

### Discovery.Discovery

```ts
interface Discovery {
  readonly scan: (source: Descriptor.Source) => Effect.Effect<SourceScan, DiscoveryError>
}

const Discovery: Context.Service<Discovery, Discovery>
```

`scan` walks one source root and returns every descriptor it produced with
every diagnostic it collected. It never loads a body into the result and never
evaluates a module. A scan either produces a complete `SourceScan` or fails;
there is no partial scan.

Discovery follows symbolic links wherever the host `FileSystem.stat` does. A
visited-directory identity set, keyed on device and inode, stops cycles and
aliases with a `symlink_cycle` warning, and a depth ceiling bounds hosts that
cannot supply stable directory identities. When `confinementRoot` is set,
discovery checks the source root, every descended directory, and every selected
entry file before reading it. A real path outside the confinement root, or one
that cannot be resolved once the root resolves, produces `outside_root` and is
skipped. Hosts that cannot resolve the confinement root retain lexical manifest
validation.

### Discovery.make

```ts
const make: (fs: FileSystem.FileSystem, path: Path.Path) => Discovery
```

Creates the service from portable file-system and path services. A test with an
in-memory filesystem needs no platform bindings.

### Discovery.layer

```ts
const layer: Layer.Layer<Discovery, never, FileSystem.FileSystem | Path.Path>
```

Provides discovery from the current file-system and path services.

### Discovery.makeNoop, Discovery.layerNoop

```ts
const makeNoop: (overrides?: Partial<Discovery>) => Discovery
const layerNoop: (overrides?: Partial<Discovery>) => Layer.Layer<Discovery>
```

An explicit absence: `scan` answers an empty `SourceScan`. `overrides` replaces
the members a caller cares about and leaves the rest as the absence.

### Discovery.entrySizeLimit, Discovery.maximumTraversalDepth

```ts
const entrySizeLimit: number // 4 * 1024 * 1024
const maximumTraversalDepth: number // 32
```

The two resource ceilings a scan enforces. `entrySizeLimit` is the largest
entry file discovery admits; a larger one is skipped with `entry_too_large` and
contributes no descriptor, so a stray build artifact under a source root cannot
exhaust the process at layer construction.

The size ceiling is checked twice, because the first check trusts the host. A
`stat` size past the limit skips the file unread, which is the fast path an
ordinary file system takes; the bytes actually read are then measured against
the same limit, so a host whose `stat` under-reports or omits a size still gets
`entry_too_large` with the true byte count, and the entry is refused before it
is hashed, decoded, or parsed.

`maximumTraversalDepth` bounds how many entry-name segments a walk descends.
The entry-name path is the flow name, so a deeper tree is a loop or a mistake,
and it is reported as `max_depth_exceeded`.

A third ceiling has no export: at most 64 KiB of an admitted file is decoded
and parsed looking for metadata. It bounds parsing only.

## MarkdownFlow

Discovery and prompt rendering for markdown-backed flows, including the Agent
Skills `SKILL.md` form.

### MarkdownFlow.Input, MarkdownFlow.Output

```ts
const Input: Schema.Struct<{ args: Schema.String }>
const Output: typeof Schema.String
```

The fixed input and output of every markdown flow. A markdown flow takes one
string and produces one string, which is why `Descriptor.SchemaRefMarkdownArgs`
and `SchemaRefMarkdownOutput` are markers rather than locators.

### MarkdownFlow.fromMarkdown

```ts
interface FromMarkdownOptions {
  readonly text: string
  readonly contentDigest?: string | undefined
  readonly path: string
  readonly baseDirectory: string
  readonly naming: "path" | "frontmatter"
  readonly name: Option.Option<string>
  readonly dirBasename: string
  readonly provenance: Provenance
}

interface FromMarkdownResult {
  readonly descriptor: Option.Option<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}

const fromMarkdown: (options: FromMarkdownOptions) => FromMarkdownResult
```

Derives a markdown flow descriptor from already-read text, without retaining
the prompt body. `Discovery` calls it with a metadata prefix and the digest of
the whole file; a caller passing complete text may omit `contentDigest`, and
the digest of `text` is used.

`descriptor` is `Option.none()` when `description` is missing or empty, when
`capabilities` is neither a string array nor a space-separated string (such as
a mapping or an array containing mappings), or when `model` is an invalid list
(such as `model: []`). These refusals report `missing_description`,
`invalid_capabilities`, or `invalid_model`, respectively. An omitted
`capabilities` key projects wildcard authority; a space-separated string is
accepted with an `invalid_capabilities` warning. Other malformed fields may
produce a descriptor with a conservative value. Report `warnings` whether or
not a descriptor was produced.

### MarkdownFlow.loadBody

```ts
const loadBody: (text: string, baseDirectory: string) => FlowBodyPrompt
```

Removes leading frontmatter and returns a `FlowBodyPrompt`. It removes nothing
else: a body's own markdown, including any later `---` rule, is preserved.

### MarkdownFlow.renderPrompt

```ts
const renderPrompt: (
  body: FlowBodyPrompt,
  input: { readonly args: string }
) => string
```

Renders a loaded markdown body for a model, using the compatible skill
convention: the body, then a fixed block naming where the flow's own files
live, then the caller's arguments when there are any.

```text
<the body text>

Supporting skill resources are available relative to this skill directory but are not loaded into context unless needed:
<skill_resources>
- Base directory: /absolute/path/to/the/skill
- Resolve relative resource paths from this directory and read only the files you need.
</skill_resources>

<args, when the caller supplied any>
```

The base directory is the absolute host path the descriptor was discovered
under, so a host that must not disclose its filesystem layout to a model should
render the body itself rather than through this helper.

### MarkdownFlow.toCoreFrontmatter

```ts
const toCoreFrontmatter: (descriptor: FlowDescriptor) => CoreMarkdown.MarkdownFrontmatter
```

Projects a descriptor into the one authoring value
[`@smthrs/core`](https://core.smithers.sh/reference/api/)'s `Markdown` module accepts. This is the deliberate
registry-to-core adapter boundary: metadata crosses it once and is not
independently reinterpreted downstream. `Executable` uses it to lower a loaded
markdown body into its annotations.

## Registry

The refreshable, first-found-wins catalog a host consumes.

### Registry.Registry

```ts
interface Registry {
  readonly list: () => Effect.Effect<ReadonlyArray<FlowDescriptor>>
  readonly visible: () => Effect.Effect<ReadonlyArray<FlowDescriptor>>
  readonly get: (name: string) => Effect.Effect<FlowDescriptor, RegistryError>
  readonly getOption: (name: string) => Effect.Effect<Option.Option<FlowDescriptor>>
  readonly loadBody: (
    name: string,
    expectedExecutionDigest?: string
  ) => Effect.Effect<FlowBody, RegistryError | DiscoveryError>
  readonly runPrompt: (
    name: string,
    input: MarkdownFlow.Input
  ) => Effect.Effect<MarkdownFlow.Output, RegistryError | DiscoveryError>
  readonly refresh: () => Effect.Effect<void, RegistryError | DiscoveryError>
  readonly warnings: () => Effect.Effect<ReadonlyArray<DiscoveryWarning>>
}

const Registry: Context.Service<Registry, Registry>
```

| Member      | What it answers                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`      | Every descriptor, in deterministic first-found order.                                                                                                                                |
| `visible`   | The descriptors whose `modelInvocable` is true.                                                                                                                                      |
| `get`       | One descriptor, or `RegistryError { code: "not_found" }`.                                                                                                                            |
| `getOption` | One descriptor as an `Option`. It cannot fail.                                                                                                                                       |
| `loadBody`  | Returns the body locator or prompt, optionally checking the approved execution identity first. Source bytes are checked against the discovery digest; unmeasured bodies are refused. |
| `runPrompt` | A markdown body rendered as a prompt. A module flow is `not_prompt_flow`.                                                                                                            |
| `refresh`   | Rescans every configured source and replaces the snapshot.                                                                                                                           |
| `warnings`  | Every discovery and collision diagnostic.                                                                                                                                            |

Reads are atomic per operation: each observes one complete snapshot. A
successful `refresh` between calls can replace or remove a listed descriptor,
so a later `get` may return a different descriptor or fail with `not_found`.
Retain returned descriptors when you need the values from that read; they do
not pin later registry calls or filesystem contents. Cross-call consistency
would require adding an explicit snapshot handle to the API; none is currently
exposed.

`refresh` replaces the snapshot only after every source succeeds. A failed
rescan leaves the previous complete snapshot serving reads.

`loadBody` and `runPrompt` are the only two members that touch the filesystem.

Pass the plan's `executionDigest` to `loadBody` when loading an approved flow.
A descriptor that no longer matches it fails with `execution_changed`, before
body loading. A markdown file changed after discovery fails with
`body_unavailable`. Refreshing the registry does not authorize the new work;
create and approve a new plan.

### Registry.Config and Registry.PackConfig

```ts
interface Config {
  readonly sources: ReadonlyArray<Descriptor.Source>
  readonly packs?: PackConfig | undefined
}

interface PackConfig {
  readonly installed: ReadonlyArray<Pack.Installed>
  readonly runtimeVersion: string
}
```

Sources are scanned in caller order, and the canonical order is system,
project, plugin, then foreign. Packs are scanned after every source and folded
in under the same first-found rule, so a source entry shadows a pack entry of
the same name. Precedence among packs is the pack's `origin`, not caller order.

`runtimeVersion` is required rather than optional because it is the only thing
a pack's `requires.smithers` can be checked against. An optional field would
silently skip the check for every caller that forgot it.

### Registry.make, Registry.layer

```ts
const make: (config: Config) => Effect.Effect<
  Registry,
  RegistryError | DiscoveryError,
  Discovery | FileSystem.FileSystem | Path.Path
>

const layer: (config: Config) => Layer.Layer<
  Registry,
  RegistryError | DiscoveryError,
  Discovery | FileSystem.FileSystem | Path.Path
>
```

Scans the ordered sources and constructs the registry. Both copy the
configuration they were given, so mutating the `sources` or `packs.installed`
array afterwards changes nothing.

A name claimed twice by ordinary sources resolves first-found with a
`duplicate_name` warning. A name shared with a source declared `system: true`
fails `RegistryError { code: "system_collision" }` in either direction.

### Registry.ProjectOptions and Registry.layerProject

```ts
interface ProjectOptions {
  readonly root: string
  readonly packs?: Registry.PackConfig | undefined
}

const layerProject: (options: ProjectOptions) => Layer.Layer<
  Registry.Registry,
  RegistryError | DiscoveryError,
  FileSystem.FileSystem | Path.Path
>
```

The registry a Node host discovers a project in: `<root>/flows/**` first, then
every installed pack, all under one first-found registry, so a project flow
shadows a pack flow of the same name and `refresh` rescans both.

Packs are scanned through the registry's own pack path, so each pack descriptor
carries its `provenance.pack`, a name two packs both define is reported as
`shadowed`, and every pack's `requires.smithers` is checked against
`PackConfig.runtimeVersion`. The runtime version rides inside `PackConfig`
rather than beside it, so a caller cannot ask for packs without saying what
their range is checked against.

A project with no `flows/` directory has no project entries. The source stays
configured with `optionalRoot: true`, so every `refresh()` checks it again.
Creating the first `flows/<id>/flow.mdx` or `flow.ts` makes it discoverable on
refresh in the same session. Removing `flows/` empties the project entries on
refresh; recreating it makes them discoverable again. Pack entries remain,
and a missing declared pack directory fails with `invalid_pack`.

### Registry.layerFromDescriptors

```ts
const layerFromDescriptors: (
  entries: ReadonlyArray<FlowDescriptor>,
  warnings?: ReadonlyArray<DiscoveryWarning>
) => Layer.Layer<Registry, never, FileSystem.FileSystem | Path.Path>
```

Provides an in-memory descriptor snapshot while retaining lazy body loading.
Its `refresh` is a no-op, because it has no discovery sources. It still
requires `FileSystem` and `Path`, because `loadBody` still reads and
digest-checks a real file.

Duplicate names among `entries` resolve first-found with a `duplicate_name`
warning appended to the warnings supplied.

### Registry.layerFromPacks

```ts
const layerFromPacks: (
  packs: ReadonlyArray<Pack.Installed>,
  options: { readonly runtimeVersion: string }
) => Layer.Layer<
  Registry,
  RegistryError | DiscoveryError,
  Discovery | FileSystem.FileSystem | Path.Path
>
```

Scans a set of installed packs into one registry. This is `layer` with no
sources of its own, so `refresh` rescans every pack the same way it rescans a
source.

Every pack's `requires.smithers` is checked before anything is scanned, so an
incompatible pack fails at load rather than at the first call into one of its
flows. Precedence is the pack's `origin`, and a shadowed definition is reported
as a `shadowed` warning naming both packs. See
[Load workflow packs](/guides/load-packs/).

A pack's manifest warnings travel with it: spread `Pack.read`'s result into an
`Installed` and add `origin`, and `registry.warnings()` reports them beside the
pack's scan warnings.

### Registry.makeNoop, Registry.layerNoop

```ts
const makeNoop: (overrides?: Partial<Registry>) => Registry
const layerNoop: (overrides?: Partial<Registry>) => Layer.Layer<Registry>
```

An explicit absence: `list`, `visible`, and `warnings` answer empty, `getOption`
answers `None`, `get`, `loadBody`, and `runPrompt` fail `not_found`, and
`refresh` succeeds. `overrides` replaces the members a caller cares about.

`layerNoop` requires nothing, so it composes into a test with no filesystem.

## Disclosure

The compact projections a client renders. Neither reads a path, a base
directory, a provenance, a frontmatter record, or a capability list. See
[Show a catalog to a model](/guides/show-flows-to-a-model/).

### Disclosure.toEntries

```ts
const toEntries: (
  entries: ReadonlyArray<FlowDescriptor>
) => ReadonlyArray<{ readonly name: string; readonly description: string }>
```

Projects descriptors into slash-autocomplete entries, sorted by name. It does
not filter: a flow that opted out of model invocation is still one an operator
may run.

### Disclosure.toXml

```ts
const toXml: (entries: ReadonlyArray<FlowDescriptor>) => string
```

Renders the model-invocable descriptors as an agentskills-style
`<available_skills>` block, sorted by name. An empty catalog renders the empty
block rather than the empty string.

`toXml` filters by `modelInvocable` itself, so passing `list()` and passing
`visible()` produce the same XML.

Text is repaired before it is escaped. Every code point XML 1.0 forbids, every
lone surrogate, and every Unicode noncharacter (U+FDD0 through U+FDEF, and
U+FFFE and U+FFFF in every plane) is replaced with U+FFFD; then `&`, `<`, `>`,
`"`, and `'` are escaped. Tab, line feed, carriage return, combining marks, and
astral characters survive unchanged, so one malformed description degrades that
description rather than invalidating the catalog.

## Executable

Turning a discovered descriptor into something the durable engine runs.
[Delegation](/concepts/delegation/) explains the model.

### Executable.Executable

```ts
interface Executable {
  readonly descriptor: Descriptor.FlowDescriptor
  readonly delegate: string | undefined
  readonly lowered: Lowered
  readonly invocation: (input: Schema.Json) => Invocation
  readonly flow: RuntimeFlow.Flow<string, typeof Payload, typeof Schema.Unknown, typeof Schema.Unknown, any>
  readonly layer: Layer.Layer<never, never, Registration>
}
```

One discovered flow, made runnable. `flow` is tagged with the descriptor's
registry name and `layer` registers it with the runtime.

`delegate` is the registered flow this descriptor hands its work to, and
`undefined` when the module IS the flow: a `flows/<name>/flow.ts` that
`export default`s a `@smthrs/flow` flow runs its own body, so its body is the
plan rather than one delegating node. The distinction is an authority one. A
delegate is host-registered code the descriptor never measured, so an approved
plan's envelope has to name it; a module that is its own flow is measured
instead, by `Descriptor.executionDigest` over its entry bytes and every module
that entry imports from beside itself.

### Executable.Options

```ts
interface Options {
  readonly delegates: ReadonlyArray<Delegate>
  readonly agent?: string | undefined
  readonly loadTimeoutMs?: number | undefined
  readonly load?:
    | ((path: string, source: {
      readonly bytes: Uint8Array
      readonly contentDigest: string
    }) => Effect.Effect<unknown, unknown>)
    | undefined
}
```

`delegates` is the set of registered runtime flows a descriptor may delegate
to. `agent` renames the fallback delegate for a host that calls its driver
something other than `agent`.

`load` receives the resolved filesystem path (or the original `file:` URL),
the verified entry bytes, their SHA-256 `contentDigest`, and `modules`: the
verified bytes of the entry and of every module it reaches through static
relative imports, keyed by absolute path, with the static specifiers that name
another module of that closure. Custom loaders must evaluate those bytes and
key any evaluation cache by both source path and digest. Reopening the
original paths or caching only by path violates the integrity and refresh
contract. Existing one-argument loaders remain assignable but must adopt this
contract to support edited modules safely.

The default loader writes each module of the closure to an exclusively
created, owner-readable sibling of its original whose unique name includes the
entry digest, and rewrites each linked static specifier to name its target's
sibling. Each load evaluates the measured bytes of the whole closure under
fresh module identities, so an edited helper is adopted after a refresh and
import cycles stay cycles. Relative imports and package resolution retain each
module's directory; `import.meta.url` names the temporary sibling. Source
directories must be writable. Temporary files are removed when loading settles
or is interrupted. `import()` and `require()` calls, and bare specifiers other
than a package.json `imports` key naming one file, load through the host's
normal module cache.

`loadTimeoutMs` bounds each `catalog` entry, including custom loaders, and
defaults to 30,000 milliseconds. Supply a positive finite number. Expiry becomes
`ExecutableError { code: "body_unavailable" }` naming the flow, source path,
and deadline. The catalog logs the refusal immediately and proceeds to the
next entry. Direct `fromDescriptor` and `fromRegistry` calls have no deadline.
Native imports cannot be cancelled: the deadline stops waiting and cleans up
temporary files, but cannot stop initialization resources or synchronous code
that blocks the event loop. Hosts needing termination must supply an isolated,
interruptible loader.

### Executable.Delegate

```ts
interface Delegate {
  readonly _tag: string
  readonly call: (payload: any) => PlanNode.Node<any, any, any>
  readonly execute: (
    payload: any,
    options?: { readonly executionId?: string | undefined }
  ) => Effect.Effect<any, any, any>
}
```

A registered `@smthrs/flow` flow a descriptor may delegate to. The contract is
structural on purpose: a `Flow.make` value satisfies it, and so does a test
double. Both ways of reaching the flow are required because the descriptor
decides which one is used. A declared cache policy makes the delegation one
dispatched step with a child execution beneath it; no policy leaves it a call
in the caller's plan.

### Executable.Payload and Executable.Invocation

```ts
const Payload: Schema.Struct<{ input: Schema.optionalKey<Schema.Json> }>

const Invocation: Schema.Struct<{
  flow: Schema.String
  input: Schema.Json
  prompt: Schema.String
  model: Schema.NullOr<Schema.String>
  placement: Schema.NullOr<Schema.Literals<["client", "local", "sandbox", "remote"]>>
  placementOptions: Schema.NullOr<
    Schema.Struct<{
      image: Schema.optional<Schema.String>
      profile: Schema.optional<Schema.String>
      target: Schema.optional<Schema.String>
    }>
  >
  capabilities: Schema.Array<Schema.String>
  flows: Schema.Array<Schema.String>
}>
```

`Payload` is what a bridged flow is executed with: one JSON field, because the
caller is a CLI launch or a control-plane launch and neither knows the
descriptor's schema at the call site.

`Invocation` is what the delegate receives. It is a fixed serializable envelope
rather than the descriptor's own input schema, because a host registers one
delegate for many descriptors. It carries the two decisions a driver cannot
re-derive: `placement`, which selects the host a cell is spawned on, and
`model`, which selects the seat. `ModelSelection` accepts one string or a non-empty ordered list: the first seat is primary and the rest are fallbacks. The order is included in execution identity.

`placementOptions` decodes an absent key to `null`, so a journal row written
before the field existed still decodes on replay. The default applies to
decoding only: encoding still writes the key, so the step key an envelope
carrying a placement hashes to does not move.

The envelope, its arrays, and its JSON input are frozen, and the same values
are captured as the delegating node's durable identity.

### Executable.Lowered and Executable.lower

```ts
interface Lowered {
  readonly cache: CacheEnvironment.CachePolicy | undefined
  readonly priority: number | undefined
  readonly placement: CorePlacement.Placement | undefined
}

const lower: (
  descriptor: Descriptor.FlowDescriptor,
  annotations: Context.Context<never>
) => Lowered
```

The runtime decisions read off a loaded body and its descriptor. The body's
annotation bag wins over the descriptor's frontmatter, because the body is the
later and more specific statement, and frontmatter can express neither
`Flow.within(...)` nor a cache policy.

`cache` is read from `CacheEnvironment.CachePolicyAnnotation`. Declaring one
changes the shape of the plan and is gated on the descriptor's tier; see
[Reuse a discovered flow's result](/guides/reuse-a-flow-result/).
`priority` reaches `NodeDraft.priority` for
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `PlanScheduler`, which orders
scheduled plans and nothing on the `Interpreter` path.

### Executable.delegateOf

```ts
const delegateOf: (
  descriptor: Descriptor.FlowDescriptor,
  options?: { readonly agent?: string | undefined }
) => Effect.Effect<string, ExecutableError>
```

The registry name of the flow a descriptor delegates to. One named flow is the
delegate. No named flow delegates to the agent, and so does one that names
several while declaring a model, because a skill listing its tools is naming
what the model may call rather than what runs it. Several named flows and no
model is `ambiguous_delegate`.

### Executable.defaultAgent

```ts
const defaultAgent: string // "agent"
```

The delegate a descriptor runs on when it names no single flow of its own. A
markdown skill and a bodiless `Flow.make({ model })` both say a model does the
work; neither names the code that drives one.

### Executable.fromDescriptor, Executable.fromRegistry

```ts
const fromDescriptor: (
  descriptor: Descriptor.FlowDescriptor,
  options: Options
) => Effect.Effect<Executable, ExecutableError, FileSystem.FileSystem | Path.Path>

const fromRegistry: (
  name: string,
  options: Options
) => Effect.Effect<
  Executable,
  ExecutableError | RegistryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
>
```

Makes one descriptor runnable. Everything that can be refused is refused here,
before the flow exists: a missing delegate, an undecidable one, an unreadable
or changed body, a module that exports something else. A flow either function
returns is one the engine can drive.

The delegate is resolved before the body is loaded. Both refusals are real, but
only one of them is about this host, and an operator reading "could not load"
would go looking in the wrong place.

### Executable.Catalog and Executable.catalog

```ts
interface Catalog {
  readonly executables: ReadonlyArray<Executable>
  readonly refused: ReadonlyArray<ExecutableError>
}

const Catalog: Context.Service<Catalog, Catalog>

const catalog: (options: Options) => Effect.Effect<
  Catalog,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
>
```

Every discovered flow this host can run, and the ones it declined. A project's
flows directory is a mixed set: some entries delegate to a flow this host
registered, others name a delegate only another host has, and one may simply be
broken. None of those is a reason to withhold the rest, so every refusal is
reported in `refused` carrying its code rather than raised. Each refusal is
logged before loading the next entry. Each entry has the `loadTimeoutMs` deadline.

The service tag is provided by `layer`, so a command that lists or diagnoses
flows reads the same refusals the registration phase acted on instead of
rebuilding the catalog and hoping the two agree.

### Executable.layer

```ts
const layer: (options: RefreshOptions) => Layer.Layer<
  Catalog | Refresh,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
>
```

Registers every runnable discovered flow with the runtime, and provides the
[`Refresh`](#executablerefresh-executablerefreshed-and-executablerefreshoptions)
that rebuilds one of them later. This is the layer a host passes as the durable
runtime's registration phase.

A refusal is never silent: each one is logged as a warning naming the flow, the
code, the delegate it wanted, and what is registered instead, and the whole
`Catalog` is provided as a service.

The `Catalog` service object never changes identity. A reader that took it
while the host was composed keeps reading it after a rebuild, because a
rebuild swaps the snapshot behind the service rather than the service.

### Executable.Refresh, Executable.Refreshed and Executable.RefreshOptions

```ts
interface Refresh {
  readonly flow: (name: string) => Effect.Effect<Refreshed, RegistryError | DiscoveryError>
}

const Refresh: Context.Service<Refresh, Refresh>

type Refreshed =
  | { readonly _tag: "Registered"; readonly executable: Executable }
  | { readonly _tag: "Refused"; readonly error: ExecutableError }
  | { readonly _tag: "Removed" }
  | { readonly _tag: "Fixed" }

interface RefreshOptions extends Options {
  readonly refreshable?: ((descriptor: Descriptor.FlowDescriptor) => boolean) | undefined
}
```

Rebuilds one entry of a catalog the host is already serving from: rescan
discovery, load that flow's body from the bytes now on disk, register it with
the runtime, and swap it into the snapshot. No restart, and the previous body
stays registered until the new one is, so an execution dispatched across the
swap reaches one of them and never an unregistered tag. Refreshes are
serialized, so two rebuilds of one name cannot interleave.

`Refreshed` has four cases because a caller that cannot tell them apart cannot
say anything honest about the flow afterwards: `Registered` (runnable now),
`Refused` (this host will not run it, with the code and the delegate it
wanted), `Removed` (discovery no longer finds it), and `Fixed` (this host
holds that entry and left the catalog alone).

`refreshable` is what answers `Fixed`. A host serving part of its catalog out
of its own measured bundle answers `false` for those entries: their bytes are
the image it was shipped as, and rebuilding one from the working tree would
replace an admitted declaration with whatever is on disk. Every flow is
refreshable by default.

The default loader writes the verified bytes to a private sibling of the
source file, named by their content digest, and imports that, so new bytes
are a new module specifier and the ESM cache cannot answer with the previous
body. The sibling is created exclusively, so a name another writer already
holds costs the load one attempt and is never written through.

### Executable.layerRefreshable

```ts
const layerRefreshable: (built: Catalog, options: RefreshOptions) => Layer.Layer<
  Catalog | Refresh,
  never,
  Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
>
```

Serves a catalog the host already built, and keeps one entry rebuildable.
`layer` is this plus the initial registrations, and is what a host with no
catalog of its own wants. Reach for this one when the host assembles the
catalog itself (several sources, or a loader per source) and registers the
result its own way: it adds the live `Catalog` and the `Refresh` beside it
without registering anything twice.

### Executable.Registration

```ts
type Registration = FlowRuntime | Action.Implementations | Crypto.Crypto
```

What a registration layer still needs from its host: the flow runtime it
registers with, the action implementation table a bridged dispatch resolves
through, and the `Crypto` the bridge derives its delegate's child execution id
with.

### Executable.fileSpecifier

```ts
const fileSpecifier: (path: string) => string
```

A `file:` specifier for an absolute filesystem path, following
`pathToFileURL`'s escaping. It is written by hand rather than with `node:url`
so a package importing this conversion does not also require a Node builtin or
a bundler shim for one, and it is exported because `Options.load` receives a
path rather than a specifier.

A `#` or a `?` in a directory name is both a legal filename character and URL
syntax, and concatenating one unescaped truncates the specifier at it, so
`file:///a#b.ts` addresses `/a`. The loader then imports the wrong module, or
none, with nothing in the failure to say why.

### Executable.ExecutableError and ExecutableErrorCode

```ts
class ExecutableError {
  readonly _tag: "flows/registry/ExecutableError"
  readonly code:
    | "missing_delegate"
    | "ambiguous_delegate"
    | "body_unavailable"
    | "invalid_module"
    | "invalid_layer"
    | "missing_service"
    | "layer_failed"
  readonly flow: string
  readonly path?: string
  readonly delegate?: string
  readonly service?: string
  readonly available: ReadonlyArray<string>
  readonly message: string
  readonly cause?: unknown
}
```

A descriptor the bridge will not turn into a runnable flow. `delegate` is
present whenever the refusal is about one named flow, and `available` lists the
delegates the host registered. That is the whole point of the type: the
engine's own unresolved-call defect names nothing, so an operator reading it
cannot tell which registration is missing.

`service` names a service missing during construction of a module's exported `layer`.
The optional export is built once in a scoped host context; see
[Module action implementations](/guides/run-a-discovered-flow/#module-action-implementations).

Each code, with its cause and its fix, is in
[Troubleshooting](/troubleshooting/).

## Pack

Workflow packs: a directory of flows with a manifest, a content address, and a
merge order. See [Load workflow packs](/guides/load-packs/).

`Discovery` already answers "what flows are in this directory". A pack adds the
three things a shareable directory needs and a bare directory cannot carry: a
name and version so a descriptor can say where it came from, a content address
so a lock file can pin exactly the bytes that were installed, and a
compatibility range so a pack written against a newer runtime is refused at
load rather than halfway through a run.

### Pack.Manifest, Pack.Requires, Pack.Origin

```ts
class Manifest {
  readonly name: string // non-empty
  readonly version: string // non-empty
  readonly flows: ReadonlyArray<string>
  readonly skills?: ReadonlyArray<string>
  readonly requires?: Requires
}

const Requires: Schema.Struct<{ smithers: Schema.String }>
const Origin: Schema.Literals<["local", "installed"]>
```

The manifest as it is written in `pack.json`. `flows` and `skills` are
directory paths relative to the pack root, each scanned exactly the way an
ordinary registry source is. They are paths and not flow names on purpose: a
manifest that listed names would have to be re-edited every time a flow was
added, and the digest would then not change when one was.

Every path must be a safe pack-relative path: non-empty, with no `.` or `..`
segment, no NUL byte, no backslash, no leading `/`, and no drive prefix. The
schema refuses anything else.

`Requires` names only `smithers`. A pack is a set of flow declarations, and the
one thing that can make them unloadable is the runtime that reads them.

`Origin` decides a name collision. `local` is a pack the project owns, checked
in or linked into the working tree; `installed` is one a package manager or an
install verb put there. A local flow shadows an installed flow of the same
name, never the other way round.

### Pack.Installed and Pack.Scan

```ts
interface Installed {
  readonly manifest: Manifest
  readonly dir: string
  readonly origin: Origin
  readonly warnings?: ReadonlyArray<DiscoveryWarning> | undefined
}

interface Scan {
  readonly pack: Installed
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}
```

One pack the host has decided to load, and where it came from. `dir` is the
pack root, and every manifest path is resolved against it. `Scan` is one pack's
scan, ready for `merge`.

### Pack.read

```ts
const read: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string
) => Effect.Effect<
  {
    readonly manifest: Manifest
    readonly dir: string
    readonly warnings: ReadonlyArray<DiscoveryWarning>
  },
  RegistryError
>
```

Reads and decodes one pack's `pack.json`. A manifest that is missing,
unparseable, or incomplete fails `RegistryError { code: "invalid_pack" }` here
rather than producing a half-loaded registry: the manifest is what names the
pack in every descriptor's provenance, so there is nothing useful to do without
it. An unsafe `flows` or `skills` entry fails the same way, naming the entry.

`warnings` holds one `unknown_pack_key` per manifest key outside `name`,
`version`, `flows`, `skills`, and `requires`. Spread this result into an
`Installed` and add `origin` to carry them: a misspelled `requires` would
otherwise disable the compatibility gate in silence.

### Pack.sources

```ts
const sources: (
  pack: Installed,
  path: Path.Path
) => Effect.Effect<ReadonlyArray<Descriptor.Source>, RegistryError, FileSystem.FileSystem>
```

The registry sources one pack contributes, in manifest order. Every `flows` and
`skills` path becomes a path-named source with `confinementRoot` set to the
pack root. Discovery uses the same pipeline as project directories. `source`
carries `pack:<name>`, which is what a warning about a pack file reads back.

Lexical containment is always enforced. When the pack root's real path
resolves, a source must resolve inside it or not exist yet; any other
`realPath` failure is refused. Hosts that cannot resolve the pack root use the
lexical verdict. The defense
is repeated here because callers may construct an `Installed` value without
decoding a manifest first. Discovery repeats the real-path check for the
source root, every descended directory, and every selected entry file. Nested
directory and entry-file symlink escapes produce `outside_root` and contribute
no descriptor for body loading or executable catalog import. Links to other
locations inside the pack remain eligible. This is a discovery-time check,
not a sandbox for module imports or protection against concurrent filesystem
changes.

### Pack.checkCompatible, Pack.compatible

```ts
const compatible: (range: string, runtimeVersion: string) => boolean

const checkCompatible: (
  pack: Installed,
  path: Path.Path,
  runtimeVersion: string
) => Effect.Effect<void, RegistryError>
```

Whether a runtime version satisfies a pack's declared range. The supported
grammar is `*`, inclusive hyphen ranges, and whitespace-separated conjunctions
of bare, `=`, `>=`, `>`, `<=`, `<`, `^`, and `~` comparators. Whitespace may
separate an operator from its version. Versions have one to three numeric
components and omitted components are zero-filled. `x` components, `*`
components, and `||` unions are unreadable; only a standalone `*` is accepted.

`^` allows everything up to the next bump of the left-most non-zero field, so
`^1.2.0` accepts `1.9.0`, `^0.2.3` accepts `0.2.9` and refuses `0.9.0`, and
`^0.0.3` accepts only `0.0.3`. `~` pins the minor, so `~1.2.0` accepts `1.2.9`
and refuses `1.3.0`.

Prerelease and build suffixes are ignored on both sides, so a `1.0.0-rc.4`
runtime satisfies a range written against `1.0.0`. A pack's compatibility
question is about the release line, and comparing the prerelease tag as well
would refuse every release candidate from a range written against its own
release.

An unreadable range returns `false` from `compatible`, and fails
`unreadable_pack_range` from `checkCompatible`; a readable but unsatisfied one
fails `incompatible_pack`. The two codes are separate so an operator can tell a
dialect this runtime cannot parse from a pack that genuinely needs a newer one.
A pack with no `requires` passes. Both failures name the pack's manifest
through the `Path` service the caller passes, which is the one `Pack.read` and
`Pack.sources` use.

### Pack.digest and Pack.File

```ts
interface File {
  readonly path: string
  readonly contents: string
}

const digest: (manifest: Manifest, files: ReadonlyArray<File>) => string
```

The content address of one pack, as a lock file records it. The digest covers
the manifest and every file the caller measured, each by its own content hash
under a validated pack-relative path.

Entries are ordered by path and then by content digest, so no input ordering
can change the result. Two installs of the same bytes therefore produce the same
digest whatever order the files were read in, and editing one flow body changes
it. Duplicate paths are retained rather than collapsed.

File contents are UTF-8 text; measuring binary resources is outside this
contract, and measuring the files at all is the caller's job. An unsafe path
throws a `TypeError`.

### Pack.attribute

```ts
const attribute: (descriptor: FlowDescriptor, pack: Installed) => FlowDescriptor
```

Stamps a descriptor's `Provenance.pack` with the pack that supplied it, so a
catalog entry says which pack it came from.

### Pack.merge

```ts
const merge: (scans: ReadonlyArray<Scan>) => {
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}
```

Merges scanned packs into one descriptor set, local packs first, each group
keeping the caller's own order. Every kept entry is stamped by `attribute`.

A name defined by more than one pack keeps the highest-precedence definition
and reports a `shadowed` warning naming both packs and versions, so an operator
can see which pack lost and why rather than discovering it from a flow that
behaves unexpectedly.

## RegistryError

Typed failures, shaped after `effect`'s `PlatformError`. Codes are a stable
public contract: callers branch on them and interfaces map them to
remediation. A code is never repurposed; a new one is added.

### RegistryError.DiscoveryError

```ts
class DiscoveryError {
  readonly _tag: "flows/registry/DiscoveryError"
  readonly code: "root_missing" | "read_failed" | "invalid_root" | "unknown"
  readonly module?: string
  readonly method?: string
  readonly path?: string
  readonly message: string
  readonly cause?: unknown
}
```

A failure while discovering entries in one registry source.

### RegistryError.RegistryError

```ts
class RegistryError {
  readonly _tag: "flows/registry/RegistryError"
  readonly code:
    | "not_found"
    | "system_collision"
    | "body_unavailable"
    | "execution_changed"
    | "not_prompt_flow"
    | "invalid_pack"
    | "incompatible_pack"
    | "unreadable_pack_range"
    | "unknown"
  readonly module?: string
  readonly method?: string
  readonly path?: string
  readonly message: string
  readonly cause?: unknown
}
```

A failure while constructing, looking up, loading, or rendering a registry
entry.

Both errors carry `module` and `method`, the operation that raised them, and
carry the offending `path` as a field rather than only inside the prose message
whenever the failure is about a file. A `DiscoveryError` always names its source
root; a `RegistryError` names no path for `not_found`, `system_collision`, and
`not_prompt_flow`, which are about a name rather than a file. Each code, with
its fields, its cause, and its fix, is in
[Troubleshooting](/troubleshooting/).

### RegistryError.RegistryFailure

```ts
type RegistryFailure = DiscoveryError | RegistryError
```

Every failure the registry layer is allowed to surface.

### RegistryError.discoveryError, RegistryError.registryError

```ts
const discoveryError: (options: {
  readonly code: DiscoveryErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly path?: string | undefined
  readonly description?: string | undefined
  readonly cause?: unknown
}) => DiscoveryError

const registryError: (options: {
  readonly code: RegistryErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly path?: string | undefined
  readonly description?: string | undefined
  readonly cause?: unknown
}) => RegistryError
```

The constructors. Each formats `message` as
`<code>: <module>.<method>: <description>`, so every failure reads the same way
whether a caller prints the message or branches on the fields. `module`
defaults to `Discovery` and `Registry` respectively.
