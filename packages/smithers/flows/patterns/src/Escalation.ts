/**
 * Sequential escalation pattern.
 *
 * A ladder tries strategies in order and stops at the first rung whose result
 * is good enough. Two deciders answer "good enough": the shared `accept` flow,
 * and a per-rung `escalateIf` that overrides it. A `fallback` runs only after
 * every rung escalated, which is where a human approval flow belongs.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/concepts/retries
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
 * One declared rung and the flow that decides whether it escalates.
 *
 * `escalateIf` receives `{ result, level }` and replaces the shared `accept`
 * flow for this rung alone. It escalates with anything but `false`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Rung<R = never> {
  readonly flow: Member<R>
  readonly escalateIf?: Member<R> | undefined
}

/**
 * Configuration for {@link make}.
 *
 * Rungs are alternative strategies, not model-seat fallback. Provider or
 * seat fallback belongs to model routing before a flow is selected.
 *
 * `accept` decides every rung that declares no `escalateIf`. `fallback` is the
 * last rung: it runs only after every declared rung escalated.
 * A rung with no `escalateIf` and no `accept` is decided by
 * {@link defaultEscalate}, in `make` and in {@link run} alike.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly rungs: ReadonlyArray<Member<R> | Rung<R>>
  readonly accept?: Member<R> | undefined
  readonly fallback?: Member<R> | undefined
}

/**
 * One operational rung and its optional escalation predicate.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeRung<I, A, E, R, E2, R2> {
  readonly run: (input: I) => Effect.Effect<A, E, R>
  readonly escalateIf?: ((result: A, level: number) => Effect.Effect<boolean, E2, R2>) | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * A rung is either a plain effectful function or a {@link RuntimeRung} that
 * carries its own `escalateIf`. With no `accept` and no `escalateIf`,
 * {@link defaultEscalate} decides.
 *
 * `run` snapshots `rungs`, each rung's `run` and `escalateIf`, `accept`, and
 * `fallback` at the call, so a later edit to the array, a rung record, or the
 * option object does not alter that run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2, F = A, E3 = never, R3 = never> {
  readonly rungs: ReadonlyArray<((input: I) => Effect.Effect<A, E, R>) | RuntimeRung<I, A, E, R, E2, R2>>
  readonly accept?: ((result: A) => Effect.Effect<unknown, E2, R2>) | undefined
  readonly fallback?: ((input: I) => Effect.Effect<F, E3, R3>) | undefined
}

/**
 * The rung that produced the settled result, and the result itself.
 *
 * `level` is the rung's index. A `fallback` result carries the rung count,
 * one past the last declared rung. `exhausted` is always `false` here, so a
 * caller reads it on either arm without a property check.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reached<A> {
  readonly level: number
  readonly result: A
  readonly exhausted: false
}

/**
 * The last rung's result, returned when every rung escalated and no fallback
 * was declared.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<A> {
  readonly level: number
  readonly result: A
  readonly accepted: false
  readonly exhausted: true
}

/**
 * One unambiguous ladder outcome: a rung settled, or every rung escalated.
 *
 * `exhausted` discriminates the two arms and the rung's own value stays
 * nested under `result`.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, F = A> = Reached<A> | Reached<F> | Exhausted<A>

/**
 * Reads an accepted decision: `true`, `"approved"`, `{ approved: true }`, or
 * `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export const accepted = Compose.accepted

/**
 * Decides escalation for a rung that names no predicate and no `accept` flow,
 * in {@link make} as a `Node.branch` on the rung's result and in {@link run}
 * on the same result.
 *
 * A missing result escalates. So does a result that reports a failure the way
 * flows conventionally do: a set `error`, `failed: true`, or `ok: false`.
 * Anything else settles the ladder.
 *
 * @category combinators
 * @since 0.1.0
 */
export const defaultEscalate = (result: unknown): boolean => {
  if (result === undefined || result === null) return true
  if (typeof result !== "object") return false
  const row = result as Readonly<Record<string, unknown>>
  if ("error" in row && row.error !== undefined && row.error !== null && row.error !== false) return true
  if (row.failed === true) return true
  return row.ok === false
}

// Copies, never the caller's records: the declaration reads a rung again
// when the graph builds, and `run` reads one again when the effect runs.
const declared = <R>(rung: Member<R> | Rung<R>): Rung<R> =>
  "flow" in rung ? { flow: rung.flow, escalateIf: rung.escalateIf } : { flow: rung }

const operational = <I, A, E, R, E2, R2>(
  rung: ((input: I) => Effect.Effect<A, E, R>) | RuntimeRung<I, A, E, R, E2, R2>
): RuntimeRung<I, A, E, R, E2, R2> =>
  typeof rung === "function" ? { run: rung } : { run: rung.run, escalateIf: rung.escalateIf }

/**
 * The declared form of an escalation ladder.
 *
 * @category models
 * @since 0.1.0
 */
export type EscalationFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Builds the bounded ladder topology, including every rung, every decider, and
 * the fallback, with a real run-time decision at each rung that has one. Use
 * {@link run} for the operational form.
 *
 * A rung with a decider is a `Node.branch`: the plan carries both the settled
 * arm and the next rung before anything runs, and the decider's answer is read
 * at run time off the result the rung really produced. A rung with neither
 * its own decider nor a shared `accept` branches on {@link defaultEscalate},
 * the rule {@link run} applies to the same result.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): EscalationFlow<R> => {
  if (options.rungs.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Escalation requires at least one rung" })
  }
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const rungs = options.rungs.map(declared)
  const accept = options.accept
  const fallback = options.fallback
  const { name, description } = Compose.label(
    "escalation",
    { rungs: rungs.length, fallback: fallback !== undefined },
    options
  )
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const exhausted = (last: unknown, level: number): Node.Node<unknown, unknown, R> =>
      fallback === undefined
        ? Node.succeed({ level, result: last, accepted: false, exhausted: true })
        : Node.bindPlanned(
          callMember(fallback, { input }),
          Node.capture(
            { level: rungs.length },
            (result: Planned.Planned<unknown>) => Node.succeed({ level: rungs.length, result, exhausted: false })
          )
        )
    const visit = (index: number, last: unknown): Node.Node<unknown, unknown, R> => {
      const rung = rungs[index]
      if (rung === undefined) return exhausted(last, index - 1)
      return Node.bindPlanned(
        callMember(rung.flow, { input }),
        Node.capture({ rung: index }, (result: Planned.Planned<unknown>) => {
          const settle = (): Node.Node<unknown, unknown, R> => Node.succeed({ level: index, result, exhausted: false })
          const escalated = (): Node.Node<unknown, unknown, R> => visit(index + 1, result)
          const escalateIf = rung.escalateIf
          if (escalateIf !== undefined) {
            // The per-rung decider settles on `false` alone, which is the rule
            // `run` spends: it escalates on anything else.
            const settles = Node.capture({ rung: index }, (decision: unknown) => decision === false)
            return Node.branch(callMember(escalateIf, { result, level: index }), {
              if: settles,
              then: settle,
              else: escalated
            })
          }
          if (accept === undefined) {
            // No decider at all: the result itself decides, by the same
            // {@link defaultEscalate} rule `run` applies.
            const settles = Node.capture({ rung: index }, (value: unknown) => !defaultEscalate(value))
            return Node.branch(Node.succeed(result), { if: settles, then: settle, else: escalated })
          }
          const approved = Node.capture({ rung: index }, (decision: unknown) => accepted(decision))
          return Node.branch(callMember(accept, { result }), { if: approved, then: settle, else: escalated })
        })
      )
    }
    return visit(0, undefined)
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and
    // declared no error schema. `@smthrs/flow` needs a real one, because the
    // engine encodes a typed failure through it, and a ladder fails with
    // whatever the rung it called failed with.
    error: Schema.Unknown,
    body: Node.capture({ rungs: rungs.length, fallback: fallback !== undefined }, body)
  })
}

const escalates = <I, A, E, R, E2, R2>(
  rung: RuntimeRung<I, A, E, R, E2, R2>,
  accept: ((result: A) => Effect.Effect<unknown, E2, R2>) | undefined,
  result: A,
  level: number
): Effect.Effect<boolean, E2, R2> => {
  if (rung.escalateIf !== undefined) return rung.escalateIf(result, level)
  if (accept !== undefined) return Effect.map(accept(result), (decision) => !accepted(decision))
  return Effect.succeed(defaultEscalate(result))
}

/**
 * Executes an escalation ladder and stops at the first rung that does not
 * escalate.
 *
 * Every outcome carries `exhausted`: `false` on a rung that settled and on a
 * fallback result, `true` on the last rung's result when every rung escalated.
 *
 * This is the operational form of the same decision {@link make} declares as a
 * `Node.branch` per rung: it stops at the first settled rung instead of
 * carrying every rung the ladder declares. Fiber interruption propagates
 * normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, E2 = never, R2 = never, F = A, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2, F, E3, R3>
): Effect.Effect<Settled<A, F>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the array, a rung record, or the option object in between must
  // not reach it.
  const rungs = options.rungs.map(operational)
  const accept = options.accept
  const fallback = options.fallback
  if (rungs.length === 0) {
    return Effect.fail(
      new PatternError({ code: "invalid_decorator", message: "Escalation requires at least one rung" })
    )
  }
  return Effect.gen(function*() {
    let last: A | undefined
    let level = 0
    for (const rung of rungs) {
      const result = yield* rung.run(input)
      last = result
      if (!(yield* escalates(rung, accept, result, level))) {
        const settled: Reached<A> = { level, result, exhausted: false }
        return settled
      }
      level = level + 1
    }
    if (fallback !== undefined) {
      const settled: Reached<F> = { level: rungs.length, result: yield* fallback(input), exhausted: false }
      return settled
    }
    const spent: Exhausted<A> = { level: rungs.length - 1, result: last as A, accepted: false, exhausted: true }
    return spent
  })
}
