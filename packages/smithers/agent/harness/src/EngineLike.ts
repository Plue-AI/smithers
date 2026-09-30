/**
 * Narrow engine port consumed by the built-in harness.
 *
 * Governing contracts: `../docs/concepts.md#durable-cell-loop`,
 * `../docs/concepts.md#child-plans-and-the-splice-boundary`, and
 * `../docs/concepts.md#step-keys-and-the-model-layer`.
 *
 * @since 0.1.0
 */

import type * as KeyMaterial from "@smthrs/core/KeyMaterial"
import type * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type * as AgentEvent from "./AgentEvent.ts"
import type * as Cell from "./Cell.ts"
import { HarnessError } from "./HarnessError.ts"
import type * as Plan from "./Plan.ts"

/**
 * Stable reasons for parking a harness turn at a safe boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SuspendReasonCode = Schema.Literals([
  "permission-required",
  "waiting-quota",
  "waiting-input",
  "waiting-event",
  "engine"
])

/**
 * Stable reasons for parking a harness turn at a safe boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SuspendReasonCode = typeof SuspendReasonCode.Type

/**
 * A serializable request to park the current engine frame.
 *
 * `details` is a closed JSON value rather than `Schema.Unknown`, for the reason
 * `HarnessError`'s `cause` is a `Schema.Defect`: this value is journaled inside
 * `AgentEvent.Suspended` and served back to whatever resumes the run, so it has
 * to be something the durable exit schema can encode. `Schema.Unknown` accepts
 * a live `Error`, a function, a `BigInt`, a cycle and an accessor, and the
 * controller was in fact attaching a `Permission.PermissionRequired` — a class
 * that extends `Error` — to every permission park. What a park carries is now
 * encoded before it is attached, so the journal holds the same value a resumed
 * run decodes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class SuspendReason extends Schema.Class<SuspendReason>("flows/harness/EngineLike/SuspendReason")({
  code: SuspendReasonCode,
  message: Schema.String,
  details: Schema.optional(Schema.Json)
}) {}

/**
 * A sealed model request and the complete digest-free material declared by the
 * harness.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SealedModelStep {
  readonly request: ModelRequest.ModelRequest
  readonly keyMaterial: KeyMaterial.KeyMaterial
  /**
   * Wall-clock milliseconds one attempt at this step may spend; zero disarms.
   *
   * The budget travels on the step rather than on the engine's construction so
   * the number the controller journals as armed is the number the engine
   * enforces — one value, read from the controller's own state, and no way for
   * a run's record of its discipline to disagree with the discipline it ran
   * under.
   *
   * It is not key material and must never become key material: it says how
   * long the caller will wait, not what the model was asked, and a step keyed
   * on it would miss its cache the moment a host retuned the budget.
   */
  readonly modelCallMs?: number | undefined
}

/**
 * The durable identity of one journaled controller boundary.
 *
 * `boundary` is a deterministic label for the boundary within its frame — a
 * cell digest or a context digest — so re-executing the frame derives the same
 * identity and replays the recorded value instead of performing the read
 * again.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BoundaryIdentity {
  /** The durable session or lineage the boundary belongs to, when the loop has one. */
  readonly session?: string | undefined
  readonly frame: number
  readonly boundary: string
}

/**
 * A schema that decodes without services — the only kind a durable store can
 * reconstruct a journaled value with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DurableSchema<A> = Schema.Schema<A> & { readonly "DecodingServices": never }

/**
 * One nondeterministic read the controller must perform exactly once per run.
 *
 * The canonical example is the turn-boundary steering drain: the host queue is
 * the world, and draining it is an effect. Left unjournaled, a resumed run
 * drains an already-drained queue, rebuilds a different context than the
 * original attempt, re-keys every later sealed step, and re-executes
 * irreversible effects. Recorded through {@link EngineLike.record}, the drain
 * replays its recorded value and the resumed run converges on the original
 * attempt.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RecordBoundary<A> {
  readonly name: string
  readonly identity: BoundaryIdentity
  readonly success: DurableSchema<A>
  readonly execute: Effect.Effect<A, HarnessError>
  /** Exact call whose delivered result this existing cell-call boundary records. */
  readonly call?: Cell.Call | undefined
  /**
   * The model usage the recorded value says this boundary paid for, such as
   * an evaluator reading taken inside `execute`, one share per model.
   *
   * Read off the recorded value, never off the live call, so a replayed frame
   * reports the same spend the original attempt paid. An implementation that
   * keeps a run budget accounts it once under this boundary's key, on the
   * live pass and on replay alike, pricing each share under its model id, so
   * the next paid call is admitted against it. Declaring it declares the
   * boundary paid: unless it is {@link advisory}, such an implementation
   * admits it before `execute` under the budget's evaluator-reading policy,
   * and a refusal fails or parks the run as a primary call's would.
   * `undefined` or an empty list from it is a boundary that paid for nothing
   * this time.
   */
  // A method, so a boundary over a narrower value is still a `RecordBoundary<unknown>`.
  usage?(value: A): ReadonlyArray<Paid> | undefined
  /**
   * A paid boundary whose caller drops its failure, such as the supervisor's
   * reading in its own fiber: it is charged but never admitted, because a
   * refusal there would register a park that no frame honours. The frame's
   * next primary call applies the budget instead.
   */
  readonly advisory?: boolean | undefined
}

/**
 * One model's share of what a recorded boundary paid.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Paid {
  readonly usage: ModelEvent.Usage
  /** The model that was paid, when the reading named it: what prices the share. */
  readonly modelId?: string | undefined
}

/**
 * One measurement of the workspace the run is changing.
 *
 * The controller never interprets `digest`; it only asks whether two
 * measurements are equal. That is deliberate — the host owns what "the
 * workspace" means (which paths it covers, and what it reads off each one),
 * and the only thing the loop is entitled to conclude is "this is the tree I
 * left" or "this is not". `paths` is carried for the journal, so a reader can
 * tell an observation over 7,000 files from one over an empty root.
 *
 * `complete` is the answer to the one question that makes "this is the tree I
 * left" meaningful. A measurement that stopped at a bound covers a prefix of
 * the workspace, and a prefix cannot say that the rest of it held still — a
 * checkout larger than the host's bound would otherwise report every frame as
 * idle, and the read-only cap would fail a run that had been editing the whole
 * time. A host that does not narrow its own measurement leaves it `true`.
 *
 * @category models
 * @since 0.1.0
 */
export class Observation extends Schema.Class<Observation>("flows/harness/EngineLike/Observation")({
  /** A content address of everything the measurement covered, taken together. */
  digest: Schema.String,
  /** How many paths the measurement covered. */
  paths: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Whether the measurement covered the whole tree it was asked to measure. */
  complete: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true)),
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  )
}) {}

/**
 * One pinned tree the run can come back to.
 *
 * A checkpoint is a **value**, not a place the run goes: minting one changes
 * nothing about the workspace, and running a call against one leaves the live
 * tree exactly as it stands. That is the whole point. Before this existed, the
 * only way to answer "did this command fail before my change" was to undo the
 * change, and `sympy__sympy-13878` shows what that costs — one byte-identical
 * 4,789-character patch applied five times, four of those applications preceded
 * by `git checkout -- sympy/stats/crv_types.py`, because a clean proof required
 * reverting the very work it was meant to prove.
 *
 * `ref` is the host's own name for what it pinned — a commit id, a snapshot
 * key, whatever the store speaks. The controller never interprets it, exactly
 * as it never interprets {@link Observation.digest}; it is carried so the
 * journal says which tree a checkpointed call ran against and a grader can
 * reconcile the reading against the store by hand.
 *
 * @category models
 * @since 0.1.0
 */
export class Snapshot extends Schema.Class<Snapshot>("flows/harness/EngineLike/Snapshot")({
  /** The id the cell holds, and the id a later call names in `at`. */
  id: Schema.String,
  /** What the host recorded, in the host's own vocabulary. */
  ref: Schema.String
}) {}

/**
 * The names of the route one model request resolves to.
 *
 * Names and nothing else. A route is an endpoint, a protocol and the
 * credentials it authorizes with, and only the first two have a name a journal
 * may carry: this is read off the credential-free `Route.PreparedRequest` the
 * sealed step is keyed on, which is built before any secret is signed onto the
 * request. So there is no field here a credential could travel in.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class Binding extends Schema.Class<Binding>("flows/harness/EngineLike/Binding")({
  /** The configured route's id, as `Route.PreparedRequest.routeId` names it. */
  routeId: Schema.String,
  /** The wire protocol that route speaks, as `Route.PreparedRequest.protocolId` names it. */
  protocolId: Schema.String
}) {}

/**
 * What one model request resolves to on its way out of the host.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Resolved {
  /** The request the provider is sent, after any rewrite the host applies. */
  readonly request: ModelRequest.ModelRequest
  /** The route it goes to, or none where the host names none. */
  readonly binding: Option.Option<Binding>
}

/**
 * A request to pin the workspace as it stands right now.
 *
 * `identity` travels with it so a store *can* namespace what it writes by the
 * run that wrote it: two runs over one workspace mint `id` values from the same
 * frame-and-ordinal counter, so a store that keys on the id alone hands the
 * second run the first run's tree. `@smthrs/std/Checkpoints`'s git store keys
 * on the id alone and is right to: it also materializes at one path per id, as
 * `TestRun`'s baseline worktree does, so two concurrent runs over one workspace
 * collide on the checkout before they collide on the name. One workspace holds
 * one run — that is the assumption the whole workspace layer already makes, and
 * this field is what a store that stops making it would namespace by.
 *
 * @category models
 * @since 0.1.0
 */
export interface CaptureRequest {
  readonly id: string
  readonly identity: BoundaryIdentity
}

/**
 * The engine operations required by harness translation.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface EngineLike {
  /**
   * Runs one sealed model step.
   *
   * The harness contributes the assembled-context input, resolved layer set,
   * capability envelope, effect tier, placement, and provider-neutral
   * `ModelRequest` as core key material. The step-key contract
   * (`../docs/concepts.md#step-keys-and-the-model-layer`) requires the exact
   * wire request in the key, so route resolution happens before the key is
   * sealed. An implementation MUST therefore resolve the route, run
   * `Route.prepare` (`/model/Route`), and digest the credential-free
   * `PreparedRequest` — canonical body bytes included — together with
   * declared material into the sealed-step key before executing. A provider
   * wire change must produce a new key; credentials are signed on after the
   * digest and never enter it.
   */
  readonly sealStep: (
    step: SealedModelStep
  ) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError>
  /** Optionally emits capacity transitions while sealing the same frame. */
  readonly sealStepWithEvents?: (
    step: SealedModelStep,
    emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  ) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError>
  readonly splice: (
    batch: Plan.Batch
  ) => Stream.Stream<Plan.SpliceEvent, HarnessError>
  /**
   * Runs one flow call issued from inside a running cell.
   *
   * This is the cell path's whole effectful surface, and it is deliberately
   * one call at a time: a cell derives the second call's input from the first
   * call's result, so there is no batch to hand over. The implementation owns
   * durability — the call is a keyed, journaled activity at the tier the flow
   * declares, keyed by `call.identity` so a settled boundary replays instead of
   * re-running when the cell is re-executed after a crash or a permission park.
   *
   * A flow that fails settles as a `failure` {@link Cell.CallResult}, which the
   * cell observes as a resolved `{ ok: false, error }` envelope, not a throw.
   * It branches on `.ok === false` and `.error.code` to recover; success
   * resolves with the flow's own value, unwrapped. A permission requirement, an
   * abort, or an engine failure travels in the error channel instead, so the
   * cell never sees — and can never swallow — a park.
   */
  readonly call: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
  /**
   * Decides a call's authority before the per-call clock starts.
   *
   * A person answering an approval is not the flow running slowly, so the
   * controller asks here first and times only {@link call}. `undefined`
   * admits the call; a result is the refusal the cell reads instead, and the
   * call is never issued. A park or an engine failure travels in the error
   * channel, exactly as it does from `call`. An implementation that admits a
   * call does not ask again when that call is issued.
   */
  readonly admit?: (call: Cell.Call) => Effect.Effect<Cell.CallResult | undefined, HarnessError>
  /**
   * The host's runaway guard for timeouts, when it has one.
   *
   * A tool call or a cell that ran past its time limit is otherwise the cell's
   * to read. A host that guards timeouts parks the run on it instead, for an
   * operator's Continue or Stop, and the controller records nothing for the
   * timed-out operation, so Continue runs it again.
   */
  readonly guard?: Guard
  /**
   * Journals one nondeterministic controller read as a durable boundary.
   *
   * The controller's state is rebuilt by re-execution, so every read of the
   * world it makes between sealed steps must be recorded: the implementation
   * runs `execute` once, journals the outcome under a run-scoped key derived
   * from `name` and `identity` TOGETHER, and serves the recorded value to any
   * later re-execution of the same frame. A read that bypasses this boundary is
   * a replay divergence — and, downstream of one, duplicate irreversible
   * effects.
   *
   * `(name, identity)` is the key, and both halves are load-bearing: one frame
   * issues several records that share a session, a frame number and a boundary
   * and differ only in what they are for. An implementation that keys on
   * `identity` alone serves one frame's opening workspace measurement as its
   * closing one. The controller also folds each boundary's purpose into
   * `identity.boundary`, so it stays correct under an implementation that reads
   * the contract the other way, but an implementation must key on both.
   */
  readonly record: <A>(boundary: RecordBoundary<A>) => Effect.Effect<A, HarnessError>
  /**
   * Measures the workspace as it stands right now.
   *
   * This is what makes the loop's mutation accounting honest. Every other
   * signal the controller has about "did this frame change anything" is a
   * *declaration*: a flow's registry envelope, or the write set an invocation
   * claimed. A shell command declares neither — spawning a process is the one
   * call whose effects do not travel through any boundary the harness can
   * read — so a run whose only edits went through `bash` looked, to every
   * control, exactly like a run that did nothing. Comparing two measurements
   * around a frame answers the question from the world instead of from the
   * paperwork.
   *
   * `Option.none()` is the honest answer for a host with no workspace to
   * measure, or none it can measure cheaply. It is not an error and it is not
   * "nothing changed": the controller reads it as "unobserved" and falls back
   * to declared writes, and says in the journal which basis it used.
   *
   * The result is nondeterministic, so the controller journals it through
   * {@link EngineLike.record} rather than calling this on a replayed frame.
   */
  readonly observe: Effect.Effect<Option.Option<Observation>, HarnessError>
  /**
   * Pins the workspace as it stands right now, under the id the caller gives.
   *
   * This is the sibling of {@link EngineLike.observe} and it is deliberately a
   * different operation: `observe` answers "is this the tree I left", which
   * needs only a digest, while this has to be able to hand the tree back later.
   * The pin happens where the call happens — a cell that mints between two
   * edits gets the tree between those two edits — which is what makes
   * `ctx.checkpoint()` mean anything at the line it is written on.
   *
   * `Option.none()` is the honest answer for a host with no store to pin into,
   * exactly as it is for `observe`. It is not an error: the controller answers
   * the cell with a resolved `checkpoint_unavailable` failure, and the run
   * carries on taking its readings from the live tree.
   *
   * The result is nondeterministic, so the controller journals it through
   * {@link EngineLike.record} rather than calling this on a replayed frame.
   */
  readonly capture: (request: CaptureRequest) => Effect.Effect<Option.Option<Snapshot>, HarnessError>
  /**
   * Says what one request will actually be asked as, for the record of it.
   *
   * Two things stand between the request the controller builds and the call a
   * provider receives, and both belong to the host: a composition may rewrite
   * the request on its way out, and a route decides where it goes. The record
   * of a model call has to be of the call that was made, so the controller
   * asks here before it seals and journals the answer.
   *
   * Optional, and total where it exists. A host that rewrites nothing and
   * names no route omits it, and the controller records the request it built.
   *
   * `Option.none()` is the honest answer for a request the host cannot say
   * anything true about: its own rewrite failed, or no route accepts what the
   * rewrite produced. The controller then journals no request for that call,
   * because the only request it holds is one no provider would be sent, and a
   * record that presented it as sent would prefill a call that never
   * happened. It is not an error. The resolution that matters is the one
   * {@link EngineLike.sealStep} performs, and that is where the same request
   * fails with its typed error. A host that answers none here MUST fail that
   * sealed step, and with the failure it already met rather than a second run
   * of whatever produced it: a rewrite asked twice may answer twice.
   *
   * Pure in the request and the composition, so it is asked again on a
   * replayed frame rather than journaled: the same request under the same
   * composition resolves the same way, and a composition that has since
   * changed has changed the sealed key too, so the call it describes is a new
   * one.
   */
  readonly resolve?: (request: ModelRequest.ModelRequest) => Effect.Effect<Option.Option<Resolved>>
  readonly suspend: (reason: SuspendReason) => Effect.Effect<never, HarnessError>
}

/**
 * Context service for the harness engine boundary.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const EngineLike: Context.Service<EngineLike, EngineLike> = Context.Service(
  "@smthrs/harness/EngineLike"
)

/**
 * Constructs an engine port from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: EngineLike): EngineLike => EngineLike.of(implementation)

/**
 * The {@link Guard} subject of one cell call: its session, frame and settled
 * boundary. A host keys what the guard decided for a call (how many times the
 * operator chose Continue) by the subject the controller admits it under.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const callSubject = (identity: Pick<Cell.CallIdentity, "session" | "frame" | "cell" | "ordinal">): string =>
  JSON.stringify({
    session: identity.session,
    frame: identity.frame,
    boundary: `cell-call:${identity.cell}:${identity.ordinal}`
  })

/**
 * One operation that ran past its time limit, as the controller reports it to
 * {@link Guard.trip}.
 *
 * `subject` is the operation's replay-stable identity. `limitMillis` is
 * absent when the operation reported its own timeout without its limit.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface TimedOut {
  readonly source: "tool-call" | "cell"
  readonly subject: string
  readonly limitMillis?: number | undefined
  readonly message: string
}

/**
 * A host's runaway guard for tool-call and cell timeouts; see
 * {@link EngineLike.guard}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Guard {
  /**
   * Admits an operation before it runs. A park whose question is still open,
   * or the failure a Stop settles the run with, travels in the error channel.
   * A host re-issues a cell call the operator continued under a key of its
   * own, since the timed-out attempt may have settled durably under the old
   * one (a command's own timeout does).
   */
  readonly admit: (subject: string) => Effect.Effect<void, HarnessError>
  /**
   * Reports a timeout. Succeeds when this run's timeouts are not guarded, so
   * the caller keeps its timeout; otherwise fails with the park.
   */
  readonly trip: (timeout: TimedOut) => Effect.Effect<void, HarnessError>
}

/**
 * Provides an engine port implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: EngineLike): Layer.Layer<EngineLike> =>
  Layer.succeed(EngineLike)(make(implementation))

/**
 * What one request resolves to on this engine.
 *
 * The answer of {@link EngineLike.resolve} where the host gives one, and
 * otherwise the honest default: the request as it was built, going to no route
 * anybody named. Written once, here, because a port that wraps another port
 * needs the same default the controller does. None is the host's own answer
 * and never the default: a port with no `resolve` sends what it was handed.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const resolve = (
  engine: EngineLike,
  request: ModelRequest.ModelRequest
): Effect.Effect<Option.Option<Resolved>> =>
  engine.resolve === undefined
    ? Effect.succeed(Option.some({ request, binding: Option.none() }))
    : engine.resolve(request)

const unavailable = (operation: string, code: "engine_failed" | "suspended" = "engine_failed"): HarnessError =>
  new HarnessError({
    code,
    message: `${operation} is unavailable`
  })

/**
 * Constructs an unavailable engine stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<EngineLike> = {}): EngineLike =>
  EngineLike.of({
    sealStep: () =>
      Stream.unwrap(Effect.fn("EngineLike.sealStep")(() => Effect.succeed(Stream.fail(unavailable("sealStep"))))()),
    splice: () => Stream.fail(unavailable("splice")),
    call: Effect.fn("EngineLike.call")(() => Effect.fail(unavailable("call"))),
    record: Effect.fn("EngineLike.record")(() => Effect.fail(unavailable("record"))),
    // Unobservable rather than unavailable. A stub engine has no workspace, and
    // the honest report of that is "I measured nothing" — which the controller
    // already knows how to read. Failing here instead would turn a host that
    // simply has no tree into a failed run.
    observe: Effect.succeed(Option.none()),
    // Unpinnable for the same reason, and reported the same way: a stub engine
    // has no store to pin a tree into, and the controller reads the absence as
    // a resolved refusal the cell can route around.
    capture: () => Effect.succeed(Option.none()),
    suspend: Effect.fn("EngineLike.suspend")(() => Effect.fail(unavailable("suspend", "suspended"))),
    ...overrides
  })

/**
 * Provides an unavailable engine stub.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<EngineLike> = {}): Layer.Layer<EngineLike> =>
  Layer.succeed(EngineLike)(makeNoop(overrides))
