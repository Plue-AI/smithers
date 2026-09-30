/**
 * Reject an invalid human answer and ask again after an engine restart.
 *
 * The first drive parks on an approval token. The second supplies an invalid
 * answer, records the refusal, and parks on a new attempt's token. The third
 * answers that token and completes the run.
 *
 * The active attempt is read from persistent waiting state. The example does not
 * rely on a process-local counter to decide which request to answer.
 */
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, DurableDeferred, HumanTask, Interpreter } from "@smthrs/flow"
import * as Flow from "@smthrs/flow/Flow"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/** The question, and the run that is blocked on it. */
export const Release = Flow.make("examples/Release", {
  payload: { build: Schema.String },
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: ({ build }) =>
    HumanTask.action.call({
      name: "release",
      kind: "confirm",
      prompt: `Ship ${build}?`,
      maxAttempts: 3
    })
})

/** The wait point one attempt at answering `Release` resolves through. */
export const tokenFor = (executionId: string, attempt: number): DurableDeferred.Token =>
  DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", attempt), {
    flow: Release,
    executionId
  })

/**
 * The attempt the ENGINE says the question is open on.
 *
 * A suspended run has a waiting row, and a human task declares its own park, so
 * the row carries `approval` and the token of the attempt that is waiting. The
 * token is opaque, so the attempt is recovered by asking which attempt's wait
 * point that token addresses. `discard` returns once the run is admitted, so the
 * read repeats until the run has parked on an attempt after `after`.
 */
const parkedAttempt = (
  executionId: string,
  attempts: number,
  after: number
): Effect.Effect<number, never, DurableEngineState.DurableEngineState> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting(executionId)
    if (Option.isNone(row)) return 0
    const { reason, token } = row.value
    if (reason !== "approval" || token === null) return 0
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (tokenFor(executionId, attempt) === token) return attempt
    }
    return yield* Effect.die(`the run "${executionId}" parked on a token no attempt of its question owns`)
  }).pipe(
    Effect.repeat({ until: (attempt) => attempt > after, schedule: Schedule.spaced(10) }),
    Effect.timeout(30_000),
    Effect.orDie
  )

/** What a recorded refusal looks like when it is read back off its step. */
const Refusal = Schema.Struct({
  task: Schema.String,
  attempt: Schema.Number,
  reason: Schema.String
})

/**
 * The refusals the run RECORDED, read out of durable state.
 *
 * A refusal is a sealed step, so it has an attempt row like every other step,
 * and the journal names the steps a run took. Reading the two together is what
 * an operator does to answer "why was that answer sent back": the step's
 * outcome carries the task, the attempt it judged, and the reason.
 */
const refusalsRecorded = (
  executionId: string
): Effect.Effect<
  ReadonlyArray<typeof Refusal.Type>,
  Journal.JournalError | AttemptStore.AttemptStoreError,
  Journal.Journal | AttemptStore.AttemptStore
> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
    const attempts = yield* AttemptStore.AttemptStore
    const steps = new Set<string>()
    for (const entry of page.entries) {
      if (entry.eventType !== "flows.engine.attempt-started") continue
      const digest = (entry.payload as { readonly stepKeyDigest?: unknown }).stepKeyDigest
      if (typeof digest === "string") steps.add(digest)
    }
    const refusals: Array<typeof Refusal.Type> = []
    for (const stepKeyDigest of steps) {
      const row = yield* attempts.get({ runId: executionId, stepKeyDigest, attempt: 1 })
      if (Option.isNone(row) || row.value.outcome === undefined) continue
      const refusal = Schema.decodeUnknownExit(Refusal)(row.value.outcome)
      if (Exit.isSuccess(refusal)) refusals.push(refusal.value)
    }
    return refusals.sort((left, right) => left.attempt - right.attempt)
  })

export interface Summary {
  /** The value the run completed with. */
  readonly result: unknown
  /** The attempt the engine's waiting row named, once for each park. */
  readonly parkedOn: ReadonlyArray<number>
  /** The refusals the engine recorded, read back off their steps. */
  readonly refusals: ReadonlyArray<typeof Refusal.Type>
}

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const executionId = "release-1"
    const engine = (hostId: string) =>
      Layer.mergeAll(HumanTask.layer, Interpreter.layer(Release)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(filename, hostId))
      )
    const parkedOn: Array<number> = []

    // Phase one: the question is asked and the run parks, unanswered.
    yield* Effect.scoped(
      Effect.gen(function*() {
        yield* Release.execute({ build: "v1.4.0" }, { executionId, discard: true })
        parkedOn.push(yield* parkedAttempt(executionId, 3, 0))
      }).pipe(Effect.provide(engine("worker-a")))
    )

    // Phase two: a fresh process answers attempt one with prose. A confirm
    // cannot accept it, so the run refuses it and parks on attempt two.
    const refusals = yield* Effect.scoped(
      Effect.gen(function*() {
        yield* HumanTask.answer({ token: tokenFor(executionId, 1), value: "yes, ship it" })
        yield* Release.resume(executionId)
        parkedOn.push(yield* parkedAttempt(executionId, 3, 1))
        return yield* refusalsRecorded(executionId)
      }).pipe(Effect.provide(engine("worker-b")))
    )

    // Phase three: a third process answers the attempt the engine parked on.
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        yield* HumanTask.answer({ token: tokenFor(executionId, parkedOn[1]!), value: true })
        return yield* Release.execute({ build: "v1.4.0" }, { executionId })
      }).pipe(Effect.provide(engine("worker-c")))
    )

    return { result, parkedOn, refusals }
  }).pipe(Effect.orDie)
