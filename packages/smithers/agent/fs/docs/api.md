---
title: "API reference"
description: "Every export of @smthrs/fs: signatures, behavior, requirements, and errors, grounded in source."
---

The root barrel exposes one namespace per supported module. The same module
is reachable through its named subpath, for example `@smthrs/fs/Command`.

| Namespace     | Responsibility                                                               |
| ------------- | ---------------------------------------------------------------------------- |
| `Command`     | Agent-facing list, parse, execute, and typed exact-call projection.          |
| `CommandTree` | Bounded immutable route trie, longest-prefix lookup, and exact lookup.       |
| `Directive`   | Registry placement literals compiled into core placement annotations.        |
| `FileRouter`  | Metadata-only filesystem discovery with absolute path-derived routes.        |
| `FlowInvoker` | Injected seam that owns actual flow execution.                               |
| `FsError`     | Sanitized stable failure taxonomy for every projection.                      |
| `Incur`       | Lazy schema-aware CLI and HTTP projection.                                   |
| `Route`       | Immutable route metadata, generated manifest types, and lazy module loading. |

The root and the eight named module subpaths are the whole import surface.
`./internal/*` and nested `*/index` subpaths are declared null in the package's
`exports` map, so they do not resolve.

`FileRouter` is discovery. It retains module, Markdown, and skill metadata.
`Command` and `Incur` are execution surfaces and therefore filter to module
routes whose `modelInvocable` flag is true. `Route.load` refuses every other
body kind.

## Example

```ts
import { Command, FileRouter } from "@smthrs/fs"

const program = Effect.gen(function*() {
  const { routes } = yield* FileRouter.scan({ root: "flows" })
  const commands = yield* Command.make(routes)
  return yield* commands.execute("review --number 42")
})
```

## Command

Agent-facing projection of executable, model-visible module routes.

### `Command.make`

```ts
;((routes: ReadonlyArray<Route.Route>) => Effect.Effect<CommandSurface, FsError>)
```

Constructs a command surface from routes. Every supplied route is validated
and snapshotted first, so a malformed route fails `make` even when it would
never enter the executable projection. Non-module, hidden, and
non-model-invocable routes remain available from the registry but never enter
this projection. Two routes claiming one command name fail with
`duplicate_route`; oversized trees fail with `resource_limit`.

### `CommandSurface`

The runtime projection `Command.make` returns. The surface, listed commands,
parsed invocations, and admitted JSON values are frozen.

| Member    | Signature                                                                                                             | Behavior                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `list`    | `() => ReadonlyArray<ListedCommand>`                                                                                  | Lists executable model-visible routes in stable segment order without loading them.    |
| `parse`   | `(commandString: string) => Effect<ParsedCommand, FsError>`                                                           | Loads the selected module and schema-decodes an agent command string without invoking. |
| `execute` | `(commandString: string) => Effect<unknown, FsError, FlowInvoker.FlowInvoker>`                                        | Parses, invokes through `FlowInvoker`, and output-encodes an agent command string.     |
| `call`    | `<N extends Route.Name>(name: N, input: Route.Input<N>) => Effect<Route.Output<N>, FsError, FlowInvoker.FlowInvoker>` | Validates decoded input and output for an exact named route.                           |

`parse` and `execute` accept a listed name with slashes or with spaces:
`"nested/visible --number 42"` and `"nested visible --number 42"` resolve the
same route. Resolution takes the longest command prefix and leaves the
remainder for arguments.

`call` accepts `Schema.Type` input and returns `Schema.Type` output. It
validates both against the decoded side of the loaded schemas without
running their encoding transformations. With `Schema.NumberFromString`,
`call` accepts and returns numbers; `execute` parses encoded string input
and returns the encoded string output. Incur also encodes its output.

`call` snapshots input admitted by the bounded JSON boundary before any
module-loading await. These snapshots and admitted JSON results are frozen.
Other decoded values, including `Date` instances, retain their native types
and are passed by reference; callers must avoid mutating them during an
invocation. They remain subject to the loaded schema's decoded validation.
A name that does not match exactly, extra path segments included, fails with
`unknown_command`. Invalid decoded input or output fails with `decode_failed`;
transport output encoding failures from `execute` use `encode_failed`.

Errors produced by the surface itself: `resource_limit`, `parse_failed`,
`unknown_command`, `load_failed`, `unsupported_schema`, `decode_failed`, and
`encode_failed`. An `FsError` the installed invoker fails with passes through
unchanged. With no invoker installed, `FlowInvoker.makeNoop` fails every
invocation with `invocation_unavailable`.

### `ListedCommand`

A route advertised to an agent.

| Field         | Type                  | Description                               |
| ------------- | --------------------- | ----------------------------------------- |
| `name`        | `string`              | The slash-joined route name.              |
| `description` | `string \| undefined` | The discovered description, when present. |

### `ParsedCommand`

A decoded command-string invocation.

| Field   | Type                        | Description                                     |
| ------- | --------------------------- | ----------------------------------------------- |
| `route` | `Route.Route`               | The resolved route.                             |
| `argv`  | `ReadonlyArray<string>`     | The lexed command tokens.                       |
| `input` | `A` (defaults to `unknown`) | The decoded, frozen input ready for invocation. |

## CommandTree

The bounded, immutable segment trie shared by every command projection.

### Constants

| Export                    | Value  | Description                                               |
| ------------------------- | ------ | --------------------------------------------------------- |
| `maximumRoutes`           | `256`  | Maximum routes accepted by one tree.                      |
| `maximumTotalSegments`    | `4096` | Maximum total path segments accepted by one tree.         |
| `maximumResolutionTokens` | `4096` | Maximum tokens accepted by one direct resolution request. |

### `CommandTree`

A node of the command trie. A node may carry a route, children, or both:
`domains` and `domains/list` may both be routable in the same tree.

| Field      | Type                               | Description                                     |
| ---------- | ---------------------------------- | ----------------------------------------------- |
| `route`    | `Option.Option<Route.Route>`       | The route ending at this node, when one exists. |
| `children` | `ReadonlyMap<string, CommandTree>` | Child nodes keyed by segment.                   |

### `Resolved`

A route selected from an argv prefix, with the unconsumed tokens.

| Field   | Type                    | Description                                |
| ------- | ----------------------- | ------------------------------------------ |
| `route` | `Route.Route`           | The selected route.                        |
| `rest`  | `ReadonlyArray<string>` | The tokens the route name did not consume. |

### `CommandTree.make`

```ts
;((input: ReadonlyArray<Route.Route>) => Effect.Effect<CommandTree, FsError>)
```

Builds one immutable command trie. Two routes claiming the same segment path
fail with `duplicate_route` instead of shadowing one another. Every route is
detached before the first caller-observable await. The input must be an
ordinary dense array: proxies, sparse arrays, accessors, and exotic
containers fail with `invalid_route` without executing user code. Trees above
`maximumRoutes` routes or `maximumTotalSegments` segments fail with
`resource_limit`.

### `CommandTree.resolve`

```ts
;((tree: CommandTree, input: ReadonlyArray<string>) => Effect.Effect<Resolved, FsError>)
```

Resolves the longest routable prefix of an argv. Lookup tokens are normalized
to Unicode NFC before comparison, so a decomposed spelling selects the same
route as a composed one; unconsumed argument text stays exactly as the caller
supplied it. A request above `maximumResolutionTokens` fails with
`resource_limit`. When no prefix matches, the effect fails with
`unknown_command`.

### `CommandTree.resolveExact`

```ts
;((tree: CommandTree, argv: ReadonlyArray<string>) => Effect.Effect<Route.Route, FsError>)
```

Resolves one complete route name and refuses unconsumed path segments with
`unknown_command`.

### `CommandTree.traverse`

```ts
;((tree: CommandTree) => ReadonlyArray<Route.Route>)
```

Lists every route in stable segment order.

## Directive

Serialized placement literals compiled into core placement annotations.

### `Literal`

```ts
type Literal = "client" | "local" | "sandbox" | "remote"
```

A placement literal produced by registry discovery.

### `Directive.compile`

```ts
;((literal: Literal) => Placement.Placement)
```

Compiles a discovered placement literal into the corresponding
[core](/api/core) value: `"client"` to `Placement.client()`, `"local"` to
`Placement.local()`, `"sandbox"` to `Placement.sandbox()`, and `"remote"` to
`Placement.remote()`. Registry discovery has already normalized source
directives, `"use server"` included, before this boundary. The returned value
survives JSON serialization unchanged.

## FileRouter

Filesystem routing over metadata-only registry discovery.

### `ScanConfig`

Configuration for one bounded file-router scan.

| Field  | Type     | Description                                   |
| ------ | -------- | --------------------------------------------- |
| `root` | `string` | The flows tree to scan, relative or absolute. |

### `Warning`

A non-fatal diagnostic emitted by registry discovery, aliasing
`Descriptor.DiscoveryWarning` from [@smthrs/registry](/api/registry).
`@smthrs/fs` copies each warning's `code`, `path`, `name`, and `message` and
drops the registry's optional `cause`.

### `ScanResult`

The immutable metadata-only result of scanning a flows tree. The result and
both arrays are frozen.

| Field      | Type                         | Description                            |
| ---------- | ---------------------------- | -------------------------------------- |
| `routes`   | `ReadonlyArray<Route.Route>` | The discovered routes, sorted by name. |
| `warnings` | `ReadonlyArray<Warning>`     | Non-fatal discovery diagnostics.       |

### `FileRouter.scan`

```ts
;((config: ScanConfig) => Effect.Effect<ScanResult, FsError, FileSystem.FileSystem | Path.Path>)
```

Scans a flows root without importing or evaluating any flow module. The
registry owns entry precedence, metadata parsing, directive detection, and
bounded reads; `@smthrs/fs` projects those descriptors into absolute,
immutable path-derived routes.

The configuration is inspected synchronously, before the first await:
accessors and exotic containers fail with `invalid_root` without being read,
and the root is resolved to an absolute path once for the whole operation.
Root-level entries produce no route. Two source paths collapsing to one
command name fail with `duplicate_route`. A scan returning more than
`CommandTree.maximumRoutes` entries fails with `resource_limit` before any
companion is inspected. A `ui.tsx` beside a flow is recorded on the route's
`ui` field; companions and colocated tests never become routes. A module body
yields kind `module`, a `SKILL.md` body yields kind `skill`, and every other
body yields kind `markdown`.

Requires the `FileSystem.FileSystem` and `Path.Path` services; on Node,
provide `NodeFileSystem.layer` and `NodePath.layer` from
`@effect/platform-node`.

Errors: `invalid_root` when the root or configuration is invalid,
`root_missing` when the root does not exist, `read_failed` when the root or a
companion cannot be read, and `discovery_failed` for every other discovery
failure. Foreign error causes are never retained.

## FlowInvoker

The seam between a resolved route and whatever actually runs a flow. The
projections in this package never execute a flow themselves: the harness owns
the run loop, permissions, and durability, so it supplies this service.

### `Invocation`

One materialized invocation. Projections pass it frozen.

| Field   | Type       | Description                                                     |
| ------- | ---------- | --------------------------------------------------------------- |
| `name`  | `string`   | The resolved route name.                                        |
| `flow`  | `Flow.Any` | The loaded flow, from [@smthrs/core](/api/core).                |
| `input` | `unknown`  | The decoded input; see `CommandSurface` for snapshot semantics. |

### `Service`

Executes a materialized flow.

| Field    | Type                                                          | Description                 |
| -------- | ------------------------------------------------------------- | --------------------------- |
| `invoke` | `(invocation: Invocation) => Effect.Effect<unknown, FsError>` | Runs one materialized flow. |

### `FlowInvoker`

```ts
class FlowInvoker extends Context.Service<FlowInvoker, Service>()("/fs/FlowInvoker")
```

The flow invocation service tag, keyed `"/fs/FlowInvoker"`.

### `FlowInvoker.make`

```ts
;((implementation: Service) => Service)
```

Constructs a frozen flow invoker from an implementation. The implementation
must carry `invoke` as an own data-property function; non-records, inherited
or accessor properties, and non-function values throw `TypeError` without
invoking anything.

### `FlowInvoker.makeNoop`

```ts
;((overrides?: Partial<Service>) => Service)
```

Constructs an invoker that fails every invocation with
`invocation_unavailable`, retaining no invocation data. An `invoke` override
replaces that default; an accessor or non-function override throws
`TypeError`.

### `FlowInvoker.layerNoop`

```ts
;((overrides?: Partial<Service>) => Layer.Layer<FlowInvoker>)
```

Provides `makeNoop` as the `FlowInvoker` layer.

## FsError

The single typed error returned by the file-routing surfaces.

### `Code`

```ts
type Code =
  | "root_missing"
  | "read_failed"
  | "invalid_root"
  | "discovery_failed"
  | "parse_failed"
  | "unknown_command"
  | "duplicate_route"
  | "invalid_route"
  | "resource_limit"
  | "load_failed"
  | "unsupported_body"
  | "unsupported_schema"
  | "decode_failed"
  | "encode_failed"
  | "invocation_unavailable"
```

Stable failure codes for routing, parsing, loading, and decoding, also
exported as a `Schema.Literals` value for decoding. For the meaning and
trigger of each code, see the
[error codes table](./contract.md#error-codes).

### `FsError`

```ts
class FsError extends Schema.TaggedError<FsError>()("flows/fs/FsError", {
  code: Code,
  method: Schema.String,
  description: Schema.String,
  path: Schema.optional(Schema.String)
})
```

A recoverable file-routing failure. `method` names the surface that failed so
a CLI or an agent can report the origin without a stack trace. Raw argv,
input values, output values, schema issues, and implementation causes are
deliberately not retained at this boundary.

## Incur

Incur projection of executable, model-visible module routes, built on the
[`incur`](https://github.com/wevm/incur) CLI library.

### `selfSegment`

```ts
const selfSegment = "self"
```

The reserved child segment that invokes a route which also has children.
Incur cannot represent a node that is both runnable and a command group, so
`domains` alongside `domains/list` is advertised and dispatched as
`domains self` on the CLI and `/domains/self` over HTTP. The bare name keeps
dispatching to the same route.

### `Incur.createCli`

```ts
;((name: string, routes: ReadonlyArray<Route.Route>) => Effect.Effect<IncurCli.Cli, FsError, FlowInvoker.FlowInvoker>)
```

Projects routes onto an Incur CLI while preserving metadata-only discovery.
Routes are validated and filtered exactly as in `Command.make`. A child route
literally named `self` under a route that also has children fails with
`duplicate_route`.

Dispatching one command loads only that command's module. Its actual Effect
input schema is projected into Incur args and options and remains the
authoritative decoder. A discovery surface must publish those descriptors, so
the first discovery request loads every command module once and caches the
result. Discovery requests are: any argv containing `--help`, `-h`, `--llms`,
`--llms-full`, `--schema`, `--version`, or `--mcp`; a truthy `COMPLETE`
environment variable (an empty value is ignored); and the HTTP paths `/mcp`,
`/openapi.json`, `/openapi.yml`, `/openapi.yaml`, and everything under
`/.well-known/`.

The returned CLI overrides two members:

- `serve(argv = process.argv.slice(2), options)` resolves the command tokens
  ahead of the first flag, accepting a slash-joined or spaced first token.
  Only an unmatched name falls back to the metadata surface's help output.
  Every other typed failure is written to `options.stdout` (defaulting to
  `process.stdout`) as a JSON envelope
  `{ "ok": false, "error": { "code", "message" } }`, followed by
  `options.exit(1)` (defaulting to `process.exit`).
- `fetch(request)` resolves the percent-decoded request path the same way and
  honors `request.signal` during dispatch. A malformed percent escape fails
  with status 400 and the `parse_failed` envelope; other pre-dispatch typed
  failures return status 400 with their own envelope.

Once a command dispatches, input that contradicts the advertised schema is
refused before the flow runs, with a field-level error naming the failing
path and no copy of the offending value. Failures raised while decoding,
invoking, or encoding are reported through Incur with the `FsError` code and
exit code 1 on the CLI, and as an error response over HTTP.

## Route

The immutable metadata projection of a discovered flow, and its lazy loader.

### Constants

| Export                   | Value   | Description                                            |
| ------------------------ | ------- | ------------------------------------------------------ |
| `maximumRouteDepth`      | `64`    | Maximum number of path segments in one route.          |
| `maximumSegmentLength`   | `255`   | Maximum UTF-16 length of one route segment.            |
| `maximumRouteNameLength` | `4096`  | Maximum UTF-16 length of one slash-joined route name.  |
| `maximumPathLength`      | `16384` | Maximum UTF-16 length of one source or companion path. |
| `maximumCapabilities`    | `256`   | Maximum number of capabilities declared by one route.  |

### `Kind`

```ts
type Kind = "module" | "markdown" | "skill"
```

How a route's body is stored on disk.

### `Route`

A path-derived command route. Everything here comes from registry discovery,
which never evaluates a flow module. Materializing the flow is `Route.load`.

| Field            | Type                                  | Description                                                       |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `name`           | `string`                              | The slash-joined, NFC-normalized route name.                      |
| `segments`       | `ReadonlyArray<string>`               | The NFC-normalized path segments.                                 |
| `kind`           | `Kind`                                | How the body is stored on disk.                                   |
| `sourcePath`     | `string`                              | The absolute path of the flow entry.                              |
| `description`    | `Option.Option<string>`               | The discovered description.                                       |
| `input`          | `Descriptor.SchemaRef`                | The input schema locator, from [@smthrs/registry](/api/registry). |
| `output`         | `Descriptor.SchemaRef`                | The output schema locator.                                        |
| `capabilities`   | `ReadonlyArray<string>`               | Declared capabilities.                                            |
| `effects`        | `Descriptor.EffectDeclaration`        | The declared reads, writes, mode, conflict policy, and tier.      |
| `modelInvocable` | `boolean`                             | Whether command surfaces may execute this route.                  |
| `placement`      | `Option.Option<Descriptor.Placement>` | The discovered placement literal, when present.                   |
| `ui`             | `Option.Option<string>`               | The absolute `ui.tsx` companion path, when present.               |

### `Manifest`

```ts
interface Manifest {}
```

Generated applications augment this map with route-specific input and output
types:

```ts
declare module "@smthrs/fs/Route" {
  interface Manifest {
    review: {
      readonly input: { readonly number: number }
      readonly output: { readonly accepted: boolean; readonly number: number }
    }
  }
}
```

Declaration merging intentionally starts from an empty manifest.

### `Name`, `Input`, and `Output`

```ts
type Name = keyof Manifest extends never ? string : Extract<keyof Manifest, string>
type Input<N extends Name> = N extends keyof Manifest ? Manifest[N] extends { readonly input: infer I } ? I : unknown
  : unknown
type Output<N extends Name> = N extends keyof Manifest ? Manifest[N] extends { readonly output: infer O } ? O : unknown
  : unknown
```

`Name` narrows to generated manifest keys when a manifest is available, and
`Input` and `Output` narrow a named route's decoded types (`Schema.Type`)
the same way. They describe `CommandSurface.call`, not the encoded transport
values (`Schema.Encoded`) used by `execute` and Incur.
Without a generated manifest, names stay `string` and values stay `unknown`,
so development discovery can proceed.

### `Route.snapshot`

```ts
;((input: Route) => Effect.Effect<Route, FsError>)
```

Copies and validates caller-owned route metadata before asynchronous use.
Validation enforces: `name` equals the slash-joined segments after Unicode
NFC normalization; segments are non-empty, bounded, and free of `.`, `..`,
and `/`; `kind` is a known `Kind`; `sourcePath` is absolute (a `file:///`
URL, a POSIX root, or a drive-letter path); text fields are bounded,
well-formed, and free of NUL; schema locators carry a known `_tag`;
`effects.mode` is `hermetic` or `expected`; `effects.onConflict` is
`serialize`, `lane`, or `fail`; `effects.tier` is `sealed`, `compensable`, or
`irreversible`; and `placement` is one of the four `Directive.Literal`
values. The result is detached from the caller's containers and frozen.
Every violation fails with `invalid_route`.

### `Route.isCommandRoute`

```ts
;((route: Route) => boolean)
```

True only for routes the agent and Incur command surfaces may execute: kind
`module` with `modelInvocable` set to true.

### `Route.load`

```ts
;((input: Route) => Effect.Effect<Flow.Any, FsError>)
```

Materializes the flow behind a route. The route is snapshotted first. Only
module routes can be materialized here; Markdown and skill bodies are registry
inputs rather than executable commands, and fail with `unsupported_body`. The module is imported through an escaped absolute
file URL, so spaces, Unicode, percent signs, hashes, and query characters in
the path name the intended file. An import failure, or a module whose default
export is not a flow, fails with `load_failed`.
