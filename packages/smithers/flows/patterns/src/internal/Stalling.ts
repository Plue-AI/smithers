/**
 * The round loops' one use of `@smthrs/flow/Stall`: resolve the option, fold a
 * round in, and settle or escalate a stall, in both the declared and the
 * operational form.
 *
 * @since 1.0.0
 */

import * as Stall from "@smthrs/flow/Stall"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import { PatternError } from "../PatternError.ts"

/**
 * The operational option: a {@link Stall.Options} plus the signals a round
 * reports, which default to its output.
 *
 * @since 1.0.0
 * @private
 */
export interface RuntimeOptions<A> extends Stall.Options {
  readonly signals?: ((value: A) => Stall.Observation) | undefined
}

/**
 * Validates the option; `undefined` means no stall breaker.
 *
 * @since 1.0.0
 * @private
 */
export const resolve = (
  pattern: string,
  options: Stall.Options | undefined
): Stall.Policy | undefined | PatternError => {
  if (options === undefined) return undefined
  try {
    return Stall.policy(options)
  } catch {
    return new PatternError({
      code: "invalid_decorator",
      message: `${pattern} stall rounds must be a safe integer of at least 2`
    })
  }
}

/**
 * The failure an `escalate` policy raises.
 *
 * @since 1.0.0
 * @private
 */
export const escalated = (pattern: string, rounds: number): PatternError =>
  new PatternError({ code: "stalled", message: `${pattern} stalled: the same result for ${rounds} rounds in a row` })

/**
 * What a declared round compares: a module-level projection of its value,
 * named so the name, not the function, enters the step identity.
 *
 * @since 1.0.0
 * @private
 */
export interface Signal {
  readonly name: string
  readonly read: (value: unknown) => unknown
}

/**
 * The round's whole value.
 *
 * @since 1.0.0
 * @private
 */
export const output: Signal = { name: "output", read: (value) => value }

/**
 * The label field a stall policy adds; absent without one, so existing names
 * are unchanged.
 *
 * @since 1.0.0
 * @private
 */
export const labelOf = (policy: Stall.Policy | undefined): string | undefined =>
  policy === undefined ? undefined : `${policy.rounds}/${policy.on}`

/**
 * Operational fold: one call per round, returning the verdict once stalled.
 *
 * @since 1.0.0
 * @private
 */
export const tracker = <A>(
  policy: Stall.Policy | undefined,
  signals: (value: A) => Stall.Observation
): (value: A) => Stall.Stalled | undefined => {
  let state = Stall.initial
  return (value) => {
    if (policy === undefined) return undefined
    const next = Stall.observe(policy, state, signals(value))
    state = next.state
    return next.stalled
  }
}

interface Observed {
  readonly state: Stall.State
  readonly stalled: Stall.Stalled | null
}

/**
 * Declared fold: observes `value` against the carried `streaks` at run time
 * and branches. A stall settles through `settle` (or fails `stalled` under
 * `escalate`); otherwise `next` continues with the new streaks.
 *
 * The compared output is `signal.read` of the round's value; a declared loop
 * cannot carry a caller's callback with stable identity, so `signal` is a
 * pattern's own module-level projection and its `name` enters the capture.
 *
 * @since 1.0.0
 * @private
 */
export const guard = <R>(
  pattern: string,
  policy: Stall.Policy,
  identity: Readonly<Record<string, unknown>>,
  value: unknown,
  streaks: Planned.Planned<Stall.State> | Stall.State,
  signal: Signal,
  arms: {
    readonly settle: (stalled: Planned.Planned<Stall.Stalled>) => Node.Node<unknown, unknown, R>
    readonly next: (streaks: Planned.Planned<Stall.State>) => Node.Node<unknown, unknown, R>
  }
): Node.Node<unknown, unknown, R> => {
  const captured = { ...identity, stall: policy, signal: signal.name }
  const observed = Node.map(
    // Planned references resolve to the real values at run time.
    Node.succeed({ value, streaks } as { readonly value: unknown; readonly streaks: Stall.State }),
    Node.capture(captured, ({ value, streaks }): Observed => {
      const next = Stall.observe(policy, streaks, { output: signal.read(value) })
      return { state: next.state, stalled: next.stalled ?? null }
    })
  )
  return Node.branch(observed, {
    if: Node.capture(captured, (verdict: Observed) => verdict.stalled !== null),
    then: (verdict: Planned.Planned<Observed>) =>
      policy.on === "escalate"
        ? Node.fail(escalated(pattern, policy.rounds))
        : arms.settle(verdict.stalled as Planned.Planned<Stall.Stalled>),
    else: (verdict: Planned.Planned<Observed>) => arms.next(verdict.state)
  })
}
