---
title: "API reference"
description: "The complete @smthrs/harness API: the cell-first controller, the sandbox and engine ports, the cell contract, flow binding, and every error union, with behavior and signatures from source."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/api.md"
---

`@smthrs/harness` is the built-in agent loop, expressed as pure translation
plus a small set of service ports. It holds no scheduler, no database, no
transport and no provider client: `EngineLike` is the port a durable engine
answers, `Sandbox` is the port a script realm answers, `Steering.Source` is the
port a notification queue answers, and [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the
assembled production composition over the durable engine.

The loop is cell-first. One frame is

```text
model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition
```

The model emits fenced `cell` blocks; they run as one program inside a realm
that outlives the frame; the only authority the program holds is
`ctx.call(flowName, input)`; and the program states its intent by calling
`ctx.done(output)`, `ctx.park(reason, message)`, or neither, which continues.
`Sandbox.replTransition` turns that into the transition the journal records.

## Example

```ts
import * as Cell from "@smthrs/harness/Cell"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { Effect } from "effect"

const frame = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const realm = yield* (yield* QuickJSSandbox.make).openRealm!({ flows: {} })
  const call = () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
  return yield* realm.evaluate({ cell: Cell.source(`ctx.done("hi")`), frame: 0, call })
})))
console.log(
  frame.outcome._tag,
  frame.outcome._tag === "settled" && frame.outcome.transition._tag === "complete"
    ? frame.outcome.transition.output
    : ""
)
```

```text
settled hi
```

## Entry points

| Import                           | What it is                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/harness`                | The root barrel: the 32 namespaces listed in the module index.                                                       |
| `@smthrs/harness/<Module>`       | Any top-level module directly, for example `@smthrs/harness/CellTurn`.                                               |
| `@smthrs/harness/QuickJSSandbox` | The QuickJS-WASM `Sandbox` binding. Not re-exported from the root, because it carries an embedded WebAssembly build. |
| `@smthrs/harness/package.json`   | The package manifest.                                                                                                |

The `./internal/*` and `./*/index` subpaths map to `null` and do not resolve.

## Module index

33 public modules, 496 documented exports. Each module's full export table is
in the [module and export inventory](/reference/); the sections below state
behavior and signatures.

| Module                       | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | What it is                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `HarnessError`               | `HarnessErrorCode`, `HarnessError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Stable failures reported at the harness translation boundary.                                            |
| `AgentEvent`                 | `Observer`, `Journal`, `RelevanceKind`, `CompactionMark`, `CompactionPin`, `MonitorKind`, `Stance`, `Suppression`, `UnjudgedReason`, `DisciplineArmed`, `TurnOpened`, `ModelRequested`, `ModelDelta`, `ModelRetried`, `ModelSettled`, `CellProduced`, `CellRejectedInFrame`, `CellCallStarted`, `CellCallSettled`, `CellPrinted`, `CellSettled`, `TransitionApplied`, `ReadOnlyDemandIssued`, `ReadOnlyDemanded`, `RepeatDemanded`, `NarrowedDemanded`, `UnmovedDemanded`, `UnresolvedDemanded`, `FailedCallDemanded`, `UnobservedDemanded`, `NarrowOnlyDemanded`, `ClaimDemanded`, `DecisionAnswer`, `decisionAnswers`, `DecisionSettled`, `SupervisorSettled`, `SupervisorUnjudged`, `DecisionUnjudged`, `RelevanceSettled`, `RelevanceRestored`, `SeatPanel`, `SeatRouted`, `SufficiencyObserved`, `VacuousVerificationObserved`, `MutationObserved`, `CheckpointMinted`, `Suspended`, `CompactionSettled`, `SteeringDrained`, `TurnClosed`, `PermissionRequired`, `Aborted`, `Resolved`, `AgentEvent`, `eventType` | Serializable events emitted by harness adapters.                                                         |
| `Plan`                       | `Child`, `Batch`, `ChildResult`, `ChildProgress`, `ChildSettled`, `SpliceEvent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Local structural plan nodes used at the harness-to-engine boundary.                                      |
| `EngineLike`                 | `SuspendReasonCode`, `SuspendReason`, `SealedModelStep`, `BoundaryIdentity`, `DurableSchema`, `RecordBoundary`, `Observation`, `Snapshot`, `Binding`, `Resolved`, `CaptureRequest`, `EngineLike`, `make`, `layer`, `resolve`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Narrow engine port consumed by the built-in harness.                                                     |
| `Tokens`                     | `Count`, `Segment`, `Accounting`, `Estimator`, `estimate`, `count`, `combine`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Deterministic token accounting for context windows.                                                      |
| `ContextWindow`              | `TypeId`, `SegmentKind`, `SegmentZone`, `Content`, `Mark`, `ContextWindowErrorCode`, `ContextWindowError`, `Segment`, `ContextWindow`, `SegmentInput`, `MakeOptions`, `makeSegment`, `make`, `empty`, `appendTurn`, `prefixDigest`, `compactMarked`, `compactPrefix`, `compact`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The immutable, provider-neutral context assembled for one model request.                                 |
| `Transcript`                 | `journalVersion`, `validateJournal`, `TranscriptErrorCode`, `TranscriptError`, `ProjectedMessage`, `ProjectedState`, `CellEvidence`, `projectStateResult`, `projectResult`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Transcript projection from durable journal entries.                                                      |
| `Compaction`                 | `summaryInstruction`, `InvalidStep`, `Summarizer`, `CompactionStep`, `TokenAccounting`, `shouldCompact`, `selectPrefix`, `declare`, `summaryRequest`, `apply`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Declarations for sealed transcript-summary steps.                                                        |
| `Steering`                   | `Delivery`, `SteerInsert`, `QueueInsert`, `Insert`, `SeatChange`, `ThinkingChange`, `Item`, `Queue`, `Drain`, `BoundaryInput`, `DrainRecord`, `drainRecord`, `empty`, `enqueue`, `drainAtClose`, `Source`, `SourceInput`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Turn-boundary steering values and their source contract.                                                 |
| `Notifications`              | `Options`, `make`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Adapter from the durable notification queue to harness turn boundaries.                                  |
| `Cell`                       | `Language`, `Source`, `digestOf`, `source`, `Continue`, `Complete`, `Park`, `Transition`, `renderText`, `RejectionCode`, `Settled`, `Raised`, `Rejected`, `Outcome`, `FlowProjection`, `project`, `CallFailureCode`, `defaultCallFailureCode`, `callFailureHint`, `CallIdentity`, `declarationDigest`, `Call`, `baseCheckpoint`, `checkpoint`, `checkpointOf`, `CallResult`, `CallSuccess`, `CallFailure`, `CallResultVariant`, `decodeCallResult`, `decodeOutcome`, `decodeTransition`, `callFailure`, `Extracted`, `extract`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The cell contract.                                                                                       |
| `Sandbox`                    | `SandboxErrorCode`, `SandboxError`, `Invocation`, `Mint`, `Minter`, `mintUnavailable`, `Handler`, `Limits`, `Capabilities`, `defaultLimits`, `minimumSteps`, `minimumTimeMs`, `minimumMemoryBytes`, `printFrameBytes`, `printStatementFloor`, `printRetainedBytes`, `withDefaults`, `Intent`, `replTransition`, `RealmEvaluation`, `RealmFrame`, `Realm`, `RealmOptions`, `Sandbox`, `make`, `layer`, `makeNoop`, `layerNoop`, `realmUnsupported`, `callTimedOut`, `compile`, `PendingCall`, `driveCell`, `raisedOutcome`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The deterministic script sandbox port.                                                                   |
| `CellTurn`                   | `defaultMaxFrames`, `defaultReadOnlyFrames`, `defaultModelCallMs`, `defaultRepeatFrames`, `defaultNarrowingDemands`, `defaultUnmovedDemands`, `defaultUnresolvedDemands`, `defaultClaimDemands`, `defaultRevalidations`, `defaultMaxCheckpoints`, `State`, `Input`, `MemoryRow`, `Memory`, `make`, `teach`, `instructionsSegment`, `memorySegment`, `run`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The cell-first controller.                                                                               |
| `CellHistory`                | `ExecutedCell`, `Service`, `CellHistory`, `make`, `makeCells`, `makeNoop`, `layer`, `layerCells`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The source of every cell the current turn executed.                                                      |
| `CellCalls`                  | `Implementation`, `Prompt`, `PromptRunner`, `Options`, `Resolver`, `make`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Registry-backed resolution for the flow calls a cell makes.                                              |
| `FlowBinding`                | `Declared`, `DescriptorOptions`, `descriptorOf`, `Binding`, `Options`, `make`, `provide`, `Source`, `source`, `Catalog`, `empty`, `catalogResult`, `catalog`, `registry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The executable-flow binding contract.                                                                    |
| `StructuredOutput`           | `StructuredOutputFailureCode`, `OutputIssueCode`, `OutputIssue`, `StructuredOutputFailure`, `maxIssues`, `jsonSchema`, `digest`, `instructions`, `issuesDigest`, `correction`, `lastBalanced`, `candidates`, `decode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Turning one agent's final text into a value the declared output schema accepts, or into a typed failure. |
| `TruncatedOutput`            | `flagSuffix`, `droppedSuffix`, `flagKey`, `minimumBytes`, `retained`, `Capture`, `Reuse`, `captures`, `reuse`, `refusal`, `retain`, `Ledger`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The truncation ledger: which bytes this run was handed as a fragment.                                    |
| `CallLedger`                 | `bound`, `width`, `members`, `Entry`, `Ledger`, `subject`, `target`, `digest`, `payload`, `Settlement`, `entry`, `settled`, `remember`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The call ledger: what this run has already asked, rendered every frame.                                  |
| `NarrowedCheck`              | `retained`, `maxTerms`, `labelWidth`, `label`, `targeting`, `names`, `lex`, `terms`, `conditions`, `Check`, `Narrowing`, `check`, `narrows`, `find`, `demand`, `Only`, `findOnly`, `demandOnly`, `remember`, `Ledger`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The narrowing ledger: which checks this run has run, and over which tree.                                |
| `CellValidation`             | `Validation`, `normalize`, `validate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Cell validation at the boundary.                                                                         |
| `CompletionClaim`            | `outputBytes`, `proseBytes`, `disprovenAt`, `overclaimedAt`, `unsupportedAt`, `inventedAt`, `leafBytes`, `resultBytes`, `receipt`, `Reported`, `Settled`, `record`, `checksRunLimit`, `Check`, `Ran`, `Evidence`, `classifier`, `sentenceLimit`, `sentences`, `sentenceMarker`, `sentenceOf`, `sentenceClassifier`, `Probabilities`, `Reading`, `find`, `unrecorded`, `newest`, `unjudged`, `unproven`, `read`, `demand`, `quote`, `prose`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The completion nothing in the record contradicts.                                                        |
| `Supervisor`                 | `frameBytes`, `recentFrames`, `recalledLimit`, `closeGraceMs`, `thrashingAt`, `offTargetAt`, `suspectAt`, `contextAt`, `Level`, `levels`, `Help`, `emotions`, `Emotion`, `Frame`, `Signals`, `Recalled`, `skillLimit`, `skillBytes`, `calledLimit`, `Skill`, `skill`, `Snapshot`, `monitorPrefix`, `MonitorQuestions`, `classifierFor`, `classifier`, `Reading`, `read`, `Memory`, `memoryNone`, `nudge`, `recalledInsert`, `head`, `tail`, `prose`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The reading Jev takes of a run while it is still running.                                                |
| `Monitor`                    | `Kind`, `Common`, `Questioned`, `Derived`, `Monitor`, `Budget`, `Input`, `budgets`, `idPattern`, `questionId`, `make`, `InvalidMonitor`, `validate`, `lint`, `paranoidText`, `carefulText`, `stepBackText`, `clarifyText`, `moods`, `defaults`, `skillText`, `skills`, `useJevText`, `useJev`, `questions`, `Row`, `Candidate`, `Evaluation`, `evaluate`, `Entry`, `Ledger`, `fresh`, `Gated`, `gate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What one supervisor reading can put in front of the run, and when.                                       |
| `Judgement`                  | `Unjudged`, `unconfigured`, `Asked`, `Read`, `measured`, `read`, `maxStateBytes`, `ItemQuestions`, `ItemAnswers`, `PerItemOptions`, `ItemState`, `ItemsRead`, `PerItem`, `perItem`, `decision`, `unjudgedEvent`, `Recorded`, `recorded`, `emitRecorded`, `taskBytes`, `task`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The one way this package asks Jev a question.                                                            |
| `Relevance`                  | `Kind`, `Item`, `Context`, `withholdAt`, `itemBytes`, `reader`, `Verdict`, `Reading`, `judge`, `settled`, `flowItem`, `Document`, `Chunk`, `chunks`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What a run is shown of the human-provided items it could be shown.                                       |
| `UnmovedTree`                | `Unmoved`, `find`, `demand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The completion with nothing behind it.                                                                   |
| `UnresolvedFailure`          | `exitStatusKey`, `failed`, `exitStatus`, `passed`, `Displaced`, `revisits`, `find`, `demand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The failing check a completion stepped around.                                                           |
| `FailedCall`                 | `cap`, `heading`, `stated`, `Failure`, `reason`, `inspects`, `find`, `demand`, `state`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The completion its own cell wrote before a call in it failed.                                            |
| `Sufficiency`                | `retained`, `Failure`, `Ledger`, `remember`, `Sufficient`, `find`, `observation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The evidence that is already complete.                                                                   |
| `VacuousVerification`        | `retained`, `Pass`, `Ledger`, `remember`, `stored`, `find`, `observation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The proof that was already true before anything changed. Not wired into `CellTurn`.                      |
| `VariablesPanel`             | `bound`, `Binding`, `Stamp`, `Ledger`, `stamp`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The variables panel: what the realm holds, stated every frame.                                           |
| `QuickJSSandbox` _(subpath)_ | `cacheSuccessful`, `VariantService`, `Variant`, `layerVariantLive`, `layerVariant`, `ComputeClockService`, `ComputeClock`, `layerClockLive`, `loadModule`, `makeWithVariant`, `makeWithClock`, `make`, `layerWithVariant`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The QuickJS-WASM sandbox binding.                                                                        |

## Durability

Every `ctx.call` is its own keyed, journaled, permission-gated boundary at the
tier the flow declares, so a crash or a permission park mid-cell is recoverable:
the cell source re-executes from the top, boundaries that already settled replay
their recorded values, and execution reaches the parked call deterministically.

`EngineLike.record` is the same mechanism for the controller's own reads of the
world. The controller's state is rebuilt by re-execution, so a read that
bypasses a record is a replay divergence and, downstream of one, a duplicate
irreversible effect. `(name, identity)` together form the record key: two
records in one frame may share an identity as long as their names differ.

One call is deliberately not covered by that guarantee. `EngineLike.call` is
where a cell reaches a durable wait, and a `Flow.suspend` raised inside an
enclosing activity suspends that activity's attempt rather than the run, so the
call is issued first and its settlement is recorded after. A call the `callMs`
ceiling interrupted therefore settles nowhere, and a re-executed frame issues it
again on the host. The cell's branch is stable either way, because the recorded
settlement is what the replayed frame is handed; what the run pays for twice is
the interrupted call itself.

## Limits

`Sandbox.defaultLimits` fills every ceiling a caller omits. A caller may raise
any single ceiling; the others keep their defaults, so a partial override cannot
disable them.

| Limit             | Default | Scope       | What it bounds                                                                                                                         |
| ----------------- | ------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `calls`           | 64      | per frame   | Flow calls one cell may make. A `ctx.checkpoint()` mint settles on the same channel and counts.                                        |
| `memoryBytes`     | 128 MiB | per **run** | What the realm's own names hold, weighed by the panel probe at each frame's close.                                                     |
| `steps`           | 1,000   | per frame   | Interrupt checks, not bytecode operations. At least `Sandbox.minimumSteps`.                                                            |
| `timeMs`          | 30,000  | per frame   | The cell's own JavaScript time. Time suspended in a `ctx.call` or `ctx.checkpoint()` does not count. At least `Sandbox.minimumTimeMs`. |
| `totalMs`         | 900,000 | per frame   | Whole-evaluation time, host calls included. The backstop for a call that never settles.                                                |
| `pauseTotalMsFor` | none    | per frame   | Flow names whose pending calls pause `totalMs`; the host must bound or settle these calls separately.                                  |
| `callMs`          | 120,000 | per call    | Wall-clock time one flow call may take before it settles as a resolved timeout.                                                        |

`memoryBytes` is a run budget rather than a frame budget because a realm outlives
its frames. `runtime.setMemoryLimit` covers the object graph but does not count
string data on the shipped QuickJS variant, so the panel probe weighs the realm's
own names and a frame that opens over the ceiling is refused before it runs. The
reading is cleared with the refusal, because freeing is itself done by a cell.

## Bytes

Text delivery and retention bounds use UTF-8 bytes measured by one shared
helper. The print channel, retention ceiling and call ledger's line sizes use
this unit, including CJK and emoji payloads. Elision notices state the real
UTF-8 byte count.

The supplemental memory probe is a separate estimate, not a UTF-8 byte count or
an exact heap measurement. Strings and property names contribute their UTF-16
code-unit lengths. Objects have a base weight of 8; non-string scalars,
functions, accessors and cycle references have fixed weights of 8. The probe walks named globals, array indices,
enumerable own string-keyed data properties, Map keys and values, and Set values.
Collection entries use the same traversal budget as properties: 200,000 values
and depth 32. An incomplete traversal causes the next frame to be refused.
Cycles stop at ancestor references; shared objects on separate paths are counted
again. Accessors are not invoked. Closure state, weak collection entries and
other storage unreachable by these paths are not measured. The native allocator
limit remains active, but this supplemental estimate is not a hard bound on all
memory retained by the realm.

## Failure categories

Three closed unions carry every failure a caller branches on. None of them is
open-ended, and none of them is prose a consumer must parse.

- `HarnessError.HarnessErrorCode`: the translation boundary's own failures.
  Folded into `@smthrs/agent`'s `AgentFailure` union, so a code that nothing
  raises is a promise this package cannot keep; the set holds only codes that
  are raised.
- `Cell.CallFailureCode`: why one flow call did not succeed, as the cell reads
  it. A failed call **resolves** with `{ ok: false, error: { code, message, hint } }`
  rather than throwing, so the recovery branch the model already wrote still
  runs. `Cell.callFailureHint` names the one move that recovers each class.
- `Sandbox.SandboxErrorCode`: why a realm could not run a cell at all, as
  distinct from a cell that ran and failed.

`StructuredOutput.StructuredOutputFailureCode` is the fourth, for the boundary
that decodes an agent's final text into a declared schema.

## Copy and mutation semantics

`ContextWindow` is immutable: the arrays a segment and a window expose are
frozen, so a runtime mutation throws rather than silently invalidating the
digest computed once at construction. `Cell` values, `CallLedger` entries and
every `AgentEvent` are schema classes and are never mutated in place. The one
value the controller mutates is its own `State`, which is journaled at each
frame boundary.

## What this package does not do

- It declares no provider tools. The cell-first loop seals every model request
  with `tools: []` and `toolChoice: "none"`. A window still carries the active
  tool set it was constructed with, and `AgentEvent.TurnOpened.activeToolNames`
  still journals it, so a foreign-adapter loop has somewhere to put one; nothing
  in this package produces a non-empty set.
- It runs no scheduler and owns no storage. `Plan` describes child batches;
  `EngineLike` splices them.

## CellTurn

Harness journal format 2 versions controller state and model-key inputs.
Resuming older controller state or an agent session journal fails before a live
model call with `HarnessError` code `incompatible_journal`; start a new run.
Historical transcript projection remains available for display and renders
summary text as a user message. rc.0 does not promise journal compatibility.

`import * as CellTurn from "@smthrs/harness/CellTurn"`

The cell-first controller. It decides continue, park, or finish from durable
evidence, the transition a cell returned and the budgets the run declared, and
never from the presence of a provider tool call.

```ts
export const run: (
  input: Input
) => Stream.Stream<
  AgentEvent.AgentEvent,
  HarnessError,
  EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source
>
```

`run` executes the loop until it completes, parks, or exhausts its budget.
Cancellation is fiber interruption: interrupting the stream tears down the
sandbox through scope closure and reports one abort. `Input` is
`{ state, flows, limits?, supervisor?, monitors?, judged?, stance?, instructions?, pinned?, memory? }`,
where `flows` is the frame's `FlowDescriptor` list, already narrowed by seat
visibility, and `monitors` (default `Monitor.defaults()`) are what each
supervisor reading scores. `judged` (default false) is true only when the
host's `Evaluator` is a real judge, and it arms Jev's features: the
supervisor delivers what its monitors gate through and its inserts, frame 0
takes the run-start relevance reading, and the supervisor marks segments for
compaction. It is runtime configuration, not `State`, so a resumed run is
armed by the host that resumes it. `DisciplineArmed` journals it, only when
true, as `judged`, `relevance` (`{ withholdAt, pinned }`) and `monitors`
(each id, kind and gate), so an unjudged journal is unchanged;
`supervisorSteer` is read only from journals written before `judged`. `stance`
(`careful` or `paranoid`) is the static stance the run is taught; pass the
window taught with it. `DisciplineArmed.stance` records it when set.

**Run-start relevance.** At frame 0 of a judged run, once the frame's catalog
is known, every model-invocable flow not in `pinned` (as `Relevance.flowItem`,
sorted by name), every chunk of `instructions` (`Relevance.Document`s) and
every row of `memory` (kind `memory`, id its `key`) is one item of a single
`relevance/unnecessary` reading, recorded under the boundary `relevance`. Nothing to judge asks nothing. `decision-settled` rows are
followed by `relevance-settled` (`source: "run"`). Withheld flows and skills
go to `State.withheldFlows` and leave every frame's taught catalog and
`ctx.flows`; the recorded `flow-catalog` stays whole. Withheld chunks leave
the window's instructions segment, found by the digest of
`instructionsSegment(instructions, new Set())`, which is how the host must
build it; a segment left empty is removed. A chunk is matched by id and text,
so a replay against an edited file keeps a chunk whose text the reading never
judged. Withheld rows leave the memory
segment, found by the digest of `memorySegment(memory.render(memory.rows),
memory.digest)`: it becomes `memory.render` of the kept rows, or is removed
when none is kept. A reading nobody could judge withholds nothing and
journals `decision-unjudged`. A call to a withheld flow
settles `flow_withheld` and restores it: the next frame shows it, and
`relevance-restored` names it. A replay is served the recorded reading.

**Compaction marks.** Marking is separate from compacting. In a judged run
each supervisor reading also asks `compaction/marks` about the transcript
segments not yet marked, the person's excepted, and the next boundary stores
the answers, by segment digest, on `State.segmentFacts` inside its recorded
drain (`Steering.DrainRecord.marks`). Marking changes nothing the model is
sent: the prefix a request is sent stays byte-stable until a compaction. A
frame compacts when the window crosses its budget (`Compaction.shouldCompact`
and `selectPrefix` at their defaults), or when the boundary before it took a
supervisor reading that fired `outdated_context` or `irrelevant_context`
(`Steering.DrainRecord.compact`, carried on `State.compactionDue` for that
frame alone); a judged run then marks each prefix segment `keep`, `squash` or `remove`. Pins, read
from `State.segmentFacts` and the still-failing checks, fix what must
survive: a summary is squashed; steering, the person's segments and the
newest segment that ran each still-failing check are kept; a segment that
changed files is never removed. The stored answers resolve the rest against
the budget; segments still unmarked are asked in one `compaction/marks`
reading, recorded under the boundary `compaction-marks:<prefix digest>`, so
a replay asks nothing and re-keys the same summary. Only squashed segments
reach the sealed summary step, which is skipped when nothing is squashed;
kept segments stay verbatim after the summary. `decision-settled` rows
precede `compaction-settled`, which carries `summary?`, `kept`, `marks`
(segment digest, mark, `pinned?`), `removedTokens` and `causes`. An unjudged run and a
reading nobody could judge (journaled `decision-unjudged`) squash every
prefix segment; so does a judged run whose facts do not describe every
transcript segment, and its `compaction-settled` says `unaligned`.

`instructionsSegment(documents, withheld)` is the prefix `system` segment of
`Relevance.render(documents, withheld)`. It is `system`, not `instructions`,
because the task is what the prefix `instructions` segments say.

`Memory` is `{ rows, digest, render }`: the opening memory rows
(`MemoryRow`, `{ key, text }`), the digest the opening declares, and the
host's render, which is only handed rows of `rows`, in order.
`memorySegment(text, digest)` is the prefix `system` segment of rendered
memory under that declared digest: what a run remembers is not its task, and
each row is judged against a task that does not contain it.

`CellTurn.make` constructs the initial `State`:

```ts
export const make: (options: {
  readonly session: string
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly layers: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly placement: Option.Option<Descriptor.Placement>
  readonly contextWindow: ContextWindow.ContextWindow
  /** Initial budget; a seat steer recomputes it from the model catalog. */
  readonly contextWindowTokens?: number | undefined
  readonly frame?: number | undefined
  /** Zero disarms the frame limit; exhausted positive limits spend no new frame. */
  readonly maxFrames?: number | undefined
  readonly readOnlyCap?: number | undefined
  readonly modelCallMs?: number | undefined
  readonly repeatCap?: number | undefined
  readonly narrowingCap?: number | undefined
  readonly unmovedCap?: number | undefined
  readonly unresolvedCap?: number | undefined
  readonly claimCap?: number | undefined
  readonly approvalChannel?: boolean | undefined
  readonly revalidations?: number | undefined
  readonly checkpointCap?: number | undefined
}) => State
```

Every omitted budget takes its module-level default, and zero disarms it:

| Constant                   | Value   | Budget it defaults                                                                                      |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `defaultMaxFrames`         | 100     | Frames one admitted task may spend.                                                                     |
| `defaultReadOnlyFrames`    | 12      | Consecutive stalled read-only frames before intervention.                                               |
| `defaultModelCallMs`       | 300,000 | Wall-clock milliseconds one model call may spend at unset, `none`, `minimal`, `low` or `medium` effort. |
| `defaultRepeatFrames`      | 4       | Consecutive repeat-observation frames.                                                                  |
| `defaultNarrowingDemands`  | 1       | Completions bounced for narrowed evidence.                                                              |
| `defaultUnmovedDemands`    | 1       | Completions bounced for an unmoved tree.                                                                |
| `defaultUnresolvedDemands` | 1       | Completions bounced for a displaced failing check.                                                      |
| `defaultClaimDemands`      | 3       | Frames given to answer an unrecorded claim.                                                             |
| `defaultRevalidations`     | 1       | In-frame answers to an unparseable cell.                                                                |
| `defaultMaxCheckpoints`    | 8       | Trees one run may pin with `ctx.checkpoint()`.                                                          |

An omitted `modelCallMs` follows the run's reasoning effort through
`modelCallMsFor(effort)`: 300,000 ms up to `medium`, 900,000 ms at `high`, and
1,800,000 ms at `xhigh` or `max`. A steering change of effort moves a defaulted
ceiling with it; a host's own number stays. The engine also cuts off a stream
that sends nothing for `defaultModelIdleMs` (300,000 ms), so a long ceiling
never waits out a stall.

A read-only frame counts toward `readOnlyCap` unless the run has already
written something and the frame settled a call the run had not issued before.
Such a frame is debugging work that exists, so it holds the streak. Frames that
call nothing, raise, or re-ask old questions still count, and every read-only
frame counts before the first write.

`readOnlyCap` is the one budget that defaults to disarmed (0), because a run
that is only meant to read, a question or a review, has nothing to be capped
at. `approvalChannel` defaults to `false`: a park is durable waiting, and a
run with nobody to answer it refuses the transition in-frame.

`State` is a schema class carrying the controller's view of the run across
frames: the panel of realm names, the call ledger, the checks and failures
ledgers, the truncated-output ledger, the checkpoint ids, the opening
workspace digest, every budget and its counter, the context window, and
`segmentFacts`: per transcript segment, the frame that wrote it, whether it
carries the person's messages (a supervisor insert does not count), whether
that frame changed files, and the checks it ran. It
serializes into the journal; the realm itself is not in it and cannot be,
because a live JavaScript context is rebuilt on resume by re-executing the
cells that built it.

`CellTurn.run` accepts an optional `contextWindowTokensFor(seat)` effect on
its runtime `Input`. A seat steer resolves its next compaction budget through
this callback. The agent adapters supply their host `SeatResolver`, including
logical seats such as `reviewer`; direct harness callers without a callback use
the model-id catalog. The callback lives outside serializable `State`; the
resolved token count is carried in state across frames.

`CellTurn.teach(contextWindow, flows, environment?, stance?)` prepends the cell contract and the
callable-flow catalog to a context window as prefix segments. The optional
`CellTurn.Environment` supplies the host's measured `locale` and `absentTools`.
A `stance` adds a one-line `cell-stance` section after the contract,
`Monitor.carefulText` or `Monitor.paranoidText` verbatim; it is constant for
the run, so the cached prefix holds.
Catalog metadata is escaped inside an `untrusted-data` block with each
source, root and repository path. Metadata and tool output cannot grant
authority or change the task. Printed observations and controller-generated
compaction summaries use the same boundary; journal replay retains it. Pass
`refreshFlows` on `CellTurn.run`'s `Input` to journal fresh descriptors at each
frame boundary and replace the previous teaching. The prompt, `ctx.flows`,
and admission share the recorded snapshot. Omit it to keep `flows` fixed.

## Sandbox

`import * as Sandbox from "@smthrs/harness/Sandbox"`

The deterministic script sandbox port. A cell never runs in the host realm; it
runs behind this port, which grants exactly one effectful primitive, flow
invocation against the capability-narrowed catalog the run was given, and
returns a serializable `Cell.Outcome`.

```ts
export interface Sandbox {
  readonly capabilities: Capabilities
  readonly openRealm?: (
    options: RealmOptions
  ) => Effect.Effect<Realm, SandboxError, Scope.Scope>
}
```

`openRealm` is optional because a realm is the whole surface: there is no
per-cell evaluation beside it. A composition that offers none is refused with
`Sandbox.realmUnsupported`. `RealmOptions` is `{ flows, limits? }`: the
catalog frozen into `ctx.flows`, and the ceilings the realm enforces. The
service tag is `Sandbox.Sandbox`; `make`, `layer`, `makeNoop`, and
`layerNoop` construct and provide implementations and stubs.

```ts
export interface Realm {
  readonly evaluate: (
    evaluation: RealmEvaluation
  ) => Effect.Effect<RealmFrame, SandboxError | HarnessError>
}
```

`RealmEvaluation` is
`{ cell, frame, call, program?, flows?, mint?, bounded?, limits? }`;
`RealmFrame` is `{ outcome, prints, bindings }`. The `Sandbox.Handler`
resolves one `Sandbox.Invocation` (`{ ordinal, flow, input, at? }`) into a
`Cell.CallResult`; the `Sandbox.Minter` settles one `ctx.checkpoint()` mint on
the same queue, in issue order, so the pin lands where the cell wrote it.

A cell states its intent by calling, and `Sandbox.replTransition` is the only
place a `Cell.Transition` is constructed:

```ts
export const replTransition: (
  intent: Intent | undefined,
  justification: string | undefined
) => Cell.Transition
```

`Intent` is `{ _tag: "Done", output }` or `{ _tag: "Park", reason, message }`,
with `reason` one of `"waiting-input"`, `"waiting-event"`, `"waiting-quota"`.
An absent intent is a `continue`.

Binding-author seams: `Sandbox.compile` erases type-only syntax from a cell
without evaluating or resolving modules (only Node's strip-safe TypeScript
subset; anything needing emit is refused). `Sandbox.driveCell` runs the shared
drive loop that settles queued calls one at a time, in issue order, until the
cell settles; `Sandbox.PendingCall` is the queued-call shape. `Sandbox.callTimedOut(flow,
callMs)` synthesizes the resolved `timeout` refusal one ceiling means,
whichever clock enforced it. `Sandbox.raisedOutcome` projects a thrown value
into a stable serializable `Cell.Raised`. `Sandbox.mintUnavailable` is the
`checkpoint_unavailable` refusal for a run with no minter wired.

`SandboxError` carries a `SandboxErrorCode` of `unavailable`, `unsupported`,
or `runtime_failed`: failures of the binding itself, as opposed to a cell that
ran and failed, which is a `Cell.Raised` outcome instead.

The limits and their defaults are documented under [Limits](#limits).
`Sandbox.withDefaults(capabilities, limits)` fills omitted ceilings for the
limits a binding can enforce; an explicit unsupported limit passes through so
the binding can refuse it. The print-channel constants are
`Sandbox.printFrameBytes` (16 KiB), `Sandbox.printStatementFloor` (512 bytes),
and `Sandbox.printRetainedBytes` (256 KiB).

## QuickJSSandbox

`import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"` (not
re-exported from the root)

The QuickJS-WASM sandbox binding, and the production `Sandbox`: the cell runs
inside a QuickJS interpreter compiled to WebAssembly, a genuinely separate
JavaScript realm with no reference to the host's globals, prototypes, or
module loader. The same single-file variant runs unmodified on Node and in a
browser. The prelude removes `Date`, `Math.random`, and `Proxy` from the
realm, and installs `ctx` and `console` as non-writable, non-configurable
properties.

| Export                                 | Signature                                                                               | Behavior                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `make`                                 | `Effect<Sandbox.Sandbox, Sandbox.SandboxError>`                                         | Constructs the sandbox over the single-file build with the live clock.                      |
| `layer`                                | `Layer<Sandbox.Sandbox, Sandbox.SandboxError>`                                          | Provides the same.                                                                          |
| `makeWithClock`                        | `Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock>`                           | The single-file build, with the clock seam left to the caller.                              |
| `makeWithVariant`                      | `Effect<Sandbox.Sandbox, Sandbox.SandboxError, ComputeClock \| Variant>`                | Constructs over the build the host names, compiling the module once.                        |
| `layerWithVariant`                     | `Layer<Sandbox.Sandbox, Sandbox.SandboxError, Variant>`                                 | Provides the sandbox over the named build, with the live clock.                             |
| `Variant` / `VariantService`           | service tag                                                                             | The QuickJS build the sandbox compiles.                                                     |
| `layerVariantLive`                     | `Layer<Variant>`                                                                        | Provides the single-file default.                                                           |
| `layerVariant`                         | `(variant: QuickJSSyncVariant) => Layer<Variant>`                                       | Provides a build the host names, for runtimes that forbid compiling WebAssembly from bytes. |
| `ComputeClock` / `ComputeClockService` | service tag                                                                             | Synchronous monotonic-enough clock the interrupt callback requires.                         |
| `layerClockLive`                       | `Layer<ComputeClock>`                                                                   | Provides the browser-safe host clock.                                                       |
| `loadModule`                           | `(loader: () => Promise<QuickJSWASMModule>) => Effect<QuickJSWASMModule, SandboxError>` | Loads a QuickJS module through the typed failure boundary (`runtime_failed`).               |
| `cacheSuccessful`                      | `<A>(load: () => Promise<A>) => () => Promise<A>`                                       | Caches only a successful load; a rejection may be retried.                                  |

The compiled module is cached per variant, weakly, so two sandboxes over one
variant share it and a variant built per request stays collectable. For the
workerd setup, see [Run on Cloudflare workerd](/guides/workerd/).

## Cell

`import * as Cell from "@smthrs/harness/Cell"`

The cell contract: the serializable half of the frame. Nothing here executes
anything; execution is `Sandbox`, durability is `EngineLike.call`, and the
loop is `CellTurn`.

**Source.** `Cell.source(text, language?)` builds a `Cell.Source` with its
computed digest; `language` is `"javascript"` or `"typescript"`. The digest is
part of every call identity produced inside the cell, so editing one character
re-keys every boundary within it. `Cell.extract(text)` recovers the cell
program from one model reply: every fenced block tagged `cell`, `js`,
`javascript`, `ts`, or `typescript`, joined in reply order with byte-identical
repeats dropped, returning `{ source, blocks }` or a `no_cell` rejection. An unterminated cell fence rejects the entire reply as
`output_truncated`; a provider `length` stop uses the same code before execution.

**Transitions.** `Cell.Transition` is the tagged union of:

- `Cell.Continue`: the cell's turn ended without settling the run. Carries an
  optional `justification`, the typed way out of the read-only cap, written by
  `ctx.justify`.
- `Cell.Complete`: the cell declares the task finished, with `output` as the
  run's answer.
- `Cell.Park`: the cell asks to wait durably, with `reason` one of
  `"waiting-input"`, `"waiting-event"`, `"waiting-quota"` and a `message`.

**Outcomes.** `Cell.Outcome` is the tagged union of `Settled` (ran and
produced a well-formed transition), `Raised` (ran and threw; the thrown value
is projected into stable `name` and `message` text), and `Rejected` (never
ran, or produced no transition). `Cell.RejectionCode` is `no_cell`, `output_truncated`,
`imports_forbidden`, `compile_failed`, `invalid_transition`,
`unsupported_language`, `limit_exceeded`, or `stalled`. A result that cannot
fit in the remaining QuickJS heap is rejected before materialization with
`code: "limit_exceeded"` and `reason: "heap"`, so the frame remains recordable.

Flow-result heap checks conservatively include value and property storage plus
bridge scratch space, not just serialized JSON bytes. A reply can be refused
when its estimated allocation exceeds the remaining heap.

Bridge replies are also limited to 128 levels of JSON nesting so a refusal can
release partial handles safely. Exceeding this limit produces a typed
`limit_exceeded` frame.

**The catalog.** `Cell.FlowProjection` is the read-only projection of one
callable flow handed to a cell: `name`, `description`, `capabilities`,
`tier`, `placement`, and an optional inline `input` JSON Schema document.
`Cell.project(descriptor)` derives it from a registry descriptor. It is
exactly what `ctx.flows` exposes: enough to choose a call, nothing that
carries authority.

**Call identity.** `Cell.CallIdentity` folds `session`, `frame`, the cell
digest, the zero-based `ordinal` of the call within the cell, the
`declaration` digest, and the resolved `layers` into one key. Re-executing a
cell reaches the same ordinal with the same declaration, so a settled boundary
replays. `Cell.declarationDigest(descriptor)` re-exports
`Descriptor.declarationDigest` from `@smthrs/registry`, which owns
`FlowDescriptor`. It hashes the complete material declaration: every top-level
field except `provenance.pack`, with `capabilities` sorted and every other
array in declaration order. `@smthrs/chain` keys its catalog entries with the
same number.

**Call results.** `Cell.CallResultVariant` is a discriminated union of
`CallSuccess` (`outcome: "success"`, JSON `value`, optional `message`) and
`CallFailure` (`outcome: "failure"`, JSON `value`, optional `message` and
`code`). A success cannot carry a failure code. The existing `Cell.CallResult`
class constructor validates the same variants and preserves valid encoded
field names. A failure's absent code means `Cell.defaultCallFailureCode`,
`"flow_failed"`. `Cell.callFailure(result)`
projects a failed result into the fixed envelope the cell observes:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
```

A failed call resolves with this value rather than throwing, so the recovery
branch the model already wrote still runs; a successful call resolves with the
flow's own value, unwrapped. `Cell.callFailureHint` maps each of the 13 codes
to the one action that recovers it. The codes and hints are tabulated in
[troubleshooting](/troubleshooting/#a-flow-call-fails).

`Cell.decodeCallResult`, `Cell.decodeOutcome` and `Cell.decodeTransition`
accept untrusted host or recorded input. They refuse contradictory fields,
missing required values and unsupported variants with `HarnessError`
(`engine_failed`), retaining the original cause. Outcome and transition
decoders validate encoded fields even on class instances, then reconstruct
the schema classes required by the recorder. Sandbox settlement and the
durable cell recorder apply these boundaries before emitting successful
observations. A missing success value is corrupt input, not an implicit null.
Valid current records retain their JSON representation, including failures
whose code is absent. `CellValidation.Validation` likewise separates compiled
source from rejection so the two cannot be supplied together.

`Cell.CallResult` retains its historical encoded schema representation because
the agent hashes that representation into sealed keys. The constructor and
boundary decoder enforce the success/failure invariants; admission hardening
does not re-key valid results. The agent pins the complete key material and
tests a historical result through SQLite close, reopen and resume.

Changing the valid wire contract still requires a version cutover and a newly
planned run. Existing approvals and recorded keys remain bound to their
original bytes; no decoder translates identities. Intermediate builds that
added the `success-without-failure-code/v1` filter to the encoded schema derived
different keys. Finish their executions on the same build before upgrading.
See the agent's [persisted cell-call identity](https://agent.smithers.sh/concepts/engine-port/#persisted-cell-call-identity)
for the retained algorithm and composition versions.

**Checkpoints.** `Cell.baseCheckpoint` is `"base"`, the id naming the tree a
run opened on, pinned for free and always present. `Cell.checkpoint(id)`
builds the opaque handle a cell holds; `Cell.checkpointOf(value)` reads the id
back strictly, returning `undefined` for anything that is not a handle, which
the boundary answers as an ordinary `invalid_input`.

## EngineLike

`import * as EngineLike from "@smthrs/harness/EngineLike"`

The narrow engine port the harness consumes. `EngineLike.make` builds the
service from an implementation, `EngineLike.layer` provides it, and
`EngineLike.makeNoop` / `layerNoop` build a stub whose operations are
unavailable (`observe` and `capture` answer `Option.none()`, the honest
"measured nothing, pinned nothing", rather than failing).

```ts
export interface EngineLike {
  readonly sealStep: (
    step: SealedModelStep
  ) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError>
  readonly sealStepWithEvents?: (
    step: SealedModelStep,
    emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  ) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError>
  readonly splice: (batch: Plan.Batch) => Stream.Stream<Plan.SpliceEvent, HarnessError>
  readonly call: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
  readonly admit?: (call: Cell.Call) => Effect.Effect<Cell.CallResult | undefined, HarnessError>
  readonly guard?: Guard
  readonly record: <A>(boundary: RecordBoundary<A>) => Effect.Effect<A, HarnessError>
  readonly observe: Effect.Effect<Option.Option<Observation>, HarnessError>
  readonly capture: (request: CaptureRequest) => Effect.Effect<Option.Option<Snapshot>, HarnessError>
  readonly resolve?: (request: ModelRequest.ModelRequest) => Effect.Effect<Option.Option<Resolved>>
  readonly suspend: (reason: SuspendReason) => Effect.Effect<never, HarnessError>
}
```

- `sealStep` runs one sealed model step. `SealedModelStep` is `{ request,
  keyMaterial, modelCallMs? }`. The implementation resolves the route, runs
  `Route.prepare` from [`@smthrs/model`](https://model.smithers.sh/reference/api/), and digests the
  credential-free prepared request, canonical body bytes included, with the
  declared material into the sealed-step key before executing. A provider wire
  change must produce a new key; credentials are signed on after the digest
  and never enter it. `modelCallMs` travels on the step and is never key
  material, so the number the controller journals as armed is the number the
  engine enforces.
- `sealStepWithEvents`, when supplied, seals through the same boundary and
  receives the controller's event emitter for failover and park transitions.
- `call` runs one flow call as a keyed, journaled activity at the tier the
  flow declares, keyed by `call.identity`. A flow failure settles as a
  `failure` `Cell.CallResult`; a permission requirement, an abort, or an
  engine failure travels in the error channel so the cell can never swallow a
  park.
- `admit`, when present, decides a call's authority before the controller
  starts the call's `callMs` clock, so time a person spends answering an
  approval is not charged to the flow. `undefined` admits the call; a result
  is the refusal the cell reads instead, and `call` is never issued. An
  implementation does not ask again when an admitted call is issued.
- `guard`, when present, is the host's runaway guard for timeouts (`Guard`:
  `{ admit(subject), trip(timeout) }`). The controller calls `admit` before it
  issues a call or evaluates a fresh cell frame, and `trip` with a `TimedOut`
  (`{ source: "tool-call" | "cell", subject, limitMillis?, message }`) when a
  call settles as a `timeout` failure or a frame overruns its wall-clock
  limit. `limitMillis` is the limit the timeout recorded: the per-call
  ceiling, or the call's own (a command's, an await's). `trip` succeeds when the run's timeouts are not guarded, and the
  cell reads the timeout as before; a guarded host fails it with a park, and
  the controller records nothing for the operation, so Continue runs it again
  and Stop fails the run at `admit`. `subject` is the replay-stable call or
  frame identity, as JSON.
- `record` journals one nondeterministic controller read, keyed on `(name,
  identity)` together. `RecordBoundary` is `{ name, identity, success,
  execute }`, where `success` is a `DurableSchema`, a schema that decodes
  without services, and `identity` is a `BoundaryIdentity` (`{ session?,
  frame, boundary }`).
- `observe` measures the workspace as it stands, as an `Observation` (`{
  digest, paths, complete }`). `complete: false` means the measurement covered
  a bounded prefix, and a prefix cannot say the rest of the tree held still.
  After a partial walk, measurement stops for the rest of that run; mutation
  evidence falls back to flow declarations.
- `capture` pins the workspace under the id in the `CaptureRequest` and
  returns a `Snapshot` (`{ id, ref }`), where `ref` is the host's own name for
  what it pinned.
- `resolve` is optional. It says what one request will actually be asked as:
  an `Option` of a `Resolved` (`{ request, binding }`) holding the request
  after any rewrite the host applies and, as an `Option`, the `Binding`
  (`{ routeId, protocolId }`) of the route it goes to. The controller asks
  before it seals and journals the answer as `AgentEvent.ModelRequested`. It
  cannot fail. A host that cannot say what would be sent, because its rewrite
  failed or no route accepts the request, answers `Option.none()`: the
  controller journals no request for that call, and `sealStep` reports the
  typed error. A host that answers none must fail that sealed step with the
  failure it already met, without running the rewrite a second time. A
  `Binding` is two names read off the credential-free prepared request, so it
  has no member a credential could occupy. A host that omits `resolve` has the
  request the controller built recorded, with no route.
  `EngineLike.resolve(engine, request)` is that rule as a function: the port's
  answer, or the request unchanged with no binding.
- `suspend` parks the current engine frame with a `SuspendReason` (`{ code,
  message, details? }`), whose `SuspendReasonCode` is `permission-required`,
  `waiting-quota`, `waiting-input`, `waiting-event`, or `engine`.
- `splice` turns a `Plan.Batch` into running children and streams
  `Plan.SpliceEvent`s back.

## Steering

`import * as Steering from "@smthrs/harness/Steering"`

Turn-boundary steering values and their source contract. Human steering
reaches a run only at safe turn boundaries.

Every frame exit records its steering decision, including rejected and raised
cells, refused parks, and completions. A completion promotes a queued follow-up
and continues when delivery has work for the next frame. At an exhausted frame
limit, the decision is empty and notifications remain pending at the source;
they are never acknowledged without a frame available to consume them.

`Steering.Queue` is an immutable FIFO of `Steering.Item`s: transcript inserts
(`SteerInsert` for the next boundary, `QueueInsert` for when the run would
otherwise go idle), and `SeatChange` and `ThinkingChange` (applied only after
the current turn closes).
`Steering.empty`, `enqueue`, and `drainAtClose(queue, cutoff)` operate on it
without mutation. `Steering.Drain` is
what one boundary promoted; `Steering.DrainRecord` and `drainRecord` project
it into its journaled record, which also carries what the supervisor delivered
there: its messages, the memory keys, the monitor delivered, the monitors
withheld, the monitor ledger after gating, the compaction marks the run
stores, and the context triggers that compact its next frame.

```ts
export interface Source {
  readonly read: () => Effect.Effect<Queue, HarnessError>
  readonly drain: (input: BoundaryInput) => Effect.Effect<Drain, HarnessError>
}
```

A drain is idempotent in its boundary string: a second drain at one boundary
promotes nothing and hands back exactly what the first promoted, with
`Drain.duplicate` set. A resumed run re-drains the boundaries it already
drained and must be told the same thing, or it rebuilds a different context
and re-keys every later sealed step. The service tag is `Steering.Source`;
`make`, `makeNoop`, `layer`, and `layerNoop` construct and provide it.

## Notifications

`import * as Notifications from "@smthrs/harness/Notifications"`

The adapter from the durable notification queue of
[`@smthrs/notifications`](https://notifications.smithers.sh/reference/api/) to harness turn boundaries.

```ts
export interface Options {
  readonly runId: string
  readonly lineageId: string
}

export const make: (
  options: Options
) => Effect.Effect<Steering.Source, never, NotificationQueue.NotificationQueue>

export const layer: (
  options: Options
) => Layer.Layer<Steering.Source, never, NotificationQueue.NotificationQueue>
```

`make` captures the journal-backed queue as the harness steering source for
one run lineage: its `read` reports an empty queue and its `drain` delegates
to the notification queue's own boundary-aware drain, mapping failures into
`HarnessError`. `layer` provides it.

## CellCalls

`import * as CellCalls from "@smthrs/harness/CellCalls"`

Registry-backed resolution for the flow calls a cell makes. It is deliberately
not a second registry: discovery, precedence, collision handling, and
progressive disclosure stay in [`@smthrs/registry`](https://registry.smithers.sh/reference/api/); this
module only decides which body runs and turns every resolution problem into a
`Cell.CallResult` that resolves in the cell as `{ ok: false, error }`.

```ts
export interface Options {
  readonly registry: Registry.Registry
  readonly catalog?: FlowBinding.Catalog | undefined
  readonly implementations?: ReadonlyMap<string, Implementation> | undefined
  readonly prompt?: PromptRunner | undefined
}

export interface Resolver {
  readonly run: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
}

export const make: (options: Options) => Resolver
```

A name the run-start relevance reading withheld is refused first, as
`flow_withheld`, by `CellTurn` before resolution. Resolution order: the registry must know the name (`unknown_flow`), the
descriptor must be model-invocable (`capability_refused`), and its
re-derived declaration digest must equal the call's
(`declaration_changed`). An executable binding then answers first, after an
identity check against the disclosed declaration; a markdown flow renders
against `{ args: string }` and runs through the supplied `PromptRunner`, or
settles `unimplemented`; anything else dispatches to the host's
`Implementation` for the name, or settles `unimplemented`. The resolver's
shape is exactly the call runner a durable host wires behind
`EngineLike.call`, so this browser-safe package never depends on the engine
binding.

## FlowBinding

`import * as FlowBinding from "@smthrs/harness/FlowBinding"`

The executable-flow binding contract: the smallest contract that pairs a flow
declaration with the code that runs it.

```ts
export interface Binding<R = never> {
  readonly descriptor: Descriptor.FlowDescriptor
  readonly run: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError, R>
}

export const make: <I, O, E, R = never>(options: Options<I, O, E, R>) => Binding<R>
```

`Options.flow` is the declaration, a `Declared` (`{ name?, description?,
capabilities, effects }`) plus `input` and `output` schemas. `make` projects
it into an ordinary `FlowDescriptor` with `descriptorOf`, deriving the body
digest from the handler source and rendering both schemas as inline JSON
Schema documents when they project; a schema with no JSON Schema form falls
back to the module locator, and explicit `inputDocument` / `outputDocument`
options win over the projection. An undeclared effect envelope defaults to
`mode: "expected"`, `onConflict: "serialize"`, and tier `irreversible`, the
tier that is never content-shared, so a binding that forgot its tier can never
replay another run's recorded result.

`run` decodes input, executes the handler, and encodes output into
serializable JSON. For struct inputs, a failed decode retries once by omitting
only declared optional fields whose encoded schema rejects their `null`.
Schema-valid nulls are preserved and the full schema validates the retry.
If the retry fails, the original rejection is reported. The encoded input
must be a struct-like object; unions of structs and records get no
null-omission retry.

Correctable failures (`invalid_input`, `flow_failed`) settle as `failure`
results that resolve in the cell as `{ ok: false, error }`. Inspect
`.ok === false` and `.error.code` to recover. Ordinary handler failures use the opaque message
`Flow <name> failed.` Raw messages, objects, and causes are excluded from call
results and their journal records. `Options.publicError`, typed as
`(error: E) => string | undefined`, explicitly selects safe public text; the
text is bounded before journaling. An absent renderer, `undefined`, a throw,
or a non-string result uses the opaque default. The renderer is not a
sanitizer: hosts must select safe fields and redact raw diagnostics before
logging or persisting them in the handler. Forward `message` only for error
classes the host authored with model-facing text; never forward messages of
transport, SDK, OS, or unknown errors, headers, URLs, or serialized causes.

Existing `HarnessError` values pass through the error channel with their
code and identity unchanged. Only `PermissionRequired` and `PermissionDenied`
are converted to `HarnessError` with code `suspended`. These errors bypass
`publicError`; interruptions are never caught.

`FlowBinding.provide(binding, context)` closes a binding's remaining
requirements. `FlowBinding.Source` is a named, possibly effectful producer of
bindings; `FlowBinding.source(name, bindings)` lifts a fixed list.
`FlowBinding.catalog(sources)` resolves ordered sources into a `Catalog`
(`{ entries, bindings, descriptors }`), refusing duplicate or empty names with
`assembly_failed`; `catalogResult` is the total-function form and `empty()`
the empty catalog. `FlowBinding.registry(base, catalog)` discloses the
catalog through an existing `Registry.Registry` with file-discovered entries
keeping precedence, shadowed bindings reported as `duplicate_name` warnings.

## CellHistory

`import * as CellHistory from "@smthrs/harness/CellHistory"`

The source of every cell the current turn executed. A frame throws its cell
away once the realm has evaluated it, so a model that wants to turn the script
it ran into a saved flow has nothing to read back; this service is where the
source goes. The controller appends each cell as it executes it, before
evaluation, so a cell that raised is still part of what the run ran.

The service is optional: the controller reads it with `Effect.serviceOption`,
a host that offers no way to save a flow binds nothing, and the controller
records nothing. `make` records what the controller executes; `makeCells`
serves a fixed list; `makeNoop` records nothing; `layer`, `layerCells`, and
`layerNoop` provide the three. `ExecutedCell` is one executed cell and
`Service` is the record-and-report interface.

## AgentEvent

`import * as AgentEvent from "@smthrs/harness/AgentEvent"`

The serializable events a harness adapter emits, one schema class per event
and `AgentEvent.AgentEvent` as the tagged union of all 45. The controller
journals them in order: `DisciplineArmed` once at the start, the frame cycle
(`TurnOpened`, `ModelRequested`, `ModelDelta`, `ModelRetried`, `ModelSettled`,
`CellProduced`, `CellRejectedInFrame`, `CellCallStarted`, `CellCallSettled`,
`CellPrinted`, `CellSettled`, `TransitionApplied`), the interventions and
observations (`ReadOnlyDemandIssued`, `ReadOnlyDemanded`, `RepeatDemanded`,
`NarrowedDemanded`, `NarrowOnlyDemanded`, `UnmovedDemanded`,
`UnresolvedDemanded`, `FailedCallDemanded`, `UnobservedDemanded`, `OutputDemanded`, `ClaimDemanded`,
`DecisionSettled`,
`SufficiencyObserved`, `VacuousVerificationObserved`,
`MutationObserved`, `CheckpointMinted`, `CompactionSettled`,
`SteeringDrained`), and the terminal set (`Suspended`, `PermissionRequired`,
`TurnClosed`, `Resolved`, `Aborted`).

Capacity transitions are `SeatFailedOver` (`from`, `to`, `code`, optional
`resetAtEpochMillis`), `ModelParked` (`seat`, `wakeAt`, `source`, `code`), and
`ModelUnparked` (`seat`, `at`).

Two of them record what a step was asked, so a reader can open one step and
ask it again:

- `ModelRequested` is written once per model call, before the call, and
  carries the `ModelRequest` the provider is sent: the request after any
  rewrite the host applies, and the `EngineLike.Binding` naming the route
  where the host resolves one. `scope` (the run's session, which is a module
  step's recorded scope), `frame` and `attempt` are the join keys. `attempt`
  counts the model calls of one frame and purpose from one, and is the number
  `CellRejectedInFrame` names when it refuses that call's answer. `purpose` is
  `frame` or `compaction`; a compaction call runs ahead of its frame's
  `TurnOpened`, so it is joined by `frame`, never by position. A call whose
  host answers `EngineLike.resolve` with none writes no `ModelRequested`: the
  sealed step fails on it, so no provider was sent anything.
- `DecisionSettled` is written once per classifier reading, beside
  `ClaimDemanded`, and carries the classifier's stable id, its
  `Classifier.digest`, the encoded state the transport was sent, the questions
  in their wire form, and one `DecisionAnswer` per question. `acted` says
  whether the decision changed what the run did next, and `decidedBy` is
  `jev`, `seat` or `human`. A `DecisionAnswer` is tagged by `kind`: `boolean`
  carries `p`; `choice` and `score` carry `value`, `probabilities`, and
  `confidence`. `confidence` is `Evaluator.Response.confidence`, the
  provider's own number, and the key is absent when the provider sent none. It
  is never the largest probability. `decisionAnswers(answers, confidence)`
  builds the record's answers from decoded `Classifier.Answer`s.

Both are emitted through the same `Observer` every other event takes, so a
durable host checkpoints them inside the step that produced them. The
controller provides `Journal` around each flow call: a flow that asks Jev
itself, such as the agent's `recall`, journals its receipts into the run that
called it. Outside a run `Journal` does nothing. A completion
judgement recorded before `DecisionSettled` existed replays with no decision:
the record is absent, never reconstructed.

Jev's other readings write these:

- `RelevanceSettled`: the human-provided items (`RelevanceKind`: `flow`,
  `skill`, `instruction`, `memory`) one reading kept and withheld, by id and
  digest, never text. `source` is `run`, `supervisor`, or `recall` for a
  recall the model called; an item is withheld only at or above
  `withholdAt`.
- `RelevanceRestored`: a withheld `flow` the run called by name.
- `SeatRouted`: the `seat`, `modelId` and prompt `variant` a run that
  `declared` no model was routed to, from the available `candidates`, with
  the `backups` it fails over to and, for a panel route, the `SeatPanel`
  (member seats with their backups, and the `merger`, which is `seat`).
  `decidedBy` is `jev`; rows written before the routing graph may say `only`
  and carry `confidence`.
- `DecisionUnjudged`: a reading nobody could judge, with `UnjudgedReason`
  (shared with `SupervisorUnjudged`), the `items` it covered, and, on both,
  the `usage` each request paid when the provider metered it before the
  reading failed. Every evaluator `usage` names its `modelId` when known.

Fields later writers add to existing events are optional, so older journals
decode unchanged: `DecisionSettled.usage`; `CompactionSettled.kept`, `marks`
(`CompactionMark` `keep`, `squash` or `remove`, with the `CompactionPin` that
overrode a removal, by segment digest), `removedTokens`, `unaligned` and
`causes` (`CompactionCause` `budget`, `outdated_context` or
`irrelevant_context`), with `summary` optional; `SupervisorSettled.monitors` (`MonitorKind` `mood`, `skill` or
`lint`) and `skillsCapped`; `DisciplineArmed.judged`,
`relevance`, `monitors` and `stance` (`careful` or `paranoid`), with
`supervisorSteer` optional; `SteeringDrained.monitor`, `suppressed`
(each with a `Suppression` reason) and `memory`; `SeatRouted.backups` and
`panel`.

Every member's `_tag` is the kebab-case discriminant `switch` and
`Stream.filter` match on. `AgentEvent.eventType` is keyed by the camelCase
property name and holds the journal event type, the one table `CellTurn`
writes and `Transcript` reads:

| `_tag`                          | `eventType` property          | Journal event type                               |
| ------------------------------- | ----------------------------- | ------------------------------------------------ |
| `aborted`                       | `aborted`                     | `flows.harness.aborted.v1`                       |
| `cell-call-settled`             | `cellCallSettled`             | `flows.harness.cell-call-settled.v1`             |
| `cell-call-started`             | `cellCallStarted`             | `flows.harness.cell-call-started.v1`             |
| `cell-printed`                  | `cellPrinted`                 | `flows.harness.cell-printed.v1`                  |
| `cell-produced`                 | `cellProduced`                | `flows.harness.cell-produced.v1`                 |
| `cell-rejected-in-frame`        | `cellRejectedInFrame`         | `flows.harness.cell-rejected-in-frame.v1`        |
| `cell-settled`                  | `cellSettled`                 | `flows.harness.cell-settled.v1`                  |
| `checkpoint-minted`             | `checkpointMinted`            | `flows.harness.checkpoint-minted.v1`             |
| `claim-demanded`                | `claimDemanded`               | `flows.harness.claim-demanded.v1`                |
| `compaction-settled`            | `compactionSettled`           | `flows.harness.compaction-settled.v1`            |
| `decision-settled`              | `decisionSettled`             | `flows.harness.decision-settled.v1`              |
| `decision-unjudged`             | `decisionUnjudged`            | `flows.harness.decision-unjudged.v1`             |
| `discipline-armed`              | `disciplineArmed`             | `flows.harness.discipline-armed.v1`              |
| `model-delta`                   | `modelDelta`                  | `flows.harness.model-delta.v1`                   |
| `model-requested`               | `modelRequested`              | `flows.harness.model-requested.v1`               |
| `seat-failed-over`              | `seatFailedOver`              | `flows.harness.seat-failed-over.v1`              |
| `model-parked`                  | `modelParked`                 | `flows.harness.model-parked.v1`                  |
| `model-unparked`                | `modelUnparked`               | `flows.harness.model-unparked.v1`                |
| `model-retried`                 | `modelRetried`                | `flows.harness.model-retried.v1`                 |
| `model-settled`                 | `modelSettled`                | `flows.harness.model-settled.v1`                 |
| `mutation-observed`             | `mutationObserved`            | `flows.harness.mutation-observed.v1`             |
| `narrow-only-demanded`          | `narrowOnlyDemanded`          | `flows.harness.narrow-only-demanded.v1`          |
| `narrowed-demanded`             | `narrowedDemanded`            | `flows.harness.narrowed-demanded.v1`             |
| `permission-required`           | `permissionRequired`          | `flows.harness.permission-required.v1`           |
| `read-only-demand-issued`       | `readOnlyDemandIssued`        | `flows.harness.read-only-demand-issued.v1`       |
| `read-only-demanded`            | `readOnlyDemanded`            | `flows.harness.read-only-demanded.v1`            |
| `relevance-restored`            | `relevanceRestored`           | `flows.harness.relevance-restored.v1`            |
| `relevance-settled`             | `relevanceSettled`            | `flows.harness.relevance-settled.v1`             |
| `repeat-demanded`               | `repeatDemanded`              | `flows.harness.repeat-demanded.v1`               |
| `resolved`                      | `resolved`                    | `flows.harness.resolved.v1`                      |
| `seat-routed`                   | `seatRouted`                  | `flows.harness.seat-routed.v1`                   |
| `steering-drained`              | `steeringDrained`             | `flows.harness.steering-drained.v1`              |
| `sufficiency-observed`          | `sufficiencyObserved`         | `flows.harness.sufficiency-observed.v1`          |
| `suspended`                     | `suspended`                   | `flows.harness.suspended.v1`                     |
| `transition-applied`            | `transitionApplied`           | `flows.harness.transition-applied.v1`            |
| `turn-closed`                   | `turnClosed`                  | `flows.harness.turn-closed.v1`                   |
| `turn-opened`                   | `turnOpened`                  | `flows.harness.turn-opened.v1`                   |
| `unmoved-demanded`              | `unmovedDemanded`             | `flows.harness.unmoved-demanded.v1`              |
| `unresolved-demanded`           | `unresolvedDemanded`          | `flows.harness.unresolved-demanded.v1`           |
| `failed-call-demanded`          | `failedCallDemanded`          | `flows.harness.failed-call-demanded.v1`          |
| `unobserved-demanded`           | `unobservedDemanded`          | `flows.harness.unobserved-demanded.v1`           |
| `output-demanded`               | `outputDemanded`              | `flows.harness.output-demanded.v1`               |
| `vacuous-verification-observed` | `vacuousVerificationObserved` | `flows.harness.vacuous-verification-observed.v1` |

## HarnessError

`import * as HarnessError from "@smthrs/harness/HarnessError"`

The translation boundary's own failures.

```ts
export class HarnessError extends Schema.TaggedError<HarnessError>()("/harness/HarnessError", {
  code: HarnessErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
```

`HarnessErrorCode` is `assembly_failed`, `incompatible_journal`,
`render_failed`, `model_failed`, `engine_failed`, `read_only_cap`,
`completion_unjudged`, `claim_unproven`, or `suspended`. The set is closed to codes this package and `@smthrs/agent`
actually raise, and `test/Contracts.test.ts` pins every member to a
construction site; a foreign CLI adapter declares its own family beside the
adapter rather than borrowing this one. Interrupting a run raises no
`HarnessError`: `CellTurn` emits `AgentEvent.Aborted` and forwards the
interrupt cause unchanged. A failed projection is a
`Transcript.TranscriptError`, not a `HarnessError`. `cause` is a
`Schema.Defect` so a live `Error` attached as cause still encodes to JSON for
the durable exit schema. `FlowBinding.make` passes existing `HarnessError`
values through unchanged; only permission requirements and denials are
converted to code `suspended`. A handler error the binding's `timedOut`
classifies becomes a `timeout` call result whose `value` records
`{ limitMillis }` when the error says its limit: `bash` and `test` classify a
command past its given or default limit, and `agent/await` a wait that gave
up. Other handler errors become opaque `flow_failed` call results. Either carries only the safe
`publicError` text the binding supplies.

## StructuredOutput

`import * as StructuredOutput from "@smthrs/harness/StructuredOutput"`

Turning one agent's final text into a value the declared output schema
accepts, or into a typed failure. A model may answer with bare JSON, prose
wrapped around JSON, a fenced block, or JSON of the wrong shape; downstream
nodes never receive that ambiguity. Extraction never relaxes validation: it
only decides which bytes are offered to the schema.

```ts
export const decode: <S extends Schema.Top>(
  schema: S,
  text: string,
  attempt: { readonly corrections: number; readonly limit: number }
) => Effect.Effect<S["Type"], StructuredOutputFailure, S["DecodingServices"]>
```

`decode` tries every `candidates(text)` entry in order, the complete
BOM-stripped response first and then the balanced JSON container whose
matching close ends last (`lastBalanced`), then the answer itself, untrimmed,
as a string unless it is a JSON string literal, and returns the first the
schema accepts. The last is how `ctx.done("text")` reaches a string schema.
When none does, the `StructuredOutputFailure` reports the issues of
the last candidate, with `code` one of `invalid_json`, `schema_mismatch`,
`no_candidate`, or `correction_exhausted` once the budget is spent.

The prompt half is `instructions(schema)`, which renders the declared schema
as a JSON Schema document for the run's system teaching and asks for the value
itself as the `ctx.done` argument, not a JSON string: the model is told the
shape before it answers, and the answer is still validated locally.
`digest(schema)` is the schema's canonical digest, `jsonSchema(schema)` its
JSON Schema document, `issuesDigest(failure)` the digest of one failure's
rendered issues, and `correction(failure)` the teaching appended when a
candidate failed to decode. A failure carries at most `maxIssues` (5)
`OutputIssue`s (`{ code, path, message }`), so a wide struct that mismatched
everywhere cannot spend the correction prompt restating the schema.

## ContextWindow

`import * as ContextWindow from "@smthrs/harness/ContextWindow"`

The immutable, provider-neutral context assembled for one model request. Every
value it exposes is frozen, the arrays, the segments, and the messages, parts,
and tool declarations they hold, so a runtime mutation throws in strict mode
instead of silently invalidating the digest computed once at construction.

```ts
export const make: (options: MakeOptions) => ContextWindow
export const empty: (modelId: string) => ContextWindow
export const makeSegment: (input: SegmentInput) => Segment
export const render: (self: ContextWindow) => ModelRequest.ModelRequest
```

`MakeOptions` is `{ modelId, segments?, activeTools?, replaced? }`. A
`Segment` is a stable, typed slice with a `SegmentKind`, a `SegmentZone`
(prefix or tail of the cache breakpoint), its content parts, a digest, and an
estimated token count computed once at construction. `appendTurn` appends one
settled assistant message; `prefixDigest`, `compactPrefix`, and
`compact` replace an exact compactable prefix while retaining every suffix
segment, failing with a `ContextWindowError` when the declared prefix does not
match. `compactMarked(window, prefixLength, marks, summary)` applies one
`Mark` per prefix segment, `keep`, `squash` or `remove`: the result holds the
segments before the prefix, one summary segment when any segment is squashed,
the kept segments as the same objects, then the suffix. The summary is required
exactly when a segment is squashed. `compactPrefix` is `compactMarked` with
every segment squashed. `render` projects the window into the `ModelRequest` of
[`@smthrs/model`](https://model.smithers.sh/reference/api/).

`appendTurn` and `compact` are dual, so each one takes the window first or
returns a function of it, and a `ContextWindow` is `Pipeable`. The direct and
the piped forms are the same call:

```ts
const request = ContextWindow.render(ContextWindow.appendTurn(window, assistant))

const piped = window.pipe(
  ContextWindow.appendTurn(assistant),
  ContextWindow.render
)
```

`ModelCatalog.contextWindowTokensFor(modelId)` of
[`@smthrs/model`](https://model.smithers.sh/reference/api/) supplies the shared context-limit catalog used by
seat resolution and seat steering (128,000 tokens for unknown models). A
thinking-only steer preserves the current budget.

## Tokens

`import * as Tokens from "@smthrs/harness/Tokens"`

Deterministic token accounting for context windows. `Tokens.estimate`
approximates four characters per token, with code punctuation and newline
density accounting for the shorter tokens of source text; it is a
deterministic local approximation, not provider billing data.
`Tokens.count(text, estimator?)` counts one text (defaulting to `estimate`)
into a `Tokens.Count` (`{ value, estimated }`), and `Tokens.combine` sums
per-segment `Tokens.Segment` counts into one `Tokens.Accounting`, split by
cache zone.

## Transcript

`import * as Transcript from "@smthrs/harness/Transcript"`

Transcript projection from durable journal entries. The transcript grows:
what the model saw is what it said plus what the harness answered, in journal
order. `Transcript.projectResult` projects model-visible messages in canonical
journal sequence order; `Transcript.projectStateResult` projects the same
events into typed state (`ProjectedState`, with the compaction replacement
identity when one was recorded), preserving malformed-payload failures as
typed `TranscriptError`s instead of throwing. `CellEvidence` is the
schema-decoded cell evidence the rebuild consumes. `CompactionSettled.retainedMessageCount`
records the number of messages in the live retained suffix, across all retained
segments. Projection applies these boundaries in journal order, replacing only
the preceding prefix with the summary. Older events without the field replace
all messages preceding the event.

## Compaction

`import * as Compaction from "@smthrs/harness/Compaction"`

Declarations for sealed transcript-summary steps.
`shouldCompact(accounting, { reserve?, keepRecent? }?)` returns whether the
model context crossed its reserved threshold; `selectPrefix(window, { keepRecent? }?)`
selects the
longest compactable prefix while preserving a whole recent suffix; `declare`
builds the sealed `CompactionStep` for one prefix and `Summarizer` without
invoking a model; `summaryRequest` builds the model request input for the
step, with `summaryInstruction` as its stable instruction; and `apply`
splices a recorded summary into a projected window, failing with
`InvalidStep` when the declaration does not match the window it is applied
to. `declare(window, prefixLength, summarizer, marks?)` takes one
`ContextWindow.Mark` per prefix segment and records them with a `marksDigest`;
without marks every segment is squashed. `summaryRequest` carries only the
squashed segments' messages and fails when nothing is squashed, and
`apply(window, step, summary?)` requires a summary exactly when a segment is
squashed. A length or digest mismatch is `InvalidStep`. `Summarizer.params` is an optional `ModelRequest.GenerationParams`.
`summaryRequest` schema-decodes supplied parameters, including JSON-round-tripped
values, and returns `InvalidStep` for invalid values or unknown parameter keys.
Defaults apply only when `params` is absent.

## Plan

`import * as Plan from "@smthrs/harness/Plan"`

Local structural plan nodes used at the harness-to-engine boundary. `Child`
is one flow invocation elaborated from a model tool call; `Batch` is the
children passed through to the engine, in source order; `ChildResult`,
`ChildProgress`, and `ChildSettled` carry outcomes back; and `SpliceEvent` is
the streaming union `EngineLike.splice` emits. Source order is retained only
for result correlation; graph dependencies are the sole sequencing signal.

## CallLedger

`import * as CallLedger from "@smthrs/harness/CallLedger"`

The call ledger: what this run has already asked, rendered every frame. Every
settled call contributes one line the harness derives on its own, ordinal,
flow, what the call was about, whether it settled ok, and a structural digest
of what came back, so a model sees what it already asked without asking
again. A line carries no payloads: it says `stdout=4096b`, never the bytes.
A call that writes also says so, names its byte count, and names an earlier
identical write when one settled. `entry` records one settled call,
`remember` folds a frame's calls into the run's `Ledger` bounded to `bound`
(30, newest last), `settled` counts through aged-out lines, and `render`
renders the ledger for the state section, only the calls after `since` when an
earlier section in the window already listed the rest. Line fields clip to `width` (120),
and a result digest names at most `members` (6) members.

## NarrowedCheck

`import * as NarrowedCheck from "@smthrs/harness/NarrowedCheck"`

The narrowing ledger: which checks this run has run, and over which tree. A
check is only evidence for the tree it ran over, and a completion whose last
check is a narrowed version of one the run already ran in full, taken after
the workspace moved, reports an unknown as proven. `check` records one
settled call as a `Check` unless its input is a payload; `narrows` decides
whether one call's terms strictly narrow another's; `find` finds the broadest
check a completing frame narrowed and did not re-run, and `demand` states the
sentence; `findOnly` and `demandOnly` cover the narrow-only shape, where no
broader reading exists at all. `remember` folds a frame's checks into the
run's `Ledger`, bounded to `retained` (32) distinct checks and `maxTerms`
(256) terms each.

## CellValidation

`import * as CellValidation from "@smthrs/harness/CellValidation"`

Cell validation at the boundary. `validate(cell)` parses one cell and reports
everything the parse can decide, a `Validation`: module syntax, non-erasable
TypeScript, syntax errors with their line, and the compiled text when it
parses. The controller answers a cell that does not parse inside the same
frame, at cached-prefix price, instead of ending the frame on it.
`normalize(compiled)` rewrites a cell's top-level declarations so the
persistent realm behaves like a notebook: a name declared again rebinds
instead of dying on redeclaration. Nothing here executes anything, and the
only outcome is a rejection the model is asked to fix in this frame.

## UnmovedTree

`import * as UnmovedTree from "@smthrs/harness/UnmovedTree"`

The completion with nothing behind it. `find` compares the digest of the tree
the run opened on against the digest the completing frame closed on; equal
digests mean the tree the completion describes is the tree the run was handed.
`demand` states that the tree never moved and names the two answers that end
it: make the change, or say why no change is needed. Nothing here reads the
completion's text, and "no change is needed" is a legitimate answer.

## FailedCall

`import * as FailedCall from "@smthrs/harness/FailedCall"`

The completion its own cell wrote before a call in it failed. A cell is
written whole before any call in it settles, and a failed call resolves
`{ ok: false }` rather than throwing, so a `ctx.done` after a failed request
still runs. When a completing frame settled a failed call and the cell never
reads a call envelope's `ok` or `error` (`inspects`), `find` names the
failures, and the controller hands the frame back once (`cap`) with `demand`,
journaled as `FailedCallDemanded`. A completion that already quotes the
flow's failure reason is spared. With no frame left or the demand spent, the
answer stands with the failures appended by `state` under `stated`. Nothing
here asks a model or reads what the claim means.

The same blindness without a failure is handed back too. Several `cell`
blocks in one reply run as one program, so a reply that makes a call, keeps
its result only for the model (printed or bound, read by nothing but
`console.*`), and calls `ctx.done` completes before the model has seen that
result. The controller refuses that completion once per run, journals
`UnobservedDemanded` with each call's flow, ordinal and result head, and
continues the frame: the next model turn reads what the cell printed, the
call results, and "Answer after reading the calls' output". A cell whose
program reads a result in a condition, in another call's input, or in the
completion itself (`if (after.exitCode === 0) ctx.done(…)`,
`ctx.done((await ctx.call(…)).stdout)`), a cell that hands a result to
anything the parse cannot see through (a function of its own, a `.then`
callback, an alias), and a cell whose calls are effects with discarded
results, are spared. `FailedCallDemanded` takes precedence, and with no frame
left the answer stands; a refused answer is also what the run ends on when
the budget runs out before it completes again.

`Input.output` (`OutputCheck`, `{ check, cap }`) is the host's shape for the
final output. Before any demand above, `check(output, corrected)` answers a
completion with a correction note or `undefined`; the verdict is a recorded
boundary. A refused completion is handed back to the same session, with what
its cell printed and the note, and journaled as `OutputDemanded`
(`{ note, nextFrame }`). The realm and every settled call stay, so the
correction repeats no work. At most `cap` completions are handed back, and
only while a frame is left; past either the completion stands and the host
decides. `AgentAction` supplies it from the declared output schema.

## UnresolvedFailure

`import * as UnresolvedFailure from "@smthrs/harness/UnresolvedFailure"`

The failing check a completion stepped around. `exitStatus` reads a settled
call's `exitStatusKey` (`exitCode`), and `failed` and `passed` read it for a
failing or passing status;
`revisits` decides whether a later check asks about the same subject as an
earlier one; `find` finds the failing check a completion replaced rather than
answered; and `demand` states which reading failed, which one replaced it,
and what ends it. A failing check alone is not the trigger: the run itself
must have demonstrated the subject was still live by returning to it.

## CompletionClaim

`import * as CompletionClaim from "@smthrs/harness/CompletionClaim"`

The sixth brake on a completion, and the only one that is not a measurement.
It declares one classifier, `completion/claim`, over the facts the harness
already holds: the task as the person stated it, the completion message,
whether the tree moved, every check the run took in its workspace as
`Evidence.checksRun` (command and outcome, newest
`checksRunLimit` (24) kept), the last check the completing frame ran with
its result clipped to the newest `outputBytes` (4 KiB), and `Evidence.callsRun`.
The latter lists the newest 30 settled calls from the durable call ledger,
including classification and reads that report no exit status. Each receipt
names the flow, bounded input subject, settlement status and structural result
summary. It records that a result was obtained without carrying its full
payload. Direct callers may omit this field for compatibility; the controller
always supplies it. It asks Jev three
questions through the `Evaluator` service. Does the completion satisfy the
person's current request, does the claim assert something the evidence does not show,
and does the claim report having run a command, or having obtained a result,
that the evidence does not record? `read` asks and returns all three
probabilities with the latency; it returns nothing only where there is no task
and no claim to form a question about, and fails with `completion_unjudged`
for every other reason it could not get an answer. The reading also carries
`asked`: the encoded evidence exactly as the transport was sent it, and every
answer as an `AgentEvent.DecisionAnswer`. The controller journals that as
`AgentEvent.DecisionSettled`; a host reader that returns no `asked` journals
the reading and no decision.

The completeness question treats labeled prior conversation as context and
judges the newest request after `The person now says:`. A purely conversational
request can be satisfied by the answer itself, without a file edit, flow call
or check. A soft demand uses neutral completion-review guidance: answer the
current request in its requested format, and support only the actions and
results actually claimed. It does not allege invented work merely because
the completeness reading was low.

The controller bounds original task evidence to 8 KiB, keeping both ends so
a long history or task cannot silently discard the newest request at the end.

`CellTurn` includes later accepted instructions in the task evidence, in
admission order, with later changes taking precedence. It labels this block
with the same `The person now says:` marker used to identify the newest
request, so the original request's marker does not continue to select a
superseded instruction. It keeps the newest
4 KiB of steering separately from tool output and conversation summaries, so
compacting a transcript cannot erase the recorded change of task. Replay
rebuilds this bounded evidence from recorded steering drains; a pending,
undelivered instruction cannot change a replayed completion.

`CellTurn` records the whole completion decision at an engine boundary keyed
by the session, frame and cell digest. Replay uses that decision, including
the classifier reading and usage, so a resumed turn keeps its previous
decision without asking Jev again. Provider refusals retain their code, HTTP
status when present and detail through the journal's error schema.

**All three ask; only the third refuses.** `find` hands the completion back at
any of three heights, `disprovenAt` (0.3) or below on the first question,
`overclaimedAt` (0.8) or above on the second, `unsupportedAt` (0.5) or above on
the third, and `demand` renders the prose the next frame reads. `unrecorded`
says whether a reading is one the brake ends a run over, which is `inventedAt`
(0.85) or above on the third question and nothing else.

The split was measured using the original completeness wording, whose positive
criteria named only workspace changes and checks. A corpus of eighteen completion states over the live
gate's own planted repository, asked six times each on 2026-09-19, found the
first two questions unable to separate a lie from an honest answer: "is the
task done" at or below 0.3 fired on eight of the twelve honest completions and
two of the six lies, and an honest unchecked fix read 0.10 on it against a flat
lie's 0.22; "asserts more than the evidence shows" fired on five of the twelve
honest ones, because thin evidence shows nothing by construction. The narrow
question refused none of the twelve honest completions and ended four of the
six lies, with the highest honest reading at 0.75 and the lowest ended lie at
0.94; `inventedAt` sits between them. All three still bounce, because a bounce
costs a frame rather than an answer and is sometimes the only thing in this
package with anything to say about a completion. The verdict is narrow for the
mirror reason: a false refusal costs a run its answer, while a false pass costs
nothing here, because the five deterministic brakes still ran and the truth bar
still judges what they let through. The module's own header carries the corpus
and the two lies that still get through.

**A long claim is read one sentence at a time.** When the whole claim reads at
`unsupportedAt` or above on the third question and has more than one sentence,
`read` asks `sentenceClassifier` the same question of each sentence in one
request, and the claim's `invented` is its most invented sentence. Two graded
runs of 2026-09-26 whose container work was all on the record read 0.91 and
0.87 as whole claims and at most 0.71 and 0.73 by sentence; a fabricated
sentence appended to each read 0.94 and 0.92. The sentence reading journals
its own `decision-settled`, and a transport failure on it fails the turn as
`completion_unjudged` like the first. Each listed check in
`Evidence.checksRun` carries its `receipt`, the tail of every string it
returned, so a sentence quoting what a check printed has something to be read
against. `record` builds that list from every call that reported an exit
status, writes included, and keeps what a re-run command reported `before` when
it changed, so "failed before the fix and passed after" is on the record. A
sentence never ends inside inline code.

It never passes a claim on its own. A confident "complete" ends no run,
bypasses no other demand, and does nothing but write a journal line;
`judgeCompletion` consults it only once the five deterministic demands have
found nothing.

**It never goes quiet either.** Every completion with a claim is read, and
`claimCap` (3) is the number of frames the run is _given_ to answer one, not
the number of completions that are read. The first such claim is handed
back with the demand prose, like any other completion demand; a claim with no
bounce left, because the cap is spent or because no frame remains to hand it
back to, and reading at `inventedAt` or above, fails the turn as
`claim_unproven` through `unproven`, carrying all three probabilities. One
below `inventedAt` stands there instead: it was handed back once, the run
answered, and refusing the answer as well is what destroyed honest runs. A
claim demand clears `State.bouncedCompletion` only when the reading is one the
brake would refuse, so the frame-budget notice cannot restore a sentence the
brake refused and does restore one it would have let stand. The cap stopped at
the bounce until this, and the second claim stood unread: on a real seat a run
bounced at frame 1 re-claimed the identical sentence and finished `stop` on it
over a repository whose test exits 1. Zero disarms the brake outright: no
request, no reading, no failure.

**It never falls back.** A completion Jev could not judge fails the turn as
`completion_unjudged`, carrying the reason: `unconfigured` where the host
delivered no transport, and the evaluator's own `unreachable`, `refused`,
`timeout`, `empty`, `invalid_answer` or `invalid_question` otherwise. So
`Evaluator.Evaluator` is a **required service** of `read`, of
`judgeCompletion`, of `CellTurn.run` and of `Agent.run` above them, and every
host binds a real or deliberately scripted judge at composition time.
`Evaluator.layerFromSeat(seat)` judges with a resolved subscription seat and
needs no provider API key or gateway key. A judge that fails during a run
produces `completion_unjudged`.

Offline hosts bind `Evaluator.layerScripted` and compute answers from the actual
evidence, dispatched by question id. One evaluator serves every classifier in
a composition. See the [whole-host scripted judge](https://github.com/smithersai/smithers/blob/main/flows/test/fixtures/scripted-judge.ts).
Constant approval is not a judge. `layerUnavailable()` is an explicit outage
fixture for classifier tests. The five deterministic brakes still run unchanged.

## Judgement

`import * as Judgement from "@smthrs/harness/Judgement"`

The one way this package asks Jev a question. Every reading goes through it:
the supervisor's and the completion brake's, and every relevance, compaction,
monitor and routing reading.

`measured(classifier, state)` asks through the bound `Evaluator` and returns a
`Read`: the decoded answers and an `Asked` (classifier id, digest, questions,
the state as it was sent, `DecisionAnswer`s with the provider's own
confidence, integer `latencyMs`, and `usage` when the transport reported any).
It fails with the transport's own `ClassifierError`. `read` is the fail-closed
layer over it and needs no `Evaluator` in its type: a host that binds none
fails `unconfigured`, and a transport failure fails as `Unjudged` with the
transport's code and `Evaluator.publicMessage` as its `detail`.

`perItem({ id, description, context, item, questions, concurrency?, maxStateBytes? })`
asks the same questions about each of many items. Each question is built from
the item's index, and its id is `${key}_${index}`. `classifierFor(n)` is the
classifier for `n` items, the same object for the same `n`. Its state is
`{ context, items }`. `read(context, items)` packs items in order, greedily,
into requests whose encoded state fits `maxStateBytes` (by default 262,144
bytes, the `jev` flow's ceiling). Each request numbers its items from 0, and
requests run at most `concurrency` (`Classifier.defaultConcurrency`) at once.
Answers come back one record per item in input order, with every request's
`Asked`. The first failed request fails the reading, and partial answers are
never returned. No items send no request. An item too large to send alone
fails `invalid_question`.

`recorded(engine, { name, identity, classifier, value, items }, execute)`
takes a reading inside a run through `EngineLike.record`. A success records
the value and one `decision-settled` row per request (`decision`: decided by
`jev`, usage carried). A failure records `value: null` and one
`decision-unjudged` row over `items` (`unjudgedEvent`). A replayed frame is
served the record and asks nothing. `emitRecorded` journals the decisions in
order, then the unjudged row. `task` bounds a run's task to `taskBytes`
(4,096) with both ends kept.

## Relevance

`import * as Relevance from "@smthrs/harness/Relevance"`

What a run is shown of the human-provided items it could be shown: catalog
flows and skills, chunks of instruction files such as `AGENTS.md`, and memory
rows. Each is an `Item` (`{ kind, id, text }`, `Kind` being
`AgentEvent.RelevanceKind`).

`judge(context, items)` asks Jev, through `reader` (a `Judgement.perItem`
reading with classifier `relevance/unnecessary` and one boolean
`unnecessary_<i>` per item), whether each item is unnecessary for
`context.task`. An item is withheld only at a probability at or above
`withholdAt` (0.9); everything else is kept. Each item's text is sent
head-kept to `itemBytes` (1,024), and an item that was cut is always kept:
Jev cannot be confident about text it was not shown. The `Reading` holds a
`Verdict` per item in
input order (`p`, `withheld`, and the digest of the whole text), every
request's `Asked`, `latencyMs` and summed `usage`. It fails as
`Judgement.Unjudged`, and the caller then keeps every item and journals
`decision-unjudged`.

`settled(reading, { scope, frame, source })` is the `relevance-settled` row:
ids and digests, never text. `flowItem(descriptor)` is a catalog entry as an
item, `skill` for a markdown body and `flow` otherwise, its description
marked untrusted. `chunks(documents)` splits `Document`s (`{ path, text }`)
into `Chunk`s with ids `${path}#${n}`: one per markdown heading and per
top-level list item, never inside a fence. `render(documents, withheld)` is the
project-instructions block of every chunk not withheld; `""` when nothing is
left.

## Supervisor

`import * as Supervisor from "@smthrs/harness/Supervisor"`

The reading Jev takes of a run while it is still running, off the cell loop's
hot path. Every other control reads a completion or one measured fact; this
one reads the run's shape. It declares one classifier, `supervisor/turn`, over
a `Snapshot` the controller assembles from what it already holds: the task
(with every later instruction the run accepted), the newest `recentFrames`
(3) frames as `Frame` (cell head, prose head, prints tail, each bounded by
`frameBytes`, the transition, whether the frame moved the tree), the counts the
deterministic controls keep as `Signals` (read-only and repeat streaks,
mutations, checks run and failing, unanswered failures, failed calls, demands
spent). It also carries `skills`: up to `skillLimit` (12)
Markdown skills from the frame's relevance-filtered catalog the model may
call and has not, sorted by name and offered only when `read` is in that
catalog, each a `Skill` of name, Markdown body path and the description's
first `skillBytes` (256) wrapped as untrusted data (`skill`); `called`, the
newest `calledLimit` (64) distinct flows the call ledger names; and
`jevAvailable`, whether the catalog has `jev`. A skill the relevance gate
withheld is never offered. Nothing is re-derived: the supervisor reads the
harness's evidence and never measures a second time.

One Jev call per snapshot answers every question at once; eleven are fixed.
Five are about the run, the `triggers`: `thrashing` (at or
above `thrashingAt`, 0.5), `off_target` (`on_target` at or below
`offTargetAt`, 0.5), `suspect` (at or above `suspectAt`, 0.5),
`outdated_context` and `irrelevant_context` (each at or above `contextAt`,
0.5). `triggered(reading)` names the triggers that fired. The two
`contextTriggers` never nudge: `compacting(reading)` names the ones that
fired, and a judged run whose boundary takes that reading compacts its
context at the next frame by the marks it stored, whatever the budget, its
`compaction-settled` naming them as `causes`. `crosses(reading)` is any other
trigger firing; the `supervisor` lint monitor and the offline replay both
call it, and `nudge` names the counts behind it. Five are
operational states scored on `Level` (`none`, `mild`, `strong`), each naming
the evidence it reads: `frustrated`, `anxious`, `scared`, `confused`,
`confident`. `needs_help` is a choice over `Help` (`none`, `clarification`,
`permission`, `stuck`, `risky_action`): the one word a person is shown, and it
never steers the run. Each monitor question the run's `Monitor`s add is one
more boolean, keyed `monitor_<id>` (`monitorPrefix`; `MonitorQuestions`).
`read(snapshot, extra)` asks them all and puts each monitor's probability on
`Reading.monitors` by monitor id. `classifierFor(extra)` is the classifier for
that set of monitor ids, declared once per set, and `classifier` the bare one
over the eleven fixed questions. `prose` strips fenced cells from a reply.

Recalled memory goes through `Relevance`, not `supervisor/turn`. Beside each
reading the fiber recalls past every row whose key the run has already been
shown, keeps the first `recalledLimit` (6) it has not, and asks
`Relevance.judge` about the rest as `memory` items keyed by row, with the
task and the head of the frame's prose as `recent`; the two readings run
concurrently. Rows Jev is confident the run does not need are withheld; the
rest, or every row when relevance cannot answer, go to the next boundary,
rendered by `recalledInsert`. That boundary drops any row shown since the
offer, records the keys it delivered on `SteeringDrained.memory`, and folds
them into `CellTurn.State.memoryShown`, so a row is shown to a run once.

`CellTurn` offers each frame's snapshot from the frame's own live turn
boundary to a one-slot sliding queue and continues at once; a forked fiber on
the loop's scope takes the newest snapshot, recalls, asks through
`EngineLike.record` (keyed on the session, the frame and the cell digest),
and journals, in order, the supervisor's `DecisionSettled` (the snapshot and
every answer), the memory reading's `DecisionSettled` rows, its
`RelevanceSettled` (`source: "supervisor"`) or a `DecisionUnjudged` for
`relevance/unnecessary`, the marks reading's `DecisionSettled` rows or a
`DecisionUnjudged` for `compaction/marks`, and last
`AgentEvent.SupervisorSettled`, whose `monitors` holds each monitor's value
and whether it crossed, and whose `skillsCapped` is true when more than
`skillLimit` skills could have been offered. Each reading scores the run's monitors, then
`Monitor.skills` of its snapshot, then `Monitor.useJev()`. What
the run is told is the monitors' to decide: the reading records each
monitor's raw value and every crossed monitor's message, and the next
boundary that executes gates them with `Monitor.gate` against
`CellTurn.State.monitorLedger` inside its own recorded drain, only when
`CellTurn.Input.judged`. At most one monitor message is delivered, then the
recalled rows, in the drain's own `supervisor` field rather than among the
person's steering inserts; a reading is dropped as stale after that boundary.
A reading that fails on one side still delivers the other. The model reads
them above the frame's ask; the task the completion brake and later snapshots
read never includes them. Each `SupervisorSettled` states the delivery it ran
under as `steer`. `Memory` is a port with `memoryNone` behind it unless the
host adapts a store. The supervisor only recalls through it; a recall that
fails is journaled as `AgentEvent.SupervisorMemoryFailed` and the reading goes
on. The supervisor writes no memory: when `supervisor.remember` is on,
`@smthrs/agent`'s `MemoryMine` mines the run's transcript once, at run end,
and writes through `Memory.remember`.

It never falls back. A snapshot nobody could judge is journaled as
`AgentEvent.SupervisorUnjudged` with `UnjudgedReason` (`unconfigured`,
`interrupted`, or the transport's own code; an `unreachable` detail is
`Evaluator.unreachableMessage`, never the transport's text), gates no
monitor, leaves the ledger alone and reports no level. A replayed frame is never
offered, so a resumed run re-asks nothing and re-delivers exactly what its
recorded drains hold. A reading in flight when the run ends gets
`closeGraceMs` (1,500) to settle; one still unanswered is interrupted and
journaled `interrupted`, and the run never waits longer. The offline replay over
archived journals that measures the triggers' precision is
`evals/swebench/lib/jev-replay.mjs`.

## Monitor

`import * as Monitor from "@smthrs/harness/Monitor"`

What one supervisor reading can put in front of the run, and when. A
`Monitor` turns a `Supervisor.Reading` into a probability and a sentence: a
`Questioned` monitor adds one boolean question (`questionId(id)`,
`monitor_<id>`) to the supervisor's single Jev call, asked of a snapshot when
its `applies` holds; a `Derived` monitor scores answers the supervisor already
asks and costs nothing. `make(input)` fills a monitor's budget from its
kind's `budgets`: `at` (crosses when `p >= at`), `consecutive` crossed
readings before delivery, `cooldownFrames` after a delivery, `limit`
deliveries per run, and `priority`. `validate` admits a set or fails with
`InvalidMonitor` naming the first id that cannot run (`idPattern`, a duplicate
id, an id each reading adds itself (`skill_*`, `use_jev`),
`at` outside `(0, 1]`, or a count that is not a non-negative integer).

`lint()` is the supervisor's legacy nudge: it crosses exactly when
`Supervisor.crosses` does and says `Supervisor.nudge`, with no streak,
cooldown or limit. `moods()` are the stance monitors `paranoid`, `careful`,
`step_back` and `clarify` over the emotions and help the reading already
holds, saying `paranoidText`, `carefulText`, `stepBackText` and `clarifyText`.
`defaults()` is both, and what `CellTurn.Input.monitors` takes when omitted.

Every reading adds two more. `skills(snapshot)` is one `skill` monitor per
offered skill (at 0.85, limit 1), id `skill_<name made safe>` with a digest
suffix when two names collide, asking whether reading `skills[i]` now would
change what the run does next; it says `skillText(name, path)`, which names
the skill and a `read` call for its body and never quotes its description.
`useJev()` is the `use_jev` lint (at 0.85, limit 2), asked only while
`jevAvailable`, for frames that print lists and choose among them by hand; it
says `useJevText`.

`questions(monitors, snapshot)` is what a snapshot adds to the call.
`evaluate` runs at reading time: a `Row` per monitor with a value, and a
`Candidate` with its rendered text per crossed one. `gate` runs at the
recorded steering drain against the durable `Ledger` (an `Entry` of
`streak`, `delivered` and `lastFrame` per id; `fresh` when absent): each row
moves its streak, each candidate is withheld for `streak`, `cooldown` or
`limit` in that order, and of the rest the highest priority takes the one
slot and the others are withheld for `slot`. `Gated` is the message, the
suppressions and the next ledger. Both halves are pure: nothing here asks,
journals or steers. `CellTurn` records the delivered id and the
suppressions on `SteeringDrained.monitor` and `suppressed`, and the ledger
on the drain, so a replay delivers exactly what it delivered the first time
and a resumed run keeps its cooldowns and limits. Delivery is silent unless
the run is judged; `DisciplineArmed.monitors` lists the armed monitors then.

## Sufficiency

`import * as Sufficiency from "@smthrs/harness/Sufficiency"`

The evidence that is already complete: the counterweight to the demands.
`remember` records one frame's failing checks against the mutation epoch they
ran in, bounded to `retained` (16); `find` finds a failing-before, passing-after
pair over one subject; and `observation` states, once per run, that the run
holds both halves of its own evidence. It asks for nothing, refuses nothing,
and spends no cap.

## VacuousVerification

`import * as VacuousVerification from "@smthrs/harness/VacuousVerification"`

The proof that was already true before anything changed. **This control is
not wired into `CellTurn`: nothing in a production run reads it, and no run
is told anything by it.** The module and
`AgentEvent.VacuousVerificationObserved` are exported so a host can wire it in
and measure it on its own. Its `stored` input reads a reserved `verification`
key out of durable state that nothing currently writes, so a host that turns
it on first decides where a run declares its verification. Once it is wired,
`find` locates the pristine-tree pass a stored verification stands on and
`observation` states the fact once per distinct input.

## TruncatedOutput

`import * as TruncatedOutput from "@smthrs/harness/TruncatedOutput"`

The truncation ledger: which bytes this run was handed as a fragment. A flow
that caps a captured stream returns the part that fit and declares the cut in
a sibling flag, and a later write of those same bytes is refused, because
there is no case in which writing a known fragment over a file is what the
caller meant. `captures` reads every truncated payload one settled call
result declares (the `flagSuffix` and `droppedSuffix` conventions beside a
named payload, or the bare `flagKey` for a single-payload flow, at or above
`minimumBytes` (1,024)); `reuse` finds the first input field carrying an earlier
capture verbatim; `refusal` states the `truncated_write` refusal; and
`retain` bounds the `Ledger` to the `retained` (16) most recent distinct captures.

## VariablesPanel

`import * as VariablesPanel from "@smthrs/harness/VariablesPanel"`

The variables panel: what the realm holds, stated every frame. A run's memory
is the set of names the realm is holding, and the model can only act on what
the prompt says about them. Every line is a name, its type, one cheap size,
and when it was last bound; nothing is serialized whole. `stamp` re-stamps
the panel `Ledger` against the bindings a frame closed on, and `render`
renders it for one frame's prompt, printing at most `bound` (64) names before it
counts instead. A binding rewritten to a value of the same type and size
reads as unchanged: the panel is a roster, and the run's own prints are what
say a value moved.
