/**
 * `ControlLive.watch`: the finite snapshot, the followed tail, and the
 * high-water handoff that joins them.
 *
 * The snapshot pins its own high-water mark with indexed probes, so the
 * interesting cases are the ones a real journal reaches rarely — an empty
 * partition, a cursor already at the mark, the largest representable
 * sequence, and a page read that fails half way through.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput, PersistenceError, Unavailable } from "../src/ControlError.ts"
import { ControlRuntime, type MemoryFlow } from "../src/ControlRuntime.ts"
import type { ControlEvent, Envelope } from "../src/ControlSchema.ts"
import { live, memoryRuntime, type Stack } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }

const flows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope }
]

const run = <A, E>(
  body: Effect.Effect<A, E, Stack>,
  stack: Layer.Layer<Stack> = live({ runtime: memoryRuntime({ flows }) })
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one run, then flushes what it journaled. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const journal = yield* Journal.Journal
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
    yield* journal.flush
    return { card, runId: receipt.runId }
  })

/**
 * A committed journal row, optionally without the run it belongs to.
 *
 * `ControlEvent` declares `runId` optional, so the projection has to survive
 * an entry that carries none.
 */
const entry = (seq: number, runId?: string): JournalEvent.Entry =>
  ({
    ...(runId === undefined ? {} : { runId: JournalEvent.RunId.make(runId) }),
    seq: JournalEvent.Seq.make(seq),
    eventId: `event-${seq}`,
    sourceId: JournalEvent.SourceId.make("/control"),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs: seq,
    eventType: "control.test",
    payload: { seq },
    meta: null
  }) as unknown as JournalEvent.Entry

const sequences = (events: ReadonlyArray<ControlEvent>): ReadonlyArray<number> => events.map((event) => event.sequence)

describe("ControlLive.watch failures", () => {
  it("reports a journal that cannot stream or page as an unavailable watch", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return {
          followed: yield* Effect.flip(Stream.runCollect(control.watch({ runId: "run-1" }))),
          snapshot: yield* Effect.flip(Stream.runCollect(control.watch({ runId: "run-1", follow: false })))
        }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        journal: Journal.layerNoop(),
        notifications: NotificationQueue.layerNoop()
      })
    )

    expect(observed.followed).toBeInstanceOf(Unavailable)
    expect((observed.followed as Unavailable).feature).toBe("watch")
    expect(observed.snapshot).toBeInstanceOf(Unavailable)
    expect((observed.snapshot as Unavailable).feature).toBe("watch")
  })

  it("reports a page read that fails after the high-water mark was pinned as a persistence failure with its cause", async () => {
    const failingPages = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (journal) =>
        Journal.make({
          ...journal,
          // The probes that pin the tail read one row at a time; only the
          // snapshot's own paging asks for a full page.
          entries: (options) =>
            options.limit === 1024
              ? Effect.fail(new Journal.JournalError({ code: "unknown", message: "page read failed" }))
              : journal.entries(options)
        }))
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)

    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start("pages")
        return yield* Effect.flip(Stream.runCollect(control.watch({ runId, follow: false })))
      }),
      live({ runtime: memoryRuntime({ flows }), journal: failingPages })
    )

    // A storage failure is not a missing feature: it keeps its cause so the
    // operator can see what the journal reported.
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error).toMatchObject({ operation: "watch", cause: { code: "unknown", message: "page read failed" } })
  })
})

describe("ControlLive.watch snapshots", () => {
  it("resumes inside an expansion at journal sequence zero", async () => {
    const source = {
      ...entry(0, "run-zero"),
      eventType: "flows/notifications/Promoted",
      payload: { boundary: "turn", ids: ["one", "two"] }
    }
    const journal = Layer.succeed(
      Journal.Journal,
      Journal.makeNoop({
        entries: (options) => Effect.succeed({ entries: options.after === undefined ? [source] : [], hasMore: false })
      })
    )
    const events = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* control.watch({ runId: "run-zero", follow: false, afterCursor: { sequence: 0, offset: 0 } }).pipe(
          Stream.runCollect
        )
      }),
      live({ journal })
    )
    expect(events.map((event) => [event.kind, event.cursor])).toEqual([
      ["control.steer.delivered", { sequence: 0, offset: 1 }],
      ["control.steer.delivered", { sequence: 0 }]
    ])
  })

  it("returns an empty snapshot for a partition with no entries at all", async () => {
    const events = await run(Effect.gen(function*() {
      const control = yield* Control
      return yield* Stream.runCollect(control.watch({ runId: "run-never-journaled", follow: false }))
    }))

    expect(events).toEqual([])
  })

  it("returns an empty snapshot when the cursor already sits at the high-water mark", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* start("cursor")
      const all = yield* Stream.runCollect(control.watch({ runId, follow: false }))
      const highWater = Math.max(...sequences(all))
      return {
        all,
        atMark: yield* Stream.runCollect(control.watch({ runId, follow: false, afterSequence: highWater })),
        beyondMark: yield* Stream.runCollect(control.watch({ runId, follow: false, afterSequence: highWater + 1 })),
        beforeMark: yield* Stream.runCollect(control.watch({ runId, follow: false, afterSequence: highWater - 1 })),
        highWater
      }
    }))

    expect(observed.all.length).toBeGreaterThan(1)
    expect(observed.atMark).toEqual([])
    expect(observed.beyondMark).toEqual([])
    // One before the mark is the boundary that still has something to replay.
    expect(sequences(observed.beforeMark)).toEqual([observed.highWater])
  })

  it("resolves a finite snapshot when the newest sequence is the largest representable sequence", async () => {
    const largestSequence = Number.MAX_SAFE_INTEGER - 1
    const extremeJournal = Layer.succeed(
      Journal.Journal,
      Journal.makeNoop({
        entries: (options) =>
          Effect.succeed({
            entries: [
              options.after === undefined ? entry(1, "run-extreme") : entry(largestSequence, "run-extreme")
            ],
            hasMore: false
          })
      })
    )

    const events = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Stream.runCollect(control.watch({ runId: "run-extreme", follow: false }))
      }),
      live({
        runtime: memoryRuntime({ flows }),
        journal: extremeJournal,
        notifications: NotificationQueue.layerNoop()
      })
    )

    // The probe stops at the largest sequence the journal can represent and
    // never asks for the unallocatable MAX_SAFE_INTEGER value.
    expect(events).toEqual([
      {
        cursor: { sequence: 1 },
        sequence: 1,
        kind: "control.test",
        runId: "run-extreme",
        occurredAt: 1,
        payload: { seq: 1 }
      }
    ])
  })

  it("covers every run and plan partition when no run is named", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { card, runId } = yield* start("unscoped")
      const orphan = yield* control.plan({ flowId: "system/test", input: { suite: "orphan" } })
      const journal = yield* Journal.Journal
      yield* journal.flush
      const events = yield* Stream.runCollect(control.watch({ follow: false }))
      return { events, card, orphan, runId }
    }))

    const partitions = new Set(observed.events.map((event) => event.runId))
    expect(partitions).toEqual(
      new Set([
        `plan:${observed.card.planId}`,
        `plan:${observed.orphan.planId}`,
        observed.runId
      ])
    )
  })
})

describe("ControlLive.watch following", () => {
  it("delivers every event once when runs start and signal while the walk is between pages", async () => {
    const secondPage = Deferred.makeUnsafe<void>()
    const resume = Deferred.makeUnsafe<void>()
    let pages = 0
    // One run id per page, and the walk parks before its second page.
    const paged = Layer.effect(ControlRuntime)(Effect.map(ControlRuntime, (runtime) =>
      ControlRuntime.of({
        ...runtime,
        pageRunIds: (request) =>
          Effect.gen(function*() {
            if (++pages === 2) {
              yield* Deferred.succeed(secondPage, undefined)
              yield* Deferred.await(resume)
            }
            return yield* runtime.pageRunIds({ ...request, limit: 1 })
          })
      }))).pipe(Layer.provide(memoryRuntime({ flows })))

    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const before = [yield* start("walk-a"), yield* start("walk-b"), yield* start("walk-c")]
        const followed: Array<ControlEvent> = []
        const fiber = yield* control.watch({}).pipe(
          Stream.runForEach((event) => Effect.sync(() => followed.push(event))),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(secondPage)
        // walk-c is not walked yet, so the tail sees its new entry first;
        // walk-d did not exist when the walk started.
        yield* control.signal({
          runId: before[2]!.runId,
          signal: { name: "mid-walk", payload: null },
          idempotencyKey: "signal:mid-walk"
        })
        const late = yield* start("walk-d")
        yield* journal.flush
        yield* Deferred.succeed(resume, undefined)
        const expected = yield* Stream.runCollect(control.watch({ follow: false }))
        for (let attempt = 0; attempt < 500 && followed.length < expected.length; attempt++) {
          yield* Effect.sleep("10 millis")
        }
        // Long enough for a duplicate to arrive after the last expected event.
        yield* Effect.sleep("100 millis")
        yield* Fiber.interrupt(fiber)
        return { expected, followed, late, signalled: before[2]!.runId }
      }),
      live({ runtime: paged })
    )

    const key = (event: ControlEvent) => `${String(event.runId)}:${event.sequence}`
    const followedKeys = observed.followed.map(key)
    expect(pages).toBeGreaterThan(2)
    expect(new Set(followedKeys).size).toBe(followedKeys.length)
    expect(new Set(followedKeys)).toEqual(new Set(observed.expected.map(key)))
    expect(observed.followed.some((event) => event.runId === observed.late.runId)).toBe(true)
    expect(observed.followed.find((event) => event.kind === "control.signal.admitted")?.runId).toBe(
      observed.signalled
    )
  })

  it("merges every partition with the committed tail and reports each event once", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const { card, runId } = yield* start("follow")
      const collected = yield* control.watch({}).pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* control.signal({
        runId,
        signal: { name: "after-watch", payload: null },
        idempotencyKey: "signal:after-watch"
      })
      yield* journal.flush
      const events = yield* Fiber.join(collected).pipe(Effect.timeout("10 seconds"))
      return { events, card, runId }
    }))

    // Sequences are per partition, so identity is the pair. The tail and the
    // run's own partition both carry the new event; the reader sees it once.
    const keys = observed.events.map((event) => `${String(event.runId)}:${event.sequence}`)
    expect(new Set(keys).size).toBe(5)
    expect(keys).toContain(`plan:${observed.card.planId}:0`)
    expect(keys).toContain(`${observed.runId}:0`)
    expect(observed.events.find((event) => event.kind === "control.signal.admitted")).toMatchObject({
      kind: "control.signal.admitted",
      runId: observed.runId
    })
  })

  it("joins more than 1024 overlapping history rows and tail notices exactly once", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const subscribed = Deferred.makeUnsafe<void>()
        const historyReady = Deferred.makeUnsafe<void>()
        const published = yield* PubSub.unbounded<JournalEvent.Entry>()
        const history = Array.from({ length: 1025 }, (_, index) => index + 1)
        const scripted = Layer.succeed(
          Journal.Journal,
          Journal.makeNoop({
            changes: PubSub.subscribe(published).pipe(
              Effect.tap(() => Deferred.succeed(subscribed, undefined))
            ),
            stream: (options) =>
              Stream.fromIterable(history.map((seq) => entry(seq, String(options.runId)))).pipe(
                Stream.ensuring(Deferred.succeed(historyReady, undefined))
              ),
            entries: (options) => {
              const after = options.after === undefined ? -1 : options.after
              const remaining = history.filter((seq) => seq > after)
              const selected = remaining.slice(0, options.limit)
              return Effect.succeed({
                entries: selected.map((seq) => entry(seq, String(options.runId))),
                hasMore: remaining.length > selected.length
              }).pipe(
                Effect.tap(() =>
                  options.limit === 1024 && selected.at(-1) === 1025
                    ? Deferred.succeed(historyReady, undefined)
                    : Effect.void
                )
              )
            }
          })
        )

        return yield* Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite: "handoff" } })
          const partition = `plan:${card.planId}`
          const collected = yield* control.watch({}).pipe(
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(subscribed)
          yield* Deferred.await(historyReady)
          for (let seq = 1; seq <= 1026; seq++) {
            yield* PubSub.publish(published, entry(seq, partition))
          }
          yield* PubSub.shutdown(published)
          return yield* Fiber.join(collected).pipe(Effect.timeout("20 seconds"))
        }).pipe(
          Effect.provide(live({
            runtime: memoryRuntime({ flows }),
            journal: scripted,
            notifications: NotificationQueue.layerNoop()
          }))
        )
      }).pipe(Effect.scoped, Effect.orDie)
    )

    expect(observed).toHaveLength(1026)
    expect(new Set(sequences(observed)).size).toBe(1026)
    expect(sequences(observed)).toContain(1)
    expect(sequences(observed)).toContain(1026)
  })

  it("drops tail entries at or below the cursor the reader supplied", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const subscribed = Deferred.makeUnsafe<void>()
        const published = yield* PubSub.unbounded<JournalEvent.Entry>()
        const scripted = Layer.succeed(
          Journal.Journal,
          Journal.makeNoop({
            stream: (options) =>
              Stream.unwrap(
                PubSub.subscribe(published).pipe(
                  Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                  Effect.map((subscription) =>
                    Stream.fromSubscription(subscription).pipe(
                      Stream.filter((entry) =>
                        entry.runId === options.runId &&
                        (options.afterSequence === undefined || entry.seq > options.afterSequence)
                      )
                    )
                  )
                )
              )
          })
        )

        return yield* Effect.gen(function*() {
          const control = yield* Control
          const collected = yield* control.watch({ runId: "run-1", afterSequence: 10 }).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(subscribed)
          yield* PubSub.publish(published, entry(9, "run-1"))
          yield* PubSub.publish(published, entry(10, "run-1"))
          yield* PubSub.publish(published, entry(11, "run-1"))
          return yield* Fiber.join(collected).pipe(Effect.timeout("10 seconds"))
        }).pipe(
          Effect.provide(live({
            runtime: memoryRuntime({ flows }),
            journal: scripted,
            notifications: NotificationQueue.layerNoop()
          }))
        )
      }).pipe(Effect.scoped, Effect.orDie)
    )

    // The cursor is exclusive: 10 is already seen, 11 is the first new one.
    expect(sequences(observed)).toEqual([11])
  })

  it("refuses a cursor that names no run, because one scalar cannot address every partition", async () => {
    // Journal sequences are partition-local: `plan:` entries and every run
    // start at 0. One scalar applied to all of them skipped every lower unseen
    // sequence in every partition but the cursor's own, while the api page
    // promised exactly-once resumption. The refusal is what makes the promise
    // true for the scoped watch that can hold it.
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Effect.flip(Stream.runCollect(control.watch({ afterSequence: 10, follow: false })))
      }).pipe(
        Effect.provide(live({ runtime: memoryRuntime({ flows }), notifications: NotificationQueue.layerNoop() })),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toContain("afterSequence")
  })
})

describe("ControlLive.watch durable gap checks", () => {
  for (
    const scenario of [
      { name: "an empty durable gap", notices: [2], durable: [] as number[], expected: [2] },
      { name: "an unused sequence and duplicate tail notice", notices: [0, 0, 3], durable: [0, 3], expected: [0, 3] },
      // The first notice pins the partition and reads its durable history,
      // so a notice the sliding buffer dropped before the pin is recovered.
      { name: "a dropped initial committed notice", notices: [2], durable: [1, 2], expected: [1, 2] },
      // After the pin, a dropped notice is a real loss and fails the stream.
      {
        name: "a dropped later committed notice",
        notices: [0],
        durable: [0],
        later: { notices: [3], durable: [0, 1, 3] },
        error: "PersistenceError"
      },
      { name: "a failed durable gap read", notices: [2], durable: [], error: "PersistenceError", fail: true }
    ]
  ) {
    it(`handles ${scenario.name}`, async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const subscribed = Deferred.makeUnsafe<void>()
          const published = yield* PubSub.unbounded<JournalEvent.Entry>()
          let durable: ReadonlyArray<number> = scenario.durable
          const scripted = Layer.succeed(
            Journal.Journal,
            Journal.makeNoop({
              changes: PubSub.subscribe(published).pipe(Effect.tap(() => Deferred.succeed(subscribed, undefined))),
              entries: (options) =>
                scenario.fail
                  ? Effect.fail(new Journal.JournalError({ code: "unknown", message: "gap read failed" }))
                  : Effect.succeed({
                    entries: durable.filter((seq) => seq > (options.after ?? -1)).slice(0, options.limit).map((
                      seq
                    ) => entry(seq, "new-partition")),
                    hasMore: false
                  })
            })
          )
          return yield* Effect.gen(function*() {
            const control = yield* Control
            const allSeen = Deferred.makeUnsafe<void>()
            const pinnedSeen = Deferred.makeUnsafe<void>()
            let delivered = 0
            const collected = yield* control.watch({}).pipe(
              Stream.tap(() => {
                ++delivered
                return Effect.all([
                  delivered === scenario.notices.length ? Deferred.succeed(pinnedSeen, undefined) : Effect.void,
                  delivered === scenario.expected?.length ? Deferred.succeed(allSeen, undefined) : Effect.void
                ])
              }),
              Stream.runCollect,
              Effect.result,
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(subscribed)
            for (const seq of scenario.notices) yield* PubSub.publish(published, entry(seq, "new-partition"))
            if ("later" in scenario) {
              yield* Deferred.await(pinnedSeen)
              durable = scenario.later.durable
              for (const seq of scenario.later.notices) yield* PubSub.publish(published, entry(seq, "new-partition"))
            }
            if (!("error" in scenario)) {
              yield* Deferred.await(allSeen)
              yield* PubSub.shutdown(published)
            }
            return yield* Fiber.join(collected).pipe(Effect.timeout("5 seconds"))
          }).pipe(Effect.provide(live({ journal: scripted, notifications: NotificationQueue.layerNoop() })))
        }).pipe(Effect.scoped, Effect.timeout("5 seconds"))
      )
      if ("error" in scenario) {
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: `/control/${scenario.error}` } })
      } else {
        expect(result._tag).toBe("Success")
        if (result._tag === "Success") expect(sequences(result.success)).toEqual(scenario.expected)
      }
    })
  }
})
