/**
 * Bounded repeat-until-predicate loops.
 *
 * A loop is the one control-flow shape a plan cannot represent honestly: the
 * number of rounds is a runtime fact. This module answers that the same way
 * `ReviewLoop` answers it. {@link make} unrolls the declared bound into a
 * conservative topology, declaring every iteration a run could reach so that
 * capability and conflict analysis see the worst case. {@link run} performs the
 * value-dependent stop, short-circuiting the moment the predicate is
 * satisfied.
 *
 * For a loop whose rounds must survive a crash, hand each iteration to the
 * durable trampoline instead: `Flow.to` with `maxRounds`, described in the
 * loops reference at https://smithers.sh/docs/reference/api/patterns.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Stall from "@smthrs/flow/Stall"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Repetition from "@smthrs/plan/Repetition"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import * as Stalling from "./internal/Stalling.ts"
import { PatternError } from "./PatternError.ts"

/**
 * What a loop does when it reaches its iteration bound unsatisfied.
 *
 * This is `@smthrs/plan`'s `Repetition.AtCeiling`, the one ceiling vocabulary,
 * which `@smthrs/flow`'s `Poll.make` takes as `onTimeout`.
 *
 * @category models
 * @since 0.1.0
 */
export type OnMaxReached = Repetition.AtCeiling

/**
 * Configuration for {@link make}.
 *
 * `body` runs once per iteration and receives `{ input, previous, iteration }`,
 * where `previous` is the preceding iteration's output and is absent on the
 * first. `until` receives `{ value, iteration }`; omit it for a loop whose body
 * reports its own completion, which is what {@link ralph} names.
 *
 * `onMaxReached` defaults to `"return-last"`, so a loop that omits it hands the
 * caller the last value it produced instead of failing.
 *
 * `captures` adds inert declaration identity for a caller that layers its own
 * runtime threshold over this loop, so two otherwise identical declarations
 * that differ in that threshold do not share a step key.
 *
 * `stall` ends the loop once `stall.rounds` unsatisfied iterations in a row
 * produced the same value (`@smthrs/flow/Stall`). `stop` and `park` settle
 * {@link Result} with `stalled` set; `escalate` fails `PatternError`
 * `stalled`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly body: Member<R>
  readonly until?: Member<R> | undefined
  readonly maxIterations: number
  readonly onMaxReached?: OnMaxReached | undefined
  readonly captures?: Readonly<Record<string, unknown>> | undefined
  readonly stall?: Stall.Options | undefined
}

/**
 * Configuration for {@link ralph}, a loop with no separate predicate flow.
 *
 * @category models
 * @since 0.1.0
 */
export type RalphOptions<R = never> = Omit<MakeOptions<R>, "until">

/**
 * Operational callbacks for {@link run}.
 *
 * `onMaxReached` defaults to `"return-last"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2> {
  readonly body: (input: {
    readonly input: I
    readonly previous: A | undefined
    readonly iteration: number
  }) => Effect.Effect<A, E, R>
  readonly until?:
    | ((input: { readonly value: A; readonly iteration: number }) => Effect.Effect<unknown, E2, R2>)
    | undefined
  readonly maxIterations: number
  readonly onMaxReached?: OnMaxReached | undefined
  readonly stall?: Stalling.RuntimeOptions<A> | undefined
}

/**
 * Operational callbacks for {@link runRalph}.
 *
 * @category models
 * @since 0.1.0
 */
export type RalphRuntimeOptions<I, A, E, R> = Omit<RuntimeOptions<I, A, E, R, never, never>, "until">

/**
 * The outcome of a bounded loop.
 *
 * `exhausted` is true when the bound stopped the loop rather than the
 * predicate. `iterations` counts the bodies that ran. `stalled` is present
 * when a stall policy stopped or parked it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<A> {
  readonly value: A
  readonly iterations: number
  readonly exhausted: boolean
  readonly stalled?: Stall.Stalled | undefined
}

/**
 * Reads the completion signals a loop predicate may return.
 *
 * A predicate answers with `true`, the string `"done"`, or an object carrying
 * `done: true`. Everything else continues the loop, which is what a symbolic
 * plan-time value does: an unresolved value never ends the declared unrolling,
 * so the topology stays conservative.
 *
 * An explicit `until` flow and a Ralph body are read by this one function, so
 * the two forms share one completion vocabulary. The match is exact: `"DONE"`,
 * `"yes"`, `1`, and `{ done: "true" }` all continue the loop.
 *
 * @category predicates
 * @since 0.1.0
 */
export const done = (value: unknown): boolean =>
  value === true ||
  value === "done" ||
  (typeof value === "object" && value !== null && "done" in value && value.done === true)

const defaultOnMaxReached: OnMaxReached = "return-last"

const exhausted = (maxIterations: number): PatternError =>
  new PatternError({
    code: "exhausted",
    message: `Loop reached its bound of ${maxIterations} iterations unsatisfied`
  })

const bound = (maxIterations: number): PatternError | undefined =>
  Number.isSafeInteger(maxIterations) && maxIterations >= 1 ? undefined : new PatternError({
    code: "invalid_decorator",
    message: "Loop maxIterations must be a positive safe integer"
  })

/**
 * The declared form of a bounded loop.
 *
 * @category models
 * @since 0.1.0
 */
export type LoopFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Declares a bounded loop as its fully unrolled conservative topology, with a
 * real run-time decision at every iteration.
 *
 * Every iteration up to `maxIterations` is declared, because a plan cannot
 * know which iteration a run stops at. Both continuations of each iteration,
 * settle now or go round again, are `Node.branch` arms, so the plan carries
 * the exit condition and both arms before anything runs and the predicate is
 * evaluated at run time on the value the body really produced. Reaching the
 * bound is a plan-time fact, so the last FALSE arm is declared as the policy
 * says: `"return-last"` settles `exhausted: true`, and `"fail"` fails
 * `PatternError` `exhausted`.
 *
 * A very large `maxIterations` builds a very large graph before anything runs,
 * and a bound whose chain nests past the plan depth limit is refused here
 * rather than at `Graph.build`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): LoopFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const declared = { body: options.body, until: options.until }
  const maxIterations = options.maxIterations
  // One `Node.branch` per iteration, and one more level for the `until` form's
  // `Node.bindPlanned`: that is how many levels one iteration nests. The calls
  // an iteration makes are the branch's own subject and the bind's, so they
  // cost no level of their own.
  const stall = Stalling.resolve("Loop", options.stall)
  if (stall instanceof PatternError) throw stall
  // A stall policy adds one branch to every iteration that goes round again.
  const invalid = bound(maxIterations) ??
    Compose.sequencedBoundRefusal(
      "Loop",
      "maxIterations",
      maxIterations,
      (declared.until === undefined ? 1 : 2) + (stall === undefined ? 0 : 1)
    )
  if (invalid !== undefined) throw invalid
  const onMaxReached = options.onMaxReached ?? defaultOnMaxReached
  const captures = {
    ...options.captures,
    maxIterations,
    onMaxReached,
    predicate: declared.until === undefined ? "body" : "flow",
    ...(stall === undefined ? {} : { stall })
  }
  const { name, description } = Compose.label(
    "loop",
    { maxIterations, onMaxReached, stall: Stalling.labelOf(stall) },
    options
  )
  const settled = (
    value: unknown,
    iteration: number,
    exhausted: boolean
  ): Node.Node<unknown, never, never> => Node.succeed({ value, iterations: iteration, exhausted })
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const visit = (previous: unknown, iteration: number, streaks: unknown): Node.Node<unknown, unknown, R> => {
      // The predicate is DIGESTED and run later, on the real value. It is
      // captured so two loops that differ only in their declared bound are
      // two declarations rather than one shared process-local callback.
      const satisfied = Node.capture({ ...captures, iteration }, (verdict: unknown) => done(verdict))
      const produced = callMember(declared.body, { input, previous, iteration })
      // The FALSE arm: the bound decides whether going round again is still
      // declared topology or whether this iteration is where the loop settles
      // exhausted. That test reads the declared bound, not a run value, so it
      // is the one decision that stays at plan time.
      const continued = (value: Planned.Planned<unknown>): Node.Node<unknown, unknown, R> =>
        iteration >= maxIterations
          ? onMaxReached === "fail" ? Node.fail(exhausted(maxIterations)) : settled(value, iteration, true)
          : stall === undefined
          ? visit(value, iteration + 1, streaks)
          : Stalling.guard("Loop", stall, { ...captures, iteration }, value, streaks as Stall.State, Stalling.output, {
            settle: (stalled) => Node.succeed({ value, iterations: iteration, exhausted: false, stalled }),
            next: (next) => visit(value, iteration + 1, next)
          })
      const predicate = declared.until
      if (predicate === undefined) {
        return Node.branch(produced, {
          if: satisfied,
          then: (value) => settled(value, iteration, false),
          else: continued
        })
      }
      // The builder is CAPTURED, like every other converted continuation here:
      // a bare arrow takes process-local `sha256-source-ephemeral/v4` identity,
      // so the same declaration built twice would key two different plans.
      return Node.bindPlanned(
        produced,
        Node.capture({ ...captures, iteration }, (value) =>
          Node.branch(callMember(predicate, { value, iteration }), {
            if: satisfied,
            then: () => settled(value, iteration, false),
            else: () => continued(value)
          }))
      )
    }
    return visit(undefined, 1, Stall.initial)
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and
    // declared no error schema. `@smthrs/flow` needs a real one, because the
    // engine encodes a typed failure through it, and a loop fails with
    // whatever the member it called failed with.
    error: Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

/**
 * Declares a Ralph loop: a bounded loop whose body reports its own completion.
 *
 * Ralph is the loop that keeps handing an agent the same goal until the agent
 * says it is finished. There is no separate predicate flow, so the declared
 * topology is `maxIterations` body calls and nothing else. `onMaxReached`
 * defaults to `"return-last"`, so `ralph({ body, maxIterations })` is the whole
 * declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ralph = <R = never>(options: RalphOptions<R>): LoopFlow<R> => make(options)

/**
 * Runs a bounded loop, stopping at the first satisfied predicate.
 *
 * The bound is checked before the first body runs, so an invalid declaration
 * never starts work. The body always runs at least once, because the predicate
 * reads a produced value: a predicate that would answer `true` from the start
 * still costs one iteration. Fiber interruption propagates normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2>
): Effect.Effect<Result<A>, E | E2 | PatternError, R | R2> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const declared = { body: options.body, until: options.until }
  const maxIterations = options.maxIterations
  const invalid = bound(maxIterations)
  if (invalid !== undefined) return Effect.fail(invalid)
  const stall = Stalling.resolve("Loop", options.stall)
  if (stall instanceof PatternError) return Effect.fail(stall)
  const signals = options.stall?.signals ?? ((output: A) => ({ output }))
  const onMaxReached = options.onMaxReached ?? defaultOnMaxReached
  return Effect.gen(function*() {
    const observe = Stalling.tracker(stall, signals)
    let previous: A | undefined = undefined
    // `bound` rejected a maxIterations below one, so iteration 1 always runs
    // and the bound arm below always returns. The loop needs no exit test.
    for (let iteration = 1;; iteration++) {
      const value: A = yield* declared.body({ input, previous, iteration })
      previous = value
      const verdict = declared.until === undefined ? value : yield* declared.until({ value, iteration })
      if (done(verdict)) return { value, iterations: iteration, exhausted: false }
      if (iteration >= maxIterations) {
        if (onMaxReached === "fail") return yield* Effect.fail(exhausted(maxIterations))
        return { value, iterations: iteration, exhausted: true }
      }
      const stalled = observe(value)
      if (stalled !== undefined) {
        if (stalled.on === "escalate") return yield* Effect.fail(Stalling.escalated("Loop", stalled.rounds))
        return { value, iterations: iteration, exhausted: false, stalled }
      }
    }
  })
}

/**
 * Runs a Ralph loop, stopping when the body reports `done`.
 *
 * Reaching the bound returns the last value with `exhausted: true` unless the
 * caller asks for `onMaxReached: "fail"`.
 *
 * @category combinators
 * @since 0.1.0
 */
export const runRalph = <I, A, E, R>(
  input: I,
  options: RalphRuntimeOptions<I, A, E, R>
): Effect.Effect<Result<A>, E | PatternError, R> => run(input, options)
