---
title: "API reference"
description: "Every public export of @smthrs/core: the Flow signature builder, the metadata modules, Markdown lowering, Digest, and the Node and Graph re-exports."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/api.md"
---

`@smthrs/core` exports nine modules from its root entry point, and each is also
importable from `@smthrs/core/<Module>`:

```ts
import { Effects, Flow, Graph, Node } from "@smthrs/core"
// or
import * as Flow from "@smthrs/core/Flow"
```

`@smthrs/core/internal/*` and `@smthrs/core/*/index` are not public.
`@smthrs/core/package.json` is exported.

Constructing a signature records a declaration without executing planned steps.
JavaScript and TypeScript declarations and all planning callbacks must be
trusted: `Graph.build` executes them in the caller process with ambient process
authority. Purity is a caller obligation; placement, capability, and effect
metadata does not sandbox planning. Use a constrained data-only ingestion
boundary or an externally isolated planner for untrusted declarations.
For the trust boundary and the model behind these signatures, see [Plan time](/concepts/plan-time/),
[Identity and key material](/concepts/identity/), and
[Effect envelopes](/concepts/effects/).

## Flow

Schema-described signatures, and the combinators that decorate one. `Flow.make`
lowers what an author declares onto the values [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)
executes: a declared action, which is what a host supplies an implementation
for, and a flow whose body is one call to that action. A signature that
declares its own `body` keeps the body and needs no action.

### Flow.make (deprecated)

```ts
const make: <
  I extends Schema.Top = typeof Schema.Void,
  O extends Schema.Top = typeof Schema.Unknown,
  Err extends Schema.Top = typeof Schema.Never,
  Requires = Action.Requirement<string>
>(config: MakeOptions<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
```

Deprecated compatibility adapter. Author new declarations with the tagged
`Flow.make` from `@smthrs/flow`; the adapter's `flow` property is that same
canonical model. Existing metadata and primitive input wrapping are retained.

For existing callers, `name` is required and is the tag the flow, the action,
and every plan that records a call carry; `Flow.make` throws `TypeError`
without one rather than minting an empty tag. A declaration loaded from a file
takes the name its loader derives from the path.

```ts
import { Action } from "@smthrs/flow"
import { Effect, Schema } from "effect"

const read = Action.make("std/read", {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  capabilities: ["fs"]
})

const layer = read.toLayer(({ path }) => Effect.succeed(path))
```

### Flow.MakeOptions

```ts
interface MakeOptions<I extends Schema.Top, O extends Schema.Top, Err extends Schema.Top, Requires> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly input?: I | undefined
  readonly output?: O | undefined
  readonly error?: Err | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly model?: Seat | readonly [Seat, ...Seat[]] | undefined
  readonly flows?: ReadonlyArray<Reference> | undefined
  readonly prompt?: string | undefined
  readonly body?: ((input: I["Type"]) => Node.Node<O["Type"], Err["Type"], Requires>) | undefined
}
```

`input` defaults to `Schema.Void`, `output` to `Schema.Unknown`, and `error` to
`Schema.Never`. `capabilities` is sorted and deduplicated. `model`, `flows`,
and `prompt` are advisory metadata a catalog and a decorator read back; the
collaborator array is copied.

### Flow.Flow

```ts
interface Flow<
  I extends Schema.Top,
  O extends Schema.Top,
  Err extends Schema.Top = typeof Schema.Never,
  Requires = Action.Requirement<string>
> extends Pipeable {
  readonly name: string
  readonly description: string | undefined
  readonly input: I
  readonly output: O
  readonly error: Err
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly model: Seat | readonly [Seat, ...Seat[]] | undefined
  readonly flows: ReadonlyArray<Reference> | undefined
  readonly prompt: string | undefined
  readonly annotations: Context.Context<never>
  readonly flow: DurableFlow.Flow<string, Payload<I>, O, Err, Requires>
  readonly action: Action.Declared<string, Payload<I>, O, Err, Requires> | undefined
  readonly call: (input: I["~type.make.in"]) => Node.Node<O["Type"], Err["Type"], Requires>
}
```

`flow` is the `@smthrs/flow` flow the signature IS: hand it to `Graph.build`,
to an `Interpreter`, or to a registry that checks that package's type id.
`action` is the declaration a host implements with `toLayer`, and it is
`undefined` exactly when the signature declared a `body`. `annotations` is the
bag both carry, with the declared `capabilities` and `effects` already lowered
into it.

A signature that declared no effect envelope dispatches as `irreversible`.
`Flow.sealed` changes the tier; its generated action remains keyless and uses
invocation identity, so this alone does not enable content sharing across runs.

The requirement channel is `Action.Requirement<string>` for every body-less
signature, because a signature's tag is typed `string`. The compiler therefore
does not tell one missing implementation from another; the runtime context key
is per tag and still refuses.

### Flow.Payload

```ts
type Payload<I extends Schema.Top> =
  & (I extends DurableFlow.AnyStructSchema ? I : Schema.Struct<{ readonly input: I }>)
  & DurableFlow.AnyStructSchema
```

The struct payload a declared `input` becomes. `@smthrs/flow` requires a struct
payload, so a non-struct input travels as the one field `input`. `call` takes
the declared shape and wraps it, so an author never writes the wrapper.

### Flow.call

```ts
readonly call: (input: I["~type.make.in"]) => Node.Node<O["Type"], Err["Type"], Requires>
```

Records a call in the schema's constructor shape. A class schema accepts inert
field data; it need not put a class instance in the plan. It never runs the body:
`Graph.build` evaluates pure bodies at plan time.

### Flow.Any

```ts
interface Any {
  readonly name: string
  readonly description: string | undefined
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly flows: ReadonlyArray<Reference> | undefined
  readonly annotations: Context.Context<never>
  readonly flow: DurableFlow.Any
  readonly call: (input: never) => Node.Node<unknown, unknown, unknown>
}
```

The existential a decorator holds. It names every property a consumer outside
this package reads off a signature.

### Flow.Reference and Flow.Seat

```ts
type Reference = Any | string
type Seat = string & {}
```

A collaborator is a signature or a registry name the harness resolves. A seat
is a model seat name, never a provider model id.

### Flow.isFlow

```ts
const isFlow: (value: unknown) => value is Any
```

The runtime type-id check, not a shape check.

### Flow.withCapabilities

```ts
const withCapabilities: {
  (
    capabilities: ReadonlyArray<string>
  ): <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
  <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>, capabilities: ReadonlyArray<string>): Flow<I, O, Err, Requires>
}
```

Returns a fresh signature whose capabilities are the union, sorted and
deduplicated.

### Flow.within

```ts
const within: {
  (placement: Placement.Placement): <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
  <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>, placement: Placement.Placement): Flow<I, O, Err, Requires>
}
```

The placement-shaped special case of `annotate`.

### Flow.annotate and Flow.annotateMerge

```ts
const annotate: {
  <Key, S>(
    key: Context.Key<Key, S>,
    value: S
  ): <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
  <I, O, Err, Requires, Key, S>(
    self: Flow<I, O, Err, Requires>,
    key: Context.Key<Key, S>,
    value: S
  ): Flow<I, O, Err, Requires>
}

const annotateMerge: {
  (
    annotations: Context.Context<never>
  ): <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
  <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>, annotations: Context.Context<never>): Flow<I, O, Err, Requires>
}
```

A custom key is advisory, so a signature annotated with one plans the same
graph. `Annotations.Placement` and `Annotations.Effects` are not advisory:
`Graph.build` projects both into node key material. Merged values override
existing values for matching keys, including declared effects and capabilities.
The exposed metadata and the action's tier follow those overrides. Later
`withCapabilities` and `sealed` operations update the effective values.
Combinators retain the original diagnostic source locations of both native
declarations.

### Flow.withFlows

```ts
const withFlows: {
  (flows: ReadonlyArray<Reference>): <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
  <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>, flows: ReadonlyArray<Reference>): Flow<I, O, Err, Requires>
}
```

Replaces the collaborators a signature declares. Everything else comes across
unchanged, which is what lets a decorator rewrite a flow tree without dropping
the metadata a host reads back. The replacement array is copied.

### Flow.sealed

```ts
const sealed: {
  (): <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>) => Flow<I, O, Err, Requires>
  <I, O, Err, Requires>(self: Flow<I, O, Err, Requires>): Flow<I, O, Err, Requires>
}
```

A signature that declared no envelope gains the hermetic, sealed one; a
signature that declared one keeps its reads and writes and seals the tier.

### Flow.Input, Flow.Output, Flow.Error

```ts
type Input<F> = F extends { readonly input: infer I extends Schema.Top } ? I["Type"] : never
type Output<F> = F extends { readonly output: infer O extends Schema.Top } ? O["Type"] : never
type Error<F> = F extends { readonly error: infer Err extends Schema.Top } ? Err["Type"] : never
```

The decoded types a signature declares.

### Flow.TypeId

```ts
const TypeId: "~flows/core/Flow"
type TypeId = "~flows/core/Flow"
```

The runtime brand `isFlow` checks.

## Node

`@smthrs/plan`'s node model, re-exported. `@smthrs/core/Node` is the name this
package's consumers reach it through and adds nothing: one AST, one set of
combinators, and one function-identity rule wherever a plan is built.

```ts
import { Node } from "@smthrs/core"

const plan = Node.map(Node.succeed(1), (value) => value + 1)
```

`succeed`, `fail`, `all`, `map`, `andThen`, `bindPlanned`, `branch`, `catch`, `capture`,
`priority`, and the call constructors are documented in the
[`@smthrs/plan` reference](https://plan.smithers.sh/reference/api/#node). A continuation that decides on a
real value is `Node.branch`: a continuation runs once at build time, on a
strict placeholder.

## Graph

`@smthrs/flow`'s plan-time graph builder, re-exported. `Graph.build` takes a
flow or a node, splices every call it can reach, and answers the topology,
the drafts a plan is compiled from, and the refusals it recorded rather than
threw.

```ts
import { Graph, Node } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"

const greeting = Flow.make("greeting", {
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
})

const graph = Graph.build(greeting, { name: "world" })
```

`build`, `nodes`, `edges`, `drafts`, `diagnostics`, `maximumGraphDepth`, and
the `Graph`, `GraphNode`, `Edge`, `EdgeReason`, `LayerRequest`, and
`BuildOptions` types are documented in the
[`@smthrs/flow` reference](https://flow.smithers.sh/reference/api/#graph), including every build refusal and
which of them are fatal.

`Graph.evaluatedFrom(evaluated, entry)` is re-exported with them. It states
that a file this runtime is about to evaluate holds bytes read from another,
so every declaration made while that file is evaluated reports the entry an
author can open rather than the scratch path the bytes were written to. A host
that verifies a flow's source has to evaluate the bytes it measured, and the
only way to evaluate bytes is to write them somewhere and import that path;
call this before the import, because a declaration captures its site while its
module is evaluated and never rewrites it afterwards.

## Effects

Pure effect declarations describing read and write envelopes.

The model lives in [`@smthrs/plan`](https://plan.smithers.sh/reference/api/#effects), the lowest package this
one and the library that executes a flow both depend on. `@smthrs/core/Effects`
re-exports it and adds nothing, so a declaration narrowed here and a declaration
narrowed by `@smthrs/flow` are narrowed by the same rule. The plan reference
documents `Declaration`, `MakeOptions`, `make`, `covers`, `narrow`,
`NarrowResult`, `overlaps`, `sealed`, and the prepared matching API `Graph.build`
uses.

```ts
import { Effects } from "@smthrs/core"

const envelope = Effects.make({
  reads: ["src/**"],
  writes: ["dist/**"],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
})
```

## Placement

Serializable placement annotations for flow graph values.

### Placement.Placement

```ts
type Placement = Data.TaggedEnum<{
  readonly "flows/core/Placement/Local": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Client": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Sandbox": Options
  readonly "flows/core/Placement/Remote": Options
}>
```

A serializable directive describing where a flow node should run.

### Placement.Options

```ts
interface Options {
  readonly image?: string | undefined
  readonly profile?: string | undefined
  readonly target?: string | undefined
}
```

Host-selection details. These fields identify a host profile; they never
contain a host implementation, credentials, or any other runtime handle.

### Placement constructors

```ts
const local: () => Placement
const client: () => Placement
const sandbox: (options?: Options) => Placement
const remote: (options?: Options) => Placement
```

`local` is the local process host, `client` is the viewer's browser host,
`sandbox` is an isolated sandbox host, and `remote` is a remote control-plane
host.

## Annotations

Typed immutable annotations attached to flow graph values. The bag is an Effect
`Context`, so a decorator may define its own key.

### Annotations.empty, add, merge, getOption

```ts
const empty: Context.Context<never>
const add: typeof Context.add
const merge: (parent: Context.Context<never>, child: Context.Context<never>) => Context.Context<never>
const getOption: <I, S>(context: Context.Context<never>, key: Context.Key<I, S>) => Option.Option<S>
```

`add` sets or replaces one annotation without changing the original. `merge`
combines a parent and a child bag, with the child's values winning.
`getOption` returns `Option.none()` for an absent service key. A
`Context.Reference` supplies its default when absent.

### The three keys

```ts
const Placement: Context.Key<Placement.Placement, Placement.Placement>
const Effects: Context.Key<Effects.Declaration, Effects.Declaration>
const Priority: Context.Service<number>
```

`Graph.build` projects `Placement` and `Effects` onto nodes. These keys are
not declared here: they are [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s
`Placement.Annotation` and `Effects.Envelope`, the same objects
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) publishes as `Flow.Placement` and
`Flow.EffectEnvelope`, so a flow annotated for one graph builder is visible to
the other. `Priority` is a signed integer read by registry and host lowering;
use `Node.priority` to set priority directly in a graph. Priority is never part
of step identity, so raising it never invalidates a cached step.

A fourth key, `Lane`, and its `LaneOptions` are gone. They were a second
spelling of `Effects.Declaration.onConflict: "lane"` with no caller outside
this package's own tests; the lane a node carries is now only the one the
write-conflict pass assigns it, typed as `Graph.Lane`.

## KeyMaterial

The digest-free input to [`@smthrs/plan`](https://plan.smithers.sh/reference/api/). Types only; this module
exports no runtime values.

### KeyMaterial.KeyMaterial

```ts
interface KeyMaterial {
  readonly version: "flows/key-material/v2"
  readonly kind: "sealed" | "compensable" | "irreversible"
  readonly body: unknown
  readonly inputs: ReadonlyArray<InputRef>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}
```

`kind` is the effective declaration's tier. `body` is the node's own
declaration projected into inert data: a call records the callee's schema
identity, capabilities, and effects.

### KeyMaterial.InputRef

```ts
type InputRef =
  | { readonly _tag: "Literal"; readonly value: unknown }
  | { readonly _tag: "Ref"; readonly from: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Pending"; readonly from: string }
```

A declared input used to identify a planned node. A `Ref` records a placeholder
member read: the node it came from and the path read from it. Graph-local ids
occur only inside these references, and the key compiler replaces them with
dependency digests before hashing.

### KeyMaterial.Entry

```ts
interface Entry {
  readonly nodeId: string
  readonly material: KeyMaterial
}
```

`nodeId` is traversal data and is never part of the material handed to the key
compiler.

## Markdown

Parses Agent Skills documents and lowers markdown prompts into ordinary signatures.
General markdown discovery, and the one specification rule that needs the file
system, belong to [`@smthrs/registry`](https://registry.smithers.sh/reference/api/).

### Markdown.parseSkill

```ts
const parseSkill: (text: string) => Result.Result<SkillDocument, MarkdownError>
```

Parses an Agent Skills document with failsafe-schema YAML semantics and
validates its frontmatter with
[`validateSkillFrontmatter`](#markdownvalidateskillfrontmatter). A mapping at
any depth that uses the reserved key `__proto__`, `constructor`, or `prototype`
fails with `skill_invalid_frontmatter`, so a copy of `extra` cannot re-point a
prototype. An alias that refers back to its own anchor, such as
`b: &a { c: *a }`, fails with the same code instead of producing a circular
value.

### Markdown.SkillDocument and Markdown.SkillFrontmatter

```ts
interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly allowedTools: ReadonlyArray<string>
  readonly extra: Record<string, unknown>
}

interface SkillDocument extends SkillFrontmatter {
  readonly body: string
}
```

`allowedTools` is the specification's space-separated `allowed-tools` scalar
split into tool names. `extra` holds every other field, including the validated
optional `license`, `compatibility`, and `metadata`, as a frozen
null-prototype record.

### Markdown.validateSkillFrontmatter

```ts
const validateSkillFrontmatter: (
  fields: Record<string, unknown>
) => Result.Result<SkillFrontmatter, MarkdownError>
```

Checks already-parsed frontmatter against the specification's intrinsic rules:
`name` is 1 to 64 lowercase ASCII letters, digits, or single hyphens and cannot
start or end with a hyphen; `description` is 1 to 1024 characters counted in
code points; `allowed-tools` and `license` are scalars; `compatibility` is 1 to
500 characters; `metadata` maps string keys to scalar values. A field that is
absent reports a `missing` code, and a field that is present but malformed
reports its own `invalid` code without echoing the offending value.

### Markdown.isSkillName

```ts
const isSkillName: (name: string) => boolean
```

Whether `name` is a valid Agent Skills name: 1 to 64 lowercase ASCII letters,
digits, or single hyphens, not starting or ending with a hyphen.
`validateSkillFrontmatter` applies this rule, and `@smthrs/registry` reads the
same predicate when it warns about a discovered skill's name.

### Markdown.lowerSkill

```ts
const lowerSkill: (text: string) => Result.Result<Flow.Flow<typeof input, typeof output>, MarkdownError>
```

Parses and lowers an Agent Skills document to an ordinary signature whose input is
`{ args: string }` and whose output is `string`. Only `name`, `description`,
and `allowed-tools` are lowered; every other field stays in `parseSkill`'s
`extra` record.

### Markdown.lowerMarkdown

```ts
const lowerMarkdown: (
  frontmatter: MarkdownFrontmatter,
  body: string
) => Flow.Flow<typeof input, typeof output>
```

Lowers already-typed markdown metadata and a body to an ordinary signature. The
prompt is the markdown body; harnesses append non-empty runtime `args` when
rendering it. The lowered signature declares no body, so it carries the action a
host supplies the implementation for, and the collaborators it names stay
declarations. The `smart` seat is the explicit fallback when the frontmatter
declares no `model`.

### Markdown.MarkdownFrontmatter

```ts
interface MarkdownFrontmatter {
  readonly name: string
  readonly description?: string | undefined
  readonly model?: string | readonly [string, ...string[]] | undefined
  readonly flows?: ReadonlyArray<string> | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: {
    readonly reads?: ReadonlyArray<string> | undefined
    readonly writes?: ReadonlyArray<string> | undefined
    readonly mode?: "hermetic" | "expected" | undefined
    readonly onConflict?: "serialize" | "lane" | "fail" | undefined
    readonly tier?: "sealed" | "compensable" | "irreversible" | undefined
  } | undefined
  readonly placement?: "sandbox" | "remote" | "client" | "local" | undefined
}
```

`name` is required: it is the tag the lowered signature carries, and a registry
derives it from the frontmatter or from the document's path before lowering. An
omitted `effects.reads` or `effects.writes` becomes empty, an omitted `mode`
becomes `hermetic`, and an omitted `onConflict` becomes `serialize`.

### Markdown.MarkdownError

```ts
class MarkdownError extends Schema.TaggedError<MarkdownError>()("flows/core/MarkdownError", {
  code: MarkdownErrorCode,
  message: Schema.String
}) {}
```

`MarkdownErrorCode` is the literal schema of ten codes:
`skill_missing_frontmatter`, `skill_invalid_frontmatter`, `skill_missing_name`,
`skill_invalid_name`, `skill_missing_description`,
`skill_invalid_description`, `skill_invalid_allowed_tools`,
`skill_invalid_compatibility`, `skill_invalid_metadata`, and
`skill_invalid_license`.

## Digest

Synchronous identity construction, for the pure constructors that compute a
content fingerprint without suspending. The digest is the same digest an
Effect-shaped derivation produces: the same canonical bytes, the same hash, and
the same hexadecimal encoding.

### Digest.digest

```ts
const digest: (input: string | Uint8Array) => string
```

The full lowercase SHA-256 digest of UTF-8 string or byte input.

### Digest.canonical

```ts
const canonical: (value: unknown) => string
```

The RFC 8785 canonical JSON serialization of a value. A function, symbol,
`bigint`, cyclic object, non-finite number, or top-level `undefined` has no
canonical JSON representation; for those values this throws the `SchemaError`
from `effect/Schema` raised through `Effect.runSync`, unwrapped.

### Digest.provideSync

```ts
const provideSync: <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) => Effect.Effect<A, E>
```

Provides the synchronous SHA-256 service to an Effect-shaped derivation, so a
pure constructor can run one without a platform layer.
