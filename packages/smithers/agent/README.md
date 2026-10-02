# @smthrs/agent

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://agent.smithers.sh

The Smithers agent, and the two ways to run it.

`Agent` **is** the agent: one service whose single method runs one whole cell
loop on the durable engine. A **cell** is the JavaScript program the model emits
each frame; it runs in the sandbox, and its only authority is
`ctx.call(flowName, input)`, so every capability a cell reaches is an ordinary
flow settling through a durable boundary. The contract is
[`@smthrs/harness/Cell`](https://harness.smithers.sh/concepts/#the-cell-loop).

`AgentSession` runs that agent as a durable control-plane run — the production
`ControlExecutor`, where the launch is a flow execution, the events go to the
journal, and an operator steers and approves it. `AgentAction` runs that same
agent as one typed step inside a larger flow, bounded by a declared output
schema and replayed like any other action.

Neither adapter reimplements the loop. A future agent that drives a foreign CLI
is another implementation of `Agent.Service`, not a second loop beside this one.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

Node.js 26.4.0 or later. The shortest real use is one model-backed step: an
ordinary action that ships its own implementation and answers in the shape you
declared.

```ts
import { AgentAction } from "@smthrs/agent"
import * as Schema from "effect/Schema"

const Research = AgentAction.make("docs/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({ summary: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant."],
  prompt: ({ topic }) => `Research ${topic}.`
})
```

[The quickstart](https://agent.smithers.sh/quickstart/) runs that step end to
end against a scripted model, with no API key. The rest of this file is the
composition guide: what each piece is, and what a host has to provide.

## `Agent`

`Agent.layer` provides the production implementation and requires both a quota
classifier and a budget. It composes the whole cell path, the controller in
`@smthrs/harness/CellTurn`, registry-backed call
resolution in `@smthrs/harness/CellCalls`, the QuickJS sandbox, the durable
engine port `FlowEngineLike`, and the plugin kernel, then returns the
framework-neutral `Stream<AgentEvent>` the controller emits. There is no
callback, no event emitter, and no host-shaped result type; a caller renders the
stream, journals it, or ignores it.

```ts
import { Agent, Budget, ChildFlows, QuotaPolicy, SeatResolver, StandardFlows } from "@smthrs/agent"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import type * as Path from "@smthrs/kernel/Path"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Stream } from "effect"
import type * as FileSystem from "effect/FileSystem"

// Inside a flow body — `FlowInstance` is per-execution.
const run = Effect.gen(function*() {
  const agent = yield* Agent.Agent
  // The host's resolver owns the credentials. `agent.run` only ever accepts a
  // seat that came out of one.
  const seats = yield* SeatResolver.SeatResolver
  const seat = yield* seats.resolve("anthropic:claude-opus-5")
  // Each standard flow takes exactly the context its handlers require, so the
  // two capabilities are built from two different slices of the host.
  const filesystemServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const shellServices = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | Path.Path
  >()
  return agent.run({
    session,
    seat,
    prompt: task,
    registry,
    // Capabilities are flows. All of them.
    flows: [
      StandardFlows.filesystem(filesystemServices),
      StandardFlows.shell(shellServices),
      ChildFlows.source(children)
    ],
    plugins
  }).pipe(Stream.provide(Agent.layerDefaults))
}).pipe(
  Effect.provide(Agent.layer),
  // This direct host should park reset-bearing refusals. It has no approved
  // plan envelope from which to derive a spend ceiling.
  Effect.provide(QuotaPolicy.layerDefault()),
  Effect.provide(Budget.layerUnbounded()),
  // The completion brake never falls back, so every host binds a transport.
  // Resolve judgeSeat through the host's existing subscription seat resolver.
  Effect.provide(Evaluator.layerFromSeat(judgeSeat))
)
```

`Seat.make` is documented as the resolved-seat constructor, and a `SeatResolver`
implementation is what calls it. A caller reaches a seat through the resolver,
never by assembling one from a model and a route it happened to hold.

`Agent.layerDefaults` supplies the two services a run leaves to the host —
the QuickJS sandbox and an empty steering source — with browser-safe defaults. A
host that accepts mid-run messages provides its own `Steering.layer` instead.

The third service a run leaves to the host is the `Evaluator` from
[`@smthrs/model`](/api/model), and it is not in `layerDefaults` because it is
a host-owned judge decision. Bind `Evaluator.layerFromSeat(judgeSeat)` using
an existing resolved subscription seat. Native hosts select a subscription
through their seat resolver; no provider API key or gateway key is required.
An unavailable seat or invalid judgment fails as `completion_unjudged`.
Offline tests deliberately bind `Evaluator.layerScripted` with an
evidence-based judge. Scripts must dispatch by question id and read the
supplied evidence; see the [whole-host fixture](https://github.com/smithersai/smithers/blob/main/flows/test/fixtures/scripted-judge.ts).
The completion-only `ScriptedJudge.layer` fixture rejects named commands missing
from the record and refuses questions it does not understand. Neither it nor
`Evaluator.layerUnavailable()` is a production default.

`Agent.layerDefaultsWithVariant` is the same pair over the QuickJS build the
host names, taken from `QuickJSSandbox.Variant`. A runtime that refuses to
compile WebAssembly from bytes, such as Cloudflare's workerd, uses it and
provides `QuickJSSandbox.layerVariant(variant)` beneath. See
[Run on Cloudflare workerd](https://harness.smithers.sh/guides/workerd/) for how
a worker builds that variant.

`flows` is an ordered list of `FlowBinding.Source`s; plugin `cellFlows` handlers
run after them, in resolution order. The composed catalog is what the model is
shown _and_ what the boundary resolves against, so the declaration digest a cell
was written against is the one checked when the call arrives. Duplicate names
fail composition rather than dispatching one descriptor to another
implementation.

- `StandardFlows` — `filesystem`, `shell`, `memory`, `clock` (a durable wait on
  the engine's `DurableClock`), and `approval` (a narrow injected `Asker` port,
  because a host with nobody to ask should refuse honestly rather than fake an
  answer).
- `ChildFlows` — subagents. An attached child needs nothing here: a dynamic or
  markdown flow called with `ctx.call` already runs inside its own durable
  boundary. Detached lifecycle — `agent/spawn`, `agent/send`, `agent/await` — is
  bound over an injected `Children` port, because nothing browser-safe can
  honestly claim to persist a detached run.
- `EngineChildren` — that port, over a durable engine. `spawn` starts the named
  flow as a run of its own and answers once its row exists, `await` reads the
  child's result back out of the run store (so another process, another engine,
  and a later incarnation all work), and `send` steers the child through
  `Control.steer`, naming the message with the calling step's key, an ordinal
  counted inside the enclosing dispatch, so a re-driven round delivers it once
  and a send after a park never inherits a replayed step's number. The message
  carries a timestamp read inside a sealed step, so a re-drive submits the same
  bytes and the control plane recognises its own earlier admission. `send`
  answers from the receipt: `Accepted` and `AlreadyApplied` report
  `delivered: true`, and every other receipt fails the call, because nothing
  was admitted. It reaches no engine internals: `FlowRuntime`, `RunStore`, and
  `Control` are the whole dependency set.
  `EngineChildren.layer({ flows })` names the flows a child may run; anything
  else is `ChildError { code: "not_found" }`. `await` and `send` reach the
  calling run's own children and no others: the child id is derived from the
  parent's execution id, so a call from inside a run that names an id outside
  that namespace is `not_found`. A call from outside any run is the host
  collecting its own child and is not restricted.
- `CellPlugin.fromBindings` — the one-liner for authoring a harness plugin that
  contributes capabilities.

The provider-tool-call loop is gone. `@smthrs/harness` deleted it along with
every module that existed only to serve it, and nothing replaced it beside the
cell path. A foreign-CLI agent returns as another implementation of
`Agent.Service`, not as a second loop.

## `Seat` and `SeatResolver`

A seat has two halves, and they live in different places on purpose.

The declared half is an ordinary string, and the package ships no schema for
it. It is what a markdown flow's `model:` frontmatter carries and what
`AgentAction`'s `seat` option takes. It carries no credentials, no endpoint, and
no client — a declaration is portable, and a run that reads one out of a
repository must not be handed the keys with it. `provider:modelId`
(`anthropic:claude-sonnet-4-5`) is the convention the resolver in
[`@smthrs/cli`](https://cli.smithers.sh) understands, not a rule the agent
enforces.

`Seat.Seat` is the resolved half, and the only thing `Agent.run` accepts: a live
`Model`, the `RouteResolver` that seals its requests, and the model's context
window in tokens so compaction has a real budget. `Seat.make` constructs one,
and a `SeatResolver` implementation is what calls it.

`SeatResolver` is the seam between them, and the credentialed half of the
composition. `@smthrs/cli`'s `NodeControl` installs the resolver that reads keys
from the environment; a test installs one that answers with a scripted model and
never touches the network. `SeatResolver.contextWindowTokensFor` is the catalog
of known models, with a conservative floor — never zero, because zero is
`CellTurn`'s "compaction disabled". A seat the host cannot serve is a typed
`Seat.SeatUnresolved`, not a run that fails halfway through.

Because the resolver owns the seat vocabulary, a host may define its own. A
resolver that maps `reviewer` onto a particular model is an ordinary
implementation of its one method.

## `AgentSession`

`AgentSession.layer(options)` is the production `ControlExecutor` for
`@smthrs/control`: when the control plane accepts a launch, the session looks
the flow up in the registry, loads its markdown prompt body, resolves its
declared seat through `SeatResolver`, and runs the `Agent` service as the body
of one durable flow execution whose id is the control run id.

The composition declares everything a control-plane host has to supply: explicit
`Sandbox.Limits` (never unlimited), a `Steering.Source` over the journal-backed
notification queue `Control.steer` admits into, and an approval `ask` gated in
`authorize` — before the durable boundary opens — that registers an in-run
approval token, parks the run with an encoded `Permission.PermissionRequired`,
and is re-decided against the grant store when `Control.approve` and
`Control.resume` bring the run back.

Both policies are required options, not defaults the session invents.
`Options.quotaPolicy` is the `QuotaClassifier` layer every model call in the run
is decided under, and `Options.budget` is a function from the approved
`Envelope` to a `Budget` layer, so the ceiling a run is held to is derived from
the plan that was admitted rather than from anything the host held. The session
provides the budget layer inside each body invocation; the latency clock is
durable so a parked run does not get its whole `milliseconds` allowance back
when it wakes. A host that means to enforce nothing says so with
`QuotaPolicy.layerUnclassified()` and `Budget.layerUnbounded()`.

`@smthrs/cli`'s `NodeControl.layerExecutor` is the Node wiring: a `SeatResolver`
over real `Route.anthropic` / `Route.openai` routes with API keys read from the
environment, and `StandardFlows.filesystem/shell/memory` over the
permission-guarded host layers from
[`@smthrs/kernel`](https://kernel.smithers.sh).

The module also exports the pieces the session builds itself out of, and they
stay public because a host that runs the agent its own way needs the same ones:
`trace` and `patterns` are the projection half (agent events to durable
`control.agent.*` trail entries, declared capability strings to patterns), and
`waitForRunning`, `waitForParked`, `preserveDriverInterrupt`, `registerDriver`,
and `settleDriverFailure` are the wait and driver-lifecycle half.

## `AgentAction`

`AgentAction.make` declares an ordinary `Action` (same tag, same payload schema,
same `.call()`, same plan node, same durable replay) and ships the
implementation with it, as the `Research` step above does. An author never
writes `toLayer` for a model call, because there is only one implementation.

The declared output schema is rendered into the run's system teaching and
enforced against the run's final answer; a decode miss spends a correction slot
on a re-prompt before it becomes a typed `StructuredOutputFailure`. The host
half is `AgentAction.Host`, the registry, the sandbox budget, and the catalog
every model-backed action in a composition shares, plus `SeatResolver` and
`Agent`. A test swaps the whole model for a scripted one by providing a
different `SeatResolver`.

`Host` also carries the defaults a step inherits: `defaultCorrections` (the
correction budget for a step that declares none), `modelRetryPolicy` (the
transport retry ladder one model call runs under, which `Schedule.recurs(0)`
turns off), `maxQuotaParks` (how many quota waits one step may take), `system`,
`maxFrames`, and `capabilityEnvelope`.

### The structured-output correction policy

Three numbers decide how hard a step tries to answer in shape, and each is
declared where the person who cares about it works:

| Where                     | What it says                                                                   |
| ------------------------- | ------------------------------------------------------------------------------ |
| `Options.corrections`     | This step's budget. Zero makes a first miss terminal.                          |
| `Host.defaultCorrections` | The composition's budget for steps that declare none. One when neither is set. |
| `Options.repair`          | One bounded ask after the budget is spent.                                     |

A correction repeats the task verbatim and appends the validation issues: it
assumes the model can still answer the question it was asked. A repair does not.
It is the author's own prompt, written from the failure, asked exactly once, and
decoded by the same schema:

```ts
const Review = AgentAction.make("review/Diff", {
  payload: { diff: Schema.String },
  output: Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) }),
  seat: "anthropic:claude-sonnet-4-5",
  prompt: ({ diff }) => `Review this diff:\n${diff}`,
  corrections: 2,
  repair: {
    prompt: (failure) => `Return ONLY the JSON review. The last answer failed with: ${failure.issues.join("; ")}`
  }
})
```

Every rejection writes one `flows.agent.structured-output-rejected.v1` record on
the journal's lossy channel, carrying the action, the attempt, the budget, the
schema digest, and a digest of the issues. The record exists because the final
failure only describes the LAST candidate: a run that answered three times
should say so in its own trail, and two runs that spent their budget the same
way should be distinguishable without the answers themselves being journaled.
A composition without a journal, such as the reference memory engine or a test,
writes nothing and behaves the same otherwise.

The record is evidence, not a decision: nothing in the ladder reads it back,
and compaction may drop it without changing what the run does.

What makes the ladder durable is the step underneath it. Each attempt is a
whole cell run under its own session and its own prompt, so its model call is a
distinct sealed step with its own content key and its own attempt row on the
journal's durable channel. A run that settles and is asked again replays the
entire ladder, corrections included, and pays the provider nothing, including
when the second ask arrives on a different engine over the same database.

The rung is readable as well as distinct. A session is key material and is
hashed into the step key, so three distinct keys say a ladder ran and not which
call was the ask. `AgentAction` sets `FlowEngineLike.Correction` around each
rung and the port stamps the ordinal onto that rung's own `RecordedModelStep`,
so a projection reading the run's sealed steps gets `correction: 0` for the ask
and `1`, `2` for its re-prompts. The field is optional: a model call outside a
ladder has no ordinal, and a record written before the field existed still
decodes for a parked run resuming onto a newer package.

### Composing it

Every layer a model-backed step needs, trimmed from
[`examples/src/11-agent-step.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/11-agent-step.ts).
`AgentAction.make` returns the declaration and its `.layer` together, so the
composition names the action once.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Agent, AgentAction, Budget, QuotaPolicy, Seat, SeatResolver } from "@smthrs/agent"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(
  Research.layer,
  Interpreter.layer(SimpleWorkflow)
).pipe(
  // The registry, the sandbox budget, and the catalog every model-backed
  // action shares, plus the credentialed seam and the agent itself.
  Layer.provideMerge(Layer.mergeAll(
    AgentAction.layerHost({ registry, limits: { calls: 8 }, capabilityEnvelope: [], maxFrames: 4 }),
    SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(Seat.make({ id, modelId: "test-model", model, route, contextWindowTokens: 200_000 }))
    }),
    Agent.layer
  )),
  // A provider refusal with a reset should park. This standalone composition
  // has no approved plan envelope from which to derive a spend ceiling.
  Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
  // The QuickJS sandbox a cell runs in and the steering source it drains.
  Layer.provideMerge(Agent.layerDefaults),
  // Resolve judgeSeat with the host's subscription resolver.
  Layer.provideMerge(Evaluator.layerFromSeat(judgeSeat)),
  // Ordinary flow composition: action implementations, a durable engine, crypto.
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

### Watching it run

A step answers with one decoded value, which it only knows at the end. Provide
`EventSink` to observe its provider and controller events, including the cell
it produced and the calls it made. `FlowEngineLike` records a complete provider
call before emitting its deltas, so those deltas do not report live provider
progress.

```ts
import { EventSink } from "@smthrs/agent"
import * as Effect from "effect/Effect"

const watched = Layer.merge(
  layer,
  EventSink.layer({ emit: (event) => Effect.sync(() => render(event)) })
)
```

An observer's `emit` consumes the public event stream. Keep it short, for
example by updating a view or resolving a deferred.

The module host installs `EventSink.durable` automatically. It checkpoints
projected events at the controller source. Each bounded fact and its checkpoint
outcome commit in one transaction before the owning agent step settles.
Provider execution holds no checkpoint transaction. Recorded invocation,
attempt, correction, quota retry, and generation coordinates keep concurrent
steps and replayed observations separate.

`AgentAction.make` accepts either one `seat` or an ordered list, including a
payload callback returning that list. Markdown flows use the same ordering:

```yaml
model: [openai:gpt-6-sol, anthropic:claude-opus-5-5]
```

The first model is primary. Remaining models are tried after a capacity refusal,
context overflow, or HTTP 5xx failure. Transport retries finish before fallback;
overflow and 5xx failures do not create a quota park. Exhausting those fallbacks
returns the last provider error. The declared order is part of flow identity,
and durable replay does not repeat completed provider calls.

Terminal credit refusals (`out_of_credit` or an unclassified
`quota_exceeded`) skip the refused account for later frames of that invocation;
explicit model scope skips only that model. Timed refusals remain eligible after
their cooldown, including when the remaining backup must park. Durable replay
reconstructs the skips; a new run can try replenished credit. Hosts retain
session-wide credit decisions and
enforce a pinned model by passing `fallbackSeats: []`.

## Quota-aware waits

A `rate_limited` or `quota_exceeded` answer is not a defect report: the provider
is saying when to come back. `QuotaPolicy` is the classifier that reads it, and
`AgentAction` is what parks on it.

```ts
import { QuotaPolicy } from "@smthrs/agent"

// In the composition, beside the host and the seat resolver.
const quota = QuotaPolicy.layerDefault({ maxWaitMillis: 900_000 })
```

The classifier answers one question, whether this refusal is a wait and until
when, in order of how much the provider actually said: `resetAtEpochMillis`, then
`retryAfterMillis`, then a delay parsed out of the message text, then
`Config.defaultWaitMillis`. A deadline beyond `Config.maxWaitMillis` is not a
wait at all: the classifier answers `None` and the original `ModelError`
propagates, because a run parked for a day is indistinguishable from a run that
hung. `QuotaPolicy.layerUnclassified()` explicitly keeps refusals as failures.

A classified refusal parks for real:

- the decision is a **recorded step**, so a replay waits out the deadline the
  first pass chose instead of computing a new one;
- `annotateWaiting({ reason: "quota", wakeAt })` and `DurableClock.sleep`
  suspend the run, so a supervisor sees a parked run with a wake time and
  `waitingRuns({ reason: "quota" })` finds it;
- the retry runs under `Action.retry`, so the re-issued model call is a new
  attempt of the same step rather than a replay of the one the provider
  refused, and the step's correction budget is untouched;
- `Host.maxQuotaParks` bounds it, because a window still closed after its own
  deadline is not one a run waits out forever.

One more thing changes at the engine port: `FlowEngineLike` records a provider
refusal as the sealed step's result, which is right for every failure except
this one. A quota refusal says nothing about the request, because the same bytes
succeed a minute later, so recording it under a content key would pin
"this prompt is refused" into the shared cache and make the wake pointless. A
classified refusal fails the sealed action instead, which records an attempt
rather than a result.

## Budgets

`Sandbox.Limits` bounds one cell and `Agent.Options.maxFrames` bounds one loop.
Neither accumulates, so `Envelope.budget`, the tokens, dollars and milliseconds
a control plane approved for a plan, bound nothing until `Budget` existed.

```ts
import { Budget } from "@smthrs/agent"

const budget = Budget.layer({
  tokens: { max: 200_000, onExceeded: "fail" },
  latency: { maxMillis: 900_000 }
})

// Or straight from what the control plane approved:
const approved = Budget.layerFromEnvelope(envelope)
```

Enforcement sits at the model boundary in `FlowEngineLike`, which every model
call passes through, so a step that assembles its own loop cannot evade a budget
declared for the run. Five rules make it usable:

- **The accumulator is per run, keyed by the model step's content key, and
  projected from the journal.** Every accounted call writes a
  `flows.agent.usage.v1` record on the journal's DURABLE channel, and a budget
  entering a run folds that run's records back before it decides anything. The
  projection is what makes the budget survive a restart: the engine resumes a
  run from its recorded NODE results and never re-enters a settled step, so an
  in-memory accumulator would start a resumed run at zero and hand it a second
  full allowance. The record is durable rather than lossy for the same reason:
  the lossy channel is droppable telemetry, and a dropped record here would
  hand out that second allowance silently. The content key is the other half: a
  recovered record and its own live call are the same key, so the call counts
  once.
- **One instance serves every run.** A composition provides `Budget` above its
  engine, so the tally is keyed by execution id. `Budget.usageOf(runId)` reads
  one run's spend, from its live accumulator when the run is here and from its
  records when it is not. `Budget.defaultMaxRuns` bounds how many tallies are
  held in memory; `Budget.layer(policy, { maxRuns })` sets it.
- **Admission reserves a projection.** Before dispatch, `reserve(stepKey)`
  atomically counts actual spend plus estimates for all in-flight calls. The
  largest observed call sets the estimate; larger completed calls raise
  outstanding estimates. Recorded usage replaces the estimate, and scope exit
  releases the reservation, including failure or cancellation.
- **An unmeasured call holds capacity.** Until a positive cost is known, one
  call reserves the full token allowance. A zero allowance refuses even the
  first call unless `warn` permits it. Concurrent distinct calls compete for
  the reserved capacity; duplicates of the same sealed key share a reservation
  until every holder finishes.
- **The accounting fails closed.** A record that could not be written, a ledger
  that could not be read, and a ledger longer than one recovery reads
  (`Budget.defaultRecoveryEntries`, overridable with
  `Budget.layer(policy, { recoveryEntries })`) all raise
  `Budget.AccountingUnavailable` rather than answering. Each of them is a run
  whose spend is UNKNOWN, and a budget that read an unknown as zero would hand
  a resumed run its whole allowance back and report itself healthy. The step
  that made the call fails instead; its sealed model step replays from the
  recorded answer, so a re-dispatch pays the ledger again and not the provider.
  The `flows.agent.budget-warning.v1` record is the one this module still lets
  go: nothing reads it back.

These are soft admission bounds: an admitted call can cost more than its
forecast, including the first call. Concurrent admission requires one shared
`Budget` instance per run. `check(stepKey)` is an advisory preview; custom
model boundaries must use scoped `reserve` through the provider call and its
`record`.

A `skip-remaining` refusal durably records the original decision as
`flows.agent.budget-latched.v1` before returning. Recovery restores that latch
independently of usage and transient reservations, including after cache
eviction. Releasing a peer reservation without usage cannot reopen the run.
Already counted steps may still replay. See the
[quota and budget guide](docs/guides/quota-and-budgets.md#limit-admission-using-a-spending-forecast)
for the admission and recovery contract.

`onExceeded` decides what running out means: `fail` reports a typed
`BudgetExceeded { scope, used, max, next }` at the step, `warn` writes a
`flows.agent.budget-warning.v1` journal record and proceeds, and
`skip-remaining` latches, so every later model call in the run fails typed
`skipped` without asking a provider anything. `Budget.layerUnbounded()`
explicitly accounts nothing and refuses nothing; omitting a budget is a type
error.

A latched refusal is its own failure, `Budget.Skipped`, carrying the
`BudgetExceeded` it latched on. The distinction is what an operator needs: one
step broke the budget and every other step was stopped by it. It is
quarantine-compatible, naming a verdict no retry can change, and
`Budget.neverRetrySkipped(policy)` adds its tag to a retry policy so a ladder
that would otherwise re-dispatch a skipped step gives up on the first refusal.

## The engine port

`@smthrs/harness` owns the _port_ — `sealStep`, `call`, `splice`, `record`,
`suspend` — and ships only `EngineLike.layer(implementation)` and
`EngineLike.layerNoop()`. It deliberately does not depend on any engine: the
browser app supplies its own in-tab implementation, and pulling the durable
engine into the port package would put it in every harness consumer's bundle.
`FlowEngineLike` is the other implementation: the same port executed on the
durable engine.

```ts
import { FlowEngineLike } from "@smthrs/agent"
import { Effect } from "effect"

// Inside a flow body — `FlowInstance` is per-execution.
const program = Effect.gen(function*() {
  const engine = yield* FlowEngineLike.make({
    model,
    route: FlowEngineLike.routeResolver(anthropic),
    calls: { authorize: (call) => checkGrants(call), run: (call) => runFlow(call) }
  })
  // ...provide `engine` to the harness.
})
```

## What durability buys

- **`sealStep`** resolves the route, runs `Route.prepare`, and digests the
  credential-free prepared request together with the harness's declared key
  material into a `StepKey`. That key is the sealed activity's idempotency key:
  a replayed turn re-emits the recorded model events instead of calling the
  provider again, and a provider wire change produces a new key. Credentials
  are signed on after the digest and never enter it.
- **`call`** runs one flow call from inside a running cell as its own activity
  at the tier the flow declares. A sealed call is content-addressed on its
  declaration digest, resolved layers, declared capabilities, and arguments, so
  it replays wherever it appears; anything else folds in the whole cell
  identity — session, frame, cell digest, and the call's execution ordinal — so
  two invocations stay distinct, an irreversible effect is run-scoped, and a
  cell re-executed after a park replays exactly the boundaries that already
  settled. Authorization is checked _before_ the activity opens: an activity's
  outcome is journaled, so a permission requirement raised from inside one
  would replay forever and no later grant could unblock it.
- **`splice`** retains the harness port shape but refuses every non-empty
  elaborated batch with a typed `engine_failed` error because the cell loop
  superseded the provider-tool-call path. An empty batch produces no events.
- **Composition identity.** `Options.layers` is the resolved layer stack and
  plugin list the host actually built, and it is folded into every key this
  port derives. A boundary resolved under a different composition is a
  different boundary, so a plugin swap can never be served a recorded result
  from the composition it replaced. The port also declares that layer set as
  the engine's content environment (`Activity.CurrentContentEnvironment`).
- **Authority identity.** The other half of the content environment is
  `Options.capabilities`, and the port never invents it. A sealed boundary is
  cross-run cacheable, so a result computed under a broad capability envelope
  must not be served to a run with an attenuated one, even when the call
  declares identical capabilities — the envelope is what attenuates it.
  Supplying the composition's **complete** authority is what makes a sealed
  boundary shareable across runs; omitting it is the honest
  "unknown", and the engine answers it by pinning every sealed key to the
  current execution. `Agent.run` declares the capability envelope it actually
  built, so hosts on that path get cross-run reuse without asserting anything
  false.
- **`record`** journals one nondeterministic controller read — the
  turn-boundary steering drain — as its own run-scoped boundary. A resumed
  run replays the recorded drain instead of reading an already-drained queue,
  which is what keeps a resume on the original attempt's sealed steps.
- **`suspend`** is a real durable suspension (`Flow.suspend`). The execution
  parks and the engine can resume it, rather than the port failing.
- **`observe`** measures the workspace around a frame through
  `WorkspaceObservation.Observer`, so the loop's mutation accounting is a fact
  about the tree rather than a claim a declaration made. `bash` is why it
  exists: a spawned process writes wherever it likes and tells nobody. The
  measurement is identity, not content — path, size, and modification time
  folded into one digest — because reading every byte costs the whole tree
  twice per frame. A composition that provides no observer answers `None`, and
  the loop falls back to declarations.
- **`capture`** takes the pinned git tree a cell call names. `@smthrs/harness`
  decides _whether_ a call may name one, mints the handle, bounds how many a run
  may hold, and folds the checkpoint into the call's key; `Checkpointed` is the
  other half, the `CallRunner` decorator that asks the store for that tree as a
  directory, points the call at it, and gives the directory back when the call
  ends. A composition that pins nothing is still wrapped, by
  `Checkpointed.unpinned`, because a call carrying an `at` must never quietly
  read the live tree instead.

`MemorySnapshotRecorder` is the third adapter in this direction: it implements
`@smthrs/memory`'s `SnapshotRecorder` port by translating a snapshot identity
into an `EngineLike.record` boundary, so a memory snapshot a run takes is
journaled and replays with it.

## Saving the script a run just wrote

A run that solved something once solved it as a script: a few cells that read the right things, called the right boundaries, and printed an answer. `PromoteFlows` is how that script becomes a flow anyone can call again, and it is two ordinary flows rather than a new affordance.

`flows/show-script` hands the model its own turn back — the source of every cell it executed, in order — together with the rules a saved flow has to follow and the file skeleton to fill in. It reads `@smthrs/harness/CellHistory`, the optional service the cell controller records into, so a host that keeps no history reports an empty script instead of failing. `flows/write-flow` takes the three files that come back — the flow, its end-to-end test, and the fixture that test replays — and writes them through a `FlowStore`. When a `Registry` is in context it is refreshed afterwards, which is what makes the saved flow appear in `ctx.flows` on the next frame rather than the next run.

`FlowStore` is where the files land, and the host decides where that is: `FlowStore.layerFileSystem(root)` writes `<root>/flows/<id>/{flow.ts,flow.e2e.ts,fixtures/<id>.json}` through Effect's `FileSystem`, `FlowStore.layerMemory()` keeps them in a map, and `FlowStore.layerNoop()` refuses with a message the model can read. The store is also the last place an id is still text, so `FlowStore.validateId` runs before any path is built from it: `../escape` is refused as a bad id rather than caught as a surprising write. The rules and the skeleton are the host's too — `PromoteFlows.Options` replaces both for a host whose flows are laid out differently.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/agent/<Module>`:

`Agent`, `AgentAction`, `AgentSession`, `Budget`, `CellPlugin`, `Checkpointed`,
`ChildFlows`, `EngineChildren`, `EventSink`, `FlowEngineLike`, `FlowStore`,
`InMemoryWorkspaceSandbox`, `MemorySnapshotRecorder`, `PromoteFlows`,
`QuotaPolicy`, `Seat`, `SeatResolver`, `StandardFlows`, `WorkspaceObservation`,
`WorkspaceSandbox`.

Every export of every one of them, with its signature and its errors, is
documented on [the API reference](https://agent.smithers.sh/reference/api/).
That page is the list; this README is the composition guide.

`@smthrs/agent/package.json` is also exported. `internal/*` and nested `*/index`
subpaths are not public.

## Not to be confused with

[`@smthrs/testing`](https://testing.smithers.sh) exports a `FlowEngineLike` of
its own, and it is a different thing. That one adapts the same engine to
`EngineSubject` (`run` / `result` / `interrupt` / `resume` / `journal`), the
conformance contract that library checks engine implementations against. The
two share a backing engine and nothing else.
