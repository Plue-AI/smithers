/**
 * `Deadline`: starting a run's deadline from its journaled first start or
 * from the lineage deadline a handoff stamped, racing a body against it, and
 * stamping it on the handoff a round settles with. The engine-level cases —
 * park, restart and multi-round lineages — live in `@smthrs/engine` and
 * `@smthrs/engine-store`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deadline, Flow, FlowRuntime } from "@smthrs/flow"
import { Cause, Duration, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { effectOnTestClock as effect } from "./Harness.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const Bounded = Flow.make("Deadline/bounded", {
  payload: {},
  success: Schema.String,
  body: () => Effect.succeed("unused") as never
})

/** Runs `body` as execution `id` of `Bounded`, with an optional inherited lineage deadline. */
const inExecution = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  lineageDeadline?: Flow.LineageDeadline
) => {
  const instance = makeInstance(Bounded, "deadline-execution")
  const withLineage = lineageDeadline === undefined ? instance : { ...instance, lineageDeadline }
  return Effect.provideService(body, FlowRuntime.FlowInstance, withLineage)
}

const squash = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("Flow.make deadline", () => {
  it("keeps a positive finite deadline as a Duration and refuses anything else", () => {
    const make = (deadline: unknown) =>
      Flow.make("Deadline/declared", {
        payload: {},
        success: Schema.String,
        deadline: deadline as never,
        body: () => Effect.succeed("unused") as never
      })
    expect(Duration.toMillis(make("90 seconds").deadline!)).toBe(90_000)
    expect(make(undefined).deadline).toBeUndefined()
    for (const deadline of [0, -1, "Infinity", "not a duration"]) {
      expect(() => make(deadline)).toThrow(`Flow.make: "Deadline/declared" deadline must be a positive finite duration`)
    }
  })
})

describe("Deadline", () => {
  effect(
    "start answers undefined for an execution with no deadline and no inherited one",
    () =>
      Effect.gen(function*() {
        expect(yield* inExecution(Deadline.start({ flowName: "Deadline/bounded" }))).toBeUndefined()
      }).pipe(Effect.provide(layerMemory))
  )

  effect("start counts a declared deadline from the journaled first start", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("5 minutes")
      const started = yield* inExecution(Deadline.start({ flowName: "Deadline/bounded", deadline: "1 hour" }))
      expect(started).toEqual({ startedAtMs: 300_000, deadlineMs: 3_600_000 })
      expect(yield* Deadline.remainingMs(started!)).toBe(3_600_000)
    }).pipe(Effect.provide(layerMemory)))

  effect("start counts from a start the host supplies without journaling one", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("5 minutes")
      const started = yield* inExecution(
        Deadline.start({ flowName: "Deadline/bounded", deadline: 60_000, startedAtMs: 1_000 })
      )
      expect(started).toEqual({ startedAtMs: 1_000, deadlineMs: 60_000 })
      expect(yield* Deadline.remainingMs(started!)).toBe(-239_000)
    }).pipe(Effect.provide(layerMemory)))

  effect("start answers the inherited lineage deadline over the declared one", () =>
    Effect.gen(function*() {
      const inherited = { startedAtMs: 0, deadlineMs: 60_000 }
      yield* TestClock.adjust("10 seconds")
      expect(yield* inExecution(Deadline.start({ flowName: "Deadline/bounded", deadline: "1 day" }), inherited))
        .toEqual(inherited)
      expect(yield* Deadline.remainingMs(inherited)).toBe(50_000)
      // An inherited deadline that already passed arms no clock and is still answered.
      yield* TestClock.adjust("2 minutes")
      expect(yield* inExecution(Deadline.start({ flowName: "Deadline/bounded" }), inherited)).toEqual(inherited)
    }).pipe(Effect.provide(layerMemory)))

  effect("start refuses a deadline that is not a positive finite duration", () =>
    Effect.gen(function*() {
      for (const deadline of [0, -1, "Infinity", "not a duration"] as const) {
        const exit = yield* Effect.exit(
          inExecution(Deadline.start({ flowName: "Deadline/bounded", deadline: deadline as never }))
        )
        expect(squash(exit)).toBeInstanceOf(RangeError)
        expect(String(squash(exit))).toContain(`"Deadline/bounded" deadline must be a positive finite duration`)
      }
    }).pipe(Effect.provide(layerMemory)))

  effect("within runs the body unbounded without a deadline", () =>
    Effect.gen(function*() {
      expect(yield* inExecution(Deadline.within(undefined, "Deadline/bounded")(Effect.succeed("free")))).toBe("free")
    }))

  effect("within settles a body that starts past the deadline at once", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const exit = yield* Effect.exit(
        inExecution(Deadline.within({ startedAtMs: 0, deadlineMs: 60_000 }, "Deadline/bounded")(Effect.succeed("x")))
      )
      expect(squash(exit)).toBeInstanceOf(Flow.DeadlineExceeded)
      expect(squash(exit)).toMatchObject({
        flowName: "Deadline/bounded",
        executionId: "deadline-execution",
        startedAtMs: 0,
        deadlineMs: 60_000,
        message: "Deadline/bounded execution deadline-execution ran past its 60000 ms deadline, " +
          "counted from its start at 1970-01-01T00:00:00.000Z"
      })
    }))

  effect(
    "within stops a running body at the deadline and leaves one that finishes in time",
    () =>
      Effect.gen(function*() {
        const deadline = { startedAtMs: 0, deadlineMs: 60_000 }
        const late = yield* Effect.forkChild(Effect.exit(
          inExecution(Deadline.within(deadline, "Deadline/bounded")(Effect.as(Effect.sleep("2 minutes"), "late")))
        ))
        const early = yield* Effect.forkChild(
          inExecution(Deadline.within(deadline, "Deadline/bounded")(Effect.as(Effect.sleep("30 seconds"), "early")))
        )
        yield* TestClock.adjust("1 minute")
        expect(yield* Fiber.join(early)).toBe("early")
        expect(squash(yield* Fiber.join(late))).toBeInstanceOf(Flow.DeadlineExceeded)
      })
  )

  effect("within stamps the deadline on the handoff a round settles with, once", () =>
    Effect.gen(function*() {
      const deadline = { startedAtMs: 0, deadlineMs: 60_000 }
      const ceilings = Flow.parseCapabilityCeilings([["fs:read"]])
      const instance = makeInstance(Bounded, "deadline-handoff")
      const handOff = Effect.flatMap(FlowRuntime.FlowInstance, (self) =>
        Effect.sync(() => {
          self.handoff = new Flow.Handoff({ flow: "Deadline/next", payload: { n: 1 }, capabilityCeilings: ceilings })
        }))
      yield* Deadline.within(deadline, "Deadline/bounded")(handOff).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(instance.handoff).toEqual(
        new Flow.Handoff({ flow: "Deadline/next", payload: { n: 1 }, capabilityCeilings: ceilings, deadline })
      )
      // A handoff that already carries a lineage deadline keeps it.
      const stamped = { startedAtMs: 5, deadlineMs: 10_000 }
      const carried = makeInstance(Bounded, "deadline-carried")
      yield* Deadline.within(deadline, "Deadline/bounded")(
        Effect.flatMap(FlowRuntime.FlowInstance, (self) =>
          Effect.sync(() => {
            self.handoff = new Flow.Handoff({ flow: "Deadline/next", payload: {}, deadline: stamped })
          }))
      ).pipe(Effect.provideService(FlowRuntime.FlowInstance, carried))
      expect(carried.handoff?.deadline).toEqual(stamped)
      // A handoff under no capability ceiling gains none.
      const open = makeInstance(Bounded, "deadline-open")
      yield* Deadline.within(deadline, "Deadline/bounded")(
        Effect.flatMap(FlowRuntime.FlowInstance, (self) =>
          Effect.sync(() => {
            self.handoff = new Flow.Handoff({ flow: "Deadline/next", payload: {} })
          }))
      ).pipe(Effect.provideService(FlowRuntime.FlowInstance, open))
      expect(open.handoff).toEqual(new Flow.Handoff({ flow: "Deadline/next", payload: {}, deadline }))
    }))

  effect("bound starts and races in one step", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.exit(
        inExecution(
          Deadline.bound({ flowName: "Deadline/bounded", deadline: "1 minute" })(Effect.never)
        )
      ))
      yield* TestClock.adjust("1 minute")
      expect(squash(yield* Fiber.join(fiber))).toMatchObject({ startedAtMs: 0, deadlineMs: 60_000 })
      expect(yield* inExecution(Deadline.bound({ flowName: "Deadline/bounded" })(Effect.succeed("free")))).toBe("free")
    }).pipe(Effect.provide(layerMemory)))
})
