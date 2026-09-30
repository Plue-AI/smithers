/**
 * Resume a poll after stopping the engine during its durable timer.
 *
 * Each `Poll.make` round performs one check. The first drive parks between
 * attempts; a fresh engine opens the same SQLite state after the deadline and
 * continues.
 *
 * The returned check count verifies that the resumed run does not repeat the
 * recorded first attempt.
 */
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Interpreter, Poll, Sleep } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/** The check the poll runs: a deployment that goes live on the third look. */
export const Status = Action.make("examples/Status", {
  payload: { id: Schema.String, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

/** The poll: one attempt per round, 120 ms of durable timer between them. */
export const Deployment = Poll.make("examples/Deployment", {
  input: { id: Schema.String },
  result: Schema.String,
  intervalMs: 120,
  backoff: "fixed",
  maxAttempts: 5,
  onTimeout: "fail",
  check: ({ attempt, id }) => Status.call({ attempt, id })
})

export interface Summary {
  /** The output of the check that satisfied the poll. */
  readonly result: string
  /** The attempt number of every check dispatch, in order. */
  readonly checks: ReadonlyArray<number>
  /** The dispatches the first engine made before it was dropped. */
  readonly checksBeforeRestart: ReadonlyArray<number>
}

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const checks: Array<number> = []
    const status = Status.toLayer(({ attempt }) =>
      Effect.sync(() => {
        checks.push(attempt)
        return { satisfied: attempt >= 3, output: `live:${attempt}` }
      })
    )
    const engine = (hostId: string) =>
      // `Sleep.layer` is not optional here: the wait between attempts is an
      // ordinary `system/sleep` node, so a composition without it has a plan
      // node no implementation answers.
      Layer.mergeAll(status, Poll.layer, Sleep.layer, Interpreter.layer(Deployment)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(filename, hostId))
      )

    // Phase one: the first attempt runs and the round parks on its timer.
    // `discard` returns once the run is admitted and scheduled, so the drive
    // waits for the durable park before it drops the engine.
    yield* Effect.scoped(
      Effect.gen(function*() {
        yield* Deployment.execute({ id: "web" }, { executionId: "deploy-1", discard: true })
        const state = yield* DurableEngineState.DurableEngineState
        yield* state.waiting("deploy-1").pipe(
          Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(10) }),
          Effect.timeout(30_000)
        )
      }).pipe(Effect.provide(engine("worker-a")))
    )

    const checksBeforeRestart = [...checks]

    // The process is gone while the timer is still pending. Wait past it, so a
    // fresh engine finds the clock due rather than arming a second one.
    yield* Effect.sleep(300)

    // Phase two: a fresh engine picks the lineage up and finishes the poll.
    const result = yield* Effect.scoped(
      Deployment.execute({ id: "web" }, { executionId: "deploy-1" }).pipe(
        Effect.provide(engine("worker-b"))
      )
    )

    return { result, checks, checksBeforeRestart }
  }).pipe(Effect.orDie)
