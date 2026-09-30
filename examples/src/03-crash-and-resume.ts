/**
 * Suspend a run and resume it through a fresh engine over the same SQLite file.
 *
 * The first drive waits on a durable deferred and releases ownership. The second
 * drive completes that deferred and finishes the execution.
 *
 * The counters identify what repeats: the `Assess` implementation enters twice,
 * while the sealed read action before the wait executes once. This simulates an
 * engine restart after a durable suspension; it does not kill a process
 * mid-write.
 */
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

export const Assess = Action.make("examples/Assess", {
  payload: { document: Schema.String },
  success: Schema.String
})

export const Review = Flow.make("examples/Review", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Assess.call(payload)
})

export const Approval = DurableDeferred.make("examples/approval", {
  success: Schema.String
})

export interface Summary {
  readonly result: string
  readonly readDispatches: number
  readonly stepEntries: number
}

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let readDispatches = 0
    let stepEntries = 0

    const ReadDocument = Action.make({
      name: "examples/ReadDocument",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "examples/read-document/v1",
      execute: Effect.sync(() => {
        readDispatches += 1
        return "draft body"
      })
    })

    const assess = ({ document }: { readonly document: string }) =>
      Effect.gen(function*() {
        stepEntries += 1
        const body = yield* ReadDocument
        const verdict = yield* DurableDeferred.await(Approval)
        return `${document}:${body}:${verdict}`
      })

    const engine = (hostId: string) =>
      Layer.mergeAll(Assess.toLayer(assess), Interpreter.layer(Review)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(filename, hostId))
      )

    // Phase one: the run suspends at the deferred and releases its claim.
    // `discard` returns once the run is admitted and scheduled, so the drive
    // waits for the durable park before it drops the engine.
    yield* Effect.scoped(
      Effect.gen(function*() {
        yield* Review.execute({ document: "rfc" }, { executionId: "review-1", discard: true })
        const state = yield* DurableEngineState.DurableEngineState
        yield* state.waiting("review-1").pipe(
          Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(10) }),
          Effect.timeout(30_000)
        )
      }).pipe(Effect.provide(engine("worker-a")))
    )

    // Phase two: a fresh engine completes the deferred and finishes the run.
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const flowEngine = yield* FlowRuntime.FlowRuntime
        yield* flowEngine.deferredDone(Approval, {
          flowName: Review._tag,
          executionId: "review-1",
          deferredName: Approval.name,
          exit: Exit.succeed("approved")
        })
        return yield* Review.execute({ document: "rfc" }, { executionId: "review-1" })
      }).pipe(Effect.provide(engine("worker-b")))
    )

    return { result, readDispatches, stepEntries }
  }).pipe(Effect.orDie)
