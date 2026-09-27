/**
 * Scoped error boundary: a protected body, a filtered recovery arm, and a
 * finalizer that runs on every path.
 *
 * `Node.catch` alone recovers a typed failure. This pattern adds the third
 * arm: cleanup that runs after success, after recovery, and after a failure no
 * handler claimed. The declaration shows the finalizer on both arms, so a
 * reader sees that nothing leaves the boundary without it.
 *
 * @see https://smithers.sh/docs/concepts/retries
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * The declared form of an error boundary.
 *
 * @category models
 * @since 0.1.0
 */
export type TryCatchFinallyFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Configuration for {@link make}.
 *
 * `catch` receives `{ error, input }`; `finally` receives `{ input }`.
 * `catchSchema` selects which typed failures reach `catch`; without it the
 * whole error channel does. Supplying `catchSchema` requires `catch`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly try: Member<R>
  readonly catch?: Member<R> | undefined
  readonly catchSchema?: Schema.Top | undefined
  readonly finally?: Member<R> | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * `catchErrors` is a predicate where `make` takes a `catchSchema`, because
 * the runtime form already holds the decoded typed error. Supplying it
 * requires `catch`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, B = A, E2 = never, R2 = never, E3 = never, R3 = never> {
  readonly try: (input: I) => Effect.Effect<A, E, R>
  readonly catch?: ((error: E, input: I) => Effect.Effect<B, E2, R2>) | undefined
  readonly catchErrors?: ((error: E) => boolean) | undefined
  readonly finally?: ((input: I) => Effect.Effect<unknown, E3, R3>) | undefined
}

/**
 * Declares the boundary: the protected call, the filtered recovery arm, and a
 * finalizer call on the settled arm and on the unhandled-failure arm.
 *
 * The unhandled arm ends in `Node.fail`, so the plan states that the finalizer
 * cleans up and hands the failure back rather than absorbing it. A finalizer
 * that fails on that arm is absorbed rather than raised, so the body failure
 * the arm exists to re-raise stays the one the boundary reports, matching the
 * precedence {@link run} applies. That boundary protects the body alone; the
 * settled arm's finalizer is sequenced after it, so a finalizer that fails on
 * the success path is not re-run by the arm meant for the body's failures.
 *
 * Both recovery arms are wrapped in `Node.capture`, so every node this
 * declaration builds keys the same way on every build. An uncaptured arm would
 * take process-local identity and re-key the boundary on each build, which
 * content-addressed step identity cannot tolerate.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): TryCatchFinallyFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const arms = { try: options.try, catch: options.catch, catchSchema: options.catchSchema, finally: options.finally }
  if (arms.catchSchema !== undefined && arms.catch === undefined) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "TryCatchFinally catchSchema requires catch"
    })
  }
  const { name, description } = Compose.label("tryCatchFinally", {
    catch: arms.catch !== undefined,
    finally: arms.finally !== undefined
  }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const finalize = arms.finally
    // The body's value is a planned reference until the run produces it, so
    // the finalizer is SEQUENCED ahead of a node that hands that reference
    // back. A mapper closing over the reference would return the placeholder.
    // A finalizer that fails after the body settled fails `finalizer_failed`
    // with its error as the cause, as `run` does. The error is a planned
    // reference while the graph builds, so the record is made at run time.
    const settle = (value: unknown): Node.Node<unknown, unknown, R> =>
      finalize === undefined
        ? Node.succeed(value)
        : Node.andThen(
          Node.catch(callMember(finalize, { input }), {
            onFailure: Node.capture({ finalizerFailed: true }, (error: unknown) =>
              Node.bindPlanned(
                Node.map(
                  Node.succeed(error),
                  Node.capture({ finalizerFailed: true }, (cause: unknown) =>
                    new PatternError({
                      code: "finalizer_failed",
                      message: "The TryCatchFinally finalizer failed after the protected body succeeded",
                      cause
                    }))
                ),
                Node.capture({ finalizerFailed: true }, (failure) => Node.fail(failure))
              ))
          }),
          Node.succeed(value)
        )
    const attempt = callMember(arms.try, input)
    const handler = arms.catch
    const recover = (handled: Member<R>) => {
      const onFailure = Node.capture(
        { handled: true },
        (error: unknown): Node.Node<unknown, unknown, R> => callMember(handled, { error, input })
      )
      const filter = arms.catchSchema as Schema.Schema<unknown> | undefined
      return filter === undefined
        ? Node.catch(attempt, { onFailure })
        : Node.catch(attempt, { error: filter, onFailure })
    }
    const recovered = handler === undefined ? attempt : recover(handler)
    // The unhandled-failure boundary wraps the BODY alone. Sequencing the
    // success-arm finalizer after it, rather than inside it, keeps the
    // declaration honest: a finalizer that fails on the success path is
    // not caught here and re-run, which is exactly what `run` does.
    const guarded = finalize === undefined ? recovered : Node.catch(recovered, {
      onFailure: Node.capture(
        { rethrow: true },
        (error: unknown) =>
          Node.andThen(
            // The body failure is what this arm re-raises, so a finalizer
            // that fails here must not take its place: without this catch
            // the re-raise never runs and the boundary reports the cleanup
            // error instead, which is the opposite of what `run` does. The
            // finalizer call is its own step, so the absorbed failure still
            // stands in the journal.
            Node.catch(callMember(finalize, { input }), {
              onFailure: Node.capture({ cleanupFailed: true }, () => Node.succeed(null))
            }),
            Node.fail(error)
          )
      )
    })
    return Node.bindPlanned(guarded, Node.capture({ settled: true }, (value) => settle(value)))
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture(
      { catch: arms.catch !== undefined, finally: arms.finally !== undefined },
      body
    )
  })
}

/**
 * Runs the boundary.
 *
 * The finalizer runs after success, after recovery, after an unclaimed
 * failure, and after interruption. A finalizer that fails on its own becomes
 * `PatternError { code: "finalizer_failed" }`; a body failure outranks it, so
 * cleanup trouble never hides the reason the body failed. When both fail the
 * cleanup failure is kept behind the body failure on the same cause rather
 * than dropped, so a lock left held still has a record.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, B = A, E2 = never, R2 = never, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, A, E, R, B, E2, R2, E3, R3>
): Effect.Effect<A | B, E | E2 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const arms = { try: options.try, catch: options.catch, catchErrors: options.catchErrors, finally: options.finally }
  if (arms.catchErrors !== undefined && arms.catch === undefined) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "TryCatchFinally catchErrors requires catch"
      })
    )
  }
  const handler = arms.catch
  const attempt = Effect.suspend(() => arms.try(input))
  const guarded: Effect.Effect<A | B, E | E2, R | R2> = handler === undefined
    ? attempt
    : Effect.catchIf(
      attempt,
      (error): error is E => arms.catchErrors === undefined || arms.catchErrors(error),
      (error) => handler(error, input)
    )
  const finalize = arms.finally
  if (finalize === undefined) return guarded
  // `Effect.onExit` combines a failing finalizer's cause behind the body's own,
  // so raising here keeps the body failure first and still leaves the cleanup
  // failure on the cause instead of discarding it.
  return Effect.onExit(guarded, (exit) =>
    Effect.matchEffect(finalize(input), {
      onFailure: (error) =>
        Effect.fail(
          new PatternError({
            code: "finalizer_failed",
            message: Exit.isSuccess(exit)
              ? "The TryCatchFinally finalizer failed after the protected body succeeded"
              : "The TryCatchFinally finalizer failed after the protected body failed",
            cause: error
          })
        ),
      onSuccess: () => Effect.void
    }))
}
