/**
 * In-process Control implementation over `ControlRuntime`, the flow
 * registry, and the append-only journal.
 *
 * @since 0.1.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import { Journal, JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
import { Registry } from "@smthrs/registry"
import { inputDocument } from "@smthrs/registry/Descriptor"
import { Cause, Effect, Exit, Layer, Option, Schema, Semaphore, Stream } from "effect"
import * as Cancellation from "./Cancellation.ts"
import {
  type ApprovalInput,
  Control,
  type RunMutationInput,
  type Service,
  type SignalInput,
  type SteerInput
} from "./Control.ts"
import {
  ClaimLost,
  type ControlError,
  type EnvelopeMismatch,
  InvalidInput,
  type LaunchFailed,
  NoMatchingWait,
  PersistenceError,
  type PlanDenied,
  type PlanDigestMismatch,
  type PlanNotFound,
  type RunNotFound,
  Unavailable
} from "./ControlError.ts"
import type { CancelRecord, Launch } from "./ControlExecutor.ts"
import { ControlExecutor } from "./ControlExecutor.ts"
import * as ControlFacts from "./ControlFacts.ts"
import { ControlRuntime, type RunPage } from "./ControlRuntime.ts"
import type {
  ControlEvent,
  FireSummary,
  IdempotencyKey,
  ListRequest,
  ListResponse,
  Receipt,
  RunId,
  RunSummary,
  TriggerSummary,
  WatchFilter
} from "./ControlSchema.ts"
import {
  ApprovalInputSchema,
  defaultPageSize,
  maxPageSize,
  Principal,
  ReasonedMutationInputSchema,
  RunInputSchema,
  SignalInputSchema,
  SteerInputSchema,
  steerItem,
  WatchCursor
} from "./ControlSchema.ts"
import * as DispatchReader from "./DispatchReader.ts"
import { schemaIssuePath } from "./internal/issues.ts"
import * as MutationBoundary from "./internal/MutationBoundary.ts"
import { alreadyApplied, canonical } from "./internal/planning.ts"
import * as Lineage from "./Lineage.ts"
import * as Steering from "./Steering.ts"

const sourceId = JournalEvent.SourceId.make("/control")

const snapshotPageSize = 1024
const snapshotPartitionConcurrency = 8

const unavailable = (feature: string): Unavailable =>
  new Unavailable({ feature, ticket: "control-runtime-engine-integration" })

/**
 * What a failed journal read during `watch` answers.
 *
 * A closed journal means this composition has no journal to watch, so the
 * feature is unavailable. Any other code is a storage failure and keeps its
 * cause, so the operator sees what the journal reported.
 */
const watchReadFailed = (cause: Journal.JournalError): Unavailable | PersistenceError =>
  cause.code === "journal_closed"
    ? unavailable("watch")
    : new PersistenceError({
      operation: "watch",
      message: `Reading the control journal failed (${cause.code})`,
      cause
    })

const accepted = (key: IdempotencyKey, runId?: RunId): Receipt =>
  runId === undefined
    ? { _tag: "Accepted", receiptId: key }
    : { _tag: "Accepted", receiptId: key, runId }

const terminal = (status: RunSummary["status"]): boolean =>
  status === "cancelled" || status === "completed" || status === "failed"

/**
 * Whether a status means a process is holding the run right now.
 *
 * `accepted` is what a claim writes, and nothing rewrites it until the run
 * settles: only `Control.run` promotes a run to `running`, and only when its
 * own executor took the launch. A run restarted by `Control.resume` or by an
 * approval therefore spends its whole second life `accepted`. Both statuses
 * project onto the store's `running` (`SqlControlRuntime`'s `storeStatus`), so
 * a lost claim against either one means a live peer owns the row — which
 * release policy 5.1 answers `ClaimLost`. Asking for the literal `running` alone
 * answered `Accepted` for a peer's accepted run and hid the peer.
 */
const live = (status: RunSummary["status"]): boolean => status === "running" || status === "accepted"

const terminalOrAccepted = (
  key: IdempotencyKey,
  run: RunSummary
): Receipt =>
  terminal(run.status)
    ? { _tag: "Terminal", runId: run.runId, status: run.status }
    : accepted(key, run.runId)

/**
 * The two paths a SERVER stamps a principal onto, and the only two an
 * idempotency fingerprint may ignore.
 *
 * `ControlServer` overwrites `input.principal` and `input.message.principal`
 * with the identity it authenticated, and the stamp carries a wall clock, so
 * keeping either made the second `smithers cancel` of one run look like a
 * different mutation under the same key: a bearer-authenticated retry answered
 * `Conflict` instead of the cancel's own receipt.
 *
 * Nothing else named `principal` is stamped. The previous replacer dropped the
 * key at EVERY depth, so two signals whose payloads differed only in a nested
 * `principal` collided under one key and the second payload was never
 * delivered.
 */
const withoutStampedPrincipal = (input: unknown): unknown => {
  /* v8 ignore next -- every caller passes a mutation the boundary already decoded into a struct; the guard keeps the helper total for a reader */
  if (input === null || typeof input !== "object") return input
  const { principal: _principal, ...rest } = input as Record<string, unknown>
  const message = rest["message"]
  if (message === null || typeof message !== "object") return rest
  const { principal: _messagePrincipal, ...messageRest } = message as Record<string, unknown>
  return { ...rest, message: messageRest }
}

/**
 * What an idempotency key is bound to: one actor's stated intent.
 *
 * The input has already crossed the inert boundary. The principal's stable id
 * and kind remain in the document while its server clock is omitted, and the
 * canonical bytes are reduced to one fixed-size durable digest.
 */
const fingerprint = (operation: string, principal: typeof Principal.Type | undefined, input: unknown): string =>
  `control-mutation:v2:${
    Sha256.digestSync(canonical({
      operation,
      actor: principal === undefined ? null : { id: principal.id, kind: principal.kind },
      intent: withoutStampedPrincipal(input)
    }))
  }`

/** Namespaces a caller key when an authenticated actor is available. */
const mutationKey = (
  operation: string,
  key: IdempotencyKey,
  principal: typeof Principal.Type | undefined
): string =>
  principal === undefined
    ? `${operation}:${key}`
    : `${operation}:actor:${Sha256.digestSync(canonical({ id: principal.id, kind: principal.kind }))}:${key}`

const json = (value: unknown): ControlEvent["payload"] => JSON.parse(JSON.stringify(value)) as ControlEvent["payload"]

const invalid = (issue: string): InvalidInput => new InvalidInput({ issue })

const AttributedApprovalInput = Schema.Struct({
  ...ApprovalInputSchema.fields,
  principal: Schema.optional(Principal)
})
const AttributedReasonedMutationInput = Schema.Struct({
  ...ReasonedMutationInputSchema.fields,
  principal: Schema.optional(Principal)
})
const AttributedRunInput = Schema.Union([
  Schema.Struct({ ...RunInputSchema.members[0].fields, principal: Schema.optional(Principal) }),
  Schema.Struct({ ...RunInputSchema.members[1].fields, principal: Schema.optional(Principal) })
])
const AttributedSignalInput = Schema.Struct({
  ...SignalInputSchema.fields,
  principal: Schema.optional(Principal)
})

// The surrogate scan restates, at the point the DURABLE KEY is formed, what
// `MutationBoundary.admit` already refused: a lone surrogate is not a string
// SQLite and JSON round-trip identically, and this value is a primary key. The
// two refusing arms are therefore unreachable through every caller, and stay
// as the local invariant rather than as a check somebody may delete upstream.
const validIdempotencyKey = (value: string): boolean => {
  if (value.length === 0 || value.length > 1024 || value.includes("\0")) return false
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      /* v8 ignore next -- an unpaired high surrogate is refused by the mutation boundary first */
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
      continue
    }
    /* v8 ignore next -- a lone low surrogate is refused by the mutation boundary first */
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Admits, schema-decodes, and detaches one mutation before its first wait. */
const snapshotMutation = <A extends { readonly idempotencyKey: string }>(
  operation: string,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  input: unknown
): Effect.Effect<A, InvalidInput> =>
  Effect.suspend(() => {
    const admitted = MutationBoundary.admit(input)
    if (!admitted.ok) return Effect.fail(invalid(`${operation}: ${admitted.complaint}`))
    return decode(admitted.value).pipe(
      Effect.mapError((error) => invalid(`${operation}: invalid mutation at ${schemaIssuePath(error)}`)),
      Effect.flatMap((snapshot) =>
        validIdempotencyKey(snapshot.idempotencyKey)
          ? Effect.succeed(snapshot)
          : Effect.fail(invalid(`${operation}.idempotencyKey: must be 1 to 1024 well-formed characters`))
      )
    )
  })

const snapshotApproval = (operation: string, input: unknown) =>
  snapshotMutation(operation, Schema.decodeUnknownEffect(AttributedApprovalInput), input)
const snapshotReasonedMutation = (operation: string, input: unknown) =>
  snapshotMutation(operation, Schema.decodeUnknownEffect(AttributedReasonedMutationInput), input)
const snapshotRun = (input: unknown) => snapshotMutation("run", Schema.decodeUnknownEffect(AttributedRunInput), input)
const snapshotSignal = (input: unknown) =>
  snapshotMutation("signal", Schema.decodeUnknownEffect(AttributedSignalInput), input)
const snapshotSteer = (input: unknown) => snapshotMutation("steer", Schema.decodeUnknownEffect(SteerInputSchema), input)

/**
 * Refuses a page size or cursor that cannot make progress.
 *
 * A `limit` of zero, a negative or fractional one, `NaN`, and `Infinity` all
 * used to answer `{ items: [], nextCursor: String(start) }`, which is a cursor
 * a client loops on forever; an unparsable cursor silently restarted at the
 * first page. Both are caller mistakes, and a control plane that answers a
 * mistake with a plausible-looking page is the partial behaviour rc.0 forbids.
 * `ControlSchema.PageLimit` refuses the same sizes on the wire; this is the
 * in-process half, which no schema decodes.
 */
const pageBounds = (
  cursor: string | undefined,
  limit: number | undefined
): Effect.Effect<{ readonly start: number; readonly size: number }, InvalidInput> => {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize)) {
    return Effect.fail(
      invalid(`limit: must be an integer between 1 and ${maxPageSize}, received ${String(limit)}`)
    )
  }
  if (cursor === undefined) return Effect.succeed({ start: 0, size: limit ?? defaultPageSize })
  const start = Number(cursor)
  return Number.isSafeInteger(start) && start >= 0
    ? Effect.succeed({ start, size: limit ?? defaultPageSize })
    : Effect.fail(invalid(`cursor: must be a cursor this listing returned, received ${JSON.stringify(cursor)}`))
}

const cursorNatural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const runCursor = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  filters: Schema.String,
  source: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
  sequence: cursorNatural,
  createdAt: cursorNatural,
  runId: Schema.NonEmptyString
}))

const page = <A>(
  values: ReadonlyArray<A>,
  bounds: { readonly start: number; readonly size: number }
): { readonly items: ReadonlyArray<A>; readonly nextCursor?: string | undefined } => {
  const items = values.slice(bounds.start, bounds.start + bounds.size)
  const next = bounds.start + items.length
  return next < values.length ? { items, nextCursor: String(next) } : { items }
}

const eventFromEntry = (entry: JournalEvent.Entry): ControlEvent => ({
  sequence: entry.seq,
  kind: entry.eventType,
  runId: entry.runId,
  occurredAt: entry.emittedAtMs,
  payload: entry.payload as ControlEvent["payload"]
})

/**
 * Live in-process Control layer.
 *
 * Writes delegate to `ControlRuntime`; journal events are observational
 * records. `watch` only replays and follows committed journal entries.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  Control,
  never,
  ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
> = Layer.effect(
  Control,
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const notifications = yield* NotificationQueue.NotificationQueue
    const registry = yield* Registry.Registry
    const executor = yield* Effect.serviceOption(ControlExecutor)
    // Optional like the executor: a composition without a trigger store still
    // plans, runs, and lists flows and runs. Only the two trigger listings
    // refuse, and they refuse with the same typed issue `layerNone` answers,
    // so a caller cannot tell an omitted port from a declared empty one.
    const dispatch = Option.getOrElse(
      yield* Effect.serviceOption(DispatchReader.DispatchReader),
      DispatchReader.makeNone
    )
    /**
     * Whether this composition has an executor that can be asked about a run.
     *
     * Read once: the executor is captured when the layer is built, so the
     * answer cannot change between two listings of one page.
     */
    const observing = Option.isSome(executor) && executor.value.readExecution !== undefined
    const observe = (run: RunSummary): Effect.Effect<RunSummary, PersistenceError> =>
      Effect.gen(function*() {
        if (Option.isNone(executor) || executor.value.readExecution === undefined) return run
        const observed = yield* executor.value.readExecution(run.runId)
        if (observed._tag === "Missing") return { ...run, executionObservation: "missing" as const }
        return {
          ...run,
          executionObservation: "observed" as const,
          executionView: observed.executionView,
          status: observed.status,
          waitingReason: observed.waitingReason,
          parentRunId: observed.parentRunId,
          lineageId: observed.lineageId,
          roundOrdinal: observed.roundOrdinal,
          // The executor's answer replaces this plane's copy here as it does
          // for every other observed field. It has to: a control plane over
          // its own coordination database cannot see the executions a flow
          // spawned, so a nested `HumanTask` park is a fact only the executor
          // holds. Where the two share one database the runtime computes the
          // same rows itself and the observation reproduces them.
          pendingWaits: observed.pendingWaits
        }
      })
    const getRun = (runId: string) => runtime.getRun(runId).pipe(Effect.flatMap(observe))

    const mutationSemaphore = yield* Semaphore.make(1)

    const emit = (
      runId: string,
      eventType: string,
      payload: ControlEvent["payload"]
    ): Effect.Effect<void, PersistenceError> =>
      // Unfenced: the control plane mutates runs it does not own — that is
      // the point of a control plane — so its event records are
      // first-writer-wins admissions, not owner-fenced lifecycle writes.
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId,
          eventType,
          payload: json(payload)
        })
      ).pipe(
        Effect.mapError((cause) =>
          new PersistenceError({
            operation: eventType,
            message: `Failed to persist ${eventType}`,
            cause
          })
        )
      )

    /**
     * Ends a run the executor was handed and could not take.
     *
     * `ControlExecutor.launch` fails when nothing in this composition will
     * ever drive the run: no seat resolved, the flow declares none, the body
     * would not load, the provider could not be constructed. The run row
     * and its idempotency receipt are already durable by then. Keep that
     * admission and record the failure; replaying its key must never launch
     * another run. An explicit retry uses a new key.
     *
     * A settlement that cannot be written is logged rather than raised. The
     * caller is already receiving the refusal it has to act on, and replacing
     * it with a persistence error would hide which key is missing.
     */
    const settleUnlaunched = (
      runId: RunId,
      cause: string
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const fence = yield* runtime.claimFence(runId)
        const run = yield* runtime.writeStatus(runId, fence, "failed")
        yield* emit(
          runId,
          "control.run.failed",
          json({ runId, status: "failed", cause: cause.slice(0, 4096), ...ControlFacts.runFact(run) })
        )
      }).pipe(
        journal.transact,
        Effect.catchCause((failure) =>
          Effect.annotateLogs(
            Effect.logWarning("A refused launch could not be settled"),
            { runId, cause: Cause.pretty(failure) }
          )
        )
      )

    const transact = <A, E, R>(
      operation: string,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | PersistenceError, R> =>
      mutationSemaphore.withPermits(1)(
        journal.transact(effect).pipe(
          Effect.mapError((cause) =>
            cause instanceof Journal.JournalError
              ? new PersistenceError({
                operation: `${operation}.idempotency`,
                message: `Failed to commit ${operation} and its idempotency receipt atomically`,
                cause
              })
              : cause
          )
        )
      )

    /**
     * Runs one mutation under its idempotency key.
     *
     * `replay` is what a recorded receipt is worth on a second ask. For every
     * mutation that CHANGES something — a launch, a decision, a signal — it is
     * everything: the receipt is the proof the change was made once, and
     * replaying it is the whole guarantee.
     *
     * `cancel` is the exception, and it is `replay: false`. Its receipt is an
     * answer ABOUT a run, and the run can be in a different state by the time
     * the operator asks again: a cancel against a run a live peer owns answers
     * `Accepted` and finishes nothing, and replaying that answer as
     * `AlreadyApplied` turned a run nobody could reach into a run nobody could
     * ask about either — the release validation left two of them, with `smithers
     * cancel` and `smithers down` both answering from the receipt and neither
     * ever reaching the row. Cancellation needs no receipt to be idempotent:
     * the run's own terminality is stronger, and `cancel` reads it first and
     * answers `Terminal` without touching anything.
     */
    const mutate = <E, R>(
      operation: string,
      key: IdempotencyKey,
      principal: typeof Principal.Type | undefined,
      mutationFingerprint: string,
      effect: Effect.Effect<Receipt, E, R>,
      replay = true,
      claimRunKey = false
    ): Effect.Effect<Receipt, E | InvalidInput | PersistenceError, R> =>
      transact(
        operation,
        Effect.gen(function*() {
          const durableKey = mutationKey(operation, key, principal)
          const prior = yield* runtime.lookupMutation(durableKey, mutationFingerprint)
          if (prior !== undefined && (replay || prior._tag === "Conflict")) {
            return prior._tag === "AlreadyApplied"
              ? { ...prior, receiptId: key }
              : prior
          }
          const claim = claimRunKey
            ? yield* runtime.claimRunKey(durableKey, mutationFingerprint)
            : undefined
          if (claim?._tag === "Raced") return alreadyApplied(key, claim.receipt)
          return yield* Effect.gen(function*() {
            const receipt = yield* effect
            // A key that already carries a receipt is not re-recorded: the store
            // refuses to overwrite one, and the answer this call returns is the
            // fresh read of the run rather than the record.
            if (receipt._tag === "Parked" && claimRunKey) {
              yield* runtime.releaseRunKey(durableKey)
            } else if (receipt._tag !== "Parked" && prior === undefined) {
              yield* runtime.recordMutation(durableKey, mutationFingerprint, receipt)
            }
            return receipt
          }).pipe(Effect.onExit((exit) =>
            claim?._tag === "Claimed" && Exit.isFailure(exit)
              ? runtime.releaseRunKey(durableKey)
              : Effect.void
          ))
        })
      )

    /**
     * Hands a decided run's resume to whoever hosts its execution.
     *
     * Outside the mutation's write transaction, for `signal`'s reason: taking
     * the resume up re-drives the run, and the engine's own writes would wait
     * on the writer the transaction holds. A host that answers `resuming` has
     * claimed the row and is driving, so its delegation is cleared here; every
     * other composition leaves it standing for the host's own poll.
     */
    const takeUpResume = (
      runId: RunId,
      sequence: number
    ): Effect.Effect<void, PersistenceError> =>
      Option.isNone(executor)
        ? Effect.void
        : executor.value.resumeRun({ runId }).pipe(
          Effect.flatMap((uptake) => uptake === "resuming" ? runtime.clearResume(runId, sequence) : Effect.void)
        )

    /**
     * Hands an admitted run to the executor, then records its acknowledgment.
     *
     * Outside the admission's transaction: the executor may immediately read
     * through another connection or fork a driver, so the run, its approval
     * and its receipt are committed before any execution crosses this line.
     */
    const hand = (launch: Launch) =>
      Effect.gen(function*() {
        const acceptance = Option.isSome(executor)
          ? yield* executor.value.launch(launch).pipe(
            Effect.tapError((error) => settleUnlaunched(error.runId, error.message))
          )
          : "pending"
        yield* transact(
          "run.acceptance",
          Effect.gen(function*() {
            // A fast executor may already have completed or parked. Never
            // regress its durable outcome with the launch acknowledgment.
            const current = yield* runtime.getRun(launch.run.runId)
            if (current.status !== "accepted") return
            const fence = yield* runtime.claimFence(current.runId)
            const run = acceptance === "accepted"
              ? yield* runtime.writeStatus(current.runId, fence, "running")
              : yield* runtime.releasePending(current.runId, fence)
            yield* emit(
              run.runId,
              acceptance === "accepted" ? "control.run.running" : "control.run.pending",
              {
                runId: run.runId,
                status: run.status,
                ...ControlFacts.runFact(run)
              } as ControlEvent["payload"]
            )
          })
        )
      })

    /**
     * Launches a run whose admitting process died before handing it over.
     *
     * The admission and its receipt commit before {@link hand}, so a crash in
     * between left the run `accepted` under its dead admitter, and a retry of
     * the same key only read the receipt back: nothing ever launched it. The
     * acknowledgment is what `accepted` with an owner lacks — a queued launch
     * releases its owner. This process owning the run means another call here
     * is between its admission and its launch; a live peer owning it is the
     * same case elsewhere and keeps it (`ClaimLost`). Only a dead owner's run is
     * claimed, under the run store's fence, so two retries launch it once.
     */
    const relaunchStranded = (runId: RunId) =>
      Effect.gen(function*() {
        const current = yield* runtime.getRun(runId)
        if (current.status !== "accepted" || current.ownerId === undefined) return
        const ours = yield* runtime.claimFence(runId).pipe(
          Effect.as(true),
          Effect.catchTag("/control/ClaimLost", () => Effect.succeed(false))
        )
        if (ours) return
        const claimed = yield* runtime.resume(runId, { scope: "launched" }).pipe(
          Effect.catchTag("/control/ClaimLost", () => Effect.succeed(undefined))
        )
        if (claimed === undefined || claimed.status !== "accepted" || claimed.planId === undefined) return
        yield* hand({ plan: yield* runtime.getPlan(claimed.planId), run: claimed })
      }).pipe(
        // The recorded receipt is the retry's answer either way; a relaunch
        // that fails leaves the run where it was for the next retry.
        Effect.catch((failure) =>
          Effect.annotateLogs(
            Effect.logWarning("A stranded run could not be relaunched"),
            { runId, cause: failure.message }
          )
        )
      )

    const decide = (
      decision: "approved" | "denied",
      submitted: ApprovalInput
    ) =>
      Effect.gen(function*() {
        const input = yield* snapshotApproval(decision, submitted)
        // Check the authenticated identity before replay or any grant writes.
        const principal = yield* runtime.stampPrincipal(input.principal)
        // Authorization precedes target reads and idempotency replay: neither
        // an old receipt nor a terminal run confers authority on this caller.
        yield* runtime.authorizeApproval({ principal, target: input.target, decision, scope: input.scope })
        // A decision on a settled run decides nothing, and it is read BEFORE
        // the idempotency replay for `resume`'s reason: the recorded receipt
        // describes the earlier call, not the run. Answering `Accepted` sent
        // `smithers approve` into `awaitRun` waiting for a settlement that had
        // already happened — the release validation's 120-second silent block — and
        // recorded a resume delegation for a run no host may take up.
        //
        // A plan-level decision has no run yet, and a target whose run this
        // plane cannot find is left to `lookupApproval` to refuse.
        if (input.target._tag === "Node") {
          const current = yield* getRun(input.target.runId).pipe(
            Effect.catchTag("/control/RunNotFound", () => Effect.succeed(undefined))
          )
          if (current !== undefined && terminal(current.status)) {
            const settled: Receipt = { _tag: "Terminal", runId: current.runId, status: current.status }
            return settled
          }
        }
        // Set by the mutation when it records a delegation, and left unset on
        // the idempotency replay path — where the original call already
        // delegated and the host's own poll is what takes it up.
        let delegated: number | undefined
        const receipt = yield* mutate(
          decision,
          input.idempotencyKey,
          input.principal,
          fingerprint(decision, input.principal, input),
          Effect.gen(function*() {
            const token = yield* runtime.lookupApproval(input.target)
            // Resolve (and recheck authority) before installing any grant. The
            // durable adapter commits all three writes in this transaction;
            // the memory test adapter must also leave no grant on refusal.
            yield* runtime.resolveApproval(token, decision, principal, input.scope)
            if (decision === "approved") {
              yield* runtime.installBulkGrant(token, input.target.envelope, input.scope)
            }
            yield* emit(
              input.target._tag === "Plan" ? `plan:${input.target.planId}` : input.target.runId,
              `control.approval.${decision}`,
              json({
                ...ControlFacts.approvalDecisionFact(token.tokenId, input.target),
                target: input.target._tag,
                scope: input.scope,
                envelope: input.target.envelope,
                principal
              })
            )
            if (input.target._tag === "Plan") return accepted(input.idempotencyKey)
            // A decision on a node target has to restart the run the ask parked,
            // in this call. Answering without a restart left the run in
            // `waiting-approval` until a second call arrived, and a denial the
            // run never learns about is a denial that decided nothing.
            //
            // The restart is recorded, not performed, and this plane does NOT
            // claim the row. `scope: "launched"` reads like a process scope and
            // is not one — it is a `control_runs` lookup, a durable table every
            // process over one control database shares — so claiming here took
            // the row away from the host that could still drive it, and left it
            // `accepted` under a process with no executor. The delegation is
            // durable instead: the host takes it up on its next poll and clears
            // it, and the journal entry stays as the operator's record of why
            // (triage B-15).
            const runId = input.target.runId
            delegated = yield* runtime.requestResume(runId)
            yield* emit(runId, "control.run.resumed", { runId })
            return accepted(input.idempotencyKey, runId)
          })
        )
        if (input.target._tag === "Node" && delegated !== undefined) {
          yield* takeUpResume(input.target.runId, delegated)
        }
        return receipt
      })

    /**
     * Restarts a parked run, by claiming it or by asking whoever owns it.
     *
     * A run this plane launched is this plane's to claim, and `scope:
     * "launched"` is how the runtime is told to check. A run the ENGINE created
     * — a child, a fork, a trampoline round — has its own driver, and claiming
     * it here overwrote the engine's `state_json` and owner columns with a
     * control-plane summary, after which that driver's `scheduleResume` no
     * longer recognized the row: the run stayed suspended with its waiting
     * reason set and its execution never returned (control-plane example 38).
     *
     * Both public resume spellings journal `control.run.resume`. The caller
     * or a host-supplied journal subscriber must drive the execution. This
     * path neither calls `requestResume` nor offers `executor.resumeRun`;
     * the durable pending-resume queue belongs to node-approval decisions.
     * A run a live peer is HOLDING — `running`, or the `accepted` a claim
     * writes and only a settlement rewrites — is still `ClaimLost`: there is
     * nothing to restart, and pretending otherwise would hide the peer.
     */
    const runMutation = (
      submitted: RunMutationInput
    ): Effect.Effect<Receipt, RunNotFound | ClaimLost | InvalidInput | PersistenceError> =>
      Effect.gen(function*() {
        const input = yield* snapshotReasonedMutation("resume", submitted)
        // Terminality is read BEFORE the idempotency replay, as `cancel` reads
        // it. A recorded receipt is the proof a restart was made once; it is
        // not an answer about the run, and the run settles afterwards. The
        // release validation asked `run --resume` for a completed run and was told
        // `AlreadyApplied`, which describes the earlier call and says nothing
        // about the run the operator named (spec item 3).
        const settled = yield* getRun(input.runId)
        if (terminal(settled.status)) {
          return { _tag: "Terminal", runId: settled.runId, status: settled.status }
        }
        return yield* mutate(
          "resume",
          input.idempotencyKey,
          input.principal,
          fingerprint("resume", input.principal, input),
          Effect.gen(function*() {
            const current = yield* getRun(input.runId)
            if (terminal(current.status)) {
              return { _tag: "Terminal", runId: current.runId, status: current.status }
            }
            const claimed = yield* runtime.resume(input.runId, { scope: "launched" }).pipe(
              Effect.catchTag("/control/ClaimLost", () =>
                live(current.status)
                  ? Effect.fail(new ClaimLost({ runId: input.runId }))
                  : Effect.succeed(undefined))
            )
            // The same attribution `cancel` writes, for the same reason: the
            // contract records `reason` on the journal entry the mutation
            // writes and `principal` as stamped by the runtime, and a resume
            // that carried neither left an operator unable to say who restarted
            // a run or why.
            const principal = yield* runtime.stampPrincipal(input.principal)
            yield* emit(
              input.runId,
              "control.run.resume",
              json({
                runId: input.runId,
                status: (claimed ?? current).status,
                ...(claimed === undefined ? {} : ControlFacts.runFact(claimed)),
                principal,
                ...(input.reason === undefined ? {} : { reason: input.reason })
              })
            )
            return claimed === undefined
              ? accepted(input.idempotencyKey, input.runId)
              : terminalOrAccepted(input.idempotencyKey, claimed)
          })
        )
      })

    /**
     * Makes a cancellation durable on the engine row through the executor.
     *
     * Absent executor, absent engine: the composition runs nothing, so there is
     * no row to write and the local interrupt is the whole cancel. An executor
     * that answers `unknown` has an engine that never heard of the run, which
     * is the same situation with a different messenger.
     */
    const executorRequestCancel = (
      runId: RunId
    ): Effect.Effect<CancelRecord, PersistenceError> =>
      Option.isNone(executor)
        ? Effect.succeed("unknown" as const)
        : executor.value.requestCancel({ runId })

    /**
     * Finishes the parked execution the cancel just recorded a request on.
     *
     * Outside the mutation's write transaction, for `takeUpResume`'s reason:
     * settling a park re-enters the engine, and the engine's writes would wait
     * on the writer the transaction holds — which deadlocks the cancel rather
     * than slowing it. So this runs on the way out, once the request and the
     * terminal control status are both committed.
     */
    const executorSettleCancelledPark = (
      runId: RunId
    ): Effect.Effect<void, PersistenceError> =>
      Option.isNone(executor)
        ? Effect.void
        : executor.value.settleCancelledPark({ runId })

    /**
     * Moves this plane's row onto the status the engine already reached.
     *
     * A reconciliation that cannot be written is logged rather than raised, for
     * `settleUnlaunched`'s reason: the caller is already receiving the engine's
     * terminal receipt, which is the true answer, and a live peer holding the
     * row will settle it itself.
     */
    const reconcileTerminal = (
      runId: RunId,
      status: RunSummary["status"]
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Reconcile the coordination row itself. Applying the engine overlay
        // here would make a stale row appear settled before it was persisted.
        const current = yield* runtime.getRun(runId)
        if (terminal(current.status)) return
        const fence = yield* runtime.claimFence(runId).pipe(
          // A parked coordination row has released its fence. Claim that row
          // before copying the engine's terminal fact; a live peer still wins.
          Effect.catchTag("/control/ClaimLost", () =>
            runtime.resume(runId).pipe(Effect.andThen(runtime.claimFence(runId))))
        )
        const run = yield* runtime.writeStatus(runId, fence, status)
        yield* emit(runId, `control.run.${status}`, json({ runId, status, ...ControlFacts.runFact(run) }))
      }).pipe(
        journal.transact,
        Effect.catchCause((failure) =>
          Effect.annotateLogs(
            Effect.logWarning("A settled engine row could not be reconciled onto the control row"),
            { runId, status, cause: Cause.pretty(failure) }
          )
        )
      )

    /**
     * Resumes a parked run whose park a steer has just answered.
     *
     * Only two parks are the steer's to end. A run parked on `event` is
     * waiting for something to arrive, and a steer is something arriving. A
     * run parked on `released` lost its owner to a sweep
     * (`@smthrs/engine-store` `DisasterRecovery.fence`) and nothing is coming
     * to claim it, so the steer claims it.
     *
     * Every other park keeps waiting. An `approval`, `timer`, or `quota` park
     * is waiting for a decision, a clock, or a budget that a message does not
     * supply. A park with NO reason at all is an operator's own park, written
     * through `ControlRuntime.writeStatus`, and it is the one park a steer must
     * not end: an operator who stopped a run and then sent it a message is
     * queuing the message for when they restart it, not asking for the stop to
     * be undone. A park a control plane cannot explain is left alone for the
     * same reason.
     *
     * A lost claim is not a failure here. It means another process already
     * owns the run, or the run belongs to a driver this plane did not launch
     * — an engine-created child keeps its park, because claiming it would
     * strand it under this plane's fence where no engine re-drives it. The
     * steer itself is already durable in the notification queue, so the
     * owning driver delivers it at the run's next boundary.
     */
    const wake = (
      run: RunSummary,
      messageId: string
    ): Effect.Effect<void, PersistenceError> => {
      if (run.status !== "parked") return Effect.void
      if (run.waitingReason !== "event" && run.waitingReason !== "released") return Effect.void
      return runtime.resume(run.runId, { scope: "launched" }).pipe(
        Effect.flatMap((resumed) =>
          emit(
            run.runId,
            "control.steer.woke",
            {
              runId: run.runId,
              messageId,
              status: resumed.status,
              ...ControlFacts.runFact(resumed)
            } as ControlEvent["payload"]
          )
        ),
        Effect.catchTag("/control/ClaimLost", () => Effect.void),
        Effect.catchTag("/control/RunNotFound", () => Effect.void)
      )
    }

    /**
     * A page of run summaries with their pending steer counts filled in.
     *
     * The count comes from the notification queue rather than from a column,
     * because pending is admitted minus promoted and the queue owns both
     * halves. A queue that is unavailable leaves the field absent — "not
     * known" is representable, and it is the truth — while a journal that
     * fails is a failed listing.
     */
    const withSteering = (
      runs: ReadonlyArray<RunSummary>
    ): Effect.Effect<ReadonlyArray<RunSummary>, ControlError> =>
      Effect.forEach(runs, (run) =>
        notifications.pending(run.runId).pipe(
          Effect.map((pending): RunSummary => ({
            ...run,
            steering: {
              pending: pending.filter((notification) => notification.delivery === "steer").length
            }
          })),
          Effect.catchTag("/notifications/NotificationError", () => Effect.succeed(run)),
          Effect.mapError((cause) =>
            new PersistenceError({
              operation: "control.list.steering",
              message: `Failed to read pending steering for ${run.runId}`,
              cause
            })
          )
        ))

    const list = (request: ListRequest): Effect.Effect<ListResponse, ControlError> =>
      Effect.gen(function*() {
        const bounds = yield* pageBounds(request._tag === "runs" ? undefined : request.cursor, request.limit)
        if (request._tag === "flows") {
          const [registered, warnings] = yield* Effect.all([registry.list(), registry.warnings()])
          const available = registered.length > 0
            ? registered.map((descriptor) => ({
              flowId: descriptor.name,
              description: descriptor.description,
              ...(inputDocument(descriptor.input) === undefined
                ? {}
                : { inputSchema: inputDocument(descriptor.input)! })
            }))
            : yield* runtime.listFlows
          const result = page(available, bounds)
          const diagnostics = warnings.length === 0 ? {} : { warnings }
          return result.nextCursor === undefined
            ? { _tag: "flows", items: result.items, ...diagnostics }
            : { _tag: "flows", items: result.items, ...diagnostics, nextCursor: result.nextCursor }
        }

        if (request._tag === "triggers") {
          let triggers: ReadonlyArray<TriggerSummary> = yield* dispatch.list(request)
          if (request.filters?.triggerId !== undefined) {
            triggers = triggers.filter((trigger) => trigger.triggerId === request.filters?.triggerId)
          }
          if (request.filters?.flowId !== undefined) {
            triggers = triggers.filter((trigger) => trigger.flowId === request.filters?.flowId)
          }
          if (request.filters?.enabled !== undefined) {
            triggers = triggers.filter((trigger) => trigger.enabled === request.filters?.enabled)
          }
          const result = page(triggers, bounds)
          return result.nextCursor === undefined
            ? { _tag: "triggers", items: result.items }
            : { _tag: "triggers", items: result.items, nextCursor: result.nextCursor }
        }

        if (request._tag === "fires") {
          let fires: ReadonlyArray<FireSummary> = yield* dispatch.fires(request)
          if (request.filters?.triggerId !== undefined) {
            fires = fires.filter((fire) => fire.triggerId === request.filters?.triggerId)
          }
          if (request.filters?.runId !== undefined) {
            fires = fires.filter((fire) => fire.runId === request.filters?.runId)
          }
          if (request.filters?.outcome !== undefined) {
            fires = fires.filter((fire) => fire.outcome === request.filters?.outcome)
          }
          const result = page(fires, bounds)
          return result.nextCursor === undefined
            ? { _tag: "fires", items: result.items }
            : { _tag: "fires", items: result.items, nextCursor: result.nextCursor }
        }

        if (request.filters?.principalId !== undefined) {
          return yield* Effect.fail(
            invalid(
              "filters.principalId: rc.0 records no launch principal on a run summary, so the filter cannot be applied"
            )
          )
        }
        const filters = request.filters
        const fingerprint = JSON.stringify([
          filters?.runId ?? null,
          filters?.flowId ?? null,
          filters?.status ?? null,
          filters?.parentRunId ?? null,
          filters?.lineageId ?? null,
          // Keep legacy cursor fingerprints byte-identical unless opting in.
          ...(filters?.terminal === undefined && request.order === undefined
            ? []
            : [filters?.terminal ?? null, request.order ?? null])
        ])
        const cursor = request.cursor === undefined ? undefined : yield* Schema.decodeUnknownEffect(runCursor)(
          request.cursor
        ).pipe(Effect.mapError(() => invalid("cursor: expected a run listing cursor")))
        if (cursor !== undefined && cursor.filters !== fingerprint) {
          return yield* invalid("cursor: belongs to different run filters")
        }
        // Exact lookups retain their one-row path. Other queries select durable
        // summary fields in the adapter before observing the selected page.
        if (filters?.runId !== undefined) {
          let runs = yield* getRun(filters.runId).pipe(
            Effect.map((run) => [run]),
            Effect.catchTag("/control/RunNotFound", () => Effect.succeed<Array<RunSummary>>([]))
          )
          if (filters.flowId !== undefined) runs = runs.filter((run) => run.flowId === filters.flowId)
          if (filters.status !== undefined) runs = runs.filter((run) => run.status === filters.status)
          if (filters.terminal !== undefined) runs = runs.filter((run) => terminal(run.status) === filters.terminal)
          if (filters.parentRunId !== undefined) runs = runs.filter((run) => run.parentRunId === filters.parentRunId)
          if (filters.lineageId !== undefined) runs = runs.filter((run) => run.lineageId === filters.lineageId)
          return { _tag: "runs", items: yield* withSteering(runs) }
        }
        // A status filter has to select on the status a caller will READ.
        // `observe` replaces this plane's copy with the executor's, so a run
        // the engine has parked on a human wait answers `waiting-approval`
        // while the coordination row still says whatever it last recorded —
        // and the adapter's own filter dropped it before anybody looked. That
        // is what left workspace 6f2733a3's run-1 out of every
        // `status: "waiting-approval"` page while the run tree was waiting on
        // a person. The exact-lookup branch above has always filtered on the
        // observed summary; this makes the paged branch agree.
        //
        // The source therefore selects without the status and the page is
        // filled from observed rows, asking for only as many as are still
        // needed so a page never over-delivers rows its cursor has passed. A
        // filter the source cannot evaluate costs a walk, which is why the
        // walk stops at a full page or at the end of the runs.
        const postFiltered = observing && (filters?.status !== undefined || filters?.terminal !== undefined)
        const sourceFilters = postFiltered
          ? Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "status" && key !== "terminal"))
          : filters
        const collected: Array<RunSummary> = []
        let sourceCursor = cursor
        let sourceNext: RunPage["nextCursor"]
        while (true) {
          const result = yield* runtime.queryRuns({
            filters: sourceFilters,
            order: request.order,
            cursor: sourceCursor,
            limit: bounds.size - collected.length
          })
          const observed = yield* Effect.forEach(result.items, observe)
          for (const run of observed) {
            if (
              !postFiltered ||
              (filters?.status === undefined || run.status === filters.status) &&
                (filters?.terminal === undefined || terminal(run.status) === filters.terminal)
            ) collected.push(run)
          }
          sourceNext = result.nextCursor
          if (!postFiltered || sourceNext === undefined || collected.length >= bounds.size) break
          sourceCursor = { version: 1, filters: fingerprint, ...sourceNext }
        }
        const items = yield* withSteering(collected)
        return sourceNext === undefined
          ? { _tag: "runs", items }
          : {
            _tag: "runs",
            items,
            nextCursor: JSON.stringify({ version: 1, filters: fingerprint, ...sourceNext })
          }
      })

    const streamForRun = (
      runId: RunId,
      filter: WatchFilter
    ): Stream.Stream<ControlEvent, ControlError> =>
      journal.stream({
        runId: JournalEvent.RunId.make(runId),
        ...(filter.afterSequence === undefined
          ? {}
          : { afterSequence: JournalEvent.Seq.make(filter.afterSequence) })
      }).pipe(
        Stream.map(eventFromEntry),
        Stream.mapError(watchReadFailed)
      )

    /**
     * Finds the last committed sequence without walking the history. The
     * journal's public cursor is forward-only, so exponential probes first
     * bracket the tail and binary probes then pin it exactly. Only these
     * indexed one-row reads run in the transaction that fixes the cutoff.
     */
    const snapshotHighWater = (
      runId: JournalEvent.RunId
    ): Effect.Effect<JournalEvent.Seq | undefined, ControlError> =>
      journal.transact(
        Effect.gen(function*() {
          const first = yield* journal.entries({ runId, limit: 1 })
          const initial = first.entries[0]
          if (initial === undefined) return undefined

          let lower = initial.seq as number
          let step = 1
          let upper = lower
          const maximumSequence = Number.MAX_SAFE_INTEGER - 1
          while (lower < maximumSequence) {
            const probe = Math.min(maximumSequence, lower + step - 1)
            const next = yield* journal.entries({
              runId,
              after: JournalEvent.Seq.make(probe),
              limit: 1
            })
            const entry = next.entries[0]
            if (entry === undefined) {
              upper = probe
              break
            }
            lower = entry.seq
            if (lower === maximumSequence) return entry.seq
            step = Math.min(maximumSequence - lower, step * 2)
          }

          while (lower < upper) {
            const middle = lower + Math.ceil((upper - lower) / 2)
            const next = yield* journal.entries({
              runId,
              after: JournalEvent.Seq.make(middle - 1),
              limit: 1
            })
            const entry = next.entries[0]
            if (entry === undefined) {
              upper = middle - 1
            } else {
              lower = entry.seq
            }
          }
          return JournalEvent.Seq.make(lower)
        })
      ).pipe(Effect.mapError(watchReadFailed))

    const snapshotForRunAt = (
      runId: RunId,
      filter: WatchFilter,
      highWater: JournalEvent.Seq | undefined
    ): Stream.Stream<ControlEvent, ControlError> => {
      const journalRunId = JournalEvent.RunId.make(runId)
      const initialAfter = filter.afterSequence === undefined
        ? undefined
        : JournalEvent.Seq.make(filter.afterSequence)
      if (highWater === undefined || (initialAfter !== undefined && initialAfter >= highWater)) {
        return Stream.empty
      }
      return Stream.paginate(initialAfter, (after) =>
        journal.entries({
          runId: journalRunId,
          ...(after === undefined ? {} : { after }),
          limit: snapshotPageSize
        }).pipe(
          Effect.map((page) => {
            const entries = page.entries.filter((entry) => entry.seq <= highWater)
            const last = entries.at(-1)
            const next = last === undefined || last.seq >= highWater || !page.hasMore
              ? Option.none<JournalEvent.Seq | undefined>()
              : Option.some<JournalEvent.Seq | undefined>(last.seq)
            return [entries, next] as const
          }),
          Effect.mapError(watchReadFailed)
        )).pipe(Stream.map(eventFromEntry))
    }

    const snapshotForRun = (
      runId: RunId,
      filter: WatchFilter
    ): Stream.Stream<ControlEvent, ControlError> =>
      Stream.unwrap(
        Effect.map(
          snapshotHighWater(JournalEvent.RunId.make(runId)),
          (highWater) => snapshotForRunAt(runId, filter, highWater)
        )
      )

    const journalPartitions = Effect.gen(function*() {
      const [planIds, runs] = yield* Effect.all([runtime.listPlanIds, runtime.listRuns])
      return [
        ...planIds.map((planId) => `plan:${planId}`),
        ...runs.map((run) => run.runId)
      ]
    })

    const snapshot = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> =>
      filter.runId !== undefined
        ? snapshotForRun(filter.runId, filter)
        : Stream.unwrap(
          Effect.map(journalPartitions, (partitions) =>
            Stream.mergeAll(
              partitions.map((partition) => snapshotForRun(partition, filter)),
              { concurrency: snapshotPartitionConcurrency }
            ))
        )

    const entries = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> =>
      filter.follow === false
        ? snapshot(filter)
        : filter.runId !== undefined
        ? streamForRun(filter.runId, filter)
        : Stream.unwrap(
          Effect.gen(function*() {
            const subscription = yield* journal.changes
            const partitions = yield* journalPartitions
            // Subscribe first, then pin each known partition's cutoff. A row
            // committed before its cutoff is read from the finite snapshot;
            // one committed after it is read from the buffered tail. This is
            // a handoff, not a bounded duplicate cache, so an arbitrarily long
            // history cannot make an old overlap reappear.
            const cutoffs = yield* Effect.forEach(
              partitions,
              (partition) =>
                Effect.map(
                  snapshotHighWater(JournalEvent.RunId.make(partition)),
                  (highWater) => [partition, highWater] as const
                ),
              { concurrency: snapshotPartitionConcurrency }
            )
            const highWaterByPartition = new Map(cutoffs)
            /**
             * Detects a live tail that silently lost entries.
             *
             * `changes` is a sliding PubSub: a watcher that falls behind drops
             * committed entries with no signal, which turns this follow into a
             * permanently incomplete stream. Sequence numbers are
             * partition-local, so each tail entry is checked against the last
             * sequence this watcher saw for its partition (or the snapshot
             * cutoff for one it has not tailed yet).
             *
             * A gap is not proof of loss on its own: a rolled-back transaction
             * leaves an allocated sequence unused, and that hole is benign. The
             * durable journal disambiguates — an entry in the gap that was
             * committed but never delivered here is a real loss and fails the
             * stream, while a hole with no durable entry is skipped.
             *
             * One limitation, by design: the disambiguation reads the durable
             * journal, so an entry that was committed, dropped, and then
             * compacted away before the check runs reports as a benign hole.
             * Closing that needs a registered reader cursor, which the
             * partition-merged tail does not hold.
             */
            const seenByPartition = new Map<string, number>()
            const gapCheck = (
              partition: string,
              expected: number | undefined,
              arrived: number
            ): Effect.Effect<void, ControlError> =>
              journal.entries({
                runId: JournalEvent.RunId.make(partition),
                ...(expected === undefined ? {} : { after: JournalEvent.Seq.make(expected) }),
                limit: 1
              }).pipe(
                Effect.mapError(watchReadFailed),
                Effect.flatMap((page) => {
                  const missed = page.entries[0]
                  if (missed === undefined || missed.seq >= arrived) return Effect.void
                  return Effect.fail(
                    new PersistenceError({
                      operation: "watch",
                      message:
                        `the live tail lost journal entries for ${partition}: sequence ${missed.seq} was committed but never delivered to this watcher`
                    })
                  )
                })
              )
            const trackTail = (
              entry: JournalEvent.Entry
            ): Effect.Effect<Option.Option<JournalEvent.Entry>, ControlError> => {
              const partition = String(entry.runId)
              const expected = seenByPartition.get(partition) ?? highWaterByPartition.get(partition)
              // A committed entry at or below the cursor was already delivered
              // (or is covered by the snapshot); passing it on teaches nothing.
              if (expected !== undefined && entry.seq <= expected) return Effect.succeed(Option.none())
              seenByPartition.set(partition, entry.seq)
              return expected !== undefined && entry.seq === expected + 1
                ? Effect.succeed(Option.some(entry))
                : Effect.map(gapCheck(partition, expected, entry.seq), () => Option.some(entry))
            }
            const tail = Stream.fromSubscription(subscription).pipe(
              // Every committed entry names its partition, so an entry from one
              // this snapshot never read has no cutoff and passes through.
              Stream.filter((entry) => {
                const highWater = highWaterByPartition.get(String(entry.runId))
                return highWater === undefined || entry.seq > highWater
              }),
              Stream.mapEffect(trackTail),
              Stream.filter(Option.isSome),
              Stream.map((entry) => entry.value),
              Stream.map(eventFromEntry)
            )
            return Stream.mergeAll(
              [
                ...cutoffs.map(([partition, highWater]) => snapshotForRunAt(partition, filter, highWater)),
                tail
              ],
              // Same bound the cutoff reads above use, plus one reserved slot
              // so the live tail is never starved behind snapshot work. An
              // unbounded merge read every partition of an unbounded database
              // at once, which is the allocation a remote watcher could force.
              { concurrency: snapshotPartitionConcurrency + 1 }
            )
          })
        )

    /** Expands each source row in stable order and checkpoints individual members. */
    const watch = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> => {
      if (filter.afterSequence !== undefined && filter.runId === undefined) {
        return Stream.fail(invalid("afterSequence: a watch cursor resumes one run, so it requires runId"))
      }
      const cursor = filter.afterCursor
      if (cursor !== undefined) {
        if (filter.runId === undefined) {
          return Stream.fail(invalid("afterCursor: a watch cursor resumes one run, so it requires runId"))
        }
        if (filter.afterSequence !== undefined) {
          return Stream.fail(invalid("afterCursor: cannot be combined with afterSequence"))
        }
        if (!Schema.is(WatchCursor)(cursor)) {
          return Stream.fail(invalid("afterCursor: sequence and offset must be nonnegative safe journal integers"))
        }
      }
      // A partial checkpoint rereads only its source row. A complete one
      // starts strictly after it, so polling never rereads completed entries.
      const afterSequence = cursor === undefined ?
        filter.afterSequence
        : cursor.offset === undefined ?
        cursor.sequence
        : cursor.sequence === 0
        ? undefined
        : cursor.sequence - 1
      return entries({
        ...filter,
        afterSequence
      }).pipe(
        Stream.map((event): ReadonlyArray<ControlEvent> => {
          const lineage = Lineage.derive(event)
          const expanded = [event, ...(lineage === undefined ? [] : [lineage]), ...Steering.derive(event)]
          const checkpointed = expanded.map((member, offset): ControlEvent => ({
            ...member,
            cursor: offset === expanded.length - 1 ? { sequence: event.sequence } : { sequence: event.sequence, offset }
          }))
          return cursor?.offset !== undefined && event.sequence === cursor.sequence
            ? checkpointed.slice(cursor.offset + 1)
            : checkpointed
        }),
        Stream.flattenIterable
      )
    }

    const service: Service = {
      plan: Effect.fn("Control.plan")((input) =>
        mutationSemaphore.withPermits(1)(
          journal.transact(Effect.gen(function*() {
            // The SQL runtime's plan, key and token writes join this transaction.
            // Memory publication cannot roll back, and older SQL writes could
            // commit without an entry, so a stored card also needs a journal check.
            const { card, created } = yield* runtime.plan(input)
            const runId = JournalEvent.RunId.make(`plan:${card.planId}`)
            if (!created) {
              let after: JournalEvent.Seq | undefined
              while (true) {
                const page = yield* journal.entries({
                  runId,
                  ...(after === undefined ? {} : { after }),
                  limit: snapshotPageSize
                })
                if (
                  page.entries.some((entry) =>
                    entry.sourceId === sourceId && entry.eventType === "control.plan.created"
                  )
                ) {
                  return card
                }
                if (!page.hasMore) break
                after = page.entries[page.entries.length - 1]!.seq
              }
            }
            yield* emit(runId, "control.plan.created", {
              planId: card.planId,
              flowId: card.flowId,
              digest: card.digest
            })
            return card
          })).pipe(
            Effect.mapError((cause) =>
              cause instanceof Journal.JournalError
                ? new PersistenceError({
                  operation: "plan",
                  message: "Failed to commit plan and its creation entry atomically",
                  cause
                })
                : cause
            )
          )
        )
      ),
      run: Effect.fn("Control.run")((submitted) =>
        Effect.gen(function*() {
          const input = yield* snapshotRun(submitted)
          // One resume, one implementation. This member used to be a second
          // path with none of `Control.resume`'s fixes: it claimed without
          // `scope: "launched"`, so resuming an engine-created child overwrote
          // the engine's continuation state; it replayed a recorded receipt as
          // `AlreadyApplied` for a run that had since settled; and it journaled
          // `control.run.resumed`, which `AgentSession` reads as an approval
          // DELEGATION rather than as the claim a resume is.
          if (input._tag === "Resume") return yield* runMutation(input)
          let admitted: Launch | undefined
          const receipt = yield* mutate<
            | RunNotFound
            | PlanNotFound
            | PlanDenied
            | PlanDigestMismatch
            | EnvelopeMismatch
            | ClaimLost
            | LaunchFailed
            | PersistenceError,
            never
          >(
            "run",
            input.idempotencyKey,
            input.principal,
            fingerprint("run", input.principal, input),
            Effect.gen(function*() {
              const launched = yield* runtime.launch(input.planId, input.digest, input.envelope)
              if (launched._tag === "Parked") {
                return { ...launched.receipt, receiptId: input.idempotencyKey }
              }
              yield* emit(
                launched.run.runId,
                "control.run.accepted",
                {
                  runId: launched.run.runId,
                  planId: input.planId,
                  digest: input.digest,
                  status: launched.run.status,
                  ...ControlFacts.runFact(launched.run, "created")
                } as ControlEvent["payload"]
              )
              admitted = { plan: yield* runtime.getPlan(input.planId), run: launched.run }
              return {
                _tag: "Accepted",
                receiptId: input.idempotencyKey,
                runId: launched.run.runId
              }
            }),
            true,
            true
          )
          // The executor may immediately read through another connection or
          // fork a driver. Its run, approval and dedupe receipt must all be
          // committed before any execution crosses that boundary.
          if (receipt._tag === "Accepted" && admitted !== undefined) yield* hand(admitted)
          else if (receipt._tag === "AlreadyApplied" && receipt.runId !== undefined) {
            yield* relaunchStranded(receipt.runId)
          }
          return receipt
        })
      ),
      approve: Effect.fn("Control.approve")((input) => decide("approved", input)),
      deny: Effect.fn("Control.deny")((input) => decide("denied", input)),
      steer: Effect.fn("Control.steer")((submitted: SteerInput) =>
        Effect.flatMap(snapshotSteer(submitted), (input) =>
          mutate(
            "steer",
            input.idempotencyKey,
            input.message.principal,
            fingerprint("steer", input.message.principal, input),
            Effect.gen(function*() {
              // Two run ids naming two runs is a caller mistake with a durable
              // consequence: the notification is admitted to `input.runId` while
              // the stored `SteerMessage.runId` names another run, so the message
              // an operator later reads says it belongs somewhere it was never
              // delivered.
              if (input.message.runId !== input.runId) {
                return yield* Effect.fail(
                  invalid(
                    `message.runId: must be ${JSON.stringify(input.runId)}, received ${
                      JSON.stringify(input.message.runId)
                    }`
                  )
                )
              }
              const run = yield* getRun(input.runId)
              // A run that will never take another turn cannot be steered, and
              // storing the steer anyway would leave an operator watching a
              // message that has no boundary left to deliver it.
              if (terminal(run.status)) return { _tag: "Terminal", runId: run.runId, status: run.status }
              const item = steerItem(input.message)
              const admission = yield* notifications.admit(input.runId, {
                _tag: "human-steer",
                id: input.message.messageId,
                delivery: "steer",
                targetLineageId: input.runId,
                provenance: {
                  sourceRunId: input.runId,
                  sourceLineageId: input.runId,
                  sourceTurn: 0,
                  sourceActor: `${input.message.principal.kind}:${input.message.principal.id}`
                },
                payload: SteerPayload.encode(item)
              }).pipe(
                Effect.mapError((cause) =>
                  cause instanceof NotificationQueue.NotificationError ? cause : new PersistenceError({
                    operation: "control.steer.notification",
                    message: "Failed to admit steering notification",
                    cause
                  })
                )
              )
              if (admission.decision === "rejected-full") {
                return yield* Effect.fail(
                  new NotificationQueue.NotificationError({
                    code: "notification_full",
                    notificationId: input.message.messageId,
                    message: "Steering queue is full; retry after pending notifications are delivered"
                  })
                )
              }
              // `createdAt` is the caller's own stated time, and the enqueue
              // entry is the one place it is kept: `steerItem` strips the control
              // envelope before the message reaches the queue, so a field the
              // journal did not carry was a field nothing ever read.
              yield* emit(input.runId, Steering.enqueuedEventType, {
                runId: input.runId,
                messageId: input.message.messageId,
                kind: item.kind,
                createdAt: input.message.createdAt
              })
              yield* wake(run, input.message.messageId)
              return accepted(input.idempotencyKey, input.runId)
            })
          ))
      ),
      signal: Effect.fn("Control.signal")((submitted: SignalInput) =>
        Effect.flatMap(snapshotSignal(submitted), (input) =>
          Effect.gen(function*() {
            const key = fingerprint("signal", input.principal, input)
            const durableKey = mutationKey("signal", input.idempotencyKey, input.principal)
            // Admission, payload and receipt commit together before any engine
            // operation. The writer is released before completing a deferred.
            const receipt = yield* mutate(
              "signal",
              input.idempotencyKey,
              input.principal,
              key,
              Effect.gen(function*() {
                const current = yield* getRun(input.runId)
                if (terminal(current.status)) {
                  return { _tag: "Terminal" as const, runId: current.runId, status: current.status }
                }
                yield* runtime.admitSignal(durableKey, input.runId, input.signal)
                yield* emit(input.runId, "control.signal.admitted", {
                  commandId: durableKey,
                  runId: input.runId,
                  name: input.signal.name
                })
                return accepted(input.idempotencyKey, input.runId)
              }),
              true,
              true
            )
            if (receipt._tag !== "Accepted" && receipt._tag !== "AlreadyApplied") return receipt
            const command = yield* runtime.signalCommand(durableKey)
            if (command === undefined || command.state === "delivered" || command.state === "terminal") return receipt
            if (command.state === "rejected") {
              return yield* new NoMatchingWait({ runId: input.runId, waitName: input.signal.name })
            }
            const delivery = Option.isNone(executor) ?
              "unknown" as const
              : yield* executor.value.deliverSignal({ ...command })
            if (delivery === "no-match") {
              yield* runtime.settleSignal(durableKey, "rejected")
              return yield* new NoMatchingWait({ runId: input.runId, waitName: input.signal.name })
            }
            if (delivery === "delivered") {
              yield* runtime.settleSignal(durableKey, "delivered")
            }
            return receipt
          }))
      ),
      cancel: Effect.fn("Control.cancel")((submitted) =>
        Effect.flatMap(snapshotReasonedMutation("cancel", submitted), (input) =>
          mutate(
            "cancel",
            input.idempotencyKey,
            input.principal,
            fingerprint("cancel", input.principal, input),
            Effect.gen(function*() {
              const current = yield* getRun(input.runId)
              // A run that has already settled cannot be cancelled, and a cancel
              // request journaled against it would be a request nothing can ever
              // act on. Answer with what actually happened to the run.
              if (terminal(current.status)) {
                yield* reconcileTerminal(input.runId, current.status)
                return { _tag: "Terminal", runId: current.runId, status: current.status }
              }
              // The durable half, and the only half that reaches a run another
              // process owns: fibers are process-local, so an interrupt can only
              // stop a run this process is driving. The executor writes
              // `cancel_requested_at_ms` on the engine row instead, and the
              // owner's cancel poll acts on it within a heartbeat.
              //
              // It runs INSIDE the mutation's transaction on purpose. An engine
              // that refuses the request rolls the whole cancel back — no
              // attribution event, no terminal control status — because a
              // control row that says `cancelled` while the engine row is still
              // running is the one state an operator can never recover from.
              //
              // It runs BEFORE the attribution event for the mirror-image
              // reason. The control row this plane read may be stale — the two
              // `flows_runs` tables are two files in the shipped CLI — and an
              // engine row that has already settled makes the cancel a request
              // nobody can act on. Attributing and transitioning it anyway is
              // exactly the terminal disagreement B-11 forbids, so the engine's
              // own status becomes the receipt and nothing else happens.
              const record = yield* executorRequestCancel(input.runId)
              if (typeof record !== "string") {
                // The engine finished the run before the request arrived. Nobody
                // cancelled anything, so no attribution is written; but leaving
                // the control row saying `running` for a run the engine settled
                // is permanent, because no verb converges it: `cancel` answers
                // `Terminal` without writing and `resume` refuses a settled run.
                // `ps` listed it live and `gc` skipped it forever. Writing the
                // ENGINE's own status is convergence, not the terminal
                // disagreement B-11 forbids, which is a control row reading
                // `cancelled` over an engine row reading `completed`.
                yield* reconcileTerminal(input.runId, record.status)
                return { _tag: "Terminal", runId: input.runId, status: record.status }
              }
              // Attribution is keyed on the request being NEWLY recorded. A
              // cancel that committed without it would be durable and anonymous,
              // and nothing afterwards could say who asked — but this mutation
              // runs with `replay: false`, so an operator asking a second time
              // re-executes it, and attributing every ask journaled one
              // `control.run.cancel-requested` per ask for one cancellation.
              // `already-requested` is the engine saying the column was set
              // before this call arrived, so the record already exists.
              //
              // It stays BEFORE the interrupt, and in the mutation's own
              // transaction.
              const prior = yield* runtime.lookupMutation(
                mutationKey("cancel", input.idempotencyKey, input.principal),
                fingerprint("cancel", input.principal, input)
              )
              // A retry after cleanup or settlement failed already committed
              // this request's attribution with its acceptance receipt.
              if (record !== "already-requested" && prior === undefined) {
                const principal = yield* runtime.stampPrincipal(input.principal)
                yield* emit(
                  input.runId,
                  Cancellation.requestedEventType,
                  json({
                    runId: input.runId,
                    source: "control",
                    principal,
                    ...(input.reason === undefined ? {} : { reason: input.reason })
                  })
                )
              }
              return accepted(input.idempotencyKey, input.runId)
            }),
            false
          ).pipe(
            Effect.flatMap((receipt) =>
              Effect.gen(function*() {
                if (receipt._tag !== "Accepted") return receipt
                // The request and receipt are committed before any finalizer runs.
                // Finalizers may use this same mutation permit or durable writer.
                const settle: NonNullable<Parameters<typeof runtime.interrupt>[1]> = (effect) =>
                  transact(
                    "cancel",
                    Effect.gen(function*() {
                      const run = yield* effect
                      yield* emit(
                        input.runId,
                        `control.run.${run.status}`,
                        {
                          runId: input.runId,
                          status: run.status,
                          ...ControlFacts.runFact(run)
                        } as ControlEvent["payload"]
                      )
                      return run
                    })
                  )
                const run = yield* runtime.interrupt(input.runId, settle).pipe(
                  Effect.catchTag("/control/ClaimLost", () =>
                    Effect.gen(function*() {
                      const current = yield* getRun(input.runId)
                      if (terminal(current.status)) return current
                      // A live peer acts on the durable request. An unowned park
                      // needs this caller to claim it and finish the cancellation.
                      if (live(current.status) && current.ownerId !== undefined) return undefined
                      return yield* runtime.resume(input.runId).pipe(
                        Effect.andThen(runtime.interrupt(input.runId, settle)),
                        Effect.catchTag("/control/ClaimLost", () => Effect.succeed(undefined))
                      )
                    }))
                )
                return run === undefined
                  ? receipt
                  : terminalOrAccepted(input.idempotencyKey, run)
              })
            ),
            // Both rows, before the process that asked goes away. The engine row
            // carries the request the moment the mutation commits, but nothing
            // drives a parked run, so the row stayed `suspended` until some
            // later long-lived engine happened to sweep it: `gc` collected the
            // run in `control.db` and skipped it in `engine.db` for fifteen
            // seconds and six commands in the release validation.
            Effect.tap(() =>
              Effect.gen(function*() {
                yield* executorSettleCancelledPark(input.runId)
                // The engine can finish between the request and local interrupt,
                // or while settling an unowned park. Its read overlay alone does
                // not persist the control row or deliver the terminal watch event.
                const current = yield* getRun(input.runId)
                if (terminal(current.status)) yield* reconcileTerminal(input.runId, current.status)
              })
            )
          ))
      ),
      resume: Effect.fn("Control.resume")((input) => runMutation(input)),
      list,
      watch
    }
    return Control.of(service)
  })
)
