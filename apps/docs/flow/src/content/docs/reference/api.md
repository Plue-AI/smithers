---
title: "API reference"
description: "The complete public surface of @smthrs/flow: flows, actions, durable primitives, step identity, retry policy, and the runtime port, and how the pieces fit together."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/api.md"
---

The flow authoring model: typed flow and action definitions, durable primitives, step identity, retry policy, and the runtime port they execute against. The whole package bundles for the browser; durability comes from whichever runtime you provide.

An `Action` carries an implementation, attached separately as a layer. A `Flow` carries a pure `body`, authored directly or lowered from a typed `prompt`, and `Interpreter.layer` drives it.

```ts
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Compile = Action.make("example/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  tier: "sealed"
})

const Build = Flow.make("example/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

const layer = Layer.mergeAll(
  Compile.toLayer(({ target }) => Effect.succeed(`${target}.js`)),
  Interpreter.layer(Build)
).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))
```

## Entry point

| Import         | Source                                                                                                     | Platform |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/flow` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/src/index.ts) | any      |

This page is the public API reference for the flow authoring model: typed flows, recorded actions, durable deferreds, clocks and queues, the system timer and wait point, polling, human tasks, plan-time graph building, the body interpreter, retry policy, step identity, and the runtime port those APIs execute against. It contains no engine implementation: that is [`@smthrs/engine`](https://engine.smithers.sh/reference/api/).

The [export reference](/reference/flow/) lists every exported symbol with its signature, its defaults, and the errors it raises. The sections below say how the pieces fit together. For task-shaped instructions, start from the [guides](/#where-to-go-next).

## `Flow`

`Flow.make(tag, options)` accepts struct payload fields, success and error schemas, an optional `idempotencyKey`, annotations, a `suspendedRetryPolicy`, a `maxRounds` bound for trampoline lineages, and a `deadline` for one execution. Four literals lower into the annotation bag rather than staying options: `description`, `capabilities`, `effects`, the effect envelope from [`@smthrs/plan`](https://plan.smithers.sh/reference/api/#effects), and `modelInvocable`, which says whether a catalog may offer this flow to a model and defaults to `true`. They are literals so a catalog can project a discovered flow's authority from source text without importing the module, and `Graph.build` refuses a composition beneath the flow that reads or writes outside that envelope, loosens its mode, or raises its tier. Declare exactly one of `body` or `prompt`. A prompt declaration lowers to one ordinary action, exposed as `flow.action`; its host supplies the implementation through `flow.action.toLayer`. The typed `flow.prompt` renderer runs inside that implementation, never during planning. Optional `model`, `effort`, `flows`, `system`, and `chat` fields retain host metadata. See [Prompt-backed flows](/guides/use-a-prompt/). `maxRounds` must be a positive safe integer and `deadline` a positive finite duration; `Flow.make` throws a `RangeError` when either is not. The deadline counts from the execution's journaled first start, so a resume after a restart honors the original deadline, and expiry settles the execution with the `DeadlineExceeded` defect whether it was running or parked. A trampoline lineage is one run: every round after a handoff expires at the originator's start plus the originator's deadline, whatever the round itself declares.

The returned definition exposes:

- `execute(payload, { executionId?, discard? })`
- `poll(executionId)`
- `interrupt(executionId)` and `resume(executionId)`
- `executionId(payload)`
- `call(payload)`, `child(payload)`, and `to(payload)` for use inside a body
- `annotate` and `annotateMerge`
- `withRollback`

`Flow.make`, declared `Action.make`, and `Action.makeSystem` accept
`declaredFrom: original` when a wrapper reconstructs a native declaration.
The new declaration retains the original's diagnostic source location, including
an absent location. It still owns its new body, options, and call closures.
The source reference is not stored in key material and changes no digest.

There is no `toLayer` on a flow. A flow carries a body and never a handler, so the seam that registers one is internal and `Interpreter.layer(flow)` is the public way to make a flow executable.

### Execution identity

Identity has three sources, consulted in this order:

1. the `executionId` the caller named on `execute`;
2. the `idempotencyKey` the flow declared, hashed together with the flow tag;
3. the ambient `CurrentExecutionIds` source, whose default `fresh` mints a new cryptographic UUID.

`layerExecutionIds(source)` replaces the third. Install `derived` when equal payloads deliberately name one piece of work; callers that name an `executionId` and flows that declare an `idempotencyKey` are unaffected, because both are decided before the source is consulted.

`ExecutionIdRequired` is a defect, not a typed failure. The opt-in derived source raises it when the payload has no canonical form, for example a non-finite number, a lone surrogate, or a cycle. `Flow.executionId(payload)` likewise dies when the payload fails the flow's own payload schema, where `Flow.execute` fails with a typed `Schema.SchemaError` instead. Precompute an id with `executionId` only for a payload you have already validated.

### Results

A flow settles with one of three results:

| Result      | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `Complete`  | the flow finished, carrying an `Exit`                                    |
| `Suspended` | the flow parked on a durable wait and will be re-driven                  |
| `Handoff`   | the round ended by handing off to the next round of a trampoline lineage |

`Result` is that union, `ResultEncoded` is its codec, `isResult` is the guard, `intoResult` turns a suspension interrupt into `Suspended`, and `wrapActionResult` holds a flow suspension until the sibling actions already running settle or suspend. `MaxRoundsExceeded` is the defect a lineage dies with when it opens a round past its `maxRounds` budget; read it off the `Complete` result, never off `execute`'s error channel. `DeadlineExceeded` is the defect an execution dies with when its `deadline` elapses, read the same way.

`Outcome` is the vocabulary a trampoline body settles a round with: `Done(value)` ends the lineage, `To(payload)` opens the next round, and `Park` suspends it. `isOutcome` is its guard.

Scope helpers are `scope`, `provideScope`, `addFinalizer`, `withRollback`, and `suspend`. Policy references are `CaptureDefects` and `SuspendOnFailure`. `Execution` is a type-level marker that ties a service to a flow tag; it carries no runtime value and identifies nothing at run time.

## `Action`

`Action.make(options)` defines a named effect with success and error schemas, a `tier`, idempotency identity, metadata, annotations, an optional `retryPolicy`, and an optional `interruptRetryPolicy`. `Action.make(tag, options)` is the declared form: pure data whose implementation attaches later through `toLayer`. `Action.makeSystem` is the declared form that mints no requirement, which is how `Sleep`, `WaitFor`, `HumanTask`, and `Poll` ship implementations with the engine instead of pushing a layer obligation onto their callers.

The declared form takes the same two literals `Flow.make` does, lowered into the annotation bag by the same code: `capabilities`, the capability ceiling the dispatch runs under, and `effects`, the effect envelope from [`@smthrs/plan`](https://plan.smithers.sh/reference/api/#effects). They are literals so a catalog can project a declaration's authority from source text without importing the module. An action is a leaf, so its envelope encloses nothing: `Graph.build` checks it against the envelope the calling flow granted, and records `capability_outside_grant` for every capability the caller does not hold.

Omitting `capabilities` inherits the caller's authority. Declaring `capabilities: []`
denies every guarded host operation. Each declaration intersects with every
ancestor and the ambient host ceiling; `*` permits any capability within those
limits. Use full patterns such as `fs:write:**` or `net:get:https://example.com/**`;
unrecognized patterns grant nothing. Capability declarations constrain the
guarded host services an action resolves: `FileSystem`, `ChildProcessSpawner`,
`HttpClient`, and `Jj`. They do not constrain arbitrary JavaScript, such as a
direct `node:fs` import.

Actions, inline calls, child runs, and handoffs keep these ceilings. Admission
records authority for replay and recovery; an execution ID retains its first
admission ceiling, and resuming from a broader host cannot widen it. A caller
joins, polls, or resumes an existing execution ID only when its ceiling covers
the recorded one; otherwise `Flow.execute` fails with typed `ExecutionIdentityConflict` on field
`capabilities`. Existing
durable runs without recorded authority refuse further dispatch: re-keying an
old action could repeat a completed effect. Inspect existing effects before
starting replacement work with a new execution ID.
Graph diagnostics are advisory conservative checks of glob coverage; execution
checks the exact intersection with the kernel matcher. Cross-run cache keys include
this effective authority. Remote execution and resume carry the ceiling to the
serving engine, which intersects it with its own authority and never widens it.

`Flow.capabilityCeilings(annotations)` reads explicitly declared groups, preserving
omission. `Flow.parseCapabilityCeilings(groups)` parses them, dropping invalid
patterns. `Flow.attenuateCapabilities(groups)(effect)` applies the parsed patterns
to the shared kernel authority without widening it.

| Export                                                                           | Purpose                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tier`                                                                           | `sealed`, `compensable`, or `irreversible`                                                                                                                                                                                                                                                   |
| `InfraInterrupt`                                                                 | marker an action adapter explicitly fails with for an infrastructure event it wants `interruptRetryPolicy` to retry; shipped engines do not synthesize it from fiber interruption                                                                                                            |
| `InfraInterruptRetriesExhausted`                                                 | the typed identity an exhausted `interruptRetryPolicy` dies with, carrying the action, the attempts, and the final interrupt                                                                                                                                                                 |
| `IrreversibleRetryRequiresIdempotencyKey`                                        | an irreversible action retried without a declared key                                                                                                                                                                                                                                        |
| `ConcurrentKeylessDispatch`                                                      | two live dispatches of one keyless allocation scope                                                                                                                                                                                                                                          |
| `UncanonicalIdempotencyKey`                                                      | a caller-declared object-form `idempotencyKey` carrying material canonical serialization rejects, such as a `Date`, an `undefined`, a class instance, or a `Redacted`. It surfaces as a typed, non-retryable recorded completion naming the offending path, never as an untyped fiber defect |
| `retry(effect, options)`                                                         | Effect retry with durable attempt context                                                                                                                                                                                                                                                    |
| `raceAll(name, actions)`                                                         | a durable race for the first success, persisting one winner; fails only when every action fails                                                                                                                                                                                              |
| `idempotencyKey(name, options?)`                                                 | the run-local invocation key                                                                                                                                                                                                                                                                 |
| `DispatchSite`                                                                   | the structural node address the interpreter scopes one dispatch to                                                                                                                                                                                                                           |
| `CurrentCacheEnvironment`                                                        | the complete `{ layers, capabilities }` a sealed cache key is computed under. It is hashed separately from caller-owned identity, and when it is absent the engine scopes the key to the current execution                                                                                   |
| `CachePolicy` and `withCache`                                                    | a declaration-level annotation bounding the age of a reusable sealed result                                                                                                                                                                                                                  |
| `FileInput`, `FileBoundary`, `BoundaryMode`, `Filegroup`, `Glob`, `TreeArtifact` | the file-boundary vocabulary an action declares its reads and writes with                                                                                                                                                                                                                    |

`CurrentAttempt` is the one-based durable attempt. `CurrentOrdinal` carries an `OrdinalSlot` (`{ values, cursors }`) rather than a number: the engine allocates each dispatch's ordinal under its declaration-identity scope and pins it per scope by dispatch position, so every attempt of one `Action.retry` sequence reuses its own action's ordinals even when the block dispatches several distinct actions or one declaration several times. Nested blocks share the pinned `values` with the enclosing block but own a private `cursors` view seeded at block entry and merged back on exit, so a concurrent sibling block's attempt boundary never rewinds another block's mid-flight cursor. Concurrent dispatch of one allocation scope is refused with `ConcurrentKeylessDispatch` for every ordinal-keyed action, keyless or keyed at a non-sealed tier, because arrival order would otherwise assign the ordinals; only a sealed action with an `idempotencyKey`, which is a pure cache key, may overlap on the same declared key, and distinct keys are distinct scopes that overlap freely.

An action is itself an `Effect`; `action.execute` bypasses engine recording and should normally be used only by engine implementations.

Sealed idempotency identity has two forms. A string is namespaced by the action name and the declared schemas. An object is caller-owned canonical JSON and stays stable across action renames. The engine separately adds the complete cache environment and any typed `fileBoundary` (or historical boundary `metadata`), so caller identity cannot override runtime facts.

## Durable primitives

| Namespace         | Public surface                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DurableDeferred` | `make`, `await`, `into`, `raceAll`, branded token parsing and creation, and `done`, `succeed`, `fail`, `failCause` completion |
| `DurableClock`    | `make({ name, duration })` and `sleep({ name, duration, inMemoryThreshold? })`                                                |
| `DurableQueue`    | `make`, `process`, `makeWorker`, and `worker` over Effect's `PersistedQueue`                                                  |
| `Deadline`        | `start`, `within`, and `bound`: the run deadline `Flow.make` applies, for a host that bounds a run by an approved deadline    |

A deferred token encodes the flow name, the execution id, and the deferred name, so another process can complete the correct durable address. `TokenInvalid` is the typed failure every completion surface returns for a token that does not parse or that names a different deferred than the one it was submitted through. Completing a deferred is first-writer-wins: the first recorded exit is the one every later read replays.

`DurableQueue.process` offers a payload, attaches a token, and suspends until a worker records the handler's exit against it. Its `retrySchedule` option bounds how a failing offer is retried; the default retries with exponential backoff, capped at one minute, and never gives up before the call dies. `DurableQueue.worker` and `makeWorker` take a `concurrency` that must be a positive safe integer.

## `Graph`

`Graph.build(flowOrNode, payload, options)` turns a body, or a bare node, into the plan-time graph the interpreter drives and the planner compiles. Building is a pure function of the declarations and the payload, so the whole shape of a round is known before its first action runs.

| Export                                                                     | Purpose                                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `build`                                                                    | builds the graph, flattening inline flow calls and expanding combinators into keyed nodes                                                 |
| `nodes`, `edges`, `drafts`, `diagnostics`                                  | read what the build produced                                                                                                              |
| `Graph`, `GraphNode`, `Edge`, `EdgeReason`, `LayerRequest`, `BuildOptions` | the models                                                                                                                                |
| `maximumGraphDepth`                                                        | the nesting bound the build refuses past, so an unrolling composition reads the same number                                               |
| `evaluatedFrom`                                                            | states that a file about to be evaluated holds bytes read from another, so the declarations inside it report the entry an author can open |

A graph carrying a FATAL diagnostic is inspectable but deliberately not compilable, so a body whose topology is incomplete is reported rather than half-driven. Building refuses a nesting depth past its bound and refuses a duplicate node id, because a node id is durable dispatch identity and two nodes answering to one address would let a later settlement overwrite an earlier one.

Building also enforces effect authority. A flow that declared an `effects` envelope grants it to everything spliced beneath it, and every call and every action that declares one of its own is checked against the enclosing grant: a read or write the envelope does not cover is `effect_outside_envelope`, an `expected` declaration inside a `hermetic` envelope is `effect_mode_widening`, and a tier that rose rather than narrowed is `effect_tier_widening`. A refused declaration does not become the envelope for what it encloses, so one over-claim cannot widen its siblings. A called flow requiring a capability the caller does not hold is the one ADVISORY refusal, `capability_outside_grant`: the call runs with the capability dropped, which is the safe direction, so `drafts` still hands the drafts over while `diagnostics` reports it. Every check runs for `.call()`, `.child()`, and `.to()` alike: a boundary gives a callee its own execution, not its own authority.

A call node's key material folds in the declared schemas as their JSON Schema documents, so a change to what a callee accepts or produces re-keys the call. That identity is JSON-Schema-shaped, and the limit is worth stating: two schemas whose decoders disagree can serialize to the same document, so changing only a codec's behaviour does NOT re-key the call, and a result recorded under the old codec is replayed under the new one. Effect codecs are not serializable, so nothing can close this automatically. An author who changes a transformation and needs the call re-keyed renames the declaration.

## `Interpreter`

`Interpreter.layer(flow)` registers a flow with the runtime and installs the handler that drives its body. `Interpreter.interpret(flowOrNode, payload, options)` is that drive on its own, for a body you want to run without registering it.

Explicit `Node.andThen(next)` waits for upstream success before starting any
part of `next`, including actions inside an `all`, `map`, branch, catch, nested
sequence, or inline flow. Upstream failure or interruption does not activate
that subtree. `Graph.build` carries the same prerequisite into every descendant
draft. `Node.bindPlanned` is different: it builds data dependencies, so members
that do not use the reference may run concurrently with its producer.

The subtree-barrier correction changes compiled identities for affected nested
sequences. Newly plan and approve changed work; this is not an unfinished-run
migration or undo of effects an older runtime already started too early. It
also does not make the interpreter consume the compiled scheduler's filesystem
conflict edges, priorities or admission limits; that execution-path integration
remains a separate release requirement.

| Export             | Purpose                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `layer`            | registers a flow and installs its body handler                                                                |
| `interpret`        | builds and walks the graph, returning an `Interpretation`                                                     |
| `Interpretation`   | the root value, every node that settled, the typed failures a catch recovered, and the nodes a branch skipped |
| `childExecutionId` | the deterministic id a `.child()` boundary opens its child execution under                                    |
| `InterpreterError` | the graph refusals, each with a stable `code`                                                                 |

`InterpreterError` codes name what the run cannot recover from on its own: `incomplete_graph` for topology the build reported, `duplicate_node_id` for two nodes answering to one dispatch address, `unresolved_action` for an action with no implementation wired up, `unresolved_reference` for a payload reading a node this graph does not hold, `unsupported_call` for a call whose declaration did not survive serialization, and `missing_operation` for a deferred function that did not either.

The walk is demand-driven from the root rather than a sweep over the node list, because dependency order puts both branch arms before the branch that chooses between them, and executing an arm to discover it was not taken is exactly what static topology exists to avoid.

## `Sleep`

`Sleep.action` is the declared `system/sleep` step: a wait that is a keyed plan node rather than a second execution mechanism. Call it in a body wherever a round has to wait for time to pass, and provide `Sleep.layer` beside the other implementation layers.

```ts
Sleep.action.call({ millis: 60_000 })
```

A payload names exactly one deadline: a relative `millis`, or an absolute `until` in epoch milliseconds. `SleepRequestInvalid` is the typed refusal, with three codes:

| Code                 | Meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_deadline`   | the payload named neither `millis` nor `until`                                                                                         |
| `ambiguous_deadline` | it named both, which are the same fact stated two ways                                                                                 |
| `invalid_deadline`   | it named a number that is not a length of time: a non-finite or negative `millis`, a non-finite `until`, or an addition that overflows |

Two waits of the same length are two waits: each call is its own node with its own identity, so `sleep` followed by `sleep` waits twice. A deadline that has already passed settles the node instead of parking it, because a run that resumes after its own deadline has to make progress.

## `WaitFor`

`WaitFor.action` is the declared `system/wait-for` step: a rendezvous with something outside the run. A payload names the wait point by `name`, relative to the running execution, or by an absolute `token`. `WaitFor.deferred(name)` is the resolver's half, the value to hand `DurableDeferred.tokenFromExecutionId` and `DurableDeferred.succeed`.

```ts
const gate = WaitFor.deferred("approval")
const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
yield * DurableDeferred.succeed(gate, { token, value: { approved: true } })
```

`WaitForRequestInvalid` carries four codes: `missing_target` and `ambiguous_target` for a payload naming neither or both, `malformed_token` for a token that does not parse, and `foreign_execution` for a token addressed to another flow or another execution. A deferred result is recorded against the flow and execution that own it, so awaiting a foreign token would park forever while the value it names was recorded elsewhere.

## `Poll`

`Poll.make(tag, options)` declares a durable poller and returns an ordinary flow. Its body is one attempt: run `check`, and either settle the lineage with the check's own output or sleep for this attempt's delay and hand off to the next round with the attempt counter raised. Each attempt is therefore a durable round with its own keyed plan nodes, a check that already ran replays from its recorded outcome, and the wait between attempts is a durable timer that survives a process restart.

| Option                  | Meaning                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`                 | the author's payload fields. `attempt` is added to them and defaults to one                                                                                   |
| `result`                | the schema the poll settles with                                                                                                                              |
| `check`                 | a body fragment returning `{ satisfied, output }`. It may not fail; state what a failure means with `Node.catch` inside the fragment                          |
| `intervalMs`, `backoff` | the wait before the next attempt: `fixed`, `linear` (interval multiplied by attempt), or `exponential` (interval multiplied by 2 raised to attempt minus one) |
| `maxAttempts`           | the attempt bound. It is also the flow's `maxRounds`, so a lineage that opened another round is refused by the engine                                         |
| `onTimeout`             | `fail` fails `PollExhausted` at the bound; `return-last` answers with the last check output                                                                   |

`delayMillis` is the exported schedule function, `CheckResult(result)` is the success schema a check action declares, `Failure` is the union a poll's rounds can fail with, and `Poll.layer` implements the `system/poll-exhausted` step. `PollExhausted` carries the stable code `poll_exhausted`.

`Poll.make` refuses a schedule no clock can keep, with a `RangeError` naming the option that is wrong: an `intervalMs` that is not finite or is negative becomes a `system/sleep` node whose timer never fires, and a `maxAttempts` below one whole attempt reaches `Flow.make` as a complaint about `maxRounds`, an option the author never wrote. The check is on the schedule rather than on the interval alone, because `delayMillis` multiplies the interval by the backoff: `{ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" }` states three finite options and still asks for a wait of `Infinity`. The last wait a poll can arm, the one before the final attempt, has to be a length too, since the attempt at the budget gives up rather than sleeps.

### Bounding a check that can hang

A per-attempt time limit on the check is deliberately not a `Poll.make` option. A plan node's duration is not something the body around it can bound, so the bound goes in the check's own implementation, where `DurableDeferred.raceAll` races the work against a durable clock:

```ts
const Status = Action.make("deploy/status", {
  payload: { id: Schema.String, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

const statusLayer = Status.toLayer(({ attempt, id }) =>
  DurableDeferred.raceAll({
    name: `deploy/status#${attempt}`,
    success: Poll.CheckResult(Schema.String),
    error: Schema.Never,
    effects: [
      readDeployment(id),
      Effect.as(
        DurableClock.sleep({
          name: `deploy/status#${attempt}`,
          duration: Duration.seconds(30),
          inMemoryThreshold: Duration.zero
        }),
        { satisfied: false, output: "unknown" }
      )
    ]
  })
)
```

Three things make this the durable bound rather than a wall-clock one. The race records its winner under a name that carries the attempt, so a re-driven round reads the recorded outcome instead of racing again. The clock parks the execution rather than holding a fiber, so the bound outlives the process waiting on it. And the clock's branch answers `satisfied: false`, so a check that ran out of time costs the poll one attempt and nothing else: the round takes its declared interval and hands off to the next attempt exactly as an unsatisfied check does.

## `Fault`

One typed fault for every failure. The owner of an error union registers each code with a class, so a failure crosses every seam as `{ class, tag }` instead of prose.

| Export                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Class`                        | `user`, `wait`, `infra`, `dependency`, `bug` (the wire registry), plus `factory` (the factory's own work did not converge; a replan may fix it) and `policy` (a cap stopped it).                                                                                                                                                                                                                 |
| `Fault`                        | `{ class, tag }`. `tag` is `<_tag>/<code>`, or `<_tag>` for an error without a code.                                                                                                                                                                                                                                                                                                             |
| `register(tag, table, field?)` | One class for the whole tag, or one per value of `field` (default `code`). Owners write `satisfies Fault.Rows<Code>`, so a new code without a class does not compile. A value the table does not name is `bug`. The registry is one per process (shared by the ESM and CommonJS builds); registering a tag again with the same rows is a no-op, and with different rows throws.                  |
| `of(error)`                    | Reads the error and up to 15 `cause` links beneath it and answers the innermost registered tag, because a wrapper names where a failure surfaced and its cause names why. Anything unregistered is `{ class: "bug", tag: "unregistered" }`.                                                                                                                                                      |
| `respond(fault, state)`        | The one response ladder, exhaustive over the classes: `wait` backs up, then parks while `parksLeft` allows, `dependency` backs up then retries (3 attempts), `infra` retries then parks, `factory` replans twice, continues once as `very_hard`, then asks for `help`, a declined request (`coding/Error/declined`) closes, any other `user` fault asks for `help`, and `policy` and `bug` stop. |
| `registered()`                 | Every registered tag; the sweep tests read it.                                                                                                                                                                                                                                                                                                                                                   |

A failed agent run, and a launch the executor refused, journal the fault on `control.run.failed` beside `cause`; the gateway carries it to the worker as `failureFault` and `failureTag`, and drops it once the run resumes.

## `Stall`

`Stall` is the stall breaker round loops share. `Stall.policy({ rounds, on })` resolves `rounds` (at least two) and `on` (`stop`, the default, `park`, or `escalate`). `Stall.observe(policy, state, observation)` folds one round into the carried `State` and returns the next state with a `Stalled` verdict once one signal held for `rounds` rounds in a row. An observation reports any of `tree` (a tree fingerprint), `checks` (failing check ids, order ignored, empty not compared), and `output` (compared by the SHA-256 of its canonical JSON; a value with no canonical form is not compared). `Stall.initial` is the state before the first round. `State`, `Policy` and `Stalled` are schemas, so a trampoline carries the state in its payload and replay reads the same verdict. The loop decides what `on` means; `@smthrs/patterns` loops and the coding correction flow use it.

## `HumanTask`

`HumanTask.action` is the declared `system/human-task` step: a typed question with re-asking and a deadline, built on `WaitFor`'s wait points and `DurableClock`.

| Payload field | Meaning                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`        | addresses the question. Two calls naming one question in one execution await one answer                      |
| `kind`        | `ask` (prose), `confirm` (a boolean), `select` (one of `options`), `json` (a value `schema` accepts)         |
| `prompt`      | what the person is asked                                                                                     |
| `options`     | the choices a `select` offers                                                                                |
| `schema`      | a JSON Schema in the bounded subset, valid only with `kind: "json"`                                          |
| `maxAttempts` | how many answers may be refused before the task fails. Defaults to `defaultMaxAttempts` (10)                 |
| `timeoutMs`   | how long the question stays open, across every attempt. A finite number of milliseconds that is not negative |

The bounded schema subset is `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `enum`, `properties`, `required`, `items`, `nullable`, `description`, and `title`. `enum` members may be any JSON value, including objects and arrays, and membership is compared structurally rather than by reference. A schema supplied with any kind other than `json` is refused as `request_invalid`, because nothing would check it.

Each attempt is its own durable wait point, `WaitFor/<name>#<attempt>`, so an answer is recorded through the ordinary durable deferred path and a refused answer stays recorded under the attempt that refused it. The refusal itself is recorded as a sealed step named `HumanTask/<name>#<attempt>/rejected`, carrying the task, the attempt, and the reason, so a reader of the journal sees why an answer was sent back. The run parks under the `approval` waiting reason carrying the current attempt's token, and `HumanTask.answer({ token, value })` records an answer against it. A re-driven round replays every answer it already has and parks on the first attempt that has none, so a restart between the park and the answer resumes on the same token.

The park also publishes `WaitingAnnotation.request` as JSON text containing
`task: "human"`, `name`, `kind`, `prompt`, `attempt`, `maxAttempts`, and any
declared `options` or `schema`. It describes the question without including an
answer. Durable readers use it to render pending questions, including waits
inside child executions; routing still uses the wait token.

`HumanTaskFailed` carries `code`, `task`, `attempts`, the `rejections` it collected, and a message. `request_invalid` refuses an unanswerable question before anyone is asked: a `select` with no options, an attempt budget below one or above the documented ceiling, a `timeoutMs` that is not a length of time, a schema outside the subset, a schema past the depth or node bound, or a schema supplied with the wrong kind. `rejected` means the budget was spent on answers the task refused. `timeout` means the deadline passed with the question open.

Sizes are bounded so one question cannot grow a durable record without limit. The attempt budget is refused above `maxAttemptBudget`, the schema is refused past `maxSchemaDepth` levels or `maxSchemaNodes` nodes, an answer is refused past `maxAnswerNodes` visited values, a value echoed into a rejection message is truncated at `maxDiagnosticChars` with an explicit marker, and the retained `rejections` array stops at `maxRetainedRejectionChars` and records how many further rejections it omitted. The per-attempt journal step still records its own full reason: only the accumulated array is capped, because a refused answer stays recorded so the record shows what was actually said.

`timeoutMs` races the answer against one `DurableClock` per task through `DurableDeferred.raceAll`. The race parks and settles on whichever arrives first, on both hosts: the in-process engine and the SQLite engine store each re-enter a parked race on the next drive, re-registering the raced deferreds against their persisted completions. A parked dispatch keeps its attempt row and its attempt number, so a question that waits out a person costs nothing against the action's retry budget.

`validate(value, request)` returns the reason an answer was refused, or `undefined`; run it in the interface so a typo is refused while the person is still looking at it. `validateSchema(schema)` checks that a schema stays inside the subset at every depth. `decode(schema)` gives the `Schema.Json` answer the caller's own type; the two schema descriptions must agree, and a disagreement surfaces as a defect rather than as a failure a body could catch.

## `RetryPolicy`

A `RetryPolicy` is a plain value, so the next retry delay is derived from a persisted attempt count instead of fiber-local `Schedule` state. `nextDelay` mirrors Temporal's `ComputeNextDelay`, and `decide` is the engine's single retry decision point.

`RetryPolicy.make` validates its bounds and throws a `RangeError` naming the field that is wrong: `initialMs` finite and greater than zero, `factor` finite and positive, `maxMs` finite and not below `initialMs`, `maxAttempts` a safe integer of at least one, `expirationMs` finite and positive, and `jitterRatio` finite and within zero and one inclusive. `initialMs: 0` is refused rather than read as an immediate retry, because every computed delay would be zero and the policy would give up on its first failure; use `initialMs: 1` for a near-immediate retry. It also copies and freezes the `nonRetryable` array, so a later mutation of the caller's array cannot change what a parked policy means.

`nextDelay` is total even for a policy that never went through `make`, which is what a policy decoded from a persisted row is: a non-finite attempt, elapsed time, bound, or computed delay answers `None` rather than handing the engine a negative or `NaN` duration to sleep for.

`decide` classifies non-retryable errors here and nowhere else, by the policy's declared tags and by `defaultNonRetryable`, which lists the integrity verdicts that must reach the driver unretried under every policy. Exhaustion and expiration preserve the final declared failure. The older `RetryPolicyExpired` and `RetryAttemptsExhausted` schemas remain available for interpreting historical outcomes.

## `StepIdentity`

| Export               | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `AllocationIdentity` | an action name refined by a declared string key        |
| `allocationScope`    | the scope an ordinal is allocated from                 |
| `invocationKey`      | the run-local ordinal step key                         |
| `DispatchSite`       | the structural graph address one dispatch is scoped to |

## `FlowRuntime`

`FlowRuntime` is the service tag the authoring APIs are written against: registration, execution, polling, safe and unsafe interruption, resume, action execution, deferred lookup and completion, and clock scheduling. This package declares the port and depends on nothing that implements it, so the dependency direction is `@smthrs/flow` then `@smthrs/engine` then the durable stores, with no cycle and no type-only escape hatch back.

| Export                  | Purpose                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowRuntime`           | the port itself                                                                                                                                                                                             |
| `FlowInstance`          | one execution's mutable frontier state: execution id, flow, scope, suspension and interruption flags, the waiting annotation, and action coordination                                                       |
| `annotateWaiting`       | declares how the flow is about to wait, so a durable driver parks the run under that reason and token                                                                                                       |
| `WaitingAnnotation`     | `{ reason, wakeAt?, token?, request? }`; `request` is JSON text describing the wait, not a routing key                                                                                                      |
| `FlowCycleDetected`     | executing a flow would close a cycle in the persisted parent chain                                                                                                                                          |
| `FlowExecutionNotFound` | `poll` was given an execution id the runtime does not hold; `resume` has no error channel and ignores an unknown id                                                                                         |
| `CancelRequestFailed`   | a durable runtime could not record a cancellation, with `cancel_request_failed` for a storage failure and `unsafe_interrupt_unsupported` for `interruptUnsafe`, which the durable engine does not implement |

`runtime.resume(flow, executionId)` and `MyFlow.resume(executionId)` are
explicit resumes. `{ poll: true }` drives background polling without recovery
consent; local and remote dispatch preserve this choice. `{ delegated: true }`
records a local background wake without recovery consent and retains the
coordinator wake signal. Remote placement refuses delegated resumes.

## See also

- [Flows and actions](/concepts/flows-and-actions/), [bodies are plans](/concepts/bodies-and-plans/), [execution identity](/concepts/execution-identity/), [suspension and replay](/concepts/suspension-and-replay/), [trampoline rounds](/concepts/trampoline-rounds/), and [the runtime port](/concepts/the-runtime-port/): the model behind this surface.
- [Export reference](/reference/flow/): every symbol, with types and defaults read from source.
- [Troubleshooting](/troubleshooting/): the same failures, sorted by symptom.
- [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) implements the `FlowRuntime` port, and [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) makes it durable.
- [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) owns the `Node` and `FileSet` vocabulary a body is written in.

## Explicit execution and registration

`flow.start(payload)` starts fresh work and returns its execution id, even for
identical payloads or a declaration with an idempotency key.
`flow.ensure(payload, { key })` starts or joins explicitly keyed work and returns
its id. Both return after admission and scheduling, before the child settles,
including when called inside an action. The child continues after that action
or parent round finishes. `execute(payload, { discard: true })` has the same
return timing. Keep the engine scope open while it runs; the memory engine
retains work only for that scope, and the durable engine records work for
recovery after a host restart. Use `poll(id)` to observe it, or
`execute(payload, { executionId: id })` to await it. The default unkeyed `execute` now starts fresh work. To reattach after a crash,
retain and pass the execution id, declare an idempotency key, or deliberately
install `Flow.layerExecutionIds(Flow.derived)`. Existing stored key encodings are
unchanged; the library does not rewrite historical runs.

`Interpreter.layerWithImplementations(flow, implementationLayer)` builds the
interpreter and all action implementations against one isolated registry. Its
types require every action named by the flow; runtime graph preflight rejects
missing handlers before dispatch. Conflicting same-tag registrations fail during
layer construction. Intentional scoped substitution uses
`action.toLayer(handler, { override: true })`.

### Execution identity conflicts

`Flow.execute` fails with `FlowRuntime.ExecutionIdentityConflict` when an id
conflicts with the recorded identity. The value is also exported as
`FlowEngine.ExecutionIdentityConflict` and carries the existing execution
`status`. A caller may choose a new id only for `completed`, `failed`, or
`cancelled` executions. A live or suspended execution must retain its id to
avoid starting a second worker. Older low-level refusals may report
`unknown`; that status never authorizes re-keying.
