import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Stream } from "effect"
import * as Clock from "effect/Clock"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as Health from "../src/Health.ts"
import * as Monitor from "../src/Monitor.ts"
import { durable, type DurableStack } from "./DurableStack.ts"
import * as ObservedClock from "./ObservedClock.ts"

const run = <A, E>(body: Effect.Effect<A, E, DurableStack>) =>
  Effect.runPromise(body.pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie))
const start = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve({ ...card.approval, idempotencyKey: "health-approve" })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "health-run"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("run not accepted")
  yield* (yield* ControlRuntime).resume(receipt.runId)
  return receipt.runId
})

describe("configured Monitor over the durable control journal", () => {
  it("journals semantic observations before beats and never counts its own observations as progress", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const report = yield* Monitor.run({
        runId,
        healthCheck: Health.makeRegistry().resolve("system/test"),
        intervalMs: 0,
        maxChecks: 3,
        stallBeats: 1
      })
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      expect(report.beats.map((beat) => beat.health)).toEqual(["healthy", "stalled", "stalled"])
      expect(new Set(report.beats.map((beat) => beat.sequence)).size).toBe(1)
      const observation = events.findIndex((event) => event.kind === Health.statusObservedEventType)
      const beat = events.findIndex((event) => event.kind === Monitor.beatEventType)
      expect(observation).toBeGreaterThanOrEqual(0)
      expect(observation).toBeLessThan(beat)
      expect(events[observation]?.payload).toMatchObject({
        subjectId: `run:${runId}`,
        activity: "unknown",
        outcome: "ok"
      })
    }))
  })
  it("coalesces unchanged checks and retains bounded reports in the production mode", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const report = yield* Monitor.run({
        runId,
        healthCheck: Health.makeRegistry().resolve("system/test"),
        intervalMs: 0,
        maxChecks: 30,
        stallBeats: 100,
        recordBeats: false,
        retainBeats: 1
      })
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      expect(events.filter((event) => event.kind === Health.statusObservedEventType)).toHaveLength(1)
      expect(events.some((event) => event.kind === Monitor.beatEventType)).toBe(false)
      expect(report.beats).toHaveLength(1)
      expect(report.beats[0]?.beat).toBe(29)
    }))
  })
  it("discards a late result after authoritative cancellation", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const began = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const healthCheck = Health.makeRegistry({
        checkers: [{
          id: "delayed",
          probe: () =>
            Deferred.succeed(began, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ activity: "working" as const })
            )
        }],
        bindings: { flow: { checkerId: "delayed" } }
      }).resolve("flow")
      const fiber = yield* Monitor.run({ runId, healthCheck, intervalMs: 0, maxChecks: 1 }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(began)
      yield* (yield* Control).cancel({ runId, reason: "test", idempotencyKey: "cancel-during-check" })
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(fiber)
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      const recorded = events.find((event) => event.kind === Health.statusObservedEventType)
      expect(recorded?.payload).toMatchObject({ outcome: "discarded", reason: "owner-changed" })
      expect(recorded?.payload).not.toHaveProperty("report")
      expect((yield* (yield* ControlRuntime).getRun(runId)).status).toBe("cancelled")
    }))
  })
  it("explicit working contributes observational progress without changing legacy remedy authority", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const healthCheck = Health.makeRegistry({
        checkers: [{ id: "semantic", probe: () => Effect.succeed({ activity: "working" }) }],
        bindings: { flow: { checkerId: "semantic" } }
      }).resolve("flow")
      const report = yield* Monitor.run({
        runId,
        healthCheck,
        intervalMs: 0,
        maxChecks: 3,
        stallBeats: 1,
        recordBeats: false
      })
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      expect(report.health).toBe("stalled")
      expect(
        events.filter((event) => event.kind === Health.statusObservedEventType).every((event) =>
          typeof event.payload === "object" && event.payload !== null && "health" in event.payload &&
          event.payload.health === "healthy"
        )
      ).toBe(true)
      expect((yield* (yield* ControlRuntime).getRun(runId)).status).toBe("accepted")
    }))
  })
  it("backs off failed probes and restores the configured cadence after success", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runId = yield* start
        const began = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>())
        const times: Array<number> = []
        const healthCheck = Health.makeRegistry({
          checkers: [{
            id: "recovering",
            probe: () =>
              Effect.gen(function*() {
                const attempt = times.length
                times.push(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
                yield* Deferred.succeed(began[attempt]!, undefined)
                if (attempt < 2) return yield* Effect.fail(new Error("unavailable"))
                return { activity: "working" as const }
              })
          }],
          bindings: {
            flow: {
              checkerId: "recovering",
              policy: {
                intervalMs: 10,
                timeoutMs: 5,
                ttlMs: 1_000,
                backoff: { initialMs: 20, maxMs: 80, factor: 2 }
              }
            }
          }
        }).resolve("flow")
        const observedClock = yield* ObservedClock.make
        const fiber = yield* Monitor.run({ runId, healthCheck, maxChecks: 4, stallBeats: 100 }).pipe(
          Effect.provideService(Clock.Clock, observedClock.clock),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(began[0]!)
        for (const [index, delay] of [20, 40, 10].entries()) {
          yield* TestDatabase.until(observedClock.scheduled(times[index]! + delay))
          yield* TestClock.adjust(delay - 1)
          expect(times).toHaveLength(index + 1)
          yield* TestClock.adjust(1)
          yield* Deferred.await(began[index + 1]!)
        }
        expect((yield* Fiber.join(fiber)).beats).toHaveLength(4)
        expect(times).toEqual([0, 20, 60, 70])
        const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
        const observations = events.filter((event) => event.kind === Health.statusObservedEventType)
        // Identical failures coalesce; recovery publishes its fresh evidence.
        expect(observations.map((event) => (event.payload as Health.HealthObservation).outcome)).toEqual([
          "error",
          "ok"
        ])
        expect(observations[1]?.payload).toMatchObject({ activity: "working", health: "healthy", observedAt: 60 })
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.provide(TestClock.layer()), Effect.orDie)
    )
  })
  it("bounds probe events to the newest 256 and advances past them on the next beat", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const journal = yield* Journal.Journal
      const append = (index: number) =>
        journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/test/progress"),
            eventType: "test.progress",
            payload: { index }
          })
        )
      for (let index = 0; index < 260; index += 1) yield* append(index)
      const began = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const contexts: Array<Health.ProbeContext> = []
      const healthCheck = Health.makeRegistry({
        checkers: [{
          id: "incremental",
          probe: (context) =>
            Effect.gen(function*() {
              contexts.push(context)
              if (contexts.length === 1) {
                yield* Deferred.succeed(began, undefined)
                yield* Deferred.await(finish)
              }
              return { activity: "unknown" as const }
            })
        }],
        bindings: { flow: { checkerId: "incremental" } }
      }).resolve("flow")
      const fiber = yield* Monitor.run({ runId, healthCheck, intervalMs: 0, maxChecks: 2 }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(began)
      yield* append(260)
      yield* Deferred.succeed(finish, undefined)
      const report = yield* Fiber.join(fiber)
      expect(contexts).toHaveLength(2)
      const first = contexts[0]!
      const second = contexts[1]!
      expect(first.events.map((event) => event.payload)).toEqual(
        Array.from({ length: 256 }, (_, index) => ({ index: index + 4 }))
      )
      expect(first.sinceCursor).toBe(0)
      expect(second.sinceCursor).toBe(first.events[255]!.sequence)
      expect(second.events.map((event) => ({ kind: event.kind, payload: event.payload }))).toEqual([
        { kind: "test.progress", payload: { index: 260 } }
      ])
      expect(report.beats.map((beat) => beat.sequence)).toEqual([
        first.events[255]!.sequence,
        second.events[0]!.sequence
      ])
    }))
  })
  it.each(["quota", "timer", "event"])("classifies a known %s wait without a stall", (waitingReason) => {
    expect(
      Monitor.classify({
        summary: { runId: "one", flowId: "test", status: "parked", waitingReason, createdAt: 0, updatedAt: 0 },
        events: [],
        beatsWithoutProgress: 999,
        stallBeats: 1
      })
    ).toBe("healthy")
  })
})
