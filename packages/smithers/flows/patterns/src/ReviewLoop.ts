/**
 * Bounded produce-review-revise pattern.
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
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import * as Stalling from "./internal/Stalling.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * `produce` receives `{ input }`, `review` receives `{ output }` carrying the
 * produced value, and `revise` receives `{ output, review, round }`. Every
 * round the bound allows is declared, and each round's approval decision is a
 * `Node.branch` whose predicate runs at run time on the review the reviewer
 * really returned, so cancellation remains ordinary structured fiber
 * interruption.
 *
 * `stall` ends the loop once `stall.rounds` refused rounds in a row reviewed
 * the same output (`@smthrs/flow/Stall`): `stop` and `park` settle
 * {@link Stalled}, `escalate` fails `PatternError` `stalled`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly produce: Member<R>
  readonly review: Member<R>
  readonly revise: Member<R>
  readonly maxRounds: number
  readonly stall?: Stall.Options | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3> {
  readonly produce: (input: I) => Effect.Effect<A, E, R>
  readonly review: (output: A, round: number) => Effect.Effect<Review, E2, R2>
  readonly revise: (input: {
    readonly output: A
    readonly review: Review
    readonly round: number
  }) => Effect.Effect<A, E3, R3>
  readonly maxRounds: number
  readonly stall?: Stalling.RuntimeOptions<A> | undefined
}

/**
 * An approved result, returned at the round whose review accepted it.
 *
 * The produced value is nested under `output` so it can never forge the
 * unapproved arm, however it is shaped.
 *
 * @category models
 * @since 1.0.0
 */
export interface Approved<A> {
  readonly _tag: "Approved"
  readonly output: A
}

/**
 * An unapproved result returned after the round bound is reached, with the
 * review that refused it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<A, Review> {
  readonly _tag: "Exhausted"
  readonly output: A
  readonly review: Review
}

/**
 * An unapproved result whose revisions stopped changing, with the last review
 * and the stall verdict.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stalled<A, Review> {
  readonly _tag: "Stalled"
  readonly output: A
  readonly review: Review
  readonly stalled: Stall.Stalled
}

/**
 * One unambiguous loop outcome: a review approved the output, the rounds
 * ran out, or the revisions stalled.
 *
 * Both arms carry `_tag` and nest the produced value under `output`, so a
 * caller branches on the discriminator rather than on the shape of the value
 * the loop produced.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, Review> = Approved<A> | Exhausted<A, Review> | Stalled<A, Review>

/**
 * Reads an accepted decision: `true`, `"approved"`, `{ approved: true }`, or
 * `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export const accepted = Compose.accepted

/**
 * The declared form of a bounded review loop.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewLoopFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Builds the conservative topology for every declared review round, with a
 * real run-time approval decision at each one. Use {@link run} for the
 * operational form.
 *
 * Each round is a `Node.branch`: the plan carries the approved arm and the
 * revise arm before anything runs, and the predicate is evaluated at run time
 * on the review the reviewer really returned. Reaching the round bound reads
 * the declared bound rather than a run value, so that one test stays at plan
 * time. A very large `maxRounds` builds a very large graph before anything
 * runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): ReviewLoopFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { produce: options.produce, review: options.review, revise: options.revise }
  const maxRounds = options.maxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "ReviewLoop maxRounds must be a positive safe integer"
    })
  }
  const stall = Stalling.resolve("ReviewLoop", options.stall)
  if (stall instanceof PatternError) throw stall
  const { name, description } = Compose.label("reviewLoop", { maxRounds, stall: Stalling.labelOf(stall) }, options)
  const captured = stall === undefined ? { maxRounds } : { maxRounds, stall }
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const visit = (output: unknown, round: number, streaks: unknown): Node.Node<unknown, unknown, R> => {
      // The predicate is DIGESTED and run later, on the review the reviewer
      // really returned. It is captured so two loops that differ only in their
      // declared bound are two declarations rather than one shared callback.
      const approved = Node.capture({ ...captured, round }, (verdict: unknown) => accepted(verdict))
      const revise = (review: Planned.Planned<unknown>, next: unknown): Node.Node<unknown, unknown, R> =>
        Node.bindPlanned(
          callMember(stages.revise, { output, review, round }),
          Node.capture({ ...captured, round }, (revised: Planned.Planned<unknown>) => visit(revised, round + 1, next))
        )
      return Node.branch(callMember(stages.review, { output }), {
        if: approved,
        then: () => Node.succeed({ _tag: "Approved", output }),
        else: (review: Planned.Planned<unknown>) =>
          round >= maxRounds
            ? Node.succeed({ _tag: "Exhausted", output, review })
            : stall === undefined
            ? revise(review, streaks)
            : Stalling.guard(
              "ReviewLoop",
              stall,
              { ...captured, round },
              output,
              streaks as Stall.State,
              Stalling.output,
              {
                settle: (stalled) => Node.succeed({ _tag: "Stalled", output, review, stalled }),
                next: (next) => revise(review, next)
              }
            )
      })
    }
    return Node.bindPlanned(
      callMember(stages.produce, { input }),
      Node.capture(captured, (initial: Planned.Planned<unknown>) => visit(initial, 1, Stall.initial))
    )
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and
    // declared no error schema. `@smthrs/flow` needs a real one, because the
    // engine encodes a typed failure through it, and a review loop fails with
    // whatever the member it called failed with.
    error: Schema.Unknown,
    body: Node.capture(captured, body)
  })
}

/**
 * Executes produce-review-revise rounds and short-circuits on approval.
 *
 * Both outcomes are tagged: an accepted review returns {@link Approved} and a
 * spent round bound returns {@link Exhausted} with the review that refused it.
 *
 * This Effect is the operational form of the same decision {@link make}
 * declares as a `Node.branch`: it stops at the first approved round instead of
 * carrying every round the bound allows. Fiber interruption propagates
 * normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, Review, E, R, E2, R2, E3, R3>(
  input: I,
  options: RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3>
): Effect.Effect<Settled<A, Review>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const stages = { produce: options.produce, review: options.review, revise: options.revise }
  const maxRounds = options.maxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "ReviewLoop maxRounds must be a positive safe integer"
      })
    )
  }
  const stall = Stalling.resolve("ReviewLoop", options.stall)
  if (stall instanceof PatternError) return Effect.fail(stall)
  const signals = options.stall?.signals ?? ((output: A) => ({ output }))
  return Effect.gen(function*() {
    const observe = Stalling.tracker(stall, signals)
    let output = yield* stages.produce(input)
    let round = 1
    while (true) {
      const review = yield* stages.review(output, round)
      if (accepted(review)) {
        const approved: Approved<A> = { _tag: "Approved", output }
        return approved
      }
      if (round === maxRounds) {
        const spent: Exhausted<A, Review> = { _tag: "Exhausted", output, review }
        return spent
      }
      const stalled = observe(output)
      if (stalled !== undefined) {
        if (stalled.on === "escalate") return yield* Effect.fail(Stalling.escalated("ReviewLoop", stalled.rounds))
        const parked: Stalled<A, Review> = { _tag: "Stalled", output, review, stalled }
        return parked
      }
      output = yield* stages.revise({ output, review, round })
      round += 1
    }
  })
}
