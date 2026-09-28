/**
 * Browser-safe port between the control plane and the execution engine, with a
 * deterministic in-memory implementation.
 *
 * `layerMemory` is the deterministic one: it models the production fence and
 * approval ordering seams but keeps everything in a `Map`, so nothing it
 * decides survives the process. The durable adapter is
 * {@link SqlControlRuntime}, and both are held to one shared contract suite —
 * see `test/ControlContract.ts`.
 *
 * @since 0.1.0
 */

import type * as PersistedPlan from "@smthrs/plan/Plan"
import { Context, Crypto, Effect, Fiber, Layer, Option, Schema } from "effect"
import * as ApprovalAuthority from "./ApprovalAuthority.ts"
import type { ApprovalTarget, PlanInput } from "./Control.ts"
import {
  AlreadyResolved,
  ClaimLost,
  type CodeDrift,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound,
  type Unauthorized
} from "./ControlError.ts"
import type {
  Envelope,
  FlowId,
  GrantScope,
  IdempotencyKey,
  PlanCard,
  PlanGraph,
  PlanNode,
  Principal,
  Receipt,
  RunId,
  RunStatus,
  RunSummary,
  SignalPayload
} from "./ControlSchema.ts"
import { GrantScope as GrantScopeSchema, Principal as PrincipalSchema } from "./ControlSchema.ts"
import { canonicalIssue } from "./internal/issues.ts"
import {
  accepted,
  adoptedCode,
  alreadyApplied as replayReceipt,
  budgeted,
  canonical,
  codeDriftOf,
  emptyEnvelope,
  planCard,
  planFingerprint,
  sameEnvelope
} from "./internal/planning.ts"
import { plannable } from "./SystemFlows.ts"

/**
 * Immutable ordering keys for a run page. Control launches precede engine runs.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunCursor {
  readonly source: 0 | 1
  readonly sequence: number
  readonly createdAt: number
  readonly runId: RunId
}

/**
 * Durable summary filters, applied before projection and executor observation.
 * `limit` must be an integer from 1 through 500. Reuse a cursor with the same filters.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunQuery {
  readonly filters?: {
    readonly flowId?: FlowId | undefined
    readonly status?: RunStatus | undefined
    readonly terminal?: boolean | undefined
    readonly parentRunId?: RunId | undefined
    readonly lineageId?: string | undefined
  } | undefined
  /** Newest creation time first; ties use the durable sequence. */
  readonly order?: "newest" | undefined
  readonly cursor?: RunCursor | undefined
  readonly limit: number
}

/**
 * A bounded page; the cursor names the last selected row, even if retention removed it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunPage {
  readonly items: ReadonlyArray<RunSummary>
  readonly nextCursor?: RunCursor | undefined
}

/**
 * One page of an inventory walk. `next` is the position to pass as `after`
 * for the following page; it is absent on the last page. `through` is the
 * highest position the walk covers: the first page pins it to the newest
 * entry at that moment, and the caller passes it back unchanged so every
 * later page stops there. A walk therefore ends even while new entries keep
 * arriving; they sort after `through` and belong to the next walk.
 *
 * @category models
 * @since 1.0.0
 */
export interface IdPage {
  readonly ids: ReadonlyArray<string>
  readonly next?: number | undefined
  readonly through: number
}

/**
 * An inventory page request. Positions are the store's insertion-ordered row
 * key, so each page is one indexed seek. `limit` must be an integer from 1
 * through 500.
 *
 * @category models
 * @since 1.0.0
 */
export interface IdPageRequest {
  readonly after?: number | undefined
  readonly through?: number | undefined
  readonly limit: number
}

/**
 * A durably admitted signal, bound at most once to one concrete wait token.
 *
 * @since 1.0.0
 * @category models
 */
export interface SignalCommand {
  readonly commandId: string
  readonly runId: RunId
  readonly signal: SignalPayload
  readonly token: string | null
  readonly state: "pending" | "delivered" | "rejected" | "terminal"
}

/**
 * A decoded input and immutable plan stored before execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface StoredPlan {
  readonly card: PlanCard
  readonly decodedInput: unknown
  readonly decision: "pending" | "approved" | "denied"
}

/**
 * The durable answer to an approval request. A decision is not inferred from
 * the presence of a grant or from a boolean that also means denial.
 *
 * @category models
 * @since 0.1.0
 */
export const ApprovalDecision = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Pending") }),
  Schema.Struct({
    _tag: Schema.Literal("Approved"),
    decisionPrincipal: PrincipalSchema,
    decidedAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    scope: GrantScopeSchema
  }),
  Schema.Struct({
    _tag: Schema.Literal("Denied"),
    decisionPrincipal: PrincipalSchema,
    decidedAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  })
])

/**
 * Durable approval state.
 * @category models
 * @since 1.0.0
 */
export type ApprovalDecision = typeof ApprovalDecision.Type

/**
 * An identity and its explicit approval decision.
 * @category models
 * @since 1.0.0
 */
export type ApprovalToken = ApprovalDecision & {
  readonly tokenId: string
  readonly target: ApprovalTarget
}

/**
 * A gate that still needs a decision.
 * @category errors
 * @since 1.0.0
 */
export class ApprovalPending extends Schema.TaggedError<ApprovalPending>()("/control/ApprovalPending", {
  tokenId: Schema.String
}) {
  override get message(): string {
    return "Approval is still pending. Wait for a decision before proceeding."
  }
}

/**
 * A gate that was denied, not merely resolved.
 * @category errors
 * @since 1.0.0
 */
export class ApprovalDenied extends Schema.TaggedError<ApprovalDenied>()("/control/ApprovalDenied", {
  tokenId: Schema.String,
  decisionPrincipal: PrincipalSchema
}) {
  override get message(): string {
    return "Approval was denied. This request cannot authorize the gated work."
  }
}

/**
 * Opens only an explicitly approved gate. Callers may park on ApprovalPending;
 * ApprovalDenied is terminal. This reads a runtime-issued token, not an
 * authentication credential, and does not itself install permissions.
 * @category combinators
 * @since 1.0.0
 */
export const requireApproved = (
  token: ApprovalToken
): Effect.Effect<Extract<ApprovalToken, { readonly _tag: "Approved" }>, ApprovalPending | ApprovalDenied> =>
  token._tag === "Approved"
    ? Effect.succeed(token)
    : token._tag === "Pending"
    ? Effect.fail(new ApprovalPending({ tokenId: token.tokenId }))
    : Effect.fail(new ApprovalDenied({ tokenId: token.tokenId, decisionPrincipal: token.decisionPrincipal }))

/**
 * One bulk permission grant. The envelope is deliberately not split into
 * individual capabilities at this boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface BulkGrant {
  readonly tokenId: string
  readonly envelope: Envelope
  readonly scope: GrantScope
  readonly installedAt: number
}

/**
 * Result of launching an approved plan.
 *
 * @category models
 * @since 0.1.0
 */
export type LaunchResult =
  | {
    readonly _tag: "Started"
    readonly receipt: Receipt
    readonly run: RunSummary
  }
  | {
    readonly _tag: "Parked"
    readonly receipt: Receipt
  }

/**
 * A plan card and whether this call is the one that created it.
 *
 * A plan under an idempotency key the runtime has already seen answers with the
 * STORED card, which is what idempotency means. `Control.plan` needs to tell
 * that apart from a first ask, because it journals `control.plan.created` and
 * an unconditional entry appended one creation per retry: `Channels.ingest`
 * passes a key on every webhook redelivery, so a watcher of the plan partition
 * replayed N creations of one plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanOutcome {
  readonly card: PlanCard
  readonly created: boolean
}

/**
 * A stored idempotency-key outcome and the mutation fingerprint that produced
 * it.
 *
 * @category models
 * @since 0.1.0
 */
export interface MutationRecord {
  readonly fingerprint: string
  readonly receipt: Receipt
}

/**
 * The outcome of claiming a run mutation's idempotency key before launch.
 *
 * `Claimed` is this call's mandate to launch: the key row was empty or did not
 * exist, and it now names this call. `Raced` is the resolution the plan verb's
 * key claim gives a loser — another mutation claimed the key first, and the
 * receipt it settled is the answer this call must return instead of launching
 * a second run.
 *
 * @category models
 * @since 0.1.0
 */
export type RunKeyClaim =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "Raced"; readonly receipt: Receipt }

/**
 * Flow metadata used by the memory runtime's input-decoding hook.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryFlow {
  readonly flowId: FlowId
  readonly description: string
  readonly deployClass: boolean
  readonly envelope: Envelope
  /** Executable source/metadata identity included in the approved card. */
  readonly executionDigest?: string | undefined
  readonly decode?: ((input: unknown) => Effect.Effect<unknown, InvalidInput>) | undefined
  /**
   * Projects the decoded input into the keyed node graph the card reports.
   *
   * Planning performs no I/O, so this is a pure function of the input: the
   * host builds the graph (`@smthrs/core`'s `Graph.build`), keys it
   * (`@smthrs/plan`'s compiler), and reports each node as `cached` or `run`
   * against whatever step cache it holds.
   */
  readonly plan?:
    | ((
      input: unknown,
      planId: string
    ) => Effect.Effect<{
      readonly plan: PersistedPlan.Plan
      readonly statuses?: Readonly<Record<string, PlanNode["status"]>> | undefined
      /** The built graph's labelled edges and declaration sites, reported outside the approval digest. */
      readonly graph?: PlanGraph | undefined
    }, InvalidInput>)
    | undefined
}

/**
 * In-memory runtime configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryOptions {
  readonly flows?: ReadonlyArray<MemoryFlow> | undefined
  readonly now?: (() => number) | undefined
  readonly principal?: Omit<Principal, "stampedAt"> | undefined
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
  /** The engine version stamped on every run this runtime starts. */
  readonly engineVersion?: string | undefined
}

/**
 * One run that has been told to resume, and the sequence of the request.
 *
 * @category models
 * @since 0.1.0
 */
export interface PendingResume {
  readonly runId: RunId
  readonly sequence: number
  /**
   * When the delegation was recorded.
   *
   * A host reads it to tell a decision it has just been handed from one that
   * has been standing unanswered: a run parked by a process that has since
   * exited has nobody left to recognize its own park, so its delegation is
   * taken up by whichever host can drive it once it has gone unanswered for
   * `Ownership.heartbeatStaleAfter` (triage B-15).
   */
  readonly requestedAtMs: number
}

/**
 * Execution-engine operations required by `ControlLive`.
 *
 * A production adapter must fence every owner-sensitive write, implement
 * resume as join-or-claim, release claims on every waiting or terminal
 * transition, and translate all conflicts into typed failures. For a new
 * approval decision, authenticate the principal and call `authorizeApproval`
 * before target reads or receipt replay. Then call `lookupApproval`,
 * `resolveApproval` exactly once with an authority recheck, `installBulkGrant`
 * only on approval, and journal the decision. Commit the decision, grant,
 * journal entry, receipt, and any node resume delegation atomically. Resolution
 * must not require an installed grant or a flushed journal decision.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** The owning host's policy, independent of authentication and attribution. */
  readonly authorizeApproval: ApprovalAuthority.Service["authorize"]
  readonly plan: (input: PlanInput) => Effect.Effect<PlanOutcome, FlowNotFound | InvalidInput | PersistenceError>
  readonly getPlan: (planId: string) => Effect.Effect<StoredPlan, PlanNotFound | PersistenceError>
  /** Plan ids in insertion order, one bounded page at a time. */
  readonly pagePlanIds: (
    request: IdPageRequest
  ) => Effect.Effect<IdPage, InvalidInput | PersistenceError>
  readonly lookupApproval: (
    target: ApprovalTarget
  ) => Effect.Effect<
    ApprovalToken,
    PlanDigestMismatch | EnvelopeMismatch | AlreadyResolved | PlanNotFound | RunNotFound | PersistenceError
  >
  /**
   * Creates the durable token for one in-run approval request, or returns the
   * existing one.
   *
   * Plan tokens are created by `plan`; nothing created tokens for `Node`
   * targets, so an in-run request (a parked `ask`, a permission requirement)
   * could never be decided through `approve`/`deny`. Registration is
   * idempotent — the executor calls it on every parked attempt — and returns
   * the token with its current tagged decision so a resumed attempt can read
   * the decision instead of parking again. A registered target that
   * disagrees with the stored digest or envelope is refused, exactly as
   * `lookupApproval` refuses it.
   */
  readonly registerApproval: (
    target: Extract<ApprovalTarget, { readonly _tag: "Node" }>
  ) => Effect.Effect<
    ApprovalToken,
    RunNotFound | PlanDigestMismatch | EnvelopeMismatch | PersistenceError
  >
  readonly installBulkGrant: (
    token: ApprovalToken,
    envelope: Envelope,
    scope: GrantScope
  ) => Effect.Effect<void, PersistenceError>
  /** Records the decision exactly once. Approval scope defaults to once; the
   * control boundary supplies the scope of the grant it installed. */
  readonly resolveApproval: (
    token: ApprovalToken,
    decision: "approved" | "denied",
    principal: Principal,
    scope?: GrantScope | undefined
  ) => Effect.Effect<void, AlreadyResolved | PersistenceError | Unauthorized>
  readonly launch: (
    planId: string,
    digest: string,
    envelope: Envelope
  ) => Effect.Effect<
    LaunchResult,
    PlanNotFound | PlanDenied | PlanDigestMismatch | EnvelopeMismatch | ClaimLost | PersistenceError
  >
  readonly getRun: (runId: RunId) => Effect.Effect<RunSummary, RunNotFound | PersistenceError>
  /**
   * Every durable run id in insertion order, one bounded page at a time, for
   * recovery and journal partition discovery. Reads keys only; use queryRuns
   * for summaries.
   */
  readonly pageRunIds: (
    request: IdPageRequest
  ) => Effect.Effect<IdPage, InvalidInput | PersistenceError>
  readonly queryRuns: (request: RunQuery) => Effect.Effect<RunPage, InvalidInput | PersistenceError>
  readonly listFlows: Effect.Effect<
    ReadonlyArray<{ readonly flowId: FlowId; readonly description: string }>,
    PersistenceError
  >
  readonly deliverSignal: (runId: RunId, signal: SignalPayload) => Effect.Effect<void, RunNotFound | PersistenceError>
  readonly admitSignal: (
    commandId: string,
    runId: RunId,
    signal: SignalPayload
  ) => Effect.Effect<void, RunNotFound | PersistenceError>
  readonly signalCommand: (commandId: string) => Effect.Effect<SignalCommand | undefined, PersistenceError>
  readonly pendingSignals: Effect.Effect<ReadonlyArray<SignalCommand>, PersistenceError>
  readonly bindSignal: (commandId: string, token: string) => Effect.Effect<string | null, PersistenceError>
  readonly settleSignal: (
    commandId: string,
    state: "delivered" | "rejected" | "terminal"
  ) => Effect.Effect<void, PersistenceError>
  readonly deliveredSignals: (
    runId: RunId
  ) => Effect.Effect<ReadonlyArray<SignalPayload>, RunNotFound | PersistenceError>
  /**
   * Records, durably, that this run has been told to resume.
   *
   * The record is the delegation. A decision on an in-run approval can be
   * taken by any process holding the control database, and only the process
   * hosting the execution can act on it, so the intent has to outlive the call
   * that made it: an in-process event bus reaches one process, and a journal
   * entry is per run and needs a reader that already knows which run to read.
   * The returned sequence is the cursor {@link Service.clearResume} checks, so
   * a resume requested while one is being taken up is not lost with it.
   *
   * A terminal run is refused with `InvalidInput`: no host will ever take the
   * delegation up, and recording it would leave an orphaned row every host's
   * `pendingResumes` poll filters but nothing ever clears.
   */
  readonly requestResume: (runId: RunId) => Effect.Effect<number, RunNotFound | InvalidInput | PersistenceError>
  /**
   * Every outstanding resume delegation for a run that is not terminal.
   *
   * This is what a host polls. A settled run's delegation is not reported: no
   * host will ever take it up, and reporting it forever would make an
   * unbounded backlog out of a run that is finished.
   */
  readonly pendingResumes: Effect.Effect<ReadonlyArray<PendingResume>, PersistenceError>
  /**
   * Clears a delegation a host has taken up, if it is still the one it read.
   *
   * The sequence check is what makes the clear safe: a resume requested
   * between the read and the clear has a higher sequence and survives, so the
   * host takes it up on its next tick instead of losing it.
   */
  readonly clearResume: (runId: RunId, sequence: number) => Effect.Effect<void, PersistenceError>
  readonly registerFiber: (
    runId: RunId,
    fiber: Fiber.Fiber<unknown, unknown>
  ) => Effect.Effect<void, RunNotFound | PersistenceError>
  /**
   * Interrupts and awaits the local fiber with no caller-held mutation locks.
   * `settle` wraps only the subsequent fenced status reconciliation, allowing
   * ControlLive to commit its terminal event in the same transaction.
   */
  readonly interrupt: (
    runId: RunId,
    settle?: (
      effect: Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
    ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  /**
   * Joins or claims a suspended run.
   *
   * `scope: "launched"` restricts claims to runs this plane launched.
   * Both `Control.resume` and `Control.run` with a Resume input, plus steer
   * wakes, pass it to preserve an engine-created run's continuation and fence.
   * `scope: "any"` (also the default) is a trusted low-level runtime
   * capability for hosts that can drive the claimed execution. Node approval
   * uses `requestResume` delegation instead of claiming here.
   */
  readonly resume: (
    runId: RunId,
    options?: {
      readonly scope?: "launched" | "any" | undefined
      /**
       * Record the flow's current execution digest and this runtime's engine
       * version on the claimed run: the operator allowed it to resume on
       * changed code, so later checks compare against that code.
       */
      readonly adoptCode?: boolean | undefined
    } | undefined
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  /**
   * The drift between the code the run recorded and the code that would
   * resume it, or `undefined` when there is none. Every path that re-drives a
   * parked run asks this before it claims or delegates; recovery paths that
   * only settle a run do not.
   */
  readonly codeDrift: (runId: RunId) => Effect.Effect<CodeDrift | undefined, RunNotFound | PersistenceError>
  readonly claimFence: (runId: RunId) => Effect.Effect<string, RunNotFound | ClaimLost | PersistenceError>
  /**
   * Releases a launch the configured executor declined without changing its
   * public `accepted` status.
   *
   * The run remains available to an external executor, but the launching
   * process no longer appears to drive it. The presented fence is spent by
   * the release and cannot authorize a later write.
   */
  readonly releasePending: (
    runId: RunId,
    fence: string
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  readonly writeStatus: (
    runId: RunId,
    fence: string,
    status: RunStatus
  ) => Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError>
  readonly stampPrincipal: (submitted?: Principal | undefined) => Effect.Effect<Principal, PersistenceError>
  readonly lookupMutation: (
    key: IdempotencyKey,
    fingerprint: string
  ) => Effect.Effect<Receipt | undefined, PersistenceError>
  readonly recordMutation: (
    key: IdempotencyKey,
    fingerprint: string,
    receipt: Receipt
  ) => Effect.Effect<void, PersistenceError>
  /**
   * Claims a run mutation's idempotency key before any launch side effect.
   *
   * This is the run verb's half of the race `control_plan_keys` closes for
   * plans: a bare `lookupMutation`/`recordMutation` pair leaves two processes
   * that both missed the lookup free to both launch, and the loser's run row
   * outlives the `recordMutation` refusal that follows. The claim must run
   * FIRST, inside the same write transaction the mutation later records its
   * receipt in, so the loser's insert conflicts on the winner's committed key
   * row before a run row, a claim, or a journal entry exists — and the winner's
   * receipt, committed in that same transaction, is already there to read.
   *
   * `Raced` carries the winner's recorded receipt verbatim, which is the
   * convergence the plan verb gives a losing planner (`created: false` with
   * the stored card). A key claimed under another fingerprint is refused with
   * `InvalidInput`, the same refusal `plan` gives a colliding key. A key row
   * whose winner never recorded — possible only when the claim and the record
   * were not one transaction — is a `PersistenceError`, because there is no
   * honest receipt to answer with.
   */
  readonly claimRunKey: (
    key: IdempotencyKey,
    fingerprint: string
  ) => Effect.Effect<RunKeyClaim, InvalidInput | PersistenceError>
  /**
   * Releases a claim {@link Service.claimRunKey} took, without a receipt.
   *
   * Exactly one path needs it: a launch that answered `Parked` created no run
   * and records no receipt, so the claim must be withdrawn inside the same
   * transaction or the key would stay held forever by a mutation that settled
   * nothing. Every other outcome either records a receipt (the claim's whole
   * point) or fails and rolls the claim back with its transaction.
   */
  readonly releaseRunKey: (key: IdempotencyKey) => Effect.Effect<void, PersistenceError>
  readonly grants: Effect.Effect<ReadonlyArray<BulkGrant>, PersistenceError>
}

/**
 * Service key for the execution-engine port.
 *
 * @category services
 * @since 0.1.0
 */
export class ControlRuntime extends Context.Service<ControlRuntime, Service>()(
  "/control/ControlRuntime"
) {}

/**
 * Constructs a runtime service from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => ControlRuntime.of(implementation)

/**
 * Refuses an id page size outside 1 through 500, the `queryRuns` bound.
 *
 * @category validation
 * @since 1.0.0
 */
export const idPageLimit = (limit: number): Effect.Effect<void, InvalidInput> =>
  Number.isSafeInteger(limit) && limit >= 1 && limit <= 500
    ? Effect.void
    : Effect.fail(new InvalidInput({ issue: "limit: must be an integer between 1 and 500" }))

/**
 * One inventory page over dense insertion positions, where `idAt` resolves a
 * position by direct lookup. Visits at most `limit` positions, so a page
 * costs and holds one page however many entries exist.
 */
const pageByPosition = (
  request: IdPageRequest,
  newest: number,
  idAt: (position: number) => string | undefined
): IdPage => {
  const through = request.through ?? newest
  const ids: Array<string> = []
  let position = request.after ?? 0
  let visited = 0
  while (position < through && visited < request.limit) {
    position += 1
    visited += 1
    const id = idAt(position)
    if (id !== undefined) ids.push(id)
  }
  return position < through ? { ids, next: position, through } : { ids, through }
}

interface MutablePlan {
  readonly card: PlanCard
  readonly decodedInput: unknown
  decision: "pending" | "approved" | "denied"
}

interface MutableToken {
  readonly tokenId: string
  readonly target: ApprovalTarget
  decision: ApprovalDecision
}

interface MutableRun {
  summary: RunSummary
  fence?: string | undefined
  localFence?: string | undefined
  fiber?: Fiber.Fiber<unknown, unknown> | undefined
  readonly sequence: number
  readonly signals: Array<SignalPayload>
  /** The sequence of the outstanding resume delegation, if there is one. */
  pendingResume?: number | undefined
  /** When that delegation was recorded. */
  pendingResumeAtMs?: number | undefined
}

// SQL persistence breaks caller reference identity through serialization. The
// memory adapter must copy at the same boundaries or its test results diverge
// from the durable implementation when a caller mutates an input or result.
const snapshot = <A>(value: A): A => structuredClone(value)

const asStored = (plan: MutablePlan): StoredPlan => ({
  card: snapshot(plan.card),
  decodedInput: snapshot(plan.decodedInput),
  decision: plan.decision
})

// JSON tuple encoding keeps caller-chosen ids in separate fields, so a node's
// request id cannot alias another run's request or a plan id.
const approvalKey = (target: ApprovalTarget): string =>
  target._tag === "Plan"
    ? JSON.stringify([target._tag, target.planId])
    : JSON.stringify([target._tag, target.runId, target.requestId])

const sameApprovalIdentity = (left: ApprovalTarget, right: ApprovalTarget): boolean =>
  left._tag === "Plan"
    ? right._tag === "Plan" && left.planId === right.planId
    : right._tag === "Node" && left.runId === right.runId && left.requestId === right.requestId

const approvalToken = (token: MutableToken): ApprovalToken => ({
  tokenId: token.tokenId,
  target: snapshot(token.target),
  ...snapshot(token.decision)
})

/**
 * Deterministic in-memory runtime. It models the production fence and approval
 * ordering seams but intentionally does not claim durable process survival;
 * see `control-runtime-engine-integration`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory = (options: MemoryOptions = {}): Layer.Layer<ControlRuntime, never, Crypto.Crypto> =>
  Layer.effect(
    ControlRuntime,
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const now = options.now ?? Date.now
      // The in-memory adapter stamps `memory`/`test` on a caller that names no
      // principal, so its default policy delegates that identity as well as
      // the local operator. Production policies never carry it.
      const approvalAuthority = options.approvalAuthority ?? (yield* ApprovalAuthority.make([
        {
          principal: { id: "local", kind: "operator" },
          scopes: ["once", "run", "remembered"],
          targets: ["Plan", "Node"]
        },
        { principal: { id: "memory", kind: "test" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
      ]).pipe(Effect.orDie))
      const authorizeApproval = approvalAuthority.authorize.bind(approvalAuthority)
      const configuredFlows = options.flows ?? plannable.map((entry): MemoryFlow => ({
        flowId: entry.flowId,
        description: `Reserved ${entry.verb} system flow`,
        deployClass: entry.deployClass,
        envelope: emptyEnvelope
      }))
      const flows = new Map(configuredFlows.map((flow) =>
        [
          flow.flowId,
          { ...flow, envelope: snapshot(flow.envelope) }
        ] as const
      ))
      const plans = new Map<string, MutablePlan>()
      const planKeys = new Map<IdempotencyKey, {
        readonly fingerprint: string
        readonly planId: string
      }>()
      const tokens = new Map<string, MutableToken>()
      const runs = new Map<RunId, MutableRun>()
      const mutations = new Map<IdempotencyKey, MutationRecord>()
      const runKeys = new Map<IdempotencyKey, { readonly fingerprint: string }>()
      const installedGrants: Array<BulkGrant> = []
      const installedGrantKeys = new Set<string>()
      let planSequence = 0
      const signalCommands = new Map<string, SignalCommand>()
      let pendingSignalOffset = 0
      let runSequence = 0
      let fenceSequence = 0
      let resumeSequence = 0

      const requireRun = (runId: RunId): Effect.Effect<MutableRun, RunNotFound> =>
        Effect.fromOption(Option.fromNullishOr(runs.get(runId)), () => new RunNotFound({ runId }))

      const updateSummary = (run: MutableRun, fields: Partial<RunSummary>): RunSummary => {
        run.summary = snapshot({ ...run.summary, ...fields, updatedAt: now() })
        return snapshot(run.summary)
      }

      const checkFence = (runId: RunId, run: MutableRun, fence: string): Effect.Effect<void, ClaimLost> =>
        run.fence === undefined || run.fence !== fence
          ? Effect.fail(new ClaimLost({ runId }))
          : Effect.void

      const service = make({
        authorizeApproval,
        plan: Effect.fn("ControlRuntime.plan")(function*(input) {
          const flow = flows.get(input.flowId)
          if (flow === undefined) return yield* new FlowNotFound({ flowId: input.flowId })
          const requestFingerprint = yield* Effect.try({
            // Validate before cloning. Canonicalization reports a throwing
            // getter at its stable path, while `structuredClone` would invoke
            // the getter first and erase that safe diagnostic.
            try: () => planFingerprint(input),
            catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
          })
          const submitted = yield* Effect.try({
            try: () => snapshot(input),
            catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
          })
          if (submitted.idempotencyKey !== undefined) {
            const prior = planKeys.get(submitted.idempotencyKey)
            if (prior !== undefined) {
              if (prior.fingerprint !== requestFingerprint) {
                return yield* new InvalidInput({
                  issue: `idempotency key ${submitted.idempotencyKey} was used for another plan`
                })
              }
              const stored = plans.get(prior.planId)
              /* v8 ignore next -- this map never loses a plan a key names; `SqlControlRuntime` covers the storage that can */
              if (stored !== undefined) return { card: snapshot(stored.card), created: false }
            }
          }
          const decoded = yield* (flow.decode?.(submitted.input) ?? Effect.try({
            try: () => {
              canonical(submitted.input)
              return submitted.input
            },
            catch: (cause) => new InvalidInput({ issue: canonicalIssue(cause) })
          }))
          const planId = `plan-${++planSequence}`
          const handoff = flow.plan === undefined ? undefined : yield* flow.plan(decoded, planId)
          const card = snapshot(
            yield* planCard({
              planId,
              flowId: submitted.flowId,
              decodedInput: decoded,
              envelope: budgeted(flow.envelope, submitted.budget),
              deployClass: flow.deployClass,
              executionDigest: flow.executionDigest,
              handoff,
              idempotencyKey: submitted.idempotencyKey
            }).pipe(Effect.provideService(Crypto.Crypto, crypto))
          )
          // Decoding, planning and hashing may yield to another keyed plan.
          // Recheck immediately before publication, with no yield between a
          // successful check and the three map writes below.
          if (submitted.idempotencyKey !== undefined) {
            const prior = planKeys.get(submitted.idempotencyKey)
            if (prior !== undefined) {
              if (prior.fingerprint !== requestFingerprint) {
                return yield* new InvalidInput({
                  issue: `idempotency key ${submitted.idempotencyKey} was used for another plan`
                })
              }
              const stored = plans.get(prior.planId)
              /* v8 ignore next -- this map never loses a plan a key names; `SqlControlRuntime` covers the storage that can */
              if (stored !== undefined) return { card: snapshot(stored.card), created: false }
            }
          }
          plans.set(planId, { card, decodedInput: snapshot(decoded), decision: "pending" })
          tokens.set(approvalKey(card.approval.target), {
            tokenId: planId,
            target: snapshot(card.approval.target),
            decision: { _tag: "Pending" }
          })
          if (submitted.idempotencyKey !== undefined) {
            planKeys.set(submitted.idempotencyKey, {
              fingerprint: requestFingerprint,
              planId
            })
          }
          return { card: snapshot(card), created: true }
        }),
        getPlan: Effect.fn("ControlRuntime.getPlan")((planId) =>
          Effect.fromOption(Option.fromNullishOr(plans.get(planId)), () => new PlanNotFound({ planId })).pipe(
            Effect.map(asStored)
          )
        ),
        pagePlanIds: Effect.fn("ControlRuntime.pagePlanIds")(function*(request) {
          yield* idPageLimit(request.limit)
          return pageByPosition(
            request,
            planSequence,
            (position) => plans.has(`plan-${position}`) ? `plan-${position}` : undefined
          )
        }),
        lookupApproval: Effect.fn("ControlRuntime.lookupApproval")(function*(target) {
          const requested = snapshot(target)
          const tokenId = requested._tag === "Plan" ? requested.planId : requested.requestId
          const token = yield* Effect.fromOption(
            Option.fromNullishOr(tokens.get(approvalKey(requested))),
            () =>
              requested._tag === "Node"
                ? new RunNotFound({ runId: requested.runId })
                : new PlanNotFound({ planId: requested.planId })
          )
          // A stored target that disagrees with its composite key is corrupted;
          // accepting only its digest and envelope would recreate the alias the
          // composite identity closes. In memory the key is DERIVED from the
          // identity, so only a caller reaching into the map can produce the
          // disagreement; `SqlControlRuntime` stores the two apart and covers
          // the same refusal against a rewritten row.
          /* v8 ignore next 6 -- unreachable while the map key is derived from the identity it is compared against */
          if (!sameApprovalIdentity(token.target, requested)) {
            return yield* new PersistenceError({
              operation: "validate an approval token",
              message: "The stored approval target does not match its identity"
            })
          }
          if (token.target.digest !== requested.digest) {
            return yield* new PlanDigestMismatch({
              planId: tokenId,
              expected: token.target.digest,
              actual: requested.digest
            })
          }
          if (!sameEnvelope(token.target.envelope, requested.envelope)) {
            return yield* new EnvelopeMismatch({
              planId: tokenId,
              expected: canonical(token.target.envelope),
              actual: canonical(requested.envelope)
            })
          }
          if (token.decision._tag !== "Pending") return yield* new AlreadyResolved({ requestId: tokenId })
          return approvalToken(token)
        }),
        registerApproval: Effect.fn("ControlRuntime.registerApproval")(function*(target) {
          const requested = snapshot(target)
          yield* requireRun(requested.runId)
          const key = approvalKey(requested)
          const existing = tokens.get(key)
          if (existing === undefined) {
            const stored: MutableToken = {
              tokenId: requested.requestId,
              target: requested,
              decision: { _tag: "Pending" }
            }
            tokens.set(key, stored)
            return approvalToken(stored)
          }
          /* v8 ignore next 6 -- as in `lookupApproval`: the map key is derived from the identity, so a stored target can only disagree with it after a reach into the map */
          if (!sameApprovalIdentity(existing.target, requested)) {
            return yield* new PersistenceError({
              operation: "validate an approval token",
              message: "The stored approval target does not match its identity"
            })
          }
          if (existing.target.digest !== requested.digest) {
            return yield* new PlanDigestMismatch({
              planId: requested.requestId,
              expected: existing.target.digest,
              actual: requested.digest
            })
          }
          if (!sameEnvelope(existing.target.envelope, requested.envelope)) {
            return yield* new EnvelopeMismatch({
              planId: requested.requestId,
              expected: canonical(existing.target.envelope),
              actual: canonical(requested.envelope)
            })
          }
          return approvalToken(existing)
        }),
        installBulkGrant: Effect.fn("ControlRuntime.installBulkGrant")((token, envelope, scope) =>
          Effect.sync(() => {
            const storedToken = snapshot(token)
            const key = approvalKey(storedToken.target)
            if (installedGrantKeys.has(key)) return
            installedGrantKeys.add(key)
            installedGrants.push({
              tokenId: storedToken.tokenId,
              envelope: snapshot(envelope),
              scope,
              installedAt: now()
            })
          })
        ),
        resolveApproval: Effect.fn("ControlRuntime.resolveApproval")(
          function*(token, decision, principal, scope = "once") {
            const requested = snapshot(token)
            const requestedPrincipal = snapshot(principal)
            const answer = yield* Schema.decodeUnknownEffect(ApprovalDecision)(
              decision === "approved"
                ? { _tag: "Approved", decisionPrincipal: requestedPrincipal, decidedAt: now(), scope }
                : { _tag: "Denied", decisionPrincipal: requestedPrincipal, decidedAt: now() }
            ).pipe(
              Effect.mapError(() =>
                new PersistenceError({
                  operation: "record an approval decision",
                  message: "The approval decision metadata is invalid"
                })
              )
            )
            yield* authorizeApproval({ principal: requestedPrincipal, target: requested.target, decision, scope })
            const mutable = tokens.get(approvalKey(requested.target))
            if (mutable === undefined || mutable.decision._tag !== "Pending") {
              return yield* new AlreadyResolved({ requestId: requested.tokenId })
            }
            mutable.decision = answer
            if (requested.target._tag === "Plan") {
              const plan = plans.get(requested.target.planId)
              /* v8 ignore next -- a plan token is only ever registered by `plan`, which stores the plan in the same call */
              if (plan !== undefined) plan.decision = decision
            }
          }
        ),
        launch: Effect.fn("ControlRuntime.launch")(function*(planId, requestedDigest, envelope) {
          const plan = yield* Effect.fromOption(
            Option.fromNullishOr(plans.get(planId)),
            () => new PlanNotFound({ planId })
          )
          if (plan.card.digest !== requestedDigest) {
            return yield* new PlanDigestMismatch({
              planId,
              expected: plan.card.digest,
              actual: requestedDigest
            })
          }
          if (!sameEnvelope(plan.card.envelope, envelope)) {
            return yield* new EnvelopeMismatch({
              planId,
              expected: canonical(plan.card.envelope),
              actual: canonical(envelope)
            })
          }
          if (plan.decision === "pending") {
            return {
              _tag: "Parked",
              receipt: {
                _tag: "Parked",
                receiptId: `launch:${planId}`,
                planId,
                status: "waiting-approval"
              }
            }
          }
          if (plan.decision !== "approved") {
            return yield* new PlanDenied({ planId })
          }
          const runId = `run-${++runSequence}`
          const fence = `fence-${++fenceSequence}`
          const timestamp = now()
          const summary: RunSummary = {
            runId,
            flowId: plan.card.flowId,
            status: "accepted",
            planId,
            planDigest: plan.card.digest,
            ...(plan.card.executionDigest === undefined ? {} : { executionDigest: plan.card.executionDigest }),
            ...(options.engineVersion === undefined ? {} : { engineVersion: options.engineVersion }),
            ownerId: "memory-owner",
            createdAt: timestamp,
            updatedAt: timestamp
          }
          runs.set(runId, {
            summary: snapshot(summary),
            fence,
            localFence: fence,
            sequence: runSequence,
            signals: []
          })
          return {
            _tag: "Started",
            receipt: accepted(`launch:${planId}:${runId}`, runId),
            run: snapshot(summary)
          }
        }),
        getRun: Effect.fn("ControlRuntime.getRun")((runId) =>
          Effect.map(requireRun(runId), (run) => snapshot(run.summary))
        ),
        pageRunIds: Effect.fn("ControlRuntime.pageRunIds")(function*(request) {
          yield* idPageLimit(request.limit)
          return pageByPosition(
            request,
            runSequence,
            (position) => runs.has(`run-${position}`) ? `run-${position}` : undefined
          )
        }),
        queryRuns: Effect.fn("ControlRuntime.queryRuns")(function*(request) {
          if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500) {
            return yield* new InvalidInput({ issue: "limit: must be an integer between 1 and 500" })
          }
          const selected: Array<MutableRun> = []
          const filters = request.filters
          const newest = request.order === "newest"
          const candidates = newest
            ? Array.from(runs.values()).sort((a, b) =>
              b.summary.createdAt - a.summary.createdAt || b.sequence - a.sequence
            )
            : runs.values()
          for (const run of candidates) {
            const after = request.cursor
            if (
              after !== undefined && (after.source !== 0 || (newest
                ? run.summary.createdAt > after.createdAt ||
                  (run.summary.createdAt === after.createdAt && run.sequence >= after.sequence)
                : run.sequence <= after.sequence))
            ) continue
            const summary = run.summary
            if (filters?.flowId !== undefined && summary.flowId !== filters.flowId) continue
            if (filters?.status !== undefined && summary.status !== filters.status) continue
            if (
              filters?.terminal !== undefined &&
              ["completed", "failed", "cancelled"].includes(summary.status) !== filters.terminal
            ) continue
            if (filters?.parentRunId !== undefined && summary.parentRunId !== filters.parentRunId) continue
            if (filters?.lineageId !== undefined && summary.lineageId !== filters.lineageId) continue
            selected.push(run)
            if (selected.length > request.limit) break
          }
          const page = selected.slice(0, request.limit)
          const last = page.at(-1)
          return {
            items: page.map((run) => snapshot(run.summary)),
            ...(selected.length <= request.limit || last === undefined ? {} : {
              nextCursor: {
                source: 0 as const,
                sequence: last.sequence,
                createdAt: last.summary.createdAt,
                runId: last.summary.runId
              }
            })
          }
        }),
        listFlows: Effect.fn("ControlRuntime.listFlows")(() =>
          Effect.sync(() =>
            Array.from(flows.values(), (flow) => ({
              flowId: flow.flowId,
              description: flow.description
            }))
          )
        )(),
        deliverSignal: Effect.fn("ControlRuntime.deliverSignal")((runId, signal) =>
          Effect.tap(requireRun(runId), (run) => Effect.sync(() => void run.signals.push(snapshot(signal))))
        ),
        admitSignal: Effect.fn("ControlRuntime.admitSignal")(function*(commandId, runId, signal) {
          yield* requireRun(runId)
          if (!signalCommands.has(commandId)) {
            signalCommands.set(commandId, snapshot({ commandId, runId, signal, token: null, state: "pending" }))
          }
        }),
        signalCommand: (commandId) => Effect.sync(() => snapshot(signalCommands.get(commandId))),
        pendingSignals: Effect.sync(() => {
          const pending = Array.from(signalCommands.values()).filter((command) => command.state === "pending")
          if (pendingSignalOffset >= pending.length) pendingSignalOffset = 0
          const page = pending.slice(pendingSignalOffset, pendingSignalOffset + 100)
          pendingSignalOffset += page.length
          return snapshot(page)
        }),
        bindSignal: (commandId, token) =>
          Effect.gen(function*() {
            const command = signalCommands.get(commandId)
            if (command === undefined) {
              return yield* new PersistenceError({
                operation: "bind signal",
                message: `No pending signal command ${commandId}`
              })
            }
            if (command.state !== "pending") return command.token
            if (
              command.token === null &&
              Array.from(signalCommands.values()).some((other) =>
                other.commandId !== commandId && other.token === token
              )
            ) return null
            const bound = command.token ?? token
            signalCommands.set(commandId, { ...command, token: bound })
            return bound
          }),
        settleSignal: (commandId, state) =>
          Effect.sync(() => {
            const command = signalCommands.get(commandId)
            if (command !== undefined && command.state === "pending") {
              signalCommands.set(commandId, { ...command, state })
            }
          }),
        deliveredSignals: Effect.fn("ControlRuntime.deliveredSignals")((runId) =>
          Effect.map(
            requireRun(runId),
            (run) =>
              snapshot([
                ...run.signals,
                ...Array.from(signalCommands.values()).filter((command) =>
                  command.runId === runId && command.state !== "rejected"
                ).map((command) => command.signal)
              ])
          )
        ),
        requestResume: Effect.fn("ControlRuntime.requestResume")(function*(runId) {
          const run = yield* requireRun(runId)
          if (
            run.summary.status === "cancelled" ||
            run.summary.status === "completed" ||
            run.summary.status === "failed"
          ) {
            return yield* new InvalidInput({
              issue: `run ${runId} is ${run.summary.status} and cannot take a resume`
            })
          }
          const sequence = ++resumeSequence
          run.pendingResume = sequence
          run.pendingResumeAtMs = now()
          updateSummary(run, { pendingResume: sequence })
          return sequence
        }),
        pendingResumes: Effect.sync(() =>
          Array.from(runs.entries()).flatMap(([runId, run]) =>
            run.pendingResume === undefined || run.pendingResumeAtMs === undefined ||
              run.summary.status === "cancelled" ||
              run.summary.status === "completed" || run.summary.status === "failed"
              ? []
              : [{ runId, sequence: run.pendingResume, requestedAtMs: run.pendingResumeAtMs }]
          )
        ),
        clearResume: Effect.fn("ControlRuntime.clearResume")((runId, sequence) =>
          Effect.sync(() => {
            const run = runs.get(runId)
            if (run === undefined || run.pendingResume !== sequence) return
            run.pendingResume = undefined
            run.pendingResumeAtMs = undefined
            updateSummary(run, { pendingResume: undefined })
          })
        ),
        registerFiber: Effect.fn("ControlRuntime.registerFiber")((runId, fiber) =>
          Effect.tap(requireRun(runId), (run) =>
            Effect.sync(() => {
              run.fiber = fiber
              fiber.addObserver(() => {
                if (run.fiber === fiber) run.fiber = undefined
              })
            }))
        ),
        interrupt: Effect.fn("ControlRuntime.interrupt")(function*(runId, settle = (effect) => effect) {
          const run = yield* requireRun(runId)
          // Terminal first, as `resume` does: a settled run released its fence,
          // and answering `ClaimLost` there would name the wrong problem.
          if (
            run.summary.status === "cancelled" ||
            run.summary.status === "completed" ||
            run.summary.status === "failed"
          ) return snapshot(run.summary)
          if (run.localFence === undefined) return yield* new ClaimLost({ runId })
          const fence = run.localFence
          yield* checkFence(runId, run, fence)
          if (run.fiber !== undefined) yield* Fiber.interrupt(run.fiber)
          return yield* settle(Effect.gen(function*() {
            // Cleanup may settle the run or release and replace its owner.
            if (
              run.summary.status === "cancelled" ||
              run.summary.status === "completed" ||
              run.summary.status === "failed"
            ) return snapshot(run.summary)
            yield* checkFence(runId, run, fence)
            run.fence = undefined
            run.localFence = undefined
            return updateSummary(run, { status: "cancelled", ownerId: undefined, parkedBy: undefined })
          }))
        }),
        codeDrift: Effect.fn("ControlRuntime.codeDrift")(function*(runId) {
          const run = yield* requireRun(runId)
          return codeDriftOf(run.summary, flows.get(run.summary.flowId), options.engineVersion)
        }),
        resume: Effect.fn("ControlRuntime.resume")(function*(runId, resumeOptions) {
          const run = yield* requireRun(runId)
          if (
            run.summary.status === "cancelled" ||
            run.summary.status === "completed" ||
            run.summary.status === "failed"
          ) return snapshot(run.summary)
          // Accepted claims are owned too; releasePending clears both fences.
          if (run.fence !== undefined) {
            /* v8 ignore next 3 -- one process holds this whole runtime, and it writes `fence` and `localFence` together; the peer this refuses exists only over a shared database, which is `SqlControlRuntime`'s fence */
            if (run.localFence === undefined || run.fence !== run.localFence) {
              return yield* new ClaimLost({ runId })
            }
            return snapshot(run.summary)
          }
          const fence = `fence-${++fenceSequence}`
          run.fence = fence
          run.localFence = fence
          // Claiming ends the park, so it ends the record of who wrote it.
          return updateSummary(run, {
            ...(resumeOptions?.adoptCode === true
              ? adoptedCode(run.summary, flows.get(run.summary.flowId), options.engineVersion)
              : {}),
            status: "accepted",
            ownerId: "memory-owner",
            parkedBy: undefined
          })
        }),
        claimFence: Effect.fn("ControlRuntime.claimFence")(function*(runId) {
          const run = yield* requireRun(runId)
          if (run.localFence === undefined) return yield* new ClaimLost({ runId })
          return run.localFence
        }),
        releasePending: Effect.fn("ControlRuntime.releasePending")(function*(runId, fence) {
          const run = yield* requireRun(runId)
          yield* checkFence(runId, run, fence)
          run.fence = undefined
          run.localFence = undefined
          return updateSummary(run, {
            status: "accepted",
            ownerId: undefined,
            parkedBy: undefined
          })
        }),
        writeStatus: Effect.fn("ControlRuntime.writeStatus")(function*(runId, fence, status) {
          const run = yield* requireRun(runId)
          yield* checkFence(runId, run, fence)
          // Ownership is released by any status that is not being driven, so the
          // fence that wrote a terminal or parked status is spent by writing it.
          if (status === "accepted" || status === "running") {
            return updateSummary(run, { status, parkedBy: undefined })
          }
          run.fence = undefined
          run.localFence = undefined
          // The spent fence is kept on a park, and only on a park: it is the
          // only thing left on the row that says which host parked it.
          return updateSummary(run, {
            status,
            ownerId: undefined,
            parkedBy: status === "parked" || status === "waiting-approval" ? fence : undefined
          })
        }),
        // Precedence matches `SqlControlRuntime`: the submitted identity is
        // the one a server authenticated, and the configured one is this
        // composition's fallback for a caller that named none.
        stampPrincipal: Effect.fn("ControlRuntime.stampPrincipal")((submitted) =>
          Effect.sync(() => ({
            id: submitted?.id ?? options.principal?.id ?? "memory",
            kind: submitted?.kind ?? options.principal?.kind ?? "test",
            stampedAt: now()
          }))
        ),
        lookupMutation: Effect.fn("ControlRuntime.lookupMutation")((key, fingerprint) =>
          Effect.sync(() => {
            const record = mutations.get(key)
            if (record === undefined) return undefined
            return record.fingerprint === fingerprint
              ? replayReceipt(key, record.receipt)
              : { _tag: "Conflict", message: `idempotency key ${key} was used for another mutation` }
          })
        ),
        recordMutation: Effect.fn("ControlRuntime.recordMutation")((key, fingerprint, receipt) =>
          Effect.gen(function*() {
            const prior = mutations.get(key)
            if (
              prior !== undefined &&
              (prior.fingerprint !== fingerprint || canonical(prior.receipt) !== canonical(receipt))
            ) {
              return yield* Effect.fail(
                new PersistenceError({
                  operation: "record a mutation",
                  message: `Idempotency key ${key} was already settled by another mutation`
                })
              )
            }
            mutations.set(key, { fingerprint, receipt: snapshot(receipt) })
          })
        ),
        claimRunKey: Effect.fn("ControlRuntime.claimRunKey")(function*(key, fingerprint) {
          const holder = runKeys.get(key)
          if (holder !== undefined) {
            if (holder.fingerprint !== fingerprint) {
              return yield* new InvalidInput({
                issue: `idempotency key ${key} was used for another run`
              })
            }
            const record = mutations.get(key)
            if (record === undefined) {
              // One process owns this runtime, so reaching here takes a caller
              // that claimed and never recorded: the cross-process winner this
              // branch really models commits both in one transaction, which is
              // `SqlControlRuntime`'s seam.
              return yield* new PersistenceError({
                operation: "read a mutation",
                message: `run key ${key} was claimed by a mutation that recorded no receipt`
              })
            }
            return { _tag: "Raced" as const, receipt: snapshot(record.receipt) }
          }
          runKeys.set(key, { fingerprint })
          return { _tag: "Claimed" as const }
        }),
        releaseRunKey: Effect.fn("ControlRuntime.releaseRunKey")((key) =>
          Effect.sync(() => {
            runKeys.delete(key)
          })
        ),
        grants: Effect.fn("ControlRuntime.grants")(() => Effect.sync(() => snapshot(installedGrants)))()
      })
      return service
    })
  )
