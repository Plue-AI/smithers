---
title: "API reference"
description: "Every public export of @smthrs/agent: the Agent service, the AgentSession and AgentAction adapters, seats, the quota and budget policies, the capability catalog, and the durable engine port."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/api.md"
---

`@smthrs/agent` exports twenty-three modules from its root entry point, and each is
also importable from `@smthrs/agent/<Module>`:

```ts
import { Agent, AgentAction, Seat } from "@smthrs/agent"
// or
import * as Agent from "@smthrs/agent/Agent"
```

`@smthrs/agent/internal/*` and `@smthrs/agent/*/index` are not public.
`@smthrs/agent/package.json` is exported.

Services and tags are Effect constructs: a `Layer` provides a service, and a
flow body or stream reads it from context. For the authoring model behind
flows, actions, and interpreters, see the
[`@smthrs/flow` reference](https://flow.smithers.sh/reference/api/). For the cell contract, the controller,
and the sandbox vocabulary the loop runs on, see the
[`@smthrs/harness` reference](https://harness.smithers.sh/reference/api/).

## Example

```ts
import { AgentAction } from "@smthrs/agent"
import * as Schema from "effect/Schema"
const Research = AgentAction.make("docs/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({ summary: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  prompt: ({ topic }) => `Research ${topic}.`
})
```

## Agent

The agent: one service whose `run` executes one whole agent loop and returns
the framework-neutral `Stream<AgentEvent>` the controller emits. A run must be
started from inside a running flow body, because the engine port is built per
execution; that is why `FlowRuntime.FlowRuntime` and `FlowRuntime.FlowInstance`
are in the stream's requirements rather than in the service's construction.

### Agent.Service

```ts
interface Service {
  readonly run: (
    options: Options
  ) => Stream.Stream<
    AgentEvent.AgentEvent,
    HarnessError | PluginError,
    | FlowRuntime.FlowRuntime
    | FlowRuntime.FlowInstance
    | Sandbox.Sandbox
    | Steering.Source
    | Budget.Budget
    | QuotaPolicy.QuotaClassifier
  >
}
```

`run` assembles the run's catalog from the registry and the declared `flows`
(plugin `cellFlows` handlers run after them, in resolution order), shows the
model exactly the registry the boundary resolves against, and runs the cell
controller. Duplicate flow names fail composition rather than dispatching one
descriptor to another implementation.

### Agent.Options

Everything one assembled cell run declares. The required half is the run
itself; every default on the optional half is the conservative one.

| Field                | Type                                                                                                                      | What it decides                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`            | `string`                                                                                                                  | The durable session or lineage every call identity is scoped to. Required.                                                                                                                                                                                                                                                                    |
| `seat`               | `Seat.Seat`                                                                                                               | The resolved seat this run streams from: model, route, and context window together. Required.                                                                                                                                                                                                                                                 |
| `fallbackSeats`      | `ReadonlyArray<Seat.Seat>`                                                                                                | Resolved seats tried in order after capacity refusal, context overflow, or HTTP 5xx failure. Capacity refusals cool seats sharing a route; overflow and 5xx do not park.                                                                                                                                                                      |
| `capacity`           | `{ park: boolean; maxParkMillis?: number; maxParks?: number }`                                                            | Capacity handling. Parking defaults to true, with no wait ceiling; unknown resets are re-probed after 15 minutes. `maxParks` (default `QuotaPolicy.defaultMaxParks`, 8) bounds the parks per run; the next refusal fails the run with the provider's typed `ModelError`.                                                                      |
| `prompt`             | `string`                                                                                                                  | The task the run was admitted with. Required.                                                                                                                                                                                                                                                                                                 |
| `registry`           | `Registry.Registry`                                                                                                       | The catalog shown to the model and the registry its calls resolve against. Required.                                                                                                                                                                                                                                                          |
| `system`             | `ReadonlyArray<string>`                                                                                                   | Stable system teaching placed ahead of the cell contract.                                                                                                                                                                                                                                                                                     |
| `flows`              | `ReadonlyArray<FlowBinding.Source>`                                                                                       | Ordered executable-flow sources composed into the run's catalog.                                                                                                                                                                                                                                                                              |
| `implementations`    | `ReadonlyMap<string, CellCalls.Implementation>`                                                                           | Host implementations for module-backed flows, keyed by flow name.                                                                                                                                                                                                                                                                             |
| `promptRunner`       | `CellCalls.PromptRunner`                                                                                                  | Runs a rendered markdown flow. A host with none refuses them catchably.                                                                                                                                                                                                                                                                       |
| `authorize`          | `(call: Cell.Call) => Effect<void, HarnessError>`                                                                         | Decides whether a call may proceed, before its durable boundary opens.                                                                                                                                                                                                                                                                        |
| `plugins`            | `PluginInput<FlowsHooks>`                                                                                                 | Shared-kernel plugins resolved for the harness target.                                                                                                                                                                                                                                                                                        |
| `config`             | `FlowsConfig`                                                                                                             | Raw config threaded through the plugin kernel's config waterfall.                                                                                                                                                                                                                                                                             |
| `memory`             | `MemorySource.Declared`                                                                                                   | One explicitly selected memory snapshot, `{ rows, digest }` from `Source.declared`. The opening renders every row with `Source.render`; a judged run's relevance reading judges each row and renders only the kept ones. Omitting it injects no memory.                                                                                       |
| `modelParams`        | `ModelRequest.GenerationParams`                                                                                           | Generation parameters for the run's model calls.                                                                                                                                                                                                                                                                                              |
| `modelRetryPolicy`   | `Schedule<unknown, Model.ModelFailure>`                                                                                   | Overrides the bounded transport retry schedule at the model boundary.                                                                                                                                                                                                                                                                         |
| `layers`             | `ReadonlyArray<string>`                                                                                                   | The resolved composition identity folded into every durable key.                                                                                                                                                                                                                                                                              |
| `capabilityEnvelope` | `ReadonlyArray<Capability.CapabilityPattern>`                                                                             | The run's complete authority. The default is nothing granted.                                                                                                                                                                                                                                                                                 |
| `placement`          | `Option<Descriptor.Placement>`                                                                                            | The run's placement identity.                                                                                                                                                                                                                                                                                                                 |
| `maxFrames`          | `number`                                                                                                                  | Bounds one loop's frames.                                                                                                                                                                                                                                                                                                                     |
| `readOnlyCap`        | `number`                                                                                                                  | Caps consecutive read-only frames. Armed for task runs only; see `CellTurn.make` in [`@smthrs/harness`](https://harness.smithers.sh/reference/api/).                                                                                                                                                                                                                        |
| `modelCallMs`        | `number`                                                                                                                  | Caps the wall clock one model call may spend. Armed by default at `CellTurn.modelCallMsFor(effort)` (300,000 ms up to `medium`, 1,800,000 ms at `max`); zero disarms it.                                                                                                                                                                      |
| `repeatCap`          | `number`                                                                                                                  | Caps consecutive repeat-observation frames. Armed by default at `CellTurn.defaultRepeatFrames`; zero disarms it.                                                                                                                                                                                                                              |
| `narrowingCap`       | `number`                                                                                                                  | Caps completions bounced for narrowed evidence. Armed by default at `CellTurn.defaultNarrowingDemands`.                                                                                                                                                                                                                                       |
| `unmovedCap`         | `number`                                                                                                                  | Caps completions bounced for an unmoved tree. Armed by default at `CellTurn.defaultUnmovedDemands`.                                                                                                                                                                                                                                           |
| `unresolvedCap`      | `number`                                                                                                                  | Caps completions bounced for a failing check the run replaced rather than answered. Armed by default at `CellTurn.defaultUnresolvedDemands`.                                                                                                                                                                                                  |
| `claimCap`           | `number`                                                                                                                  | Caps completions bounced for a claim the run's record does not support; the one brake that asks the `Evaluator`. Armed by default at `CellTurn.defaultClaimDemands`; zero disarms it.                                                                                                                                                         |
| `approvalChannel`    | `boolean`                                                                                                                 | Whether a human can answer this run. Defaults to false; a run that claims it wrongly buys a run that waits forever.                                                                                                                                                                                                                           |
| `limits`             | `Sandbox.Limits`                                                                                                          | The sandbox budget every cell runs under.                                                                                                                                                                                                                                                                                                     |
| `supervisor`         | `{ remember?: boolean; namespace?: string; monitors?: ReadonlyArray<Monitor.Monitor>; stance?: "careful" \| "paranoid" }` | What the supervisor may do with its readings. `monitors` are added after `Monitor.defaults()` and before the `cellMonitors` hook; a duplicate or malformed monitor fails the run with `assembly_failed` before its first frame. `stance` is the static stance a judged run is taught, `careful` when omitted; an unjudged run is taught none. |
| `judged`             | `boolean`                                                                                                                 | Whether the host's `Evaluator` is a real judge. True arms Jev's features, among them the supervisor's nudges and memory inserts and the run-start relevance reading. Defaults to false.                                                                                                                                                       |
| `instructions`       | `ReadonlyArray<{ path: string; text: string }>`                                                                           | Human-provided instruction files, such as `AGENTS.md`, shown after `system`. A judged run drops the chunks Jev is confident the task does not need; see `CellTurn.Input.instructions`.                                                                                                                                                        |
| `pinnedSources`      | `ReadonlyArray<string>`                                                                                                   | Names of `flows` sources whose flows a judged run never withholds, beside `StandardFlows.coreSources`.                                                                                                                                                                                                                                        |

### Agent.Agent

```ts
class Agent extends Context.Service<Agent, Service>()("@smthrs/agent/Agent")
```

The `Service` tag.

### Agent.make

```ts
const make: (implementation: Service) => Service
```

Builds a `Service` from an implementation of its one method. A future agent
that drives a foreign CLI is another implementation built here, not a second
loop.

### Agent.makeNoop

```ts
const makeNoop: (overrides?: Partial<Service>) => Service
```

A `Service` that emits nothing and runs no model.

### Agent.layer

```ts
const layer: Layer.Layer<Agent, never, QuotaPolicy.QuotaClassifier | Budget.Budget>
```

Provides the production agent. The policy services are requirements of the
layer so a composition cannot erase them before `run` reaches the model
boundary.

### Agent.layerNoop

```ts
const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<Agent>
```

Provides `makeNoop`.

### Agent.layerDefaults

```ts
const layerDefaults: Layer.Layer<Sandbox.Sandbox | Steering.Source, Sandbox.SandboxError>
```

The browser-safe defaults for the two services a run leaves to the host: the
QuickJS single-file sandbox build, which runs unchanged in Node and in a
browser, and an empty steering source. A host that accepts mid-run messages
provides its own `Steering.layer` instead.

### Agent.layerDefaultsWithVariant

```ts
const layerDefaultsWithVariant: Layer.Layer<
  Sandbox.Sandbox | Steering.Source,
  Sandbox.SandboxError,
  QuickJSSandbox.Variant
>
```

`layerDefaults` over the QuickJS build the host names. A runtime that refuses
to compile WebAssembly from bytes, such as Cloudflare's workerd, provides
`QuickJSSandbox.layerVariant(variant)` beneath this and builds that variant
from a `.wasm` module import.

## AgentSession

The production `ControlExecutor` for [`@smthrs/control`](https://control.smithers.sh/reference/api/). When
the control plane accepts a launch, the session looks the flow up in the
registry, loads its markdown prompt body, resolves its declared seat through
`SeatResolver`, and runs `Agent` as the body of one durable flow execution
whose id is the control run id. Run-status writes stay fenced: the executor
waits for the control plane's own `running` transition, writes
`waiting-approval` when the execution parks, and writes the terminal status
when it settles.

Before starting a prompt, the session checks the plan's `executionDigest`
against the registry descriptor and verifies the loaded source bytes. The
same checks run on every drive or resume. An absent measured identity or a
change to the prompt, model, parameters, or discovered metadata refuses the
run; a refreshed registry needs a new plan and approval. A registry mismatch
is retained as the typed cause of the launch failure.

Module flows are discovered and planned but return `pending` from this agent
executor. A host must register their flow and action implementations and drive
them separately; `AgentSession` executes markdown prompt flows.

### AgentSession.Options

`abandonedParkAfter?: Duration.Duration` sets how long a foreign host's resume
delegation must stand before adoption. The default is
`Ownership.heartbeatStaleAfter` (30 seconds); adoption starts at the cutoff.

| Field             | Type                                                                      | What it decides                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits`          | `Sandbox.Limits`                                                          | The explicit sandbox budget every cell runs under. Required; never unlimited.                                                                       |
| `quotaPolicy`     | `Layer<QuotaPolicy.QuotaClassifier>`                                      | The required quota park/retry policy every model call in the run is decided under.                                                                  |
| `budget`          | `(envelope: Envelope) => Layer<Budget.Budget, Budget.ConfigurationError>` | Builds the run-local spending policy from the plan that was approved. Provided inside each body invocation.                                         |
| `flows`           | `ReadonlyArray<FlowBinding.Source>`                                       | Host executable-flow sources composed into every run's catalog. The durable wait and the control-wired approval are composed by the session itself. |
| `system`          | `ReadonlyArray<string>`                                                   | Stable system teaching placed ahead of the cell contract.                                                                                           |
| `maxFrames`       | `number`                                                                  | The cell-loop bound.                                                                                                                                |
| `readOnlyCap`     | `number`                                                                  | Consecutive read-only frames a task run may spend. Defaults to `CellTurn.defaultReadOnlyFrames`.                                                    |
| `modelCallMs`     | `number`                                                                  | Wall-clock milliseconds one model call may spend. Defaults to `CellTurn.modelCallMsFor(effort)`; zero disarms it.                                   |
| `repeatCap`       | `number`                                                                  | Consecutive repeat-observation frames. Defaults to `CellTurn.defaultRepeatFrames`; zero disarms it.                                                 |
| `narrowingCap`    | `number`                                                                  | Completions bounced for narrowed evidence. Defaults to `CellTurn.defaultNarrowingDemands`; zero disarms it.                                         |
| `unmovedCap`      | `number`                                                                  | Completions bounced for an unmoved tree. Defaults to `CellTurn.defaultUnmovedDemands`; zero disarms it.                                             |
| `unresolvedCap`   | `number`                                                                  | Completions bounced for a failing check the run replaced. Defaults to `CellTurn.defaultUnresolvedDemands`; zero disarms it.                         |
| `approvalChannel` | `boolean`                                                                 | Whether a human answers this executor's runs. Defaults to false; a run that claims false has its `park` transitions refused and answered in-frame.  |
| `judged`          | `boolean`                                                                 | Whether the host's `Evaluator` is a real judge; forwarded to `Agent.Options.judged`.                                                                |
| `reasoningEffort` | `ModelRequest.ReasoningEffort`                                            | The reasoning effort agent seats run at when their flow declares none. The flow's own `effort:` frontmatter wins; the built-in default is `high`.   |

### AgentSession.make

```ts
const make: (
  options: Options
) => Effect.Effect<ControlExecutor.Service, never, Services | Scope.Scope>
```

Constructs the production executor. It must be built in a scope: the scope owns
the registered agent flow, every forked run driver, and the resume bridge that
follows the journal. Its requirements are `Agent`, `ControlRuntime`,
`Crypto.Crypto`, `DurableEngineState`, `FlowRuntime`, `Journal`,
`NotificationQueue`, `Registry`, `RunStore`, and `SeatResolver`.

### AgentSession.layer

```ts
const layer: (options: Options) => Layer.Layer<ControlExecutor.ControlExecutor, never, Services>
```

Provides the production `ControlExecutor`.

### AgentSession.trace

```ts
const trace: (
  event: AgentEvent.AgentEvent,
  previous?: RequestTrail
) => { readonly eventType: string; readonly payload: unknown } | undefined

interface RequestTrail {
  readonly systemDigest: string
  readonly messageDigests: ReadonlyArray<string>
}
```

The journal projection of one agent event: `model-settled` becomes
`control.agent.model-settled`, and so on for the run's whole trail.
`model-delta` is the one omission, returning `undefined`, because deltas are
the token-by-token prefix of `model-settled` and journaling them would multiply
a run's event count by its token count. Free-text and value fields larger than
`maxTracedBytes` are replaced with a deterministic truncation marker carrying
the field's byte count and digest. This includes completion `output` nested in
`cell-settled.outcome.transition` and `transition-applied.transition`; the
containing outcome and transition retain their tags.

Two records hold what a step was asked, so a reader can reopen one step:

| Event type                       | Payload                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control.agent.model-requested`  | `scope`, `frame`, `attempt`, `purpose`, `seat`, `modelId`, `routeId?`, `protocolId?`, `system?`, `systemDigest`, `messages`, `messagesDigest`, `prefixCount`, `prefixDigest?`, `params`, `paramsDigest`, `toolCount`, `truncated?` |
| `control.agent.decision-settled` | `scope`, `frame`, `classifier`, `digest`, `state`, `stateDigest`, `questions`, `questionsDigest`, `answers`, `answersDigest`, `latencyMs`, `acted`, `decidedBy`, `truncated?`                                                      |

`scope` and `frame` join either record to its turn; position never does.
`system` is the system text, part by part, and `messages` is `{ role, text }`
per message. `params` carries `GenerationParams` with `maxTokens` written as
`maxOutput`, because the journal redacts a key ending in `token` and a composer
prefilled from `"[REDACTED]"` would send a lie.

A `model-requested` record holds what its call added to the call before it,
where "before" is the previous record of the same `scope` and `purpose` in
`(frame, attempt)` order:

- `prefixCount` is how many leading messages the call shares with that
  record's whole transcript, and `messages` is the rest. It is the longest
  common prefix, so an in-frame re-ask, the next frame, and the realm note a
  frame closes on each cost only what changed. The first call, a compaction,
  and a host rewrite share nothing and are written whole with `prefixCount: 0`.
- `prefixDigest` is present when `prefixCount` is above zero. It is
  `Digest.digest(CanonicalJson.stringify(digests))`, where `digests` holds one
  `Digest.digest(CanonicalJson.stringify({ role, text }))` per shared message.
- `system` is written when `systemDigest` differs from the previous record's,
  and is otherwise left out. `systemDigest` is always written.

A reader rebuilds one call by walking back through those records until
`prefixCount` is `0`, taking the first `prefixCount` messages of each rebuilt
predecessor, and reads `system` from the nearest record at or before the call
that carries it under the same `systemDigest`. The request is unavailable when
any record on the walk carries `truncated: true`, when a `prefixDigest` does
not match the messages taken, or when a predecessor is missing. A resumed run
that diverged can leave two records at one `(scope, purpose, frame, attempt)`;
the one whose messages satisfy the next record's `prefixDigest` is on the walk.

Every field a record is rebuilt from travels with the digest of that field as
it stood before the journal saw it: `systemDigest`, `messagesDigest` and
`paramsDigest`, and `stateDigest`, `questionsDigest` and `answersDigest`. Each
is `Digest.digest(CanonicalJson.stringify(field))` over the JSON the record
holds. The journal's redaction rewrites text that only looks like a credential
(`maxTokens: 4096`, `cacheKey = id`, `secret = hunter2`) and leaves no mark on
the row. A reader re-digests each field it read and treats a mismatch as
"redacted, not re-askable", the same way it treats `truncated`.

`system` and `params`, and `state`, `questions` and `answers`, are each bounded
by `maxTracedBytes`, and a field over the bound is replaced by its marker,
whose `digest` equals the field's sibling digest. The messages of one record
share one `maxTracedBytes` between them: each is written whole while the field
has room and as its own marker after, so one oversized message does not erase
the messages beside it and the record stays inside the step-fact payload
bound. When any marker is written the record also carries `truncated: true` at
the top level, so a reader reports the request unavailable instead of
rebuilding it from the fields that fit. A call whose host could not say what
would be sent writes no `model-requested`. A trail written before these
records existed has neither: a request or decision that was not journaled is
absent, never reconstructed.

`decision-settled` writes every name a classifier's author chose as a value,
never as a key, because the journal replaces the value under any key it reads
as a credential name (`auth`, `session`, `token`). `questions` is an array of
`{ id, type, instructions, criteria? }` in declaration order, and a choice
question's `criteria` is an array of `{ option, description }`. `answers` is an
array of `{ id, kind, ... }`, and the `probabilities` of a choice or a score is
an array of `{ option, p }`. `digest` hashes the wire form, which keys the
questions by id and a choice's criteria by option, so a reader rebuilds those
records from the entries before checking them against it.

The executor writes both without advancing the frame ordinal that
`traceIdentity` folds in, so a run journaled before they existed and resumed
after still deduplicates its recorded prefix.

### AgentSession.tracer

```ts
const tracer: () => (event: AgentEvent.AgentEvent) => ReturnType<typeof trace>
```

`trace` over one run's events in order. It keeps one `RequestTrail` per
`(scope, purpose)`, which is what a `model-requested` record is written
against; every other event projects exactly as `trace` projects it. Make one
per incarnation, where the events are consumed, and never keep it across a
restart: a resumed attempt replays from its first frame, and a fold that starts
empty regenerates the payloads, and so the identities, the first attempt wrote.

`trace(event, previous?)` takes the same `RequestTrail` as an argument and
stays pure. Without one it writes the request whole.

### AgentSession.traceIdentity

```ts
const traceIdentity: (
  frame: number,
  ordinal: number,
  cell: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>
) => JournalEvent.SourceSeq
```

The producer identity of one journaled agent event, derived from where the
event sits and what it says: the frame, its ordinal within that frame, the cell
that frame produced, the event type, and the event's payload minus the
observation-only fields `at` and `durationMillis`. A resumed attempt
republishes its whole prefix, and this identity is what lets the journal's
`UNIQUE (run_id, source_id, source_seq)` index refuse the duplicates while
admitting events produced after a divergence.

### AgentSession.agentFlow

```ts
const agentFlow: Flow.Flow<"agent/run", ...>
```

The one durable flow every agent run executes, registered by `make`. Its
execution id is the control run id. `FlowRuntime.resume(agentFlow, runId)`
re-drives a parked run through the registered handler; a round nobody
requested re-parks on the same wait, token, and question.

### AgentSession.maxTracedBytes

```ts
const maxTracedBytes = 65_536
```

The largest free-text or value field one trail record carries.

### AgentSession.patterns

```ts
const patterns: (
  capabilities: ReadonlyArray<string>
) => ReadonlyArray<Capability.CapabilityPattern>
```

Parses a run envelope's formatted capabilities, dropping every entry the
capability grammar cannot name. Dropping narrows authority, which is the
fail-closed direction.

### AgentSession.settlementFailure

```ts
const settlementFailure: (error: unknown) => unknown
```

Renders the failure the engine persists as the agent flow's settlement. Values
the JSON codec already accepts keep their identity; other objects are
round-tripped through JSON so their enumerable fields, `_tag` above all,
survive; anything else falls back to a text rendering. The mapper never throws:
a cycle, a `BigInt` field, or excessive depth still settles as text.

### Wait and driver helpers

`AgentSession.readExecution(runId)` returns `Missing` when no engine execution
is visible, or an `Observed` value with current lifecycle and waiting state.
When a run has continued to a later trampoline round, lifecycle and waiting
state come from the latest round; parent and round ordinal still describe the
requested `runId`. A root therefore remains round zero and never becomes its
own parent. A row's explicit parent takes precedence over its earliest durable
spawn edge.

The engine reads share its existing transaction. With the SQLite adapter this
holds a short writer lock during the scoped reads and releases it before any
execution or waiting. Store failures become typed `PersistenceError` values
with their original cause; interruption remains interruption. Control metadata
comes from a separate database read: this contract does not supply a global
snapshot, revision watermark, or bounded run-list query.

The pieces the session builds itself out of, public because a host that runs
the agent its own way needs the same ones:

| Export                    | Signature                                                                    | Behavior                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitForRunning`          | `(status, runId, attempts, retryDelay?) => Effect<boolean, unknown>`         | Waits for the control plane to publish its `running` transition before a driver starts the engine. Fails with `LaunchFailed` when the admission budget expires at `accepted`; answers false for any other status.          |
| `waitForParked`           | `(poll, attempts) => Effect<boolean, unknown>`                               | Polls a durable execution until it is published as parked. A missing poll is a still-live execution, so retries are bounded.                                                                                               |
| `preserveDriverInterrupt` | `(interrupt) => Effect<void, never, R>`                                      | Keeps a control cancellation durable even when its engine interrupt fails: a non-interrupt cause is logged, and an interrupt-only cause is re-thrown.                                                                      |
| `registerDriver`          | `(register, runId) => Effect<void, LaunchFailed>`                            | Translates a failed driver registration into the executor's launch error.                                                                                                                                                  |
| `settleDriverFailure`     | `(cause, runId, writeFailed) => Effect<void, E, R>`                          | Re-throws a cancelled driver while logging a non-interrupt engine failure and writing the run's `failed` status.                                                                                                           |
| `requestCancel`           | `(input: CancelRequest) => Effect<CancelRecord, PersistenceError, RunStore>` | Atomically records cancellation across the engine's trampoline lineage, whichever process owns it. `Terminal` requires every round to have settled; a missing row answers `unknown`; a repeat answers `already-requested`. |
| `deliverSignal`           | `(input: Signal) => Effect<SignalDelivery, PersistenceError, ...>`           | Completes the matching `WaitFor` token. Answers `delivered` only when the stored completion matches the payload, `no-match` for a conflicting token or completion, and `unknown` when completion cannot be established.    |
| `drainRecordedSignals`    | `Effect<void, never, ...>`                                                   | Reconciles a bounded rotating page of admitted commands at startup and every 250 ms. Commands remain pending until delivery is established, rejected, or their unbound run becomes terminal.                               |

A durable signal command carries its admission identity and requires the
admitting `ControlRuntime`. Its first token binding wins, so retrying after a
lost acknowledgment addresses the same wait even after the run advances or
settles. Two commands cannot consume the same token. A competing resolver's
different payload is a conflict, and a write acknowledgment alone is not proof
of delivery: the matching completion must be readable from engine state.

Delivery rechecks the bound token's deferred name against the signal name.
Only `WaitFor/<name>` or a positive numbered `WaitFor/<name>#<attempt>` matches;
a token for another name returns `no-match`, including after restart.

If resume temporarily clears the wait before replay parks on the same token,
delivery returns `unknown` and keeps the command bound for retry. It returns
`no-match` when another token replaces it. With `RunStore` available, a missing
or terminal bound execution also returns `no-match`. A previously stored
matching completion still proves delivery.

One failed command does not prevent the rest of a reconciliation page from
being attempted. The failed command stays pending for a later pass. Legacy
payload-only messages are not replayed because they have no durable application
identity.

## AgentAction

The authoring surface for a model-backed step. `make` declares an ordinary
`Action`, with the same tag, payload schema, `.call()`, plan node, and durable
replay as any other, and ships the implementation with it. An author never
writes `toLayer` for a model call, because there is only one implementation.

### AgentAction.make

```ts
const make: <Tag extends string, Payload, Output>(
  tag: Tag,
  options: Options<Payload, Output>
) => AgentAction<Tag, PayloadSchemaOf<Payload>, Output>
```

Declares a model-backed action and ships its implementation. The returned value
is used exactly like any other declared action: `.call()` in a flow body,
`.layer` in the composition. The layer resolves the seat through `SeatResolver`,
runs one agent loop through `Agent` inside the current flow execution, and
decodes the run's final answer with the declared output schema, spending
`Options.corrections` re-prompts before it reports a typed
`StructuredOutputFailure`.

### AgentAction.Options

| Field         | Type                                              | What it decides                                                                                                                                                                       |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payload`     | `Schema.Struct.Fields \| Flow.AnyStructSchema`    | The step's typed input, exactly as `Action.make` takes it. Required.                                                                                                                  |
| `output`      | `Schema.Top`                                      | The schema the answer must satisfy. Rendered into the prompt and enforced. Required.                                                                                                  |
| `seat`        | `ModelSelection \| ((payload) => ModelSelection)` | One seat or a non-empty ordered list. The first seat is primary, the rest are fallbacks. A callback is evaluated once per execution. Required.                                        |
| `phase`       | `SeatRouter.Phase`                                | The phase of work a `Seat.auto` seat routes as. Jev classifies it when absent. A panel route runs the members in parallel, then the merger on the answers of those that did not fail. |
| `prompt`      | `(payload) => string`                             | The task, built from the decoded payload. Required.                                                                                                                                   |
| `system`      | `ReadonlyArray<string>`                           | Stable system teaching for this step, after the host's and before the schema's.                                                                                                       |
| `corrections` | `number`                                          | How many times a decode miss may be re-prompted. Falls back to `Host.defaultCorrections`, then to one. Zero declares a first miss terminal and beats a generous host default.         |
| `repair`      | `Repair<Payload>`                                 | One bounded repair ask made after the correction budget is spent, decoded by the same schema.                                                                                         |
| `modelParams` | `ModelRequest.GenerationParams`                   | Generation parameters for the step's model calls.                                                                                                                                     |
| `maxFrames`   | `number`                                          | The cell-loop bound for this step, ahead of the host's.                                                                                                                               |

### AgentAction.Repair

```ts
interface Repair<Payload> {
  readonly prompt: (
    failure: StructuredOutput.StructuredOutputFailure,
    payload: Payload
  ) => string
  readonly seat?: string | undefined
  readonly system?: ReadonlyArray<string> | undefined
}
```

The bounded repair ask made after a correction budget is spent. The failure
carries the declared schema's digest, the issues the last candidate raised, and
how many corrections were spent. `seat` and `system` default to the step's own.

### AgentAction.AgentAction

```ts
interface AgentAction<Tag, Payload, Output> extends Action.Declared<Tag, Payload, Output, typeof AgentFailure> {
  readonly layer: Layer.Layer<Action.Requirement<Tag>, never, ...>
}
```

A declared model-backed action, plus the layer that implements it. The layer's
requirements are `Agent`, `FlowRuntime`, `Host`, `Sandbox.Sandbox`,
`SeatResolver`, `Steering.Source`, `Crypto.Crypto`, `Budget.Budget`, and
`QuotaPolicy.QuotaClassifier`.

### AgentAction.Host

The host composition every model-backed action in a run shares, provided once
through `layerHost`:

| Field                | Type                                            | What it decides                                                                                                                                                         |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry`           | `Registry.Registry`                             | The catalog a cell is shown and the registry its calls resolve against. Required.                                                                                       |
| `limits`             | `Sandbox.Limits`                                | The explicit sandbox budget every cell runs under. Required; never unlimited.                                                                                           |
| `flows`              | `ReadonlyArray<FlowBinding.Source>`             | Host executable-flow sources composed into every run's catalog.                                                                                                         |
| `implementations`    | `ReadonlyMap<string, CellCalls.Implementation>` | Host implementations for module-backed flows, keyed by flow name.                                                                                                       |
| `plugins`            | `PluginInput<FlowsHooks>`                       | Plugins composed into every run.                                                                                                                                        |
| `config`             | `FlowsConfig`                                   | Configuration composed into every run.                                                                                                                                  |
| `system`             | `ReadonlyArray<string>`                         | Stable system teaching placed ahead of every action's own.                                                                                                              |
| `capabilityEnvelope` | `ReadonlyArray<Capability.CapabilityPattern>`   | What the composition grants, and what its sealed step keys are computed under.                                                                                          |
| `maxFrames`          | `number`                                        | The default cell-loop bound for steps that declare none.                                                                                                                |
| `defaultCorrections` | `number`                                        | The correction budget for steps that declare none. Omitting both leaves the budget at one.                                                                              |
| `approvalChannel`    | `boolean`                                       | Whether this host can answer a parked step. Defaults to false.                                                                                                          |
| `modelRetryPolicy`   | `Schedule<unknown, Model.ModelFailure>`         | The transport retry ladder one model call runs under. Defaults to the port's own; `Schedule.recurs(0)` turns it off.                                                    |
| `maxQuotaParks`      | `number`                                        | How many quota waits one ask may take. Defaults to `QuotaPolicy.defaultMaxParks` (8). The bound is per ask: a corrected step starts its next ask with a full allowance. |
| `judged`             | `boolean`                                       | Whether the host's `Evaluator` is a real judge; forwarded to each step's `Agent.Options.judged`, so every subagent is armed on its own session.                         |
| `supervisor`         | `Agent.Options["supervisor"]`                   | Forwarded to each step's `Agent.Options.supervisor`, so a subagent recalls from the run's memory bank and is taught the operator's stance.                              |

### AgentAction.makeHost

```ts
const makeHost: (host: Host) => Host
```

Constructs a host composition value. A `defaultCorrections` that is not a
non-negative safe integer is refused here with `InvalidCorrectionBudget`
rather than at the first decode miss.

### AgentAction.layerHost

```ts
const layerHost: (host: Host) => Layer.Layer<Host>
```

Provides one host composition to every model-backed action in a run.

### AgentAction.AgentFailure

```ts
const AgentFailure = Schema.Union([
  StructuredOutput.StructuredOutputFailure,
  Seat.SeatUnresolved,
  Budget.BudgetExceeded,
  Budget.Skipped,
  HarnessError,
  PluginError
])
```

Everything a model-backed action can fail with. `StructuredOutputFailure` is
the one an author handles: the model answered and the answer did not fit the
declared schema after its correction budget. `SeatUnresolved` is the host
having no model for the declared seat. `BudgetExceeded` is the run having spent
what it was approved for, and `Budget.Skipped` is every later model call in a
run whose budget declared `skip-remaining`. `HarnessError` and `PluginError`
are the composition failing underneath the step.

### AgentAction.structuredOutputRejectedEvent

```ts
const structuredOutputRejectedEvent = "flows.agent.structured-output-rejected.v1"
```

The journal event one rejected answer writes on the lossy channel, carrying the
action, the attempt, the budget, the schema digest, and a digest of the issues.
The record is evidence, not a decision: nothing in the ladder reads it back,
and a composition without a journal writes nothing and behaves the same
otherwise.

### AgentAction.InvalidCorrectionBudget

```ts
class InvalidCorrectionBudget extends Schema.TaggedError<InvalidCorrectionBudget>()(
  "flows/agent/InvalidCorrectionBudget",
  { corrections: Schema.Number, message: Schema.String }
)
```

Raised synchronously when an action declaration or a host composition has an
unbounded correction budget: not a non-negative safe integer.

## Seat

The seat: what a flow or an action declares to pick the model it runs on. The
declared half is an ordinary string this module deliberately ships no schema
for; the resolved half is `Seat`, the only thing `Agent.run` accepts. For the
mental model, see [Seats](/concepts/seats/).

### Seat.Seat

```ts
interface Seat {
  readonly id: string
  readonly modelId: string
  readonly model: Model.Model
  readonly route: FlowEngineLike.RouteResolver
  readonly contextWindowTokens: number
}
```

One resolved seat: the declared `id`, the provider `modelId` used for generation
and compaction, the model to stream from, the
route that seals its requests, and the model's context window in tokens so
compaction has a real budget. `contextWindowTokens` must never be zero: zero is
the controller's "compaction disabled".

### Seat.make

```ts
const make: (seat: Seat) => Seat
```

Constructs a resolved seat. A `SeatResolver` implementation is what calls it; a
caller reaches a seat through the resolver, never by assembling one from a
model and a route it happened to hold.

### Seat.SeatUnresolved

```ts
class SeatUnresolved extends Schema.TaggedError<SeatUnresolved>()(
  "@smthrs/agent/Seat/SeatUnresolved",
  { seat: Schema.String, message: Schema.String }
)
```

A seat the host could not turn into a model route: an unknown provider, a
missing API key, an invalid endpoint. Typed, so the run refuses at the seam
rather than failing halfway through.

### Seat.auto

```ts
const auto: "auto"
```

The declared seat that asks Jev to pick the model. See
[SeatRouter](#seatrouter).

### Seat.SeatUnrouted

```ts
class SeatUnrouted extends Schema.TaggedError<SeatUnrouted>()(
  "@smthrs/agent/Seat/SeatUnrouted",
  {
    seat: Schema.String,
    reason: Schema.Literals([
      "unconfigured",
      "interrupted",
      "no_candidates",
      ...Evaluator.EvaluatorErrorCode.literals
    ]),
    message: Schema.String
  }
)
```

A seat Jev could not pick. `unconfigured` means no judge is bound or the
catalog could not list its seats; `no_candidates` means the catalog offered
no seat the routing graph picked; any other reason is the judge's own failure. No default seat is ever picked instead.

### Seat.modelIdOf

```ts
const modelIdOf: (id: string) => string
```

The model id half of a seat string: the part after the first `:`. A seat with
no separator is its own model id.

## SeatResolver

The host seam that turns a declared seat string into a live model. The
credentialed half of the composition lives here and nowhere else.

### SeatResolver.Service

```ts
interface Service {
  readonly resolve: (id: string) => Effect.Effect<Seat.Seat, Seat.SeatUnresolved>
}
```

One seat string in, one resolved seat out. Because the resolver owns the seat
vocabulary, a host may define its own: `provider:modelId` is the convention the
resolver in [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) understands, not a rule the agent
enforces.

### SeatResolver.SeatResolver

```ts
class SeatResolver extends Context.Service<SeatResolver, Service>()("@smthrs/agent/SeatResolver")
```

The `Service` tag.

### SeatResolver.make, SeatResolver.layer

```ts
const make: (implementation: Service) => Service
const layer: (implementation: Service) => Layer.Layer<SeatResolver>
```

Builds or provides a `Service` from an implementation of its one method.

### SeatResolver.makeNoop, SeatResolver.layerNoop

```ts
const makeNoop: (overrides?: Partial<Service>) => Service
const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<SeatResolver>
```

A resolver that resolves nothing. Refusing is the honest default: a composition
with no configured resolver has no credentials, and inventing a model here
would turn a missing key into a failed provider call halfway through a run.
The refusal is `SeatUnresolved` with the message "No seat resolver is
configured".

### SeatResolver.contextWindowTokensFor

```ts
const contextWindowTokensFor: (modelId: string) => number
```

The context window, in tokens, of a known model id, with a conservative floor
of 128,000 for models the catalog has not met. Never zero.

| Pattern                                                                      | Tokens    |
| ---------------------------------------------------------------------------- | --------- |
| `claude-opus-5`, `claude-sonnet-5`                                           | 1,000,000 |
| `claude-fable-5*`, `claude-mythos-5*` (numeric version suffixes)             | 1,000,000 |
| `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6` | 1,000,000 |
| Other `claude` ids, including Haiku and Bedrock/Vertex-prefixed ids          | 200,000   |
| `gpt-5`                                                                      | 400,000   |
| `gpt-4.1`                                                                    | 1,000,000 |
| `gpt-4o`                                                                     | 128,000   |
| `o1`, `o3`, `o4`                                                             | 200,000   |
| anything else                                                                | 128,000   |

## SeatRouter

Routes a run by the maintainer's routing graph. A declared seat always wins
and asks nothing. A run that declares `auto` asks Jev once, at its start, the
graph's edge questions and the system-prompt variant in one call; a pure
table picks the seat, its backups, and, for important plans and reviews, a
panel. Each subagent routes on its own prompt. A judge that cannot answer, or
a pick with nothing available, fails as `Seat.SeatUnrouted`.

### SeatRouter.seats, SeatRouter.phases

```ts
const seats: readonly ["luna", "sol", "astra", "opus", "fable", "sonnet", "kimi"]
type GraphSeat = typeof seats[number]
const phases: readonly ["plan", "implement", "review", "ui", "tool", "other"]
type Phase = typeof phases[number]
```

The graph's seats, by their `Providers.seatAliases` names, and its phases of
work.

### SeatRouter.plan, SeatRouter.backupsOf

```ts
const Answers: Schema.Struct<{
  phase: Schema.Literals<Phase>
  size: Schema.Literals<["trivial", "simple", "middle", "important"]>
  clarity: Schema.Literals<["clear", "unknowns"]>
  binary: Schema.Boolean
}>
interface Planned {
  readonly seat: GraphSeat
  readonly panel?: { readonly seats: ReadonlyArray<GraphSeat>; readonly merger: GraphSeat }
}
const plan: (answers: Answers) => Planned
const backupsOf: (seat: GraphSeat, phase: Phase) => ReadonlyArray<GraphSeat>
```

`plan` is the graph; the panel is Opus, Fable, and Astra, merged by Fable.

| Phase       | Pick                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| `plan`      | trivial: Sonnet; simple: Opus; middle: Fable; important: the panel       |
| `implement` | important with unknowns: Fable; important or unknowns: Opus; else Sonnet |
| `review`    | important: the panel; else Opus                                          |
| `ui`        | Opus                                                                     |
| `tool`      | binary and clear: Luna when trivial, else Sonnet; else Opus              |
| `other`     | Opus                                                                     |

Writing code never runs on Luna. `backupsOf` is the failover order: Fable to
Astra; Opus to Sol, or Kimi then Sol for `ui`; Kimi to none; every other seat
to Kimi.

### SeatRouter.fit, SeatRouter.Route

```ts
const RouteSchema: Schema.Struct<{
  seat: Schema.String
  backups: Schema.Array<Schema.String>
  panel: Schema.optionalKey<typeof AgentEvent.SeatPanel>
}>
type Route = typeof RouteSchema.Type
const fit: (planned: Planned, phase: Phase, available: ReadonlyArray<string>) => Route | undefined
```

Keeps the available seats of a pick. Each seat becomes the first available of
itself and its backups, and the rest available are its backups. Panel members
that land on one seat are one member with the union of their backups, in
order, less the seats on the panel. A panel left with one member is that
member's seat and backups alone. `undefined` when
the pick's seat and backups are all unavailable.

### SeatRouter.Variant

```ts
interface Variant {
  readonly id: string
  readonly description: string
  readonly system: ReadonlyArray<string>
}
```

Jev reads each `description`; a run picked for a variant is given its
`system` text.

### SeatRouter.Catalog, SeatRouter.Service, SeatRouter.layer

```ts
interface Service {
  readonly candidates: Effect.Effect<ReadonlyArray<string>, Seat.SeatUnresolved>
  readonly variants: ReadonlyArray<Variant>
}
class Catalog extends Context.Service<Catalog, Service>()("@smthrs/agent/SeatRouter/Catalog")
const layer: (implementation: Service) => Layer.Layer<Catalog>
```

What the host offers: the graph seats its `SeatResolver` runs here, and the
variants.

### SeatRouter.defaultVariants

| Id            | System text                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `change`      | "Edit the workspace to do what the task asks." "Prove the change with a check whose result is recorded before you finish." |
| `investigate` | "Read what the task needs and cite the files and lines you rely on." "Change nothing."                                     |
| `answer`      | "Reply only: the task needs an answer, not a change."                                                                      |
| `review`      | "Judge the diff you were given and cite each problem where it is." "Make no edits."                                        |

### SeatRouter.State

```ts
const State: Schema.Struct<{
  task: Schema.String
  flow: Schema.String
  description: Schema.String
  capabilities: Schema.Array<Schema.String>
}>
```

What Jev reads. Callers pass the task whole; `route` sends it as
`Judgement.task` carries it, both ends kept.

### SeatRouter.classifierFor, SeatRouter.edgeQuestions

```ts
const classifierFor: (
  variants: ReadonlyArray<Variant>,
  pinned: boolean
) => Classifier.Classifier<"seat/route", typeof State, Classifier.Questions>
```

The `seat/route` classifier: the `edgeQuestions` `phase`, `size`, `clarity`,
and `binary`, without `phase` when the caller pinned it, and `system`, a choice
over the variants with `systemInstructions`, asked only when there are at
least two. The same variants and pin return the same classifier.

### SeatRouter.Decision, SeatRouter.DecisionSchema

```ts
type Decision = {
  readonly seat: string
  readonly backups: ReadonlyArray<string>
  readonly panel?: AgentEvent.SeatPanel
  readonly variant: string | null
  readonly decidedBy: "jev" | "declared"
  readonly answers: Answers | null
  readonly latencyMs: number
  readonly candidates: ReadonlyArray<string>
  readonly asked: {
    readonly classifier: string
    readonly digest: string
    readonly questions: Readonly<Record<string, Schema.Json>>
    readonly state: Schema.Json
    readonly answers: Readonly<Record<string, AgentEvent.DecisionAnswer>>
    readonly usage?: Evaluator.Usage
  } | null
}
```

The route, the variant, and the graph's inputs. `candidates` are the seats that
were available. `asked.questions` is the wire form.

### SeatRouter.route

```ts
const route: (input: Input) => Effect.Effect<Decision, Seat.SeatUnrouted, Catalog>
```

`Input` is `{ declared, state, phase?, panel? }`. A seat other than
`Seat.auto` is kept with `decidedBy: "declared"`. Otherwise Jev answers the
edge questions, with `phase` taken from the input when given, and the route is
`fit` of `plan` over the catalog's seats. `panel: false`, for a caller that
does not fan out, routes a panel pick to its merger and its backups alone, so
no panel is recorded that does not run. An empty catalog, or a pick with
nothing available, fails as `no_candidates`.

### SeatRouter.mergePrompt

```ts
const mergePrompt: (
  task: string,
  answers: ReadonlyArray<readonly [seat: string, answer: string]>,
  failed: ReadonlyArray<string>
) => string
```

The merger's task: the task, each member's answer as `seat: answer`, and the
members that failed without one.

### SeatRouter.durable

```ts
const durable: (
  input: Input,
  key: { readonly executionId: string; readonly purpose: string }
) => Action.Action<typeof DecisionSchema, typeof Seat.SeatUnrouted, Catalog>
```

`route` as the sealed action `agent/route-seat`, keyed
`seat/route:${executionId}:${purpose}`. A replay is served the recorded
decision; a process that dies before it is recorded asks again. The key leaves
out the classifier digest, so editing a description does not re-route a run in
flight. A replay is served the recorded route, panel included.

### SeatRouter.events

```ts
const events: (
  decision: Decision,
  at: { readonly scope: string; readonly modelId: string }
) => ReadonlyArray<AgentEvent.AgentEvent>
```

`seat-routed`, with the route's `backups` and `panel`, and the reading's
`decision-settled` row (frame 0, acted); nothing for a declared seat.

### SeatRouter.variantText

```ts
const variantText: (variants: ReadonlyArray<Variant>, id: string | null) => ReadonlyArray<string> | undefined
```

The system text of the variant `id` names: `[]` for `null`, and `undefined` for
an id no variant has.

## QuotaPolicy

The classification half of quota-aware waits: it answers one question, "is
this refusal a wait, and until when?", and nothing else. The park itself
belongs to `AgentAction`. For the full behavior, see
[Park on quota refusals and limit model admission](/guides/quota-and-budgets/).

### QuotaPolicy.QuotaClassifier and QuotaPolicy.Service

```ts
interface Service {
  readonly classify: (error: unknown, nowMillis: number) => Option.Option<Park>
}

class QuotaClassifier extends Context.Service<QuotaClassifier, Service>()(
  "@smthrs/agent/QuotaPolicy/QuotaClassifier"
)
```

Decides whether a failure is a quota wait. `now` is passed in rather than read:
the classifier is pure, so a caller inside a flow takes the instant from the
injected clock and a test states it outright.

### QuotaPolicy.Park and QuotaPolicy.ParkSource

```ts
const Park = Schema.Struct({
  wakeAt: Schema.Number,
  source: ParkSource
})

const ParkSource = Schema.Literals(["reset", "retry-after", "text", "default"])
```

One classified refusal: the absolute epoch instant the run may ask again, and
on whose authority. It is a schema rather than an interface because the
decision is recorded: a replayed body waits out the deadline the first pass
chose.

### QuotaPolicy.makeDefault, QuotaPolicy.layerDefault

```ts
const makeDefault: (config?: Config) => Service
const layerDefault: (config?: Config) => Layer.Layer<QuotaClassifier>
```

The production classifier. It classifies a `ModelError` whose code is
`rate_limited` or `quota_exceeded`, or whose HTTP status is 429 or 529, and decides
the deadline in order of how much the provider said: `resetAtEpochMillis`,
then `retryAfterMillis`, then a delay parsed out of the message text, then
`Config.defaultWaitMillis`. A deadline more than `Config.maxWaitMillis` away
answers `None` and the original `ModelError` propagates, because a run parked
for a day is indistinguishable from a run that hung. A deadline already past is
a park of zero, not a refusal to park.

A TERMINAL refusal never parks, however the deadline reads. `isTerminalRefusal`
names them: an exhausted balance (`quota_exceeded` with neither
`resetAtEpochMillis` nor `retryAfterMillis`, or HTTP 402), a bad key
(`authentication`, HTTP 401/403), a model or request the provider will refuse
again (`invalid_request`, `no_route`, `content_policy`, `context_overflow`,
`invalid_provider_output`, and the 4xx statuses), and the step fails on the
attempt that earned it with the provider's own message. A `quota_exceeded` that
DOES name a reset is a subscription window, and still parks. `rate_limited`,
HTTP 429 and HTTP 529 keep their bounded wait.

```ts
const isTerminalRefusal: (error: ModelError) => boolean
```

### QuotaPolicy.Config, QuotaPolicy.defaultWaitMillis, QuotaPolicy.maxWaitMillis

```ts
interface Config {
  readonly defaultWaitMillis?: number | undefined
  readonly maxWaitMillis?: number | undefined
}

const defaultWaitMillis = 60_000
const maxWaitMillis = 3_600_000
```

`defaultWaitMillis` is how long a refusal that names no deadline parks for.
`maxWaitMillis` is the longest wait a refusal may buy before it stays a
failure.

### QuotaPolicy.makeUnclassified, QuotaPolicy.layerUnclassified

```ts
const makeUnclassified: () => Service
const layerUnclassified: () => Layer.Layer<QuotaClassifier>
```

A classifier that classifies nothing, so every refusal stays a failure. This is
an explicit safety-policy decision, not a default: the recorder's independent
capacity-refusal floor still prevents those failures from becoming durable
sealed values.

### QuotaPolicy.parseDelay

```ts
const parseDelay: (message: string) => number | undefined
```

The delay a refusal's message names, in milliseconds, read from prose forms
such as "try again in 30 seconds", "retry-after: 2 minutes", and "resets in 1
hour". `undefined` means the text named none, which is not the same as naming
zero: the caller falls back to its configured default.

### QuotaPolicy.modelErrorOf

```ts
const modelErrorOf: (error: unknown) => Option.Option<ModelError>
```

The `ModelError` a failure is, or wraps. Walks the `cause` chain, up to eight
levels, and accepts a plain object with the right shape as well as a class
instance, because a failure that has been through a journal round trip is
decoded, not reconstructed.

### QuotaPolicy.quotaParkedEvent

```ts
const quotaParkedEvent = "flows.agent.quota-parked.v1"
```

The journal event one park writes.

### QuotaPolicy.defaultMaxParks

```ts
const defaultMaxParks = 8
```

The most times one ask parks before its refusal is reported. The bound is per
ask: a step that parks, answers, and is corrected starts again from zero.

### QuotaPolicy.current

```ts
const current: Effect.Effect<Service, never, QuotaClassifier>
```

Reads the classifier a composition explicitly provided. There is deliberately
no fallback: omitting the decision is a type error.

## Budget

What a run may spend across its model calls, and what happens when it has
spent it. Enforcement sits at the model boundary in `FlowEngineLike`, which
every model call passes through, so a step that assembles its own loop cannot
evade a budget declared for the run.

### Budget.Policy, Budget.TokenBudget, Budget.LatencyBudget, Budget.OnExceeded

```ts
const OnExceeded = Schema.Literals(["fail", "warn", "skip-remaining", "park"])

interface Policy {
  readonly tokens?: TokenBudget | undefined
  readonly latency?: LatencyBudget | undefined
}

interface TokenBudget {
  readonly max: number
  readonly onExceeded?: OnExceeded | undefined
}

interface LatencyBudget {
  readonly maxMillis: number
  readonly onExceeded?: OnExceeded | undefined
}
```

Everything one composition declares about spending. An empty policy is a real
policy: it accumulates usage and refuses nothing. A latency budget bounds when
a call may start, not how long one may take; cutting a call off is
`Agent.Options.modelCallMs`, a different budget. Its zero is the run's first
budget question and is durable, so a park or restart does not grant the run the
whole interval again. The ceiling counts active time only: time the run spends
suspended on an approval, a question, or a budget raise is recorded durably and
subtracted, including across a process restart. That includes a native module
execution suspended on a `HumanTask`, an approval, or a timer.

`onExceeded` decides what running out means, and defaults to `fail`:

| Setting          | Behavior                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fail`           | The step fails with `BudgetExceeded { scope, used, max, next }`.                                                                                                                                                                               |
| `warn`           | A `flows.agent.budget-warning.v1` record is written and the call proceeds.                                                                                                                                                                     |
| `skip-remaining` | The budget latches. Every later model call in the run fails typed `skipped` without asking a provider.                                                                                                                                         |
| `park`           | The run parks with waiting reason `budget` and an approval request for a raised budget. Approving it resumes the run under the raised ceiling; denying it fails the call as `fail` does. Timeouts park too; see [RunawayGuard](#runawayguard). |

A flow sets it in frontmatter as `budget.onExceeded`, and `smthrs flow start`
sets it for one run with `--on-exceeded`, beside `--budget-tokens` and
`--budget-ms`. A composition without `Budget.Parking` treats `park` as `fail`.

### Budget.Budget and Budget.Service

```ts
interface Service {
  readonly check: (stepKey: string | undefined) => Effect.Effect<Verdict, AccountingUnavailable>
  readonly reserve: (stepKey: string) => Effect.Effect<Verdict, AccountingUnavailable, Scope.Scope>
  readonly record: (stepKey: string, usage: ModelEvent.Usage) => Effect.Effect<void, AccountingUnavailable>
  readonly usage: Effect.Effect<Usage, AccountingUnavailable>
  readonly usageOf: (runId: string) => Effect.Effect<Usage, AccountingUnavailable>
  readonly suspend: Effect.Effect<void, AccountingUnavailable>
  readonly resume: (at?: number) => Effect.Effect<void, AccountingUnavailable>
}

class Budget extends Context.Service<Budget, Service>()("@smthrs/agent/Budget")
```

- `check` previews admission without reserving capacity. A step
  the ledger has already counted proceeds, whatever the ceiling says, because
  its replay costs nothing. `undefined` gets the projection, because a call the
  ledger cannot recognize is a call the run has not made.
- `reserve` atomically admits a sealed key and holds its forecast until scope
  exit. Dispatch through this method, not a separate check-then-call sequence.
  All concurrent calls of a run must share one budget instance. Token
  forecasts are soft, not hard provider billing limits.
- `record` accounts finite non-negative usage, idempotently in its step key,
  and replaces its reservation's estimate. Failed/uncommitted writes remain
  retryable and block uncounted steps; retries must supply the same cost.
- `usage` is what the current run has spent.
- `usageOf` reads one named run's spend, from its live accumulator when this
  process is driving it and from its durable records when it is not.
- `suspend` and `resume` open and close the current run's suspension span,
  `resume` at `at` when given. The harness engine port calls `suspend` when it
  parks a frame and `resume` when it is built for the next drive; a native
  module execution calls them when it suspends and when it enters. Admission
  also closes an open span. A port or module execution whose `resume` was not
  recorded does no work: it retries the record at the instant it resumed and
  fails the run with `AccountingUnavailable` while it cannot, because an open
  span would subtract that work as parked time.

### Budget.Verdict and Budget.Usage

```ts
type Verdict =
  | { readonly _tag: "proceed" }
  | { readonly _tag: "warn"; readonly exceeded: BudgetExceeded }
  | { readonly _tag: "refuse"; readonly exceeded: BudgetExceeded; readonly failure: BudgetExceeded | Skipped }

interface Usage {
  readonly tokens: number
  readonly calls: number
  readonly largestCall: number
}
```

The answer to "may this call be made", and what one run has spent so far.
`largestCall` is what the next call is projected to cost. `calls` counts
distinct model steps, replays included exactly once.

Before a positive cost is known, a reservation holds the full token allowance.
`BudgetExceeded.used` remains actual spend; its optional `reserved` field is
the forecast held by other in-flight calls. Usage reports exclude forecasts
but include actual spend whose journal write is still pending.

### Budget.make, Budget.layer

```ts
const make: (policy: Policy, options?: Options) => Effect.Effect<Service, ConfigurationError>
const layer: (policy: Policy, options?: Options) => Layer.Layer<Budget, ConfigurationError>
```

Builds a budget over one policy. One instance serves a whole composition: the
accumulator is keyed by execution id, so a layer built once above an engine
accounts every run it drives separately. Every accounted call writes a
`flows.agent.usage.v1` record on the journal's durable channel, and the run's
first decision writes its latency clock zero as a
`flows.agent.budget-started.v1` record; a budget entering a resumed run folds
both back before it decides anything.

Acquisition validates and snapshots configuration. Token ceilings must be
non-negative safe integers; latency ceilings finite non-negative milliseconds.
`maxRuns` and `recoveryEntries` must be positive safe integers. Invalid values
and unknown exceeded policies fail with `ConfigurationError`; omit a ceiling
for no limit. Later mutations to input objects do not affect the built service.

### Budget.Options, Budget.defaultMaxRuns, Budget.defaultRecoveryEntries, Budget.looseRunId

```ts
interface Options {
  readonly maxRuns?: number | undefined
  readonly recoveryEntries?: number | undefined
}

const defaultMaxRuns = 256
const defaultRecoveryEntries = 1_000_000
const looseRunId = ""
```

`maxRuns` bounds how many runs' tallies one budget keeps in memory; an evicted
run projects both its spend and its original latency zero back from its own
durable records the next time it asks. `recoveryEntries` bounds how many
journal entries one recovery reads before it fails closed: a recovery pages to
the end of the run's journal, so the bound is the point at which the budget
declares the ledger unreadable, not a stopping point. `looseRunId` names the
tally of calls recorded outside any run, held apart from the run map so no
bound evicts it.

### Budget.makeUnbounded, Budget.layerUnbounded

```ts
const makeUnbounded: () => Service
const layerUnbounded: () => Layer.Layer<Budget>
```

A budget that accounts nothing and refuses nothing. This is an explicit
decision to give up plan-envelope spending enforcement, never a production
default.

### Budget.policyFromEnvelope, Budget.layerFromEnvelope

```ts
const policyFromEnvelope: (
  envelope: ControlSchema.Envelope,
  options?: { readonly onExceeded?: OnExceeded | undefined }
) => Policy

const layerFromEnvelope: (
  envelope: ControlSchema.Envelope,
  options?: { readonly onExceeded?: OnExceeded | undefined }
) => Layer.Layer<Budget, ConfigurationError>
```

Turns an approved plan envelope into a policy or a layer. A missing field is
not a zero budget; it is no budget at all, so an envelope that approves neither
tokens nor milliseconds produces an empty policy. The envelope's
`budget.onExceeded` wins over `options.onExceeded`, which is the composition's
default.

### Budget.Parking, Budget.raise, Budget.raisedBy

```ts
class Parking extends Context.Service<Parking, {
  readonly park: (exceeded: BudgetExceeded) => Effect.Effect<Parked, HarnessError.HarnessError>
  readonly guardsTimeouts: boolean
  readonly trip: (timeout: RunawayGuard.Timeout) => Effect.Effect<Parked, HarnessError.HarnessError>
  readonly admit: (
    subject: string
  ) => Effect.Effect<
    { readonly _tag: "proceed"; readonly continued: number } | { readonly _tag: "park"; readonly parked: Parked },
    HarnessError.HarnessError
  >
}>()("@smthrs/agent/Budget/Parking")

const raise: (budget: Envelope["budget"], exceeded: BudgetExceeded) => Envelope["budget"]
const raisedBy: (envelope: Envelope, raises: ReadonlyArray<Envelope["budget"]>) => Envelope
```

`Parking` is how a host that takes approvals parks a `park` budget.
`AgentSession` provides it: it registers a `budget/` approval request whose
envelope carries `raise`'s proposal, which is the exceeded ceiling raised to
cover what the run spent and holds, the refused call, and one more original
allowance. A resumed run spends against `raisedBy` of its card and every
approved raise. Parked time does not count against a latency ceiling, so an
approved latency raise admits the resumed call however long the park lasted.
The request's fact carries the guard's `incident`, so a restarted host re-parks
on and presents the facts the park was made on.

`guardsTimeouts` is true when the envelope's budget parks. `trip` parks the run
on a `RunawayGuard.Timeout` and `admit` answers work on a subject a timeout
may have parked; see [RunawayGuard](#runawayguard).

### Budget.current

```ts
const current: Effect.Effect<Service, never, Budget>
```

Reads the budget a composition explicitly provided. There is deliberately no
fallback.

### Budget.tokensOf

```ts
const tokensOf: (usage: ModelEvent.Usage) => number
```

The tokens one model call cost. The provider's total wins when present;
otherwise the input, output, and reasoning parts are summed.
Every supplied counter, including cache counters, must be finite and
non-negative even when a total is supplied. Malformed components return `NaN`:
they cannot cancel each other or be concealed by total precedence. `record`
refuses that value, leaves the tally unchanged, and blocks fresh admission until
the same step supplies a valid record. This validates reported usage; it does
not reconcile an invoice or recover usage a provider never reported.

### Budget errors

```ts
class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "flows/agent/BudgetConfigurationError",
  { message: Schema.String }
)

class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()(
  "flows/agent/BudgetExceeded",
  {
    scope: Schema.Literals(["tokens", "latency"]),
    onExceeded: OnExceeded,
    used: Schema.Number,
    reserved: Schema.optional(Schema.Number),
    max: Schema.Number,
    next: Schema.Number,
    message: Schema.String
  }
)

class Skipped extends Schema.TaggedError<Skipped>()(
  "flows/agent/Skipped",
  { budget: BudgetExceeded, message: Schema.String }
)

class AccountingUnavailable extends Schema.TaggedError<AccountingUnavailable>()(
  "flows/agent/BudgetAccountingUnavailable",
  {
    phase: Schema.Literals(["record", "recover"]),
    runId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
)
```

- `ConfigurationError`: invalid configuration, rejected during budget acquisition.
- `BudgetExceeded`: a run that would exceed what it was approved for. `used` is
  actual spend, `reserved` is other in-flight forecasts, `max` is the soft
  admission ceiling, and `next` the projected cost of the refused call.
- `Skipped`: a model call refused because the run's budget already latched.
  Carries the `BudgetExceeded` it latched on, so the numbers are the ones the
  first refusal reported. Quarantine-compatible: a verdict no retry can change.
- `AccountingUnavailable`: the budget could not account a run, so it will not
  say what the run may spend. `phase` says which half broke: `record` is the
  write after a call, `recover` is the read a run makes before its first
  decision. The accounting fails closed because each of these is a run whose
  spend is unknown, not zero.

### Budget.neverRetrySkipped, Budget.nonRetryableTags, Budget.skippedTag

```ts
const skippedTag = "flows/agent/Skipped"
const nonRetryableTags: ReadonlyArray<string> = [skippedTag]
const neverRetrySkipped: (policy: RetryPolicy.RetryPolicy) => RetryPolicy.RetryPolicy
```

Adds the `Skipped` tag to a retry policy's non-retryable list, so a ladder that
would otherwise re-dispatch a skipped step gives up on the first refusal.

### Budget records

| Constant               | Value                             | Channel                                                                                                                             |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `usageEvent`           | `flows.agent.usage.v1`            | Durable. Read back on resume; a write failure raises `AccountingUnavailable`. Payload schema: `UsageRecord` (`{ stepKey, spent }`). |
| `budgetStartedEvent`   | `flows.agent.budget-started.v1`   | Durable. The run's latency clock zero; the earliest recorded value wins. Payload schema: `BudgetStartedRecord` (`{ startedAt }`).   |
| `budgetSuspendedEvent` | `flows.agent.budget-suspended.v1` | Durable. Opens a suspension span; a second open span keeps the first start. Payload schema: `BudgetClockRecord` (`{ at }`).         |
| `budgetResumedEvent`   | `flows.agent.budget-resumed.v1`   | Durable. Closes the open suspension span. Payload schema: `BudgetClockRecord` (`{ at }`).                                           |
| `budgetWarningEvent`   | `flows.agent.budget-warning.v1`   | Lossy. Evidence only; nothing reads it back.                                                                                        |

A composition with no journal at all, such as the reference memory engine,
accounts within one process and recovers nothing across a restart.

## RunawayGuard

```ts
class Timeout extends Schema.TaggedError<Timeout>()("flows/agent/Timeout", {
  source: Schema.Literals(["model-call", "tool-call", "cell"]),
  subject: Schema.String,
  limitMillis: Schema.optional(Schema.Number),
  message: Schema.String
})

type Incident = typeof ControlFacts.GuardIncident.Type
const incident: (tripped: BudgetExceeded | Timeout, raised?: number) => Incident
const stopped: (facts: Incident) => HarnessError.HarnessError
```

A run whose envelope budget sets `onExceeded: park` parks on every guard for
an operator's Continue or Stop, through `Budget.Parking`:

| Guard                                                                                    | Classification | `source`            |
| ---------------------------------------------------------------------------------------- | -------------- | ------------------- |
| A token or latency ceiling                                                               | `Runaway`      | `tokens`, `latency` |
| A model call past `modelCallMs`, after its one overrun retry                             | `Stuck`        | `model-call`        |
| A tool call past its call limit, a command's own timeout, or a child await still running | `Stuck`        | `tool-call`         |
| A cell past its wall-clock limit                                                         | `Stuck`        | `cell`              |

Each park is one `budget/` approval request, with waiting reason `budget`,
whose `control.approval.requested` fact carries the exact `incident` facts
frozen when the guard tripped: `used`, `reserved`, `max`, and `next` in the
source's unit, the `message`, the timed-out `subject`, and the `allowance`
Continue authorizes. A restarted host re-parks on that request without
measuring again.

Approving is Continue. For a budget it raises the ceiling to the recorded
allowance; the ledger keeps every charge. For a timeout it authorizes one more
run of the operation under the same limit: a model call is re-issued under a
key of its own, and a tool call or cell runs again with its settled calls
replayed. The same operation timing out again asks again under a new request.
Denying is Stop: the resumed run fails with `stopped` before the operation
runs again, without calling the provider. A run whose budget does not park
keeps each timeout's own behavior: an exhausted model call fails the run, and
the cell reads a tool or cell timeout as a `timeout` call failure.

## EventSink

The host seam that watches one model-backed step while it runs. `AgentAction`
consumes the whole event stream itself to owe its caller one decoded value; a
provided sink is handed each event on the way past, and the step's answer,
correction budget, and failures are the same with a sink as without one.

With `FlowEngineLike`, model deltas arrive at the sealed model-call boundary,
after the provider stream settles. The adapter records the complete provider
stream before emitting its events. The sink does not report live provider
progress. A replay emits the recorded events again without calling the provider.

### EventSink.Service and EventSink.EventSink

```ts
interface Service {
  readonly emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
}

class EventSink extends Context.Service<EventSink, Service>()("@smthrs/agent/EventSink")
```

The method cannot fail: a host's rendering is not the run's business. One
constraint governs an implementation: `emit` runs inside the frame that
produced the event, and that frame holds the engine's write transaction. A sink
pushes onto a queue, writes to a socket, or resolves a deferred; a sink that
waits on a durable write stalls the run.

### EventSink.make, EventSink.layer, EventSink.makeNoop, EventSink.layerNoop

```ts
const make: (implementation: Service) => Service
const layer: (implementation: Service) => Layer.Layer<EventSink>
const makeNoop: (overrides?: Partial<Service>) => Service
const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<EventSink>
```

Builds or provides a sink from an implementation. The noop forms drop every
event, which is what a composition that provides no sink already does, written
down so a test can provide the absence explicitly. The service is optional:
`AgentAction` resolves it with `Effect.serviceOption`.

## StandardFlows

The built-in host capabilities, expressed as ordinary executable flows. There
is no `ctx.fs`, no `ctx.shell`, no `ctx.memory`, and no `ctx.wait`: a cell
finds a flow in `ctx.flows` and calls it. Each helper pairs a declaration that
already exists with the handler that already exists, and takes the `Context`
the host built, because a handler's requirements are the host's to supply.

Bindings explicitly publish host-authored refusal messages through
`FlowBinding.Options.publicError`. Shell, test, and search errors with codes
`command_failed` or `request_failed` remain opaque because their messages can
carry process diagnostics. A `timeout` publishes fixed text: "The command timed
out." Search `invalid_pattern` errors use fixed corrective text because native
search can return raw stderr. The portable validator's specific reason is
deliberately omitted too, since both sources share that error code. Custom
services must keep all other refusal messages suitable for cells and journals;
diagnostic causes are never selected.

### StandardFlows.filesystem

```ts
const filesystem: (
  services: Context.Context<FileSystem.FileSystem | Path.Path>,
  search?: Search.Search
) => FlowBinding.Source
```

The standard filesystem capabilities, all seven bound: `read`, `write`,
`edit`, `apply_patch`, `ls`, `glob`, and `grep` from
[`@smthrs/std`](https://std.smithers.sh/reference/api/). The search implementation defaults to
`PortableSearch.make(services)`.

### StandardFlows.shell

```ts
const shell: (
  services: Context.Context<ChildProcessSpawner.ChildProcessSpawner | Path.Path>,
  container?: Container.Container
) => FlowBinding.Source
```

Shell execution as one ordinary flow, `bash`. The container transport defaults
to `Container.makeCommand()`, the docker or podman CLI; a composition that
supplies none refuses a containerised call.

### StandardFlows.tests

```ts
const tests: (
  services: Context.Context<
    ChildProcessSpawner.ChildProcessSpawner | Evaluator.Evaluator | TestRunner.TestRunner
  >
) => FlowBinding.Source
```

The project's own test runner as one ordinary flow. A host that has no
runner binds `TestRunner.layerNoop` and the flow says so when it is called. The
`Evaluator` is what the flow attributes a non-zero exit with: Jev answers
whether the run failed about the code or about the command it was handed, so a
host binds an evaluator on a subscription seat, and a judge that does not
answer fails the call.

### StandardFlows.memory, StandardFlows.recallFlow, StandardFlows.JudgedRecallOutput

```ts
interface MemoryScope {
  readonly policy: WithMemory.Policy
  readonly provenance?: MemoryStore.Provenance | undefined
}

const memory: (
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  scope?: MemoryScope
) => FlowBinding.Source
const memory: (
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  judge: Context.Context<Evaluator.Evaluator>,
  scope?: MemoryScope
) => FlowBinding.Source

const JudgedRecallOutput: Schema.Struct<{
  rows: typeof MemoryFlows.RecallOutput
  withheld: Schema.Array<Schema.Struct<{ key: Schema.String; digest: Schema.String; p: Schema.Number }>>
  unjudged: Schema.optional<Schema.Struct<{ reason: typeof AgentEvent.UnjudgedReason; detail: Schema.String }>>
}>
```

Durable memory as two ordinary flows: `remember` from
[`@smthrs/memory`](https://memory.smithers.sh/reference/api/), and `recall`. Given a `judge`, `recall` is
`recallFlow`, the memory recall filtered by `Relevance`: it asks `judge` which
rows the query does not need and returns the rest in `rows`. A row is withheld
only at `Relevance.withholdAt`, and is listed in `withheld` by key, digest and
probability. When Jev cannot answer, every row is kept and `unjudged` says
why. The reading is journaled into the calling run through
`AgentEvent.Journal`: its `decision-settled` rows and a `relevance-settled`
row with source `recall`, or its `decision-unjudged` row. Nothing recalled
asks nothing. Without a judge, `recall` answers the recalled rows.

Without a `scope`, a call reaches any bank it names. With one, both flows are
bound through `WithMemory.withMemory` and `Flows.handlersFor`: a bank outside
`policy.namespace` fails with `invalid_namespace` before any I/O, a recall
naming no bank reads the policy namespace, and `recall: "none"` and
`retain: "never"` behave as the memory package defines them. `remember` still
requires a bank, so tell the model its bank (`<kind>-<id>`). `provenance` is
recorded on every remembered fact. The policy and provenance are the scope's
declaration identity, so give each run its own `provenance.runId` and keep it
across that run's resumes: a sealed recall recorded under one scope never
answers another. A policy that does not decode binds nothing, and composing
the catalog fails with `assembly_failed`.

### StandardFlows.clock

```ts
const clock: (
  services: Context.Context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>,
  options?: { readonly maxSeconds?: number | undefined }
) => FlowBinding.Source
```

A durable wait as one ordinary flow, `wait`. The sleep is the engine's
`DurableClock`, so a replay does not re-wait. The clock's name is the call
identity, not the duration, so two waits of equal length in one cell stay
distinct. `maxSeconds` may only lower the ceiling: a non-finite or larger value
is clamped to `defaultMaxWaitSeconds`, and a value at or below zero means "no
waiting". A wait past the ceiling is refused with a catchable message naming
the host's ceiling. This is the one helper whose context is the engine; nothing
in `Agent` imports it.

### StandardFlows.waitFlow, StandardFlows.WaitInput, StandardFlows.WaitOutput, StandardFlows.defaultMaxWaitSeconds

```ts
const defaultMaxWaitSeconds = 3_600

const WaitInput = Schema.Struct({
  seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.optional(Schema.String)
})

const WaitOutput = Schema.Struct({ waitedSeconds: Schema.Number })

const waitFlow: /* Flow "wait", effects tier "irreversible" */
```

The durable wait declaration and its schemas. One hour is the default ceiling:
long enough for an intentional backoff, short enough that a parked run remains
distinguishable from one that hung.

### StandardFlows.approval, StandardFlows.Asker, StandardFlows.askFlow, StandardFlows.askerNoop

```ts
interface Asker {
  readonly ask: (
    input: typeof AskInput.Type
  ) => Effect.Effect<typeof AskOutput.Type, HarnessError | ApprovalUnavailable>
}

const approval: (asker: Asker) => FlowBinding.Source
const askerNoop: () => Asker
```

Human approval as one ordinary flow, `ask`. The port is one method, because a
host with nobody to ask must refuse honestly rather than fake an answer:
`askerNoop` refuses with `ApprovalUnavailable`, which the cell may catch. A host
that wants the run to wait for a person fails with a `HarnessError` carrying a
`Permission.PermissionRequired`, or gates the call in `Agent.Options.authorize`.

### StandardFlows.AskInput, StandardFlows.AskOutput

```ts
const AskInput = Schema.Struct({
  question: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  to: Schema.optional(Schema.Literals(["parent", "person"]))
})

const AskOutput = Schema.Struct({
  answer: Schema.String,
  approved: Schema.Boolean
})
```

`to` says who answers. `parent`, the default, is the agent that started this
one, escalating toward the person; `person` skips the agents. A host with no
agent above the run asks the person either way.

### StandardFlows.ApprovalUnavailable

```ts
class ApprovalUnavailable extends Schema.TaggedError<ApprovalUnavailable>()(
  "@smthrs/agent/StandardFlows/ApprovalUnavailable",
  { message: Schema.String }
)
```

A host that has nobody to ask. Separate from `HarnessError` on purpose: this is
a refusal the agent can see and route around, turned into an ordinary catchable
call failure.

### StandardFlows.coreSources

```ts
const coreSources: ReadonlyArray<string>
```

The source names of every helper above and of `ChildFlows.source`. A judged
run's run-start relevance reading never judges a flow bound by one of these
sources or by `Agent.Options.pinnedSources`.

## ChildFlows

Detached child agents as three ordinary flows. There is no `ctx.spawn`, no
`ctx.send`, and no `ctx.await`: a cell delegates the way it does anything else.
Attached children need nothing here; a dynamic or markdown flow called with
`ctx.call` already runs inside its own durable boundary.

### ChildFlows.source

```ts
const source: (children: Children) => FlowBinding.Source
```

Detached child lifecycle as three ordinary flows, bound over the injected
`Children` port: `agent/spawn`, `agent/send`, and `agent/await`, all at the
`irreversible` tier.

### ChildFlows.sourceName

```ts
const sourceName: "agent/children"
```

The name of the source `ChildFlows.source` returns.

### ChildFlows.Children

```ts
interface Children {
  readonly spawn: (input: typeof SpawnInput.Type) => Effect.Effect<typeof SpawnOutput.Type, HarnessError | ChildError>
  readonly send: (input: typeof SendInput.Type) => Effect.Effect<typeof SendOutput.Type, HarnessError | ChildError>
  readonly await: (input: typeof AwaitInput.Type) => Effect.Effect<typeof AwaitOutput.Type, HarnessError | ChildError>
}

const Children: Context.Service<Children, Children>
```

The narrow child-run port a host supplies. `EngineChildren` is the durable
implementation over an engine.

### ChildFlows.makeNoop

```ts
const makeNoop: (overrides?: Partial<Children>) => Children
```

A child port that refuses every operation with
`ChildError { code: "unsupported" }`, whose refusal the cell can see and route
around.

### ChildFlows.ChildError

```ts
class ChildError extends Schema.TaggedError<ChildError>()(
  "@smthrs/agent/ChildFlows/ChildError",
  {
    code: Schema.Literals(["unsupported", "not_found", "failed"]),
    message: Schema.String
  }
)
```

A child lifecycle refusal the agent can see. Separate from `HarnessError` on
purpose: an unsupported operation or a child that failed is data the cell may
catch, while a `HarnessError` is a park or an abort the cell must never
swallow.

### ChildFlows flow declarations and schemas

| Export                                   | Declaration                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawnFlow`, `SpawnInput`, `SpawnOutput` | `agent/spawn`: start a child agent and return its id without waiting. Input `{ flow, input?, label? }`; the label is the child's identity within the run, so two concurrent children of one flow need two labels. Output `{ child }`. |
| `sendFlow`, `SendInput`, `SendOutput`    | `agent/send`: send a steering message to a running child. Input `{ child, message }`. Output `{ delivered }`.                                                                                                                         |
| `awaitFlow`, `AwaitInput`, `AwaitOutput` | `agent/await`: wait for a child to finish and return its output. Input `{ child }`. Output `{ child, output }`.                                                                                                                       |

## EngineChildren

The durable implementation of `ChildFlows.Children`: detached children as real
runs. It touches three services and no more: `FlowRuntime`, `RunStore`, and
`Control`.

### EngineChildren.make, EngineChildren.layer

```ts
const make: (
  options: Options
) => Effect.Effect<ChildFlows.Children, never, Control | Crypto.Crypto | FlowRuntime.FlowRuntime | RunStore.RunStore>

const layer: (
  options: Options
) => Layer.Layer<ChildFlows.Children, never, Control | Crypto.Crypto | FlowRuntime.FlowRuntime | RunStore.RunStore>
```

Builds or provides the durable child port:

- `spawn` starts the named flow as a run of its own, linked to the caller
  through the engine's parent-edge table and spawned with the result discarded,
  which records `onParentExit: "detach"` so the child outlives its parent. It
  answers once the child's run row exists.
- `await` reads the child's settled result out of the run store, so it works
  from a different engine, a different process, and a later incarnation. It
  waits by re-reading the child's run row on an interval rather than suspending
  the run, so a cell that awaits a long child holds its round open.
- `send` steers the child through `Control.steer`, naming the message with the
  calling step's canonical key so a re-driven round delivers it once. The
  message carries a timestamp read inside a sealed step, so a re-drive submits
  the same bytes. `Accepted` and `AlreadyApplied` receipts answer
  `delivered: true`; every other receipt fails the call.

`await` and `send` are bound as tools whose `child` is a string the cell
writes, so both are restricted to the calling run's own children. A call made
inside a run may name only ids in that run's child namespace, `childExecutionId`
of its own execution id; anything else is `ChildError { code: "not_found" }`,
whether or not such a run exists. A call made outside any run is the host
collecting a child of its own over the run store and control plane it already
holds, and is not restricted.

### EngineChildren.Options

| Field          | Type                      | What it decides                                                                                                                                                     |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows`        | `ReadonlyArray<Flow.Any>` | The flows a child may run, by `_tag`. Anything else is `ChildError { code: "not_found" }`. Registering the flow with the runtime is separate and still required.    |
| `pollInterval` | `Duration.Input`          | How long `await` waits before re-reading an unsettled child, and how long `spawn` waits between checks for the child's run row. Defaults to 250 ms.                 |
| `startTimeout` | `Duration.Input`          | How long `spawn` waits for the child's run row before reporting the child never started. Defaults to 30 seconds.                                                    |
| `awaitTimeout` | `Duration.Input`          | How long `await` polls an unsettled child before answering `ChildError { code: "still_running" }`, when the call names no `timeoutSeconds`. Defaults to 10 minutes. |

`spawn` owns its startup fiber until the row is confirmed. Timeout, store
failure, and cancellation interrupt and join it before returning failure.

A run store that cannot answer is `ChildError { code: "failed" }`, logged with
its cause, never `not_found` and never a defect.

### EngineChildren.childExecutionId

```ts
const childExecutionId: (parentExecutionId: string, label: string) => string
```

The execution id a labelled child runs under:
`child-v2:<parent length>:<parent><label length>:<label>`. Lengths count JavaScript
UTF-16 code units. Both components are delimited, including labels containing
`/child/`. Treat the returned id as opaque.
Derived rather than minted, so a parent that is re-driven spawns the same child
rather than a second one.

### EngineChildren.ChildState

```ts
const ChildState = Schema.Struct({ flowName: Schema.String })
```

The one key this port reads out of a child run's state document: the name of
the flow the child is running, because `FlowRuntime.poll` addresses an
execution by declaration and a cell only ever has the child's id.

## CellPlugin

Cell-harness hooks hosted by the shared plugin kernel from
[`@smthrs/plugin`](https://plugin.smithers.sh/reference/api/). This module augments the kernel's open hook
catalog with four dispatch points and resolves a cell host's plugin list for
the harness target.

### The hooks

Registered on `FlowsHooks` by module augmentation:

| Hook               | Kind      | What it transforms                                                                                                                                                             |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cellRegistry`     | waterfall | The one registry used for disclosure and call resolution.                                                                                                                      |
| `cellFlows`        | waterfall | The executable flow bindings the host composes. The last handler's array is both the descriptors disclosed to the model and the implementations the boundary resolves against. |
| `cellMonitors`     | waterfall | The monitors the supervisor scores, after `Monitor.defaults()` and `supervisor.monitors`. The result is validated before the first frame.                                      |
| `cellModelRequest` | waterfall | A provider-neutral request, immediately before its sealed model step. A plugin may rewrite what is asked; it does not change how long the run waits for the answer.            |

### CellPlugin.hooks

```ts
const hooks: /* engineHooks plus the four cell waterfalls, frozen */
```

The runtime hook catalog supplied when the plugin kernel resolves for a cell
host.

### CellPlugin.make

```ts
const make: (
  input?: PluginInput<FlowsHooks>,
  config?: FlowsConfig
) => Effect.Effect<Kernel.Kernel<FlowsHooks>, PluginError>
```

Resolves a cell host's plugin list through the shared kernel, for the harness
target.

### CellPlugin.registry, CellPlugin.flows, CellPlugin.monitors, CellPlugin.modelRequest

```ts
const registry: (plugins: Plugins.Service<FlowsHooks>, initial: Registry.Registry) => ...
const flows: (plugins: Plugins.Service<FlowsHooks>, initial: ReadonlyArray<FlowBinding.Binding>) => ...
const monitors: (plugins: Plugins.Service<FlowsHooks>, initial: ReadonlyArray<Monitor.Monitor>) => ...
const modelRequest: (plugins: Plugins.Service<FlowsHooks>, initial: ModelRequest.ModelRequest) => ...
```

Run the four ordered waterfalls.

### CellPlugin.fromBindings

```ts
const fromBindings: (options: {
  readonly name: string
  readonly bindings: ReadonlyArray<FlowBinding.Binding>
  readonly enforce?: "pre" | "post" | undefined
  readonly apply?: Apply | undefined
}) => FlowsPlugin<FlowsHooks>
```

The one-liner for authoring a harness plugin that contributes executable flows.
Ordering, `apply` filtering, and the config waterfall are the kernel's,
unchanged; a plugin that needs to transform other plugins' flows writes the
`cellFlows` hook itself.

### CellPlugin.identity

```ts
const identity: (
  layers: ReadonlyArray<string>,
  plugins: Plugins.Service<FlowsHooks>,
  config: ResolvedConfig
) => Effect.Effect<string, PluginError>
```

Computes the order-sensitive identity of a resolved host composition, as
`flows/cell-composition/v1:<digest>`. Plugin and layer order can change request
and registry semantics, so the ordered declarations and resolved config are
folded into one digest inside the otherwise set-like layer material.

## SmithersPlugin

A cell plugin that teaches an agent Smithers itself. It uses the two
`CellPlugin` hooks above and adds no `ctx` global: a cell reaches its flows
with `ctx.call`, like every other capability.

```ts
import { SmithersPlugin } from "@smthrs/agent"

agent.run({ ...options, plugins: [SmithersPlugin.make(ports)] })
```

| Flow               | Needs `ports` | What it does                                                                       |
| ------------------ | ------------- | ---------------------------------------------------------------------------------- |
| `smithers.guide`   | no            | Returns `knowledge` for `{ topic?: "packages" \| "cli" \| "authoring" \| "all" }`. |
| `smithers.flows`   | yes           | Lists the project flows a model may start.                                         |
| `smithers.run`     | yes           | Requests a run `{ id, flow, input? }` and returns its receipt at once.             |
| `smithers.inspect` | yes           | Reads one run's status, steps, and result without waiting.                         |

### SmithersPlugin.make

```ts
const make: (ports?: Ports) => FlowsPlugin<FlowsHooks>
```

The plugin, named `smithers`, applied to the harness target. `cellFlows`
appends the flows above; a name already in the catalog fails catalog assembly
instead of being shadowed. `cellModelRequest` appends `brief` to the system
prompt once.

### SmithersPlugin.Ports

```ts
interface Ports {
  readonly list: () => unknown
  readonly run: (request: { id: string; flow: string; input?: { [key: string]: Schema.Json } }) => unknown
  readonly inspect: (id: string) => unknown
}
```

The host's own run path. Each port returns data or a promise of it; the flow
returns it as plain JSON. A thrown error becomes the call's failure text.
The model chooses every `id` and `flow`, so the host scopes them: `inspect`
answers only runs this session may read, and `run` refuses flows that are not
model-invocable and routes the launch through the host's own approval.

### SmithersPlugin.knowledge, SmithersPlugin.brief, SmithersPlugin.guide

`knowledge` holds `packages`, `cli`, and `authoring` facts, each
`{ name, about }`. `brief` is the short system teaching. `guide` is the
`smithers.guide` binding; `flows(ports?)` returns every binding `make`
contributes. `Topic` is the guide's topic schema and `name` is `"smithers"`.

## PromoteFlows

Turning the script the model just ran into a saved flow, as two ordinary flows.
For the walkthrough, see [Save the script a run wrote as a flow](/guides/promote-flows/).

### PromoteFlows.source

```ts
const source: (
  services: Context.Context<CellHistory.CellHistory | FlowStore.FlowStore>,
  options?: Options
) => FlowBinding.Source
```

Promotion as two ordinary flows:

- `flows/show-script` hands the model its own turn back: the source of every
  cell it executed, in order, plus the rules a saved flow has to follow and the
  file skeleton to fill in. It reads the `CellHistory` the controller records
  into, so a host that keeps no history reports an empty script.
- `flows/write-flow` takes the three files that come back and writes them
  through a `FlowStore`. When a `Registry` is in context it is refreshed
  afterwards. Pass that same registry to `Agent.run`: a successful refresh
  makes the saved model-invocable flow visible and callable next frame. Each
  frame journals its descriptor snapshot for replay. The id is validated before
  the store is asked, so a bad id is never misread as "nowhere to save".

### PromoteFlows.Options

| Field           | Type     | What it decides                                     |
| --------------- | -------- | --------------------------------------------------- |
| `bestPractices` | `string` | Replaces the rules a saved flow has to follow.      |
| `template`      | `string` | Replaces the `flow.ts` skeleton the model fills in. |

### PromoteFlows.bestPractices, PromoteFlows.flowTemplate

The house rules and the `flow.ts` skeleton `flows/write-flow` expects back. A
host whose flows are laid out differently replaces both through `Options`.

### PromoteFlows flow declarations and schemas

| Export                                                                        | Declaration                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showScriptFlow`, `ShowScriptInput`, `ShowScriptOutput`                       | `flows/show-script`: return the source of every cell this turn has executed, plus the rules and the skeleton. Input `{ bestPractices? }` (extra guidance appended after the house rules). Output `{ cells, bestPractices, template }`.                                                                                                                                     |
| `writeFlowFlow`, `writeFlowCapabilities`, `WriteFlowInput`, `WriteFlowOutput` | `flows/write-flow`: write `flow.ts`, `flow.e2e.ts`, and the fixture under `flows/<id>/`. Input `{ id, description, flowSource, testSource, fixtureJson }`. Output `{ files }`, the root-relative paths written. Declares `writes: ["flows/**"]` and `capabilities: writeFlowCapabilities` (`["fs:write:/flows/**"]`), so a run whose envelope lacks that write is refused. |

## FlowStore

Where a saved flow's files land: one contract a checkout, a browser host, and
a test all satisfy, so `PromoteFlows` never learns which one it is talking to.

### FlowStore.Service and FlowStore.FlowStore

```ts
interface Service {
  readonly write: (id: string, files: Record<string, string>) => Effect.Effect<WriteResult, FlowStoreError>
  readonly list: () => Effect.Effect<ReadonlyArray<SavedFlow>, FlowStoreError>
}

class FlowStore extends Context.Service<FlowStore, Service>()("@smthrs/agent/FlowStore")
```

`write` keys files by their root-relative paths and reports them back
unchanged. `list` answers every flow the store holds, by id.

### FlowStore.SavedFlow, FlowStore.WriteResult

```ts
interface SavedFlow {
  readonly id: string
  readonly files: ReadonlyArray<string>
}

interface WriteResult {
  readonly files: ReadonlyArray<string>
}
```

### FlowStore.makeFileSystem, FlowStore.layerFileSystem

```ts
const makeFileSystem: (fs: FileSystem.FileSystem, path: Path.Path, root: string) => Service
const layerFileSystem: (root: string) => Layer.Layer<FlowStore, never, FileSystem.FileSystem | Path.Path>
```

A store over a directory on the host filesystem. Before creating directories,
it validates every path with the injected `Path` service. Absolute paths,
paths that resolve outside the root (including Windows backslash traversal),
root directory targets, and overlapping file paths are refused. Symbolic links
below the root are refused with `FlowStoreError { code: "invalid_path" }`.

Writes to the same resolved root are serialized within this process, including
across store instances and saves of the same flow.
Each save stages all new files and copies of existing files in a temporary
directory inside the root. Each target is then replaced by an atomic rename.
A publication failure restores replaced files and removes newly published
files. Staging is cleaned on failure or interruption; interruption during
publication waits for the full set to be installed or restored. If rollback
also fails, the error reports the directory where recovery files are retained.

Individual renames are atomic. External readers can observe the file set
between renames. This does not provide crash recovery or coordinate writers
in other processes.
`PromoteFlows` writes `<root>/flows/<id>/{flow.ts,flow.e2e.ts,fixtures/<id>.json}`.

### FlowStore.makeMemory, FlowStore.layerMemory

```ts
const makeMemory: (written?: Map<string, string>) => Service
const layerMemory: (written?: Map<string, string>) => Layer.Layer<FlowStore>
```

A store over an in-memory map, keyed by path. The map is the caller's, so a
test writes through the store and reads the bytes back without a filesystem.
Every key must be a file path under `flows/<id>/` with no empty, `.`, or `..`
segment; otherwise the whole write fails with
`FlowStoreError { code: "invalid_path" }` before any key is stored.

### FlowStore.makeNoop, FlowStore.layerNoop

```ts
const makeNoop: (overrides?: Partial<Service>) => Service
const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<FlowStore>
```

A store that saves nothing, refusing with
`FlowStoreError { code: "unsupported" }` and a message the model can read.

### FlowStore.validateId, FlowStore.idPattern

```ts
const idPattern = /^[a-z][a-z0-9-]*$/
const validateId: (id: string) => Effect.Effect<void, FlowStoreError>
```

Refuses an id no flow directory could be named. The store is the last place an
id is still text: every path a write builds comes from it, so the check runs
before any of them are built, and `../escape` is refused as a bad id rather
than caught as a surprising write outside the root.

### FlowStore.FlowStoreError, FlowStore.FlowStoreErrorCode

```ts
const FlowStoreErrorCode = Schema.Literals(["invalid_id", "invalid_path", "write_failed", "unsupported"])

class FlowStoreError extends Schema.TaggedError<FlowStoreError>()(
  "@smthrs/agent/FlowStore/FlowStoreError",
  { code: FlowStoreErrorCode, message: Schema.String, cause: Schema.optional(Schema.Unknown) }
)
```

Every message is written for the model that will read it back as a call
failure, because the cell that asked to save a flow is the only thing that can
correct the id or reissue the write.

## FlowEngineLike

The production `EngineLike` binding: the harness engine port executed on the
durable flow engine from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/). Not to be confused
with the `FlowEngineLike` that [`@smthrs/testing`](https://testing.smithers.sh/reference/api/) exports, which
adapts the same engine to that library's conformance contract for engine
implementations; the two share a backing engine and nothing else. For the port
mapping and the key rules, see [The engine port](/concepts/engine-port/).

### FlowEngineLike.make, FlowEngineLike.layer

```ts
const make: (
  options: Options
) => Effect.Effect<
  EngineLike.EngineLike,
  never,
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Budget.Budget | QuotaPolicy.QuotaClassifier
>

const layer: (options: Options) => Layer.Layer<EngineLike.EngineLike, never, ...>
```

Constructs or provides the durable harness engine port. `FlowInstance` is
per-execution, so this must be built inside a running flow body. The captured
services are supplied back to every activity, which is what keeps the port's
streams requirement-free the way `EngineLike` declares them.

The port implements `EngineLike.resolve`: it returns the request unchanged and
the `routeId` and `protocolId` of the `Route.PreparedRequest` its
`RouteResolver` prepares, which exists before any credential is signed on. A
request no route accepts resolves with no binding, and `sealStep` reports the
route's error. `Agent` wraps the port so `resolve` returns the request its
`cellModelRequest` plugins rewrote, and runs those plugins once per model
call.

### FlowEngineLike.Options

| Field              | Type                                              | What it decides                                                                                                                                                           |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`            | `Model.Model`                                     | The model sealed steps stream from. Required.                                                                                                                             |
| `route`            | `RouteResolver`                                   | Resolves the route one sealed request is prepared under. Required.                                                                                                        |
| `calls`            | `CallRunner`                                      | The cell loop's flow-call seam. Without one, a cell call is refused with a typed engine failure.                                                                          |
| `modelRetryPolicy` | `Schedule<unknown, Model.ModelFailure>`           | Bounded model-boundary retry policy. Defaults to `defaultModelRetryPolicy`.                                                                                               |
| `layers`           | `ReadonlyArray<string>`                           | The resolved composition identity every durable key folds in: the layer set the host actually built, plus the resolved plugin list in resolution order.                   |
| `capabilities`     | `Readonly<Record<string, ReadonlyArray<string>>>` | The composition's complete effective authority, if the host knows it. Omitting it is the honest "unknown", and the engine pins every sealed key to the current execution. |

### FlowEngineLike.RouteResolver, FlowEngineLike.routeResolver

```ts
interface RouteResolver {
  readonly prepare: (
    request: ModelRequest.ModelRequest
  ) => Effect.Effect<Route.PreparedRequest, ModelError.ModelError>
}

const routeResolver: <Body, Frame, Event, State>(
  route: Route.Route<Body, Frame, Event, State>
) => RouteResolver
```

The port needs `Route.prepare` and nothing else, so a consumer can supply a
configured route, a router, or a recorded resolver in tests.

### FlowEngineLike.CallRunner, FlowEngineLike.WorkspaceCallRunner

```ts
interface CallRunner {
  readonly authorize?: (call: Cell.Call) => Effect.Effect<void, HarnessError.HarnessError>
  readonly run: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError.HarnessError>
}

interface WorkspaceCallRunner {
  readonly authorize?: (call: Cell.Call) => Effect.Effect<void, HarnessError.HarnessError>
  readonly run: (
    call: Cell.Call
  ) => Effect.Effect<Cell.CallResult, HarnessError.HarnessError, WorkspaceSandbox.Workspace>
}
```

Executes one flow call issued from inside a running cell. The runner owns
lookup, decoding, attenuation, and placement; the port owns only durability.
`authorize` is checked before the durable boundary opens: an activity's outcome
is journaled, so a permission requirement raised from inside one would replay
forever and no later grant could unblock it. A `WorkspaceCallRunner` may also
touch the workspace it runs inside; a plain `CallRunner` satisfies it too.

### FlowEngineLike.sandboxed

```ts
const sandboxed: (
  sandbox: WorkspaceSandbox.Service,
  runner: WorkspaceCallRunner,
  options?: { readonly layers?: ReadonlyArray<string> | undefined }
) => Effect.Effect<CallRunner, never, Crypto.Crypto>
```

Runs every cell call inside an outer workspace transaction. A call's declared
effects are checked, not trusted: a call that reads or writes outside what the
cell chose comes back `Invalidated`, and the adapter turns that into a catchable
call failure with the speculative changes discarded. Materialization is
explicit, so a conflicting concurrent write is a typed refusal instead of a
lost update. It is a `CallRunner` decorator rather than an option on `make`, so
a host chooses the transaction boundary by composition.

### FlowEngineLike.RecordedModelStep

```ts
const RecordedModelStep = Schema.Union([
  Schema.Array(ModelEvent.ModelEvent),
  Schema.Struct({
    events: Schema.Array(ModelEvent.ModelEvent),
    error: Schema.optional(ModelError.ModelError),
    correction: Schema.optional(Schema.Int)
  })
])
```

The durable outcome of one sealed model step. The array branch is the format
written before model-boundary retries existed and stays decodable so a parked
run can resume onto a newer package. New records use the object branch, so a
terminal typed model failure replays after its retry events, and the
`correction` ordinal names which structured-output correction the call belonged
to.

### FlowEngineLike.Correction

```ts
const Correction: Context.Reference<number | undefined>
```

The correction ordinal the model calls made under it belong to. `AgentAction`
sets it around each rung of its ladder and the port stamps it onto the rung's
sealed record. It is deliberately not key material: the session already
distinguishes the rungs. Absent by default, which is the honest reading of a
model call made outside any ladder.

### FlowEngineLike retry policy constants

| Constant                        | Value                | What it bounds                                                                                                                                                                                              |
| ------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultModelRetryBaseMillis`   | 1,000                | The first transport retry delay.                                                                                                                                                                            |
| `defaultModelRetryFactor`       | 2                    | The factor each successive delay multiplies by.                                                                                                                                                             |
| `defaultModelRetryTimes`        | 5                    | How many times one sealed step retries.                                                                                                                                                                     |
| `defaultModelRetryWindowMillis` | 45,000               | The wall clock the ladder may span. Whichever of the count and the window arrives first ends the ladder.                                                                                                    |
| `defaultModelRetryPolicy`       | jittered exponential | The production transport retry budget, composed from the four values. Sleeps are taken on the injected clock and jitter on the injected `Random`.                                                           |
| `defaultModelOverruns`          | 1                    | How many times one sealed step re-issues a call its `modelCallMs` budget cut off, with overrun teaching prepended. An overrun costs a whole armed ceiling, so it does not share the transport retry budget. |
| `defaultModelIdleMs`            | 300,000              | How long a model stream may send nothing before it is cut off as `transport` and re-issued without teaching, at most `defaultModelOverruns` times. Armed only below the call's `modelCallMs` ceiling.       |

### FlowEngineLike.workspaceRelative, FlowEngineLike.callBoundary, FlowEngineLike.callMaterial

```ts
const workspaceRelative: (path: string) => string
const callBoundary: (call: Cell.Call) => FileBoundary
const callMaterial: (call: Cell.Call, layers?: ReadonlyArray<string>) => KeyMaterial.KeyMaterial
```

The conversions between the agent-side declaration and the engine's file
boundary, and the workspace sandbox's content key over the declared call
material. `workspaceRelative` strips the leading `/`: the declaration's
"anywhere" (`/**`) and the boundary's "everything under the root" name the same
set. `callBoundary` maps a hermetic mode to a hard boundary. `callMaterial` is
the sandbox's separate content key, intentionally not equal to the durable
activity key, which nests effects under the body and includes the composition
digest.

## Checkpointed

Running one cell call against a pinned tree instead of the live one.
`@smthrs/harness` decides whether a call may name a checkpoint; this module is
the other half, the `CallRunner` decorator that asks the store for that tree as
a directory, points the call at it, and gives the directory back when the call
ends.

### Checkpointed.decorate, Checkpointed.checkpointed, Checkpointed.unpinned

```ts
const decorate: (runner: FlowEngineLike.CallRunner) => Effect.Effect<FlowEngineLike.CallRunner>
const checkpointed: (store: Checkpoints.Checkpoints, runner: FlowEngineLike.CallRunner) => FlowEngineLike.CallRunner
const unpinned: (runner: FlowEngineLike.CallRunner) => FlowEngineLike.CallRunner
```

`decorate` wraps a runner with checkpoint materialization when the composition
has a `Checkpoints` store, and with `unpinned` when it does not. A composition
that pins nothing is still wrapped: a call carrying an `at` must never quietly
read the live tree instead, so `unpinned` refuses it with
`checkpoint_unavailable`. A store that cannot hand the tree back is also a
catchable `checkpoint_unavailable` refusal, not a failed run.

### Checkpointed.unpinnedFact

```ts
const unpinnedFact: string
```

The system text `Agent.run` adds to a run whose composition has no
`Checkpoints` store. It says that `ctx.base`, `ctx.checkpoint()` and every
`at`-carrying call are refused, and that a baseline is taken by running the
check before the edit.

### Checkpointed.unsupported, Checkpointed.absolute, Checkpointed.outside

```ts
const unsupported: (flow: string) => Cell.CallResult
const absolute: (flow: string, path: string) => Cell.CallResult
const outside: (flow: string, path: string) => Cell.CallResult
```

The three `checkpoint_unsupported` refusals: a flow that names what it touches
rather than where it runs, an absolute path, and a path that climbs out of the
checkpoint with `..`. Each message names the remedy, because a refusal without
a next action costs the run a frame.

## WorkspaceObservation

Measuring the workspace a run is changing, so the loop's mutation accounting is
a fact about the tree rather than a claim a declaration made. `bash` is why it
exists: a spawned process writes wherever it likes and tells nobody.

### WorkspaceObservation.Observer

```ts
interface Observer {
  readonly observe: Effect.Effect<EngineLike.Observation, HarnessError>
}

const Observer: Context.Service<Observer, Observer>
```

The port `EngineLike.observe` is produced through. A service rather than an
option, because it is host equipment: whoever composed a workspace is the only
party that knows where its root is. A composition that provides none leaves the
loop on declared writes, and the journal says so.

### WorkspaceObservation.observe, WorkspaceObservation.make, WorkspaceObservation.layer

```ts
const observe: (
  fs: FileSystem.FileSystem,
  root: string,
  options?: Options
) => Effect.Effect<EngineLike.Observation>

const make: (fs: FileSystem.FileSystem, root: string, options?: Options) => Observer

const layer: (root: string, options?: Options) => Layer.Layer<Observer, never, FileSystem.FileSystem>
```

A pruned walk of the workspace root that folds every kept file's path, size,
and modification time into one digest. The listing is depth-first in sorted
order, so two measurements of an unchanged tree are byte-identical. Hand it the
host's own `FileSystem`, not the kernel-guarded one: the walk is stat-only,
never follows a symlink, and every path it builds starts from the root it was
constructed with, while a guarded filesystem bills one helper process per file.

### WorkspaceObservation.Host, WorkspaceObservation.observeHost, WorkspaceObservation.layerHost

```ts
type Measured =
  | { readonly _tag: "File"; readonly size: number; readonly modified: number }
  | { readonly _tag: "Directory" }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Failed"; readonly method: string; readonly cause: PlatformError.PlatformError }

interface Host {
  readonly entries: (
    directory: string,
    keep: (name: string) => boolean
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly measured: Measured }>, PlatformError.PlatformError>
}

const fileSystemHost: (fs: FileSystem.FileSystem) => Host
const observeHost: (host: Host, root: string, options?: Options) => Effect.Effect<EngineLike.Observation>
const layerHost: (host: Host, root: string, options?: Options) => Layer.Layer<Observer>
```

The host operation the walk is built on: one directory, listed and measured in
one call, in any order. `observe` is `observeHost(fileSystemHost(fs), ...)`,
two `FileSystem` calls per entry. `NodeControl.layerObserver` composes a Node
host that reads entry types off the listing and measures a directory's files
with concurrent `lstat`s: 0.8 s instead of 5.4 s on a 50,000-file tree. Both
hosts produce the same digest for the same tree.

### WorkspaceObservation.Options

| Field            | Type                    | What it decides                                                                                                                                                                                          |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prune`          | `ReadonlyArray<string>` | Directory names never descended into. Defaults to `defaultPrune`.                                                                                                                                        |
| `ignoreSuffixes` | `ReadonlyArray<string>` | Name suffixes left out of a measurement. Defaults to `defaultIgnoreSuffixes`.                                                                                                                            |
| `excludePaths`   | `ReadonlyArray<string>` | Exact root-relative paths to omit, using `/` separators. Excluding a directory also omits its descendants; similarly named paths elsewhere remain measured.                                              |
| `maxPaths`       | `number`                | The largest number of files one measurement covers. Defaults to 50,000. A walk that stops there reports `complete: false`, and the controller decides changed-ness from what the frame's calls declared. |

### WorkspaceObservation.defaultPrune, WorkspaceObservation.defaultIgnoreSuffixes

`defaultPrune` skips version-control internals, dependency trees, and the
caches Python, Node, Rust, and their test runners keep beside the sources:
`.git`, `.jj`, `.hg`, `.svn`, `.flows`, `node_modules`, `__pycache__`,
`.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.nox`, `.venv`, `venv`,
`.eggs`, `.gradle`, `.turbo`, `.next`, `target`. `defaultIgnoreSuffixes` skips
compiled output: `.pyc`, `.pyo`, `.pyd`, `.so`, `.o`, `.a`, `.dylib`, `.class`,
`.egg-info`.

### WorkspaceObservation.layerNoop

```ts
const layerNoop: Layer.Layer<Observer>
```

Provides an observer that reports a failure rather than a measurement. This
exists so a host can prove the failing path; a composition that wants "measures
nothing" provides no observer at all.

## WorkspaceSandbox

The engine-store workspace transaction contract, re-exported from
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) so the harness and the engine stay
on one transaction seam. See that package's reference for the full surface.

## InMemoryWorkspaceSandbox

The deterministic in-memory implementation of the workspace sandbox.

### InMemoryWorkspaceSandbox.make

```ts
const make = WorkspaceSandbox.makeMemory
```

Creates the engine-store conformance sandbox over an in-memory host.
`InitialFiles`, `HostFile`, and `InMemoryWorkspaceSandbox` are type aliases for
the engine-store models.

## MemorySnapshotRecorder

The durable implementation of `@smthrs/memory`'s `SnapshotRecorder` port: it
translates a snapshot identity into an `EngineLike.record` boundary that holds
the snapshot's rows, so a memory snapshot a run takes is journaled and replays
with it.

### MemorySnapshotRecorder.make, MemorySnapshotRecorder.layer

```ts
const make: (engine: EngineLike.EngineLike) => SnapshotRecorder.Service
const layer: Layer.Layer<SnapshotRecorder.SnapshotRecorder, never, EngineLike.EngineLike>
```

Builds the memory recorder backed by a harness engine, or provides durable
opening-memory snapshots through the current harness engine. A recorder failure
is fatal rather than continued past: continuing with a live value would
recreate the replay divergence the adapter exists to prevent.

`SeatResolver.contextWindowResolver(service)` adapts a host resolver to the
harness's `contextWindowTokensFor(seat)` callback. The session and action
adapters use it when steering, so logical seats such as `reviewer` retain the
host's context budget. A refused seat becomes a typed harness assembly failure.

## ScriptedJudge

`import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"`

`layer` is an explicit offline completion fixture. It reads a claim's named
commands against `checksRun` and `lastCheck`, rejects commands absent from the
record, and refuses question sets other than `complete`, `overclaims`, and
`invented`. Its command syntax is deliberately limited; it is not a general
language judge or a production default. A whole host must dispatch its other
classifiers too; see [the whole-host fixture](https://github.com/smithersai/smithers/blob/main/flows/test/fixtures/scripted-judge.ts).

`layerAll` answers every classifier the agent asks: completion, relevance,
compaction marks, seat routing and the supervisor. Each answer is computed from
the state by the matching `answer.*` answerer, and `answererFor(ids)` picks one
by question ids. A question-id set no classifier asks fails `unreachable`.
