/**
 * Forward steps with compensations that unwind in reverse.
 *
 * A saga is the answer to "the third call failed and the first two already
 * changed the world". Each step registers the call that undoes it, and a
 * failure walks those calls backwards, most recent first.
 *
 * @see https://smithers.sh/docs/concepts/retries
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * What a step failure does to the steps that already completed.
 *
 * Both {@link make} and {@link run} default to `compensate` when the caller
 * names no policy.
 *
 * `compensate` unwinds and returns a settled {@link Compensated} outcome; the
 * other two policies only ever settle as {@link Completed}.
 * `compensate-and-fail` unwinds and re-raises the original failure.
 * `fail` leaves the completed work alone.
 *
 * @category models
 * @since 0.1.0
 */
export type OnFailure = "compensate" | "compensate-and-fail" | "fail"

/**
 * One declared step: the call that changes the world, and the call that undoes
 * it.
 *
 * The action receives `{ input, completed }`, where `completed` holds the
 * values of the steps before it, keyed by id. The compensation receives
 * `{ id, input, value }`, where `value` is what its own action returned.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step<R = never> {
  readonly id: string
  readonly action: Member<R>
  readonly compensation: Member<R>
}

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly steps: ReadonlyArray<Step<R>>
  readonly onFailure?: OnFailure | undefined
}

/**
 * One operational step.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeStep<I, A, E, R, E2, R2> {
  readonly id: string
  readonly action: (
    input: { readonly input: I; readonly completed: Readonly<Record<string, A>> }
  ) => Effect.Effect<A, E, R>
  readonly compensation: (
    input: { readonly id: string; readonly input: I; readonly value: A }
  ) => Effect.Effect<unknown, E2, R2>
}

/**
 * Configuration for {@link run}.
 *
 * `run` snapshots `steps`, each step's `id`, `action`, and `compensation`,
 * and `onFailure` at the call, so a later edit to the array, a step record,
 * or the option object does not alter that run. See
 * https://smithers.sh/docs/reference/api/patterns#identity-and-ownership.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2> {
  readonly steps: ReadonlyArray<RuntimeStep<I, A, E, R, E2, R2>>
  readonly onFailure?: OnFailure | undefined
}

/**
 * A saga whose forward chain ran to the end.
 *
 * The step values are nested under `values` so a step id can never forge the
 * settled arm: a saga with steps named `_tag` and `failure` still returns a
 * `Completed` envelope.
 *
 * @category models
 * @since 1.0.0
 */
export interface Completed<A> {
  readonly _tag: "Completed"
  readonly values: Readonly<Record<string, A>>
}

/**
 * The settled outcome of a saga that unwound cleanly under `compensate`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Compensated<E> {
  readonly _tag: "Compensated"
  readonly failure: E
}

/**
 * One unambiguous saga outcome: the forward chain completed, or it unwound.
 *
 * Both arms carry `_tag`, so a caller branches on the discriminator rather
 * than on the shape of its own step values.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, E> = Completed<A> | Compensated<E>

// Only action failures enter this envelope. Each undo extends it immutably,
// so graph planning and repeated evaluations cannot share mutable residue.
interface Unwind {
  readonly failure: unknown
  readonly residue: ReadonlyArray<{ readonly id: string; readonly error: unknown }>
}

const CleanUnwind = Schema.Struct({ failure: Schema.Unknown, residue: Schema.Tuple([]) })

/**
 * The declared form of a saga.
 *
 * @category models
 * @since 1.0.0
 */
export type SagaFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

// The refusal is minted once, as a value. `make` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
const stepsRefusal = (steps: ReadonlyArray<{ readonly id: string }>): PatternError | undefined => {
  if (steps.length === 0) {
    return new PatternError({ code: "invalid_decorator", message: "Saga requires at least one step" })
  }
  const ids = new Set(steps.map((step) => step.id))
  if (ids.size !== steps.length) {
    return new PatternError({ code: "invalid_decorator", message: "Saga step ids must be unique" })
  }
  return undefined
}

// `make` builds topology out of the two members a step names, so a value that
// cannot record a call is refused here rather than left to fail inside
// `Graph.build` with a TypeError naming nothing a caller can act on. A member
// is a flow or an action, and both record a call through their own `.call`, so
// that is what is checked. `run` takes effect functions instead and has nothing
// to check.
// Every function already inherits `Function.prototype.call`, so "has a `call`"
// alone would admit a bare arrow. A member's own `call` shadows it: a flow's
// comes from the flow prototype, an action's from the action prototype, and a
// test fixture's is its own property.
const callable = (member: unknown): boolean => {
  if (member === null || (typeof member !== "object" && typeof member !== "function")) return false
  const record = member as { readonly call?: unknown }
  return typeof record.call === "function" && record.call !== Function.prototype.call
}

const declarationRefusal = <R>(steps: ReadonlyArray<Step<R>>): PatternError | undefined => {
  for (const step of steps) {
    if (!callable(step.action)) {
      return new PatternError({
        code: "invalid_decorator",
        message: `Saga step "${step.id}" action must be a flow or an action`
      })
    }
    if (!callable(step.compensation)) {
      return new PatternError({
        code: "invalid_decorator",
        message: `Saga step "${step.id}" compensation must be a flow or an action`
      })
    }
  }
  return undefined
}

/**
 * Declares the forward chain and its compensation arms.
 *
 * Each step's continuation is wrapped in a `Node.catch` whose arm calls that
 * step's compensation and re-raises, so a failure deeper in the chain unwinds
 * one step at a time, most recent first. Under `compensate`, the default, an
 * outer arm turns the re-raised failure into a settled {@link Compensated}
 * value only when every compensation succeeds; under `fail` no arm is declared
 * at all. Failed compensations are collected without stopping earlier undos.
 * Both compensation policies fail with `compensation_failed`, preserving the
 * original failure and the residue sorted by step id.
 *
 * A step whose action or compensation is not a flow is refused here, because
 * the declaration cannot be built out of anything else.
 *
 * `make` snapshots `steps` and each step's `id`, `action`, and
 * `compensation` at the call, so a later edit to the caller's array or
 * records does not change the declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): SagaFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // this snapshot and never the caller's steps again.
  const steps: ReadonlyArray<Step<R>> = options.steps.map((step) => ({
    id: step.id,
    action: step.action,
    compensation: step.compensation
  }))
  const refusal = stepsRefusal(steps) ?? declarationRefusal(steps)
  if (refusal !== undefined) throw refusal
  const policy = options.onFailure ?? "compensate"
  const { name, description } = Compose.label(
    "saga",
    { steps: steps.map((step) => step.id), onFailure: policy },
    options
  )
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const visit = (index: number, completed: Readonly<Record<string, unknown>>): Node.Node<unknown, unknown, R> => {
      const step = steps[index]
      if (step === undefined) return Node.succeed({ _tag: "Completed", values: completed })
      const action = callMember(step.action, { input, completed })
      const guarded = policy === "fail" ? action : Node.catch(action, {
        onFailure: Node.capture(
          { step: step.id, forward: true },
          (failure) => Node.fail<Unwind>({ failure, residue: [] })
        )
      })
      return Node.bindPlanned(
        guarded,
        Node.capture({ step: step.id }, (value): Node.Node<unknown, unknown, R> => {
          const rest = visit(index + 1, { ...completed, [step.id]: value })
          if (policy === "fail") return rest
          return Node.catch(rest, {
            onFailure: Node.capture(
              { step: step.id },
              (error: unknown): Node.Node<unknown, unknown, R> => {
                const unwind = error as Unwind
                // The unwind is a planned reference until the run produces it,
                // so the compensation is SEQUENCED ahead of a node that hands
                // that reference back. A mapper closing over the reference
                // would return the placeholder instead of the unwind.
                const undo = Node.catch(
                  Node.andThen(
                    callMember(step.compensation, { id: step.id, input, value }),
                    Node.succeed(unwind)
                  ),
                  {
                    onFailure: Node.capture({ step: step.id, residue: true }, (undoError) =>
                      Node.map(
                        Node.succeed({ unwind, undoError }),
                        Node.capture({ step: step.id, residue: true }, ({ unwind, undoError }): Unwind => ({
                          failure: unwind.failure,
                          residue: [...unwind.residue, { id: step.id, error: undoError }]
                        }))
                      ))
                  }
                )
                return Node.bindPlanned(undo, Node.capture({ step: step.id }, (failure) => Node.fail(failure)))
              }
            )
          })
        })
      )
    }
    const chain = visit(0, {})
    if (policy === "fail") return chain
    const reported = Node.catch(chain, {
      onFailure: Node.capture({ residue: true }, (error: unknown) =>
        Node.bindPlanned(
          Node.map(
            Node.succeed(error as Unwind),
            Node.capture({ residue: true }, (unwind: Unwind) => {
              if (unwind.residue.length === 0) return unwind
              const residue = [...unwind.residue].sort((left, right) => left.id.localeCompare(right.id))
              return new PatternError({
                code: "compensation_failed",
                message: `Saga compensation failed for: ${residue.map((entry) => entry.id).join(", ")}`,
                cause: { failure: unwind.failure, residue }
              })
            })
          ),
          Node.capture({ residue: true }, (failure) => Node.fail(failure))
        ))
    })
    // A schema selects the clean arm at execution time; branching on a
    // symbolic error while building the graph would hide the dirty arm.
    return Node.catch(reported, {
      error: CleanUnwind,
      onFailure: Node.capture({ settled: true, onFailure: policy }, (unwind) =>
        policy === "compensate"
          ? Node.succeed({ _tag: "Compensated", failure: unwind.failure })
          : Node.fail(unwind.failure))
    })
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and declared
    // no error schema. `@smthrs/flow` needs a real one, because the engine
    // encodes a typed failure through it, and a saga fails with whatever the
    // step it called failed with.
    error: Schema.Unknown,
    body: Node.capture({ steps: steps.map((step) => step.id), onFailure: policy }, body)
  })
}

/**
 * Runs the forward chain, unwinding completed steps on a failure or an
 * interruption.
 *
 * The policy defaults to `compensate`. Both outcomes are tagged: a chain that
 * ran to the end returns {@link Completed} with its step values nested under
 * `values`, and a clean unwind under `compensate` returns
 * {@link Compensated}.
 *
 * Each completed step registers a scope finalizer, so the unwind is LIFO and
 * runs on interruption as well as on failure. A compensation that fails does
 * not stop the ones behind it; every failing step id is collected and the run
 * fails `PatternError { code: "compensation_failed" }` naming them, because
 * state left dirty outranks the failure that started the unwind.
 *
 * A compensation that DIES counts as a failed compensation, not as a defect
 * the run raises: the undo did not happen, so the step belongs in the residue
 * with the typed failures. This includes a synchronous throw while constructing
 * the compensation effect. Letting the defect escape would lose both the
 * residue and the failure that started the unwind.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2>
): Effect.Effect<Settled<A, E>, E | PatternError, R | R2> => {
  // Snapshots taken at the call, ahead of the suspend: the effect may run
  // later, and a caller's edit to the array, a step record, or the option
  // object in between must not reach it.
  const steps: ReadonlyArray<RuntimeStep<I, A, E, R, E2, R2>> = options.steps.map((step) => ({
    id: step.id,
    action: step.action,
    compensation: step.compensation
  }))
  const policy = options.onFailure ?? "compensate"
  return Effect.suspend(() => {
    const refusal = stepsRefusal(steps)
    if (refusal !== undefined) return Effect.fail(refusal)
    const residue: Array<{ readonly id: string; readonly error: unknown }> = []
    const forward = Effect.gen(function*() {
      const completed = new Map<string, A>()
      for (const step of steps) {
        const value = yield* step.action({
          input,
          completed: Object.fromEntries(completed)
        })
        completed.set(step.id, value)
        if (policy === "fail") continue
        yield* Effect.addFinalizer((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.matchCause(Effect.suspend(() => step.compensation({ id: step.id, input, value })), {
              onFailure: (cause) => {
                residue.push({ id: step.id, error: Cause.squash(cause) })
              },
              onSuccess: () => {}
            })
        )
      }
      return Object.fromEntries(completed)
    })
    const settle = (
      exit: Exit.Exit<Readonly<Record<string, A>>, E>
    ): Effect.Effect<Settled<A, E>, E | PatternError> => {
      const failure = Exit.findErrorOption(exit)
      if (residue.length > 0) {
        const sorted = [...residue].sort((left, right) => left.id.localeCompare(right.id))
        return Effect.fail(
          new PatternError({
            code: "compensation_failed",
            message: `Saga compensation failed for: ${sorted.map((entry) => entry.id).join(", ")}`,
            cause: {
              ...(Option.isSome(failure) ? { failure: failure.value } : {}),
              residue: sorted
            }
          })
        )
      }
      if (!Exit.isSuccess(exit) && policy === "compensate" && Option.isSome(failure)) {
        return Effect.succeed<Settled<A, E>>({ _tag: "Compensated", failure: failure.value })
      }
      // A failure exit short-circuits the map and re-raises; a success exit
      // becomes the completed envelope.
      return Effect.map(exit, (values): Settled<A, E> => ({ _tag: "Completed", values }))
    }
    return Effect.flatMap(Effect.exit(Effect.scoped(forward)), settle)
  })
}
