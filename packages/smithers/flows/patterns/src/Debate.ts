/**
 * A bounded, alternating deliberation pattern.
 *
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * One immutable contribution to a debate transcript.
 *
 * @category models
 * @since 0.1.0
 */
export interface Turn {
  readonly proponent: unknown
  readonly opponent: unknown
}

/**
 * One typed contribution produced by {@link run}. The turn wrapper is frozen,
 * while its proponent and opponent payloads remain opaque caller-owned
 * references and are not recursively frozen.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeTurn<Proponent, Opponent> {
  readonly proponent: Proponent
  readonly opponent: Opponent
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3> {
  readonly rounds: number
  readonly proponent: (state: {
    readonly input: I
    readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>
    readonly round: number
  }) => Effect.Effect<Proponent, E, R>
  readonly opponent: (state: {
    readonly input: I
    readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>
    readonly proponent: Proponent
    readonly round: number
  }) => Effect.Effect<Opponent, E2, R2>
  readonly judge: (state: {
    readonly input: I
    readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>
  }) => Effect.Effect<Judge, E3, R3>
}

/**
 * Configuration for {@link make}.
 *
 * Each participant receives `{ input, transcript }`. The judge receives the
 * final value with the same shape. `rounds` is expanded while this flow is
 * declared, rather than at execution time.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly proponent: Member<R>
  readonly opponent: Member<R>
  readonly judge: Member<R>
  readonly rounds: number
}

/**
 * The declared form of a debate.
 *
 * @category models
 * @since 0.1.0
 */
export type DebateFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

const invalidRounds = (rounds: number): never => {
  throw new PatternError({
    code: "invalid_decorator",
    message: `Debate rounds must be a positive safe integer, received ${rounds}`
  })
}

/**
 * Builds the conservative fixed-round participant topology. Use {@link run}
 * when participant outputs must accumulate into a runtime transcript.
 * A very large `rounds` value builds a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): DebateFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const participants = { proponent: options.proponent, opponent: options.opponent, judge: options.judge }
  const rounds = options.rounds
  if (!Number.isSafeInteger(rounds) || rounds < 1) invalidRounds(rounds)
  const { name, description } = Compose.label("debate", { rounds }, options)
  // The transcript is a real array of planned references, assembled while the
  // graph builds. A planned value may be read by field and passed into a
  // payload but never computed on, so a round appends to the array the builder
  // holds instead of spreading the symbol a previous round produced.
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const visit = (
      round: number,
      transcript: ReadonlyArray<
        { readonly proponent: Planned.Planned<unknown>; readonly opponent: Planned.Planned<unknown> }
      >
    ): Node.Node<unknown, unknown, R> => {
      if (round === rounds) return callMember(participants.judge, { input, transcript })
      return Node.bindPlanned(
        callMember(participants.proponent, { input, transcript }),
        Node.capture({ round }, (proponent) =>
          Node.bindPlanned(
            callMember(participants.opponent, { input, transcript, proponent }),
            Node.capture({ round }, (opponent) => visit(round + 1, [...transcript, { proponent, opponent }]))
          ))
      )
    }
    return visit(0, [])
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ rounds }, body)
  })
}

/**
 * Executes a fixed-round debate and supplies the real accumulated transcript
 * to each participant and the judge.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3>(
  input: I,
  options: RuntimeOptions<I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3>
): Effect.Effect<Judge, E | E2 | E3 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const participants = { proponent: options.proponent, opponent: options.opponent, judge: options.judge }
  const rounds = options.rounds
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: `Debate rounds must be a positive safe integer, received ${rounds}`
      })
    )
  }
  return Effect.gen(function*() {
    const transcript: Array<RuntimeTurn<Proponent, Opponent>> = []
    const snapshot = (): ReadonlyArray<RuntimeTurn<Proponent, Opponent>> => Object.freeze([...transcript])
    for (let round = 1; round <= rounds; round++) {
      const proponent = yield* participants.proponent({ input, transcript: snapshot(), round })
      const opponent = yield* participants.opponent({ input, transcript: snapshot(), proponent, round })
      transcript.push(Object.freeze({ proponent, opponent }))
    }
    return yield* participants.judge({ input, transcript: snapshot() })
  })
}
