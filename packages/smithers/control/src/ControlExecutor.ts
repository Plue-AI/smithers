/**
 * Acceptance port from the control plane into a real run executor.
 *
 * Governing contract: `docs/pages/control/index.md`.
 *
 * @since 0.1.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import type { ExecutionFact } from "@smthrs/journal"
import { Context, Effect, Layer } from "effect"
import type { LaunchFailed, PersistenceError } from "./ControlError.ts"
import type { StoredPlan } from "./ControlRuntime.ts"
import type { ApprovalTarget, PendingWait, RunId, RunSummary, SignalPayload } from "./ControlSchema.ts"

/**
 * One stored plan and the run summary it is being started as.
 *
 * @category models
 * @since 0.1.0
 */
export interface Launch {
  readonly plan: StoredPlan
  readonly run: RunSummary
}

/**
 * Whether the executor took the launch now or queued it.
 *
 * @category models
 * @since 0.1.0
 */
export type Acceptance = "accepted" | "pending"

/**
 * One run whose cancellation has to become durable on the engine row.
 *
 * @category models
 * @since 0.1.0
 */
export interface CancelRequest {
  readonly runId: RunId
}

/**
 * The engine row a cancel request arrived too late for.
 *
 * It carries the ENGINE's status rather than a bare marker because the control
 * plane cannot read that row: in the shipped CLI the two `flows_runs` tables
 * live in two files (`.flows/control.db` and `.flows/engine.db`), so the port
 * is the only place the plane learns what actually became of the run.
 *
 * @category models
 * @since 0.1.0
 */
export interface CancelTerminal {
  readonly _tag: "Terminal"
  readonly status: "completed" | "failed" | "cancelled"
}

/**
 * What the executor did with a cancel request.
 *
 * `recorded` means THIS call set `cancel_requested_at_ms` on the engine row, so
 * the owning process stops the run at its next cancel poll whichever process
 * asked. `already-requested` means the column was already set when this call
 * arrived: the request is just as durable, and the cancellation it belongs to
 * was somebody else's. `Control.cancel` keys its attribution event on that
 * difference — the write is first-writer-wins and every repeat re-runs the
 * whole mutation, so answering `recorded` to all of them left one journaled
 * `control.run.cancel-requested` per ask for a single cancellation (release validation
 * smoke: three `cancel` calls and one `down` against one parked run left four).
 * `unknown` means this executor's engine has no row for the run at all, which
 * is the honest answer for a run another composition launched into a database
 * this one does not share. A {@link CancelTerminal} means the engine row has
 * already settled, so there is nothing left to stop: recording intent on it
 * would be a request no process can ever act on, and answering `recorded` let
 * `Control.cancel` write a terminal control status the engine row does not have
 * (triage B-11).
 *
 * @category models
 * @since 0.1.0
 */
export type CancelRecord = "recorded" | "already-requested" | "unknown" | CancelTerminal

/**
 * One parked run that has been told to resume.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResumeRequest {
  readonly runId: RunId
}

/**
 * What the executor did with a resume request.
 *
 * `resuming` means this executor hosts the run's execution, has taken the
 * control row's fence, and is re-driving it: the caller can stop, and the run
 * moves on its own. `unknown` means this executor drives no execution for the
 * run, which is the answer an operator's CLI, a gateway, or any second process
 * gives, and it is why the control plane records the delegation durably
 * instead of treating its own journal entry as the delivery (triage B-15).
 *
 * @category models
 * @since 0.1.0
 */
export type ResumeUptake = "resuming" | "unknown"

/**
 * One signal to deliver to a run's open wait point.
 *
 * @category models
 * @since 0.1.0
 */
export interface Signal {
  /** Actor-scoped durable admission identity, present on control-plane delivery. */
  readonly commandId?: string
  /** An existing immutable binding survives a crash before acknowledgment. */
  readonly token?: string | null
  readonly runId: RunId
  readonly signal: SignalPayload
}

/**
 * What the executor did with a signal.
 *
 * `delivered` means the `WaitFor` deferred the run is parked on was completed
 * with the signal's payload and the run was woken. `no-match` means the run IS
 * parked and is waiting for something else, which `Control.signal` refuses
 * rather than recording a delivery nothing consumes. `unknown` means this
 * executor is driving no execution for the run at all — another process may
 * be, or none is yet — so the recorded message is the whole delivery and the
 * executor that eventually drives the run replays it at its next start.
 *
 * @category models
 * @since 0.1.0
 */
export type SignalDelivery = "delivered" | "no-match" | "unknown"

/**
 * Current engine observation. Missing execution is distinct from a running one.
 * @category models
 * @since 1.0.0
 */
export type ExecutionObservation =
  | { readonly _tag: "Missing" }
  | {
    readonly _tag: "Observed"
    readonly executionView?: ExecutionFact.View | undefined
    readonly status: "accepted" | "running" | "parked" | "waiting-approval" | "completed" | "failed" | "cancelled"
    readonly waitingReason?: string | undefined
    readonly parentRunId?: string | undefined
    readonly lineageId?: string | undefined
    readonly roundOrdinal?: number | undefined
    /**
     * Open human waits anywhere in this execution's tree.
     *
     * The control plane cannot compute these. It keeps its own coordination
     * copy of `flows_runs`, and the executions a flow spawns — where a nested
     * `HumanTask` actually parks — exist only in the executor's database, with
     * the edges that link them. `readExecution` is the one place that reads
     * both, so it is where a run tree's open questions become visible to
     * anything else.
     *
     * Absent when nothing in the tree is waiting on a person. `status` rolls
     * up with them: an execution parked while a descendant holds a human wait
     * is observed as `waiting-approval`.
     */
    readonly pendingWaits?: ReadonlyArray<PendingWait> | undefined
  }

/**
 * The waiting reason a human wait parks under.
 *
 * `HumanTask` and the agent's own `ask` both declare it
 * (`@smthrs/flow` `FlowRuntime.annotateWaiting({ reason: "approval" })`), so
 * it is the one value that separates "somebody has to answer this" from every
 * other park.
 *
 * @category models
 * @since 1.0.0
 */
export const humanWaitReason = "approval"

/**
 * The wait point a durable token addresses, as a person reads it.
 *
 * A `HumanTask` attempt is its own wait point named `WaitFor/<task>#<attempt>`
 * (`@smthrs/flow` `HumanTask`), and a plain `WaitFor` gate is `WaitFor/<name>`.
 * Splitting the two out of the token is what lets a client address an answer by
 * the name a person was asked under rather than by a base64 blob, and lets an
 * inbox say which of three attempts is open.
 *
 * A token this plane cannot parse names nothing extra; the token itself still
 * travels, so the wait stays answerable.
 */
const waitPointOf = (token: string): { readonly name?: string; readonly attempt?: number } => {
  let decoded: unknown
  try {
    decoded = JSON.parse(globalThis.atob(token))
  } catch {
    return {}
  }
  const deferredName = Array.isArray(decoded) && typeof decoded[2] === "string" ? decoded[2] : undefined
  if (deferredName === undefined || !deferredName.startsWith("WaitFor/")) return {}
  const point = deferredName.slice("WaitFor/".length)
  const marker = point.lastIndexOf("#")
  if (marker < 0) return { name: point }
  const attempt = Number(point.slice(marker + 1))
  return Number.isSafeInteger(attempt) && attempt > 0
    ? { name: point.slice(0, marker), attempt }
    : { name: point }
}

/**
 * One parked execution as a {@link PendingWait}, or nothing when it is not a
 * wait a person can end.
 *
 * Shared by the two readers that produce these rows — the control plane's own
 * SQL runtime, when it shares a database with the engine, and the executor's
 * observation port, when it does not — so a wait reads the same either way.
 *
 * @category constructors
 * @since 1.0.0
 */
export const pendingWaitOf = (row: {
  readonly runId: string
  readonly flowId?: string | undefined
  readonly reason: string
  readonly token: string | null | undefined
  readonly request?: unknown
  readonly createdAt: number
}): PendingWait | undefined => {
  if (row.reason !== humanWaitReason || row.token === null || row.token === undefined) return undefined
  return {
    runId: row.runId,
    reason: row.reason,
    token: row.token,
    tokenDigest: Sha256.digestSync(row.token),
    createdAt: row.createdAt,
    ...(row.flowId === undefined ? {} : { flowId: row.flowId }),
    ...waitPointOf(row.token),
    ...(row.request === undefined ? {} : { request: row.request as PendingWait["request"] })
  }
}

/**
 * The wait a `Node` approval target addresses, when it addresses one.
 *
 * Most gates are a capability the run wants allowed: the target's `digest` is
 * the request's own digest, a decision grants or refuses it, and the control
 * plane holds a registered token for it. A `HumanTask` gate has no such token
 * — nothing registers one, because the run parked itself on a durable wait
 * rather than asking the control plane for permission — and `lookupApproval`
 * answers a target with no token by reporting the RUN as missing. That is what
 * an operator saw when the app submitted an answer as an ordinary approval:
 * `/control/RunNotFound` naming a run that was listed, rendered, and waiting
 * (workspace 4bb93306, run-1).
 *
 * So a decision has to be able to tell the two apart from the payload alone.
 * The approvals projection publishes a human wait with the durable wait token
 * as the `digest` and the wait point's own name as the `requestId`, and a
 * durable deferred token is self-describing: it decodes to a flow, an
 * execution, and a deferred name under `WaitFor/`. Nothing else produces one,
 * so a target carrying one is a question, and the name it answers is right
 * there.
 *
 * @category constructors
 * @since 1.0.0
 */
export const answerableWait = (
  target: ApprovalTarget
): { readonly name: string; readonly token: string } | undefined => {
  if (target._tag !== "Node") return undefined
  const point = waitPointOf(target.digest)
  return point.name === undefined ? undefined : { name: target.requestId, token: target.digest }
}

/**
 * The executor port: the control plane hands work over to a real run executor
 * and learns only what the executor did with it.
 *
 * `launch` is acceptance. `requestCancel`, `deliverSignal`, and `resumeRun`
 * are the three requests that have to reach the engine to mean anything: a
 * cancel is durable on the engine row so that whichever process owns the run
 * stops it, a signal completes the wait point a parked run is actually waiting
 * on, and a resume re-drives the execution an approval decision unblocked.
 * Without them the control plane records facts nobody reads — a cancel that
 * answers `ClaimLost` to every process but the owner, a signal a parked run
 * never sees, and a resume event published into an in-process hub no other
 * process subscribes to (the release policy; triage B-10, B-13, B-15).
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  /** Read from the executor's database, never the control coordination copy. */
  readonly readExecution?: (runId: RunId) => Effect.Effect<ExecutionObservation, PersistenceError>
  readonly launch: (input: Launch) => Effect.Effect<Acceptance, LaunchFailed>
  /**
   * Records a cancellation on the engine row, durably, regardless of which
   * process owns the run.
   */
  readonly requestCancel: (input: CancelRequest) => Effect.Effect<CancelRecord, PersistenceError>
  /**
   * Completes the run's open `WaitFor` wait point with the signal's payload.
   */
  readonly deliverSignal: (input: Signal) => Effect.Effect<SignalDelivery, PersistenceError>
  /**
   * Takes up a resume: claims the control row and re-drives the execution,
   * when this executor is the one hosting it.
   */
  readonly resumeRun: (input: ResumeRequest) => Effect.Effect<ResumeUptake, PersistenceError>
  /**
   * Finishes a PARKED execution whose cancellation is already durable.
   *
   * A park has no owner — that is what makes it resumable — so nothing is
   * driving the run and nothing reads the request {@link requestCancel} wrote.
   * The engine's parked-run sweep does, once per heartbeat, but a `smithers
   * cancel` process writes the request at the very end of its life and exits
   * before that tick: the release validation watched an engine row stay
   * `suspended` with `cancel_requested_at_ms` set through six more commands
   * and fifteen seconds, so `gc` collected the run in `control.db` and
   * skipped it in `engine.db`.
   *
   * Called AFTER the cancel mutation commits, never inside it: driving a run
   * re-enters the engine, whose writes would wait on the writer the
   * mutation's transaction holds. An executor that does not host the run, or
   * one whose run is not parked, does nothing and leaves the durable request
   * standing for the host that does.
   */
  readonly settleCancelledPark: (input: CancelRequest) => Effect.Effect<void, PersistenceError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class ControlExecutor extends Context.Service<ControlExecutor, Service>()(
  "/control/ControlExecutor"
) {}

/**
 * Builds a {@link Service} from an implementation of its methods.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => ControlExecutor.of(implementation)

/**
 * A {@link Service} that accepts every launch as `pending` and starts
 * nothing. Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    launch: Effect.fn("ControlExecutor.launch")(() => Effect.succeed("pending" as const)),
    // An executor that starts nothing owns no engine row and no wait point, so
    // it records no cancel and matches no signal. `Control.cancel` still writes
    // its journal entry and interrupts a local fiber, and `Control.signal`
    // still records the message: both are what the port's absence already did.
    requestCancel: Effect.fn("ControlExecutor.requestCancel")(() => Effect.succeed("unknown" as const)),
    deliverSignal: Effect.fn("ControlExecutor.deliverSignal")(() => Effect.succeed("unknown" as const)),
    resumeRun: Effect.fn("ControlExecutor.resumeRun")(() => Effect.succeed("unknown" as const)),
    settleCancelledPark: Effect.fn("ControlExecutor.settleCancelledPark")(() => Effect.void),
    ...overrides
  })

/**
 * Provides {@link ControlExecutor} from an implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: Service): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(make(implementation))

/**
 * The same executor with the two methods that drive a run refused.
 *
 * A host composed to observe runs rather than drive them has no completion
 * judge, so it must not be able to start or resume one: without this a verb
 * misclassified as a read would admit a run and lose it at its first
 * completion, which is the outcome the boot-time judge requirement exists to
 * prevent. Reaching either method is a composition defect, not an operator
 * error, so it dies rather than failing.
 *
 * Observation, cancellation and signal delivery stay live. A cancel and a
 * signal record a durable request that the process driving the run picks up,
 * so none of them reaches a completion, and refusing them would stop an
 * operator ending a run on a host with no gateway key, which is the whole
 * reason a read host exists.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeObserving = (service: Service): Service => {
  const refuse = (method: string) =>
    Effect.die(
      new Error(
        `This host observes runs and drives none, so ControlExecutor.${method} is unreachable on it. ` +
          "Compose it with startsRuns to start or resume a run."
      )
    )
  return make({
    ...service,
    launch: Effect.fn("ControlExecutor.launch")(() => refuse("launch")),
    resumeRun: Effect.fn("ControlExecutor.resumeRun")(() => refuse("resumeRun"))
  })
}

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(makeNoop(overrides))
