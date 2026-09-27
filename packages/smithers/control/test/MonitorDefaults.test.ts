import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Clock from "effect/Clock"
import * as ObservedClock from "./ObservedClock.ts"
/**
 * The monitor loop's defaults, its empty report, and the one failure it cannot
 * absorb.
 *
 * `Monitor.run` is what an operator reaches for when a run stopped answering,
 * so its unattended shape matters as much as its configured one: called with
 * nothing but a run id it must still beat on a real clock, take a bounded
 * number of beats, and record each of them. The cases here pin those defaults
 * against the documented numbers rather than against whatever the code happens
 * to say.
 *
 * The last case is the opposite of the loop's usual promise. Every beat is
 * evidence, and evidence that cannot be written is not a degraded beat, it is
 * no beat at all: the monitor fails with `PersistenceError` naming the record
 * it could not append instead of reporting a health it never proved.
 */
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as Monitor from "../src/Monitor.ts"
import { durable, type DurableStack } from "./DurableStack.ts"
import { park } from "./Park.ts"

const run = <A, E>(body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie))

/**
 * The same stack over a clock the case moves by hand.
 *
 * A case that asserts the default interval has to let nine of them pass, and
 * nine real seconds is not a unit test. `TestClock.adjust` opens the latch of
 * every sleep scheduled at or before the new time, so the loop takes its beats
 * on demand and the case still fails if the default interval ever becomes
 * zero — a zero interval finishes before the first adjustment.
 */
const runOnTestClock = <A, E>(body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(
    body.pipe(Effect.provide(durable()), Effect.scoped, Effect.provide(TestClock.layer()), Effect.orDie)
  )

/** Parks a run on a reason the way the engine parks one. */
const parkOn = (runId: string, reason: string) =>
  Effect.flatMap(
    Effect.service(SqlClient.SqlClient),
    (sql) => sql`UPDATE flows_runs SET waiting_reason = ${reason} WHERE run_id = ${runId}`.pipe(Effect.orDie)
  )

/** Plans, approves, and starts one control-owned run. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    yield* runtime.resume(receipt.runId)
    return receipt.runId
  })

describe("Monitor.run defaults", () => {
  it("beats ten times a second apart when it is given nothing but a run id", async () => {
    const report = await runOnTestClock(Effect.gen(function*() {
      const runId = yield* start("defaults")
      const observedClock = yield* ObservedClock.make
      const fiber = yield* Monitor.run({ runId }).pipe(
        Effect.provideService(Clock.Clock, observedClock.clock),
        Effect.forkChild({ startImmediately: true })
      )
      // Nine sleeps separate ten beats. Advancing less than that would leave
      // the loop mid-interval, which is how a default that silently became
      // zero would still pass.
      for (let beat = 1; beat <= 8; beat++) {
        yield* TestDatabase.until(observedClock.scheduled(beat * 1000))
        yield* TestClock.adjust("1 second")
      }
      const early = fiber.pollUnsafe()
      yield* TestDatabase.until(observedClock.scheduled(9000))
      yield* TestClock.adjust("1 second")
      const finished = yield* Fiber.join(fiber)
      return { early, finished }
    }))

    expect(report.early).toBeUndefined()
    expect(report.finished.beats.map((beat) => beat.beat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("reports an unknown health when it was asked for no beats at all", async () => {
    const report = await run(Effect.gen(function*() {
      const runId = yield* start("no-beats")
      return yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 0 })
    }))

    expect(report.beats).toEqual([])
    expect(report.health).toBe("unknown")
  })

  it("calls a run the control plane cannot find unknown rather than guessing", async () => {
    const report = await run(Monitor.run({ runId: "run-that-never-existed", intervalMs: 0, maxChecks: 2 }))

    expect(report.beats.map((beat) => beat.health)).toEqual(["unknown", "unknown"])
    expect(report.beats.map((beat) => beat.sequence)).toEqual([-1, -1])
  })

  it("cancels a failing run through the default remedy when it is allowed to", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* start("default-cancel")
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "failed")
      const report = yield* Monitor.run({
        runId,
        intervalMs: 0,
        maxChecks: 3,
        autoHeal: ["failing"]
      })
      const after = yield* runtime.getRun(runId)
      return { after, report }
    }))

    expect(observed.report.beats[0]?.health).toBe("failing")
    // The default remedy for a failing run is `Control.cancel`, and a run the
    // control plane has already settled answers it `Terminal`: the remedy ran,
    // and it healed nothing, which is exactly what the beat records.
    expect(observed.report.beats[0]?.receipt?._tag).toBe("Terminal")
    expect(observed.report.beats[0]?.healed).toBeUndefined()
    expect(observed.after.status).toBe("failed")
  })

  it("counts a trampoline against the round bound it was given", async () => {
    const report = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* start("round-bound")
      yield* park(runtime, runId)
      yield* parkOn(runId, "released")
      return yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 2, stallBeats: 99, roundBound: 1 })
    }))

    expect(report.beats).toHaveLength(2)
  })

  it("fails with the record it could not append rather than reporting an unproven beat", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const runId = yield* start("unwritable")
        // A monitor id that is not well-formed text cannot be canonicalized
        // into a journal payload, so the beat cannot be recorded.
        return yield* Effect.flip(Monitor.run({ runId, monitorId: "\ud800", intervalMs: 0, maxChecks: 1 }))
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(failure).toBeInstanceOf(PersistenceError)
    expect((failure as PersistenceError).operation).toBe(Monitor.beatEventType)
    expect((failure as PersistenceError).message).toContain("beat")
  })
})
