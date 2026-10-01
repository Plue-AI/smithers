/**
 * Action dispatch: the ordinal allocation an invocation key is derived from,
 * the keyless-concurrency guard that refuses indistinguishable overlaps, the
 * compensable snapshot orchestration, and the engine's single retry decision
 * point.
 *
 * @since 0.1.0
 */

import { Action, Fault, Flow, FlowRuntime, RetryPolicy, StepIdentity } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { renderDiagnostic } from "../internal/Diagnostic.ts"
import { toJsonExit } from "../internal/JsonExit.ts"
import { actionKey, ordinalScope, uncanonicalKey } from "./ActionKey.ts"
import type { ActionExecuteOptions, Encoded } from "./Encoded.ts"
import { SnapshotBoundary, type SnapshotBoundaryOptions, SnapshotBoundaryRequired } from "./SnapshotBoundary.ts"

// An action can open an independent child flow. Only invocations in this same
// execution inherit its allocation scope; a child must replay the same keys
// when a different process resumes it without its original caller's context.
const CurrentActionParent = Context.Reference<
  {
    readonly executionId: string
    readonly key: string
  } | undefined
>("@smthrs/engine/CurrentActionParent", { defaultValue: () => undefined })

/**
 * Starts a flow body with its own dispatch context. A timer can wake a
 * suspended execution from inside an action; the new round must replay from
 * its root rather than inherit that action's parent, attempt or ordinal slot.
 * Composition-wide cache identity remains in the context.
 *
 * @private
 * @since 1.0.0
 */
export const resetActionContext = Context.omit(
  CurrentActionParent,
  Action.CurrentAttempt,
  Action.CurrentOrdinal,
  Action.CurrentInvocationKey,
  Action.CurrentHeartbeat,
  StepIdentity.DispatchSite,
  StepIdentity.DispatchReport
)

/**
 * Whether a failed attempt died of nothing but an expired attempt bound, the
 * one defect the retry decision treats as an attempt failure. The tag is read
 * off the defect so a replayed row, whose defect is the error's encoded
 * fields, is recognized like the live error.
 */
const timedOutOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) =>
    Cause.isDieReason(reason) && Predicate.isTagged(reason.defect, "@smthrs/flow/AttemptTimedOut")
  )

/**
 * Keeps an expired attempt a settlement even when the flow does not capture
 * defects, so the retry decision below still sees it.
 */
const settleTimedOut = <E, R>(
  effect: Effect.Effect<Flow.Result<unknown, unknown>, E, R>
): Effect.Effect<Flow.Result<unknown, unknown>, E, R> =>
  Effect.catchCause(effect, (cause) =>
    timedOutOnly(cause)
      ? Effect.succeed(new Flow.Complete({ exit: Exit.failCause(cause) }))
      : Effect.failCause(cause))

/**
 * Builds the typed `actionExecute` an engine answers with: it allocates the
 * dispatch's identity, admits it through the low-level seam, and owns the
 * retry decision made on the outcome.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeActionExecute = (options: Encoded) => {
  // The allocation scope is derived once by `actionExecute` below and passed
  // here, so the concurrent guard and the ordinal allocator cannot check
  // different identities. Untraced because action retries are a hot path
  // within a flow run.
  const dispatch = Effect.fnUntraced(function*<
    Success extends Schema.Constraint,
    Error extends Schema.Constraint,
    R
  >(action: Action.Action<Success, Error, R>, attempt: number, scope: string) {
    const instance = yield* FlowRuntime.FlowInstance
    // `Action.retry` hands down an empty slot map rather than a number:
    // the ordinal can only be allocated here, where the action — and so
    // its allocation scope — is known (issue #73). The slot is keyed by
    // scope so a retry block dispatching several distinct actions pins
    // each to its own ordinal (issue #84), reused across every attempt of
    // the sequence. Within one attempt the n-th dispatch of a scope takes
    // the n-th pinned ordinal (issue #100): a retry block may dispatch one
    // declaration several times, and each dispatch owns its own identity —
    // allocated on the attempt that first reaches it, replayed by position
    // on every later attempt.
    const slot = yield* Action.CurrentOrdinal
    let ordinal: number
    if (slot === undefined) {
      ordinal = instance.actionState.nextOrdinal(scope)
    } else {
      const index = slot.cursors.get(scope) ?? 0
      slot.cursors.set(scope, index + 1)
      const pinned = slot.values.get(scope) ?? []
      if (index < pinned.length) {
        ordinal = pinned[index]!
      } else {
        ordinal = instance.actionState.nextOrdinal(scope)
        pinned.push(ordinal)
        slot.values.set(scope, pinned)
      }
    }
    // Invocation keys are run-local, so the environment is not their key
    // material; `actionKey` folds it into cache keys only (issue #75).
    const environment = yield* Action.CurrentCacheEnvironment
    // `AnyWithProps` widening: `actionKey` needs the declared schemas so
    // the string-form sealed identity folds the compiled declaration
    // (issue #120); every action built by `Action.make` carries them,
    // only the `Schema.Constraint` type parameters resist the assignment.
    const deriveKey = (executionId: string, runScoped: boolean) =>
      actionKey(
        action as unknown as Action.AnyWithProps & Pick<Action.Any, "annotations">,
        executionId,
        ordinal,
        runScoped ? undefined : environment,
        scope
      )
    const keyResult = yield* Effect.result(
      options.actionReplayKey === undefined
        ? deriveKey(instance.executionId, false)
        : options.actionReplayKey(deriveKey)
    )
    // The scope can be valid while this subsequent Crypto digest fails.
    if (Result.isFailure(keyResult)) {
      return uncanonicalKey(action.name, keyResult.failure)
    }
    const key = keyResult.success
    const envelope = Context.getOption(action.annotations, Flow.EffectEnvelope)
    const repeatSafe = action.idempotencyKey !== undefined ||
      (Option.isSome(envelope) && envelope.value.writes.length === 0)
    // The irreversible guard also applies to default retries: a read envelope
    // cannot authorize repeating an unkeyed irreversible action.
    const defaultTransient = action.retryPolicy === undefined && repeatSafe &&
      (action.tier !== "irreversible" || action.idempotencyKey !== undefined)
    const policy = action.retryPolicy ?? (defaultTransient ? RetryPolicy.transient : undefined)
    // Elapsed retry time for the policy's expiration bound. Durable
    // drivers persist the first attempt's start time alongside the attempt
    // row and expose it through `actionRetryOrigin`, so the
    // schedule-to-close budget survives park/resume and process death
    // (issue #45, mirroring Temporal's persisted expiration interval). The
    // in-process clock is the fallback for engines without durable
    // attempts.
    const durableOrigin = policy?.expirationMs !== undefined &&
        options.actionRetryOrigin !== undefined
      ? yield* options.actionRetryOrigin({ key })
      : Option.none<number>()
    if (
      policy?.expirationMs !== undefined &&
      options.actionRetryOrigin !== undefined &&
      Option.isNone(durableOrigin)
    ) {
      // A durable driver that finds no surviving attempt row cannot bound
      // the schedule-to-close budget to the true first attempt. The engine
      // keeps the in-process fallback — failing the run outright would
      // turn benign attempt-row retention pruning into spurious failures —
      // but the restarted budget is worth a trace (issue #69).
      yield* Effect.logWarning(
        `FlowEngine.actionExecute: no durable retry origin for "${action.name}"; the expirationMs budget restarts from the current clock`
      )
    }
    const now = yield* Clock.currentTimeMillis
    const origin = Option.getOrUndefined(durableOrigin)
    const unusableOrigin = origin !== undefined && (!Number.isFinite(origin) || origin > now)
    if (unusableOrigin) {
      yield* Effect.logWarning(
        `FlowEngine.actionExecute: unusable durable retry origin for "${action.name}": ` +
          `reported ${String(origin)} while the current clock is ${now}; the expirationMs budget starts now`
      )
    }
    const usableOrigin = origin !== undefined && Number.isFinite(origin)
      ? Math.min(origin, now)
      : undefined
    const retryStartMs = usableOrigin ?? now
    // Resume the durable attempt counter (issue #59): a persisted attempt
    // sequence keeps its numbering across process death, so replayed
    // failed attempts do not re-sleep the backoff ladder from attempt 1
    // and the retry decision below sees the true attempt count.
    const latestAttempt = options.actionLatestAttempt !== undefined
      ? yield* options.actionLatestAttempt({ key })
      : Option.none<number>()
    const durableAttempt = Option.getOrUndefined(latestAttempt)
    const usableAttempt = durableAttempt !== undefined && Number.isSafeInteger(durableAttempt)
    if (durableAttempt !== undefined && !usableAttempt) {
      yield* Effect.logWarning(
        `FlowEngine.actionExecute: rejected unusable durable latest attempt for "${action.name}": ` +
          `${String(durableAttempt)} is not a safe integer; using caller attempt ${attempt}`
      )
    }
    let currentAttempt = usableAttempt && durableAttempt > attempt
      ? durableAttempt
      : attempt
    while (true) {
      if (
        action.tier === "irreversible" &&
        currentAttempt > 1 &&
        action.idempotencyKey === undefined
      ) {
        return yield* Effect.die(
          new Action.IrreversibleRetryRequiresIdempotencyKey({
            actionName: action.name,
            attempt: currentAttempt
          })
        )
      }
      const input: ActionExecuteOptions = {
        action,
        attempt: currentAttempt,
        key,
        tier: action.tier,
        ...(action.nondeterministic === undefined ? {} : { nondeterministic: action.nondeterministic }),
        metadata: action.metadata
      }
      let result: Flow.Result<unknown, unknown>
      if (action.tier === "compensable") {
        const boundaryOption = yield* Effect.serviceOption(SnapshotBoundary)
        if (Option.isNone(boundaryOption)) {
          return yield* Effect.die(
            new SnapshotBoundaryRequired({
              actionName: action.name,
              message: `Compensable action "${action.name}" requires SnapshotBoundary`
            })
          )
        }
        const boundary = boundaryOption.value
        const boundaryOptions: SnapshotBoundaryOptions = {
          flow: instance.flow,
          executionId: instance.executionId,
          key,
          attempt: currentAttempt,
          metadata: action.metadata
        }
        // A durable driver owns the journal check. Defer boundary work until
        // it asks to execute, so replay cannot replace the pre-crash handle
        // with a snapshot of the already-mutated world.
        const durableSnapshot = options.actionSnapshot
        let captured = Option.none<unknown>()
        const prepare = Effect.gen(function*() {
          const original = durableSnapshot !== undefined
            ? yield* durableSnapshot({ key })
            : currentAttempt > 1 && instance.actionState.snapshots.has(key)
            ? Option.some(instance.actionState.snapshots.get(key))
            : Option.none<unknown>()
          if (Option.isSome(original)) {
            yield* boundary.restore(original.value, boundaryOptions)
          }
          const snapshot = yield* boundary.snapshot(boundaryOptions)
          // Keep the earliest handle throughout the retry sequence.
          if (!instance.actionState.snapshots.has(key)) {
            instance.actionState.snapshots.set(key, snapshot)
          }
          captured = Option.some(snapshot)
          return snapshot
        })
        const dispatch = durableSnapshot === undefined
          ? prepare.pipe(
            Effect.andThen(
              options.actionExecute(input).pipe(Flow.attenuateCapabilities(Flow.capabilityCeilings(action.annotations)))
            )
          )
          : options.actionExecute({ ...input, snapshot: prepare }).pipe(
            Flow.attenuateCapabilities(Flow.capabilityCeilings(action.annotations))
          )
        result = yield* dispatch.pipe(
          settleTimedOut,
          Effect.ensuring(Effect.suspend(() =>
            Option.isSome(captured)
              ? Effect.asVoid(boundary.diff(captured.value, boundaryOptions))
              : Effect.void
          )),
          Effect.provideService(Action.CurrentAttempt, currentAttempt),
          Effect.provideService(CurrentActionParent, { executionId: instance.executionId, key }),
          Effect.provideService(Action.CurrentInvocationKey, key)
        )
      } else {
        result = yield* options.actionExecute(input).pipe(
          Flow.attenuateCapabilities(Flow.capabilityCeilings(action.annotations)),
          settleTimedOut
        ).pipe(
          Effect.provideService(Action.CurrentAttempt, currentAttempt),
          Effect.provideService(CurrentActionParent, { executionId: instance.executionId, key }),
          // DECIDED: the dispatch's own key is
          // handed to the implementation rather than left engine-private. An
          // implementation that names durable state of its own — `Sleep`
          // names a `DurableClock` — needs identity that is stable across
          // replays of one node and distinct between two identical calls,
          // and this key already is both: it is allocated here on EVERY
          // dispatch, including a replayed one, because the driver reached
          // through `options.actionExecute` addresses the recorded outcome
          // by it. Deriving a second identity in the implementation would
          // duplicate the allocation and drift from it; the attempt is
          // deliberately not folded in, so a retried wait rejoins the timer
          // it already armed.
          Effect.provideService(Action.CurrentInvocationKey, key)
        )
      }
      // Suspension is the action path's only non-exit settlement; the
      // narrowing is written as "not complete" so the flow-only handoff
      // variant needs no unreachable arm of its own.
      if (result._tag !== "Complete") {
        return result
      }
      const exit = yield* Effect.orDie(
        Schema.decodeEffect(action.exitSchemaPartial)(toJsonExit(result.exit)).pipe(
          // An action whose recorded outcome does not match its declared
          // schemas is a defect either way, but `orDie` alone reports only
          // the schema mismatch — "Expected /harness/HarnessError at
          // [cause][failures][0][error][_tag]" — and never the error that
          // actually occurred, which can leave a real failure (a refused
          // step boundary, say) undiagnosable. Naming the action and its
          // recorded exit turns that into one legible log line.
          Effect.tapError(() =>
            Effect.annotateLogs(
              Effect.logError("A recorded action outcome does not match the action's declared schemas"),
              { action: action.name, exit: renderDiagnostic(toJsonExit(result.exit)) }
            )
          )
        )
      )
      // The engine's single retry decision point. The delay is derived from
      // the attempt count — persisted by durable engines and passed back in
      // on resume — so a backoff sequence survives process death.
      // nonRetryable classification is evaluated here and nowhere else.
      // Defects and interruptions are not retried, with one exception: an
      // attempt that outlived its declared `attemptTimeoutMs` or
      // `heartbeatTimeoutMs` dies with `AttemptTimedOut`, and that is an
      // attempt failure the policy decides on like a typed one.
      const retryable = policy === undefined || exit._tag !== "Failure" || Cause.hasInterrupts(exit.cause)
        ? undefined
        : !Cause.hasDies(exit.cause)
        ? exit.cause.reasons.find(Cause.isFailReason)
        : timedOutOnly(exit.cause)
        ? exit.cause.reasons.find(Cause.isDieReason)
        : undefined
      const error = retryable === undefined ?
        undefined :
        Cause.isFailReason(retryable)
        ? retryable.error
        : retryable.defect
      if (
        policy !== undefined && retryable !== undefined &&
        (!defaultTransient || Fault.of(error).class === "infra")
      ) {
        const decision = yield* RetryPolicy.decideEffect(policy, {
          attempt: currentAttempt,
          error,
          elapsedMs: (yield* Clock.currentTimeMillis) - retryStartMs
        })
        if (decision._tag === "RetryAfter") {
          if (action.tier === "irreversible" && action.idempotencyKey === undefined) {
            return yield* Effect.die(
              new Action.IrreversibleRetryRequiresIdempotencyKey({
                actionName: action.name,
                attempt: currentAttempt + 1
              })
            )
          }
          yield* Effect.sleep(decision.delayMs)
          currentAttempt = currentAttempt + 1
          continue
        }
        // Exhaustion is a retry decision, not a change to the action's
        // declared error channel. Preserve the final business failure so
        // ordinary typed recovery (including a graph Catch) still runs.
        yield* Effect.annotateCurrentSpan({
          "retry.stopReason": decision.reason,
          "retry.attempt": currentAttempt
        })
        // nonRetryable: fall through and propagate the original failure.
      }
      return new Flow.Complete({ exit })
    }
  })
  return Effect.fnUntraced(function*<
    Success extends Schema.Constraint,
    Error extends Schema.Constraint,
    R
  >(action: Action.Action<Success, Error, R>, attempt: number) {
    // Ordinal-keyed invocations of one allocation scope are
    // allocation-ordered: with two in flight at once the ordinals — and so
    // the step keys, attempt rows, and recorded outcomes — would be
    // assigned by fiber arrival order, and a crash-resume replaying the
    // fibers in the opposite order would silently hand one invocation the
    // other's recorded outcome (issue #111). Interpreter graph nodes carry
    // replay-stable structural sites, so distinct nodes refine the scope
    // and may overlap. Indistinguishable dispatches — the same site, or
    // handler-driven calls with no site — still have no engine-visible
    // material to order them by (inputs live in the execute closure), so
    // the hazard is refused up front. A declared idempotencyKey also
    // distinguishes invocations when its values differ.
    // Only a sealed action with a key escapes the refusal: it takes a
    // pure cache key with no ordinal at all. A keyed action at any
    // other tier still resolves to an invocation key whose scope folds the
    // key, so two concurrent SAME-key dispatches share one scope and have
    // exactly the arrival-order hazard — and, nested in sibling retry
    // blocks under a shared outer block, the #116 private cursor views
    // would even hand both dispatches the same pinned ordinal (issue
    // #130). Distinct keys are distinct scopes and overlap freely.
    const dispatchSite = yield* Effect.serviceOption(StepIdentity.DispatchSite)
    const site = Option.getOrUndefined(dispatchSite)
    const scopeResult = yield* Effect.result(ordinalScope(action, site))
    if (Result.isFailure(scopeResult)) {
      return uncanonicalKey(action.name, scopeResult.failure)
    }
    // Each action implementation runs with a fresh instance and fresh ordinal
    // counters. Its enclosing invocation therefore refines the allocation
    // scope, or two parents' first nested dispatches would share one key.
    // Top-level keys and explicitly keyed sealed cache identities stay intact.
    const instance = yield* FlowRuntime.FlowInstance
    const parent = yield* CurrentActionParent
    const scope = parent !== undefined && parent.executionId === instance.executionId
      ? `${scopeResult.success}/p:${parent.key.length}:${parent.key}`
      : scopeResult.success
    const body = dispatch(action, attempt, scope)
    if (action.tier === "sealed" && action.idempotencyKey !== undefined) return yield* body
    const inFlight = instance.actionState.keylessInFlight
    // The acquire and its release live in one uninterruptible region
    // (issue #139): a bare `add` followed by `Effect.ensuring` left a
    // one-op window — after the add, before the finalizer registered —
    // where an interruption (a lost race, a timeout) leaked the scope
    // into the Set forever, so every later fully sequential dispatch of
    // the same scope falsely died `ConcurrentKeylessDispatch`.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        if (inFlight.has(scope)) return false
        inFlight.add(scope)
        return true
      }),
      (acquired) =>
        acquired
          ? body
          : Effect.die(
            new Action.ConcurrentKeylessDispatch({ actionName: action.name })
          ),
      (acquired) => acquired ? Effect.sync(() => inFlight.delete(scope)) : Effect.void
    )
  })
}
