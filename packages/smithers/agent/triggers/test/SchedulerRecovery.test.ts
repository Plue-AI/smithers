import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as SqlTriggerStore from "../src/SqlTriggerStore.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000

interface RunnerFixture {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
  readonly active: Set<string>
  readonly cancelled: Array<string>
  readonly inspected: Array<string>
}

const runnerFixture = (
  overrides: Partial<Scheduler.RunnerService> = {}
): RunnerFixture => {
  const starts: Array<Scheduler.StartInput> = []
  const active = new Set<string>()
  const cancelled: Array<string> = []
  const inspected: Array<string> = []
  return {
    starts,
    active,
    cancelled,
    inspected,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.sync(() => {
          starts.push(input)
          const runId = `run-${starts.length}`
          active.add(runId)
          return runId
        }),
      inspect: (runId) =>
        Effect.sync(() => {
          inspected.push(runId)
          return active.has(runId) ? "active" as const : "completed" as const
        }),
      cancel: (runId) =>
        Effect.sync(() => {
          cancelled.push(runId)
          active.delete(runId)
        }),
      ...overrides
    })
  }
}

const trigger = (
  overlap: Trigger["overlap"] = "skip",
  catchUp: Trigger["catchUp"] = "one",
  maxCatchUp = 3
): Trigger => ({
  id: "hourly",
  flowId: "flow",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap,
  catchUp,
  maxCatchUp,
  enabled: true
})

const seedFired = (store: TriggerStore.Service, declaration: Trigger) =>
  Effect.gen(function*() {
    const registered = yield* store.register(declaration)
    yield* store.claimFire({
      triggerId: declaration.id,
      occurrence: 0,
      expectedRevision: registered.revision
    })
    yield* store.recordResult({ triggerId: declaration.id, occurrence: 0, outcome: "skipped" })
    return registered
  })

const inMemory = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(TestTriggers.layer), Effect.provide(TestClock.layer()))
  )

describe("Scheduler recovery", () => {
  it("cancels a delayed losing launch across two schedulers before lease expiry", async () => {
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* seedFired(store, { ...trigger("supersede", "one"), cron: "* * * * *" })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const runner = runnerFixture()
      const hostA = yield* Scheduler.make().pipe(Effect.provideService(Scheduler.Runner, {
        ...runner.service,
        start: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => {
              runner.active.add("old-run")
              return "old-run"
            }))
          )
      }))
      const hostB = yield* Scheduler.make().pipe(Effect.provideService(Scheduler.Runner, runner.service))
      yield* TestClock.setTime(60_000)
      const first = yield* Effect.forkScoped(hostA.runOnce)
      yield* Deferred.await(entered)
      yield* TestClock.setTime(120_000)
      yield* hostB.runOnce
      expect(yield* store.activeRun("hourly")).toEqual(Option.some("run-1"))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect(yield* store.activeRun("hourly")).toEqual(Option.some("run-1"))
      expect(runner.cancelled).toEqual(["old-run"])
      expect([...runner.active]).toEqual(["run-1"])
      expect((yield* store.history({ triggerId: "hourly" })).items.find((fire) => fire.occurrence === 60_000)?.outcome)
        .toBe("superseded")
    })))
  })

  it.each(["committed", "reserved"])("keeps an idempotent run adopted by a newer %s attempt", async (owner) => {
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const registered = yield* seedFired(store, trigger("skip", "one"))
      const runner = runnerFixture({
        start: () =>
          Effect.gen(function*() {
            yield* TestClock.adjust(TriggerStore.reservationLeaseMs + 1)
            const replacement = yield* store.claimFire({
              triggerId: "hourly",
              occurrence: hour,
              expectedRevision: registered.revision
            })
            if (!replacement.claimed || replacement.action !== "fire") return yield* Effect.die("expected replacement")
            if (owner === "committed") {
              yield* store.recordResult({
                triggerId: "hourly",
                occurrence: hour,
                outcome: "launched",
                runId: "shared-run",
                reservationId: replacement.reservationId
              })
            }
            return "shared-run"
          })
      })
      // The start answers after its reservation lease. The default start
      // deadline abandons a launch before the lease can expire, so this
      // scenario needs a deadline above it.
      const scheduler = yield* Scheduler.make({ startTimeout: "10 minutes" }).pipe(
        Effect.provideService(Scheduler.Runner, runner.service)
      )
      yield* TestClock.setTime(hour)
      yield* scheduler.runOnce
      // The tick returns once the claim is durable; the launch finishes on
      // its own fiber.
      for (let n = 0; n < 10; n++) yield* Effect.yieldNow
      expect(runner.cancelled).toEqual([])
      const held = yield* store.inspect("hourly")
      if (owner === "committed") expect(held.activeRunId).toBe("shared-run")
      else expect(TriggerStore.reservationOccurrence(held.activeRunId!)).toBe(hour)
    })))
  })

  it("treats a runner refusal before acceptance as a fenced launch failure", async () => {
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* seedFired(store, trigger("skip", "one"))
      const runner = runnerFixture({
        start: () => Effect.fail(new TriggerError({ code: "stale_owner", message: "runner refused" }))
      })
      const scheduler = yield* Scheduler.make().pipe(Effect.provideService(Scheduler.Runner, runner.service))
      yield* TestClock.setTime(hour)
      yield* scheduler.runOnce
      expect((yield* store.history()).items[0]?.outcome).toBe("failed")
      expect(yield* store.inspect("hourly")).toEqual({})
      expect(runner.cancelled).toEqual([])
    })))
  })

  it("retains a buffered lease when atomic compensation fails and recovers after a crash", async () => {
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const registered = yield* store.register(trigger("buffer-one", "none"))
      yield* store.claimFire({ triggerId: "hourly", occurrence: 0, expectedRevision: registered.revision })
      yield* store.claimFire({ triggerId: "hourly", occurrence: hour, expectedRevision: registered.revision })
      yield* store.recordResult({ triggerId: "hourly", occurrence: 0, outcome: "completed" })
      const refuse = () => Effect.fail(new TriggerError({ code: "store", message: "disk full while rearming" }))
      const flaky = { ...store, setPending: refuse, restorePending: refuse }
      const failingRunner = runnerFixture({
        start: () => Effect.fail(new TriggerError({ code: "runner", message: "launch failed" }))
      })
      yield* TestClock.setTime(hour)
      yield* Effect.scoped(Effect.gen(function*() {
        const scheduler = yield* Scheduler.make().pipe(
          Effect.provideService(TriggerStore.TriggerStore, flaky),
          Effect.provideService(Scheduler.Runner, failingRunner.service)
        )
        yield* scheduler.runOnce
      }))
      const held = yield* store.inspect("hourly")
      expect(TriggerStore.isReservation(held.activeRunId)).toBe(true)
      expect(held.pendingAt).toBeUndefined()
      yield* TestClock.adjust(TriggerStore.reservationLeaseMs + 1)
      const recoveredRunner = runnerFixture()
      const recovered = yield* Scheduler.make().pipe(Effect.provideService(Scheduler.Runner, recoveredRunner.service))
      yield* recovered.runOnce
      expect(recoveredRunner.starts.map((start) => start.idempotencyKey)).toEqual([
        `hourly:${new Date(hour).toISOString()}`
      ])
    })))
  })

  // The watermark used to advance before the work it gates, so a transient
  // claim failure was logged, abandoned, and never recomputed: the next tick
  // saw the occurrence as already observed and returned nothing.
  it("re-claims an occurrence whose claim failed rather than losing it", async () => {
    const runner = runnerFixture()
    let claims = 0
    const starts = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "one"))
          const flaky = TriggerStore.TriggerStore.of({
            ...store,
            claimFire: (fire) =>
              claims++ === 0
                ? Effect.fail(new TriggerError({ code: "store", message: "claim write failed" }))
                : store.claimFire(fire)
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, flaky),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          expect(runner.starts).toHaveLength(0)

          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return runner.starts
        })
      )
    )
    expect(claims).toBe(2)
    expect(starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  it("re-arms committed buffered work when its launch fails", async () => {
    const starts: Array<Scheduler.StartInput> = []
    let failures = 1
    const runner = runnerFixture({
      start: (input) =>
        Effect.suspend(() => {
          starts.push(input)
          if (failures > 0) {
            failures--
            return Effect.fail(new TriggerError({ code: "runner", message: "launch failed" }))
          }
          return Effect.succeed("run-1")
        })
    })
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("buffer-one", "none"))
          yield* TestClock.setTime(hour)
          yield* store.claimFire({
            triggerId: "hourly",
            occurrence: 0,
            expectedRevision: registered.revision
          })
          yield* store.claimFire({
            triggerId: "hourly",
            occurrence: hour,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({ triggerId: "hourly", occurrence: 0, outcome: "completed" })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* scheduler.runOnce
          expect(starts).toHaveLength(1)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  it("re-arms an occurrence when its launched run cannot be persisted", async () => {
    const runner = runnerFixture()
    let refuseLaunchResult = true
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "one"))
          const flaky = TriggerStore.TriggerStore.of({
            ...store,
            recordResult: (result) => {
              if (result.outcome === "launched" && refuseLaunchResult) {
                refuseLaunchResult = false
                return Effect.fail(new TriggerError({ code: "store", message: "launch result write failed" }))
              }
              return store.recordResult(result)
            }
          })
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, flaky),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          expect(runner.starts).toHaveLength(1)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  // A reservation is not a run: the runner has never heard of it, so asking
  // answers "not active" for a launch that is still in flight. Only its lease
  // may release it, and only the store enforces that.
  it("keeps a recovered launch reservation across ticks without asking the runner", async () => {
    const runner = runnerFixture()
    const outcome = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("skip", "one"))
          yield* TestClock.setTime(hour)
          // The reservation another incarnation wrote while it was inside
          // `runner.start`.
          yield* store.claimFire({
            triggerId: "hourly",
            occurrence: 0,
            expectedRevision: registered.revision
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          const afterFirst = yield* store.activeRun("hourly")
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return { afterFirst, afterSecond: yield* store.activeRun("hourly") }
        })
      )
    )
    const reservation = Option.getOrThrow(outcome.afterFirst)
    expect(reservation).toMatch(/^trigger-reservation:hourly:[^:]+:0$/)
    expect(outcome.afterFirst).toMatchObject({ _tag: "Some", value: reservation })
    expect(outcome.afterSecond).toMatchObject({ _tag: "Some", value: reservation })
    expect(runner.starts).toHaveLength(0)
    expect(runner.inspected).not.toContain(reservation)
  })

  it("rechecks a recovered reservation and launches it after its lease expires", async () => {
    const runner = runnerFixture()
    const active = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("skip", "none"))
          yield* TestClock.setTime(0)
          yield* store.claimFire({
            triggerId: registered.id,
            occurrence: 0,
            expectedRevision: registered.revision
          })
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* scheduler.runOnce
          yield* TestClock.adjust(TriggerStore.reservationLeaseMs + 1)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return yield* store.activeRun(registered.id)
        })
      )
    )
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(0).toISOString()}`
    ])
    expect(active).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(runner.inspected.some(TriggerStore.isReservation)).toBe(false)
  })

  it("rechecks a claimed buffer and re-arms it after its lease expires", async () => {
    const runner = runnerFixture()
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("buffer-one", "none"))
          yield* TestClock.setTime(0)
          yield* store.claimFire({
            triggerId: registered.id,
            occurrence: 0,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: registered.id,
            occurrence: 0,
            outcome: "launched",
            runId: "prior-run",
            reservationId: (yield* store.inspect(registered.id)).activeRunId!
          })
          yield* store.claimFire({
            triggerId: registered.id,
            occurrence: hour,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: registered.id,
            occurrence: 0,
            outcome: "completed",
            runId: "prior-run"
          })
          yield* store.claimPending({
            triggerId: registered.id,
            expectedRevision: registered.revision
          })

          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* scheduler.runOnce
          yield* TestClock.adjust(TriggerStore.reservationLeaseMs + 1)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  // The runs are durable and outlive this process. Closing the scope must
  // detach the monitors, never cancel what they were watching: a deploy would
  // otherwise cancel every scheduled run it found in flight.
  it("detaches run monitors on scope closure instead of cancelling the runs", async () => {
    const runner = runnerFixture()
    await inMemory(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* seedFired(store, trigger("skip", "one"))
        yield* TestClock.setTime(hour)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            expect(runner.starts).toHaveLength(1)
          })
        )
      })
    )
    expect(runner.cancelled).toEqual([])
    expect(runner.active.has("run-1")).toBe(true)
  })

  it("cancels a superseded run exactly once", async () => {
    const runner = runnerFixture()
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("supersede", "one"))
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(2 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(runner.cancelled).toEqual(["run-1"])
  })

  it("restores the prior run and queues the replacement when cancellation fails", async () => {
    const runner = runnerFixture({
      cancel: () => Effect.fail(new TriggerError({ code: "runner", message: "cancel failed" }))
    })
    runner.active.add("prior-run")
    const state = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("supersede", "one"))
          yield* store.claimFire({
            triggerId: registered.id,
            occurrence: 0,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: registered.id,
            occurrence: 0,
            outcome: "launched",
            runId: "prior-run",
            reservationId: (yield* store.inspect(registered.id)).activeRunId!
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          return {
            active: yield* store.activeRun(registered.id),
            pending: (yield* store.inspect(registered.id)).pendingAt
          }
        })
      )
    )
    expect(state.active).toMatchObject({ _tag: "Some", value: "prior-run" })
    expect(state.pending).toBe(hour)
    expect(runner.starts).toHaveLength(0)
  })

  it("keeps the prior monitor until its superseded result is durable", async () => {
    const runner = runnerFixture()
    let refuseSuperseded = true
    const occurrence = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("supersede", "one"))
          const flaky = TriggerStore.TriggerStore.of({
            ...store,
            recordResult: (result) => {
              if (result.outcome === "superseded" && refuseSuperseded) {
                refuseSuperseded = false
                return Effect.fail(new TriggerError({ code: "store", message: "superseded result write failed" }))
              }
              return store.recordResult(result)
            }
          })
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, flaky),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(2 * hour)
          yield* Effect.yieldNow
          yield* scheduler.runOnce
          expect(runner.starts).toHaveLength(1)
          yield* TestClock.adjust(hour)
          yield* Effect.yieldNow
          return yield* store.activeOccurrence("hourly", "run-1")
        })
      )
    )
    expect(occurrence).toMatchObject({ _tag: "None" })
  })

  it("recovers and cancels the predecessor when a supersede claimant dies", async () => {
    const runner = runnerFixture()
    runner.active.add("prior-run")
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("supersede", "one"))
          yield* TestClock.setTime(0)
          yield* store.claimFire({
            triggerId: registered.id,
            occurrence: 0,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: registered.id,
            occurrence: 0,
            outcome: "launched",
            runId: "prior-run",
            reservationId: (yield* store.inspect(registered.id)).activeRunId!
          })
          yield* store.claimFire({
            triggerId: registered.id,
            occurrence: hour,
            expectedRevision: registered.revision
          })

          yield* TestClock.adjust(TriggerStore.reservationLeaseMs + 1)
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(runner.cancelled).toEqual(["prior-run"])
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  // A bound the declaration cannot honour is a statement about how much
  // history to replay, not a reason to stop scheduling.
  it("abandons a backlog beyond its bound and keeps scheduling", async () => {
    const runner = runnerFixture()
    const starts = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "all", 2))
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(10 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          // The backlog is abandoned; the current boundary still fires.
          expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
            `hourly:${new Date(10 * hour).toISOString()}`
          ])
          runner.active.clear()

          yield* TestClock.setTime(11 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return runner.starts
        })
      )
    )
    expect(starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(10 * hour).toISOString()}`,
      `hourly:${new Date(11 * hour).toISOString()}`
    ])
  })

  it.each([1, 4])("keeps a live run durable after %s inspection failures and reattaches", async (failures) => {
    let polls = 0
    const runner = runnerFixture()
    const inspecting = {
      ...runner.service,
      inspect: (runId: string) =>
        Effect.suspend(() => {
          polls++
          return polls <= failures
            ? Effect.fail(new TriggerError({ code: "runner", message: "transient inspection outage" }))
            : runner.service.inspect(runId)
        })
    }
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* seedFired(store, trigger("skip", "one"))
      const scheduler = yield* Scheduler.make({ runPollInterval: "1 second" }).pipe(
        Effect.provideService(Scheduler.Runner, inspecting)
      )
      yield* TestClock.setTime(hour)
      yield* scheduler.runOnce
      yield* Effect.yieldNow
      expect(yield* store.activeRun("hourly")).toEqual(Option.some("run-1"))
      expect([...runner.active]).toEqual(["run-1"])
      expect((yield* store.history()).items[0]?.outcome).toBe("launched")

      if (failures === 4) {
        // Three retries back off by one, two, then four poll intervals.
        for (const delay of [1_000, 2_000, 4_000]) yield* TestClock.adjust(delay)
        expect(polls).toBe(4)
        yield* TestClock.adjust("1 minute")
        expect(polls).toBe(4)
        expect(yield* store.activeRun("hourly")).toEqual(Option.some("run-1"))
        yield* scheduler.runOnce
        expect(polls).toBe(5)
      }
      yield* TestClock.setTime(2 * hour)
      yield* scheduler.runOnce
      expect(runner.starts).toHaveLength(1)
      expect([...runner.active]).toEqual(["run-1"])
      expect((yield* store.history()).items[0]?.outcome).toBe("skipped")

      runner.active.delete("run-1")
      yield* TestClock.adjust("1 second")
      yield* scheduler.runOnce
      expect(yield* store.activeRun("hourly")).toEqual(Option.none())
      expect((yield* store.history()).items.find((fire) => fire.occurrence === hour)?.outcome).toBe("completed")
      expect(runner.cancelled).toEqual([])
    })))
  })

  it.each(["typed", "defect"])("retries a %s completion write through tick recovery", async (failure) => {
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* seedFired(store, trigger())
      const runner = runnerFixture()
      let refuse = true
      const results: Array<TriggerStore.Result> = []
      const scheduler = yield* Scheduler.make().pipe(
        Effect.provideService(Scheduler.Runner, {
          ...runner.service,
          inspect: (runId) =>
            Effect.sync(() => {
              runner.active.delete(runId)
              return "completed" as const
            })
        }),
        Effect.provideService(TriggerStore.TriggerStore, {
          ...store,
          recordResult: (result) =>
            Effect.suspend(() => {
              results.push(result)
              if (refuse && result.outcome === "completed") {
                refuse = false
                return failure === "typed"
                  ? Effect.fail(new TriggerError({ code: "store", message: "completion write failed" }))
                  : Effect.die("completion write defect")
              }
              return store.recordResult(result)
            })
        })
      )
      yield* TestClock.setTime(hour)
      yield* scheduler.runOnce
      yield* Effect.yieldNow
      expect(yield* store.activeRun("hourly")).toEqual(Option.some("run-1"))
      expect((yield* store.history()).items[0]?.outcome).toBe("launched")
      yield* scheduler.runOnce
      expect(yield* store.activeRun("hourly")).toEqual(Option.none())
      expect((yield* store.history()).items[0]?.outcome).toBe("completed")
      expect(results.map((result) => result.outcome)).toEqual(["launched", "completed", "completed"])
      expect(runner.starts).toHaveLength(1)
    })))
  })

  it("detaches on inspection interruption and caps defect retries at one minute", async () => {
    await inMemory(Effect.scoped(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* seedFired(store, trigger())
      const runner = runnerFixture()
      const scheduler = yield* Scheduler.make().pipe(
        Effect.provideService(Scheduler.Runner, {
          ...runner.service,
          inspect: () => Effect.interrupt
        })
      )
      yield* TestClock.setTime(hour)
      yield* scheduler.runOnce
      yield* Effect.yieldNow
      expect(yield* store.activeRun("hourly")).toEqual(Option.some("run-1"))
      expect((yield* store.history()).items[0]?.outcome).toBe("launched")

      yield* seedFired(store, { ...trigger(), id: "defective" })
      let polls = 0
      const retrying = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
        Effect.provideService(Scheduler.Runner, {
          ...runner.service,
          inspect: (runId) =>
            runId === "run-1" ? runner.service.inspect(runId) : Effect.suspend(() => {
              polls++
              return Effect.die("inspection defect")
            })
        })
      )
      yield* retrying.runOnce
      expect(polls).toBe(1)
      for (const expected of [2, 3, 4]) {
        yield* TestClock.adjust("59 seconds")
        expect(polls).toBe(expected - 1)
        yield* TestClock.adjust("1 second")
        expect(polls).toBe(expected)
      }
      yield* TestClock.adjust("1 minute")
      expect(polls).toBe(4)
      expect(yield* store.activeRun("defective")).toEqual(Option.some("run-2"))
      expect([...runner.active]).toEqual(["run-1", "run-2"])
      expect(runner.cancelled).toEqual([])
    })))
  })

  it.each(["typed", "start defect", "record defect", "interrupt"])(
    "isolates a launch %s from the tick and releases the tick semaphore",
    async (failure) => {
      await inMemory(Effect.scoped(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* seedFired(store, trigger())
        yield* seedFired(store, { ...trigger(), id: "z-other", flowId: "healthy" })
        const runner = runnerFixture()
        const entered = yield* Deferred.make<void>()
        const scheduler = yield* Scheduler.make().pipe(
          Effect.provideService(Scheduler.Runner, {
            ...runner.service,
            start: (input) =>
              input.flowId === "healthy" ?
                runner.service.start(input) :
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(
                  failure === "typed" ?
                    Effect.fail(new TriggerError({ code: "runner", message: "launch refused" })) :
                    failure === "start defect" ?
                    Effect.die("launch defect") :
                    failure === "interrupt"
                    ? Effect.interrupt
                    : runner.service.start(input)
                ))
          }),
          Effect.provideService(TriggerStore.TriggerStore, {
            ...store,
            recordResult: (result) =>
              failure === "record defect" && result.triggerId === "hourly" &&
                result.outcome === "launched"
                ? Effect.die("launch record defect")
                : store.recordResult(result)
          })
        )
        yield* TestClock.setTime(hour)
        const tick = yield* Effect.forkScoped(scheduler.runOnce)
        yield* Deferred.await(entered)
        for (let n = 0; n < 10; n++) yield* Effect.yieldNow
        const exit = tick.pollUnsafe()
        expect(exit).toBeDefined()
        // The tick never waits on a launch, so no launch failure, interruption
        // included, reaches it or the trigger beside it.
        expect(exit?._tag).toBe("Success")
        expect(runner.starts.filter((input) => input.flowId === "healthy")).toHaveLength(1)
        const held = yield* store.inspect("hourly")
        if (failure === "typed") expect(held.activeRunId).toBeUndefined()
        else expect(TriggerStore.isReservation(held.activeRunId)).toBe(true)
        // A second tick must also acquire the permit after a failed child.
        yield* scheduler.runOnce
        expect(runner.starts.filter((input) => input.flowId === "healthy")).toHaveLength(1)
      })))
    }
  )

  it("skips an occurrence while its own launch is still in flight", async () => {
    const runner = runnerFixture()
    const results: Array<TriggerStore.Result> = []
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "one"))
          const recording = TriggerStore.TriggerStore.of({
            ...store,
            recordResult: (result) =>
              Effect.sync(() => {
                results.push(result)
              }).pipe(Effect.andThen(store.recordResult(result)))
          })
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, recording),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(2 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(runner.starts).toHaveLength(1)
    expect(results.filter((result) => result.outcome === "skipped")).toHaveLength(1)
  })
})

describe("Scheduler revision fencing", () => {
  const registered = (revision: number): TriggerStore.Registered => ({
    ...trigger("skip", "one"),
    revision,
    lastFiredAt: 0
  })

  const fenced = (
    stored: Option.Option<TriggerStore.Registered>,
    claims: Array<number>
  ): TriggerStore.Service =>
    TriggerStore.makeNoop({
      list: () => Effect.succeed([TriggerStore.listed(registered(1))]),
      get: () => Effect.succeed(stored),
      activeRun: () => Effect.succeed(Option.none()),
      claimPending: () => Effect.succeed(Option.none()),
      recordResult: () => Effect.void,
      clearActive: () => Effect.void,
      claimFire: (fire) =>
        Effect.suspend(() => {
          claims.push(fire.expectedRevision)
          return fire.expectedRevision === 2
            ? Effect.succeed({
              claimed: true as const,
              action: "fire" as const,
              reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
            })
            : Effect.fail(
              new TriggerError({ code: "revision_mismatch", message: "trigger hourly is at revision 2" })
            )
        })
    })

  const tick = (store: TriggerStore.Service, runner: RunnerFixture) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )

  // A claim is fenced on the declaration the occurrence was computed from. One
  // refresh and one retry is enough: the next tick re-reads anyway.
  it("refreshes the declaration once and retries the claim", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    await tick(fenced(Option.some(registered(2)), claims), runner)
    expect(claims).toEqual([1, 2])
    expect(runner.starts).toHaveLength(1)
  })

  it("reports a non-revision claim failure without retrying or dispatching", async () => {
    const runner = runnerFixture()
    let claims = 0
    let reads = 0
    await tick({
      ...fenced(Option.some(registered(2)), []),
      get: () => {
        reads++
        return Effect.succeed(Option.some(registered(2)))
      },
      claimFire: () => {
        claims++
        return Effect.fail(new TriggerError({ code: "store", message: "claim unavailable" }))
      }
    }, runner)
    expect(claims).toBe(1)
    expect(reads).toBe(0)
    expect(runner.starts).toHaveLength(0)
  })

  for (const current of [undefined, 1, 2]) {
    it(`refreshes a buffered claim against revision ${current ?? "deleted"}`, async () => {
      const claims: Array<number> = []
      const runner = runnerFixture()
      const first = { ...registered(1), lastFiredAt: hour }
      await tick({
        ...fenced(
          current === undefined ? Option.none() : Option.some({ ...registered(current), lastFiredAt: hour }),
          []
        ),
        list: () => Effect.succeed([TriggerStore.listed(first, { pendingAt: 1 })]),
        claimPending: (fire) => {
          claims.push(fire.expectedRevision)
          return fire.expectedRevision === 2
            ? Effect.succeed(Option.none())
            : Effect.fail(new TriggerError({ code: "revision_mismatch", message: "buffer edited" }))
        }
      }, runner)
      expect(claims).toEqual(current === 2 ? [1, 2] : [1])
      expect(runner.starts).toHaveLength(0)
    })
  }

  it("stops after a second revision mismatch and keeps earlier dispatch progress", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    let reads = 0
    await tick({
      ...fenced(Option.some(registered(2)), []),
      list: () =>
        Effect.succeed([
          TriggerStore.listed({
            ...registered(1),
            lastFiredAt: hour - 180_000,
            cron: "* * * * *",
            catchUp: "all",
            maxCatchUp: 3
          })
        ]),
      get: () => {
        reads++
        return Effect.succeed(
          Option.some({
            ...registered(2),
            lastFiredAt: hour - 180_000,
            cron: "* * * * *",
            catchUp: "all",
            maxCatchUp: 3
          })
        )
      },
      claimFire: (fire) => {
        claims.push(fire.expectedRevision)
        return claims.length === 1
          ? Effect.succeed({ claimed: false })
          : Effect.fail(new TriggerError({ code: "revision_mismatch", message: "edited again" }))
      }
    }, runner)
    expect(claims).toEqual([1, 1, 2])
    expect(reads).toBe(1)
    expect(runner.starts).toHaveLength(0)
  })

  it("gives up when the refreshed declaration is the one it already had", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    await tick(fenced(Option.some(registered(1)), claims), runner)
    expect(claims).toEqual([1])
    expect(runner.starts).toHaveLength(0)
  })

  it("gives up when the trigger is gone by the time it re-reads", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    await tick(fenced(Option.none(), claims), runner)
    expect(claims).toEqual([1])
    expect(runner.starts).toHaveLength(0)
  })
})

describe("Scheduler over real SQLite", () => {
  const declaration = trigger("skip", "one")
  const database = TestDatabase.layer
  const store = SqlTriggerStore.layer.pipe(Layer.provide(database))
  const storeWithSql = SqlTriggerStore.layer.pipe(Layer.provideMerge(database))

  // A restart is two schedulers over one database. The second one has no
  // in-process state at all, so everything it knows about the run in flight it
  // has to read back out of the store.
  it("re-attaches to a run in flight after the process that started it dies", async () => {
    const runner = runnerFixture()
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const triggers = yield* TriggerStore.TriggerStore
        yield* triggers.register(declaration)
        yield* TestClock.setTime(hour)

        yield* Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* TestDatabase.until(
              triggers.activeRun(declaration.id).pipe(
                Effect.map((active) => Option.isSome(active) && active.value === "run-1")
              )
            )
          })
        )
        const acrossDeath = yield* triggers.activeRun(declaration.id)

        yield* TestClock.setTime(3 * hour)
        const afterRestart = yield* Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            const held = yield* triggers.activeRun(declaration.id)
            runner.active.clear()
            yield* TestClock.setTime(4 * hour)
            yield* scheduler.runOnce
            yield* TestDatabase.until(
              triggers.get(declaration.id).pipe(
                Effect.map((row) => Option.isSome(row) && row.value.lastFiredAt === 4 * hour)
              )
            )
            return held
          })
        )
        return { acrossDeath, afterRestart, cursor: yield* triggers.get(declaration.id) }
      }).pipe(Effect.provide(store), Effect.provide(TestClock.layer()))
    )

    expect(outcome.acrossDeath).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(outcome.afterRestart).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(runner.cancelled).toEqual([])
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(2 * hour).toISOString()}`,
      `hourly:${new Date(4 * hour).toISOString()}`
    ])
    expect(
      outcome.cursor._tag === "Some" ? outcome.cursor.value.lastFiredAt : undefined
    ).toBe(4 * hour)
  })

  it("records a recovered run as completed when it has settled", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const triggers = yield* TriggerStore.TriggerStore
        const registered = yield* triggers.register(trigger("skip", "none"))
        yield* triggers.claimFire({
          triggerId: registered.id,
          occurrence: hour,
          expectedRevision: registered.revision
        })
        yield* triggers.recordResult({
          triggerId: registered.id,
          occurrence: hour,
          outcome: "launched",
          runId: "settled-run",
          reservationId: (yield* triggers.inspect(registered.id)).activeRunId!
        })
        const scheduler = yield* Scheduler.make().pipe(
          Effect.provideService(Scheduler.Runner, runnerFixture().service)
        )
        yield* TestClock.setTime(hour)
        yield* scheduler.runOnce
        const rows = yield* sql<{ readonly outcome: string; readonly run_id: string | null }>`
          SELECT outcome, run_id FROM flows_trigger_fires
          WHERE trigger_id = ${registered.id} AND occurrence_at_ms = ${hour}
        `
        return rows[0]
      }).pipe(
        Effect.scoped,
        Effect.provide(storeWithSql),
        Effect.provide(TestClock.layer())
      )
    )
    expect(outcome).toEqual({ outcome: "completed", run_id: "settled-run" })
  })

  it("settles the active occurrence rather than the later fire cursor", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const triggers = yield* TriggerStore.TriggerStore
        const registered = yield* triggers.register(trigger("skip", "none"))
        yield* triggers.claimFire({
          triggerId: registered.id,
          occurrence: hour,
          expectedRevision: registered.revision
        })
        yield* triggers.recordResult({
          triggerId: registered.id,
          occurrence: hour,
          outcome: "launched",
          runId: "settled-run",
          reservationId: (yield* triggers.inspect(registered.id)).activeRunId!
        })
        yield* triggers.claimFire({
          triggerId: registered.id,
          occurrence: 2 * hour,
          expectedRevision: registered.revision
        })
        const scheduler = yield* Scheduler.make().pipe(
          Effect.provideService(Scheduler.Runner, runnerFixture().service)
        )
        yield* TestClock.setTime(2 * hour)
        yield* scheduler.runOnce
        return yield* sql<{ readonly occurrence_at_ms: number; readonly outcome: string }>`
          SELECT occurrence_at_ms, outcome FROM flows_trigger_fires
          WHERE trigger_id = ${registered.id} ORDER BY occurrence_at_ms
        `
      }).pipe(
        Effect.scoped,
        Effect.provide(storeWithSql),
        Effect.provide(TestClock.layer())
      )
    )
    expect(outcomes).toEqual([
      { occurrence_at_ms: hour, outcome: "completed" },
      { occurrence_at_ms: 2 * hour, outcome: "skipped" }
    ])
  })
})

describe("Scheduler dispatch edges", () => {
  const base: TriggerStore.Registered = { ...trigger("skip", "one"), revision: 1, lastFiredAt: 0 }

  // A listing reports what the row holds, and the scheduler reads it before it
  // asks the store again. A fixture that scripts a stored run or a buffered
  // occurrence has to list a row holding one, exactly as a store would.
  const scripted = (
    overrides: Partial<TriggerStore.Service>,
    stored: TriggerStore.Registered = base,
    held: TriggerStore.Held = {
      ...(overrides.activeRun === undefined ? {} : { activeRunId: "scripted-run" }),
      ...(overrides.claimPending === undefined ? {} : { pendingAt: 0 })
    }
  ): TriggerStore.Service =>
    TriggerStore.makeNoop({
      list: () => Effect.succeed([TriggerStore.listed(stored, held)]),
      get: () => Effect.succeed(Option.some(stored)),
      activeRun: () => Effect.succeed(Option.none()),
      activeOccurrence: () => Effect.succeed(Option.none()),
      claimPending: () => Effect.succeed(Option.none()),
      recordResult: () => Effect.void,
      clearActive: () => Effect.void,
      setPending: () => Effect.void,
      claimFire: (fire) =>
        Effect.succeed({
          claimed: true as const,
          action: "fire" as const,
          reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
        }),
      ...overrides
    })

  const tick = (
    store: TriggerStore.Service,
    runner: RunnerFixture,
    at: number = hour,
    options: Scheduler.Options = {}
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make(options).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(at)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )

  it("refreshes a cached reservation when another process commits its run id", async () => {
    for (const live of [true, false]) {
      const runner = runnerFixture()
      if (live) runner.active.add("committed-run")
      const results: Array<TriggerStore.Result> = []
      let reads = 0
      const reservation = TriggerStore.reservationId("hourly", 0)
      const store = scripted({
        activeRun: () => Effect.succeed(Option.some(reads++ === 0 ? reservation : "committed-run")),
        activeOccurrence: () => Effect.succeed(Option.some(0)),
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          })
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(TriggerStore.TriggerStore, store),
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* TestClock.setTime(0)
            yield* scheduler.runOnce
            yield* scheduler.runOnce
            if (live) yield* scheduler.runOnce
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )
      expect(runner.inspected).toEqual(live ? ["committed-run", "committed-run"] : ["committed-run"])
      expect(results.map((result) => result.outcome)).toEqual(live ? [] : ["completed"])
    }
  })

  it("records a run that finished before the first poll as completed", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture({ inspect: () => Effect.succeed("completed") })
    await tick(
      scripted({
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          })
      }),
      runner
    )
    expect(results.map((result) => result.outcome)).toEqual(["launched", "completed"])
    expect(results[1]).toMatchObject({ runId: "run-1", occurrence: hour })
  })

  it("re-arms a committed pending claim when dispatch fails", async () => {
    const runner = runnerFixture({
      cancel: () => Effect.fail(new TriggerError({ code: "runner", message: "cancel failed" }))
    })
    let pendingClaims = 0
    let rearmed = 0
    const occurrence = hour
    const store = scripted({
      claimPending: () =>
        Effect.sync(() => {
          pendingClaims++
          return Option.some({
            occurrence,
            claim: pendingClaims === 1
              ? {
                claimed: true as const,
                action: "supersede" as const,
                reservationId: TriggerStore.reservationId("hourly", occurrence),
                activeRunId: "foreign-run"
              }
              : {
                claimed: true as const,
                action: "fire" as const,
                reservationId: TriggerStore.reservationId("hourly", occurrence)
              }
          })
        }),
      restorePending: () =>
        Effect.sync(() => {
          rearmed++
        })
    }, { ...trigger("supersede", "none"), revision: 1, lastFiredAt: 0 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(0)
          yield* scheduler.runOnce
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(pendingClaims).toBe(2)
    expect(rearmed).toBe(1)
    expect(runner.starts).toHaveLength(1)
  })

  it("leaves a refused pending claim and re-arms a failed buffered decision", async () => {
    const runner = runnerFixture()
    let pendingClaims = 0
    let rearmed = 0
    const store = scripted({
      claimPending: () =>
        Effect.sync(() => {
          pendingClaims++
          return Option.some({
            occurrence: hour,
            claim: pendingClaims === 1
              ? { claimed: false as const }
              : { claimed: true as const, action: "buffer" as const }
          })
        }),
      recordResult: () => Effect.fail(new TriggerError({ code: "store", message: "record failed" })),
      setPending: () =>
        Effect.sync(() => {
          rearmed++
        })
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(0)
          yield* scheduler.runOnce
          yield* scheduler.runOnce
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(pendingClaims).toBe(2)
    expect(rearmed).toBe(1)
    expect(runner.starts).toHaveLength(0)
  })

  it("does nothing when another worker already holds the occurrence", async () => {
    const runner = runnerFixture()
    await tick(scripted({ claimFire: () => Effect.succeed({ claimed: false as const }) }), runner)
    expect(runner.starts).toHaveLength(0)
  })

  // The active run the claim reports may belong to another process entirely,
  // in which case there is no local fiber to interrupt and the store's run id
  // is all this scheduler has to cancel.
  it("supersedes a run this process never launched", async () => {
    const runner = runnerFixture()
    runner.active.add("foreign-run")
    const results: Array<TriggerStore.Result> = []
    const store = scripted({
      claimFire: (fire) =>
        Effect.succeed({
          claimed: true as const,
          action: "supersede" as const,
          reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence),
          activeRunId: "foreign-run"
        }),
      recordResult: (result) =>
        Effect.sync(() => {
          results.push(result)
        })
    }, { ...trigger("supersede", "one"), revision: 1 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(2 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(runner.cancelled).toEqual(["foreign-run"])
    expect(runner.starts).toHaveLength(1)
    // The superseded occurrence belongs to a process this one never met, so
    // there is no occurrence of its own to record the supersession against.
    expect(results.map((result) => result.outcome)).toEqual(["launched"])
  })

  it("re-attaches to a stored run that has no recorded fire cursor", async () => {
    const runner = runnerFixture()
    runner.active.add("foreign-run")
    await tick(
      scripted({ activeRun: () => Effect.succeed(Option.some("foreign-run")) }, {
        ...base,
        lastFiredAt: undefined
      }),
      runner
    )
    expect(runner.inspected).toContain("foreign-run")
    expect(runner.starts).toHaveLength(0)
  })

  it("clears a recovered settled run when no fire occurrence is known", async () => {
    const runner = runnerFixture()
    let stored = true
    let clears = 0
    await tick(
      scripted({
        activeRun: () => Effect.succeed(stored ? Option.some("settled-run") : Option.none()),
        clearActive: () =>
          Effect.sync(() => {
            stored = false
            clears++
          })
      }, {
        ...base,
        lastFiredAt: undefined
      }),
      runner
    )
    expect(clears).toBe(1)
    expect(runner.starts).toHaveLength(0)
  })

  // The bound guard is not the only refusal a catch-up computation can raise.
  // A stored bound one greater than the largest safe integer makes the
  // occurrence search itself refuse, and that is not a backlog to abandon.
  it("propagates a catch-up failure that is not a bound refusal", async () => {
    const runner = runnerFixture()
    const results: Array<TriggerStore.Result> = []
    await tick(
      scripted({
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          })
      }, {
        ...trigger("skip", "all", Number.MAX_SAFE_INTEGER),
        revision: 1,
        lastFiredAt: 0
      }),
      runner
    )
    expect(runner.starts).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  it("fires the backlog and the current occurrence in order", async () => {
    const runner = runnerFixture()
    const store = scripted({}, { ...trigger("supersede", "all"), revision: 1, lastFiredAt: 0 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(4 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(2 * hour).toISOString()}`,
      `hourly:${new Date(3 * hour).toISOString()}`,
      `hourly:${new Date(4 * hour).toISOString()}`
    ])
  })

  // The watermark stops at the last occurrence this tick finished dispatching,
  // so the occurrence whose dispatch failed is recomputed on the next tick and
  // the ones before it are not.
  it("advances the watermark only past the occurrences it dispatched", async () => {
    const runner = runnerFixture()
    const claimed: Array<number> = []
    let failures = 1
    const store = scripted({
      claimFire: (fire) =>
        Effect.suspend(() => {
          claimed.push(fire.occurrence)
          if (fire.occurrence === 3 * hour && failures > 0) {
            failures--
            return Effect.fail(new TriggerError({ code: "store", message: "claim write failed" }))
          }
          return Effect.succeed({
            claimed: true as const,
            action: "fire" as const,
            reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
          })
        })
    }, { ...trigger("supersede", "all"), revision: 1, lastFiredAt: 0 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(3 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(claimed).toEqual([hour, 2 * hour, 3 * hour, 3 * hour])
  })

  // Interruption is the scope closing, not a trigger failing, so it is
  // re-raised rather than logged and swallowed like an ordinary tick failure.
  it("re-raises an interrupt out of a tick instead of logging it", async () => {
    const runner = runnerFixture()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(
              TriggerStore.TriggerStore,
              scripted({ claimFire: () => Effect.interrupt })
            ),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(exit._tag).toBe("Failure")
    expect(runner.starts).toHaveLength(0)
  })

  it("stops the supervisor when the poll loop itself is interrupted", async () => {
    const runner = runnerFixture()
    let calls = 0
    const store = TriggerStore.makeNoop({
      list: () =>
        Effect.suspend(() => {
          calls++
          return Effect.interrupt
        })
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.provide(
          TestClock.adjust("5 minutes"),
          Scheduler.layer().pipe(
            Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(store)),
            Layer.provide(Layer.succeed(Scheduler.Runner)(runner.service))
          )
        )
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(calls).toBe(1)
  })

  // The claim may report a supersession with nothing to supersede: the run the
  // store knew about settled between the read and the decision.
  it("launches a supersede claim that names no active run", async () => {
    const runner = runnerFixture()
    await tick(
      scripted({
        claimFire: (fire) =>
          Effect.succeed({
            claimed: true as const,
            action: "supersede" as const,
            reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
          })
      }),
      runner
    )
    expect(runner.cancelled).toEqual([])
    expect(runner.starts).toHaveLength(1)
  })

  // A prior launch that never got past its reservation has no run for the
  // runtime to cancel; only the store can release the reservation.
  it("never asks the runner to cancel a reservation", async () => {
    const runner = runnerFixture()
    const reservation = TriggerStore.reservationId("hourly", 0)
    runner.active.add(reservation)
    await tick(
      scripted({
        claimFire: (fire) =>
          Effect.succeed({
            claimed: true as const,
            action: "supersede" as const,
            reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence),
            activeRunId: reservation
          })
      }),
      runner
    )
    expect(runner.cancelled).toEqual([])
    expect(runner.starts).toHaveLength(1)
  })
})
