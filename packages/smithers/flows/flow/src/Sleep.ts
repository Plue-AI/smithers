/**
 * The system timer, as an ordinary declared action.
 *
 * `docs/concepts/flows-and-actions.md` names the timer primitive a
 * gap and says how to close it: ship it over the existing `DurableClock`, so a
 * wait is a visible, keyed plan node rather than a second execution mechanism.
 * That is this module. {@link action} is a plain `Action.make` declaration —
 * it appears in a catalog, `.call()` records a node, and `Graph.build` puts that
 * node in the plan beside every other step — and {@link layer} is the
 * implementation the hosts that can run a timer provide.
 *
 * The wait itself is `DurableClock`'s, not a new one. The implementation arms
 * the durable clock and awaits its deferred, which is what parks the execution;
 * the park is declared through the ordinary waiting vocabulary
 * ({@link module:WaitingAnnotation.annotateWaiting}) under `timer`, with the
 * deadline as `wakeAt`, so a durable driver records the same waiting row it
 * records for a hand-written `DurableClock.sleep`. Replay is the deferred's:
 * once the clock has fired, its result is persisted, so a re-driven round reads
 * it and runs straight through instead of parking a second time.
 *
 * Which clock a wait arms is the dispatch's own, read from
 * {@link module:Context.CurrentInvocationKey}: a keyed node already owns an
 * identity that survives replay and separates two identical calls, so the timer
 * inherits it rather than being addressed by the payload it was called with.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableClock from "./DurableClock.ts"
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import { annotateWaiting } from "./FlowRuntime/WaitingAnnotation.ts"

/**
 * A sleep whose payload does not name exactly one deadline.
 *
 * A payload carries a relative `millis` or an absolute `until`, and naming
 * both, or neither, leaves no deadline to arm a clock with. It is a typed
 * failure rather than a defect because the payload of a driven node is
 * assembled from plan values, so an author's mistake is recoverable through
 * `Node.catch` like any other declared failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class SleepRequestInvalid extends Schema.TaggedError<SleepRequestInvalid>()(
  "@smthrs/flow/SleepRequestInvalid",
  {
    code: Schema.Literals(["missing_deadline", "ambiguous_deadline", "invalid_deadline"]),
    message: Schema.String
  }
) {}

/**
 * The tag the sleep declaration is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const tag = "system/sleep"

/**
 * The declared sleep action: `millis` from now, or an absolute `until`.
 *
 * **When to use**
 *
 * Use it in a body wherever a round has to wait for time to pass —
 * `Sleep.action.call({ millis: 60_000 })` — rather than reaching for
 * `DurableClock.sleep`, which is only callable from a handler and leaves
 * nothing in the plan. A sleep node is keyed, inspectable, and skippable by a
 * branch exactly like an action that does work.
 *
 * Two waits of the same length are two waits: `sleep(1h)` followed by
 * `sleep(1h)` sleeps for two hours, because each call is its own node with its
 * own identity, exactly as two calls of any other declaration are.
 *
 * @category constructors
 * @since 0.1.0
 */
export const action: Action.Declared<
  typeof tag,
  Schema.Struct<{
    readonly millis: Schema.optional<Schema.Number>
    readonly until: Schema.optional<Schema.Number>
  }>,
  typeof Schema.Void,
  typeof SleepRequestInvalid,
  never
> = Action.makeSystem(tag, {
  payload: {
    millis: Schema.optional(Schema.Number),
    until: Schema.optional(Schema.Number)
  },
  success: Schema.Void,
  error: SleepRequestInvalid,
  tier: "sealed"
})

/**
 * The absolute deadline a payload names, in epoch milliseconds.
 *
 * DECIDED: a payload names EXACTLY one of `millis`
 * and `until`, and both other shapes are refused rather than resolved by
 * precedence. A precedence rule would silently ignore half of a payload an
 * author believed in, and the two fields are the same fact stated two ways, so
 * there is no shape where carrying both is meaningful.
 *
 * `Duration.millis` accepts every number, so an unchecked deadline changes the
 * sleep instead of refusing it. `NaN` becomes zero, a negative relative delay
 * has already passed, and `Infinity` never ends. The implementation rejects
 * those values before it annotates the instance or arms a clock. A finite
 * absolute `until` remains legal when it is in the past because that sleep can
 * settle immediately.
 *
 * @private
 */
const deadlineOf = (
  payload: { readonly millis?: number | undefined; readonly until?: number | undefined },
  now: number
): Effect.Effect<number, SleepRequestInvalid> => {
  if (payload.millis !== undefined && payload.until !== undefined) {
    return Effect.fail(
      new SleepRequestInvalid({
        code: "ambiguous_deadline",
        message: `${tag} was called with both "millis" and "until". A sleep names one deadline: ` +
          "a relative duration, or an absolute epoch time."
      })
    )
  }
  if (payload.millis !== undefined) {
    if (!Number.isFinite(payload.millis) || payload.millis < 0) {
      return Effect.fail(
        new SleepRequestInvalid({
          code: "invalid_deadline",
          message: `${tag} was called with millis ${payload.millis}. A deadline is a finite number of ` +
            "milliseconds that is not negative; the sleep would be over before it started, or never over at all."
        })
      )
    }
    const deadline = now + payload.millis
    if (!Number.isFinite(deadline)) {
      return Effect.fail(
        new SleepRequestInvalid({
          code: "invalid_deadline",
          message: `${tag} was called with millis ${payload.millis} at current time ${now}, which produces ` +
            `${deadline}. A deadline is a finite epoch time in milliseconds.`
        })
      )
    }
    return Effect.succeed(deadline)
  }
  if (payload.until !== undefined) {
    return Number.isFinite(payload.until)
      ? Effect.succeed(payload.until)
      : Effect.fail(
        new SleepRequestInvalid({
          code: "invalid_deadline",
          message:
            `${tag} was called with until ${payload.until}. A deadline is a finite epoch time in milliseconds; ` +
            "the sleep must end at a real point in time."
        })
      )
  }
  return Effect.fail(
    new SleepRequestInvalid({
      code: "missing_deadline",
      message: `${tag} was called with neither "millis" nor "until", so there is no deadline to wait for.`
    })
  )
}

/**
 * The durable clock the dispatch currently executing arms.
 *
 * DECIDED: the name is derived from the ENGINE's
 * per-dispatch identity — the invocation key it already allocated — rather than
 * from the payload. A durable clock's deferred is addressed by (execution,
 * name), so the name has to be stable across replays of one node and distinct
 * between two identical nodes, and the invocation key is exactly that: it is
 * allocated on every dispatch including a replayed one, because the driver
 * addresses the recorded outcome by it. A payload-derived name has only the
 * first property — `sleep(1h); work(); sleep(1h)` would address ONE wake and
 * sleep once — and closing that with a discriminator in the payload would make
 * an author carry identity that a keyed plan node already has.
 *
 * DECIDED: a runtime that supplies no dispatch
 * identity is refused as a defect rather than falling back to the payload. The
 * fallback is unobservable in the one-wait case and silently collapses two
 * waits in every other, so it would trade a wiring error a host fixes once for
 * a run that quietly sleeps for half as long as it declared.
 *
 * @private
 */
const clockName: Effect.Effect<string> = Effect.gen(function*() {
  const invocation = yield* Action.CurrentInvocationKey
  if (invocation === undefined) {
    return yield* Effect.die(
      `${tag} ran under a runtime that supplies no Action.CurrentInvocationKey. ` +
        "A durable timer is named by the dispatch that armed it, so a runtime that does not " +
        "identify the dispatch cannot arm one."
    )
  }
  return `Sleep/${invocation}`
})

/**
 * The sleep implementation: arm the durable clock, park under `timer`, wake.
 *
 * Provide it beside the other action implementation layers a body calls, over
 * the {@link module:Implementations.layerImplementations} table they file
 * themselves in:
 *
 * ```ts
 * Layer.mergeAll(Sleep.layer, Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime> = action.toLayer((payload) =>
  Effect.gen(function*() {
    // Whole milliseconds, both of them. A durable deadline lands in an INTEGER
    // column whose CHECK constraint refuses anything else
    // (`flows_runs.waiting_wake_at_ms`, `flows_clock_deadlines.due_at_ms`), and
    // `Clock.currentTimeMillis` is not integral under every clock: a test clock
    // advanced by a fractional-millisecond sleep reports a fractional now, and
    // a fractional `millis` or `until` in the payload does the same. The
    // unrounded deadline reached the park write as a raw SQL constraint
    // failure, which killed the drive and left the run `running` with nothing
    // left to wake it. `now` floors, and the deadline ceils so a rounded sleep
    // never ends before the instant it was asked to wait for.
    const now = Math.floor(yield* Clock.currentTimeMillis)
    const wakeAt = Math.ceil(yield* deadlineOf(payload, now))
    const remaining = wakeAt - now
    // DECIDED: a deadline that has already passed
    // settles the node instead of parking it. A durable wait exists to survive
    // the gap until a deadline, and a run that resumes after its own deadline
    // has to make progress rather than park again on a timer that can only fire
    // in the past.
    if (remaining <= 0) return
    const name = yield* clockName
    // DECIDED: the park is declared rather than
    // left to a driver's derivation, so a host with no clock table still parks
    // under `timer`. A `millis` deadline is recomputed from the current clock,
    // so a round re-driven before its timer fires re-declares a `wakeAt` later
    // than the armed one; the wake itself is unaffected, because the durable
    // clock row is keyed by name and keeps the deadline it was first armed
    // with, and `wakeAt` is a sweeper hint rather than the wake.
    yield* annotateWaiting({ reason: "timer", wakeAt })
    yield* DurableClock.sleep({
      name,
      duration: Duration.millis(remaining),
      // The wait is the point: a sleep called as a plan node parks the
      // execution rather than holding a fiber open, so the in-memory shortcut
      // is disabled instead of being left at its 60-second default.
      inMemoryThreshold: Duration.zero
    })
  })
)
