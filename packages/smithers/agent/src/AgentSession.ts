/**
 * One control-plane launch, run as one durable agent session.
 *
 * This is the production `ControlExecutor`. `ControlLive.run` resolves the
 * executor through `Effect.serviceOption`, and until this module existed
 * nothing provided one, so every accepted run stayed `pending` forever. What it
 * does is take a stored plan, find the flow's descriptor and prompt body in the
 * registry, resolve the flow's declared seat through {@link SeatResolver}, and
 * run {@link module:Agent} as the body of one durable flow execution whose id
 * is the control run id.
 *
 * The session is the adapter, not the agent. Everything about how a frame is
 * built, sealed, and replayed belongs to `Agent`; what belongs here is the
 * control-plane half — status fencing, the resume bridge, the approval gate,
 * and the journal trail.
 *
 * What the composition declares, because the spec says a host must:
 *
 * - **Explicit sandbox limits.** `Options.limits` is required; an unlimited
 *   QuickJS cell can hang the frame, so there is no default-unlimited path.
 * - **A resolved context window.** `Seat.contextWindowTokens` comes back from
 *   the host's `SeatResolver`, so compaction is armed instead of silently
 *   disabled at zero. `SeatResolver.contextWindowTokensFor` is the catalog for
 *   known models.
 * - **Steering from the durable queue.** The `Steering.Source` is
 *   `@smthrs/harness/Notifications` over the same journal-backed queue
 *   `Control.steer` admits into, so an operator steer reaches the loop at the
 *   next frame boundary.
 * - **Approval through control.** The `ask` flow is gated in the `authorize`
 *   hook — before the durable boundary opens — by registering an in-run
 *   approval token (`ControlRuntime.registerApproval`) and failing with an
 *   encoded `Permission.PermissionRequired`, which the controller turns into
 *   a real durable park. `Control.approve` resolves the token and installs
 *   the grant; the resumed attempt re-asks against the grant store as it now
 *   stands and proceeds. The park is decided outside the activity on purpose:
 *   a requirement raised inside one would be journaled and replayed forever.
 *
 * Run-status writes stay fenced: the executor waits for the control plane's
 * own `running` transition before the engine starts, writes
 * `waiting-approval` when the execution parks, and writes the terminal status
 * when it settles. Resumption is event-driven — the executor follows the
 * journal for the control plane's resume events and re-drives the parked
 * engine execution.
 *
 * Prior art: Effect's workflow runtime (register/execute/poll/resume), adapted
 * by `@smthrs/engine`, and OpenCode's scope-owned background session driver.
 * These are upstream designs, not paths in this repository.
 *
 * @since 0.1.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { ControlFacts } from "@smthrs/control"
import { EnvelopeMismatch, LaunchFailed, PersistenceError } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime, type PendingResume } from "@smthrs/control/ControlRuntime"
import { Envelope, type PlanCard, type RunStatus } from "@smthrs/control/ControlSchema"
import * as Digest from "@smthrs/core/Digest"
import { ExecutionFacts } from "@smthrs/engine-store"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { AttemptEvidenceQuarantined } from "@smthrs/engine-store/Errors"
import { Action, DurableDeferred, Fault, Flow, FlowRuntime, WaitFor } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import * as CellTurn from "@smthrs/harness/CellTurn"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as HarnessError from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Transcript from "@smthrs/harness/Transcript"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as MemorySnapshot from "@smthrs/memory/SnapshotRecorder"
import type * as MemorySource from "@smthrs/memory/Source"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"
import { Agent, type Options as AgentOptions } from "./Agent.ts"
import * as Budget from "./Budget.ts"
import { agentOutcome } from "./internal/AgentOutcome.ts"
import { callId } from "./internal/CallIdentity.ts"
import { failureJson } from "./internal/FailureJson.ts"
import { failureSummary } from "./internal/FailureSummary.ts"
import { latestPendingApproval } from "./internal/PendingApproval.ts"
import { unordered } from "./internal/TraceOrder.ts"
import { waitingAnnotation } from "./internal/WaitingAnnotation.ts"
import type * as QuotaPolicy from "./QuotaPolicy.ts"
import * as RunawayGuard from "./RunawayGuard.ts"
import * as Seat from "./Seat.ts"
import { contextWindowResolver, SeatResolver } from "./SeatResolver.ts"
import * as SeatRouter from "./SeatRouter.ts"
import * as StandardFlows from "./StandardFlows.ts"

/**
 * Everything the host decides about the composition.
 *
 * `limits` is required on purpose: the composition never runs a cell without
 * an explicit memory and step budget. `flows` is the host's executable
 * catalog — filesystem, shell, memory — while the durable wait and the
 * control-wired approval are composed here, because they belong to the
 * engine and the control plane rather than to the host.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Workspace AGENTS.md files sent to the relevance gate. */
  readonly workspaceInstructions?: AgentOptions["instructions"]
  /** Host flow sources a judged run must always offer. */
  readonly pinnedSources?: AgentOptions["pinnedSources"]
  /** Host-selected profile instructions, sealed before the first model call. */
  readonly instructions?:
    | ((launch: {
      readonly descriptor: Descriptor.FlowDescriptor
      readonly text: string
      readonly capabilities: ReadonlyArray<string>
    }) => Effect.Effect<ReadonlyArray<string>, unknown>)
    | undefined

  /** Host-selected opening context, frozen in this run before the first model call. */
  readonly memory?:
    | ((launch: {
      readonly runId: string
      readonly prompt: string
      readonly history: ReadonlyArray<string>
      readonly capabilities: ReadonlyArray<string>
    }) => Effect.Effect<MemorySource.Declared, unknown>)
    | undefined
  /** Native host callback commits intent and facts to its captured engine journal.
   * Standalone legacy compositions without it retain row-only cancellation.
   */
  readonly requestNativeCancel?: ControlExecutor.Service["requestCancel"] | undefined
  /**
   * Age at which an unanswered resume delegation may be adopted by another
   * host. Defaults to `Ownership.heartbeatStaleAfter`; the cutoff is inclusive.
   */
  readonly abandonedParkAfter?: Duration.Duration | undefined
  /** Refuse resume delegation for a run routed to another workspace host. */
  readonly canExecute?: ((runId: string) => Effect.Effect<boolean>) | undefined
  /** Binds an explicit resume to the currently released native children before driving. */
  readonly authorizeReleasedChildren?: ((runId: string, sequence: number) => Effect.Effect<void, unknown>) | undefined
  /**
   * Holds a terminal control status until the host has copied this run's
   * native evidence into the control journal.
   *
   * The two writes are independent: this executor journals
   * `control.run.completed` from the flow body's exit, while the
   * `flows.engine.run-decision` carrying the run's output is committed by the
   * engine after the handler returns and copied afterwards. A reader folding
   * the control journal between them saw `completed` with no output. A host
   * that runs a native journal supervisor supplies its wait here.
   *
   * Absent, the terminal status is written from the body's exit exactly as it
   * was, which is what every composition with nothing to copy wants.
   *
   * @since 1.0.0-rc.0
   */
  readonly orderTerminalStatus?: ((runId: string) => Effect.Effect<void>) | undefined
  /** Host executable-flow sources composed into every run's catalog. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** Runs rendered markdown children; the host closes over their runtime dependencies. */
  readonly promptRunner?: CellCalls.PromptRunner | undefined
  /** The explicit sandbox budget every cell runs under. Never unlimited. */
  readonly limits: Sandbox.Limits
  /** Required quota park/retry policy for every model call in the run. */
  readonly quotaPolicy: Layer.Layer<QuotaPolicy.QuotaClassifier>
  /** Whether the seat-capacity controller may park after a provider refusal. */
  readonly capacity?: AgentOptions["capacity"]
  /** Builds the run-local spending policy from the plan that was approved. */
  readonly budget: (envelope: Envelope) => Layer.Layer<Budget.Budget, Budget.ConfigurationError>
  /** Stable system teaching placed ahead of the cell contract. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly maxFrames?: number | undefined
  /**
   * Consecutive read-only frames a task run may spend before the controller
   * demands an edit or a justification, and twice that before it stops the
   * run. Defaults to `CellTurn.defaultReadOnlyFrames`.
   *
   * @since 1.0.0-rc.0
   */
  readonly readOnlyCap?: number | undefined
  /** What the supervisor may do with its readings; see `Agent.Options.supervisor`. */
  readonly supervisor?: AgentOptions["supervisor"]
  /** Whether the host's `Evaluator` is a real judge; see `Agent.Options.judged`. */
  readonly judged?: boolean | undefined
  /**
   * Wall-clock milliseconds one model call may spend before the boundary
   * interrupts it and re-issues it. Defaults to `CellTurn.defaultModelCallMs`;
   * zero disarms it.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Consecutive repeat-observation frames a run may spend before the
   * controller names the repetition and redirects it. Defaults to
   * `CellTurn.defaultRepeatFrames`; zero disarms it.
   */
  readonly repeatCap?: number | undefined
  /**
   * Completions a run may have bounced for narrowed evidence before the
   * controller stops naming the check it skipped. Defaults to
   * `CellTurn.defaultNarrowingDemands`; zero disarms it.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Completions a run may have bounced for an unmoved tree before the
   * controller stops naming it. Defaults to `CellTurn.defaultUnmovedDemands`;
   * zero disarms it.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Completions a run may have bounced for a failing check it replaced rather
   * than answered. Defaults to `CellTurn.defaultUnresolvedDemands`; zero
   * disarms it.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Whether a human answers this executor's runs, which is what makes a cell's
   * `park` transition honorable.
   *
   * The executor wires an approval gate on every run, but a gate is not an
   * answerer: a benchmark, a cron, and a CI lane all register approvals that
   * nobody will ever decide. So the host says. It defaults to false, and a run
   * that claims false has its `park` transitions refused and answered in-frame
   * rather than left waiting on an operator who is not there.
   */
  readonly approvalChannel?: boolean | undefined
  /**
   * What an in-run `ask` does.
   *
   * `park`, the default, parks the run on an approval an operator answers
   * with `smithers approve`. `refuse` is for a host nobody answers: the ask
   * fails at once with `StandardFlows.ApprovalUnavailable`, which the cell
   * reads and routes around, so the run never waits on a decision that will
   * not come and nothing is approved on anyone's behalf.
   */
  readonly asks?: "park" | "refuse" | undefined
  /**
   * The reasoning effort agent seats run at when their flow declares none.
   *
   * The flow's own `effort:` frontmatter wins; this is the host's default
   * beneath it, and the built-in default is `high` — an unset effort is not
   * neutral, it is near-zero thinking (the first SWE-bench runs recorded ~20
   * reasoning tokens per call while the same model under the Codex CLI ran
   * at medium and resolved four times as many instances).
   *
   * @since 1.0.0-rc.0
   */
  readonly reasoningEffort?: ModelRequest.ReasoningEffort | undefined
}

const sourceId = JournalEvent.SourceId.make("/control/executor")

/**
 * The agent trail's own producer, separate from the executor's lifecycle
 * events.
 *
 * The trail supplies its own producer sequences ({@link traceIdentity}) while
 * `control.run.*` and `control.approval.requested` allocate theirs from the
 * journal's floor. Sharing one producer would mix the two schemes in one
 * sequence space: the floor is `MAX(source_seq) + 1`, so it would jump to a
 * derived identity plus one, and a later derived identity could name a
 * sequence a lifecycle event had already taken. Two producers keep each
 * scheme's numbers to itself.
 */
const trailSourceId = JournalEvent.SourceId.make("/control/executor/trail")

/**
 * Payload fields a replayed event does not reproduce.
 *
 * `at` is stamped when the executor recorded the event, and `durationMillis`
 * is measured around a step the engine serves from its record on the way back,
 * so both differ between the attempt that first produced an event and the
 * attempt that replays it. They describe the observation rather than the
 * event, so the identity below is derived without them and the first
 * attempt's values are the ones that stand.
 */
const observationOnly = new Set(["at", "durationMillis"])

/**
 * Payload fields added to an event type AFTER runs were journaled without them.
 *
 * {@link traceIdentity} hashes the payload, so enriching an event that already
 * exists in the wild changes what its identity derives to. A run journaled by
 * the old producer and RESUMED under the new one replays its whole recorded
 * prefix, re-projects every event in it with the new fields, derives an
 * identity none of the recorded rows carry, and
 * `UNIQUE (run_id, source_id, source_seq)` admits all of them: the prefix is
 * published a second time, and a projection summing usage or counting demands
 * over-counts the run once per park. Listing the added fields here keeps the
 * old producer's keys, so the recorded prefix still deduplicates and only what
 * the resumed attempt genuinely produced is admitted.
 *
 * The exclusion costs what it says it costs: two events of the same type at
 * the same coordinates that differ ONLY in a late field collide and the second
 * is dropped. That is why an entry names one event type rather than one field
 * name — `callId` is excluded from the two call lifecycle events that gained
 * it and from nothing else — and why a field belongs here only if it was added
 * after journals existed.
 *
 * A brand-new event TYPE needs no entry. Its identity has never been derived,
 * so no recorded prefix can mismatch it, and excluding its fields would only
 * collapse distinct events onto one key. Add an entry when you add a field to
 * an event type that is already being journaled; add nothing when you add the
 * event type itself. A new type emitted in the MIDDLE of a frame has a
 * different cost, which this table cannot pay: see {@link unordered}.
 *
 * A Map rather than an object literal because the key is an event type read
 * off a decoded event. A literal resolves `lateFields["constructor"]` through
 * `Object.prototype` to a function, which is truthy — so `??` cannot catch it
 * and the `.has` below throws on a value that was never an entry.
 * `@smthrs/ui` `status.ts` carries the same note over the same hazard.
 *
 * @category projections
 * @since 1.0.0
 */
const lateFields: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // callId enriches the control projection of an identity the harness already
  // carried. Resuming a pre-callId run must deduplicate its recorded prefix
  // instead of publishing every call a second time.
  // `descriptor` joined `callId` for the same reason: it enriches a record
  // that already exists in journals, and a resumed pre-enrichment run must
  // deduplicate its recorded prefix rather than publish all of it again.
  ["control.agent.cell-call-started", new Set(["callId", "descriptor"])],
  ["control.agent.cell-call-settled", new Set(["callId"])],
  // The five events below reached every consumer countable and otherwise
  // empty: the projection's `default` arm dropped every field they carried.
  // Their whole payload is late, so their whole payload is excluded.
  ["control.agent.cell-rejected-in-frame", new Set(["attempt", "code", "message"])],
  ["control.agent.narrow-only-demanded", new Set(["flow", "check", "targets", "currentDigest", "nextFrame"])],
  ["control.agent.read-only-demand-issued", new Set(["streak", "cap", "nextFrame"])],
  ["control.agent.steering-drained", new Set(["messages", "supervisor", "monitor", "suppressed", "memory"])],
  ["control.agent.sufficiency-observed", new Set(["flow", "failed", "passed", "epoch", "nextFrame"])],
  // `refused` separates the reading that ended a run from the one that let a
  // claim stand, and it was added to an event type journals already carried.
  // A pre-`refused` record has no such key, and the decoder fills it with
  // `false`, so a resumed run would derive a new identity for every
  // `claim-demanded` in its recorded prefix and publish the prefix twice.
  ["control.agent.claim-demanded", new Set(["refused"])],
  // `supervisorSteer` was added to the one event every run journals first,
  // and later writers omit it again for `judged`; either way a record in a
  // resumed prefix may or may not carry it.
  ["control.agent.discipline-armed", new Set(["supervisorSteer", "judged", "relevance", "monitors", "stance"])],
  // The Jev fields.
  ["control.agent.decision-settled", new Set(["usage"])],
  ["control.agent.supervisor-settled", new Set(["monitors", "skillsCapped"])],
  ["control.agent.compaction-settled", new Set(["marks", "removedTokens", "unaligned"])]
])

/** The exclusion set for an event type that has never been enriched. */
const noLateFields: ReadonlySet<string> = new Set()

/**
 * The OpenTelemetry trace id every span of one run is exported under.
 *
 * Derived from the run id alone, so `runs status` names the trace without a
 * stored column and every attempt of the run joins the same trace.
 *
 * @category tracing
 * @since 1.0.0
 */
export const traceId = (runId: string): string => Digest.digest(`smithers/run-trace/${runId}`).slice(0, 32)

/**
 * The fixed parent every attempt of one run opens its `smithers.run` span
 * under, so a resumed or re-driven run stays in the one trace {@link traceId}
 * names.
 */
const runTraceParent = (runId: string): Tracer.ExternalSpan => {
  const digest = Digest.digest(`smithers/run-trace/${runId}`)
  return Tracer.externalSpan({ traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) })
}

/**
 * The producer identity of one journaled agent event.
 *
 * A resumed attempt replays its whole prefix and re-publishes every event in
 * it, so without an identity of their own those events were journaled again:
 * the auto-allocated sequence never collided, the dedup index never fired, and
 * a projection summing `control.agent.model-settled` usage over-counted a
 * run's tokens once per park. This is the identity that lets
 * `UNIQUE (run_id, source_id, source_seq)` answer, and it has to hold for a
 * resumed attempt that DIVERGES rather than only for one that repeats.
 *
 * The material is where the event sits and what it says: the frame, its
 * ordinal within that frame, the cell that frame produced, the event type, and
 * the event's own payload minus {@link observationOnly} and minus whatever
 * {@link lateFields} records this event type as having gained after journals
 * of it already existed. A replayed event
 * regenerates all five, so it regenerates the identity and the index refuses
 * it. An event produced after divergence differs in at least one of them, so
 * it derives a different identity and is admitted normally: the approved
 * `ask` writes `cell-call-settled` where the parked attempt wrote
 * `permission-required`, at the same ordinal of the same frame, and the two
 * do not collide. A running count across the incarnation cannot make that
 * distinction, which is why one was tried and rejected.
 *
 * The identity hashes the payload that is journaled. When {@link trace}
 * replaces an oversized field, the deterministic marker carries the digest of
 * the full value, so two different omitted values still produce different
 * identity material without canonicalizing the full value a second time here.
 *
 * Truncation is to 48 bits, comfortably inside the safe-integer range the
 * journal allocates in, and the birthday bound over a run's thousands of
 * events is around 1e-9. The failure it bounds is a dropped duplicate, never a
 * rewritten row: the first observation of an identity is the one that stands.
 *
 * @category projections
 * @since 0.1.0
 */
export const traceIdentity = (
  frame: number,
  ordinal: number,
  cell: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>
): JournalEvent.SourceSeq => {
  // Keep old producer keys for every field this event type gained after runs
  // were journaled without it, so a resumed pre-enrichment run deduplicates
  // its recorded prefix instead of publishing all of it a second time.
  const late = lateFields.get(eventType) ?? noLateFields
  const material = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !observationOnly.has(key) && !late.has(key))
  )
  const digest = Digest.digest(CanonicalJson.stringify({ cell, eventType, frame, material, ordinal }))
  return JournalEvent.SourceSeq.make(Number.parseInt(digest.slice(0, 12), 16))
}

/**
 * The durable identity shared by a cell call's start and settlement.
 *
 * CellTurn constructs the identity before dispatch and carries that exact
 * value into both events. Hash those coordinates, never emission order or the
 * flow name: concurrent calls may settle in any order, and replay must name
 * the same call. The prefix versions this contract without changing the
 * durable engine's activity keys.
 *
 * @category projections
 * @since 1.0.0
 */
export { callId } from "./internal/CallIdentity.ts"

/**
 * The largest free-text or value field one trail record carries.
 *
 * Completion outputs are bounded inside both cell settlements and applied
 * transitions, preserving the containing outcome and transition tags.
 *
 * The trail is a durable journal row, and a cell may read a multi-megabyte
 * file into one result. Bounding the field limits both that row's storage and
 * the canonicalization and hashing work paid for every event identity.
 *
 * @category projections
 * @since 1.0.0-rc.0
 */
export const maxTracedBytes = 65_536

const traceEncoder = new TextEncoder()

/**
 * What stands in a record for a field too large to journal.
 *
 * An alias rather than an interface so that it is JSON to the compiler as well:
 * an interface has no index signature and cannot sit inside a `Schema.Json`.
 */
type Marker = {
  readonly truncated: true
  readonly bytes: number
  readonly digest: string
}

/**
 * The size and digest of one value, from the one canonical form of it.
 *
 * `bytes` is what the value costs where it is written whole, and `digest` is
 * the digest a {@link Marker} carries for it.
 */
const measured = (value: Schema.Json | string): { readonly bytes: number; readonly digest: string } => {
  const canonical = CanonicalJson.stringify(value)
  return {
    bytes: traceEncoder.encode(typeof value === "string" ? value : canonical).byteLength,
    digest: Digest.digest(canonical)
  }
}

/**
 * One field bounded for the trail, with the digest of the whole of it.
 *
 * The digest is the one the marker carries, so a record that writes a digest
 * beside every field it is rebuilt from canonicalizes each field once.
 */
const bounded = <A extends Schema.Json | string>(
  value: A
): { readonly field: A | Marker; readonly digest: string } => {
  const { bytes, digest } = measured(value)
  return { field: bytes <= maxTracedBytes ? value : { truncated: true, bytes, digest }, digest }
}

const tracedField = <A extends Schema.Json | string>(value: A): A | Marker => bounded(value).field

/**
 * The top-level marker a record carries when any of the fields it is rebuilt
 * from, or any one message of a request, was replaced by its {@link Marker}.
 *
 * The per-field marker says which field was left out and what it digested to;
 * this says, in one place, that the record cannot be used to rebuild what it
 * describes. A reader that prefills a request from `model-requested` checks
 * this and reports the request unavailable, rather than sending the fields
 * that happened to fit. Compared by reference because {@link bounded} returns
 * the value it was given whenever that value fits, so a state that merely
 * looks like a marker is not mistaken for one. Absent, never `false`.
 */
const truncatedMarker = (
  fields: ReadonlyArray<readonly [original: unknown, traced: unknown]>
): { readonly truncated?: true } => fields.some(([original, traced]) => original !== traced) ? { truncated: true } : {}

/**
 * Generation parameters under names the journal does not redact.
 *
 * `maxTokens` ends in a word the journal's redaction treats as a credential
 * name, so the row would read `"maxTokens": "[REDACTED]"` and a composer
 * prefilled from it would send a string where the provider wants a number.
 * It travels as `maxOutput`; every other parameter keeps its name.
 */
const tracedParams = (params: ModelRequest.GenerationParams): Schema.Json =>
  JSON.parse(JSON.stringify({
    maxOutput: params.maxTokens,
    temperature: params.temperature,
    topP: params.topP,
    topK: params.topK,
    stopSequences: params.stopSequences,
    thinkingBudget: params.thinkingBudget,
    reasoningEffort: params.reasoningEffort
  })) as Schema.Json

const tracedTransition = (transition: Cell.Transition) =>
  transition._tag === "complete" ? { ...transition, output: tracedField(transition.output) } : transition

/**
 * Why a parked run is being taken up, which decides whether the hosting guard
 * applies to it.
 *
 * `claimed` is an operator's own `Control.resume` or a steer's wake: the plane
 * that asked has ALREADY claimed the control row (`ControlLive.runMutation`
 * and the steer wake both call `ControlRuntime.resume` before they journal),
 * and a wedged run is by definition one nobody is driving. Guarding it would
 * turn the operator's remedy into a claimed row nothing re-drives.
 *
 * `delegated` is the approval seam, where the decision may have been taken in
 * any process holding the control database and the run belongs to whichever
 * one parked it. `requestedAtMs` is the age of the durable delegation, and only
 * the durable follower has one: a process that has just decided an approval
 * knows nothing about the host from having decided it.
 */
type Uptake =
  | { readonly _tag: "claimed"; readonly sequence?: number | undefined }
  | { readonly _tag: "delegated"; readonly requestedAtMs?: number | undefined }

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")

/**
 * The readable text of one transcript message of any role.
 *
 * `assistantText` reads one settled assistant turn, where the only parts that
 * carry prose are text parts. A steering insert is whatever an operator or a
 * flow put on the queue, so the role is not known in advance and a tool result
 * keeps its prose in `content` rather than in a text part. Thinking blocks and
 * tool calls are left out: the first is the provider's attested reasoning and
 * the second is already journaled per call by `cell-call-started`.
 */
const messageText = (message: ModelRequest.Message): string => {
  const parts: ReadonlyArray<ModelRequest.ContentPart> = message.content
  return parts
    .flatMap((part) => part.type === "text" ? [part.text] : part.type === "tool-result" ? [part.content] : [])
    .join("\n")
}

/**
 * What the last `model-requested` of one scope and purpose said, as digests.
 *
 * The next record of the same scope and purpose is written against this: the
 * system text is left out while its digest stands, and the messages the two
 * calls share are counted rather than repeated. Digests only, so holding it
 * for the length of a run holds no transcript.
 *
 * @category projections
 * @since 1.0.0-rc.0
 */
export interface RequestTrail {
  /** The digest of the system text the last record of this scope and purpose named. */
  readonly systemDigest: string
  /** One digest per message of that record's whole transcript, in order. */
  readonly messageDigests: ReadonlyArray<string>
}

/**
 * The payload of one `model-requested` record, and the trail the next is
 * written against.
 *
 * A run asks one model call per frame and each call's transcript is the last
 * one's and a little more, so a record that carried its request whole wrote
 * the run's transcript once per call and its system teaching every time: a
 * hundred frames journaled the same twenty kilobytes of teaching a hundred
 * times, and the transcript as a whole stopped fitting one field long before
 * any compaction, which left every later call of a long run unreadable. So a
 * record carries what its call ADDED. `prefixCount` is how many leading
 * messages it shares with the record before it, `messages` is the rest, and
 * `system` is written only where `systemDigest` moved.
 *
 * What is shared is the longest common prefix and not only a whole previous
 * transcript, because the next call never simply extends the last one: every
 * frame closes on a note about the realm that the next frame replaces, and an
 * in-frame re-ask carries a refusal the following frame drops. A compaction
 * or a host rewrite shares nothing and is written whole, which is also what
 * the first call is.
 *
 * A reader rebuilds a call by walking back through the records of its scope
 * and purpose until `prefixCount` is zero, and checks each step of the walk:
 * `prefixDigest` is the digest of the per-message digests of the messages it
 * takes from the record before, so a missing, reordered or redacted
 * predecessor is a mismatch and never a wrong request.
 *
 * The messages share one field's bound. Each is written whole while the field
 * has room and as its own marker after, so one oversized result costs the
 * record that message and not the transcript beside it, and the record stays
 * inside the step-fact payload bound however many messages a call adds.
 *
 * Deterministic in the event and the trail, and the trail is a fold over the
 * same events from an empty start, so a replayed incarnation regenerates every
 * payload byte for byte and with it every {@link traceIdentity}.
 */
const tracedRequest = (
  event: AgentEvent.ModelRequested,
  previous: RequestTrail | undefined
): { readonly payload: Readonly<Record<string, unknown>>; readonly trail: RequestTrail } => {
  // The system text is carried here rather than referenced from
  // `prompt-rendered`: that record holds the launch arguments and not the
  // teaching around them, it is written once per run while the system text is
  // per call (compaction asks under a different one), and a module step writes
  // no `prompt-rendered` at all.
  const system = event.request.system.map((part) => part.text)
  const tracedSystem = bounded(system)
  const systemMoved = previous?.systemDigest !== tracedSystem.digest
  // Messages travel as role and prose, the way `steering-drained` writes
  // them. A thinking block's provider attestation is a field named
  // `signature`, which the journal redacts by name, so a block journaled
  // whole would come back unusable; and a cell-first request carries no tool
  // parts to lose.
  const spoken = event.request.messages.map((message) => {
    const value = { role: message.role, text: messageText(message) }
    return { value, ...measured(value) }
  })
  const messageDigests = spoken.map((message) => message.digest)
  const before = previous?.messageDigests ?? []
  let prefixCount = 0
  while (
    prefixCount < before.length
    && prefixCount < messageDigests.length
    && before[prefixCount] === messageDigests[prefixCount]
  ) prefixCount++
  let room = maxTracedBytes
  const added = spoken.slice(prefixCount)
  const messages = added.map(({ bytes, digest, value }): typeof value | Marker => {
    if (bytes > room) return { truncated: true, bytes, digest }
    room -= bytes
    return value
  })
  const tracedMessages = bounded(messages)
  const params = tracedParams(event.request.params)
  const tracedParameters = bounded(params)
  return {
    trail: { systemDigest: tracedSystem.digest, messageDigests },
    payload: {
      // The join keys. A reader finds this call's turn by these, never by
      // where the row sits: a compaction request is written before its
      // frame's `turn-opened`.
      scope: event.scope,
      frame: event.frame,
      attempt: event.attempt,
      purpose: event.purpose,
      seat: event.seat,
      modelId: event.request.modelId,
      // Names only. `EngineLike.Binding` has nowhere a credential could
      // sit, and a host that resolved no route adds neither key.
      ...(event.binding === undefined
        ? {}
        : { routeId: event.binding.routeId, protocolId: event.binding.protocolId }),
      // Only the OpenAI protocols put this affinity key on the wire.
      // Anthropic uses cache breakpoints, not a session/key header.
      ...((event.binding?.protocolId === "openai-responses" || event.binding?.protocolId === "openai-responses-chatgpt")
          && event.request.cacheKey !== undefined ?
        { cacheKey: event.request.cacheKey } :
        {}),
      ...(event.binding?.protocolId === "anthropic-messages" && event.request.cacheBoundary !== undefined
        ? { cacheBoundary: event.request.cacheBoundary } :
        {}),
      // Each digest is of its field as it stood before the journal saw it.
      // The journal's redaction rewrites text that merely looks like a
      // credential (`maxTokens: 4096`, `cacheKey = id`) and leaves no mark on
      // the row, so a reader digests what it read and treats a mismatch the
      // way it treats `truncated`: this is not the request that was sent.
      ...(systemMoved ? { system: tracedSystem.field } : {}),
      systemDigest: tracedSystem.digest,
      messages: tracedMessages.field,
      messagesDigest: tracedMessages.digest,
      prefixCount,
      ...(prefixCount === 0
        ? {}
        : { prefixDigest: Digest.digest(CanonicalJson.stringify(messageDigests.slice(0, prefixCount))) }),
      params: tracedParameters.field,
      paramsDigest: tracedParameters.digest,
      toolCount: event.request.tools.length,
      ...truncatedMarker([
        ...(systemMoved ? [[system, tracedSystem.field] as const] : []),
        [messages, tracedMessages.field],
        ...messages.map((message, index) => [added[index]?.value, message] as const),
        [params, tracedParameters.field]
      ])
    }
  }
}

/**
 * The journal projection of one agent event.
 *
 * The executor consumes the harness stream itself, so without this the whole
 * transcript — what the model said, the cell it produced, the flows that cell
 * called, and why a frame was rejected — existed only for the duration of the
 * run and a settled run could not be read back at all. Model deltas are the
 * one omission: they are the token-by-token prefix of `model-settled`, and
 * journaling them would multiply a run's event count by its token count for
 * no information the settlement does not already carry.
 *
 * `undefined` means "not journaled".
 *
 * `previous` is what the last `model-requested` of the same scope and purpose
 * said, and only that record reads it: see {@link RequestTrail}. Without one
 * the request is written whole, which is what a caller projecting one event on
 * its own wants. A caller projecting a run's events in order uses
 * {@link tracer}, which keeps it.
 *
 * @category projections
 * @since 0.1.0
 */
export const trace = (
  event: AgentEvent.AgentEvent,
  previous?: RequestTrail
): { readonly eventType: Transcript.ControlEventType; readonly payload: unknown } | undefined => {
  switch (event._tag) {
    case "model-delta":
      return undefined
    case "model-retried":
      // The delay is journaled with the attempt because it cannot be
      // recovered from the timestamps: every retry of one sealed step is
      // written when that step settles, so a run that backed off for half a
      // minute and one that did not back off at all produce the same
      // timestamps. A wave report reads the schedule off this field.
      return {
        eventType: "control.agent.model-retried",
        payload: { attempt: event.attempt, code: event.code, delayMillis: event.delayMillis }
      }
    case "discipline-armed":
      // The positive record of what this run armed, written before any of it
      // can fire. A run that never completes still proves its arming here.
      return {
        eventType: "control.agent.discipline-armed",
        payload: {
          readOnlyCap: event.readOnlyCap,
          maxFrames: event.maxFrames,
          approvalChannel: event.approvalChannel,
          // The one budget a report can grade after the fact without any
          // further instrumentation: `control.agent.model-settled` already
          // journals `durationMillis` per call, so the pair says both what the
          // run promised and what every call it made actually spent.
          modelCallMs: event.modelCallMs,
          // Armed for the same reason and journaled the same way: a wave that
          // records no repeat demand must be able to say whether the control
          // was armed and never needed, or never armed at all.
          repeatCap: event.repeatCap,
          // The one control that acts on a completion rather than on a stall,
          // so a wave's report can say whether the run that finished was ever
          // asked about the evidence it finished on.
          narrowingCap: event.narrowingCap,
          // The two controls that judge what a completion is *about* rather
          // than how it was verified: whether the run changed anything at all,
          // and whether it answered the check that told it something was
          // broken. Journaled with the rest so a wave can tell "armed and never
          // needed" from "never armed".
          unmovedCap: event.unmovedCap,
          unresolvedCap: event.unresolvedCap,
          // Whether Jev's readings run, and how the gates they feed are set.
          // A real judge arms them; verdicts are journaled either way.
          ...(event.judged === undefined ? {} : { judged: event.judged }),
          ...(event.relevance === undefined ? {} : { relevance: event.relevance }),
          ...(event.monitors === undefined ? {} : { monitors: event.monitors }),
          ...(event.stance === undefined ? {} : { stance: event.stance }),
          calls: event.calls,
          memoryBytes: event.memoryBytes,
          steps: event.steps,
          timeMs: event.timeMs,
          callMs: event.callMs,
          totalMs: event.totalMs
        }
      }
    case "turn-opened":
      return {
        eventType: "control.agent.turn-opened",
        payload: { seat: event.seat, contextDigest: event.contextDigest }
      }
    case "model-requested":
      // What the call was asked, so a reader can open this one step and ask
      // it again: see {@link tracedRequest}.
      return { eventType: "control.agent.model-requested", payload: tracedRequest(event, previous).payload }
    case "model-settled":
      return {
        eventType: "control.agent.model-settled",
        payload: {
          text: tracedField(assistantText(event.message)),
          usage: event.usage,
          // The call's USD cost, so a status card totals spend without a rate card.
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
          ...(event.costSource === undefined ? {} : { costSource: event.costSource }),
          // Wall-clock for this one sealed call. A run's total time was
          // already derivable from event stamps; per-call latency was not,
          // and it is the number a speed comparison actually needs.
          durationMillis: event.durationMillis,
          // A wrapped CLI seat's vendor session, so a take-over can resume it.
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId })
        }
      }
    case "cell-produced":
      return {
        eventType: "control.agent.cell-produced",
        payload: { language: event.cell.language, digest: event.cell.digest, text: tracedField(event.cell.text) }
      }
    case "cell-rejected-in-frame":
      // The re-ask is spend: a refused reply is a real model call, and a wave
      // counting cost per frame would otherwise see the output of an answer it
      // has no record of asking for. `attempt` is what makes the ratio of this
      // event to a frame's settlement readable — how often one re-ask recovers
      // a frame — and the message is bounded because a `compile_failed`
      // refusal quotes the interpreter back at whatever the cell was.
      return {
        eventType: "control.agent.cell-rejected-in-frame",
        payload: { attempt: event.attempt, code: event.code, message: tracedField(event.message) }
      }
    case "cell-call-started": {
      // The input is bounded for the same reason the result is. A `write` call
      // carries the whole file it is about to write, so the record that opens
      // the call is as large as the one that settles it.
      //
      // The declaration's display fields ride the opening record because that
      // is the only record that holds them: the call settles with an outcome,
      // and a reader months later has the journal and no registry to ask. A
      // flow that declared neither field adds nothing, so its record is
      // unchanged and a reader's compatibility table still applies to it.
      const descriptor = Cell.displayDescriptor(event.call)
      return {
        eventType: "control.agent.cell-call-started",
        payload: {
          callId: callId(event.call.identity),
          flowName: event.call.flowName,
          input: tracedField(event.call.input),
          ...(descriptor === undefined ? {} : { descriptor })
        }
      }
    }
    case "cell-call-settled":
      return {
        eventType: "control.agent.cell-call-settled",
        payload: {
          callId: callId(event.identity),
          flowName: event.flowName,
          outcome: event.result.outcome,
          // A failure message is free text a handler chose, and a compiler or
          // test runner writes megabytes of it.
          message: event.result.message === undefined ? undefined : tracedField(event.result.message),
          value: tracedField(event.result.value)
        }
      }
    case "cell-printed":
      // The whole of the REPL mode's context channel. Journaled with the cell
      // that produced it so a transcript projection can rebuild a resumed run's
      // window without re-running anything.
      return {
        eventType: "control.agent.cell-printed",
        payload: { cell: event.cell, text: tracedField(event.text) }
      }
    case "cell-settled":
      return {
        eventType: "control.agent.cell-settled",
        payload: {
          outcome: event.outcome._tag === "settled"
            ? { ...event.outcome, transition: tracedTransition(event.outcome.transition) }
            : event.outcome
        }
      }
    case "transition-applied":
      return {
        eventType: "control.agent.transition-applied",
        payload: { transition: tracedTransition(event.transition) }
      }
    case "mutation-observed":
      // Written for every frame, not only for the ones that trip a control.
      // `basis` travels with it because a `declared` answer is paperwork and an
      // `observed` one is a fact about the tree, and a reader reconstructing a
      // run must not have to guess which it is holding.
      return {
        eventType: "control.agent.mutation-observed",
        payload: {
          basis: event.basis,
          mutated: event.mutated,
          digest: event.digest,
          paths: event.paths,
          declaredWrites: event.declaredWrites
        }
      }
    case "checkpoint-minted":
      // The store's own name for the tree travels with the id, because the
      // frame that reads against a checkpoint is usually not the frame that
      // pinned it: a journal holding only the reading could not say which tree
      // it was a reading of, and a fails-before proof is exactly that claim.
      return {
        eventType: "control.agent.checkpoint-minted",
        payload: { id: event.id, ref: event.ref, cell: event.cell, ordinal: event.ordinal }
      }
    case "read-only-demand-issued":
      // The issuance, kept apart from `read-only-demanded` above, which is the
      // same demand's later answer. A crash between the two boundaries must
      // still leave the demand on the record, so the streak and the cap it
      // reached are written here rather than only where the answer lands.
      return {
        eventType: "control.agent.read-only-demand-issued",
        payload: { streak: event.streak, cap: event.cap, nextFrame: event.nextFrame }
      }
    case "read-only-demanded":
      return {
        eventType: "control.agent.read-only-demanded",
        payload: {
          streak: event.streak,
          cap: event.cap,
          nextFrame: event.nextFrame,
          nextAction: event.nextAction
        }
      }
    case "repeat-demanded":
      // Journaled at issuance, not at its answer: what answers this demand is
      // the shape of the next frame's calls, and `cell-call-started` already
      // writes those one at a time.
      return {
        eventType: "control.agent.repeat-demanded",
        payload: { frames: event.frames, cap: event.cap, nextFrame: event.nextFrame }
      }
    case "narrowed-demanded":
      // The two inputs and the two digests travel together because the whole
      // judgement is in the pair: without the digests a reader cannot tell a
      // stale broad check from a current one, and without the inputs it cannot
      // tell whether the narrowing was real. A grader reading this back can
      // second-guess the demand without replaying the run.
      return {
        eventType: "control.agent.narrowed-demanded",
        payload: {
          flow: event.flow,
          broader: event.broader,
          narrower: event.narrower,
          broaderDigest: event.broaderDigest,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "narrow-only-demanded":
      // The sibling of `narrowed-demanded` from the other side: that one fires
      // when a broader check exists in the ledger and was not re-run, this one
      // when no broader check was ever taken. There is no broader input to
      // pair the check against, so `targets` is what stands in its place — the
      // subjects the demand is about, which is the whole of what a grader
      // needs to decide after the fact whether refusing the completion was
      // right.
      return {
        eventType: "control.agent.narrow-only-demanded",
        payload: {
          flow: event.flow,
          check: event.check,
          targets: event.targets,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "unmoved-demanded":
      // Both digests, because the judgement is the comparison: a reader with
      // only one of them cannot tell an unmoved tree from a measurement that
      // never happened, and the pair reconciles directly against the run's own
      // `mutation-observed` record.
      return {
        eventType: "control.agent.unmoved-demanded",
        payload: {
          openedDigest: event.openedDigest,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "unresolved-demanded":
      // The failing check and the reading that displaced it travel together
      // for the same reason the narrowing pair does: either one alone is
      // unremarkable, and the demand is entirely about the two of them.
      return {
        eventType: "control.agent.unresolved-demanded",
        payload: {
          flow: event.flow,
          failed: event.failed,
          instead: event.instead,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "failed-call-demanded":
      // Each failed call in the flow's own words: the demand is that the
      // completion was written before these results existed.
      return {
        eventType: "control.agent.failed-call-demanded",
        payload: {
          failures: event.failures.map((failure) => ({ flow: failure.flow, message: tracedField(failure.message) })),
          nextFrame: event.nextFrame
        }
      }
    case "unobserved-demanded":
      // Each call the completion was written without reading, with the head
      // of the result the next frame was shown in its place.
      return {
        eventType: "control.agent.unobserved-demanded",
        payload: {
          calls: event.calls.map((call) => ({
            flow: call.flow,
            ordinal: call.ordinal,
            ok: call.ok,
            summary: tracedField(call.summary)
          })),
          nextFrame: event.nextFrame
        }
      }
    case "output-demanded":
      // The correction the same session was handed, verbatim.
      return {
        eventType: "control.agent.output-demanded",
        payload: { note: tracedField(event.note), nextFrame: event.nextFrame }
      }
    case "claim-demanded":
      // All three probabilities and the latency, on every reading rather than
      // only on a firing, because this is the one demand a grader cannot
      // recompute from the journal: it is a model's answer, and the passing
      // answers are what say whether arming the control was right. `demanded`
      // separates a demand; `refused` names a spent-cap rejection. `invented`
      // is the one that acts; `complete` and
      // `overclaims` ride along because a journal that stops carrying them
      // cannot answer whether demoting them was right. See `CompletionClaim`.
      return {
        eventType: "control.agent.claim-demanded",
        payload: {
          complete: event.complete,
          overclaims: event.overclaims,
          invented: event.invented,
          latencyMs: event.latencyMs,
          usage: event.usage,
          demanded: event.demanded,
          refused: event.refused,
          currentDigest: event.currentDigest,
          nextFrame: event.nextFrame
        }
      }
    case "supervisor-settled":
      // Every field verbatim: the levels and the word are the transport's,
      // and a reader re-applies thresholds to the three probabilities.
      return {
        eventType: "control.agent.supervisor-settled",
        payload: {
          scope: event.scope,
          frame: event.frame,
          thrashing: event.thrashing,
          onTarget: event.onTarget,
          suspect: event.suspect,
          ...(event.outdatedContext === undefined ? {} : { outdatedContext: event.outdatedContext }),
          ...(event.irrelevantContext === undefined ? {} : { irrelevantContext: event.irrelevantContext }),
          frustrated: event.frustrated,
          anxious: event.anxious,
          scared: event.scared,
          confused: event.confused,
          confident: event.confident,
          needsHelp: event.needsHelp,
          crossed: event.crossed,
          nudged: event.nudged,
          ...(event.steer === undefined ? {} : { steer: event.steer }),
          latencyMs: event.latencyMs,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.monitors === undefined ? {} : { monitors: event.monitors }),
          ...(event.skillsCapped === undefined ? {} : { skillsCapped: event.skillsCapped })
        }
      }
    case "supervisor-unjudged":
      return {
        eventType: "control.agent.supervisor-unjudged",
        payload: { scope: event.scope, frame: event.frame, reason: event.reason, detail: event.detail }
      }
    case "decision-unjudged":
      return {
        eventType: "control.agent.decision-unjudged",
        payload: {
          scope: event.scope,
          frame: event.frame,
          classifier: event.classifier,
          reason: event.reason,
          detail: event.detail,
          items: event.items
        }
      }
    case "relevance-settled":
      // Item ids are written as values, never as keys, for the redaction
      // reason `decision-settled` gives below.
      return {
        eventType: "control.agent.relevance-settled",
        payload: {
          scope: event.scope,
          frame: event.frame,
          source: event.source,
          withholdAt: event.withholdAt,
          kept: event.kept,
          withheld: event.withheld,
          latencyMs: event.latencyMs,
          ...(event.usage === undefined ? {} : { usage: event.usage })
        }
      }
    case "relevance-restored":
      return {
        eventType: "control.agent.relevance-restored",
        payload: { scope: event.scope, frame: event.frame, flow: event.flow }
      }
    case "seat-routed":
      return {
        eventType: "control.agent.seat-routed",
        payload: {
          scope: event.scope,
          declared: event.declared,
          seat: event.seat,
          modelId: event.modelId,
          variant: event.variant,
          candidates: event.candidates,
          decidedBy: event.decidedBy,
          latencyMs: event.latencyMs,
          ...(event.backups === undefined ? {} : { backups: event.backups }),
          ...(event.panel === undefined ? {} : { panel: event.panel })
        }
      }
    case "supervisor-memory-failed":
      // Counted by a wave's scorecard: a write lost to a locked store must
      // not read as a run that remembered nothing.
      return {
        eventType: "control.agent.supervisor-memory-failed",
        payload: { scope: event.scope, frame: event.frame, operation: event.operation, detail: event.detail }
      }
    case "decision-settled": {
      // The state, the questions and the answers, because a decision is the
      // one record a reader cannot recompute: it is a model's answer about
      // evidence the run assembled and kept nowhere else.
      //
      // A question id and an option are names the classifier's author chose,
      // and the journal replaces the value under any key it reads as a
      // credential name: a router over `auth`, `billing` and `session` would
      // come back with two of its three probabilities `"[REDACTED]"`. So the
      // caller's names are written as values, never as keys, in the order the
      // declaration gave them. `digest` hashes the wire form, which keys the
      // same questions by id and a choice's criteria by option, so a reader
      // rebuilds that record from these entries before checking it.
      const questions = Object.entries(Evaluator.encodeQuestions(event.questions)).map(([id, question]) => {
        const wire = question as { readonly type: string; readonly criteria?: Readonly<Record<string, string>> }
        return wire.type === "choice" && wire.criteria !== undefined
          ? {
            id,
            ...wire,
            criteria: Object.entries(wire.criteria).map(([option, description]) => ({ option, description }))
          }
          : { id, ...wire }
      }) as Schema.Json
      const answers = Object.entries(event.answers).map(([id, answer]) =>
        answer.kind === "boolean"
          ? { id, ...answer }
          : { id, ...answer, probabilities: Object.entries(answer.probabilities).map(([option, p]) => ({ option, p })) }
      ) as Schema.Json
      // The digests are what `model-requested` writes them for: the state is
      // free text the journal's redaction may rewrite without a mark.
      const traced = { state: bounded(event.state), questions: bounded(questions), answers: bounded(answers) }
      return {
        eventType: "control.agent.decision-settled",
        payload: {
          scope: event.scope,
          frame: event.frame,
          classifier: event.classifier,
          digest: event.digest,
          state: traced.state.field,
          stateDigest: traced.state.digest,
          questions: traced.questions.field,
          questionsDigest: traced.questions.digest,
          answers: traced.answers.field,
          answersDigest: traced.answers.digest,
          latencyMs: event.latencyMs,
          acted: event.acted,
          decidedBy: event.decidedBy,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...truncatedMarker([
            [event.state, traced.state.field],
            [questions, traced.questions.field],
            [answers, traced.answers.field]
          ])
        }
      }
    }
    case "sufficiency-observed":
      // The one control in the set that is not a brake, and the only event
      // written for a frame that has done nothing wrong: the run watched a
      // check fail before it changed anything and watched the same check, or a
      // broader one, pass after. The two inputs and `epoch` — the run's count
      // of mutating frames when the failure was recorded — are what make that
      // ordering checkable after the fact, and they are the whole record:
      // nothing is refused, so there is no cap to journal beside them.
      return {
        eventType: "control.agent.sufficiency-observed",
        payload: {
          flow: event.flow,
          failed: event.failed,
          passed: event.passed,
          epoch: event.epoch,
          nextFrame: event.nextFrame
        }
      }
    case "vacuous-verification-observed":
      // The stored check travels with the identity the controller matched it
      // by, because the whole judgement is that this exact call had already
      // been watched passing: a reader with only the text cannot tell an exact
      // reuse from a command that merely reads like one, and the call's digest
      // reconciles the row directly against the run's own
      // `cell-call-settled` record.
      return {
        eventType: "control.agent.vacuous-verification-observed",
        payload: {
          flow: event.flow,
          check: event.check,
          callDigest: event.callDigest,
          nextFrame: event.nextFrame
        }
      }
    case "suspended":
      return { eventType: "control.agent.suspended", payload: { reason: event.reason } }
    case "compaction-settled":
      return {
        eventType: "control.agent.compaction-settled",
        payload: {
          replacedPrefixDigest: event.replacedPrefixDigest,
          // Counts, not digests: the digests name messages the trail never carried.
          ...(event.marks === undefined ? {} : {
            marks: {
              kept: event.marks.filter(({ mark }) => mark === "keep").length,
              squashed: event.marks.filter(({ mark }) => mark === "squash").length,
              removed: event.marks.filter(({ mark }) => mark === "remove").length
            }
          }),
          ...(event.removedTokens === undefined ? {} : { removedTokens: event.removedTokens }),
          ...(event.unaligned === undefined ? {} : { unaligned: event.unaligned })
        }
      }
    case "steering-drained":
      // The operator's own words, which existed nowhere else in the journal:
      // a steer is admitted through `Control.steer`, delivered at a frame
      // boundary, and read by the next model turn, and until now the trail
      // recorded only that some number of them had been drained. The role
      // travels with each one because a drain carries whatever the queue held,
      // and a run's own continuation insert reads differently from a person
      // interrupting it. Each message is bounded on its own rather than the
      // array as a whole, so one pasted file does not erase the steers around
      // it.
      return {
        eventType: "control.agent.steering-drained",
        payload: {
          messages: event.messages.map((message) => ({
            role: message.role,
            text: tracedField(messageText(message))
          })),
          // The supervisor's nudge or recalled rows, delivered at the same
          // boundary and kept apart from the person's words.
          ...(event.supervisor === undefined ? {} : {
            supervisor: event.supervisor.map((message) => ({
              role: message.role,
              text: tracedField(messageText(message))
            }))
          }),
          ...(event.monitor === undefined ? {} : { monitor: event.monitor }),
          ...(event.suppressed === undefined ? {} : { suppressed: event.suppressed }),
          ...(event.memory === undefined ? {} : { memory: event.memory })
        }
      }
    case "turn-closed":
      return {
        eventType: "control.agent.turn-closed",
        payload: { stopReason: event.stopReason, outcome: event.outcome }
      }
    case "permission-required":
      return { eventType: "control.agent.permission-required", payload: { request: event.request } }
    case "aborted":
      return { eventType: "control.agent.aborted", payload: { reason: event.reason } }
    case "resolved":
      return { eventType: "control.agent.resolved", payload: { text: tracedField(assistantText(event.message)) } }
    case "seat-failed-over":
      return {
        eventType: "control.agent.seat-failed-over",
        payload: {
          from: event.from,
          to: event.to,
          code: event.code,
          resetAtEpochMillis: event.resetAtEpochMillis
        }
      }
    case "model-parked":
      return {
        eventType: "control.agent.model-parked",
        payload: {
          seat: event.seat,
          wakeAt: event.wakeAt,
          source: event.source,
          code: event.code
        }
      }
    case "model-unparked":
      return { eventType: "control.agent.model-unparked", payload: { seat: event.seat, at: event.at } }
    // Unreachable, and pinned that way. Every declared `AgentEvent` now has an
    // arm above, and the `never` assignment is what a newly declared tag fails
    // on: the arm it would otherwise fall into projects the event countable
    // and otherwise empty, which is how `read-only-demand-issued`,
    // `sufficiency-observed`, `steering-drained`, `narrow-only-demanded` and
    // `cell-rejected-in-frame` reached every consumer with every field
    // dropped. The fallback itself is kept unchanged beneath the assignment,
    // because a build that somehow meets a tag it has never heard of should
    // still count the event rather than lose it.
    /* v8 ignore next 5 -- the `never` assignment proves at compile time that no declared event reaches this arm, and `AgentEvent` is a closed union built from the same sources, so nothing in the suite can produce a value that takes it */
    default: {
      const unreachable: never = event
      const unknown = unreachable as AgentEvent.AgentEvent
      return { eventType: `control.agent.${unknown._tag}`, payload: {} }
    }
  }
}

/**
 * {@link trace} over one run's events in order.
 *
 * `model-requested` is the one record written against the record before it,
 * and this is where "before it" is kept: one {@link RequestTrail} per scope
 * and purpose, so a compaction call and a frame call, or two steps sharing a
 * sink, never count each other's messages. Every other event projects exactly
 * as {@link trace} projects it.
 *
 * One per incarnation, made where the events are consumed and never shared or
 * kept across a restart. A resumed attempt replays its events from the first
 * frame, so a fold that starts empty regenerates the payloads the first
 * attempt wrote and the journal's unique index refuses them; one that carried
 * the last attempt's trail over would write the replayed prefix as new rows.
 *
 * @category projections
 * @since 1.0.0-rc.0
 */
export const tracer = (): (event: AgentEvent.AgentEvent) => ReturnType<typeof trace> => {
  const trails = new Map<string, RequestTrail>()
  return (event) => {
    if (event._tag !== "model-requested") return trace(event)
    const key = JSON.stringify([event.scope, event.purpose])
    const { payload, trail } = tracedRequest(event, trails.get(key))
    trails.set(key, trail)
    return { eventType: "control.agent.model-requested", payload }
  }
}

/**
 * Resolves the reasoning effort one run's model calls request.
 *
 * The flow's `effort:` frontmatter wins, then the host's configured default,
 * then `high`. The frontmatter value is validated against the effort
 * vocabulary and an unrecognised spelling falls through rather than failing
 * the launch: effort is a tuning knob, not a contract.
 */
const effortFor = (
  descriptor: { readonly frontmatter: Readonly<Record<string, unknown>> },
  host: ModelRequest.ReasoningEffort | undefined
): ModelRequest.ReasoningEffort => {
  const declared = descriptor.frontmatter["effort"]
  if (typeof declared === "string" && Schema.is(ModelRequest.ReasoningEffort)(declared)) {
    return declared
  }
  return host ?? "high"
}

/** The envelope an in-run ask approval binds to: the ask flow, nothing else. */
const askEnvelope: Envelope = { capabilities: [], flows: ["ask"], budget: {} }

interface AskInput {
  readonly question: string
  readonly options?: ReadonlyArray<string> | undefined
}

/**
 * The identity of one ask, derived from its run and whole input. Including the
 * run id prevents a grant for a byte-identical question in one run from
 * answering it in another, while remaining stable across this run's park and
 * resumed attempt. The raw call input and its decoded form digest identically
 * — both are plain JSON and canonical serialization sorts keys.
 */
const askIdentity = (
  runId: string,
  input: unknown
): { readonly digest: string; readonly requestId: string } => {
  const digest = Digest.digest(CanonicalJson.stringify({ input, runId }))
  return { digest, requestId: `ask/${runId}/${digest}` }
}

/** Dollars as a person reads them: cents when whole cents, else to the micro-dollar. */
const usdText = (value: number): string => {
  const cents = Math.round(value * 100)
  return Math.abs(value * 100 - cents) < 1e-6 ? `$${(cents / 100).toFixed(2)}` : `$${Number(value.toFixed(6))}`
}

/** The prefix of every approval request a parked budget registers. */
const budgetRequestPrefix = "budget/"

/**
 * The identity of one budget park, derived from its run, the scope it
 * exceeded, and the ceiling it exceeded, so a resumed run that exceeds an
 * approved raise asks again.
 *
 * The proposal is not part of it. A raise covers what the run has used, and a
 * latency run's elapsed time grows while it waits: an identity hashed from the
 * proposal named a new request on every re-drive, so a denial never answered
 * the request it was made on and the run asked again instead of failing
 * (#2739).
 */
const budgetIdentity = (
  runId: string,
  scope: Budget.BudgetExceeded["scope"],
  ceiling: Envelope["budget"]
): { readonly digest: string; readonly requestId: string } => {
  const digest = Digest.digest(CanonicalJson.stringify({ ceiling, runId, scope }))
  return { digest, requestId: `${budgetRequestPrefix}${runId}/${digest}` }
}

/** The `budget/` target one approval decision entry resolved, if any. */
const budgetDecision = (entry: JournalEvent.Entry) => {
  if (entry.eventType !== "control.approval.approved" && entry.eventType !== "control.approval.denied") return undefined
  const fact = Schema.decodeUnknownOption(ControlFacts.ApprovalDecisionFact)(entry.payload)
  if (Option.isNone(fact)) return undefined
  const target = fact.value.approvalTarget
  return target._tag === "Node" && target.requestId.startsWith(budgetRequestPrefix) ? target : undefined
}

/**
 * The `waiting_request` a park declares for one approval question: JSON text
 * built from the question alone, because the question is what the run's
 * `control.approval.requested` fact keeps. A host that re-parks the run
 * without having parked it rebuilds the same text from that fact.
 */
const declaredQuestion = (question: string): string => JSON.stringify({ question })

/**
 * The budgets an operator approved for one run's budget parks, read from its
 * `control.approval.approved` entries.
 */
const approvedRaises = (
  entries: ReadonlyArray<JournalEvent.Entry>
): ReadonlyArray<Envelope["budget"]> =>
  entries.flatMap((entry) => {
    const target = entry.eventType === "control.approval.approved" ? budgetDecision(entry) : undefined
    return target === undefined ? [] : [target.envelope.budget]
  })

/** Visits every page of one run's control journal, in order. */
const scanRun = (
  journal: Journal.Service,
  runId: string,
  visit: (entries: ReadonlyArray<JournalEvent.Entry>) => void
) =>
  Effect.gen(function*() {
    let after: JournalEvent.Seq | undefined
    for (;;) {
      const page = yield* journal.entries({
        runId: JournalEvent.RunId.make(runId),
        limit: 1_000,
        ...(after === undefined ? {} : { after })
      })
      visit(page.entries)
      if (!page.hasMore) return
      after = page.entries.at(-1)!.seq
    }
  })

/**
 * The envelope one run spends against: its approved card's, with every budget
 * raise an operator approved in the run's control journal applied.
 *
 * A native module handler reads it on each entry, so a park approved in this
 * process or before a restart reaches the resumed module as it reaches a
 * resumed prompt run.
 *
 * @category budget
 * @since 1.0.0
 */
export const approvedEnvelope = (
  journal: Journal.Service,
  runId: string,
  envelope: Envelope
): Effect.Effect<Envelope, Journal.JournalError> => {
  const raises: Array<Envelope["budget"]> = []
  return scanRun(journal, runId, (entries) => {
    raises.push(...approvedRaises(entries))
  }).pipe(Effect.map(() => Budget.raisedBy(envelope, raises)))
}

/** The request prefix every timeout park of one subject in one run shares. */
const timeoutPrefix = (runId: string, subject: string): string =>
  `${budgetRequestPrefix}${runId}/timeout/${Digest.digest(CanonicalJson.stringify({ runId, subject }))}/`

/** Where one timeout subject's latest park stands, from its run's control journal. */
interface TimeoutPark {
  /** The park's ordinal: the first timeout of a subject is 1, each Continue adds one. */
  readonly ordinal: number
  readonly fact: typeof ControlFacts.ApprovalRequestFact.Type
  readonly decision: "pending" | "approved" | "denied"
  /** How many of this subject's parks the operator continued. */
  readonly continued: number
}

/** Every timeout subject's latest park in one run's control journal, by request prefix. */
const timeoutParks = (journal: Journal.Service, runId: string) => {
  const facts = new Map<string, typeof ControlFacts.ApprovalRequestFact.Type>()
  const decisions = new Map<string, "approved" | "denied">()
  const prefix = `${budgetRequestPrefix}${runId}/timeout/`
  return scanRun(journal, runId, (entries) => {
    for (const entry of entries) {
      if (entry.eventType === "control.approval.requested") {
        const fact = Schema.decodeUnknownOption(ControlFacts.ApprovalRequestFact)(entry.payload)
        if (Option.isSome(fact) && fact.value.requestId.startsWith(prefix)) facts.set(fact.value.requestId, fact.value)
      }
      const target = budgetDecision(entry)
      if (target !== undefined && target.requestId.startsWith(prefix)) {
        decisions.set(target.requestId, entry.eventType === "control.approval.approved" ? "approved" : "denied")
      }
    }
  }).pipe(
    Effect.map(() => {
      // Folded in ordinal order, so each subject's highest ordinal is its
      // latest park whatever order the journal recorded the requests in.
      const requests = [...facts].map(([requestId, fact]) => {
        const cut = requestId.lastIndexOf("/") + 1
        return { subject: requestId.slice(0, cut), ordinal: Number(requestId.slice(cut)), fact }
      }).sort((left, right) => left.ordinal - right.ordinal)
      const parks = new Map<string, TimeoutPark>()
      for (const { fact, ordinal, subject } of requests) {
        const decision = decisions.get(fact.requestId) ?? "pending"
        const continued = (parks.get(subject)?.continued ?? 0) + (decision === "approved" ? 1 : 0)
        parks.set(subject, { ordinal, fact, decision, continued })
      }
      return parks
    }),
    Effect.mapError((cause) =>
      new HarnessError.HarnessError({
        code: "engine_failed",
        message: "The run's timeout decisions could not be read",
        cause
      })
    )
  )
}

/**
 * Parks a run whose `park` budget refused a call, or one of whose operations
 * ran past its time limit: registers the request in the run's control journal
 * with the guard's exact {@link RunawayGuard.incident} facts, and answers with
 * the `budget` wait and the requirement that suspends the frame. Approving the
 * request is Continue: a raised ceiling the resumed attempt spends against, or
 * one more run of the timed-out operation. Denying it is Stop: the resumed
 * attempt fails the run.
 *
 * `envelope` is the one the attempt spends against, with approved raises
 * applied. A request already made against that ceiling is reused as it was
 * recorded, proposal and facts included, so a re-driven run finds the
 * operator's decision on it rather than asking a new question. A concurrent
 * park that registered the same request first wins: this one parks on its
 * proposal. Timeouts are guarded only when the envelope's budget parks.
 *
 * @category budget
 * @since 1.0.0
 */
export const budgetParking = (
  journal: Journal.Service,
  runtime: Pick<ControlRuntime["Service"], "registerApproval">
) =>
(runId: string, envelope: Envelope): Budget.Parking["Service"] => {
  const commit = (request: {
    readonly requestId: string
    readonly question: string
    readonly target: typeof ControlFacts.ApprovalRequestFact.Type["payload"]["target"]
    readonly incident: RunawayGuard.Incident | undefined
  }) =>
    ControlFacts.commitApprovalRequest(journal, runtime, {
      runId,
      requestId: request.requestId,
      question: request.question,
      payload: { target: request.target, scope: "run", idempotencyKey: `approve:${request.requestId}` },
      ...(request.incident === undefined ? {} : { incident: request.incident })
    }, sourceId).pipe(Effect.map((token) => ({ token, question: request.question })))
  const parked = (requestId: string, question: string, resource: string): Budget.Parked => ({
    waiting: { reason: "budget", token: requestId, request: declaredQuestion(question) },
    failure: new HarnessError.HarnessError({
      code: "engine_failed",
      message: `Budget approval required: ${question}`,
      cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
        new Permission.PermissionRequired({
          code: "permission_required",
          requestId,
          runId,
          capability: Capability.make("model:call", resource),
          tier: "irreversible",
          meta: { question }
        })
      )
    })
  })
  const committed = (cause: unknown) =>
    new HarnessError.HarnessError({
      code: "engine_failed",
      message: "The budget approval request and token could not be committed",
      cause
    })
  // Read once per drive: a decision takes effect only by driving the run again.
  let decided: Map<string, TimeoutPark> | undefined
  return {
    guardsTimeouts: envelope.budget.onExceeded === "park",
    park: (exceeded) =>
      Effect.gen(function*() {
        const identity = budgetIdentity(runId, exceeded.scope, envelope.budget)
        let recorded: typeof ControlFacts.ApprovalRequestFact.Type | undefined
        yield* scanRun(journal, runId, (entries) => {
          for (const entry of entries) {
            if (recorded !== undefined || entry.eventType !== "control.approval.requested") continue
            const fact = Schema.decodeUnknownOption(ControlFacts.ApprovalRequestFact)(entry.payload)
            if (Option.isSome(fact) && fact.value.requestId === identity.requestId) recorded = fact.value
          }
        }).pipe(Effect.mapError((cause) =>
          new HarnessError.HarnessError({
            code: "engine_failed",
            message: "The run's budget requests could not be read",
            cause
          })
        ))
        const raisedCeiling = (budget: Envelope["budget"]) =>
          exceeded.scope === "tokens" ? budget.tokens : exceeded.scope === "usd" ? budget.usd : budget.milliseconds
        const question = (budget: Envelope["budget"]) => {
          const raised = raisedCeiling(budget)
          if (exceeded.scope === "usd") {
            return `Raise the USD budget from ${usdText(exceeded.max)} to ${usdText(raised ?? 0)}?`
          }
          const unit = exceeded.scope === "tokens" ? "tokens" : "ms"
          return `Raise the ${exceeded.scope} budget from ${exceeded.max} to ${raised} ${unit}?`
        }
        const proposed = (budget: Envelope["budget"]) => ({
          requestId: identity.requestId,
          question: question(budget),
          target: {
            _tag: "Node" as const,
            runId,
            requestId: identity.requestId,
            digest: identity.digest,
            envelope: { ...envelope, budget }
          },
          incident: RunawayGuard.incident(exceeded, raisedCeiling(budget))
        })
        const { question: asked, token } = yield* commit(
          recorded === undefined
            ? proposed(Budget.raise(envelope.budget, exceeded))
            : {
              requestId: identity.requestId,
              question: recorded.question,
              target: recorded.payload.target,
              incident: recorded.incident
            }
        ).pipe(
          // A concurrent park of this run registered the same identity between
          // the scan and this commit, with the raise its own elapsed time
          // proposed. The runtime holds one proposal per identity and reports
          // it in the refusal, so park on that one.
          Effect.catchIf(
            (cause): cause is EnvelopeMismatch =>
              recorded === undefined && cause instanceof EnvelopeMismatch && cause.planId === identity.requestId,
            (cause) =>
              Option.match(decodeRegisteredEnvelope(cause.expected), {
                onNone: () => Effect.fail(cause),
                onSome: (registered) => commit(proposed(registered.budget))
              })
          ),
          Effect.mapError(committed)
        )
        // A decided request no longer parks: a denial is the refusal it
        // asked to lift, and an approval this attempt did not apply is too.
        if (token._tag !== "Pending") {
          return yield* new HarnessError.HarnessError({
            code: "model_failed",
            message: exceeded.message,
            cause: exceeded
          })
        }
        return parked(identity.requestId, asked, `budget/${exceeded.scope}`)
      }),
    trip: (timeout) =>
      Effect.gen(function*() {
        const prefix = timeoutPrefix(runId, timeout.subject)
        decided = yield* timeoutParks(journal, runId)
        const latest = decided.get(prefix)
        if (latest?.decision === "denied") {
          return yield* RunawayGuard.stopped(latest.fact.incident ?? RunawayGuard.incident(timeout))
        }
        // An open question is the one this timeout re-parks on; a continued
        // one was answered by the run that just timed out again.
        const reused = latest?.decision === "pending" ? latest.fact : undefined
        const requestId = `${prefix}${reused === undefined ? (latest?.ordinal ?? 0) + 1 : latest!.ordinal}`
        const limit = timeout.limitMillis === undefined ? "its limit" : `another ${timeout.limitMillis} ms`
        const { question: asked, token } = yield* commit(
          reused === undefined
            ? {
              requestId,
              question: `${timeout.message} Continue runs it again with ${limit}; Stop fails the run.`,
              target: {
                _tag: "Node",
                runId,
                requestId,
                digest: Digest.digest(CanonicalJson.stringify({ requestId, runId })),
                envelope
              },
              incident: RunawayGuard.incident(timeout)
            }
            : { requestId, question: reused.question, target: reused.payload.target, incident: reused.incident }
        ).pipe(Effect.mapError(committed))
        if (token._tag === "Pending") return parked(requestId, asked, `timeout/${timeout.source}`)
        // Decided between the scan and the commit: settle on that decision.
        decided = undefined
        return yield* RunawayGuard.stopped(reused?.incident ?? RunawayGuard.incident(timeout))
      }),
    admit: (subject) =>
      Effect.gen(function*() {
        decided ??= yield* timeoutParks(journal, runId)
        const latest = decided.get(timeoutPrefix(runId, subject))
        // A subject that never timed out proceeds as one continued zero times.
        if (latest?.decision === "denied") {
          return yield* RunawayGuard.stopped(
            latest.fact.incident ?? { classification: "Stuck", source: "tool-call", message: latest.fact.question }
          )
        }
        if (latest?.decision === "pending") {
          return {
            _tag: "park",
            parked: parked(latest.fact.requestId, latest.fact.question, "timeout")
          } as const
        }
        return { _tag: "proceed", continued: latest?.continued ?? 0 } as const
      })
  }
}

/** The envelope a runtime's `EnvelopeMismatch` names as registered, if it decodes. */
const decodeRegisteredEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))

/**
 * Parses a run envelope's formatted capabilities, dropping every entry the
 * capability grammar cannot name. Dropping an unparseable entry narrows
 * authority — the fail-closed direction — because an empty envelope grants
 * nothing.
 *
 * The bare `*` a markdown-declared flow carries when its frontmatter names no
 * `capabilities:` is part of the grammar itself: `Capability.parsePattern`
 * expands it to `*:**`, so nothing here special-cases it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const patterns = (capabilities: ReadonlyArray<string>): ReadonlyArray<Capability.CapabilityPattern> =>
  capabilities.flatMap((formatted) => {
    const parsed = Capability.parsePattern(formatted)
    return Option.isSome(parsed) ? [parsed.value] : []
  })

/**
 * A prompt flow's body and its launch input, rendered into one task.
 *
 * @category models
 * @since 1.0.0
 */
export interface RenderedPrompt {
  /** The task the run is admitted with: the body, then the arguments. */
  readonly text: string
  /** The argument names the body can cite, in declaration order. */
  readonly fields: ReadonlyArray<string>
  /** The arguments section alone, as it appears inside {@link RenderedPrompt.text}. */
  readonly arguments: string
}

/** One argument value as the body must read it back: a string verbatim, anything else as JSON. */
const argumentValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null"

/**
 * The heading the arguments section opens with.
 *
 * It says what the section is rather than only labelling it, because the
 * failure this replaces was a model reading a trailing block as an appendix
 * to skim: `Input:\n{ "args": "s16-marker" }` under no heading at all.
 */
const argumentsHeading = "# Arguments\n\nThe values this run was launched with. Use them exactly as given.\n\n"

/**
 * Renders the prompt-flow body and its decoded input into the task the run is
 * admitted with.
 *
 * Every declared field becomes its own `## <field>` heading with its value
 * verbatim beneath it, so a body that says "the line given in the arguments"
 * resolves to one value in one place. The previous rendering appended
 * `Input:` and the pretty-printed JSON object, and a production run
 * (`plan:28e015f8`) asked to append the marker from its arguments appended the
 * invented line `unknown-marker` instead and reported success.
 *
 * An absent or empty input adds nothing at all: the task is the trimmed body,
 * byte for byte, so a flow that carries no input keeps the prompt it was
 * already cached under.
 *
 * @category conversions
 * @since 1.0.0
 */
export const prompt = (text: string, input: unknown): RenderedPrompt => {
  const body = text.trim()
  const entries: ReadonlyArray<readonly [string, unknown]> = input == null
    ? []
    : typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input as Record<string, unknown>)
    // A scalar or an array declares no field to name, so the section names the
    // whole input rather than inventing a key the body could not cite.
    : [["input", input] as const]
  if (entries.length === 0) return { text: body, fields: [], arguments: "" }
  const fields = entries.map(([field]) => field)
  const rendered = entries.map(([field, value]) => `## ${field}\n\n${argumentValue(value)}`).join("\n\n")
  return { text: `${body}\n\n${argumentsHeading}${rendered}`, fields, arguments: rendered }
}

/**
 * The journal record of what a launch input was rendered into.
 *
 * Without it an ignored argument is only visible in the diff of whatever the
 * run was asked to change, which is exactly the evidence a run that ignored
 * its argument does not produce. The record is bounded like every other trail
 * field, and it is written whether or not the flow declared an input, so an
 * empty `fields` is the positive statement that there was nothing to ignore.
 *
 * @category projections
 * @since 1.0.0
 */
export const promptRendered = (
  rendered: RenderedPrompt
): { readonly eventType: Transcript.ControlEventType; readonly payload: unknown } => ({
  eventType: "control.agent.prompt-rendered",
  payload: { fields: rendered.fields, arguments: tracedField(rendered.arguments) }
})

/**
 * The failure the engine persists as this flow's settlement.
 *
 * `agent/run` declares `error: Schema.Unknown`, and `Schema.toCodecJson`
 * reads that as "any JSON value". Every real agent failure is an `Error`
 * instance instead — a `HarnessError` wrapping a `ModelError`, a
 * `SeatUnresolved` — so the codec rejected every one of them, `engine-store`
 * degraded the settlement into a projection, and it said so in a second WARN
 * stack beside the run's own `An agent run failed` (release validation observation
 * N1: two stack traces for one billing refusal).
 *
 * The rendering is the package's one failure serializer, shared with the
 * action and the budget boundaries so a nested `Error` reads the same in every
 * durable record rather than only in this one.
 *
 * @category conversions
 * @since 1.0.0
 */
export const settlementFailure = (error: unknown): unknown => failureJson(error)

/**
 * The one durable flow every agent run executes. Its plan-time body is inert;
 * the behaviour is the `execute` registered by {@link make}, and the
 * execution id is the control run id. A host re-drives a run by resuming it
 * under this address, which is also how an unrequested round reaches the
 * registered handler.
 *
 * @category flows
 * @since 1.0.0
 */
export const agentFlow = Flow.make("agent/run", {
  payload: { runId: Schema.String, planId: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/**
 * Waits for ControlLive to publish its running transition before a driver
 * starts the engine. Keeping the bounded retry here makes the publication race
 * deterministic to exercise without coupling it to a particular scheduler.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForRunning = (
  status: (runId: string) => Effect.Effect<RunStatus, unknown>,
  runId: string,
  attempts: number,
  retryDelay: Effect.Effect<void> = Effect.sleep(Duration.millis(10))
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const current = yield* status(runId)
    if (current === "running") {
      // The running row is written inside ControlLive's admission transaction.
      // Cross the same asynchronous retry boundary once more so that
      // transaction can commit before the engine opens its own durable
      // transaction.
      yield* retryDelay
      return true
    }
    if (current === "accepted" && attempts > 0) {
      yield* retryDelay
      return yield* waitForRunning(status, runId, attempts - 1, retryDelay)
    }
    if (current === "accepted") {
      return yield* Effect.fail(
        new LaunchFailed({
          runId,
          message: "The accepted run was not published as running before its driver admission budget expired"
        })
      )
    }
    return false
  })

/**
 * Polls a durable execution until it is published as parked. A missing poll is
 * a still-live execution, so retries are bounded before a resume is attempted.
 *
 * @category helpers
 * @since 0.1.0
 */
export const waitForParked = (
  poll: () => Effect.Effect<Option.Option<{ readonly _tag: string }>, unknown>,
  attempts: number
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const result = yield* poll()
    if (Option.isNone(result)) {
      if (attempts <= 0) return false
      yield* Effect.sleep(Duration.millis(10))
      return yield* waitForParked(poll, attempts - 1)
    }
    return result.value._tag === "Suspended"
  })

const recoverCause = <A>(
  cause: Cause.Cause<unknown>,
  message: string,
  fallback: A,
  annotations: Readonly<Record<string, unknown>>
): Effect.Effect<A> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.annotateLogs(
      Effect.logWarning(message).pipe(Effect.as(fallback)),
      { ...annotations, cause: Cause.pretty(cause) }
    )

/**
 * Keeps a control cancellation durable even when its engine interrupt fails.
 *
 * @category helpers
 * @since 0.1.0
 */
export const preserveDriverInterrupt = <R>(
  interrupt: () => Effect.Effect<void, unknown, R>
): Effect.Effect<void, never, R> =>
  interrupt().pipe(
    Effect.catchCause((cause) => recoverCause(cause, "The engine interrupt could not be delivered", undefined, {}))
  )

/**
 * Translates a failed driver registration into the executor's launch error.
 *
 * @category helpers
 * @since 0.1.0
 */
export const registerDriver = (
  register: () => Effect.Effect<void, unknown>,
  runId: string
): Effect.Effect<void, LaunchFailed> =>
  register().pipe(
    Effect.mapError((cause) =>
      new LaunchFailed({
        runId,
        message: "The run driver could not be registered for cancellation",
        cause
      })
    )
  )

/**
 * Re-throws a cancelled driver while logging a non-interrupt engine failure.
 *
 * @category helpers
 * @since 0.1.0
 */
export const settleDriverFailure = <E, R>(
  cause: Cause.Cause<unknown>,
  runId: string,
  writeFailed: (detail: string) => Effect.Effect<void, E, R>
): Effect.Effect<void, E, R> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.andThen(
      Effect.annotateLogs(
        Effect.logError("An accepted agent run could not start on the engine"),
        { runId, cause: Cause.pretty(cause) }
      ),
      writeFailed(Cause.pretty(cause))
    )

/**
 * Records a cancellation on the engine row, whichever process owns the run.
 *
 * This is the durable half of `Control.cancel`. Interruption is a fiber
 * operation and fibers are process-local, so a cancel that only interrupted
 * would reach nothing when a second `flows` process, the UI, or a gateway asked
 * — the engine row's `cancel_requested_at_ms` is what the owning driver's
 * cancel poll reads, and it is first-writer-wins, so a repeat is harmless.
 *
 * `NotFound` is `unknown` rather than a failure: an engine that never heard of
 * the run has nothing to record, and the control plane's own interrupt and
 * journal entry are still the whole answer for a run this composition launched
 * nothing for.
 *
 * @category helpers
 * @since 0.1.0
 */
export const requestCancel = (
  input: ControlExecutor.CancelRequest
): Effect.Effect<ControlExecutor.CancelRecord, PersistenceError, RunStore.RunStore> =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const at = yield* Clock.currentTimeMillis
    const failure = (runId: string) => (cause: unknown) =>
      new PersistenceError({
        operation: "AgentSession.requestCancel",
        message: `The engine could not record a cancellation for ${runId}`,
        cause
      })
    // A completed round can have a live handoff successor. Resolve membership
    // and record intent in one engine-store write transaction; neither a stale
    // control row nor a read of just the predecessor decides terminality.
    const outcome = yield* runs.requestCancelLineage(input.runId, at).pipe(Effect.mapError(failure(input.runId)))
    if (outcome._tag === "Terminal") return { _tag: "Terminal", status: outcome.status } as const
    if (outcome._tag === "NotFound") return "unknown"
    // The store already distinguishes the write that recorded the request from
    // the one that found it recorded, and the control plane needs that
    // difference: `Control.cancel` runs with `replay: false`, so every repeat
    // re-executes, and attributing each one journals a fresh
    // `control.run.cancel-requested` for a cancellation that happened once.
    return outcome._tag === "AlreadyRequested" ? "already-requested" : "recorded"
  })

/**
 * Reads current-round lifecycle and the requested run's ancestry from the
 * engine services captured by the host. The existing engine transaction keeps
 * these reads coherent; the SQLite adapter holds a writer lock only for the
 * scoped reads, without executing or waiting on the run.
 *
 * Control metadata is read separately. This is not a cross-database snapshot
 * or a revisioned read projection. A later trampoline round supplies lifecycle
 * and waiting state, while parent and round ordinal still name `runId`.
 *
 * @category queries
 * @since 0.1.0
 */
export const readExecution = (
  runId: string
): Effect.Effect<
  ControlExecutor.ExecutionObservation,
  PersistenceError,
  RunStore.RunStore | DurableEngineState.DurableEngineState
> =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    // The current round, its waiting reason and parent edge must come from
    // one snapshot. Completion/handoff can otherwise split these three reads.
    return yield* state.transaction(Effect.gen(function*() {
      const row = yield* runs.latestRound(runId).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeed(Option.none<RunStore.RunRow>())
            : Effect.fail(
              new PersistenceError({
                operation: "read engine execution",
                message: `Cannot read engine execution ${runId}`,
                cause: error
              })
            )
        )
      )
      if (Option.isNone(row)) return { _tag: "Missing" } as const
      const waiting = yield* state.waiting(row.value.runId)
      const current = row.value
      const tree = yield* state.waitingTree(current.runId)
      // A module run's budget parks the native child that made the call, and
      // the root only awaits that child. The tree's budget wait is why the
      // run waits, and what an operator acts on (#2739).
      const reason = Option.isSome(waiting)
        ? waiting.value.reason === "event" && tree.some((wait) => wait.reason === "budget")
          ? "budget"
          : waiting.value.reason
        : undefined
      // Every open human wait in the TREE, not just this row's own.
      //
      // A flow that calls another flow parks the child execution, and those
      // executions exist only here: the control plane keeps a separate
      // coordination database and has never seen them. So a `HumanTask`
      // several `.child()` boundaries down was invisible to everything outside
      // this process — the run an operator opened reported `parked` on an
      // `event` and the approvals inbox was empty, which is how run-1 of
      // workspace 6f2733a3 parked on `coding-clarification` with no way to
      // answer it. This port is the only reader of both databases, so it is
      // where the tree's open questions become visible.
      const pendingWaits = tree
        .flatMap((wait) =>
          ControlExecutor.pendingWaitOf({
            runId: wait.runId,
            reason: wait.reason,
            token: wait.token,
            createdAt: current.createdAtMs,
            ...(wait.request === undefined ? {} : { request: wait.request })
          }) ?? []
        )
      const identity = current.runId === runId ? current : yield* runs.get(runId).pipe(
        Effect.mapError((cause) =>
          new PersistenceError({
            operation: "read engine execution",
            message: `Cannot read engine identity ${runId}`,
            cause
          })
        )
      )
      // Old low-level rows may contain arbitrary JSON rather than a native
      // RunState. Preserve their historical status observation, while declining
      // normalized replay coverage; current writers require the full contract.
      const hasNativeIdentity = (row: RunStore.RunRow): boolean => {
        try {
          const flowName = JSON.parse(row.stateJson)?.flowName
          return typeof flowName === "string" && flowName.length > 0
        } catch {
          return false
        }
      }
      const executionView = hasNativeIdentity(identity) && hasNativeIdentity(current) ?
        {
          root: yield* ExecutionFacts.observe(identity, state).pipe(Effect.orDie),
          current: yield* ExecutionFacts.observe(current, state).pipe(Effect.orDie),
          humanWaits: yield* Effect.forEach(pendingWaits, (wait) =>
            runs.get(wait.runId).pipe(
              Effect.flatMap((waitingRun) => ExecutionFacts.observe(waitingRun, state)),
              Effect.orDie
            ))
        } :
        undefined
      return {
        _tag: "Observed",
        executionView,
        // An execution whose tree holds an open human wait is waiting on a
        // human, however nested the row that holds it and whether or not its
        // own row has flipped to `suspended` yet: a parent awaiting a
        // `.child()` is blocked on that child's question either way. Only
        // ATTACHED waits reach here — `waitingTree` skips a detached subtree,
        // whose whole point is to outlive the run that spawned it.
        status: current.status === "pending"
          ? "accepted"
          : current.status === "suspended"
          ? reason === ControlExecutor.humanWaitReason || pendingWaits.length > 0 ? "waiting-approval" : "parked"
          : current.status === "running" && pendingWaits.length > 0
          ? "waiting-approval"
          : current.status,
        waitingReason: current.status === "suspended" ? reason : undefined,
        ...(pendingWaits.length === 0 ? {} : { pendingWaits }),
        parentRunId: identity.parentRunId ?? (yield* state.runParents(identity.runId))[0]?.parentId,
        lineageId: identity.lineageId ?? current.lineageId ?? undefined,
        // Older lineage roots have null columns; membership was established by
        // latestRound, so they remain round zero of that lineage.
        roundOrdinal: identity.roundOrdinal ?? (current.runId === runId ? undefined : 0)
      } as const
    }))
  }).pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
    const failure = Cause.squash(cause)
    return Effect.fail(
      failure instanceof PersistenceError ? failure : new PersistenceError({
        operation: "read engine execution",
        message: `Cannot read engine observation ${runId}`,
        cause: failure
      })
    )
  }))

/** The deferred name a `WaitFor` wait point is recorded under. */
const waitPointName = (signal: string): string => `WaitFor/${signal}`

/**
 * Whether a parked wait point is the one a signal names.
 *
 * Two spellings are accepted, because a re-asked question has one name and
 * many wait points. `WaitFor.action` parks on `WaitFor/<name>`, and each
 * attempt of a `HumanTask` parks on its own `WaitFor/<name>#<attempt>`
 * (`@smthrs/flow` `HumanTask`). A person answering `coding-clarification`
 * knows the question's name and has no reason to know it is on its second
 * attempt, so the bare name matches whichever attempt is currently open —
 * and only one ever is, because an attempt's park ends before the next
 * begins.
 */
const namesWaitPoint = (deferredName: string, signal: string): boolean => {
  const exact = waitPointName(signal)
  if (deferredName === exact) return true
  if (!deferredName.startsWith(`${exact}#`)) return false
  const attempt = Number(deferredName.slice(exact.length + 1))
  return Number.isSafeInteger(attempt) && attempt > 0
}

/** Reads a recorded wake token, reporting an unreadable one as a store fault. */
const parseWakeToken = (
  runId: string,
  token: string
): Effect.Effect<DurableDeferred.TokenParsed, PersistenceError> =>
  Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(token).pipe(
    Effect.mapError((cause) =>
      new PersistenceError({
        operation: "AgentSession.deliverSignal",
        message: `The wake token recorded for ${runId} is not a durable deferred token`,
        cause
      })
    )
  )

/**
 * Completes the `WaitFor` wait point a run is parked on with a signal's
 * payload.
 *
 * The wait point is read off the run's own waiting row rather than derived from
 * the flow, because the engine writes the deferred's token there when it parks
 * (`WaitFor.layer` annotates `reason: "event"` with the token). That makes the
 * bridge flow-agnostic: it completes whatever wait point the parked run
 * actually declared, through the ordinary `DurableDeferred.succeed` path every
 * other resolver uses, and the engine's own `scheduleResume` re-drives the run.
 *
 * The three answers are distinct on purpose. `delivered` completed a wait
 * point. `no-match` means the run IS parked and is waiting for something else —
 * a different signal name, an approval, a timer — which `Control.signal`
 * refuses rather than recording a delivery nothing consumes. `unknown` means
 * this executor can see no open wait point at all, which is not the same as
 * knowing there is none: another process may own the run, or it may not have
 * parked yet, and the recorded message is what a later start replays.
 *
 * A `delivered` answer also records the resume it is owed, through
 * `ControlRuntime.requestResume`. Completing the wait point is not on its own
 * enough to restart the run: {@link make}'s round guard re-enters a parked run
 * only for a delegation somebody recorded, and the only other caller of
 * `requestResume` is `ControlLive.decide`, which records one for an approval
 * TOKEN. Every ask answered by completing a wait point instead — each
 * `HumanTask` and `WaitFor` park, which is how the repository flows ask and how
 * the gateway routes `Approval.Submit` on a human wait — would otherwise settle
 * its deferred and leave the run parked on the question it had just answered.
 *
 * @category helpers
 * @since 0.1.0
 */
export const deliverSignal = (
  input: ControlExecutor.Signal
): Effect.Effect<
  ControlExecutor.SignalDelivery,
  PersistenceError,
  DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const control = yield* Effect.serviceOption(ControlRuntime)
    // The answer is what asks for the re-drive, and this is the asking. Two
    // refusals are not delivery failures: `RunNotFound` is an execution this
    // control plane never launched, and `InvalidInput` is a run that has
    // already settled. Neither has a park for a delegation to re-drive, and
    // recording one anyway leaves a row no host ever clears.
    const recordAnswerResume = Effect.suspend(() =>
      Option.isNone(control) ? Effect.void : control.value.requestResume(input.runId).pipe(
        Effect.asVoid,
        Effect.catchTags({
          "/control/RunNotFound": () => Effect.void,
          "/control/InvalidInput": () => Effect.void
        })
      )
    )
    // Every open wait in the run TREE, not only the named run's own row. A
    // flow that calls another flow parks the child execution, so `run-3` of
    // `coding/request` sat on an `event` wait while the question a person had
    // to answer was parked three executions below it; addressing the run an
    // operator knows about answered `/control/NoMatchingWait` for a wait that
    // was wide open (`DurableEngineState.waitingTree`).
    const open = yield* state.waitingTree(input.runId)
    let token = input.token ?? null
    let reason = "event"
    if (token === null) {
      const matched = yield* Effect.findFirst(open, (row) =>
        row.token === null ? Effect.succeed(false) : Effect.map(
          parseWakeToken(input.runId, row.token),
          (parsed) => namesWaitPoint(parsed.deferredName, input.signal.name)
        ))
      if (Option.isNone(matched)) {
        // No open wait anywhere in the tree is `unknown`: another process may
        // own the run, or it may not have parked yet. An open wait that this
        // signal does not name is `no-match`, which is the refusal.
        return open.length === 0 ? "unknown" as const : "no-match" as const
      }
      token = matched.value.token!
      reason = matched.value.reason
    } else {
      // A bound retry carries its token and must complete under the same
      // reason the park declared, or the compare-and-swap finds no row.
      const parked = open.find((row) => row.token === token)
      if (parked !== undefined) reason = parked.reason
    }
    const parsed = yield* parseWakeToken(input.runId, token)
    if (!namesWaitPoint(parsed.deferredName, input.signal.name)) return "no-match" as const
    // A human wait is an approval gate, and a signal is not an approval: its
    // admitting principal must be one `ApprovalAuthority` lets approve this
    // wait's `Node` target, exactly as `Control.approve` would check it. The
    // principal was stamped at admission, so a replay after restart is judged
    // as the original caller. No principal, or no runtime to ask, refuses.
    if (reason === ControlExecutor.humanWaitReason) {
      if (Option.isNone(control) || input.principal === undefined) return "refused" as const
      const authorized = yield* control.value.authorizeApproval({
        principal: input.principal,
        target: {
          _tag: "Node",
          runId: input.runId,
          requestId: input.signal.name,
          digest: token,
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        decision: "approved",
        scope: "once"
      }).pipe(
        Effect.as(true),
        Effect.catchTag("/control/Unauthorized", () => Effect.succeed(false))
      )
      if (!authorized) return "refused" as const
    }
    // First binding wins in control.db. A crash before or after completion
    // retries this exact token; the command can never move to a later wait.
    if (input.commandId !== undefined) {
      if (Option.isNone(control)) {
        return yield* new PersistenceError({
          operation: "AgentSession.deliverSignal",
          message: "Durable signal admission requires ControlRuntime"
        })
      }
      token = yield* control.value.bindSignal(input.commandId, token)
      if (token === null) return "no-match" as const
    }
    const bound = yield* Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(token).pipe(Effect.orDie)
    if (!namesWaitPoint(bound.deferredName, input.signal.name)) return "no-match" as const
    const completionMatches = (row: DurableEngineState.DeferredRow): boolean => {
      const exit = row.exit as Exit.Exit<unknown, unknown>
      return Exit.isExit(exit) && Exit.isSuccess(exit) &&
        CanonicalJson.stringify(exit.value) === CanonicalJson.stringify(input.signal.payload)
    }
    const previous = yield* state.deferred(bound)
    if (Option.isSome(previous)) {
      if (!completionMatches(previous.value)) return "no-match" as const
      // A retry of an answer already recorded. The resume is requested again
      // because the first attempt may have died between the completion and
      // the request, and an answer whose re-drive was lost is an answer
      // nobody gave: `requestResume` keys on the run, so a second request is
      // the same delegation with a newer sequence, not a second one.
      yield* recordAnswerResume
      return "delivered" as const
    }
    const engine = yield* FlowRuntime.FlowRuntime
    const outcome = yield* engine.deferredDoneIfWaiting(
      WaitFor.deferred(bound.deferredName.slice("WaitFor/".length)),
      {
        flowName: bound.flowName,
        executionId: bound.executionId,
        deferredName: bound.deferredName,
        reason,
        token,
        exit: Exit.succeed(input.signal.payload)
      }
    )
    // Completion rechecks the concrete token in the engine transaction. A
    // competing resolver may have won; the durable stored result is the proof.
    const completed = yield* state.deferred(bound)
    if (Option.isSome(completed)) {
      if (!completionMatches(completed.value)) return "no-match" as const
      yield* recordAnswerResume
      return "delivered" as const
    }
    if (outcome !== "NotWaiting") return "unknown" as const
    // A normal resume clears waiting before replay parks on the same token.
    // Losing that CAS is not evidence that the admitted signal is wrong. Keep
    // the command bound so the inbox retries this exact wait, never a later one.
    const waiting = yield* state.waiting(bound.executionId)
    if (
      Option.isSome(waiting) && waiting.value.token !== null && waiting.value.token !== token
    ) return "no-match" as const
    const runs = yield* Effect.serviceOption(RunStore.RunStore)
    if (Option.isSome(runs)) {
      const row = yield* runs.value.get(bound.executionId).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) =>
          cause.code === "not_found_row" ? Effect.succeed(Option.none<RunStore.RunRow>()) : Effect.fail(
            new PersistenceError({
              operation: "AgentSession.deliverSignal",
              message: "The bound signal execution could not be read",
              cause
            })
          )
        )
      )
      if (
        Option.isNone(row) || ["completed", "failed", "cancelled"].includes(row.value.status)
      ) return "no-match" as const
    }
    return "unknown" as const
  })

/**
 * Reconciles a bounded rotating page of admitted signal commands.
 *
 * The host runs this at startup and every 250 ms. A command without a
 * concrete wait stays pending; a bound command always retries its original
 * token, including after the run has settled but acknowledgment was lost.
 * Legacy payload-only messages are not replayed because their application
 * identity cannot be recovered safely.
 *
 * @category helpers
 * @since 0.1.0
 */
export const drainRecordedSignals: Effect.Effect<
  void,
  never,
  ControlRuntime | DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime
> = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const commands = yield* runtime.pendingSignals
  yield* Effect.forEach(commands, (command) =>
    Effect.gen(function*() {
      const current = yield* runtime.getRun(command.runId)
      if (
        command.token === null &&
        (current.status === "completed" || current.status === "failed" || current.status === "cancelled")
      ) {
        yield* runtime.settleSignal(command.commandId, "terminal")
        return
      }
      const delivery = yield* deliverSignal(command)
      if (delivery !== "unknown") {
        yield* runtime.settleSignal(command.commandId, delivery === "delivered" ? "delivered" : "rejected")
      }
    }).pipe(Effect.catchCause((cause) =>
      Effect.logWarning("Pending signal delivery failed", { commandId: command.commandId, cause: Cause.pretty(cause) })
    )), { discard: true })
}).pipe(
  Effect.catchCause((cause) =>
    Effect.annotateLogs(
      Effect.logWarning("Recorded signals could not be replayed at executor start"),
      { cause: Cause.pretty(cause) }
    )
  )
)

/** Everything the executor captures at construction and re-provides per run. */
type Services =
  | Agent
  | ControlRuntime
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | FlowRuntime.FlowRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue
  | Registry.Registry
  | RunStore.RunStore
  | SeatResolver

/**
 * Constructs the production executor.
 *
 * Must be built in a scope: the scope owns the registered agent flow, every
 * forked run driver, and the resume bridge that follows the journal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<ControlExecutor.Service, never, Services | Scope.Scope> =>
  Effect.gen(function*() {
    const abandonedParkAfterMs = Duration.toMillis(options.abandonedParkAfter ?? Ownership.heartbeatStaleAfter)
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const registry = yield* Registry.Registry
    // A host registers native modules through the existing executable catalog.
    // Prompt-only compositions retain their current admission behavior.
    const executables = yield* Effect.serviceOption(Executable.Catalog)
    const engine = yield* FlowRuntime.FlowRuntime
    const seats = yield* SeatResolver
    // Optional so every existing composition keeps its requirements: without
    // a catalog, an undeclared seat is refused exactly as it always was.
    const seatCatalog = yield* Effect.serviceOption(SeatRouter.Catalog)
    const agent = yield* Agent
    const engineRuns = yield* RunStore.RunStore
    const engineState = yield* DurableEngineState.DurableEngineState
    const scope = yield* Effect.scope
    const services = yield* Effect.context<Services>()

    /**
     * Emits one agent-trace event on the journal's lossy channel, under the
     * identity {@link traceIdentity} derived for it.
     *
     * The channel matters more than it looks. A trace event is telemetry, not
     * lifecycle state, and the executor emits it from inside the harness
     * stream's own consumer — so a durable emit deadlocks: the write joins the
     * single writer's transaction queue behind the engine transaction that the
     * harness frame is still inside, while the frame cannot proceed until the
     * consumer accepts the event. Runs stalled silently at 0% CPU a few frames
     * in. `emitLossy` queues instead of joining the transaction, which is the
     * documented channel for exactly this.
     *
     * Native call invocation and recorded-result facts have a separate producer
     * in ActionPersistence, inside the owning action transaction. That durable
     * journal is the outbox; this consumer remains compatible telemetry and
     * cannot establish a call's committed lifecycle by itself.
     *
     * The explicit sequence rides the same channel. It used to send the emit
     * through a preflight SELECT before admission, which reintroduced that
     * deadlock from the other side, and `emitLossy` now settles an explicit
     * identity from memory or admits it optimistically, leaving the unique
     * index to refuse the duplicate at the insert. `dedupe: "identity"` is
     * this producer saying the sequence is derived from the event: the
     * observation metadata that differs between a first attempt and a replay
     * must not be read as two different events.
     */
    const trail = (
      runId: string,
      sourceSeq: JournalEvent.SourceSeq,
      eventType: string,
      payload: unknown
    ): Effect.Effect<void, unknown> =>
      journal.emitLossy(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: trailSourceId,
          sourceSeq,
          dedupe: "identity",
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )

    /**
     * Decides one ask before its durable boundary opens. An unresolved ask
     * registers its token, publishes the exact approval payload an operator
     * replays through `smithers approve`, and parks the run with an encoded
     * `PermissionRequired`; a resolved one lets the activity run and read the
     * decision.
     */
    const authorize =
      (runId: string, instance: FlowRuntime.FlowInstance["Service"]) =>
      (call: Cell.Call): Effect.Effect<void, HarnessError.HarnessError> =>
        Effect.gen(function*() {
          if (call.flowName !== StandardFlows.askFlow.name) return
          const input = call.input as unknown as AskInput
          const identity = askIdentity(runId, call.input)
          const target = {
            _tag: "Node" as const,
            runId,
            requestId: identity.requestId,
            digest: identity.digest,
            envelope: askEnvelope
          }
          const token = yield* ControlFacts.commitApprovalRequest(journal, runtime, {
            runId,
            requestId: identity.requestId,
            question: input.question,
            payload: { target, scope: "run", idempotencyKey: `approve:${identity.requestId}` }
          }, sourceId).pipe(Effect.mapError((cause) =>
            new HarnessError.HarnessError({
              code: "engine_failed",
              message: "The approval request and token could not be committed",
              cause
            })
          ))
          if (token._tag !== "Pending") return
          // Classify the park before taking it. Without this the engine derived
          // the reason from durable state and an in-run `ask` — which arms no
          // clock — parked under `event`, the reason `Control.steer` treats as
          // "waiting for something to arrive" and therefore wakes on a message.
          // `approval` is what the run is actually waiting for, and the request
          // id is the token a wake handler matches (engine-store issue #31).
          // The annotation cannot go stale: a round that parks here ends, and
          // the resumed round runs under an instance of its own. The instance
          // travels down from the registered handler rather than through a map
          // the handler writes: the body is forked with `startImmediately`, so a
          // map written after the fork is not yet written when the body's first
          // ask reaches this line, and the park then took the derived `event`
          // reason instead of `approval`.
          yield* Effect.provideService(
            FlowRuntime.annotateWaiting({
              reason: "approval",
              token: identity.requestId,
              request: declaredQuestion(input.question)
            }),
            FlowRuntime.FlowInstance,
            instance
          )
          return yield* Effect.fail(
            new HarnessError.HarnessError({
              code: "engine_failed",
              message: `Approval required: ${input.question}`,
              cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
                new Permission.PermissionRequired({
                  code: "permission_required",
                  requestId: identity.requestId,
                  runId,
                  // No action in the capability vocabulary names a human
                  // decision; the request carries the question in `meta` and
                  // the model seat's own action as the closest formal claim.
                  capability: Capability.make("model:call", `ask/${identity.digest}`),
                  tier: "irreversible",
                  meta: { question: input.question }
                })
              )
            })
          )
        })

    const parking = budgetParking(journal, runtime)

    /**
     * Answers from the decision itself, not from a scan of unrelated grants.
     * A pending or unreadable answer is not an implicit denial or approval.
     */
    const asker = (runId: string): StandardFlows.Asker => ({
      ask: (input) =>
        Effect.gen(function*() {
          const identity = askIdentity(runId, input)
          const token = yield* runtime.registerApproval({
            _tag: "Node",
            runId,
            requestId: identity.requestId,
            digest: identity.digest,
            envelope: askEnvelope
          }).pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError.HarnessError({
                  code: "engine_failed",
                  message: `The approval decision could not be read for run ${runId}`,
                  cause
                })
            )
          )
          if (token._tag === "Pending") {
            return yield* new HarnessError.HarnessError({
              code: "engine_failed",
              message: "The ask has no approval decision yet"
            })
          }
          const approved = token._tag === "Approved"
          return { answer: approved ? "approved" : "denied", approved }
        })
    })

    /**
     * The fence each run this session parked was parked under.
     *
     * `RunSummary.parkedBy` is the durable half; this is the half only the
     * parking process can hold. A fence is minted per claim, so a fence this
     * map still holds and the row still names is proof that THIS incarnation
     * parked THAT execution — which is the only thing that distinguishes the
     * host of a parked run from any other process that can see it, since a
     * park releases the owner columns on both rows (triage B-15).
     */
    const parkFences = new Map<string, string>()

    /** Whether a status leaves the run parked rather than driving or ending it. */
    const parks = (status: RunStatus): boolean => status === "parked" || status === "waiting-approval"

    /**
     * Writes one fenced status transition and its journal record.
     *
     * A terminal `failed` carries the rendered cause. Before it did, the
     * cause went only to `Effect.logWarning`, so a failed run was
     * undiagnosable from its own journal: three of the five first SWE-bench
     * benchmark runs ended `control.run.failed {runId, status}` and nothing
     * else, and the log line was long gone. The journal is the record a
     * `smithers status` diagnosis reads, so the reason a run died belongs in it.
     * Beside it goes the failure's typed {@link Fault}, which the gateway
     * carries to the worker so nothing downstream re-reads the prose.
     */
    const writeStatus = (runId: string, status: RunStatus, detail?: string, fault?: Fault.Fault) =>
      Effect.suspend(() => {
        let fence: string
        return ControlFacts.commitRun(
          journal,
          Effect.gen(function*() {
            fence = yield* runtime.claimFence(runId)
            return yield* runtime.writeStatus(runId, fence, status)
          }),
          sourceId,
          `control.run.${status}`,
          {
            ...(detail === undefined ? {} : { cause: detail.slice(0, 4096) }),
            ...(fault === undefined ? {} : { fault })
          }
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (parks(status)) parkFences.set(runId, fence)
              else parkFences.delete(runId)
            })
          ),
          Effect.asVoid
        )
      })

    const claimForResume = (runId: string) =>
      ControlFacts.commitRun(journal, runtime.resume(runId), sourceId, "control.run.claimed")

    /**
     * Every terminal control write this executor makes, for as long as it owes
     * one. The scope waits for them the way it waits for a drive.
     */
    const terminalWrites = new Map<object, Fiber.Fiber<unknown, unknown>>()

    /**
     * Writes one terminal control status, after the host's ordering has let it.
     *
     * It cannot be awaited where it is called. `settle` runs inside the engine's
     * registered handler, and what {@link Options.orderTerminalStatus} waits for
     * — the engine's own terminal commit, and the decision copied from it — is
     * written only after that handler returns. Awaiting it here would be the run
     * waiting for itself, so the write leaves on its own fiber and the session's
     * scope carries it.
     *
     * With no ordering to observe there is nothing to wait for and nothing to
     * detach: the status is written inline, exactly as it was.
     */
    const settleTerminal = (runId: string, status: RunStatus, detail?: string, fault?: Fault.Fault) => {
      const write = writeStatus(runId, status, detail, fault).pipe(
        Effect.catchTag("/control/ClaimLost", (cause) =>
          status === "cancelled"
            ? runtime.getRun(runId).pipe(
              Effect.flatMap((run) => run.status === "cancelled" ? Effect.void : Effect.fail(cause))
            )
            : Effect.fail(cause))
      )
      const order = options.orderTerminalStatus
      if (order === undefined) return write
      return Effect.sync(() => {
        const key = {}
        terminalWrites.set(
          key,
          Effect.runForkWith(services)(
            order(runId).pipe(
              // The ordering is a wait, never a veto. A host whose observation
              // dies still owes this run a terminal status, so a refusal is
              // recorded and the write goes on; only the scope closing under it
              // stops it, and the finalizer below gives that its own grace.
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.annotateLogs(
                  Effect.logWarning("A terminal control status was ordered by a host that stopped answering"),
                  { runId, status, cause: Cause.pretty(cause) }
                )
              ),
              Effect.andThen(write),
              // Nothing joins this fiber, so an unwritten terminal status would
              // otherwise be silent. It is the run's outcome of record.
              Effect.catchCause((cause) =>
                Effect.annotateLogs(
                  Effect.logError("A terminal control status could not be written"),
                  { runId, status, cause: Cause.pretty(cause) }
                )
              ),
              Effect.ensuring(Effect.sync(() => terminalWrites.delete(key)))
            )
          )
        )
      })
    }

    // An interrupt can mean shutdown or durable cancellation. Only the engine
    // row's recorded intent authorizes a terminal cancellation; an unreadable
    // or absent row must remain reclaimable.
    const settleInterrupted = (runId: string) =>
      engineRuns.get(runId).pipe(
        Effect.map((row) => row.cancelRequestedAtMs !== null),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.annotateLogs(Effect.logWarning("Cancellation intent could not be read"), {
              runId,
              cause: Cause.pretty(cause)
            }),
            false
          )
        ),
        Effect.flatMap((cancelled) => cancelled ? settleTerminal(runId, "cancelled") : Effect.void)
      )

    /**
     * Settles the control-plane status from one execution attempt's exit. A
     * suspension surfaces as an interrupt-only cause — the engine parked the
     * frame — and every re-executed attempt settles again, so the resumed
     * run writes its own terminal status.
     */
    const settle = (
      runId: string,
      suspended: boolean,
      exit: Exit.Exit<unknown, unknown>,
      waitingReason?: string
    ) =>
      Exit.isSuccess(exit)
        ? settleTerminal(runId, "completed")
        // Flow suspension deliberately interrupts the user body. Process
        // shutdown and Control.cancel do too, but neither sets the durable
        // execution's suspension bit; reporting those as an approval wait
        // would leave a cancelled run looking resumable.
        : Cause.hasInterruptsOnly(exit.cause)
        ? suspended
          ? writeStatus(runId, waitingReason === "approval" ? "waiting-approval" : "parked")
          : settleInterrupted(runId)
        : exit.cause.reasons.some((
            reason
          ) => (Cause.isDieReason(reason) && reason.defect instanceof AttemptEvidenceQuarantined)
          )
        ? writeStatus(runId, "parked", Cause.pretty(exit.cause))
        : Effect.andThen(
          Effect.annotateLogs(Effect.logWarning("An agent run failed"), {
            runId,
            cause: Cause.pretty(exit.cause)
          }),
          Effect.suspend(() => {
            const error = Cause.squash(exit.cause)
            const detail = failureSummary(settlementFailure(error))
            const cause = Cause.pretty(exit.cause)
            return settleTerminal(
              runId,
              "failed",
              detail === undefined ? cause : `${detail}\n${cause}`,
              Fault.of(error)
            )
          })
        )

    const approvedExecution = (
      runId: string,
      card: PlanCard,
      descriptor: Descriptor.FlowDescriptor,
      adopted?: string | undefined
    ): Effect.Effect<string, LaunchFailed> =>
      Effect.suspend(() => {
        const expected = adopted ?? card.executionDigest
        if (expected === undefined || Descriptor.executionDigest(descriptor) !== expected) {
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: `Flow ${card.flowId} changed or has no approved executable identity; ` +
                "create and approve a new plan before running it",
              cause: { flowId: card.flowId }
            })
          )
        }
        return Effect.succeed(expected)
      })

    const approvedSeats = (
      runId: string,
      card: PlanCard,
      descriptor: Descriptor.FlowDescriptor
    ): Effect.Effect<ReadonlyArray<string>, LaunchFailed> =>
      Effect.suspend(() => {
        // Validate the same executable fields at launch and on every resume.
        // A declared seat is a person's choice and wins. An undeclared one is
        // Jev's to pick, at run start, from the host's catalog; a host with no
        // catalog cannot run it at all.
        if (Option.isNone(descriptor.model)) {
          if (Option.isSome(seatCatalog)) return Effect.succeed([Seat.auto])
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: `Flow ${card.flowId} declares no model seat: add a \`model:\` line to ` +
                `its frontmatter, then run \`smithers doctor\` to see which provider keys this project has`,
              cause: { flowId: card.flowId }
            })
          )
        }
        return Effect.succeed(
          typeof descriptor.model.value === "string" ? [descriptor.model.value] : descriptor.model.value
        )
      })

    /**
     * The catalog an `auto` seat is routed over, with at least one seat in
     * it. Checked at launch, so an unroutable run is refused before it is
     * accepted, and again on every attempt, which is where Jev is asked.
     */
    const routingCatalog = (runId: string): Effect.Effect<SeatRouter.Service, LaunchFailed> =>
      Effect.gen(function*() {
        const refused = (reason: "unconfigured" | "no_candidates", message: string) =>
          new LaunchFailed({ runId, message, cause: { seat: Seat.auto, reason } })
        if (Option.isNone(seatCatalog)) {
          return yield* refused("unconfigured", "This host has no seat catalog to route an `auto` seat over")
        }
        const candidates = yield* seatCatalog.value.candidates.pipe(
          Effect.mapError((error) => refused("unconfigured", error.message))
        )
        if (candidates.length === 0) return yield* refused("no_candidates", "The seat catalog offers no seat")
        return seatCatalog.value
      })

    const approvedModule = (
      runId: string,
      card: PlanCard,
      executionDigest: string
    ): Effect.Effect<Executable.Executable, LaunchFailed> =>
      Effect.suspend(() => {
        const catalog = Option.getOrUndefined(executables)
        const executable = catalog?.executables.find((entry) => entry.descriptor.name === card.flowId)
        if (executable === undefined || Descriptor.executionDigest(executable.descriptor) !== executionDigest) {
          const refusal = catalog?.refused.find((entry) => entry.flow === card.flowId)
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: refusal?.message ??
                `Flow ${card.flowId} has no registered executable matching its approved identity`,
              cause: refusal ?? { flowId: card.flowId }
            })
          )
        }
        // A module that IS its own flow delegates to nothing: the approved
        // execution digest covers its entry bytes and the digest of every
        // module that entry imports from beside itself, so there is no
        // unmeasured code for the envelope to have had to name. A delegate is
        // the opposite — host-registered code the descriptor never measured.
        if (executable.delegate !== undefined && !card.envelope.flows.includes(executable.delegate)) {
          return Effect.fail(
            new LaunchFailed({
              runId,
              message: `Flow ${card.flowId} delegates to ${executable.delegate}, outside the approved flow envelope`,
              cause: { flowId: card.flowId, delegate: executable.delegate }
            })
          )
        }
        return Effect.succeed(executable)
      })

    /** One agent run, executed as the whole of one durable flow execution. */
    const body = (
      payload: { readonly runId: string; readonly planId: string },
      instance: FlowRuntime.FlowInstance["Service"]
    ) =>
      Effect.gen(function*() {
        // Check before opening any model or cell boundary. A new hash alone
        // would turn old settlements into misses and repeat their side effects.
        let after: JournalEvent.Seq | undefined
        const raises: Array<Envelope["budget"]> = []
        for (;;) {
          const page = yield* journal.entries({
            runId: JournalEvent.RunId.make(payload.runId),
            limit: 1_000,
            ...(after === undefined ? {} : { after })
          })
          yield* Effect.fromResult(Transcript.validateJournal(page.entries))
          raises.push(...approvedRaises(page.entries))
          if (!page.hasMore) break
          after = page.entries.at(-1)!.seq
        }
        const plan = yield* runtime.getPlan(payload.planId)
        const card = plan.card
        yield* Effect.annotateCurrentSpan("smithers.flow", card.flowId)
        // A budget park's approval raises the ceiling this attempt spends
        // against; the card itself stays the plan that was approved.
        const envelope = Budget.raisedBy(card.envelope, raises)
        const descriptor = yield* registry.get(card.flowId)
        // The run records the plan's digest at launch. Only `runs resume
        // --allow-code-drift` moves it, to the code the operator accepted, so
        // that is the identity this execution may enter (#1807). A round or
        // fork that recorded none runs under its ancestor's, which is the one
        // the drift check admitted it on (#2740). A control row that cannot be
        // read leaves the plan's digest binding.
        const recorded = yield* runtime.recordedCode(payload.runId).pipe(
          Effect.map((code) => code.executionDigest),
          Effect.orElseSucceed(() => undefined)
        )
        const executionDigest = yield* approvedExecution(payload.runId, card, descriptor, recorded)
        // The launch already validated the seat and body; re-validation here
        // guards a registry that changed between acceptance and execution.
        const flowBody = yield* registry.loadBody(card.flowId, executionDigest)
        if (flowBody._tag !== "Prompt") {
          const executable = yield* approvedModule(payload.runId, card, executionDigest)
          const input = yield* Schema.decodeUnknownEffect(Schema.Json)(plan.decodedInput)
          // One ordinary durable child retains the module's native topology,
          // action outputs, waits and replay. The existing session continues
          // to own control admission, cancellation and settlement. It is keyed
          // on the plan's digest, not the adopted one, so a drifted resume
          // continues that child: unchanged steps replay and only re-keyed
          // ones run again.
          return yield* executable.flow.execute({ input }, {
            executionId: Digest.digest(
              Digest.canonical(["control/module", payload.runId, card.executionDigest ?? executionDigest])
            )
          }).pipe(
            CapabilitySet.attenuate(patterns(card.envelope.capabilities)),
            Effect.provide(options.budget(envelope)),
            Effect.provide(options.quotaPolicy)
          )
        }
        const seatIds = yield* approvedSeats(payload.runId, card, descriptor)
        const seatId = seatIds[0]!
        const steering = yield* Notifications.make({ runId: payload.runId, lineageId: payload.runId })
        // The three services a durable flow body already holds, captured
        // together: `StandardFlows.clock` hands them back to a `DurableClock`
        // sleep, whose deferred key is hashed, so `Crypto` travels with the
        // runtime rather than being substituted at the binding.
        const engineServices = yield* Effect.context<
          Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
        >()
        const tags: Array<string> = []
        // The trail is buffered in memory and written by a fiber of its own,
        // never by the stream's consumer.
        //
        // The consumer runs inside the frame: the harness cannot emit its next
        // event until this callback returns, and the frame it is inside holds
        // the engine's write transaction. A journal write here therefore waits
        // on a writer that is waiting on this callback, and the run stalls
        // silently at 0% CPU a few frames in — which is exactly what happened
        // when this was a plain `emitDurable`, and still happened on the lossy
        // channel because its queue drains through the same writer. Pushing
        // onto an array cannot block, so the frame always proceeds; the pump
        // below writes whatever has accumulated once the writer is free again.
        const pending: Array<
          { readonly sourceSeq: JournalEvent.SourceSeq; readonly eventType: string; readonly payload: unknown }
        > = []
        // The one record that says what the model was actually handed of the
        // launch input, pushed before the first frame so the flush on the way
        // out carries it even if the run never opens a turn. Frame `-1` is
        // where it sits: before every frame, and derived from the same
        // material on a resumed attempt, so the unique index deduplicates it.
        const rendered = prompt(flowBody.text, plan.decodedInput)
        // Jev routes an `auto` seat once per run: the decision is a sealed
        // step keyed by this execution, so a resumed attempt is served the
        // route and variant it first started on and asks nothing.
        const routing = seatId === Seat.auto
          ? yield* Effect.gen(function*() {
            const catalog = yield* routingCatalog(payload.runId)
            const decision = yield* SeatRouter.durable({
              declared: seatId,
              state: {
                task: rendered.text,
                flow: card.flowId,
                description: descriptor.description,
                capabilities: card.envelope.capabilities
              },
              // An interactive run does not fan out, so it routes to one seat.
              panel: false
            }, { executionId: payload.runId, purpose: "run" }).pipe(
              Effect.provideService(SeatRouter.Catalog, catalog),
              Effect.provide(engineServices)
            )
            const variant = SeatRouter.variantText(catalog.variants, decision.variant)
            if (variant === undefined) {
              return yield* new Seat.SeatUnrouted({
                seat: seatId,
                reason: "unconfigured",
                message: `The seat catalog no longer offers the variant ${decision.variant} this run started on`
              })
            }
            return { decision, variant }
          })
          : undefined
        const resolvedSeats = yield* Effect.forEach(
          routing === undefined ? seatIds : [routing.decision.seat, ...routing.decision.backups],
          (id) => seats.resolve(id)
        )
        const seat = resolvedSeats[0]!
        const fallbackSeats = resolvedSeats.slice(1)
        const renderedRecord = promptRendered(rendered)
        const renderedMaterial = JSON.parse(JSON.stringify(renderedRecord.payload)) as Record<string, unknown>
        pending.push({
          sourceSeq: traceIdentity(-1, 0, "", renderedRecord.eventType, renderedMaterial),
          eventType: renderedRecord.eventType,
          payload: {
            ...renderedMaterial,
            at: yield* Clock.currentTimeMillis,
            journalVersion: Transcript.journalVersion
          }
        })
        const flush = Effect.suspend(() =>
          Effect.forEach(
            pending.splice(0, pending.length),
            // Contained per entry rather than per batch: one refused event must
            // not take the rest of the batch down with it.
            (entry) => Effect.ignore(trail(payload.runId, entry.sourceSeq, entry.eventType, entry.payload)),
            { discard: true }
          )
        )
        // Journaling is best-effort on purpose: a full or rejecting journal
        // must not fail an agent run that is otherwise making progress.
        // Occurrence time is stamped into the payload because the pump
        // flushes in batches: `emitted_at_ms` is admission time, so every
        // event in one flush shares a millisecond and per-call timing is
        // unrecoverable from the row alone.
        //
        // Where the run is, as the stream reports it, which is what
        // `traceIdentity` derives an event's identity from. A resumed attempt
        // republishes its whole prefix from frame zero, so counting frames and
        // the events inside them reproduces the same coordinates for the same
        // events, and only for them. Non-journaled events (the model deltas)
        // are not counted: they carry no row, and leaving them out keeps the
        // ordinal a position in the trail rather than in the stream.
        let frame = -1
        let ordinal = 0
        let cell = ""
        // Made per incarnation for the same reason the counters start over: a
        // request record is written against the one before it, and a replayed
        // prefix regenerates its rows only if it folds from the first frame.
        const project = tracer()
        const record = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => {
              tags.push(event._tag)
              if (event._tag === "turn-opened") {
                frame += 1
                ordinal = 0
                cell = ""
              }
              if (event._tag === "cell-produced") cell = event.cell.digest
              const projected = project(event)
              if (projected !== undefined) {
                // Normalized once, here, so the identity is derived from the
                // same bytes the journal stores. A projection carries optional
                // fields as `undefined`, which JSON drops and canonical JSON
                // refuses outright, so deriving straight from the projection
                // threw on the first `cell-call-settled` that answered without
                // a message.
                const material = JSON.parse(JSON.stringify(projected.payload)) as Record<string, unknown>
                // A record that carries its own coordinates takes no ordinal,
                // so its arrival moves no other row; see {@link unordered}.
                const positioned = !unordered.has(projected.eventType)
                const sourceSeq = traceIdentity(frame, positioned ? ordinal : 0, cell, projected.eventType, material)
                if (positioned) ordinal += 1
                pending.push({
                  sourceSeq,
                  eventType: projected.eventType,
                  payload: { ...material, at, journalVersion: Transcript.journalVersion }
                })
              }
            }))
        const pump = yield* Effect.forkChild(
          Effect.forever(Effect.andThen(Effect.sleep(Duration.millis(250)), flush))
        )
        const memory = options.memory === undefined ? undefined : yield* Action.make({
          name: "agent/opening-memory",
          tier: "sealed",
          idempotencyKey: `${payload.runId}:opening-memory`,
          success: Schema.Struct({ rows: MemorySnapshot.Snapshot.fields.rows, digest: Schema.String }),
          error: Schema.Unknown,
          execute: options.memory({
            runId: payload.runId,
            prompt: rendered.text,
            history: [],
            capabilities: card.envelope.capabilities
          })
        })
        const instructions = options.instructions === undefined ? [] : yield* Action.make({
          name: "agent/opening-instructions",
          implementationVersion: "1",
          tier: "sealed",
          idempotencyKey: `${payload.runId}:opening-instructions`,
          success: Schema.Array(Schema.String),
          error: Schema.Unknown,
          execute: options.instructions({ descriptor, text: flowBody.text, capabilities: card.envelope.capabilities })
        })
        const system = [...(options.system ?? []), ...instructions, ...(routing?.variant ?? [])]
        const outcome = yield* agent.run({
          memory,
          instructions: options.workspaceInstructions,
          pinnedSources: options.pinnedSources,
          contextWindowTokensFor: contextWindowResolver(seats),
          session: payload.runId,
          seat,
          fallbackSeats,
          modelParams: ModelRequest.GenerationParams.make({
            reasoningEffort: effortFor(descriptor, options.reasoningEffort)
          }),
          capacity: options.capacity,
          prompt: rendered.text,
          // The host's own system text stays first; a routed run's variant
          // follows it.
          system,
          registry,
          promptRunner: options.promptRunner,
          flows: [
            ...(options.flows ?? []),
            StandardFlows.clock(engineServices),
            StandardFlows.approval(options.asks === "refuse" ? StandardFlows.askerNoop() : asker(payload.runId))
          ],
          // A refusing host registers no approval and parks on nothing.
          ...(options.asks === "refuse" ? {} : { authorize: authorize(payload.runId, instance) }),
          capabilityEnvelope: patterns(card.envelope.capabilities),
          limits: options.limits,
          maxFrames: options.maxFrames,
          // A task run's frames are supposed to change something, so hold it
          // to a rhythm of acting rather than only reading.
          readOnlyCap: options.readOnlyCap ?? CellTurn.defaultReadOnlyFrames,
          // Passed straight through rather than defaulted here: unlike the
          // read-only cap, the controller's own default is the one this
          // executor wants, and a second copy of the number would be a second
          // thing to keep true. The repeat cap is passed the same way.
          modelCallMs: options.modelCallMs,
          repeatCap: options.repeatCap,
          narrowingCap: options.narrowingCap,
          unmovedCap: options.unmovedCap,
          unresolvedCap: options.unresolvedCap,
          approvalChannel: options.approvalChannel ?? false,
          supervisor: options.supervisor,
          judged: options.judged
        }).pipe(
          // A routed run's decision opens its trail; a declared seat adds nothing.
          (stream) =>
            routing === undefined ? stream : Stream.concat(
              Stream.fromIterable(SeatRouter.events(routing.decision, { scope: payload.runId, modelId: seat.modelId })),
              stream
            ),
          (stream) => agentOutcome(stream, record),
          // A refusing host registers no approval, so its `park` budget fails.
          (effect) =>
            options.asks === "refuse"
              ? effect
              : Effect.provideService(effect, Budget.Parking, parking(payload.runId, envelope)),
          Effect.provide(options.budget(envelope)),
          Effect.provide(options.quotaPolicy),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provideService(Steering.Source, steering),
          // The pump is interrupted before the final flush so the two never
          // race for the same buffered entries, and the flush runs on the way
          // out of every exit — settled, failed, or parked — because a parked
          // run's trail is the one an operator most needs to read.
          Effect.onExit(() => Effect.andThen(Fiber.interrupt(pump), flush))
        )
        if (outcome._tag === "FramesExhausted") {
          return yield* new HarnessError.HarnessError({
            code: "model_failed",
            message:
              `The agent session "${payload.runId}" ended without a completed answer after ${outcome.frames} frames`,
            cause: outcome
          })
        }
        return tags
      })

    const activeBodies = new Map<string, Fiber.Fiber<unknown, unknown>>()

    /** One launched run's drive, for as long as this composition owns its fiber. */
    interface Drive {
      /**
       * Whether the flow body has exited, leaving only the engine's own
       * terminal write.
       *
       * The control status and the engine's terminal transition are two
       * writes, in that order: `settle` runs on the body's exit, INSIDE the
       * registered handler, and the engine records the round's result only
       * after that handler returns.
       */
      settled: boolean
    }

    /**
     * The drive of every run this composition launched and still owns. An
     * entry is created by `launch` and removed when its fiber ends, so nothing
     * a sweep or a resume drives ever enters it.
     */
    const launchedDrives = new Map<string, Drive>()

    /**
     * How long a closing scope waits for a drive fiber whose body has already
     * settled.
     *
     * The wait is for one engine transaction, which is milliseconds. The bound
     * exists so a wedged store costs a bounded exit rather than a hung one.
     */
    const settlementGrace = Duration.seconds(5)

    /**
     * Releases one drive fiber when this composition's scope closes.
     *
     * A drive fiber that is still executing is interrupted at once. That is
     * process shutdown, and `RunDriver.settleInterrupted` releases the row for
     * reclaim, which is the contract. A drive fiber whose body has already
     * settled is a different thing: nothing is left to interrupt but the
     * engine's own terminal write, so that write is awaited first.
     *
     * Without the wait, an attached launch tore that write in half. The CLI
     * returns on `control.run.completed` (`packages/smithers/src/Command.ts`
     * `awaitRun`), its scope closes, and this finalizer interrupted the driver
     * 10 to 14 ms before `engine.execute` had recorded the `Complete` result.
     * The release validation measured it on both a foreground `smithers run` and a
     * `smithers up -d`: `control.run.completed` at 1788163027537,
     * `flows.engine.run-decision interrupt-released` at 1788163027551. The row
     * was left `suspended`/`released` with no result, so every later process
     * that composed an executor claimed it and replayed the agent turn: 16 run
     * decisions across 11 pids for one run, tokens reported six times over,
     * and `gc` never collecting it from `engine.db`.
     */
    const releaseDrive = (drive: Drive, fiber: Fiber.Fiber<unknown, unknown>): Effect.Effect<void> =>
      Effect.suspend(() =>
        drive.settled
          ? Effect.andThen(
            Effect.ignore(Effect.timeout(Fiber.await(fiber), settlementGrace)),
            Fiber.interrupt(fiber)
          )
          : Fiber.interrupt(fiber)
      )

    const driveFibers = new Map<Drive, Fiber.Fiber<unknown, unknown>>()
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(driveFibers),
          ([drive, fiber]) => releaseDrive(drive, fiber),
          { discard: true, concurrency: "unbounded" }
        )
      )
    )
    // A detached terminal write is the run's outcome of record, so a closing
    // scope gives it the same bounded chance `releaseDrive` gives the engine's
    // own terminal write. Its ordering releases when the host's observation
    // ends, and closing the host ends every observation, so this waits for a
    // write that is already on its way rather than for a projection.
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(terminalWrites.values()),
          (fiber) =>
            Effect.andThen(
              Effect.ignore(Effect.timeout(Fiber.await(fiber), settlementGrace)),
              Fiber.interrupt(fiber)
            ),
          { discard: true, concurrency: "unbounded" }
        )
      )
    )

    const driver = (runId: string, planId: string) =>
      Effect.gen(function*() {
        const admitted = yield* waitForRunning(
          (id) => runtime.getRun(id).pipe(Effect.orDie, Effect.map((run) => run.status)),
          runId,
          400
        )
        if (!admitted) return
        // Awaited, not discarded: `discard: true` admits the run and returns
        // (#2932), which would end this fiber at once and leave the cancel
        // handler below nothing to interrupt the body through.
        yield* engine.execute(agentFlow, {
          executionId: runId,
          payload: { runId, planId }
        }).pipe(
          Effect.asVoid,
          // ControlRuntime awaits this driver while it owns the control
          // transaction, so the active flow body is interrupted synchronously
          // here: no tool escapes a cancellation that has already committed.
          //
          // And that is ALL this handler does. It used to call
          // `engine.interrupt` — the DURABLE cancel, which writes
          // `cancel_requested_at_ms` — for every interruption of this fiber,
          // and a park interrupts it as surely as a cancel does. A flow that
          // suspended on a durable clock or an in-run `ask` was therefore
          // recorded as cancelled at the parking process's exit: the guarded
          // suspended transition in `RunDriver.settleRound` read the request
          // and answered `GuardFailed`, `cancelOwned` completed the run's
          // clock rows 150 seconds before they fell due, and the journal
          // gained `flows.engine.interrupted {"outcome":"cancelled"}` for a
          // run nobody had cancelled (release rehearsal).
          //
          // The durable half of a cancellation belongs to the caller that
          // meant one. `Control.cancel` writes it through
          // `ControlExecutor.requestCancel` INSIDE its own mutation
          // transaction, before it interrupts anything, and rolls the whole
          // cancel back if the engine refuses. `RunDriver.settleInterrupted`
          // then reads that record and discriminates on it: an interruption
          // backed by a request closes the run, and every other one releases
          // it for reclaim (engine-store issue #26). Recording the request
          // here as well made this fiber's interruption its own evidence,
          // which is the one thing it can never be.
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              const bodyFiber = activeBodies.get(runId)
              if (bodyFiber !== undefined) {
                yield* Fiber.interrupt(bodyFiber).pipe(
                  Effect.forkDetach({ startImmediately: true })
                )
              }
            })
          )
        )
      }).pipe(
        Effect.catchCause((cause) =>
          settleDriverFailure(cause, runId, (detail) => settleTerminal(runId, "failed", detail))
        )
      )

    /**
     * Whether this engine publishes the execution as parked, treating a store
     * that cannot answer as "not parked": a composition with no evidence
     * leaves the run to the host that has some.
     */
    const parkedHere = (runId: string, attempts: number): Effect.Effect<boolean> =>
      awaitParked(runId, attempts).pipe(
        Effect.catchCause((cause) => recoverCause(cause, "The engine park state could not be read", false, { runId }))
      )

    const awaitParked = (runId: string, attempts: number): Effect.Effect<boolean, unknown> =>
      Effect.gen(function*() {
        // A time-travel fork has executable state but no previous Suspended
        // result. Ownership columns prove it is available without waiting
        // for a publication that only an already-executed run can produce.
        const row = yield* engineRuns.get(runId).pipe(
          Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.fail(error))
        )
        if (
          row !== undefined && (row.status === "pending" || row.status === "suspended") &&
          row.owner === null && row.claim === null
        ) {
          const state = JSON.parse(row.stateJson) as { flowName?: unknown; result?: unknown }
          if (state.flowName === agentFlow._tag && state.result === undefined) return true
        }
        return yield* waitForParked(
          () =>
            engine.poll(agentFlow, runId).pipe(
              // The journal carries resume events for runs other executors own —
              // a paused system flow, a shared control database. An execution
              // this engine does not know will not become parked by waiting, so
              // it is published as a settled non-parked state: the wait ends
              // now instead of holding the single-concurrency bridge through
              // the whole retry budget.
              Effect.catchTag(
                "@smthrs/flow/FlowExecutionNotFound",
                () => Effect.succeed(Option.some({ _tag: "NotFound" }))
              )
            ),
          attempts
        )
      })

    /**
     * Re-drives one execution `takeUpResume` has already found parked here and
     * claimed. A refusal is contained: one run that cannot restart must not
     * take the follower or the journal bridge down with it.
     */
    const resumeExecution = (runId: string, uptake: Uptake): Effect.Effect<void> =>
      (uptake._tag === "delegated"
        ? engine.resume(agentFlow, runId, { delegated: true }).pipe(
          Effect.andThen(reparkRefusedDelegation(runId))
        )
        : engine.resume(agentFlow, runId, { poll: uptake.sequence === undefined })).pipe(
          Effect.catchCause(
            (cause) =>
              Effect.annotateLogs(
                Effect.logWarning("A parked agent run could not be resumed"),
                { runId, cause: Cause.pretty(cause) }
              )
          )
        )

    /**
     * Returns the control claim a delegated resume took when the engine
     * refused to drive it.
     *
     * The park precheck in {@link takeUpResume} and the engine's resume are
     * separate reads: a peer can quarantine the execution between them. The
     * engine refuses a delegated resume of a quarantine park atomically, which
     * leaves this executor holding a control claim that nothing is driving.
     * The row goes back to `parked`, which is where a quarantined run waits
     * for the operator. A drive that entered the body and quarantined there
     * has already parked the row itself, and is left alone.
     */
    const reparkRefusedDelegation = (runId: string) =>
      Effect.gen(function*() {
        const waiting = yield* engineState.waiting(runId)
        if (Option.isNone(waiting) || waiting.value.reason !== "quarantine") return
        if (parks((yield* runtime.getRun(runId)).status)) return
        yield* writeStatus(runId, "parked")
      })

    /**
     * Closes a parked run whose cancellation this process has just recorded.
     *
     * A park has no owner, which is what makes it resumable — so nothing is
     * driving the run and nothing reads the request the CONTROL plane just
     * wrote on the engine row. The engine's own parked-run sweep ticks once
     * per `Ownership.heartbeatInterval`, but a `smithers cancel` process
     * writes the request at the very end of its life and exits before that
     * tick lands: the release validation watched an engine row stay `suspended`
     * with `cancel_requested_at_ms` set through six more commands and 15
     * seconds, so `gc` skipped the run in `engine.db` while collecting it in
     * `control.db`, and only a 20-second `smithers serve` finalized it.
     *
     * Driving the run settles it inside the cancelling call, after the
     * mutation that recorded the request has committed — inside it the
     * engine's writes would wait on the writer that transaction holds, and
     * the cancel deadlocked until its timeout. It cannot
     * re-execute the flow: the request is durable BEFORE this runs, and the
     * engine's re-activation guard closes a run with a recorded cancellation
     * instead of entering its body (engine-store issue #39, pinned by
     * `InterruptReleaseReclaim`). A run this engine does not host is not
     * parked as far as `poll` is concerned, or refuses the claim, and either
     * way this is a no-op — the durable request stays for the host that does.
     */
    const settleCancelledPark = (runId: string): Effect.Effect<void> =>
      Effect.flatMap(
        // No retries: a run this engine is not hosting must cost a cancel
        // nothing, and one it is hosting is already parked by the time the
        // request is durable.
        parkedHere(runId, 0),
        (parked) => parked ? resumeExecution(runId, { _tag: "claimed" }) : Effect.void
      )

    /**
     * Whether this composition is the one hosting a parked run.
     *
     * Engine visibility is not hosting. A parked execution has released its
     * owner and its heartbeat on both rows — that is what makes it resumable —
     * so `engine.poll` answers `Suspended` in EVERY process that opened the
     * same `engine.db`, and the shipped CLI composes an executor in every one
     * of them (`NodeControl.layerControl` builds `layerExecutor` unless
     * `--remote`). A `smithers approve` against a run a gateway parked could
     * therefore claim the control row, drive the run itself, and strand it at
     * process exit. `RunSummary.parkedBy` is what answers instead: the fence
     * the park was written under, which only the parking incarnation still
     * holds (triage B-15).
     *
     * Three answers, in order:
     *
     * - No `parkedBy` at all: nothing claims to host the run — an operator's
     *   own park, or a row parked before this field existed — so the take-up
     *   proceeds as it always did.
     * - `parkedBy` this session wrote: this is the host. It takes its own
     *   delegation up at once, which is the ordinary same-process approval.
     * - Somebody else's `parkedBy`: not this composition's run to drive, so
     *   the delegation is left standing for the host that parked it — until
     *   it has stood unanswered for `options.abandonedParkAfter`, defaulting
     *   to the engine's `heartbeatStaleAfter`. Refusing it forever would leave
     *   a run parked by an exited process unresumable by another host.
     *
     * A control store that cannot answer is not evidence of a foreign host, so
     * it leaves the decision where it was before this guard existed.
     */
    const hostsPark = (
      runId: string,
      uptake: Uptake
    ): Effect.Effect<boolean, never> =>
      Effect.gen(function*() {
        if (uptake._tag === "claimed") return true
        const parkedBy = yield* runtime.getRun(runId).pipe(
          Effect.map((run) => run.parkedBy),
          Effect.catchCause((cause) =>
            recoverCause(cause, "The parked run host could not be read", undefined, { runId })
          )
        )
        if (parkedBy === undefined) return true
        if (parkFences.get(runId) === parkedBy) return true
        if (uptake.requestedAtMs === undefined) return false
        const nowMs = yield* Clock.currentTimeMillis
        return nowMs - uptake.requestedAtMs >= abandonedParkAfterMs
      })

    /**
     * Takes up one resume: this executor's execution, this executor's fence.
     *
     * The park wait comes first. It ends `false` for an execution this engine
     * does not have, and for one that is not parked, and neither is this
     * executor's to claim. {@link hostsPark} comes second and is the ownership
     * question proper: an execution this engine can SEE is not one it hosts.
     *
     * The claim comes third and is what makes the re-driven run WRITABLE.
     * `writeStatus` reaches `claimFence`, which requires `ownedByUs`, which
     * requires a `running` row: a run re-driven without a claim runs to its
     * end and then cannot record that it did.
     *
     * `drive` is how the caller wants the re-drive run. The journal bridge
     * awaits it, so one process's re-drives stay serialized; the port forks it,
     * so a control-plane call returns as soon as the run is moving again.
     *
     * `uptake` says which seam asked. See {@link Uptake}: an operator's own
     * resume is not guarded, an approval delegation is.
     */
    const takeUpResume = (
      runId: string,
      drive: (runId: string, uptake: Uptake) => Effect.Effect<void>,
      uptake: Uptake
    ): Effect.Effect<ControlExecutor.ResumeUptake, never> =>
      Effect.gen(function*() {
        if (options.canExecute !== undefined && !(yield* options.canExecute(runId))) return "unknown" as const
        const parked = yield* parkedHere(runId, 500)
        if (!parked) return "unknown" as const
        // A saved clock, deferred, parent, or approval request is background
        // intent. It can predate a later corruption park, so it cannot stand
        // in for the explicit recovery decision the engine requires. This
        // read only spares a claim: a peer can still quarantine the run after
        // it, and the engine's refusal of a delegated resume is the fence
        // ({@link reparkRefusedDelegation} hands the claim back).
        if (uptake._tag === "delegated") {
          const eligible = yield* engineState.waiting(runId).pipe(
            Effect.map((waiting) => Option.isNone(waiting) || waiting.value.reason !== "quarantine"),
            Effect.catchCause((cause) =>
              recoverCause(cause, "The parked engine wait could not be read", false, { runId })
            )
          )
          if (!eligible) return "unknown" as const
        }
        const hosted = yield* hostsPark(runId, uptake)
        if (!hosted) return "unknown" as const
        const claimed = yield* claimForResume(runId).pipe(
          Effect.as(true),
          // A lost claim is a live peer holding the run, and the delegation
          // stays standing for it. Answering "resuming" here would clear a
          // delegation this executor is not going to honour.
          Effect.catchCause((cause) =>
            recoverCause(cause, "The parked run could not be claimed for resume", false, { runId })
          )
        )
        if (!claimed) return "unknown" as const
        if (
          uptake._tag === "claimed" && uptake.sequence !== undefined && options.authorizeReleasedChildren !== undefined
        ) {
          yield* options.authorizeReleasedChildren(runId, uptake.sequence).pipe(
            Effect.catchCause((cause) =>
              recoverCause(cause, "Released child retry authorization could not be recorded", undefined, { runId })
            )
          )
        }
        yield* drive(runId, uptake)
        return "resuming" as const
      })

    /**
     * Follows the journal for the control plane's resume events and re-drives
     * the parked engine execution. `Control.resume` and `Control.run`'s
     * `Resume` branch record different event types; both mean the same thing
     * here.
     */
    const resumeBridge = Effect.gen(function*() {
      const subscription = yield* journal.changes
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((entry) => entry.eventType === "control.run.resume" || entry.eventType === "control.run.resumed"),
        Stream.mapEffect(
          (entry) =>
            takeUpResume(
              entry.runId,
              (runId, uptake) => resumeExecution(runId, uptake),
              // `control.run.resume` is the operator's own claim, already taken
              // in this process by the call that journaled it; `resumed` is the
              // approval delegation, which belongs to whoever parked the run.
              entry.eventType === "control.run.resume"
                ? { _tag: "claimed", sequence: entry.seq }
                : { _tag: "delegated" }
            ),
          { concurrency: 1 }
        ),
        Stream.runDrain
      )
    }).pipe(
      Effect.catchCause(
        (cause) =>
          Effect.annotateLogs(
            Effect.logError("The executor resume bridge stopped"),
            { cause: Cause.pretty(cause) }
          )
      )
    )

    /**
     * The approval park a run is still waiting on, read from its journal: the
     * latest run approval request no decision has answered, with the question
     * it asked. The engine's own waiting row is gone by the time an
     * unrequested round asks, because claiming the round cleared it, and a
     * host that did not park the run has nothing else to re-declare it from.
     */
    const pendingApprovalWait = (runId: string) =>
      Effect.gen(function*() {
        const approvals: Array<JournalEvent.Entry> = []
        yield* scanRun(journal, runId, (entries) => {
          for (const entry of entries) if (entry.eventType.startsWith("control.approval.")) approvals.push(entry)
        })
        const pending = latestPendingApproval(approvals)
        if (pending === undefined) return undefined
        return {
          reason: pending.requestId.startsWith(budgetRequestPrefix) ? "budget" : ControlExecutor.humanWaitReason,
          token: pending.requestId,
          // The value `declaredQuestion` serializes, so the re-park writes the
          // same text the first park did.
          request: { question: pending.question }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          recoverCause(cause, "The run's approval park could not be read", undefined, { runId })
        )
      )

    /** Reads once per round; missing control evidence must not abandon a live run. */
    const controlRunBeforeRound = (runId: string) =>
      runtime.getRun(runId).pipe(
        Effect.catchCause((cause) =>
          recoverCause(cause, "The control run settlement could not be read", undefined, { runId })
        )
      )

    yield* engine.register(agentFlow, (input) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        // A fork copies the parent's input, but belongs to its own execution.
        // Never settle or send approvals to the parent named by copied data.
        const payload = { ...input, runId: instance.executionId }
        // A run the control plane has already settled is finished here without
        // being executed again.
        //
        // A launcher killed between the two settlement writes leaves the
        // engine row `suspended`/`released` with no result, and that row is
        // reclaimable by design: `RunDriver.sweepCancelRequested` wakes every
        // released row once per heartbeat, in EVERY process that opened the
        // same `engine.db`. Without this guard each of them re-enters the
        // agent body: the release validation counted ten processes replaying run-1,
        // 162 journal events against 36 for an untouched run, and a token
        // total six times the truth. Returning here records a terminal
        // result instead, which is the one write the row is missing, so the
        // next `gc` can collect it. The control row is the run's outcome of
        // record and is not rewritten.
        const controlRun = yield* controlRunBeforeRound(payload.runId)
        if (controlRun !== undefined && ["completed", "failed", "cancelled"].includes(controlRun.status)) return []
        const reclaimControl = claimForResume(payload.runId).pipe(
          // Admission and the engine claim are separate transactions. A peer
          // can acquire the control fence between them; losing that race is
          // a release, never a terminal failure that cancels this run's children.
          Effect.catchTag("/control/ClaimLost", () =>
            Effect.andThen(
              FlowRuntime.annotateWaiting({ reason: "released" }),
              Flow.suspend(instance)
            ))
        )
        // The engine follows a discarded execution through later rounds in
        // the registration scope. Such a round can start before the control
        // resume bridge runs; its previous park released the control fence.
        // Only the hosting session may reclaim that record before executing.
        //
        // The delegation is what makes a round a resume. Without it the round
        // re-entered the body of a run nobody had answered: the executor
        // claimed the park, replayed every settled frame, and suspended on the
        // same ask again, once per heartbeat, for as long as the run waited on
        // a human. `Control.approve` records the delegation before it hands
        // the decision over, so the approval a park is waiting on always
        // arrives with one; a bare `Control.resume` claims the row itself and
        // reaches this round on a status that no longer parks. An unrequested
        // round therefore has nothing to drive, and driving it anyway made the
        // incarnation that consumed the operator's decision one that had read
        // the run's durable history before the operator touched it.
        if (controlRun !== undefined && parks(controlRun.status)) {
          const pending = (yield* runtime.pendingResumes).find((entry) => entry.runId === payload.runId)
          if (
            pending === undefined ||
            !(yield* hostsPark(payload.runId, { _tag: "delegated", requestedAtMs: pending.requestedAtMs }))
          ) {
            // A trampoline poll may re-enter a parked timer before its durable
            // deadline. Keep the timer classification so the host still sees
            // the real wake; only the clock completion records a delegation.
            const clocks = controlRun.status === "parked"
              ? yield* engineState.pendingClocks({ executionId: payload.runId })
              : []
            const prior = Option.getOrUndefined(yield* engineState.waiting(payload.runId)) ??
              (yield* pendingApprovalWait(payload.runId))
            yield* FlowRuntime.annotateWaiting(waitingAnnotation(controlRun.status, clocks, prior))
            return yield* Flow.suspend(instance)
          }
          yield* reclaimControl
          // One answer buys one re-drive. The delegation is durable and only a
          // host clears it, and this round IS the host taking it up: left
          // standing it would re-drive the run's NEXT park too, which is the
          // unrequested round this guard exists to refuse. The sequence check
          // keeps a resume requested since this read.
          yield* runtime.clearResume(payload.runId, pending.sequence)
        } else if (controlRun !== undefined) {
          // A running run this process does not own is one the engine took
          // over from a host that died mid-run: it re-drives an execution only
          // after its owner's lease expired. The control record still names
          // the dead host, and every status write is fenced on it, so the run
          // is claimed here before it executes; a live owner refuses.
          const owned = yield* runtime.claimFence(payload.runId).pipe(
            Effect.as(true),
            Effect.catchTag("/control/ClaimLost", () => Effect.succeed(false))
          )
          if (!owned) yield* reclaimControl
        }
        const fiber = yield* Effect.forkChild(
          body(payload, instance).pipe(
            Effect.withSpan("smithers.run", {
              parent: runTraceParent(payload.runId),
              attributes: { "smithers.run_id": payload.runId, "gen_ai.conversation.id": payload.runId }
            }),
            Effect.onExit((exit) =>
              Effect.andThen(
                Effect.sync(() => {
                  const drive = launchedDrives.get(payload.runId)
                  if (drive !== undefined) drive.settled = true
                }),
                settle(payload.runId, instance.suspended, exit, instance.waiting?.reason)
              )
            ),
            Effect.provide(services)
          ),
          { startImmediately: true }
        )
        activeBodies.set(payload.runId, fiber)
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (activeBodies.get(payload.runId) === fiber) activeBodies.delete(payload.runId)
          }))
        )
      }).pipe(
        // Pre-body reads and control claims fail through this same boundary.
        // Preserve their typed fields in the engine's JSON settlement too.
        // `settle` still observes the body's original failure before conversion.
        Effect.mapError(settlementFailure)
      )).pipe(Scope.provide(scope))

    /**
     * Takes up every resume delegation this executor hosts, once.
     *
     * The journal's `changes` hub is an in-process `PubSub`: no other journal
     * instance can publish into it, so a decision taken in another process
     * reaches this executor through nothing at all. The delegation is durable
     * in the control database instead, and this is what reads it. Runs this
     * executor does not host are left alone with their delegation standing,
     * for the host that does — and this is the one caller that knows how long
     * one has been standing, so it is the only path by which an abandoned
     * park is ever adopted ({@link hostsPark}).
     */
    const takeUpPendingResume = (entry: PendingResume) =>
      takeUpResume(
        entry.runId,
        (runId, uptake) => Effect.asVoid(Effect.forkIn(resumeExecution(runId, uptake), scope)),
        { _tag: "delegated", requestedAtMs: entry.requestedAtMs }
      ).pipe(
        Effect.flatMap((uptake) =>
          uptake === "resuming" ? runtime.clearResume(entry.runId, entry.sequence) : Effect.void
        )
      )

    const takeUpDelegations = (wanted: (entry: PendingResume) => boolean) =>
      runtime.pendingResumes.pipe(
        Effect.flatMap((pending) => Effect.forEach(pending.filter(wanted), takeUpPendingResume, { discard: true })),
        Effect.catchCause((cause) =>
          Effect.annotateLogs(
            Effect.logWarning("A pending resume delegation could not be taken up"),
            { cause: Cause.pretty(cause) }
          )
        )
      )

    const drainPendingResumes = takeUpDelegations(() => true)

    /**
     * Takes up the delegation an answered ask has just recorded, in the call
     * that answered it.
     *
     * The record alone already reaches every host, through
     * {@link drainPendingResumes}'s poll and through the engine's own
     * post-completion round. Both are a wait, and a person who has just
     * answered something is owed the restart in the call they made, which is
     * what `ControlLive.takeUpResume` gives an approval decision. Nothing is
     * claimed that the poll would not claim: a run this executor does not host
     * is left parked with its delegation standing for the host that does.
     */
    const takeUpAnsweredPark = (runId: string) => takeUpDelegations((entry) => entry.runId === runId)

    /**
     * The durable follower: one pass, then one every second, forever.
     *
     * A second is the same bound `SqlJournal`'s own cross-process follower
     * uses to recheck the durable tail, and the same heartbeat tick the engine
     * sweeps cancellations on. Nothing here is event-driven, because rc.0 has
     * no cross-process wake (the release policy).
     */
    const pendingResumeBridge = drainPendingResumes.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(1))),
      Effect.forever
    )

    yield* Effect.forkIn(resumeBridge, scope)
    yield* Effect.forkIn(pendingResumeBridge, scope)
    // A signal recorded while this process was down has a wait point still
    // open and nobody to complete it. Replaying at start is what makes
    // `Control.signal`'s record a promise rather than a note.
    yield* Effect.forkIn(
      Effect.provide(drainRecordedSignals, services).pipe(Effect.repeat({ schedule: Schedule.spaced("250 millis") })),
      scope
    )

    const launch = (
      input: ControlExecutor.Launch
    ): Effect.Effect<ControlExecutor.Acceptance, LaunchFailed> =>
      Effect.gen(function*() {
        const flowId = input.plan.card.flowId
        const descriptor = yield* registry.getOption(flowId)
        if (Option.isNone(descriptor)) {
          // Not a flow this composition knows — a system flow, or one whose
          // registry another host holds. Pending is the honest acceptance:
          // nothing here runs it, and something else still might.
          return "pending" as const
        }
        const flowBody = yield* registry.loadBody(flowId, input.plan.card.executionDigest).pipe(
          Effect.mapError(
            (cause) =>
              new LaunchFailed({
                runId: input.run.runId,
                message: `The body of flow ${flowId} could not be loaded`,
                // The typed registry failure travels whole. `LaunchFailed.cause`
                // is `Schema.Defect`, so it carries the `RegistryError` with its
                // `_tag` and `code` intact, and an operator reading the refusal
                // can tell a deleted flow file from an unreadable one.
                // `String(cause)` flattened both to the same sentence.
                cause
              })
          )
        )
        if (flowBody._tag !== "Prompt") {
          if (Option.isNone(executables)) return "pending" as const
          const digest = yield* approvedExecution(input.run.runId, input.plan.card, descriptor.value)
          // A module whose delegate this host never registered is driven by
          // the host program that registers it, so pending is the honest
          // acceptance here too: nothing here runs it, and that program still
          // might. Every other refusal is a defect in the entry and refuses.
          if (
            executables.value.refused.some((entry) => entry.flow === flowId && entry.code === "missing_delegate")
          ) return "pending" as const
          yield* approvedModule(input.run.runId, input.plan.card, digest)
        } else {
          yield* approvedExecution(input.run.runId, input.plan.card, descriptor.value)
          const seatIds = yield* approvedSeats(input.run.runId, input.plan.card, descriptor.value)
          // Resolve the seat now, so a missing key refuses the launch as a
          // typed failure instead of failing the run after it was accepted.
          // An `auto` seat has no seat yet: Jev picks it when the run starts,
          // never here, so the launch only checks there is something to pick.
          if (seatIds[0] === Seat.auto) {
            yield* routingCatalog(input.run.runId)
          } else {
            yield* Effect.forEach(seatIds, (seatId) => seats.resolve(seatId)).pipe(
              Effect.mapError((error) =>
                new LaunchFailed({
                  runId: input.run.runId,
                  message: error.message,
                  cause: { seat: error.seat }
                })
              )
            )
          }
        }
        const start = yield* Deferred.make<void>()
        const drive: Drive = { settled: false }
        launchedDrives.set(input.run.runId, drive)
        const fiber = Effect.runForkWith(services)(
          Deferred.await(start).pipe(
            Effect.andThen(driver(input.run.runId, input.plan.card.planId)),
            // The drive is over: whatever the engine was going to record, it
            // has. Nothing may wait on this fiber after this point.
            Effect.ensuring(Effect.sync(() => {
              if (launchedDrives.get(input.run.runId) === drive) launchedDrives.delete(input.run.runId)
              driveFibers.delete(drive)
            })),
            Effect.scoped
          )
        )
        driveFibers.set(drive, fiber)
        yield* registerDriver(
          () => runtime.registerFiber(input.run.runId, fiber),
          input.run.runId
        ).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Fiber.interrupt(fiber) : Effect.void)
        )
        yield* Deferred.succeed(start, void 0)
        return "accepted" as const
      })

    return ControlExecutor.make({
      readExecution: (runId) => Effect.provide(readExecution(runId), services),
      launch: Effect.fn("AgentSession.launch")(launch),
      requestCancel: Effect.fn("AgentSession.requestCancel")((input) =>
        options.requestNativeCancel?.(input) ?? Effect.provide(requestCancel(input), services)
      ),
      deliverSignal: Effect.fn("AgentSession.deliverSignal")((input) =>
        Effect.provide(deliverSignal(input), services).pipe(
          Effect.tap((delivery) => delivery === "delivered" ? takeUpAnsweredPark(input.runId) : Effect.void)
        )
      ),
      resumeRun: Effect.fn("AgentSession.resumeRun")((input) =>
        takeUpResume(
          input.runId,
          (runId, uptake) => Effect.asVoid(Effect.forkIn(resumeExecution(runId, uptake), scope)),
          {
            _tag: "delegated"
          }
        )
      ),
      settleCancelledPark: Effect.fn("AgentSession.settleCancelledPark")((input) => settleCancelledPark(input.runId))
    })
  })

/**
 * Provides the production {@link ControlExecutor.ControlExecutor}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<ControlExecutor.ControlExecutor, never, Services> =>
  Layer.effect(ControlExecutor.ControlExecutor)(make(options))
