/**
 * The stall breaker: end a round loop that has stopped making progress.
 *
 * A round bound is only a budget. A loop whose rounds change nothing spends
 * the whole budget anyway: an agent that rewrites the same tree, a check that
 * fails the same way after every repair, a reviser that hands back the same
 * draft. This module counts consecutive rounds whose signal did not move and
 * reports a {@link Stalled} verdict once one signal has held for
 * `rounds` rounds in a row.
 *
 * Three signals are read, each optional per round:
 *
 * - `tree`: a fingerprint of the files the round left behind, such as a JJ
 *   tree id or a `TreeFingerprint` checksum.
 * - `checks`: the ids of the checks that failed. Order does not matter, and
 *   an empty list is not compared.
 * - `output`: the round's value, compared by the SHA-256 of its RFC 8785
 *   canonical JSON. A value with no canonical form is not compared.
 *
 * Everything here is data. The {@link State} a round carries forward is a
 * plain record, so a durable trampoline keeps it in its payload and a replay
 * reads the same verdict. The loop decides what `on` means: `stop` settles
 * with the stalled value, `park` settles the same way tagged for a caller
 * that hands it to a person (the coding correction reports it `blocked`),
 * and `escalate` fails.
 *
 * @since 1.0.0
 */

import { canonicalize } from "@smthrs/canonical"
import { digestSync } from "@smthrs/crypto"
import * as Schema from "effect/Schema"

/**
 * What a loop does once it has stalled.
 *
 * @category models
 * @since 1.0.0
 */
export const On = Schema.Literals(["stop", "park", "escalate"])

/**
 * The `on` values as a type.
 *
 * @category models
 * @since 1.0.0
 */
export type On = typeof On.Type

/**
 * The signal that held still.
 *
 * @category models
 * @since 1.0.0
 */
export const Signal = Schema.Literals(["tree", "checks", "output"])

/**
 * The signal names as a type.
 *
 * @category models
 * @since 1.0.0
 */
export type Signal = typeof Signal.Type

/**
 * A resolved stall policy: `rounds` identical rounds in a row, at least two,
 * trigger `on`.
 *
 * @category models
 * @since 1.0.0
 */
export const Policy = Schema.Struct({
  rounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  on: On
})

/**
 * A resolved policy as a type.
 *
 * @category models
 * @since 1.0.0
 */
export type Policy = typeof Policy.Type

/**
 * The authoring form of a {@link Policy}; `on` defaults to `"stop"`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly rounds: number
  readonly on?: On | undefined
}

/**
 * What one round reports. An absent signal is not compared and resets its
 * streak.
 *
 * @category models
 * @since 1.0.0
 */
export interface Observation {
  readonly tree?: string | undefined
  readonly checks?: ReadonlyArray<string> | undefined
  readonly output?: unknown
}

const Streak = Schema.NullOr(Schema.Struct({ key: Schema.String, rounds: Schema.Int }))

/**
 * The streak of every signal, carried from one round to the next.
 *
 * @category models
 * @since 1.0.0
 */
export const State = Schema.Struct({ tree: Streak, checks: Streak, output: Streak })

/**
 * The carried streaks as a type.
 *
 * @category models
 * @since 1.0.0
 */
export type State = typeof State.Type

/**
 * The state before the first round.
 *
 * @category constructors
 * @since 1.0.0
 */
export const initial: State = { tree: null, checks: null, output: null }

/**
 * The typed verdict: which signal held, for how many rounds, and what the
 * policy says to do.
 *
 * @category models
 * @since 1.0.0
 */
export const Stalled = Schema.Struct({
  _tag: Schema.Literal("Stalled"),
  signal: Signal,
  rounds: Schema.Int,
  on: On
})

/**
 * The verdict as a type.
 *
 * @category models
 * @since 1.0.0
 */
export type Stalled = typeof Stalled.Type

/**
 * Validates authoring options into a {@link Policy}. Throws a `RangeError`
 * for fewer than two rounds, since one round cannot repeat anything.
 *
 * @category constructors
 * @since 1.0.0
 */
export const policy = (options: Options): Policy => {
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 2) {
    throw new RangeError("Stall rounds must be a safe integer of at least 2")
  }
  return { rounds: options.rounds, on: options.on ?? "stop" }
}

// A value with no canonical form (an `Error`, a `bigint`) is not compared.
const hash = (value: unknown): string | undefined => {
  try {
    return digestSync(canonicalize(value ?? null))
  } catch {
    return undefined
  }
}

const keys = (observation: Observation): Record<Signal, string | undefined> => ({
  tree: observation.tree,
  // No failing check is not a repeated failure.
  checks: observation.checks === undefined || observation.checks.length === 0
    ? undefined
    : JSON.stringify([...new Set(observation.checks)].sort()),
  output: "output" in observation ? hash(observation.output) : undefined
})

const signals: ReadonlyArray<Signal> = ["tree", "checks", "output"]

/**
 * Folds one round into the state and reports whether the loop has stalled.
 *
 * Signals are judged in the order `tree`, `checks`, `output`; the first that
 * reached `policy.rounds` names the verdict.
 *
 * @category combinators
 * @since 1.0.0
 */
export const observe = (
  policy: Policy,
  state: State,
  observation: Observation
): { readonly state: State; readonly stalled: Stalled | undefined } => {
  const current = keys(observation)
  const next = Object.fromEntries(signals.map((signal) => {
    const key = current[signal]
    const prior = state[signal]
    return [signal, key === undefined ? null : { key, rounds: prior?.key === key ? prior.rounds + 1 : 1 }]
  })) as unknown as State
  const signal = signals.find((signal) => (next[signal]?.rounds ?? 0) >= policy.rounds)
  return {
    state: next,
    stalled: signal === undefined ? undefined : { _tag: "Stalled", signal, rounds: next[signal]!.rounds, on: policy.on }
  }
}
