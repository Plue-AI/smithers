/**
 * Run a cheap shadow beside the primary and measure the gap.
 *
 * A sidecar answers one question: would the cheaper model have been good
 * enough? It runs both over the same input, concurrently, and scores them.
 * The shadow is an experiment, so its failure is quarantined and the primary
 * result stands. The primary is not: a sidecar is not a fallback ladder, and a
 * failed primary is a failed run. {@link Escalation} is the pattern for
 * alternatives.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * The declared form of a sidecar.
 *
 * @category models
 * @since 0.1.0
 */
export type SidecarFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Configuration for {@link make}.
 *
 * Omit `score` for a sidecar that only records the shadow output for later
 * comparison.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly primary: Member<R>
  readonly shadow: Member<R>
  readonly score?: Member<R> | undefined
}

/**
 * The two scores a comparison produces.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scores {
  readonly primary: number
  readonly shadow: number
}

/**
 * A scored comparison of the primary against its shadow.
 *
 * `difference` is `primary - shadow`, so a positive difference means the
 * expensive run was better. `cheaperWins` is the finding a sidecar exists to
 * produce: the shadow matched or beat the primary, and the cheaper seat is a
 * candidate for the real work.
 *
 * Both scores and their computed difference are always finite numbers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Delta extends Scores {
  readonly difference: number
  readonly cheaperWins: boolean
}

/**
 * The shadow's outcome, quarantined when it failed.
 *
 * A quarantined shadow carries its `Cause`, so an operator can read what the
 * experiment did without the run having failed. The declared form
 * ({@link make}) carries `error` instead: a recovery arm is planned against the
 * typed error the shadow may fail with, and only a running fiber has the whole
 * cause.
 *
 * @category models
 * @since 0.1.0
 */
export type Shadow<S> =
  | { readonly quarantined: false; readonly value: S }
  | { readonly quarantined: true; readonly cause: Cause.Cause<unknown> }

/**
 * The outcome of one sidecar run.
 *
 * `delta` is absent when no scorer is configured and when the shadow was
 * quarantined, because there is nothing to compare against.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<P, S> {
  readonly primary: P
  readonly shadow: Shadow<S>
  readonly delta?: Delta | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * `score` receives both outputs and is called only when the shadow produced
 * one. Its failure is the run's failure: an unreadable measurement is worse
 * than no measurement. Both returned scores and their computed difference
 * must be finite, or `run` fails with a `PatternError`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, P, S, E, R, E2, R2, E3 = never, R3 = never> {
  readonly primary: (input: I) => Effect.Effect<P, E, R>
  readonly shadow: (input: I) => Effect.Effect<S, E2, R2>
  readonly score?:
    | ((input: { readonly primary: P; readonly shadow: S }) => Effect.Effect<Scores, E3, R3>)
    | undefined
}

// Reads one field of a joined value. During planning the value is symbolic and
// the read answers a reference the plan records; during execution it answers
// the field. Both directions matter: the plan must show which half of the join
// the scorer reads, and the run must actually read it.
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key]

// Scores are data an evaluator returned, so a non-finite one is an input
// fault rather than a declaration fault.
const scoreRefusal = (primary: number, shadow: number): PatternError | undefined => {
  if (!Number.isFinite(primary)) {
    return new PatternError({
      code: "invalid_input",
      message: `Sidecar primary score must be a finite number, received ${primary}`
    })
  }
  if (!Number.isFinite(shadow)) {
    return new PatternError({
      code: "invalid_input",
      message: `Sidecar shadow score must be a finite number, received ${shadow}`
    })
  }
  const difference = primary - shadow
  return Number.isFinite(difference)
    ? undefined
    : new PatternError({
      code: "invalid_input",
      message: `Sidecar score difference must be a finite number, received ${difference}`
    })
}

const measuredDelta = (primary: number, shadow: number): Delta => ({
  primary,
  shadow,
  difference: Number((primary - shadow).toFixed(12)),
  cheaperWins: shadow >= primary
})

/**
 * Compares two scores.
 *
 * The subtraction is rounded to twelve decimal places, because a raw
 * floating-point difference reports `0.30000000000000004` for two scores an
 * operator entered as `0.8` and `0.5`. A tie counts as `cheaperWins`: equal
 * quality at lower cost is the cheaper seat winning.
 * Both scores and the difference must be finite.
 *
 * @category combinators
 * @since 0.1.0
 */
export const delta = (primary: number, shadow: number): Delta => {
  const refusal = scoreRefusal(primary, shadow)
  if (refusal !== undefined) throw refusal
  return measuredDelta(primary, shadow)
}

/**
 * Declares the sidecar topology: primary and shadow under one `All`, with the
 * shadow behind a `Catch`.
 *
 * The declared `All` is what makes the shadow concurrent rather than an extra
 * sequential step. The `Catch` is what makes it an experiment: the arm settles
 * the shadow as `{ quarantined: true, error }`, so the join cannot fail on the
 * shadow's behalf and a plan reader sees that a failed shadow does not fail the
 * run. A settled shadow is `{ quarantined: false, value }`, the shape
 * {@link run} reports.
 *
 * The score call is the settled arm of a `Node.branch` on the real shadow, so a
 * quarantined shadow is never scored, as in {@link run}. The declared result
 * is `{ primary, shadow, delta? }`, which is {@link Result}, except that a
 * quarantined shadow carries its typed `error` where `run` carries the whole
 * `Cause`: a cause does not cross the declared wire.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): SidecarFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const declared = { primary: options.primary, shadow: options.shadow }
  const score = options.score
  const { name, description } = Compose.label("sidecar", { scores: score !== undefined }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const shadow: Node.Node<unknown, unknown, R> = Node.catch(
      Node.map(
        callMember(declared.shadow, input),
        Node.capture({ shadow: "settled" }, (value: unknown) => ({ quarantined: false, value }))
      ),
      {
        onFailure: Node.capture(
          { shadow: "quarantined" },
          (error: unknown) => Node.succeed({ quarantined: true, error })
        )
      }
    )
    // The delta is computed on the REAL scores, and the pair beside it is
    // carried as planned references: a mapper that closed over the pair would
    // hand back the placeholder instead of the values the run produced.
    const measured = (scorer: Member<R>, both: unknown): Node.Node<unknown, unknown, R> =>
      Node.bindPlanned(
        Node.map(
          // The scorer sees the same pair `run` hands it: the primary's value
          // and the shadow's, not the shadow's quarantine wrapper.
          callMember(scorer, { primary: field(both, "primary"), shadow: field(field(both, "shadow"), "value") }),
          Node.capture(
            { scores: true },
            (scores: unknown) => measuredDelta(field(scores, "primary") as number, field(scores, "shadow") as number)
          )
        ),
        Node.capture({ scores: true }, (delta) =>
          Node.succeed({
            primary: field(both, "primary"),
            shadow: field(both, "shadow"),
            delta
          }))
      )
    // A quarantined shadow has no value to score, so the score call is the
    // settled arm of a branch on the real shadow, as `run` skips it.
    const scored = (both: unknown): Node.Node<unknown, unknown, R> =>
      score === undefined ? Node.succeed(both) : Node.branch(Node.succeed(both), {
        if: Node.capture(
          { scores: true },
          (settled: unknown) => field(field(settled, "shadow"), "quarantined") === true
        ),
        then: (settled) => Node.succeed(settled),
        else: (settled) => measured(score, settled)
      })
    return Node.bindPlanned(
      Node.all({ primary: callMember(declared.primary, input), shadow }),
      Node.capture({ scores: score !== undefined }, scored)
    )
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ scores: score !== undefined }, body)
  })
}

/**
 * Runs the primary and its shadow concurrently and scores the pair.
 *
 * The shadow's failure, defect included, becomes a quarantined result rather
 * than a run failure. Interruption is not quarantined: a cancelled run is
 * cancelled, and reporting the shadow as merely failed would hide that.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, P, S, E, R, E2, R2, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, P, S, E, R, E2, R2, E3, R3>
): Effect.Effect<Result<P, S>, E | E3 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const declared = { primary: options.primary, shadow: options.shadow, score: options.score }
  return Effect.gen(function*() {
    // The shadow callback is invoked inside `Effect.suspend` so that a factory
    // that throws before it returns an effect is a defect the quarantine
    // claims, not one that fails the run before the primary ever starts.
    const quarantine: Effect.Effect<Shadow<S>, never, R2> = Effect.flatMap(
      Effect.exit(Effect.suspend(() => declared.shadow(input))),
      (exit) =>
        Exit.isSuccess(exit)
          ? Effect.succeed<Shadow<S>>({ quarantined: false, value: exit.value })
          // An interrupted shadow means the run itself is being cancelled.
          // Reporting that as a quarantined experiment would hide the
          // cancellation, so re-raise it as the interruption it is.
          : Cause.hasInterrupts(exit.cause)
          ? Effect.interrupt
          : Effect.succeed<Shadow<S>>({ quarantined: true, cause: exit.cause })
    )
    const [primary, shadow] = yield* Effect.all([declared.primary(input), quarantine] as const, { concurrency: 2 })
    if (declared.score === undefined || shadow.quarantined) {
      const reported: Result<P, S> = { primary, shadow }
      return reported
    }
    const scores = yield* declared.score({ primary, shadow: shadow.value })
    const refusal = scoreRefusal(scores.primary, scores.shadow)
    if (refusal !== undefined) return yield* Effect.fail(refusal)
    const reported: Result<P, S> = { primary, shadow, delta: measuredDelta(scores.primary, scores.shadow) }
    return reported
  })
}
