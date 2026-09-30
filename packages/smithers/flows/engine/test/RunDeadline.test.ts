/**
 * A flow's `deadline` bounds one execution on the in-memory engine: a parked
 * execution is woken and settled at the deadline, a running one is stopped by
 * the in-fiber race, and one that settles in time is untouched. The restart
 * case, which needs a store, lives in `@smthrs/engine-store`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, type FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Duration from "effect/Duration"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

const Wait = Action.make("RunDeadline/wait", { payload: { id: Schema.String }, success: Schema.String })
const gate = DurableDeferred.make("RunDeadline/gate", { success: Schema.String })

const deadlined = (tag: string) =>
  Flow.make(tag, {
    payload: { id: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ id }) => id,
    deadline: "1 hour",
    body: (payload) => Wait.call(payload)
  })

const Parked = deadlined("RunDeadline/parked")
const Running = deadlined("RunDeadline/running")
const InTime = deadlined("RunDeadline/in-time")

const layer = (flow: ReturnType<typeof deadlined>, wait: Effect.Effect<string, never, any>) =>
  Layer.mergeAll(Wait.toLayer(() => wait), Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )

/** Advances the clock in small steps until `poll` reports a settled result. */
const settle = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>,
  step: Duration.Input
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 200 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(step)
      result = yield* poll
    }
    return result
  })

const defect = (result: Option.Option<Flow.Result<unknown, unknown>>) => {
  if (Option.isNone(result) || result.value._tag !== "Complete" || !Exit.isFailure(result.value.exit)) return undefined
  return Cause.squash(result.value.exit.cause)
}

describe("Flow deadline", () => {
  effect("a parked execution settles with DeadlineExceeded when its deadline elapses", () =>
    Effect.gen(function*() {
      const flow = Parked
      const executionId = yield* flow.execute({ id: "parked" }, { discard: true })
      yield* TestClock.adjust("59 minutes")
      const before = yield* flow.poll(executionId)
      expect(Option.isSome(before) && before.value._tag).toBe("Suspended")
      const after = yield* settle(flow.poll(executionId), "1 minute")
      const expired = defect(after)
      expect(expired).toBeInstanceOf(Flow.DeadlineExceeded)
      expect(expired).toMatchObject({
        code: "deadline_exceeded",
        flowName: "RunDeadline/parked",
        executionId,
        deadlineMs: 3_600_000,
        startedAtMs: 0,
        message: `RunDeadline/parked execution ${executionId} ran past its 3600000 ms deadline, ` +
          "counted from its start at 1970-01-01T00:00:00.000Z"
      })
    }).pipe(Effect.provide(layer(Parked, DurableDeferred.await(gate)))))

  effect("a running execution is stopped by the in-fiber race at its deadline", () =>
    Effect.gen(function*() {
      const flow = Running
      const executionId = yield* flow.execute({ id: "running" }, { discard: true })
      const result = yield* settle(flow.poll(executionId), "10 minutes")
      expect(defect(result)).toBeInstanceOf(Flow.DeadlineExceeded)
    }).pipe(Effect.provide(layer(Running, Effect.as(Effect.sleep("2 hours"), "late")))))

  effect("an execution that settles before its deadline is untouched", () =>
    Effect.gen(function*() {
      const flow = InTime
      const executionId = yield* flow.execute({ id: "in-time" }, { discard: true })
      const result = yield* settle(flow.poll(executionId), "10 minutes")
      expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
        Exit.succeed("done")
      )
      // The armed deadline clock firing later changes nothing.
      yield* TestClock.adjust("2 hours")
      expect(yield* flow.poll(executionId)).toEqual(result)
    }).pipe(Effect.provide(layer(InTime, Effect.as(Effect.sleep("30 minutes"), "done")))))

  it("refuses a deadline that is not a positive finite duration", () => {
    for (const deadline of ["0 millis", "Infinity", -5] as const) {
      expect(() =>
        Flow.make("RunDeadline/invalid", {
          payload: {},
          success: Schema.String,
          deadline: deadline as never,
          body: () => Wait.call({ id: "x" })
        })
      ).toThrow(`Flow.make: "RunDeadline/invalid" deadline must be a positive finite duration`)
    }
  })

  it("keeps the deadline across annotate", () => {
    const flow = deadlined("RunDeadline/annotated")
    expect(flow.annotateMerge(flow.annotations).deadline).toEqual(flow.deadline)
    const Note = Context.Service<string>("RunDeadline/Note")
    expect(flow.annotate(Note, "kept").deadline).toEqual(flow.deadline)
  })
})

const Step = Action.make("RunDeadline/step", { payload: { value: Schema.Number }, success: Schema.Number })

/** A lineage that counts to `target` one round at a time, each round taking a step. */
type Counter = Flow.Flow<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  Action.Requirement<"RunDeadline/step">
>
const lineages = new Map<string, Counter>()
const counter = (tag: string, next: string, deadline?: Duration.Input): Counter => {
  const flow: Counter = Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(deadline === undefined ? {} : { deadline }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Step.call({ value }).pipe(
        Node.branch({
          if: (reached) => reached >= target,
          then: (reached) => Flow.done(reached),
          else: (reached) => lineages.get(next)!.to({ value: reached, target })
        })
      )
  })
  lineages.set(tag, flow)
  return flow
}
// The originator declares the hour; the round it hands to declares a longer one
// and the round after that none, and all of them run under the originator's.
const Originator = counter("RunDeadline/lineage", "RunDeadline/lineage-next", "1 hour")
const Successor = counter("RunDeadline/lineage-next", "RunDeadline/lineage-last", "1 day")
const Last = counter("RunDeadline/lineage-last", "RunDeadline/lineage-last")

const lineageLayer = (stepFor: Duration.Input) =>
  Layer.mergeAll(Interpreter.layer(Originator), Interpreter.layer(Successor), Interpreter.layer(Last)).pipe(
    Layer.provideMerge(Step.toLayer(({ value }) => Effect.as(Effect.sleep(stepFor), value + 1))),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )

/** Follows the lineage to its answer, advancing the clock in `step`s. */
const follow = (payload: { readonly value: number; readonly target: number }, step: Duration.Input) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.exit(Originator.execute(payload)))
    for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(step)
    }
    return yield* Fiber.join(fiber)
  })

describe("Flow deadline across trampoline rounds", () => {
  effect(
    "every round of a lineage expires at the originator's first start plus its deadline",
    () =>
      Effect.gen(function*() {
        // Four 25-minute rounds: no single round reaches an hour, the lineage does.
        const exit = yield* follow({ value: 0, target: 4 }, "5 minutes")
        expect(Exit.isFailure(exit)).toBe(true)
        const expired = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(expired).toBeInstanceOf(Flow.DeadlineExceeded)
        expect(expired).toMatchObject({ deadlineMs: 3_600_000, startedAtMs: 0 })
        // The third round expired, under the originator's hour and not its own day.
        expect((expired as Flow.DeadlineExceeded).flowName).toBe("RunDeadline/lineage-last")
        expect(yield* Clock.currentTimeMillis).toBeLessThanOrEqual(65 * 60_000)
      }).pipe(Effect.provide(lineageLayer("25 minutes")))
  )

  effect("a lineage that settles within the originator's deadline answers its value", () =>
    Effect.gen(function*() {
      expect(yield* follow({ value: 0, target: 4 }, "5 minutes")).toEqual(Exit.succeed(4))
    }).pipe(Effect.provide(lineageLayer("10 minutes"))))
})
