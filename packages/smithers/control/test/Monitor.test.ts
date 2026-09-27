import * as TestDatabase from "@smthrs/database/test/TestDatabase"
/**
 * Run health classification and the heal loop over it.
 *
 * `classify` is enumerated as a table, because the value of a fixed vocabulary
 * is that every condition maps to exactly one word and a reader can check the
 * mapping at a glance. The loop runs over the real durable control plane: a
 * monitor that healed a run in a fixture would prove nothing about a monitor
 * pointed at production, and the stall it has to detect is a property of the
 * journal, which only a real journal has.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { ControlEvent, Receipt, RunSummary } from "../src/ControlSchema.ts"
import * as Monitor from "../src/Monitor.ts"
import { durable, type DurableStack } from "./DurableStack.ts"
import { park } from "./Park.ts"

/** Parks a run on a reason the way the engine parks one. */
const parkOn = (runId: string, reason: string) =>
  Effect.flatMap(
    Effect.service(SqlClient.SqlClient),
    (sql) => sql`UPDATE flows_runs SET waiting_reason = ${reason} WHERE run_id = ${runId}`.pipe(Effect.orDie)
  )

const run = <A, E>(
  body: Effect.Effect<A, E, DurableStack>,
  stack: Layer.Layer<DurableStack> = durable()
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Every journal entry a run has, so a test can read a record's source. */
const entriesOf = (runId: string) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }).pipe(
        Effect.map((page) => page.entries),
        Effect.orDie
      )
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

const summary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  runId: "run-1",
  flowId: "system/test",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const event = (kind: string, sequence: number, payload: ControlEvent["payload"] = {}): ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload
})

const started = (sequence: number) => event(Monitor.attemptStartedEventType, sequence)
const finished = (sequence: number, state: "succeeded" | "failed") =>
  event(Monitor.attemptFinishedEventType, sequence, { state })

const classify = (observation: Partial<Monitor.Observation>): Monitor.Health =>
  Monitor.classify({ summary: summary(), events: [], beatsWithoutProgress: 0, stallBeats: 3, ...observation })

describe("Monitor.classify", () => {
  const table: ReadonlyArray<[string, Partial<Monitor.Observation>, Monitor.Health]> = [
    ["a run the control plane has never heard of", { summary: undefined }, "unknown"],
    ["a run that reported its own failure", { summary: summary({ status: "failed" }) }, "failing"],
    ["a completed run", { summary: summary({ status: "completed" }) }, "healthy"],
    ["a cancelled run", { summary: summary({ status: "cancelled" }) }, "healthy"],
    ["a run waiting on an approval", { summary: summary({ status: "waiting-approval" }) }, "awaiting-human"],
    [
      "a run parked on an approval",
      { summary: summary({ status: "parked", waitingReason: "approval" }) },
      "awaiting-human"
    ],
    [
      "an approval park that also has a failed attempt",
      {
        summary: summary({ status: "parked", waitingReason: "approval" }),
        events: [started(1), finished(2, "failed")]
      },
      "awaiting-human"
    ],
    [
      "a run an operator parked, which declares no waiting reason",
      { summary: summary({ status: "parked" }), beatsWithoutProgress: 9 },
      "awaiting-human"
    ],
    [
      "a run a sweep released from a dead owner",
      { summary: summary({ status: "parked", waitingReason: "released" }), beatsWithoutProgress: 3 },
      "stalled"
    ],
    [
      "a trampoline past the round bound",
      { summary: summary({ roundOrdinal: 40 }), roundBound: 32 },
      "runaway-loop"
    ],
    [
      "a trampoline under the round bound",
      { summary: summary({ roundOrdinal: 4 }), roundBound: 32 },
      "healthy"
    ],
    [
      "a run whose last settled attempt failed",
      { events: [started(1), finished(2, "failed")] },
      "failing"
    ],
    [
      "a run that failed an attempt and then succeeded one",
      { events: [started(1), finished(2, "failed"), started(3), finished(4, "succeeded")] },
      "healthy"
    ],
    [
      "no progress for the stall threshold with nothing in flight",
      { events: [started(1), finished(2, "succeeded")], beatsWithoutProgress: 3 },
      "stalled"
    ],
    [
      "no progress for the stall threshold with an attempt still open",
      { events: [started(1)], beatsWithoutProgress: 3 },
      "wedged-node"
    ],
    [
      "no progress for one beat short of the threshold",
      { events: [started(1)], beatsWithoutProgress: 2 },
      "healthy"
    ],
    ["a run whose journal is still growing", { events: [started(1)], beatsWithoutProgress: 0 }, "healthy"]
  ]

  for (const [name, observation, health] of table) {
    it(`calls ${name} ${health}`, () => {
      expect(classify(observation)).toBe(health)
    })
  }

  it("maps each health onto the remedy it warrants", () => {
    const every: ReadonlyArray<Monitor.Health> = [
      "healthy",
      "stalled",
      "wedged-node",
      "runaway-loop",
      "awaiting-human",
      "failing",
      "unknown"
    ]
    expect(every.map((health) => [health, Monitor.remedyFor(health)])).toEqual([
      ["healthy", "none"],
      ["stalled", "resume"],
      ["wedged-node", "resume"],
      ["runaway-loop", "cancel"],
      ["awaiting-human", "none"],
      ["failing", "cancel"],
      ["unknown", "none"]
    ])
  })
})

describe("Monitor.run over the durable control plane", () => {
  it("reads only new watch events across beats, including its own records", async () => {
    await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("incremental")
      const delivered: Array<Array<ControlEvent>> = []
      const filters: Array<Parameters<typeof control.watch>[0]> = []
      const report = yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 4, stallBeats: 1 }).pipe(
        Effect.provideService(Control, {
          ...control,
          watch: (filter) => {
            filters.push(filter)
            const events: Array<ControlEvent> = []
            delivered.push(events)
            return control.watch(filter).pipe(Stream.tap((event) =>
              Effect.sync(() => {
                events.push(event)
              })
            ))
          }
        })
      )
      expect(delivered[0]!.length).toBeGreaterThan(0)
      expect(delivered.slice(1).map((events) => events.map((event) => event.kind))).toEqual([
        [Monitor.beatEventType],
        [Monitor.beatEventType],
        [Monitor.beatEventType]
      ])
      expect(filters.slice(1).map((filter) => filter.afterCursor)).toEqual(
        delivered.slice(0, -1).map((events) => events.at(-1)!.cursor)
      )
      expect(report.beats.map((beat) => beat.health)).toEqual(["healthy", "stalled", "stalled", "stalled"])
      expect(new Set(report.beats.map((beat) => beat.sequence)).size).toBe(1)
    }))
  })

  it("checkpoints completed snapshots from providers without expansion cursors", async () => {
    await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("legacy-cursor")
      const delivered: Array<Array<ControlEvent>> = []
      const report = yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 3, stallBeats: 1 }).pipe(
        Effect.provideService(Control, {
          ...control,
          watch: (filter) => {
            const events: Array<ControlEvent> = []
            delivered.push(events)
            return control.watch({ runId: filter.runId, follow: filter.follow, afterSequence: filter.afterSequence })
              .pipe(
                Stream.map(({ cursor: _cursor, ...event }) => event),
                Stream.tap((event) =>
                  Effect.sync(() => {
                    events.push(event)
                  })
                )
              )
          }
        })
      )
      expect(report.beats.map((beat) => beat.health)).toEqual(["healthy", "stalled", "stalled"])
      expect(delivered.slice(1).map((events) => events.map((event) => event.kind))).toEqual([
        [Monitor.beatEventType],
        [Monitor.beatEventType]
      ])
    }))
  })

  it("retains open attempts and the last outcome while folding only new entries", async () => {
    await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const runId = yield* start("fold-attempts")
      let check = 0
      const report = yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 8, stallBeats: 1 }).pipe(
        Effect.provideService(Control, {
          ...control,
          watch: (filter) =>
            Stream.unwrap(
              Effect.gen(function*() {
                const additions = check === 0 || check === 6 ?
                  [started(0)]
                  : check === 2 ?
                  [finished(0, "failed")]
                  : check === 4 ?
                  [started(0), finished(0, "succeeded")]
                  : []
                check++
                for (const addition of additions) {
                  yield* journal.emitDurableUnfenced(
                    new JournalEvent.Input({
                      runId: JournalEvent.RunId.make(runId),
                      sourceId: JournalEvent.SourceId.make("/test"),
                      eventType: addition.kind,
                      payload: addition.payload
                    })
                  )
                }
                return control.watch(filter)
              }).pipe(Effect.orDie)
            )
        })
      )
      expect(report.beats.map((beat) => beat.health)).toEqual([
        "healthy",
        "wedged-node",
        "failing",
        "failing",
        "healthy",
        "stalled",
        "healthy",
        "wedged-node"
      ])
    }))
  })

  it("takes every beat it was asked for and journals each one", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("beats")
      const report = yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 4, stallBeats: 99 })
      const journaled = yield* control.list({ _tag: "runs", filters: { runId } })
      return { report, journaled }
    }))

    expect(observed.report.beats.map((beat) => beat.beat)).toEqual([0, 1, 2, 3])
    expect(observed.report.beats.every((beat) => beat.healed === undefined)).toBe(true)
    expect(observed.report.health).toBe("healthy")
  })

  it("records every beat on the run's journal", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("journal")
      yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 3, stallBeats: 99 })
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return events.filter((event) => event.kind === Monitor.beatEventType)
    }))

    expect(observed.map((event) => event.payload)).toEqual([
      { runId: expect.any(String), monitorId: "default", beat: 0, health: "healthy", sequence: expect.any(Number) },
      { runId: expect.any(String), monitorId: "default", beat: 1, health: "healthy", sequence: expect.any(Number) },
      { runId: expect.any(String), monitorId: "default", beat: 2, health: "healthy", sequence: expect.any(Number) }
    ])
  })

  it("calls an approval-parked run awaiting-human and heals nothing", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* start("approval")
      yield* park(runtime, runId)
      yield* parkOn(runId, "approval")
      const before = yield* runtime.getRun(runId)
      const report = yield* Monitor.run({
        runId,
        intervalMs: 0,
        maxChecks: 5,
        stallBeats: 1,
        autoHeal: ["stalled", "wedged-node", "failing", "runaway-loop"]
      })
      const after = yield* runtime.getRun(runId)
      return { before, report, after }
    }))

    expect(observed.report.beats.map((beat) => beat.health)).toEqual([
      "awaiting-human",
      "awaiting-human",
      "awaiting-human",
      "awaiting-human",
      "awaiting-human"
    ])
    expect(observed.report.beats.every((beat) => beat.healed === undefined)).toBe(true)
    // The run is exactly where the human left it.
    expect(observed.after.status).toBe("parked")
  })

  it("resumes a stalled run once and stops when the resume moves it", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("stalled")
      yield* park(yield* ControlRuntime, runId)
      // A stall is a run nobody is driving: `released` is what a sweep writes
      // on a run whose owner died. A park with no reason is an operator's, and
      // the case below proves the monitor leaves that one alone.
      yield* parkOn(runId, "released")
      const report = yield* Monitor.run({
        runId,
        intervalMs: 0,
        maxChecks: 6,
        stallBeats: 3,
        autoHeal: ["stalled"]
      })
      return report
    }))

    expect(observed.beats.filter((beat) => beat.healed === "resume")).toHaveLength(1)
    expect(observed.beats.find((beat) => beat.healed === "resume")?.health).toBe("stalled")
    expect(observed.beats.find((beat) => beat.healed === "resume")?.receipt?._tag).toBe("Accepted")
    // Three quiet beats before the stall, and none after: the resume wrote a
    // journal entry, which is progress.
    expect(observed.beats.map((beat) => beat.health)).toEqual([
      "healthy",
      "healthy",
      "healthy",
      "stalled",
      "healthy",
      "healthy"
    ])
  })

  it("journals the heal only after the remedy returned a receipt", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("healed-after")
      yield* park(yield* ControlRuntime, runId)
      yield* parkOn(runId, "released")
      const report = yield* Monitor.run({
        runId,
        intervalMs: 0,
        maxChecks: 4,
        stallBeats: 3,
        autoHeal: ["stalled"]
      })
      const entries = yield* entriesOf(runId)
      return {
        report,
        beats: entries.filter((entry) => entry.eventType === Monitor.beatEventType),
        healed: entries.filter((entry) => entry.eventType === Monitor.healedEventType)
      }
    }))

    const deciding = observed.beats.at(-1)!
    // The beat that decided says what it is ABOUT to do. Saying it healed
    // before the remedy ran would leave durable evidence of a heal that a
    // crash one instruction later never performed.
    expect(deciding.payload).toMatchObject({ health: "stalled", remedy: "resume" })
    expect((deciding.payload as Record<string, unknown>)["healed"]).toBeUndefined()

    expect(observed.healed).toHaveLength(1)
    expect(observed.healed[0]?.payload).toMatchObject({
      monitorId: "default",
      health: "stalled",
      healed: "resume",
      receipt: "Accepted"
    })
    // And it is written after the beat, not with it.
    expect(observed.healed[0]!.seq).toBeGreaterThan(deciding.seq)
    expect(observed.report.beats.at(-1)?.healed).toBe("resume")
  })

  it("journals nothing healed when the remedy fails", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("failed-heal")
      yield* park(yield* ControlRuntime, runId)
      yield* parkOn(runId, "released")
      const exit = yield* Effect.exit(Monitor.run({
        runId,
        intervalMs: 0,
        maxChecks: 6,
        stallBeats: 3,
        autoHeal: ["stalled"],
        heal: () =>
          Effect.fail(
            new PersistenceError({ operation: "resume", message: "the control plane refused the resume" })
          )
      }))
      const entries = yield* entriesOf(runId)
      return {
        exit,
        beats: entries.filter((entry) => entry.eventType === Monitor.beatEventType),
        healed: entries.filter((entry) => entry.eventType === Monitor.healedEventType)
      }
    }))

    expect(observed.exit._tag).toBe("Success")
    expect(observed.beats).toHaveLength(6)
    // The run was never healed, and the journal never says it was.
    expect(observed.healed).toEqual([])
    expect(observed.beats.at(-1)?.payload).toMatchObject({ health: "stalled", remedy: "resume" })
    for (const beat of observed.beats) {
      expect((beat.payload as Record<string, unknown>)["healed"]).toBeUndefined()
    }
  })

  /**
   * What each receipt a remedy can answer with means to the loop.
   *
   * Only `Accepted` and `AlreadyApplied` say the remedy was applied. `Parked`
   * and `Conflict` say it was not, so the stall evidence stands and the next
   * beat tries again; `Terminal` says the run settled under the monitor, so
   * there is nothing left to remedy and the loop ends. `beats` is what tells
   * the ended loop apart from the one that kept beating: the monitor is
   * allowed four checks and takes fewer when it stops early.
   */
  const receiptCases: ReadonlyArray<{
    readonly receipt: Receipt
    readonly healed: boolean
    readonly calls: number
    readonly beats: number
    readonly finalHealth: Monitor.Health
  }> = [
    {
      receipt: { _tag: "Accepted", receiptId: "receipt:accepted", runId: "run-replaced" },
      healed: true,
      calls: 1,
      beats: 4,
      finalHealth: "healthy"
    },
    {
      receipt: { _tag: "AlreadyApplied", receiptId: "receipt:replayed", runId: "run-replaced" },
      healed: true,
      calls: 1,
      beats: 4,
      finalHealth: "healthy"
    },
    {
      receipt: { _tag: "Parked", receiptId: "receipt:parked", planId: "plan-parked", status: "waiting-approval" },
      healed: false,
      calls: 2,
      beats: 4,
      finalHealth: "stalled"
    },
    {
      receipt: { _tag: "Conflict", message: "the key names another mutation" },
      healed: false,
      calls: 2,
      beats: 4,
      finalHealth: "stalled"
    },
    {
      // The beat that asked still classified a stalled run, because it did:
      // the run settled while the remedy was in flight, and rewriting the
      // beat's own classification afterwards would be a record of something
      // the monitor never observed. What changes is that the loop stops.
      receipt: { _tag: "Terminal", runId: "run-replaced", status: "completed" },
      healed: false,
      calls: 1,
      beats: 3,
      finalHealth: "stalled"
    }
  ]

  for (const testCase of receiptCases) {
    it(`interprets a ${testCase.receipt._tag} remedy receipt without overstating the heal`, async () => {
      let calls = 0
      const observed = await run(Effect.gen(function*() {
        const runId = yield* start(`receipt-${testCase.receipt._tag}`)
        yield* park(yield* ControlRuntime, runId)
        yield* parkOn(runId, "released")
        const receipt = testCase.receipt._tag === "Terminal" || testCase.receipt._tag === "Accepted" ||
            testCase.receipt._tag === "AlreadyApplied"
          ? { ...testCase.receipt, runId }
          : testCase.receipt
        const report = yield* Monitor.run({
          runId,
          intervalMs: 0,
          maxChecks: 4,
          stallBeats: 2,
          autoHeal: ["stalled"],
          heal: () => {
            calls += 1
            return Effect.succeed(receipt)
          }
        })
        const entries = yield* entriesOf(runId)
        return {
          report,
          healed: entries.filter((entry) => entry.eventType === Monitor.healedEventType)
        }
      }))

      expect(calls).toBe(testCase.calls)
      expect(observed.report.beats).toHaveLength(testCase.beats)
      expect(observed.report.beats.at(-1)?.health).toBe(testCase.finalHealth)
      expect(observed.report.beats.some((beat) => beat.healed === "resume")).toBe(testCase.healed)
      expect(observed.healed).toHaveLength(testCase.healed ? 1 : 0)
    })
  }

  it("names the monitor on every record it writes, so two of them are tellable apart", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("two-monitors")
      yield* park(yield* ControlRuntime, runId)
      yield* parkOn(runId, "released")
      // Two supervisors pointed at one run. Nothing stops that, so the
      // evidence has to say which of them wrote each record, and their
      // remedies have to carry different idempotency keys.
      yield* Monitor.run({
        runId,
        monitorId: "supervisor-a",
        intervalMs: 0,
        maxChecks: 4,
        stallBeats: 3,
        autoHeal: ["stalled"]
      })
      yield* Monitor.run({
        runId,
        monitorId: "supervisor-b",
        intervalMs: 0,
        maxChecks: 4,
        stallBeats: 3,
        autoHeal: ["stalled"]
      })
      const entries = yield* entriesOf(runId)
      return entries.filter((entry) =>
        entry.eventType === Monitor.beatEventType || entry.eventType === Monitor.healedEventType
      )
    }))

    const sources = new Set(observed.map((entry) => entry.sourceId as string))
    expect(sources).toEqual(new Set(["/control/monitor/supervisor-a", "/control/monitor/supervisor-b"]))
    const monitors = new Set(observed.map((entry) => (entry.payload as Record<string, unknown>)["monitorId"]))
    expect(monitors).toEqual(new Set(["supervisor-a", "supervisor-b"]))
  })

  it("leaves a run an operator parked where the operator left it", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* start("operator-park")
      // An operator's own park writes no waiting reason. Every engine park
      // names one, so an absent reason is an operator's hand on the run.
      yield* park(runtime, runId)
      const report = yield* Monitor.run({
        runId,
        intervalMs: 0,
        maxChecks: 5,
        stallBeats: 1,
        autoHeal: ["stalled", "wedged-node", "failing", "runaway-loop"]
      })
      return { report, after: yield* runtime.getRun(runId) }
    }))

    expect(observed.report.beats.map((beat) => beat.health)).toEqual([
      "awaiting-human",
      "awaiting-human",
      "awaiting-human",
      "awaiting-human",
      "awaiting-human"
    ])
    expect(observed.report.beats.every((beat) => beat.healed === undefined)).toBe(true)
    expect(observed.after.status).toBe("parked")
  })

  it("stops early on a run that finished", async () => {
    const observed = await run(Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const runId = yield* start("completed")
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "completed")
      return yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 6, stallBeats: 1 })
    }))

    expect(observed.beats).toHaveLength(1)
    expect(observed.health).toBe("healthy")
  })

  it("calls a run unknown when the control plane answers a listing of another kind", async () => {
    // `Monitor` asks for runs and reads the answer's tag rather than trusting
    // it. A control plane that answered a flow listing — an older server, a
    // proxy that rewrote the request — would otherwise have its items read as
    // run summaries, and the monitor would heal a run from another table's row.
    const blindListing = Layer.provideMerge(
      Layer.effect(
        Control,
        Effect.map(Control, (control) => ({
          ...control,
          list: () => Effect.succeed({ _tag: "flows" as const, items: [] })
        }))
      ),
      durable()
    ) as Layer.Layer<DurableStack>

    const observed = await run(
      Effect.gen(function*() {
        const runId = yield* start("blind-listing")
        return yield* Monitor.run({ runId, intervalMs: 0, maxChecks: 2, stallBeats: 1, autoHeal: ["stalled"] })
      }),
      blindListing
    )

    expect(observed.beats.map((beat) => beat.health)).toEqual(["unknown", "unknown"])
    // Nothing is known, so nothing is remedied.
    expect(observed.beats.every((beat) => beat.healed === undefined)).toBe(true)
  })

  it("waits the interval between beats", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runId = yield* start("interval")
        const fiber = yield* Monitor.run({ runId, intervalMs: 1_000, maxChecks: 3, stallBeats: 99 }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        // The first beat has run and the second is asleep.
        const early = fiber.pollUnsafe()
        yield* TestDatabase.until(TestClock.adjust("1 second").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined)))
        return { early, report: yield* Fiber.join(fiber) }
      }).pipe(
        Effect.provide(durable()),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.early).toBeUndefined()
    expect(observed.report.beats).toHaveLength(3)
  })
})
