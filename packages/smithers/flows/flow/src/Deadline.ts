/**
 * The wall-clock bound one run of a flow settles by.
 *
 * A deadline counts from the run's FIRST start, which is journaled, so it
 * survives park, resume and process death: a restarted engine honors the
 * original deadline instead of starting a new one. A trampoline lineage is one
 * run, so its rounds share one deadline: the round that hands off stamps the
 * lineage's start and bound on the {@link module:Result.Handoff}, and the next
 * round runs under that stamp rather than starting a clock of its own. Like
 * `maxRounds`, the bound belongs to the lineage originator; a handoff target
 * cannot reset or replace it.
 *
 * The engine applies {@link bound} to every execution of a flow that declares
 * `Flow.make(tag, { deadline })`. A control plane applies it inside a run body
 * to bound a run by an approved envelope's deadline. Both settle an expired
 * run with the same {@link module:DeadlineExceeded.DeadlineExceeded} defect.
 *
 * @since 1.0.0
 */

import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableClock from "./DurableClock.ts"
import { DeadlineExceeded } from "./Flow/DeadlineExceeded.ts"
import { Handoff, type LineageDeadline } from "./Flow/Result.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"

/**
 * The execution's first start, journaled once.
 *
 * A sealed action's result is recorded with its attempt and replayed on every
 * later drive, so the origin a deadline counts from is the time the execution
 * first ran, on this engine or on the one that resumes it after a restart.
 */
const origin = Action.make({
  name: "@smthrs/engine/deadline-origin",
  tier: "sealed",
  success: Schema.Number,
  execute: Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
})

/**
 * Starts the current execution's deadline: the lineage deadline this round
 * inherited from a handoff, or `deadline` counted from the execution's
 * journaled first start, or from `startedAtMs` when the host supplies a
 * durable start of its own. Answers `undefined` when neither applies, which is
 * an unbounded execution.
 *
 * **Details**
 *
 * The first start is a sealed action, so every later drive of the execution,
 * on this engine or one that resumes it after a restart, reads the same
 * origin. A durable clock is armed at the deadline so a parked execution is
 * driven again when it passes; the clock keeps the due time it was first armed
 * with, so arming it on every drive is idempotent.
 *
 * **Gotchas**
 *
 * Start at most one deadline per execution, before any other dispatch that a
 * replay must line up with: the origin and the clock are addressed by fixed
 * names within the execution.
 *
 * @category constructors
 * @since 1.0.0
 */
export const start = (options: {
  /** The flow the refusal names. */
  readonly flowName: string
  /** The bound; a positive finite duration. Absent means unbounded. */
  readonly deadline?: Duration.Input | undefined
  /**
   * Where the bound counts from, when the host already holds a durable
   * start of its own, such as the time a control plane accepted the run.
   * Absent, the execution's first start is journaled and read back.
   */
  readonly startedAtMs?: number | undefined
}): Effect.Effect<LineageDeadline | undefined, never, FlowRuntime | FlowInstance | Crypto.Crypto> =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    let lineage = instance.lineageDeadline
    if (lineage === undefined) {
      if (options.deadline === undefined) return undefined
      const deadlineMs = Option.match(Duration.fromInput(options.deadline), {
        onNone: () => Number.NaN,
        onSome: Duration.toMillis
      })
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        return yield* Effect.die(
          new RangeError(`Deadline.start: "${options.flowName}" deadline must be a positive finite duration`)
        )
      }
      lineage = { startedAtMs: options.startedAtMs ?? (yield* origin), deadlineMs }
    }
    const remaining = yield* remainingMs(lineage)
    if (remaining > 0) {
      yield* (yield* FlowRuntime).scheduleClock(instance.flow, {
        executionId: instance.executionId,
        clock: DurableClock.make({ name: "@smthrs/engine/deadline", duration: remaining })
      })
    }
    return lineage
  })

/**
 * The whole milliseconds left before `deadline` passes, as the durable clock
 * row stores its due time; zero or less once it has passed.
 *
 * @category getters
 * @since 1.0.0
 */
export const remainingMs = (deadline: LineageDeadline): Effect.Effect<number> =>
  Effect.map(Clock.currentTimeMillis, (now) => Math.ceil(deadline.startedAtMs + deadline.deadlineMs - now))

/**
 * Runs `body` within a started deadline.
 *
 * A body that starts at or past the deadline settles at once, and one that
 * starts before it races the time remaining in this fiber, so a running
 * execution is stopped too. Both settle with the same `DeadlineExceeded`
 * defect. The race is `raceFirst`: a body that parks exits first, so parking
 * still parks. A round that hands off stamps the deadline on its handoff, so
 * the next round of the lineage runs under it. An `undefined` deadline runs
 * `body` unbounded.
 *
 * @category combinators
 * @since 1.0.0
 */
export const within =
  (deadline: LineageDeadline | undefined, flowName: string) =>
  <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | FlowInstance> =>
    deadline === undefined ? body : Effect.gen(function*() {
      const instance = yield* FlowInstance
      const expired = new DeadlineExceeded({
        flowName,
        executionId: instance.executionId,
        deadlineMs: deadline.deadlineMs,
        startedAtMs: deadline.startedAtMs,
        message: `${flowName} execution ${instance.executionId} ran past its ${deadline.deadlineMs} ms deadline, ` +
          `counted from its start at ${new Date(deadline.startedAtMs).toISOString()}`
      })
      const remaining = yield* remainingMs(deadline)
      if (remaining <= 0) return yield* Effect.die(expired)
      const value = yield* Effect.raceFirst(body, Effect.andThen(Effect.sleep(remaining), Effect.die(expired)))
      const handoff = instance.handoff
      if (handoff !== undefined && handoff.deadline === undefined) {
        instance.handoff = new Handoff({
          flow: handoff.flow,
          payload: handoff.payload,
          ...(handoff.capabilityCeilings === undefined ? {} : { capabilityCeilings: handoff.capabilityCeilings }),
          deadline
        })
      }
      return value
    })

/**
 * Bounds the current execution by `deadline`, counted from its journaled first
 * start, or by the lineage deadline this round inherited from a handoff:
 * {@link start}, then {@link within}.
 *
 * A round that inherited a lineage deadline runs under it whatever it
 * declares, so every round of a lineage expires at the originator's time. With
 * no inherited deadline and `deadline` absent, the body runs unbounded.
 *
 * @category combinators
 * @since 1.0.0
 */
export const bound = (options: {
  /** The flow the refusal names. */
  readonly flowName: string
  /** The bound; a positive finite duration. Absent means unbounded. */
  readonly deadline?: Duration.Input | undefined
  /** Where the bound counts from; see {@link start}. */
  readonly startedAtMs?: number | undefined
}) =>
<A, E, R>(
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | FlowRuntime | FlowInstance | Crypto.Crypto> =>
  Effect.flatMap(start(options), (deadline) => within(deadline, options.flowName)(body))
