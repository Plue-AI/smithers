/**
 * `EngineSubject` adapter over the real `/engine`.
 *
 * This is the authoritative subject for the core conformance operations:
 * identity, replay, race, and interruption run against the production engine,
 * not a test-only model. Governing design:
 * `packages/testing/docs/concepts/engine-subject.md`. Smithers capabilities absent from the production
 * contract are recorded as parity gaps rather than simulated. The adapter
 * registers each `FlowSpec` as a real `Flow` whose execute function
 * runs every step as an `Action`:
 *
 * - Sealed steps declare their spec key as the activity idempotency key, so
 *   the engine derives content identity from it and aliased sealed steps
 *   replay one recorded result.
 * - Unsealed steps declare no idempotency key, so the engine derives
 *   occurrence (ordinal) identity and duplicate declared keys run separately.
 * - Race steps run through `Action.raceAll`, the engine's durable race.
 *
 * Step outcomes are journaled by the adapter as they settle; replayed steps
 * never invoke their closures, so the journal is written exactly once per
 * behavior-bearing outcome.
 *
 * @since 0.0.0
 */

import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import {
  type EngineSubject as EngineSubjectService,
  EngineSubject as EngineSubjectTag,
  type ExecutionResult,
  type FlowSpec,
  type JournalEntryLike,
  type StepSpec
} from "./EngineSubject.ts"
import { conflict, type ExecutionConflict } from "./internal/Execution.ts"
import type { EngineSubjectError } from "./TestingError.ts"
import { EngineUnavailableError } from "./TestingError.ts"

/**
 * The payload wrapper the adapter registers for every `FlowSpec`.
 *
 * `value` is an optional key rather than a required one because the engine
 * stores a payload through the flow's own JSON codec, and `undefined` is not a
 * JSON value. A caller that runs a flow with no payload therefore encodes as
 * `{}`, which round-trips, instead of as `{ value: undefined }`, which the
 * codec rejects. Absence is already how {@link ExecutionResult} spells "no
 * value", so both directions of the subject agree.
 */
const payloadSchema = Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) })

type Subject = Flow.Flow<
  string,
  typeof payloadSchema,
  typeof Schema.Unknown,
  typeof Schema.Unknown
>

interface ExecutionMeta {
  readonly flow: Subject
  /** What the execution was started with, so a re-submission can be checked. */
  readonly submitted: ExecutionConflict
}

const unavailable = (message: string): EngineUnavailableError => new EngineUnavailableError({ message })

/**
 * How many scheduler passes `awaitResult` gives a runtime to publish a result
 * whose body has already exited. Publication takes a handful of passes, so the
 * budget is generous; its purpose is to convert a runtime that never publishes
 * from a hang into a typed failure naming the execution.
 */
const publicationPasses = 1000

const makeResult = (
  executionId: string,
  status: ExecutionResult["status"],
  value: unknown
): ExecutionResult => value === undefined ? { executionId, status } : { executionId, status, value }

const toExecutionResult = (
  executionId: string,
  result: Flow.Result<unknown, unknown>
): ExecutionResult => {
  if (result._tag === "Suspended") {
    return { executionId, status: "suspended" }
  }
  // A `Handoff` ends a round by naming the next round of a trampoline
  // lineage. The adapter's flows never plan a handoff, so observing one here
  // is outside the subject contract and settles as a typed failure rather
  // than a misread completion.
  if (result._tag === "Handoff") {
    return makeResult(
      executionId,
      "failed",
      unavailable(`Execution ${executionId} handed off to flow ${result.flow}, which the engine subject does not model`)
    )
  }
  const exit = result.exit
  if (Exit.isSuccess(exit)) {
    return makeResult(executionId, "completed", exit.value)
  }
  return Cause.hasInterruptsOnly(exit.cause)
    ? { executionId, status: "aborted" }
    : makeResult(executionId, "failed", Cause.squash(exit.cause))
}

/**
 * Classifies the exit of one execution *attempt* of a registered flow body.
 *
 * This is the completion signal the adapter settles `awaitResult` with, so it
 * must distinguish the two interrupt-shaped outcomes the engine collapses into
 * a single interrupted exit: a body that asked for suspension via
 * `Flow.suspend` (which sets `instance.suspended` before interrupting) and
 * a body torn down by `interruptUnsafe`.
 */
const attemptToExecutionResult = (
  executionId: string,
  instance: FlowRuntime.FlowInstance["Service"],
  exit: Exit.Exit<unknown, unknown>
): ExecutionResult => {
  if (Exit.isSuccess(exit)) {
    return makeResult(executionId, "completed", exit.value)
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { executionId, status: instance.suspended ? "suspended" : "aborted" }
  }
  return makeResult(executionId, "failed", Cause.squash(exit.cause))
}

const append = (
  journal: Array<JournalEntryLike>,
  stepKey: string,
  kind: string,
  outcome: JournalEntryLike["outcome"],
  value: unknown
): Effect.Effect<void> =>
  Effect.sync(() => {
    journal.push(
      value === undefined
        ? { index: journal.length, stepKey, kind, outcome }
        : { index: journal.length, stepKey, kind, outcome, value }
    )
  })

/**
 * Runs a step closure in a child fiber so its own outcome stays observable:
 *
 * - success is journaled as `completed`,
 * - a self-interrupting closure is journaled as `suspended` and converted to
 *   an engine suspension via `Flow.suspend`,
 * - external interruption (engine abort or a lost race) is journaled as
 *   `aborted` and re-propagated,
 * - failure is journaled as `failed`.
 */
const instrument = <R>(
  journal: Array<JournalEntryLike>,
  step: { readonly key: string; readonly kind: string },
  effect: Effect.Effect<unknown, unknown, R>
): Effect.Effect<unknown, unknown, R | FlowRuntime.FlowInstance> =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.interruptible(effect).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const exit = yield* restore(Fiber.await(fiber)).pipe(
          Effect.onInterrupt(() =>
            Fiber.interrupt(fiber).pipe(
              Effect.andThen(append(journal, step.key, step.kind, "aborted", undefined))
            )
          )
        )
        if (Exit.isSuccess(exit)) {
          yield* append(journal, step.key, step.kind, "completed", exit.value)
          return exit.value
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          yield* append(journal, step.key, step.kind, "suspended", undefined)
          return yield* Flow.suspend(instance)
        }
        yield* append(journal, step.key, step.kind, "failed", Cause.squash(exit.cause))
        return yield* Effect.failCause(exit.cause)
      })
    )
  })

const stepActivity = (
  journal: Array<JournalEntryLike>,
  step: Extract<StepSpec, { readonly kind: "step" }>,
  input: unknown
) =>
  Action.make({
    name: step.key,
    success: Schema.Unknown,
    error: Schema.Unknown,
    ...(step.sealed ? { idempotencyKey: step.key } : {}),
    execute: instrument(journal, step, Effect.suspend(() => step.run(input)))
  })

const branchActivity = (
  journal: Array<JournalEntryLike>,
  branch: StepSpec,
  input: unknown
): Action.Action<typeof Schema.Unknown, typeof Schema.Unknown> =>
  branch.kind === "step"
    ? stepActivity(journal, branch, input)
    : Action.make({
      name: branch.key,
      success: Schema.Unknown,
      error: Schema.Unknown,
      ...(branch.sealed ? { idempotencyKey: branch.key } : {}),
      execute: instrument(journal, branch, raceStep(journal, branch, input))
    })

const raceStep = (
  journal: Array<JournalEntryLike>,
  race: Extract<StepSpec, { readonly kind: "race" }>,
  input: unknown
): Effect.Effect<
  unknown,
  unknown,
  FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto
> =>
  race.branches.length === 0
    ? Effect.fail(unavailable(`Race ${race.key} has no branches`))
    : Action.raceAll(
      race.key,
      race.branches.map((branch) => branchActivity(journal, branch, input)) as [
        Action.Action<typeof Schema.Unknown, typeof Schema.Unknown>
      ]
    )

/**
 * Constructs an `EngineSubject` over the real flow engine in the ambient
 * `FlowEngine` service.
 *
 * Each `run` registers the spec's flow (scoped to the construction
 * scope), starts the execution with `discard`, and then polls the engine
 * until the execution settles as completed, aborted, failed, or suspended.
 *
 * `interrupt` uses the engine's cooperative `FlowRuntime.interrupt`, which
 * delivers the interruption to the live body fiber. It is the durable engine's
 * only cancellation path: the release policy requires
 * `interruptUnsafe` to fail there with `unsafe_interrupt_unsupported`, so an
 * adapter built on it could not run a single interrupt pin against the engine
 * that ships.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (): Effect.Effect<
  EngineSubjectService,
  never,
  Scope.Scope | FlowRuntime.FlowRuntime | Crypto.Crypto
> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    // Captured once so the service methods stay `R = never`: a Context.Service
    // record cannot carry requirements, and the step-key derivation inside
    // `engine.register` needs a Crypto in strict type environments.
    const crypto = yield* Crypto.Crypto
    const journals = new Map<string, Array<JournalEntryLike>>()
    const executions = new Map<string, ExecutionMeta>()
    const idempotencyIndex = new Map<string, string>()
    const interrupted = new Set<string>()
    // Skips ids a caller already claimed explicitly, so an anonymous run can
    // never collide with `executionId: "engine-0"`. The memory reference
    // engine has always done this; the two subjects must agree.
    const freshExecutionId = (): string => {
      while (executions.has(`engine-${nextExecutionId}`)) nextExecutionId += 1
      return `engine-${nextExecutionId++}`
    }
    // One completion latch per execution *attempt*. `awaitResult` waits on it
    // instead of spinning on `engine.poll`, so an execution that settles only
    // after a delay (a timer, an external signal) costs one suspension rather
    // than an unbounded busy-poll that never yields the CPU to the sleeping
    // step.
    const settlements = new Map<string, Deferred.Deferred<ExecutionResult>>()
    let nextExecutionId = 0

    const arm = (executionId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        settlements.set(executionId, Deferred.makeUnsafe<ExecutionResult>())
      })

    const settle = (executionId: string, result: ExecutionResult): Effect.Effect<void> =>
      Effect.suspend(() => {
        const deferred = settlements.get(executionId)
        /* v8 ignore next -- Registered execution bodies settle only after run or resume arms their settlement. */
        return deferred === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(deferred, result))
      })

    const journalFor = (executionId: string): Array<JournalEntryLike> => {
      let journal = journals.get(executionId)
      if (journal === undefined) {
        journal = []
        journals.set(executionId, journal)
      }
      return journal
    }

    const register = (spec: FlowSpec): Effect.Effect<Subject> =>
      Effect.provideService(
        Effect.gen(function*() {
          const flow: Subject = Flow.make(spec.name, {
            payload: payloadSchema.fields,
            success: Schema.Unknown,
            error: Schema.Unknown,
            // The registration below supplies this flow's behavior: the engine
            // runs the registered execute and never interprets the plan-time
            // body `Flow.make` requires, so the declaration carries the
            // smallest honest body.
            /* v8 ignore next -- The registered execute function runs every subject flow, so the declarative body is never interpreted. */
            body: () => Node.succeed(undefined)
          })
          yield* engine.register(flow, (payload, executionId) =>
            Effect.suspend(() => {
              const journal = journalFor(executionId)
              return Effect.gen(function*() {
                const instance = yield* FlowRuntime.FlowInstance
                return yield* Effect.onExit(
                  Effect.gen(function*() {
                    let input: unknown = payload.value
                    for (const step of spec.steps) {
                      input = step.kind === "step"
                        ? yield* stepActivity(journal, step, input)
                        : yield* raceStep(journal, step, input)
                    }
                    return input
                  }),
                  (exit) => settle(executionId, attemptToExecutionResult(executionId, instance, exit))
                )
              })
            })).pipe(Scope.provide(scope))
          return flow
        }),
        Crypto.Crypto,
        crypto
      )

    const requireMeta = (executionId: string): Effect.Effect<ExecutionMeta, EngineUnavailableError> =>
      Effect.suspend(() => {
        const meta = executions.get(executionId)
        return meta === undefined
          ? Effect.fail(unavailable(`Execution ${executionId} is unavailable`))
          : Effect.succeed(meta)
      })

    const awaitResult = (executionId: string): Effect.Effect<ExecutionResult, EngineUnavailableError> =>
      Effect.gen(function*() {
        const meta = yield* requireMeta(executionId)
        const deferred = settlements.get(executionId)
        /* v8 ignore next 3 -- Every path to awaitResult arms a settlement after recording execution metadata, and settlements are never removed. */
        if (deferred === undefined) {
          return yield* Effect.fail(unavailable(`Execution ${executionId} has no pending settlement`))
        }
        // Completion signal. Nothing polls while the execution is still doing
        // work, so a step that settles only after a delay costs this fiber one
        // suspension instead of a hot `yieldNow` loop that starves the timer it
        // is waiting on.
        const settled = yield* Deferred.await(deferred)
        // The engine publishes the execution result a few scheduler steps after
        // the flow body exits. Confirm publication before reporting, so
        // `resume` observes a finished execution fiber rather than a live one,
        // which the engine refuses to re-enter. This loop only spans fiber
        // teardown -- the awaited work has already completed -- so it yields
        // the scheduler rather than sleeping, and it is bounded: a runtime
        // that never publishes fails typed here instead of spinning until the
        // runner's wall-clock timeout reports a generic hang.
        const confirm = (attempt: number): Effect.Effect<ExecutionResult, EngineUnavailableError> =>
          Effect.gen(function*() {
            const polled = yield* Effect.exit(engine.poll(meta.flow, executionId))
            // An interrupted execution leaves `poll` with nothing to decode;
            // the attempt classification already recorded the abort.
            if (Exit.isFailure(polled) || Option.isSome(polled.value)) return settled
            if (attempt >= publicationPasses) {
              return yield* Effect.fail(unavailable(
                `Execution ${executionId} settled but the flow engine did not publish its result within ${publicationPasses} scheduler passes`
              ))
            }
            yield* Effect.yieldNow
            return yield* confirm(attempt + 1)
          })
        return yield* confirm(0)
      })

    const run = (
      options: Parameters<EngineSubjectService["run"]>[0]
    ): Effect.Effect<ExecutionResult, EngineSubjectError> =>
      Effect.gen(function*() {
        const joinedId = options.idempotencyKey === undefined
          ? undefined
          : idempotencyIndex.get(options.idempotencyKey)
        const executionId = joinedId ?? options.executionId ?? freshExecutionId()
        const known = executions.get(executionId)
        if (known !== undefined) {
          // A re-submission that matches joins the existing execution; one
          // that disagrees about the flow or the payload is refused rather
          // than silently running the original.
          const difference = conflict(
            executionId,
            known.submitted,
            { flowName: options.flow.name, payload: options.payload }
          )
          if (Option.isSome(difference)) return yield* Effect.fail(difference.value)
        }
        if (options.idempotencyKey !== undefined) {
          idempotencyIndex.set(options.idempotencyKey, executionId)
        }
        if (known === undefined) {
          const flow = yield* register(options.flow)
          executions.set(executionId, {
            flow,
            submitted: { flowName: options.flow.name, payload: options.payload }
          })
          journalFor(executionId)
          // Armed before submission so the body can never settle a latch that
          // does not exist yet.
          yield* arm(executionId)
          yield* engine.execute(flow, {
            executionId,
            // Omitted rather than set to `undefined`: see `payloadSchema`.
            payload: options.payload === undefined ? {} : { value: options.payload },
            discard: true
          }).pipe(
            // `FlowCycleDetected` is part of the engine's typed `execute`
            // contract — a recoverable failure the caller matches on — so it
            // passes through untouched. Every other submission failure is
            // foreign to this seam and maps onto the subject's typed channel
            // instead of widening the channel back to `unknown`.
            Effect.mapError((cause) =>
              cause instanceof FlowRuntime.FlowCycleDetected
                ? cause
                : unavailable(`Execution ${executionId} could not be submitted to the flow engine: ${String(cause)}`)
            )
          )
        }
        return yield* awaitResult(executionId)
      })

    const result = (executionId: string): Effect.Effect<ExecutionResult, EngineSubjectError> =>
      Effect.gen(function*() {
        const meta = yield* requireMeta(executionId)
        // Cancellation can re-drive a suspended round without entering the
        // registered body. In that case only the runtime has its latest exit.
        const deferred = settlements.get(executionId)
        if (!interrupted.has(executionId) && deferred !== undefined && Deferred.isDoneUnsafe(deferred)) {
          return yield* Deferred.await(deferred)
        }
        const polled = yield* Effect.exit(engine.poll(meta.flow, executionId))
        if (Exit.isFailure(polled)) {
          return interrupted.has(executionId)
            ? { executionId, status: "aborted" as const }
            : yield* Effect.fail(
              unavailable(`Execution ${executionId} failed while polling: ${String(polled.cause)}`)
            )
        }
        return Option.isSome(polled.value)
          ? toExecutionResult(executionId, polled.value.value)
          : { executionId, status: "suspended" as const }
      })

    const interrupt = (executionId: string): Effect.Effect<void, EngineSubjectError> =>
      Effect.gen(function*() {
        const meta = executions.get(executionId)
        if (meta === undefined) return
        const deferred = settlements.get(executionId)
        const wasSettled = deferred !== undefined && Deferred.isDoneUnsafe(deferred)
        if (wasSettled) yield* arm(executionId)
        interrupted.add(executionId)
        // `interrupt`, never `interruptUnsafe`: the durable engine refuses the
        // unsafe path with `unsafe_interrupt_unsupported` by contract, and the
        // safe path does deliver the interruption to the live body fiber.
        yield* engine.interrupt(meta.flow, executionId)
        if (!wasSettled) return
        // A cancelled parked round can self-interrupt before the registered
        // body installs its onExit. Publish that round's exit to the fresh
        // latch so run joins and resume cannot reuse its earlier suspension.
        for (let attempt = 0;; attempt++) {
          const current = yield* result(executionId)
          if (current.status !== "suspended") {
            yield* settle(executionId, current)
            return
          }
          if (attempt >= publicationPasses) {
            return yield* Effect.fail(unavailable(
              `Execution ${executionId} did not publish its cancellation result within ${publicationPasses} scheduler passes`
            ))
          }
          yield* Effect.yieldNow
        }
      })

    const resume = (executionId: string): Effect.Effect<ExecutionResult, EngineSubjectError> =>
      Effect.gen(function*() {
        const meta = yield* requireMeta(executionId)
        // The engine only re-enters a *suspended* execution; resuming a
        // settled one is a no-op that would never settle a fresh latch.
        const current = yield* result(executionId)
        if (current.status !== "suspended") return current
        yield* arm(executionId)
        yield* engine.resume(meta.flow, executionId)
        return yield* awaitResult(executionId)
      })

    const journal = (executionId: string): Effect.Effect<ReadonlyArray<JournalEntryLike>, EngineSubjectError> =>
      Effect.suspend(() => {
        const stored = journals.get(executionId)
        return stored === undefined
          ? Effect.fail(unavailable(`Execution ${executionId} is unavailable`))
          : Effect.succeed(stored.slice())
      })

    return EngineSubjectTag.of({
      name: "FlowEngineLike",
      run,
      result,
      interrupt,
      resume,
      journal
    })
  })

/**
 * Provides an `EngineSubject` over the ambient `FlowEngine` service.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (): Layer.Layer<
  EngineSubjectService,
  never,
  FlowRuntime.FlowRuntime | Crypto.Crypto
> => Layer.effect(EngineSubjectTag)(make())

/**
 * Web Crypto as the engine's `Crypto`, so `layerMemory` stays a
 * zero-configuration bundle. The engine digests step identities through the
 * service, and `globalThis.crypto` is the one implementation both Node and the
 * browser ship — pulling in a platform package here would cost this package
 * its browser safety.
 */
const layerWebCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, data as BufferSource)),
        (digested) => new Uint8Array(digested)
      )
  })
)

/**
 * Provides an `EngineSubject` over any `FlowRuntime` implementation.
 *
 * This is the seam the conformance suite binds to. `make` reads the runtime
 * out of the ambient service and never names an implementation, so the same
 * case list runs against whichever runtime is provided here: the volatile
 * `FlowEngine.layerMemory` below, or the durable engine, whose runtime layer
 * is `EngineStore.layer({ owner, journalSource })` in `@smthrs/engine-store`.
 * That package is not a dependency of this one, so the durable binding belongs
 * to a suite that already has it; supplying its layer is the whole connection.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerOver = <E, R>(
  runtime: Layer.Layer<FlowRuntime.FlowRuntime, E, R>
): Layer.Layer<EngineSubjectService | Crypto.Crypto, E, R> =>
  layer().pipe(
    Layer.provide(runtime),
    Layer.provideMerge(layerWebCrypto)
  )

/**
 * Provides an `EngineSubject` over the engine's in-memory implementation.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerMemory: Layer.Layer<EngineSubjectService | Crypto.Crypto> = layerOver(FlowEngine.layerMemory)
