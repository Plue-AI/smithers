---
title: "API reference"
description: "Every public export of @smthrs/chain: the 20 namespaces, their members, signatures, behavior, and errors."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/api.md"
---

`@smthrs/chain` exports one namespace per module. The barrel and the matching
subpath reach the same module, so `@smthrs/chain/Catalog` and `Catalog` from
the barrel are the same namespace. `./internal/*` is null-mapped and carries
no promise.

## The spine

| Namespace     | What it is                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Chain`       | The trampoline. `Chain.run(options)` drives a chain to a terminal outcome and resumes from whatever the journal already holds.     |
| `Journal`     | The append-only journal port: `append(event, expectedPosition)` and `read`. `layerMemory` is the in-process stand-in tests run on. |
| `Event`       | The event vocabulary and the pure folds over it. Every projection a host shows is a fold, never a second store.                    |
| `CallKey`     | The replay key: link, script digest, ordinal, and the entry's declaration digest.                                                  |
| `Outcome`     | What a link returns: `done`, `to`, `park`, and the terminal subset a run resolves to.                                              |
| `Observation` | The typed rejection a gate journals so the next author can route around it.                                                        |

## Authoring and scripts

| Namespace           | What it is                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Author`            | The model seat as a port. `layerMock` and `layerFn` are the test seats; `contextOf` normalizes a script's author payload. |
| `AuthorDeclaration` | The author entry's name, description, digest, and capability claim, in one leaf both the trampoline and the prompt read.  |
| `ModelAuthor`       | The production seat over `@smthrs/model`.                                                                                 |
| `Script`            | Script text plus the digest that keys it, and `extract`, which is gate 1: exactly one fenced `flow` block.                |
| `ScriptRunner`      | The interpreter port, its typed `ScriptFailure`, and `layerInProcess`.                                                    |
| `JsonBoundary`      | The gate both bindings answer to: `jsonBoundary`, its limits, `decodeOutcome`, and the shared refusal messages.           |
| `QuickJsRunner`     | The production sealed interpreter: a per-link QuickJS realm with memory, stack, and step limits.                          |
| `Prompt`            | The byte-stable system prefix and the catalog block the model reads.                                                      |

## The catalog and its compositions

| Namespace         | What it is                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Catalog`         | Gate 3: the entries a script may call, indexed by name, plus `entryDigest`, the `system` entries, and `withSystem`. |
| `MemoryEntries`   | Durable memory as two entries, `remember` and `recall`.                                                             |
| `RegistryCatalog` | Repository-discovered flows projected into entries.                                                                 |
| `SubChains`       | Sub-agents as one ordinary entry: `agent` runs a nested chain in the same journal under a derived child id.         |

## Seams a host provides

| Namespace   | What it is                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorize` | Gate 4: per-call authorization against the capabilities an entry declares. `layerRules` decides exact claims through `@smthrs/capability`'s own `Permission.evaluate`. |
| `Steering`  | The root chain's inbound instruction channel, drained at a link and ordinal boundary and journaled.                                                                    |

## Composing a run

`Chain.run` needs four services (`Journal`, `Catalog`, `Author`, and
`ScriptRunner`) and picks up `Authorize` and `Steering` when they are
mounted.

Neither `Chain` nor `ModelAuthor` writes a prompt. `Chain.run` defaults
`prefix` to the empty string and `ModelAuthor` sends no system part for an
empty prefix, so a model-backed run that passes only a `goal` hands the model
nothing about links, flow scripts, `ctx.call`, outcomes, or the entries it may
call. Assemble the prefix from the mounted catalog with `Prompt.forCatalog`
and pass it to every `Chain.run`.

```ts
import { Catalog, Chain, Journal, ModelAuthor, Prompt, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

// `ModelAuthor.layer` needs `Model.Model`, and `Layer.mergeAll` does not
// satisfy one sibling from another: the model layer goes UNDER the author
// layer, not beside it.
const author = ModelAuthor.layer(authorConfig).pipe(Layer.provide(modelLayer))

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  author,
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem(hostEntries))
)

// The prefix is assembled from the SAME catalog service the chain dispatches
// against, so the entries the model reads are the entries it can call.
const program = Effect.gen(function*() {
  const catalog = yield* Catalog.Catalog
  return yield* Chain.run({
    goal: "fix the failing test",
    prefix: Prompt.forCatalog(catalog, "concierge")
  })
})

// `QuickJsRunner.layer()` carries a `ScriptFailure` error, so the composed
// program can also fail with `runner_unavailable` while the layers are being
// built, before any run starts. Compiling the WebAssembly module is the
// thing that can fail (a browser CSP blocking WebAssembly, say), and that is
// a typed, retryable unavailability rather than a defect.
const terminal = await Effect.runPromise(program.pipe(Effect.provide(layers)))
```

A catalog layer that itself needs the base services (`SubChains.make` is
the one in this package) must be built over the SAME journal, author, and
runner instances the chain runs on. `SubChains` captures those services at
construction, so a catalog built over a second set of layers would run its
children against a different journal than their parent.

## `Chain`

The chain trampoline: bootstrap, links, gates, and prefix replay.

### Errors

- `ChainError extends Schema.TaggedError`: tag `/chain/ChainError`, fields
  `code: "replay_divergence" | "invalid_journal"` and `message: string`. A
  chain that cannot proceed: a replayed link diverged from its journal, or
  the journal itself is not a valid chain history. Never recoverable by
  re-authoring.

### Models

- `Options`: what a run needs.
  - `goal: string` (required): pinned into `ChainStarted` and compared on
    resume.
  - `envelope?: Schema.Json`: opaque run identity, compared on resume; a
    resumed run whose envelope differs fails with `replay_divergence`. NOT a
    policy input: the `Authorize` seam receives only the call's name,
    capabilities, and slot. Journaled verbatim and never redacted, so keep
    secrets out of it.
  - `prefix?: string`: the stable fixed prefix handed to the author seat.
  - `maxLinks?: number`: link budget, default `defaultMaxLinks`.
  - `maxCallsPerLink?: number`: per-link call budget, default
    `defaultMaxCallsPerLink`.
  - `context?: ReadonlyArray<string>`: caller-supplied context lines
    appended after the goal in harness-driven author calls.
  - `chain?: string`: the journal scope this run owns (default `""`, the
    root); sub-chains derive theirs from the spawning call slot.

### Constants

- `authorName: "author"`: the name every script uses to call the author
  seat, re-exported from `AuthorDeclaration`.
- `authorDescription: string`: the author entry's one-line description,
  shared with the prompt's catalog block so the model sees the same
  declaration the key pins.
- `authorDigest: string`: the declaration digest pinned into every author
  call key.
- `authorCapability: "model:call:author"`: the capability claim the chain
  sends to the `Authorize` seam for the model seat. An operator's policy
  rule must cover it for a chain to author at all.
- `defaultMaxLinks = 32`: the link budget a run inherits when
  `Options.maxLinks` is unset. Exceeding it parks the chain with a `quota`
  reason.
- `defaultMaxCallsPerLink = 64`: the per-link call budget a run inherits
  when `Options.maxCallsPerLink` is unset. Exceeding it rejects the call as
  a `fuel` observation, which parks the chain on the next attempt.

### Execution

- `run(options: Options): Effect.Effect<Outcome.Terminal, RunError, Services>`:
  runs a chain to a terminal outcome, resuming from whatever the journal
  already holds. A finished chain returns its terminal without executing
  anything; a half-finished link replays its settled calls by ordinal before
  running live. The error channel and the service requirement are fixed:

  ```ts
  type RunError =
    | ChainError
    | Journal.JournalError
    | Author.AuthorError
    | Steering.SteeringError
    | Authorize.AuthorizeError

  type Services =
    | Journal.Journal
    | Catalog.Catalog
    | Author.Author
    | ScriptRunner.ScriptRunner
  ```

  A script failure, a handler failure, and an unserializable value become
  journaled observations, not errors.

## `Journal`

The append-only journal port and its in-memory layer. The journal is the
only state the chain has.

### Errors

- `JournalError extends Schema.TaggedError`: tag `/chain/JournalError`,
  fields `code: "journal_conflict" | "journal_unavailable"` (constructor
  default `journal_unavailable`) and `message: string`. A journal that
  cannot be appended to or read.

### Services

- `Service`: the two operations the chain needs.
  - `append(event, expectedPosition): Effect<void, JournalError>`: appends
    one event as a compare-and-swap against the position the caller believes
    is next.
  - `read: Effect<ReadonlyArray<Event.Event>, JournalError>`: reads them
    all.
- `Journal extends Context.Service`: the journal service tag, key
  `/chain/Journal`.

### Constructors and layers

- `make(implementation: Service): Service`: builds a journal from an
  implementation.
- `makeNoop(overrides?: Partial<Service>): Service`: a journal whose every
  operation fails as unavailable, with per-operation overrides. The default
  a test starts from.
- `layerNoop(overrides?: Partial<Service>): Layer.Layer<Journal>`: the
  unavailable journal as a layer.
- `layerMemory(initial?: ReadonlyArray<Event.Event>): Layer.Layer<Journal>`:
  an in-memory journal over one array, optionally seeded with prior events.
  The seed is how tests replay and resume a chain. `append` pushes in place
  and fails with `journal_conflict` when `expectedPosition` does not match
  the current length; `read` returns a copy, so a reader never sees a later
  append.

## `Event`

The journal event vocabulary and the pure folds over it.

### Models

Each event is a `Schema.TaggedStruct` (with its decoded type of the same
name) and carries an optional `chain` scope, omitted at the root so existing
journals stay byte-identical and set to the deterministic child id for
sub-chain events.

- `ChainStarted`: `{ goal: string, envelope: Schema.Json }`. The chain's
  first event.
- `LinkAuthored`: `{ link: LinkId, script: Script.Script }`. The script a
  link will execute, recorded before it runs so a resumed link replays the
  same source.
- `CallSettled`: `{ link: LinkId, key: CallKey.CallKey, name: string,
  payload: Schema.Json, result: Schema.Json }`. One call that reached an
  entry and produced a result; the unit the replay cache is keyed by.
- `GateRejected`: `{ link: LinkId, ordinal: Ordinal, observation:
  Observation.Observation }`. One call a gate refused.
- `LinkEnded`: `{ link: LinkId, outcome: Outcome.Outcome }`. The outcome a
  link ended with; the event that advances the link counter.
- `SteeringDrained`: `{ link: LinkId, ordinal: Ordinal, messages:
  ReadonlyArray<string> }`. One non-empty steering drain, tied to the live
  author call it fed. Empty drains are not journaled.
- `Event`: the union of all six.

### Folds

Each fold takes the event array and a chain scope (default `""`, the root)
and returns a pure projection.

- `inChain(event, chain): boolean`: whether an event belongs to the given
  chain scope.
- `started(events, chain?): boolean`: whether the chain has recorded its
  `ChainStarted` event.
- `linkCount(events, chain?): number`: the index of the current link. Links
  end strictly in order, so the count of `LinkEnded` events names the link
  now in progress.
- `authored(events, link, chain?): Script.Script | undefined`: the script
  authored for a link, if any. Link 0 (bootstrap) never has one.
- `settled(events, link, chain?): ReadonlyMap<number, CallSettled>`: the
  settled calls of a link, keyed by ordinal. The replay cache.
- `rejected(events, link, chain?): ReadonlyMap<number, GateRejected>`: the
  gate rejections of a link, keyed by ordinal. Replayed as aborts so a
  resumed link never re-executes a rejected call.
- `observations(events, link, chain?): ReadonlyArray<Observation.Observation>`:
  all observations recorded for a link, in journal order. The material a
  recovery author call projects into its context.
- `steeringLines(events, link, chain?): ReadonlyArray<string>`: every
  steering line recorded for a link, in drain order.
- `steeredOrdinals(events, link, chain?): ReadonlySet<number>`: the ordinals
  of a link's recorded drains. A resumed execution never re-drains a
  boundary it already consumed.
- `terminal(events, chain?): Outcome.Terminal | undefined`: the chain's
  terminal outcome, if it has one: the last `LinkEnded` whose outcome is
  `Done` or `Park`. A replay of a finished chain returns this without
  executing anything.

## `CallKey`

The durable identity of one settled call within a link.

### Models

- `LinkId`: a `Schema.Int` checked `>= 0`. A link's index in its chain,
  counted from zero.
- `Ordinal`: a `Schema.Int` checked `>= 0`. A call's position within its
  link, counted from zero in issue order.
- `CallKey`: `{ link: LinkId, scriptDigest: string, ordinal: Ordinal,
  entryDigest: string }`. The four components a settled call is keyed by.

### Constants and constructors

- `harnessDigest = ""`: the `scriptDigest` recorded for calls the harness
  itself issues (bootstrap and recovery author calls), which belong to no
  authored script.
- `make(link, scriptDigest, ordinal, entryDigest): CallKey`: builds a call
  key from its four components.

## `Outcome`

The trampoline outcomes a link can end with.

### Models

- `ParkCode`: `"approval" | "event" | "timer" | "quota" | "plugin"`. What a
  parked lineage is waiting for.
- `ParkReason`: `{ code: ParkCode, message: string }`. A park's typed code
  plus the prose a reader needs to act on it.
- `Done`: tagged struct `{ value: Schema.Json }`. The chain completed,
  carrying its result value.
- `To`: tagged struct `{ script: Script.Script }`. The link hands off to a
  successor script; the trampoline's one bounce.
- `Park`: tagged struct `{ reason: ParkReason }`. The lineage suspends.
- `Outcome`: the union `Done | To | Park`.
- `Terminal = Done | Park`: a chain-ending outcome. Parked lineages stop
  (wake is out of the slice's scope) and completed lineages return their
  value.

### Constructors

- `done(value): Done`: completes the chain with a value. `undefined`
  becomes `null`, the one JSON representation of "no value".
- `to(script): To`: continues the chain with a successor script. The digest
  is RE-DERIVED from the text and the caller's is discarded: a script may
  choose the text it hands on, never the replay identity that text is keyed
  by.
- `park(code: ParkCode, message = ""): Park`: suspends the lineage with a
  typed waiting reason.

## `Observation`

Typed, journaled gate observations. A failed gate is never a harness crash:
it is recorded in the journal and projected into the next authored link's
context.

### Models

- `Kind`: `"shape" | "fuel" | "catalog" | "call_failed" | "script_failed" |
  "denied"`. Which gate produced the observation, or which stage failed.
- `Observation`: `{ kind: Kind, message: string }`.

### Constructors and projections

- `make(kind, message): Observation`: builds an observation from its kind
  and message.
- `render(observation): string`: renders an observation as one context line
  for the next author call, `[kind] message`.

## `Author`

The author seat: the one thing the chain needs from a model. The seat is
mocked at this boundary, not at the provider wire.

### Errors

- `AuthorError extends Schema.TaggedError`: tag `/chain/AuthorError`, fields
  `code: "author_unavailable" | "exhausted"`, `message: string`, and
  optional `cause: string`. The cause carries the underlying typed condition
  when one exists (a model failure code such as `rate_limited` or
  `context_overflow`, a permission tag, or a stop reason such as `length`),
  so callers branch on it rather than parsing prose.

### Models

- `Input`: `{ prefix: string, context: ReadonlyArray<string> }`. What the
  harness hands the seat: the stable fixed prefix and the context the
  previous link's code built, nothing else.

### Services

- `Service`: `{ author(input: Input): Effect<string, AuthorError> }`. The
  seat's one operation: turn an author input into the raw model output the
  chain extracts a script from.
- `Author extends Context.Service`: the author seat service tag, key
  `/chain/Author`.

### Constructors and layers

- `contextOf(payload: unknown): ReadonlyArray<string>`: normalizes an author
  call's payload into its context lines. Scripts call the author entry with
  `{ context: [...] }`; anything else normalizes to no context, so a script
  passing garbage stays a journaled observation, never a crash.
  Context elements use string coercion. If coercion fails, they use JSON
  text, or `[unprintable context]` if serialization also fails.
- `make(implementation: Service): Service`: builds a seat from an
  implementation.
- `makeNoop(overrides?: Partial<Service>): Service`: a seat whose every
  operation fails as unavailable, with per-operation overrides.
- `layerNoop(overrides?): Layer.Layer<Author>`: the unavailable seat as a
  layer.
- `layerFn(f: (input: Input) => string): Layer.Layer<Author>`: a reactive
  mock. The test supplies the function from input to raw model output and
  can capture the inputs it saw.
- `layerMock(outputs: ReadonlyArray<string>): Layer.Layer<Author>`: a
  scripted mock. Pops canned raw outputs in order and fails with `exhausted`
  when asked for more than it holds.

## `AuthorDeclaration`

The author entry's declaration: the one leaf both the trampoline and the
prompt read, so the model always sees exactly the declaration the call key
pins, and the pure prompt module never imports the runtime.

### Constants

- `authorName = "author"`: the name every script uses to call the author
  seat. Model calls are ordinary calls, one mechanism.
- `authorDescription`: the author entry's one-line description: "Author the
  successor flow script from the context the caller built".
- `authorDigest: string`: the declaration digest pinned into every author
  call key, digested from the canonical name and description.
- `authorCapability = "model:call:author"`: the capability the author seat
  claims. The authorization seam evaluates the model call against this claim
  like any other effect, so an operator's policy must cover it before a
  chain can author at all.

## `ModelAuthor`

The model-backed author seat over `Model.Model` from
[@smthrs/model](https://model.smithers.sh/reference/api/).

### Models

- `Config`: `{ modelId: string, params?: ModelRequest.GenerationParams }`.
  Which model the seat calls, and the generation parameters it calls with.

### Constructors and layers

- `requestFor(config): (input: Author.Input) => ModelRequest.ModelRequest`:
  the pure mapping from an author input to the wire-neutral request. It is
  the mapping `make` itself calls, so you can build a request from an input
  and inspect exactly what the model will see. Degenerate inputs
  collapse to wire-valid shapes: an empty prefix emits no system part at
  all, and an empty context becomes one placeholder line, because providers
  reject empty system blocks and empty user content outright. The request
  declares no tools and `toolChoice: "none"`.
- `make(config): Effect<Author.Service, never, Model.Model>`: builds the
  author seat over the ambient model. A stream that settles with a stop
  reason other than `stop` fails `author_unavailable` with the stop reason
  as `cause`; a settlement with no visible text fails with cause `no_text`;
  other model failures carry their code (or tag, or `unknown`) as `cause`.
- `layer(config): Layer.Layer<Author.Author, never, Model.Model>`: the
  production author layer. `Author` from `Model.Model`.

## `Script`

The authored artifact of one link and the shape gate over raw output.

### Models

- `Script`: `{ text: string, digest: string }`. A link's flow-script text
  paired with the content digest that keys every call it makes.
- `Extraction`: `{ _tag: "Extracted", script: Script } | { _tag: "Rejected",
  reason: string }`. The result of applying the shape gate.

### Constructors and gates

- `make(text: string): Script`: builds a script from its text, digesting it.
  A script's digest is always the digest of its text.
- `extract(raw: string): Extraction`: applies gate 1 to raw author output:
  exactly one fenced `flow` block, whose body becomes the script. Zero
  blocks or more than one is a `Rejected` whose reason the next authoring
  reads.

## `JsonBoundary`

The gate both runner bindings answer to. `ScriptRunner` is the port and its
in-process binding, `QuickJsRunner` is the sealed realm; whatever the two
must agree about byte for byte lives here, so a limit or a refusal sentence
has one home instead of a copy per binding.

### Constants

- `maxJsonDepth = 128`: the deepest nesting a value may carry across the
  boundary.
- `maxJsonSize = 8 * 1024 * 1024`: the boundary's size budget, in units: one
  per node plus one per code unit of every string and key.
- `unserializableOutcome`: the message every binding reports when a script's
  returned value is not JSON.
- `notAnOutcome`: the message every binding reports when a script's returned
  value is JSON but not one of the three outcomes.
- `unserializableInput`: the message every binding rejects a `ctx.call` with
  when its input does not cross the boundary. The QuickJS prelude
  interpolates it, so the in-realm refusal and the host-side one are the
  same sentence by construction.
- `missingCallName`: the message every binding rejects a `ctx.call` with
  when its first argument is not a call name.
- `abortedLink`: the message every queued call settles with once a failed
  handler aborts the link.
- `neverSettles`: the runtime failure every binding reports when the script
  awaited something outside the one supported async door.

### Gates

- `jsonBoundary(value): { _tag: "Ok", value: unknown } | { _tag: "Refused" }`:
  the strict JSON boundary every value crosses: call payloads, handler
  results, and script outcomes. Only `null`, finite numbers, strings,
  booleans, and acyclic plain objects and arrays cross, and what crosses is
  a structural copy. `undefined` is refused everywhere except as the whole
  value, where it becomes `null`; array holes are refused; non-finite
  numbers are refused; `-0` crosses as `0`; a `toJSON` method is never
  called; non-plain prototypes are refused; identity is not preserved.
- `decodeOutcome(value): Option.Option<Outcome.Outcome>`: decodes a script's
  returned value into an outcome. Shared by every runner binding so they
  reject the same shapes and normalize identically. A `To` is rebuilt
  through `Outcome.to`.
- `failureMessage(error: unknown): string`: renders a script failure value
  the way the QuickJS binding renders a dumped realm error, so runtime
  failure messages match across runners.

## `ScriptRunner`

The script interpreter port and its in-process implementation.

### Errors

- `ScriptFailure extends Schema.TaggedError`: tag `/chain/ScriptFailure`,
  fields `code: "compile" | "runtime" | "invalid_outcome" |
  "runner_unavailable"` and `message: string`. A script that did not reach
  an outcome. Inside `Chain.run` it is absorbed into a `script_failed`
  observation; `QuickJsRunner.layer()` carries it when the WebAssembly
  module cannot load.

### Models

- `Request`: `{ name: string, payload: unknown }`. One call a running script
  issued. Ordinals are assigned by the chain's handler, which owns the
  per-link call counter.

### Services

- `Service`: `{ run(script, handler): Effect<Outcome.Outcome, ScriptFailure
  | E> }`. The interpreter's one operation: run a script to an outcome,
  settling each call it issues through the given handler, one at a time.
- `ScriptRunner extends Context.Service`: the script interpreter service
  tag, key `/chain/ScriptRunner`.

### Constructors and layers

- `make(implementation: Service): Service`: builds an interpreter from an
  implementation.
- `makeNoop(overrides?: Partial<Service>): Service`: an interpreter whose
  every operation fails as unavailable, with per-operation overrides.
- `layerNoop(overrides?): Layer.Layer<ScriptRunner>`: the unavailable
  interpreter as a layer.
- `layerInProcess: Layer.Layer<ScriptRunner>`: the in-process runner. The
  script body runs as an async `Function` with `ctx`, `done`, `to`, and
  `park` in scope. It provides NO isolation: the script reaches
  `globalThis`, `process`, and dynamic `import()`. Use it for trusted
  fixtures only; `QuickJsRunner.layer()` is the only sandbox for
  model-authored scripts.

## `QuickJsRunner`

The QuickJS-WASM script runner: the production sealed interpreter. A fresh
realm per link, with limits enforced by the QuickJS runtime itself, and no
host globals. The prelude deletes `Date` and `Math.random`; time and
randomness are the `sys/now` and `sys/random` catalog entries.

### Models

- `Limits`: optional hard limits on a script evaluation.
  - `memoryBytes?: number`: clamped to `memoryFloor`; below it the realm
    cannot bootstrap and QuickJS aborts natively instead of failing typed.
  - `steps?: number`: counts interrupt-handler polls. QuickJS polls roughly
    every few thousand instructions, so the budget is an
    order-of-magnitude bound on work, not an instruction count.
  - `stackBytes?: number`: bounds in-realm recursion, clamped to
    `stackCeiling`. Leaving it unset lets deep recursion exhaust the HOST
    WebAssembly stack instead, so opting out is only ever right for a
    trusted fixture.

### Constants

- `memoryFloor = 256 * 1024`: the smallest memory limit the runner applies.
- `stackCeiling = 256 * 1024`: the largest in-realm stack the runner grants.
  At this size QuickJS raises its own catchable `stack overflow` and
  disposal is clean.
- `hostDefectMarker = "host: "`: the prefix on every `runtime` failure the
  realm's defect boundary produced from a host-side defect (a native
  WebAssembly abort, a host `RangeError`, a bridge bug) rather than from
  the script. A script's own throw never carries it. The boundary also logs
  the defect with its cause at `Warning` level.
- `escapedWrapper = "the script escaped its async wrapper"`: the `runtime`
  failure for a script whose text closed the async wrapper it is spliced
  into. The runner parses the wrapped source compile-only, then compares
  the body function's source with the authored text before the body runs.
  The outcome always passes the in-realm encoder, whatever the script does
  to realm globals such as `Promise.prototype.then`.
- `defaultLimits: Required<Limits>`: `{ memoryBytes: 64 * 1024 * 1024,
  stackBytes: stackCeiling, steps: 10000 }`. Passing an explicit `undefined`
  for any field opts out of that limit.

### Gates

- `decodeCallInput(encoded: string): { payload: unknown, refusal?: string }`:
  applies the host JSON boundary to one call input encoded by the realm.
- `dispatchBridgeCall(next, pending, handler): Effect<void, E>`: dispatches
  one queued realm call or settles its host-side input refusal. A failed
  handler aborts the run; queued calls settle as aborted so the realm holds
  no dangling promises.
- `encodeSettlement(name, settlement): string`: encodes one bridge
  settlement for the realm. Total: a `JSON.stringify` that throws degrades
  to a refusal the script can catch.

### Constructors and layers

- `cachedLoad(load): () => Promise<A>`: caches a successful load
  process-wide while letting a rejected load be retried. Caching the
  rejection would turn one transient failure into a permanently broken
  runner.
- `make(limits?: Limits, load?: () => Promise<QuickJSWASMModule>):
  Effect<ScriptRunner.Service, ScriptRunner.ScriptFailure>`: constructs the
  runner, compiling the WebAssembly module once per process. A failed load
  is a typed, retryable `runner_unavailable`, never a defect, and never
  cached.
- `layer(limits?: Limits): Layer.Layer<ScriptRunner.ScriptRunner,
  ScriptRunner.ScriptFailure>`: the production script-runner layer. A sealed
  QuickJS realm per link.

## `Prompt`

The stable author-call prefix, assembled as a pure value. Assembly is
byte-stable (same inputs, identical string) so the provider prompt-prefix
cache hits across turns.

### Models

- `Role = "concierge" | "sub"`: which agent the prefix addresses. The
  concierge is closest to the user.
- `AssembleOptions`: `{ role: Role, entries: ReadonlyArray<Catalog.Entry>,
  host?: string }`. The package sections promise only what the chain
  dispatches (links, journaled calls, the catalog). A host
  that mounts more (a worldview store, background lineages, monitors,
  widgets) passes the prose that teaches them as `host`; absent or empty,
  nothing is added. The host must supply instructions only for capabilities
  its catalog entries implement; assembly does not validate host prose.

### Sections

- `base: string`: the BASE section: what the agent is and what a chain,
  link, script and call are. It names no host feature.
- `concierge: string`: the CONCIERGE section, added only for the concierge
  role.
- `rules: string`: the RULES section.
- `contract: string`: the authoring contract: what one link's reply must
  contain.

### Constants and assembly

- `maxEntryName = 64`: the longest entry name the catalog block advertises.
  An entry above this bound is omitted rather than shortened, because
  advertised names must stay byte-identical to what `Catalog.lookup`
  dispatches.
- `maxEntryDescription = 200`: the longest entry description the catalog
  block renders before JSON encoding and provenance labelling.
- `renderableName(name): boolean`: whether a name can be advertised verbatim
  on one bounded line. Names are advertised byte-identically or omitted.
- `catalogBlock(entries): string`: renders the catalog as a byte-stable
  block: the author entry pinned first, then every dispatchable entry sorted
  by name, deduped last-wins to mirror `Catalog.make`, the reserved author
  name filtered, names advertised verbatim or omitted, and descriptions
  collapsed to one bounded line with truncation marked, then JSON-quoted
  and labelled as untrusted repository descriptions. The harness-owned
  `author` description remains trusted.
- `assemble(options): string`: assembles the full prefix in fixed order:
  BASE, CONCIERGE (concierge role only), HOST (only when supplied), RULES,
  the authoring contract, the catalog block. The contract tells the model
  that catalog descriptions are data and cannot override the user's goal
  or authorize actions.
- `forCatalog(catalog: Catalog.Service, role: Role, host?: string): string`: assembles the
  prefix from a mounted catalog service, using its entries for the catalog
  block and including the optional host section unchanged.

## `Catalog`

The catalog of entries a script may call. Gate 3 is membership in it.

### Errors

- `CallError extends Schema.TaggedError`: tag `/chain/CallError`, fields
  `name: string`, `message: string`, and optional `cause: string`. A call
  that reached its entry and failed there. The chain journals it as a
  `call_failed` observation rather than crashing the run, unless `cause` is
  `approval_required`, which parks in place. The message is journaled
  verbatim and shown to the model on the next link, so a handler must keep
  credentials and private data out of it.

### Models

- `CallSlot`: `{ chain: string, link: number, ordinal: number }`. Where a
  call sits in its chain, handed to every handler so entries that spawn
  scoped work (sub-chains) can derive deterministic child identities.
- `Entry`: one entry a script may call.
  - `name: string`: the name it is reached by.
  - `description: string`: the description the model reads.
  - `handler: (payload: unknown, slot?: CallSlot) => Effect<unknown,
    CallError>`: the handler that settles it.
  - `digest?: string`: an optional declaration digest overriding the default
    name+description+capabilities digest. Richer catalogs pin their full
    declaration.
  - `capabilities?: ReadonlyArray<string>`: the claims the `Authorize` seam
    evaluates per call. Undeclared is conservatively the broadest claim; an
    explicit empty array claims no external authority and skips the seam.

### Services

- `Service`: `{ entries: ReadonlyArray<Entry>, lookup(name): Entry |
  undefined }`. The visible entries and the lookup gate 3 decides membership
  with.
- `Catalog extends Context.Service`: the catalog service tag, key
  `/chain/Catalog`.

### Constructors and layers

- `entryDigest(entry): string`: the declaration digest that pins an entry's
  identity into every call key that names it. The `digest` override wins
  when non-empty; otherwise the digest of the canonical name, description,
  and capabilities.
- `make(entries): Service`: builds a catalog over the given entries, indexed
  by name, last-wins, over one frozen snapshot that backs BOTH the
  advertised list and the dispatch index.
- `system: ReadonlyArray<Entry>`: the system entries every sealed realm
  relies on: `sys/now` (the current wall-clock time in epoch milliseconds,
  journaled for replay) and `sys/random` (a uniform random number in
  `[0, 1)`, journaled for replay), both with an empty capability list.
- `withSystem(entries): ReadonlyArray<Entry>`: appends the system entries to
  a host's own, LAST, so nothing a host passes can shadow them.
- `makeNoop(): Service`: the empty catalog. Every call misses gate 3.
- `layer(entries): Layer.Layer<Catalog>`: a catalog over the given entries,
  as a layer.
- `layerNoop: Layer.Layer<Catalog>`: the empty catalog as a layer.

## `MemoryEntries`

The memory door: `remember` and `recall` as catalog entries, bound over the
[@smthrs/memory](https://memory.smithers.sh/reference/api/) package's own shipped contract.

### Constructors and layers

- `contractDigest(contract): string`: the digest of a memory entry's shipped
  contract (name, description, effect declaration, and the input/output
  schema shapes), so a memory-package upgrade that changes the contract
  re-keys every call that names it instead of replaying stale results.
- `make(policy: WithMemory.Policy): Effect<ReadonlyArray<Catalog.Entry>,
  MemoryError, MemoryStore.MemoryStore | Recall.Recall>`: builds the two
  memory entries over the ambient store and recall services. Exactly those
  two services are captured, so call-time provisions of anything else are
  never shadowed. Every call runs under `policy`: a bank the policy does not
  name fails with cause `invalid_namespace` before the store runs, an empty
  bank means the policy's own, and each remembered fact records `{ runId:
  chain, nodeId: "link-<link>", iteration: ordinal }` as provenance. An
  invalid policy fails with `invalid_argument`. A malformed payload fails
  with cause `invalid_input` quoting the actual parse failure; a result
  outside the output contract fails with `invalid_output`; a store failure
  carries the memory package's stable error code as the call's `cause`.
- `layer(policy: WithMemory.Policy): Layer.Layer<Catalog.Catalog,
  MemoryError, MemoryStore.MemoryStore | Recall.Recall>`: the memory entries
  under `policy` as a whole catalog of their own, composed with the system
  entries.

Hosts that also mount the memory flows through the registry must bind them
there OR here, not both: a catalog holding two `remember` declarations
discloses one and runs the other, and journals written under the registry's
digest refuse to resume against this door's digest.

## `RegistryCatalog`

The registry-backed catalog projection over [@smthrs/registry](https://registry.smithers.sh/reference/api/).
Projection, not fusion: the registry stays the owner of discovery, naming,
warnings, and lazy bodies.

### Models

- `Implementation = (payload: unknown) => Effect<unknown, Catalog.CallError>`:
  a host-supplied handler for a module-bodied flow.
- `PromptRunner = (rendered: string, descriptor: Descriptor.FlowDescriptor)
  => Effect<string, Catalog.CallError>`: how a rendered markdown prompt
  executes; the seam a sub-agent seat fills. Without one, markdown flows are
  not projected at all.
- `Options`: how the registry is projected into a catalog.
  - `implementations?: ReadonlyMap<string, Implementation>`: which flows
    have host implementations.
  - `prompt?: PromptRunner`: how markdown prompts execute.
  - `visible?: (descriptor) => boolean`: which flows are visible (default
    the registry's own `visible()`).
  - `entries?: ReadonlyArray<Catalog.Entry>`: extra host entries, composed
    after the projection.

### Constructors and layers

- `declarationDigest(descriptor): string`: re-exported from
  `Descriptor.declarationDigest` in `@smthrs/registry`, which owns
  `FlowDescriptor`. The canonical digest of a descriptor's full declaration:
  every top-level field except `provenance.pack`, with `capabilities` sorted,
  so redeclaring a flow on any of those axes changes what every call key pins.
  It is the same number `@smthrs/harness` folds into a call identity.
- `make(options?): Effect<Catalog.Service, never, Registry.Registry>`:
  builds the catalog service from the ambient registry. Only callable
  descriptors are projected. Precedence when names collide: registry
  projection, then host extras, then the system entries, later wins.
  Binding an implementation for a name the registry does not know is a host
  configuration defect and dies at construction. A markdown call takes
  `{ args: string }` (or a bare string) and re-checks the declaration digest
  at call time, failing with a `CallError` when the registry was refreshed
  under it.
- `layer(options?): Layer.Layer<Catalog.Catalog, never, Registry.Registry>`:
  the registry-backed catalog layer.

## `SubChains`

Sub-agents as an ordinary recursive catalog entry. Recursion is the
primitive.

### Constants

- `agentName = "agent"`: the catalog name a script spawns a sub-agent by.
- `agentDescription`: the agent entry's description, as the model reads it
  in the catalog block: "Run a sub-agent chain to completion and return its
  terminal outcome as data".
- `agentCapability = "proc:spawn:agent"`: the capability the agent entry
  claims. Spawning a sub-agent is a process-spawn-shaped authority hosts
  grant deliberately; the child's own calls are gated individually by the
  same seam.
- `defaultMaxDepth = 4`: the nesting bound a catalog inherits when
  `Options.maxDepth` is unset, counted in derived child segments.

### Models

- `Options`: what the recursive catalog needs.
  - `entries: ReadonlyArray<Catalog.Entry>` (required): entries every chain
    in the tree can call. The agent and system entries are appended.
  - `maxDepth?: number`: maximum nesting depth, counted in derived child
    segments.
  - `maxLinks?: number`, `maxCallsPerLink?: number`, `prefix?: string`:
    per-child budgets and prefix, independent of the parent's.

### Constructors and layers

- `contractDigest(options): string`: the digest of the agent entry's
  behavior contract. Redeclaring the child budgets, prefix, or depth bound
  re-keys every settled spawn.
- `make(options): Effect<Catalog.Service, never, Journal.Journal |
  Author.Author | ScriptRunner.ScriptRunner>`: builds the recursive catalog:
  the given entries plus the `agent` entry (whose handler runs a nested
  chain against this same catalog, so children recurse up to `maxDepth`) and
  the system entries, which nothing can shadow. The services are captured at
  construction: build the catalog over the SAME layers the chain runs on.
  Host entries shadowing the reserved names (`agent`, `author`, `sys/now`,
  `sys/random`) die at construction.
- `layer(options): Layer.Layer<Catalog.Catalog, never, Journal.Journal |
  Author.Author | ScriptRunner.ScriptRunner>`: the recursive catalog layer.

The `agent` entry takes `{ goal, context? }` and runs the child under the
derived id `parent-chain/link.ordinal`. A child's `done` and non-approval
parks settle as data; a child's approval park bubbles as a `CallError` whose
`cause` is `approval_required`; a failing child run dies as a defect so the
parent fails un-settled and resumes at the child's settled prefix.

## `Authorize`

Gate 4's seam: per-call authorization against declared capabilities.

### Errors

- `AuthorizeError extends Schema.TaggedError`: tag `/chain/AuthorizeError`,
  fields `code: "denied" | "approval_required" | "authorize_unavailable"`
  and `message: string`. A refusal from the authorization seam. For catalog
  calls, `denied` and `approval_required` are absorbed (a journaled
  observation, an in-place park); `authorize_unavailable` always propagates.
  For the model seat, `denied` propagates typed.

### Models

- `Request`: `{ name: string, capabilities: ReadonlyArray<string>, slot:
  Catalog.CallSlot }`. What the chain hands the seam: the call's name, the
  capability claims its entry declares (an undeclared entry claims
  everything), and the call slot.

### Services

- `Service`: `{ authorize(request: Request): Effect<void, AuthorizeError> }`.
  The seam's one operation: succeed when the call is allowed, fail with the
  typed refusal otherwise.
- `Authorize extends Context.Service`: the authorization seam service tag,
  key `/chain/Authorize`.

### Constructors and layers

- `make(implementation: Service): Service`: builds a seam from an
  implementation.
- `makeNoop(overrides?: Partial<Service>): Service`: a seam whose every
  operation fails as unavailable, with per-operation overrides.
- `layerNoop(overrides?): Layer.Layer<Authorize>`: the unavailable seam as a
  layer.
- `claimPattern(declared: string):
  Option.Option<Capability.CapabilityPattern>`: parses a declared claim into
  a capability pattern over [@smthrs/capability](https://capability.smithers.sh/reference/api/). A
  two-component claim with no resource (`fs:read`) claims the whole family,
  as if it ended in `:**`. An unparseable claim is `None`: the seam asks for
  it, never passes it.
- `layerRules(rules: ReadonlyArray<Permission.Rule>): Layer.Layer<Authorize>`:
  the rules-backed seam. An exact claim is decided by `Permission.evaluate`;
  a set claim (a family action or a resource glob) is decided
  pattern-to-pattern, where a whole-set match is last-match-wins and a
  partial `deny` or `ask` can only raise the verdict. Across one request's
  claims, `deny` beats `ask` beats `allow`. An unmatched or unparseable
  claim asks.
- `layerAllowAll: Layer.Layer<Authorize>`: an allow-everything seam for
  hosts that enforce elsewhere.

## `Steering`

The steering port: outside messages drained at link boundaries.

### Errors

- `SteeringError extends Schema.TaggedError`: tag `/chain/SteeringError`,
  fields `code: "steering_unavailable"` (constructor default) and `message:
  string`. A steering queue that cannot be admitted to or drained.

### Services

- `Service`: the two operations the chain needs.
  - `admit(message: string): Effect<void, SteeringError>`: admits a message
    from outside.
  - `drain(boundary: string): Effect<ReadonlyArray<string>, SteeringError>`:
    takes every queued message. The boundary names the journal position the
    drain feeds (`link/ordinal`), so a durable binding can make the take
    exactly-once by deduping on it.
- `Steering extends Context.Service`: the steering service tag, key
  `/chain/Steering`.

### Constructors and layers

- `make(implementation: Service): Service`: builds a steering port from an
  implementation.
- `makeNoop(overrides?: Partial<Service>): Service`: a steering port whose
  every operation fails as unavailable, with per-operation overrides.
- `layerNoop(overrides?): Layer.Layer<Steering>`: the unavailable steering
  port as a layer.
- `layerMemory(initial?: ReadonlyArray<string>): Layer.Layer<Steering>`: an
  in-memory steering queue. `admit` appends, `drain` takes everything and
  ignores the boundary, accepting the volatile loss window that implies.

Only the root chain drains, and only at the `link/ordinal` boundary of a
live author call. Non-empty drains journal a `SteeringDrained` event;
drained lines reach every subsequent author attempt of the link as
`[steering] <line>` context. For the design behind every entry on this page,
see [The chain contract](/contract/).
