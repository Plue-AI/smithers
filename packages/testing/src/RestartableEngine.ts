/**
 * Scoped restart harness for the reference in-memory engine.
 *
 * @since 0.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import {
  type EngineSubject as EngineSubjectService,
  EngineSubject as EngineSubjectTag,
  type ExecutionResult
} from "./EngineSubject.ts"
import { type EngineStore, make as makeMemoryEngine, makeStore } from "./MemoryEngine.ts"
import type { EngineSubjectError, EngineUnavailableError } from "./TestingError.ts"

interface EngineInstance {
  readonly engine: EngineSubjectService
  readonly scope: Scope.Closeable
}

/**
 * A stable engine facade and controls for replacing its live in-memory
 * instance while retaining the persistent execution store.
 *
 * @category models
 * @since 0.0.0
 */
export interface Restartable {
  readonly engine: EngineSubjectService
  readonly restart: Effect.Effect<void, EngineUnavailableError>
  /**
   * Replaces the live instance WITHOUT closing the one it replaces.
   *
   * The difference from {@link restart} is the release. A restart closes the
   * outgoing instance's scope, so its fibers are interrupted and its
   * finalizers run — the orderly shutdown a process performs when it is asked
   * to stop. A kill runs neither: the abandoned instance keeps whatever it
   * held, exactly as SIGKILL leaves a durable owner holding a run it will
   * never release, which is the state lease-based reclaim has to recover from
   * (`Ownership.leaseLiveness`).
   *
   * The abandoned scope is still closed when the harness's own scope closes,
   * so a killed instance leaks nothing past the test that killed it.
   */
  readonly kill: Effect.Effect<void, EngineUnavailableError>
  /**
   * {@link restart}, then `resume` on the fresh instance: the orderly
   * shutdown-and-restart a process performs when it is asked to stop.
   *
   * This is what `killAndResume` used to do under a name that promised the
   * opposite, so every restart-flavoured conformance run exercised the orderly
   * path and the hard-kill state no case ever reached.
   */
  readonly restartAndResume: (
    executionId: string
  ) => Effect.Effect<ExecutionResult, EngineSubjectError>
  /**
   * {@link kill}, then `resume` on the fresh instance while the killed one is
   * still running and unreleased. This is the state a lease-based reclaim
   * recovers from, and the only variant that produces it.
   */
  readonly killAndResume: (
    executionId: string
  ) => Effect.Effect<ExecutionResult, EngineSubjectError>
}

const buildInstance = (
  store: EngineStore
): Effect.Effect<EngineInstance> =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const engine = yield* makeMemoryEngine(store).pipe(Scope.provide(scope))
    return { engine, scope }
  })

/**
 * Constructs a restartable engine over one persistent `MemoryEngine` store.
 *
 * `restart` closes the current instance scope, interrupting all of its live
 * execution fibers, and then constructs a fresh engine over the same store.
 * `kill` builds the same fresh engine but leaves the outgoing one running and
 * unreleased, which is the hard-kill state a lease-based reclaim recovers
 * from. The exposed engine is a stable facade that always delegates to the
 * current instance.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (): Effect.Effect<
  Restartable,
  EngineUnavailableError,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const store = yield* makeStore()
    const initial = yield* buildInstance(store)
    const current = yield* Ref.make(initial)
    /**
     * Instances dropped by {@link Restartable.kill}. A killed instance is
     * deliberately left running for the rest of the test, so the harness — not
     * the kill — owns closing it, and nothing survives the harness scope.
     */
    const abandoned = yield* Ref.make<ReadonlyArray<Scope.Closeable>>([])

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function*() {
        const instance = yield* Ref.get(current)
        yield* Scope.close(instance.scope, exit)
        yield* Effect.forEach(
          yield* Ref.get(abandoned),
          (scope) => Scope.close(scope, exit),
          { discard: true }
        )
      })
    )

    const restart: Effect.Effect<void, EngineUnavailableError> = Effect.gen(function*() {
      const previous = yield* Ref.get(current)
      yield* Scope.close(previous.scope, Exit.void)
      const next = yield* buildInstance(store)
      yield* Ref.set(current, next)
    })

    const kill: Effect.Effect<void, EngineUnavailableError> = Effect.gen(function*() {
      const previous = yield* Ref.get(current)
      yield* Ref.update(abandoned, (scopes) => [...scopes, previous.scope])
      const next = yield* buildInstance(store)
      yield* Ref.set(current, next)
    })

    const withEngine = <A>(
      f: (engine: EngineSubjectService) => Effect.Effect<A, EngineSubjectError>
    ): Effect.Effect<A, EngineSubjectError> =>
      Ref.get(current).pipe(
        Effect.flatMap((instance) => f(instance.engine))
      )

    const engine = EngineSubjectTag.of({
      name: "RestartableEngine",
      run: (options) => withEngine((subject) => subject.run(options)),
      result: (executionId) => withEngine((subject) => subject.result(executionId)),
      interrupt: (executionId) => withEngine((subject) => subject.interrupt(executionId)),
      resume: (executionId) => withEngine((subject) => subject.resume(executionId)),
      journal: (executionId) => withEngine((subject) => subject.journal(executionId))
    })

    return {
      engine,
      restart,
      kill,
      restartAndResume: (executionId) =>
        restart.pipe(
          Effect.andThen(withEngine((subject) => subject.resume(executionId)))
        ),
      killAndResume: (executionId) =>
        kill.pipe(
          Effect.andThen(withEngine((subject) => subject.resume(executionId)))
        )
    }
  })
