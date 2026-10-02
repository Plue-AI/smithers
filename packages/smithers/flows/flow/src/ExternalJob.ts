/**
 * Durable external work as ordinary actions, handoffs and parked timers.
 *
 * @since 1.0.0
 */

import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as Fault from "./Fault.ts"
import * as Flow from "./Flow/index.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { ExecutionMiddleware } from "./internal/ExecutionMiddleware.ts"
import * as Interpreter from "./Interpreter.ts"
import * as Sleep from "./Sleep.ts"

/**
 * External process observation.
 * @category schemas
 * @since 1.0.0
 */
export const Status = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Running") }),
  Schema.Struct({ _tag: Schema.Literal("Exited"), exitCode: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("Lost") })
])
/**
 * Decoded external process observation.
 * @category models
 * @since 1.0.0
 */
export type Status = typeof Status.Type
/**
 * Decoded external process observation.
 * @category models
 * @since 1.0.0
 */
export type Exited = Extract<Status, { readonly _tag: "Exited" }>
/**
 * A collected exit that can be replaced.
 *
 * @category errors
 * @since 1.0.0
 */
export class Again extends Schema.TaggedError<Again>()("@smthrs/flow/ExternalJobAgain", { message: Schema.String }) {}
/**
 * No worker or exit receipt remains.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExternalJobLost extends Schema.TaggedError<ExternalJobLost>()("@smthrs/flow/ExternalJobLost", {
  key: Schema.String,
  message: Schema.String
}) {}
/**
 * The deadline anchored before initial start elapsed.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExternalJobTimedOut extends Schema.TaggedError<ExternalJobTimedOut>()("@smthrs/flow/ExternalJobTimedOut", {
  key: Schema.String,
  message: Schema.String
}) {}
Fault.register("@smthrs/flow/ExternalJobLost", "infra")
Fault.register("@smthrs/flow/ExternalJobTimedOut", "dependency")

const millis = (value: Duration.Input, field: string): number => {
  const parsed = Duration.fromInput(value)
  const result = Option.isSome(parsed) ? Duration.toMillis(parsed.value) : NaN
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError(`ExternalJob.make: ${field} must be a finite positive duration`)
  }
  return result
}
/**
 * The adapter's full typed failure union belongs in make's error schema.
 *
 * @category models
 * @since 1.0.0
 */
export interface Operations<P, H, A, E, R> {
  readonly start: (payload: P, key: string) => Effect.Effect<H, E, R>
  readonly status: (handle: H, key: string) => Effect.Effect<Status, E, R>
  readonly collect: (handle: H, key: string, exited: Exited) => Effect.Effect<A, E | Again, R>
  readonly cancel: (handle: H, key: string) => Effect.Effect<void, never, R>
}

/**
 * Create-or-get by execution id and generation. Private ordinary flows carry
 * journaled state; initial callers cannot supply a key or continuation handle.
 * `restarts` counts replacement generations; zero permits only g1.
 * @category constructors
 * @since 1.0.0
 */
export const make = <
  const Tag extends string,
  P extends Schema.Struct.Fields | Flow.AnyStructSchema,
  H extends Schema.Top,
  A extends Schema.Top,
  E extends Schema.Top = typeof Schema.Never
>(tag: Tag, options: {
  readonly payload: P
  readonly handle: H
  readonly success: A
  readonly error?: E
  readonly probe: { readonly every: Duration.Input; readonly max: Duration.Input }
  readonly timeout: Duration.Input
  readonly restarts?: number
}) => {
  const every = millis(options.probe.every, "probe.every")
  const maximum = millis(options.probe.max, "probe.max")
  const timeout = millis(options.timeout, "timeout")
  const restarts = options.restarts ?? 0
  if (maximum < every) throw new RangeError("ExternalJob.make: probe.max must be at least probe.every")
  if (!Number.isSafeInteger(restarts) || restarts < 0) {
    throw new RangeError("ExternalJob.make: restarts must be a nonnegative safe integer")
  }
  type Input = P extends Schema.Struct.Fields ? Schema.Struct<P> : P
  // Erase field modifiers at nesting boundaries: these are required values,
  // even when the author's schema contains optional fields internally.
  const input =
    (Schema.isSchema(options.payload) ? options.payload : Schema.Struct(options.payload)) as unknown as Schema.Codec<
      Input["Type"],
      Input["Encoded"],
      Input["DecodingServices"],
      Input["EncodingServices"]
    >
  const handle = options.handle as Schema.Codec<H["Type"], H["Encoded"], H["DecodingServices"], H["EncodingServices"]>
  const providerError = (options.error ?? Schema.Never) as E
  const failure = Schema.Union([providerError, ExternalJobLost, ExternalJobTimedOut, Sleep.SleepRequestInvalid])
  const state = Schema.Struct({
    input,
    origin: Schema.String,
    startedAt: Schema.Number,
    generation: Schema.Int,
    probe: Schema.Int
  })
  const observed = Schema.Struct({ ...state.fields, handle })
  type State = typeof state.Type
  type Observed = typeof observed.Type
  const keyOf = (job: { readonly origin: string; readonly generation: number }) => `${job.origin}#g${job.generation}`
  const captures = { tag, every, maximum, timeout, restarts, version: "external-job/v1" }
  type Active = { executionId: string; current: { handle: H["Type"]; key: string } | undefined }
  const active = Context.Service<Active>(`${tag}/ExternalJobActive`)
  const cancellations = new WeakMap<object, (handle: H["Type"], key: string) => Effect.Effect<void>>()
  const annotations = Context.make(ExecutionMiddleware, {
    wrap: (payload, body) =>
      Effect.gen(function*() {
        const instance = yield* FlowInstance
        const table = yield* Action.Implementations
        const cancel = cancellations.get(table)
        if (cancel === undefined) {
          return yield* Effect.die(
            new Interpreter.InterpreterError({
              code: "unresolved_action",
              flow: tag,
              node: `${tag}/cancel`,
              message: `ExternalJob ${tag} has no cancellation implementation; provide its toLayer`
            })
          )
        }
        const current: Active = {
          executionId: instance.executionId,
          current: instance.flow._tag === `${tag}/observe`
            ? { handle: (payload as Observed).handle, key: keyOf(payload as Observed) } :
            undefined
        }
        yield* Flow.withRollback(Effect.succeed(current), (value, cause) =>
          Cause.hasInterruptsOnly(cause) && !instance.interrupted && !instance.suspended || value.current === undefined
            ? Effect.void :
            cancel(value.current.handle, value.current.key))
        return yield* body.pipe(Effect.provideService(active, current))
      })
  })
  const Initialize = Action.make(`${tag}/initialize`, { payload: { input }, success: state })
  const Start = Action.make(`${tag}/start`, {
    payload: state,
    success: options.handle,
    error: providerError,
    tier: "irreversible",
    idempotencyKey: keyOf
  })
  const Probe = Action.make(`${tag}/status`, {
    payload: observed,
    success: Schema.Struct({
      status: Status,
      timedOut: Schema.Boolean,
      wakeAt: Schema.Number,
      next: observed,
      restart: state
    }),
    error: providerError,
    implementationVersion: "external-job/status/v1",
    effects: { reads: [], writes: [], mode: "expected", onConflict: "fail" },
    tier: "sealed",
    idempotencyKey: (job) => `${keyOf(job)}/probe/${job.probe}`
  })
  const Collect = Action.make(`${tag}/collect`, {
    payload: { job: observed, exited: Schema.Struct({ _tag: Schema.Literal("Exited"), exitCode: Schema.Int }) },
    success: options.success,
    error: Schema.Union([providerError, Again]),
    tier: "irreversible",
    idempotencyKey: ({ job }) => `${keyOf(job)}/collect`
  })
  const Cancel = Action.make(`${tag}/cancel`, {
    payload: observed,
    success: Schema.Void,
    tier: "irreversible",
    idempotencyKey: (job) => `${keyOf(job)}/cancel`
  })
  const Fail = Action.make(`${tag}/fail`, {
    payload: { job: observed, timedOut: Schema.Boolean },
    success: Schema.Never,
    error: Schema.Union([ExternalJobLost, ExternalJobTimedOut])
  })
  const Ready = Action.make(`${tag}/ready`, { payload: state, success: Schema.Boolean })
  const LaunchFailure = Action.make(`${tag}/launch-timeout`, {
    payload: state,
    success: Schema.Never,
    error: ExternalJobTimedOut
  })
  const launched = (job: State | Action.PlannedPayload<State>) =>
    Start.call(job as Action.PlannedPayload<State>).pipe(
      Node.bindPlanned((handle) =>
        observe.to({
          input: job.input,
          origin: job.origin,
          startedAt: job.startedAt,
          generation: job.generation,
          probe: job.probe,
          handle
        })
      )
    )
  // Pin the declared union through recursive bodies: cross-package inference
  // otherwise narrows the error schema to the provider-only generic E.
  const launch: Flow.Flow<string, typeof state, A, typeof failure, Action.Requirement<string>> = Flow.make<
    `${Tag}/launch`,
    typeof state,
    A,
    typeof failure,
    Action.Requirement<string>
  >(
    `${tag}/launch`,
    {
      payload: state,
      success: options.success,
      error: failure,
      annotations,
      body: Node.capture(
        captures,
        (job) =>
          Ready.call(job).pipe(Node.branch({
            if: Node.capture(captures, (ready) => ready),
            then: () => launched(job),
            else: () => LaunchFailure.call(job)
          }))
      )
    }
  )
  const recover = (job: Observed, result: Action.PlannedPayload<{ restart: State; wakeAt: number }>) =>
    Cancel.call(job).pipe(Node.andThen(
      Node.succeed(job).pipe(Node.branch({
        if: Node.capture(captures, (current) => current.generation <= restarts),
        then: () => Sleep.action.call({ until: result.wakeAt }).pipe(Node.andThen(launch.to(result.restart))),
        else: () => Fail.call({ job, timedOut: false })
      }))
    ))
  const observe: Flow.Flow<string, typeof observed, A, typeof failure, Action.Requirement<string>> = Flow.make<
    `${Tag}/observe`,
    typeof observed,
    A,
    typeof failure,
    Action.Requirement<string>
  >(
    `${tag}/observe`,
    {
      payload: observed,
      success: options.success,
      error: failure,
      annotations,
      body: Node.capture(
        captures,
        (job) =>
          Probe.call(job).pipe(Node.bindPlanned((result) =>
            Node.succeed(result).pipe(Node.branch({
              if: Node.capture(captures, (value) => value.timedOut),
              then: () => Cancel.call(job).pipe(Node.andThen(Fail.call({ job, timedOut: true }))),
              else: () =>
                Node.succeed(result.status).pipe(Node.branch({
                  if: Node.capture(captures, (status) => status._tag === "Running"),
                  then: () => Sleep.action.call({ until: result.wakeAt }).pipe(Node.andThen(observe.to(result.next))),
                  else: (status) =>
                    Node.succeed(status).pipe(Node.branch({
                      if: Node.capture(captures, (value) => value._tag === "Lost"),
                      then: () => recover(job, result),
                      else: (exited) =>
                        Collect.call({ job, exited: exited as unknown as Exited }).pipe(
                          Node.catch({ error: Again, onFailure: () => recover(job, result) })
                        )
                    }))
                }))
            }))
          ))
      )
    }
  )
  const flow = Flow.make<Tag, P, A, typeof failure, Action.Requirement<string>>(tag, {
    payload: options.payload,
    success: options.success,
    error: failure,
    annotations,
    body: Node.capture(captures, (payload) => Initialize.call({ input: payload }).pipe(Node.bindPlanned(launched)))
  })
  const toLayer = <R>(operations: Operations<typeof input.Type, H["Type"], A["Type"], E["Type"], R>) => {
    const bindCancellation = Layer.effectDiscard(Effect.gen(function*() {
      const table = yield* Action.Implementations
      const context = yield* Effect.context<R>()
      const cancel = (handle: H["Type"], key: string) =>
        operations.cancel(handle, key).pipe(Effect.provideContext(context))
      cancellations.set(table, cancel)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (cancellations.get(table) === cancel) cancellations.delete(table)
        })
      )
    }))
    const interpreter = Layer.mergeAll(Interpreter.layer(flow), Interpreter.layer(launch), Interpreter.layer(observe))
    const layer = Layer.mergeAll(
      interpreter,
      bindCancellation,
      Sleep.layer,
      Initialize.toLayer(({ input }) =>
        Effect.gen(function*() {
          const instance = yield* active
          return {
            input,
            origin: instance.executionId,
            startedAt: Math.floor(yield* Clock.currentTimeMillis),
            generation: 1,
            probe: 1
          }
        })
      ),
      Start.toLayer((job) =>
        Effect.tap(operations.start(job.input, keyOf(job)), (handle) =>
          Effect.map(active, (value) => {
            value.current = { handle, key: keyOf(job) }
          }))
      ),
      Probe.toLayer((job) =>
        Effect.gen(function*() {
          let now = Math.floor(yield* Clock.currentTimeMillis)
          const deadline = job.startedAt + timeout
          let timedOut = now >= deadline
          const status = timedOut ? { _tag: "Running" as const } : yield* Effect.raceFirst(
            operations.status(job.handle, keyOf(job)),
            Effect.sleep(deadline - now).pipe(Effect.as({ _tag: "Running" as const }))
          )
          now = Math.floor(yield* Clock.currentTimeMillis)
          timedOut ||= now >= deadline
          const delay = Math.min(maximum, every * 2 ** Math.min(job.probe - 1, 1023))
          return {
            status,
            timedOut,
            wakeAt: Math.min(deadline, Math.ceil(now + delay)),
            next: { ...job, probe: job.probe + 1 },
            restart: {
              input: job.input,
              origin: job.origin,
              startedAt: job.startedAt,
              generation: job.generation + 1,
              probe: 1
            }
          }
        }), { implementationVersion: "external-job/status/v1" }),
      Collect.toLayer(({ exited, job }) =>
        Effect.tap(operations.collect(job.handle, keyOf(job), exited), () =>
          Effect.map(active, (value) => {
            value.current = undefined
          }))
      ),
      Cancel.toLayer((job) =>
        Effect.tap(operations.cancel(job.handle, keyOf(job)), () =>
          Effect.map(active, (value) => {
            value.current = undefined
          }))
      ),
      Fail.toLayer(({ job, timedOut }) =>
        Effect.fail(
          timedOut
            ? new ExternalJobTimedOut({ key: keyOf(job), message: `Job ${keyOf(job)} timed out` })
            : new ExternalJobLost({
              key: keyOf(job),
              message: `Job ${keyOf(job)} exhausted its replacement generations`
            })
        )
      ),
      Ready.toLayer((job) => Effect.map(Clock.currentTimeMillis, (now) => now < job.startedAt + timeout)),
      LaunchFailure.toLayer((job) =>
        Effect.fail(
          new ExternalJobTimedOut({ key: keyOf(job), message: `Job ${keyOf(job)} timed out before replacement start` })
        )
      )
    )
    // Active is supplied by the execution middleware, never by the host.
    return layer as Layer.Layer<
      Layer.Success<typeof layer>,
      Layer.Error<typeof layer>,
      Exclude<Layer.Services<typeof layer>, Active>
    >
  }
  // A job requires its own execution scope and identity even when composed
  // through call; reuse the existing child boundary rather than inline it.
  const call: typeof flow.child = (payload) => flow.child(payload)
  return Object.assign(flow, { call, toLayer }) as {
    readonly call: typeof call
    readonly toLayer: typeof toLayer
  } & typeof flow
}
