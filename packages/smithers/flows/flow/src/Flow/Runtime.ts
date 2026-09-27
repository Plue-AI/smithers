// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Runtime helpers for flow completion, suspension, scopes, and rollback.
 *
 * @since 0.1.0
 */

import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Filter from "effect/Filter"
import { dual, identity } from "effect/Function"
import * as Scope from "effect/Scope"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import { CaptureDefects, SuspendOnFailure } from "./Annotations.ts"
import { Complete, isResult, type Result, Suspended } from "./Result.ts"

/**
 * Runs an effect as a flow execution and converts its outcome into a
 * `Result`, handling suspension, defect capture, interruption, and flow
 * scope finalization.
 *
 * @category results
 * @since 0.1.0
 */
export const intoResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  Result<A, E>,
  never,
  Exclude<R, Scope.Scope> | FlowInstance
> =>
  Effect.contextWith((context: Context.Context<FlowInstance>) => {
    const instance = Context.get(context, FlowInstance)
    const captureDefects = Context.get(instance.flow.annotations, CaptureDefects)
    const suspendOnFailure = Context.get(instance.flow.annotations, SuspendOnFailure)
    return effect.pipe(
      // so we can use external interruption to suspend the flow
      Effect.forkChild({ startImmediately: true }),
      Effect.flatMap((fiber) => Effect.onInterrupt(Fiber.join(fiber), () => Fiber.interrupt(fiber))),
      Effect.interruptible,
      suspendOnFailure
        ? Effect.catchCause((cause) => {
          instance.suspended = true
          if (!Cause.hasInterruptsOnly(cause)) {
            instance.cause = Cause.die(Cause.squash(cause))
          }
          return Effect.interrupt
        })
        : identity,
      Effect.scoped,
      Effect.matchCauseEffect({
        // A body that handed off produced no answer of its own, so the slot
        // the handoff was recorded in wins over the value the handler returned
        // (`docs/concepts/trampoline-rounds.md`).
        onSuccess: (value) =>
          Effect.succeed(
            instance.handoff ?? new Complete({ exit: Exit.succeed(value) })
          ),
        onFailure: (cause): Effect.Effect<Result<A, E>> => {
          const [reasons, interrupts] = Arr.partition(
            cause.reasons,
            Filter.fromPredicate(Cause.isInterruptReason)
          )
          const hasInterruptsOnly = interrupts.length === cause.reasons.length
          const filtered = reasons.length === 0 ? cause : Cause.fromReasons(reasons)
          return instance.suspended && hasInterruptsOnly
            ? Effect.succeed(new Suspended({ cause: instance.cause }))
            : (!instance.interrupted && hasInterruptsOnly) ||
                (!captureDefects && Cause.hasDies(cause))
            ? Effect.failCause(filtered as Cause.Cause<never>)
            : Effect.succeed(new Complete({ exit: Exit.failCause(filtered) }))
        }
      }),
      (eff) =>
        Effect.onExitPrimitive(eff, (exit) => {
          if (Exit.isFailure(exit)) {
            return Scope.close(instance.scope, exit)
          } else if (exit.value._tag === "Complete") {
            return Scope.close(instance.scope, exit.value.exit)
          } else if (exit.value._tag === "Handoff") {
            // A handoff ends this round for good — the next round is a separate
            // execution with its own instance and its own scope — so the round's
            // scope closes here exactly as a completion closes it. A suspension
            // is the only settlement that keeps the scope open.
            return Scope.close(instance.scope, Exit.void)
          }
          return Effect.void
        }, true),
      Effect.uninterruptible
    )
  })

/**
 * The action regions open on the current fiber's dynamic call stack.
 *
 * `actionState.count` says how many regions are open on an instance; it does
 * not say which of them the current region is nested inside. That difference is
 * the whole of {@link wrapActionResult}'s liveness: a region that suspends
 * waits for the *other* open regions to settle, and an enclosing region can
 * never settle before the region inside it returns. Carrying the enclosing
 * instances in the context is what lets a suspension tell a sibling — which
 * will settle — from an ancestor, which is waiting on the very fiber that is
 * waiting on it.
 *
 * It is a context reference rather than a fiber-local counter because the chain
 * crosses fibers: {@link intoResult} forks the body, and an engine gives every
 * action dispatch a fiber of its own. Context propagates to forked children;
 * a per-fiber counter would restart at each fork and read every ancestor as a
 * sibling again.
 */
const EnclosingActions = Context.Reference<ReadonlyArray<FlowInstance["Service"]>>(
  "@smthrs/flow/Flow/EnclosingActions",
  { defaultValue: () => [] }
)

/**
 * Wraps an action-like effect so flow suspension waits for currently
 * running actions to finish or suspend.
 *
 * The wait is for *siblings*. An action that suspends holds work its siblings
 * have not journaled yet, so the flow must not park out from under them; an
 * enclosing region holds no such work, because everything it is doing is this
 * region. Waiting for one is a deadlock, and it was a real one: a harness cell
 * call is an action, the `wait` flow it dispatches awaits a `DurableClock`
 * under the run's own instance, and the round that should have parked instead
 * blocked forever inside an uninterruptible finalizer — not cancellable, not
 * resumable, and invisible in the journal past the `clock-scheduled` record.
 *
 * @category results
 * @since 0.1.0
 */
export const wrapActionResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  isSuspend: (value: A) => boolean
): Effect.Effect<A, E, R | FlowInstance> =>
  Effect.contextWith((context: Context.Context<FlowInstance>) => {
    const instance = Context.get(context, FlowInstance)
    const enclosing = Context.getUnsafe(context, EnclosingActions)
    // How many of the regions counted on this instance are this one's own
    // ancestors, and so how many of them will still be open once every sibling
    // has settled.
    let ancestors = 0
    for (const open of enclosing) if (open === instance) ancestors++
    const state = instance.actionState
    if (state.count === 0) state.latch.closeUnsafe()
    state.count++
    return Effect.onExit(
      Effect.provideService(effect, EnclosingActions, [...enclosing, instance]),
      (exit) => {
        state.count--
        const isSuspended = Exit.isSuccess(exit) && isSuspend(exit.value)
        if (
          Exit.isSuccess(exit) &&
          isResult(exit.value) &&
          exit.value._tag === "Suspended" &&
          exit.value.cause
        ) {
          instance.cause = instance.cause
            ? Cause.combine(instance.cause, exit.value.cause)
            : exit.value.cause
        }
        if (state.count === 0) return state.latch.open
        // Every decrement can satisfy a waiter whose threshold is not zero, so
        // the waiters are released to re-test their own. `release` wakes them
        // without opening the latch, so the ones still short of their threshold
        // park again on the next turn of the loop.
        return isSuspended
          ? Effect.andThen(state.latch.release, waitForSiblings(instance, ancestors))
          : Effect.asVoid(state.latch.release)
      }
    )
  })

// Untraced because this latch loop is a flow scheduler hot path.
const waitForSiblings = Effect.fnUntraced(function*(
  instance: FlowInstance["Service"],
  ancestors: number
) {
  const state = instance.actionState
  while (true) {
    if (state.count > ancestors) {
      yield* state.latch.await
      yield* Effect.yieldNow
      continue
    }
    yield* Effect.yieldNow
    if (state.count <= ancestors) return
  }
})

/**
 * Accesses the current round's flow scope. Suspension keeps it open;
 * completion or handoff closes it.
 *
 * @category resource management
 * @since 0.1.0
 */
export const scope: Effect.Effect<
  Scope.Scope,
  never,
  FlowInstance
> = Effect.map(
  FlowInstance,
  (instance) => instance.scope as Scope.Scope
)

/**
 * Provides the current round's flow scope to the given effect. Suspension keeps
 * the scope open; completion or handoff closes it.
 *
 * @category resource management
 * @since 0.1.0
 */
export const provideScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | FlowInstance> =>
  Effect.flatMap(scope, (scope) => Scope.provide(effect, scope))

/**
 * Adds an exit finalizer to the current flow scope, preserving the
 * services available when the finalizer is registered.
 *
 * @category resource management
 * @since 0.1.0
 */
export const addFinalizer: <R>(
  f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
) => Effect.Effect<
  void,
  never,
  FlowInstance | R
> =
  // Untraced because suspension recursively re-enters flow execution.
  Effect.fnUntraced(function*<R>(
    f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
  ) {
    const instance = yield* FlowInstance
    const services = yield* Effect.context<R>()
    yield* Scope.addFinalizerExit(instance.scope, (exit) => Effect.provideContext(f(exit), services))
  })

/**
 * Runs an effect and registers how to undo its successful result if the
 * current round later exits unsuccessfully.
 *
 * **When to use**
 *
 * Use when a top-level flow operation changes something that must be undone if
 * a later operation causes the same round to fail or be interrupted.
 *
 * **Details**
 *
 * The effect runs first. If it fails, no rollback is registered. If it
 * succeeds, its value is captured in a round-scope finalizer. The finalizer does
 * nothing when the round succeeds; when the round exits unsuccessfully
 * it calls `rollback(value, cause)`. Suspension keeps that scope open.
 *
 * A handoff completes the round successfully and discards its `withRollback` registrations.
 * A later round's failure cannot invoke those rollbacks. The engine does not
 * provide lineage-scoped compensation.
 *
 * **Gotchas**
 *
 * This applies only to effects run directly inside the flow execution. It does
 * not attach rollback behavior to nested actions. The rollback's typed error
 * channel is `never`; handle expected rollback failures inside the callback.
 *
 * @category resource management
 * @since 0.1.0
 */
export const withRollback: {
  <A, R2>(
    rollback: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): <E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope>
  <A, E, R, R2>(
    effect: Effect.Effect<A, E, R>,
    rollback: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope>
} = dual(2, <A, E, R, R2>(
  effect: Effect.Effect<A, E, R>,
  rollback: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
): Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.tap(
      restore(effect),
      (value) => addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : rollback(value, exit.cause))
    )
  ))

/**
 * Marks a flow instance as suspended and interrupts the current fiber to
 * stop execution until it is resumed.
 *
 * @category results
 * @since 0.1.0
 */
export const suspend = (instance: FlowInstance["Service"]): Effect.Effect<never> =>
  Effect.interruptible(Effect.callback<never>(() => {
    instance.suspended = true
    const fiber = Fiber.getCurrent()!
    fiber.interruptUnsafe(fiber.id)
  }))
