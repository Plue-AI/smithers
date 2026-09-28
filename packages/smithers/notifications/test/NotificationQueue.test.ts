import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const item = (
  id: string,
  delivery: "steer" | "queue",
  targetLineageId = "run/root",
  body = id
): Notification => {
  const common = {
    id,
    targetLineageId,
    provenance: {
      sourceRunId: "operator",
      sourceLineageId: "operator/root",
      sourceTurn: 3,
      sourceActor: "human:will"
    },
    payload: { body }
  }
  return delivery === "steer"
    ? { _tag: "human-steer", delivery, ...common }
    : { _tag: "human-followup", delivery, ...common }
}

/** One durable read, and the cursor it paged from. */
interface Read {
  readonly runId: string
  readonly after: number | undefined
  readonly limit: number
  readonly entries: number
}

/**
 * A journal that records every durable read.
 *
 * The cursor is the point: a fold the cache still holds pages from the
 * sequence it stopped at, and a fold the cache dropped starts again with no
 * cursor at all. Counting runs kept alive cannot tell those apart, so the
 * eviction cases read this instead of the layer's private map.
 */
const recording = (reads: Array<Read>) =>
  Layer.effect(
    Journal.Journal,
    Effect.map(Journal.Journal, (journal) =>
      Journal.Journal.of({
        ...journal,
        entries: (options) =>
          Effect.tap(journal.entries(options), (page) =>
            Effect.sync(() => {
              reads.push({
                runId: options.runId,
                after: options.after,
                limit: options.limit,
                entries: page.entries.length
              })
            }))
      }))
  ).pipe(Layer.provide(TestJournal.layer()))

it("ignores noise-only tails while retaining canonical admission and promotion cursors", async () => {
  const reads: Read[] = []
  await Effect.runPromise(
    Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue, journal = yield* Journal.Journal
      const runId = JournalEvent.RunId.make("filtered-notifications")
      const first = yield* queue.admit(runId, item("first", "steer", runId))
      for (let index = 0; index < 20; index++) {
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId,
            sourceId: JournalEvent.SourceId.make("engine"),
            eventType: "control.engine.event",
            payload: { index }
          })
        )
      }
      reads.length = 0
      expect((yield* queue.pending(runId)).map((note) => note.id)).toEqual(["first"])
      expect((yield* queue.pending(runId)).map((note) => note.id)).toEqual(["first"])
      expect(reads.map((read) => [read.after, read.entries])).toEqual([[first.seq, 0], [first.seq, 0]])
      const second = yield* queue.admit(runId, item("second", "steer", runId))
      expect(second.seq).toBe(first.seq! + 21)
      reads.length = 0
      expect((yield* queue.pending(runId)).map((note) => note.id)).toEqual(["first", "second"])
      expect(reads.map((read) => [read.after, read.entries])).toEqual([[second.seq, 0]])
      expect((yield* queue.admit(runId, item("first", "steer", runId))).seq).toBe(first.seq)
      const drain = { runId, targetLineageId: runId, boundary: "complete", wouldIdle: true }
      expect((yield* queue.drain(drain)).notifications.map((note) => note.id)).toEqual(["first", "second"])
      expect((yield* queue.drain(drain)).duplicate).toBe(true)
      expect(yield* queue.pending(runId)).toEqual([])
    }).pipe(Effect.provide(NotificationQueue.layer), Effect.provide(recording(reads)), Effect.scoped)
  )
})

it("recovers promotion identities across multiple filtered pages", async () => {
  const reads: Read[] = []
  await Effect.runPromise(
    Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue, journal = yield* Journal.Journal
      const runId = JournalEvent.RunId.make("paged-notifications")
      yield* journal.transact(Effect.forEach(
        Array.from({ length: 513 }, (_, index) => index),
        (index) =>
          journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId,
              sourceId: JournalEvent.SourceId.make(`/notifications/drain/history-${index}`),
              sourceSeq: JournalEvent.SourceSeq.make(index),
              eventType: "flows/notifications/Promoted",
              payload: { targetLineageId: runId, boundary: `past-${index}`, ids: [] }
            })
          ),
        { discard: true }
      ))
      expect(yield* queue.pending(runId)).toEqual([])
      expect(reads.map((read) => read.entries)).toEqual([512, 1])
      expect((yield* queue.drain({ runId, targetLineageId: runId, boundary: "past-512", wouldIdle: true })).duplicate)
        .toBe(true)
    }).pipe(Effect.provide(NotificationQueue.layerWith()), Effect.provide(recording(reads)), Effect.scoped)
  )
})

it.each(
  (["legacy-admission", "promotion"] as const).flatMap((kind) =>
    (["missing", "malformed", "other-kind"] as const).map((response) => ({ kind, response }))
  )
)("refuses an unreadable saved $kind ($response)", async ({ kind, response }) => {
  let hideExact = false
  const journal = Layer.effect(
    Journal.Journal,
    Effect.map(Journal.Journal, (underlying) =>
      Journal.make({
        ...underlying,
        entries: (options) =>
          underlying.entries(options).pipe(Effect.map((page) => {
            if (!hideExact || options.limit !== 1) return page
            if (response === "missing") return { entries: [], hasMore: false }
            return {
              ...page,
              entries: page.entries.map((entry) =>
                new JournalEvent.Entry({
                  ...entry,
                  eventType: kind === "legacy-admission"
                    ? "flows/notifications/Promoted"
                    : "flows/notifications/Admitted",
                  payload: response === "malformed" ? {} : kind === "legacy-admission"
                    ? { boundary: "other", targetLineageId: "run/root", ids: [] }
                    : { notification: item("other", "steer"), decision: "admitted" }
                })
              )
            }
          }))
      }))
  ).pipe(Layer.provide(TestJournal.layer()))
  await Effect.runPromise(
    Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue, log = yield* Journal.Journal
      const notification = item("legacy", "steer"), runId = JournalEvent.RunId.make("unreadable")
      yield* log.emitDurableUnfenced(
        new JournalEvent.Input({
          runId,
          sourceId: JournalEvent.SourceId.make("/notifications/admission/legacy"),
          eventType: "flows/notifications/Admitted",
          payload: { notification, decision: "admitted" }
        })
      )
      expect((yield* queue.pending(runId)).map((note) => note.id)).toEqual(["legacy"])
      const boundary = { runId, targetLineageId: notification.targetLineageId, boundary: "saved", wouldIdle: true }
      if (kind === "promotion") yield* queue.drain(boundary)
      hideExact = true
      const refused = yield* (kind === "legacy-admission"
        ? queue.admit(runId, notification).pipe(Effect.flip)
        : queue.drain(boundary).pipe(Effect.flip))
      expect(refused.code).toBe("notification_unavailable")
      expect(refused.message).toContain("no longer readable")
    }).pipe(Effect.provide(NotificationQueue.layerWith()), Effect.provide(journal), Effect.scoped)
  )
})

it("ignores malformed historical payloads without losing later valid notifications", async () => {
  await run(Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue, journal = yield* Journal.Journal
    for (const eventType of ["flows/notifications/Admitted", "flows/notifications/Promoted"]) {
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make("malformed-history"),
          sourceId: JournalEvent.SourceId.make("historical"),
          eventType,
          payload: {}
        })
      )
    }
    expect(yield* queue.pending("malformed-history")).toEqual([])
    yield* queue.admit("malformed-history", item("valid", "steer"))
    expect((yield* queue.pending("malformed-history")).map((note) => note.id)).toEqual(["valid"])
  }))
})

it("replays an acknowledged duplicate promotion from its committed identity", async () => {
  const journal = Layer.effect(
    Journal.Journal,
    Effect.map(Journal.Journal, (underlying) =>
      Journal.make({
        ...underlying,
        emitDurableUnfenced: (input) =>
          Effect.map(underlying.emitDurableUnfenced(input), (receipt) =>
            input.eventType === "flows/notifications/Promoted"
              ? {
                _tag: "Duplicate" as const,
                seq: receipt.seq,
                sourceSeq: receipt.sourceSeq,
                status: "committed" as const
              }
              : receipt)
      }))
  ).pipe(Layer.provide(TestJournal.layer()))
  await Effect.runPromise(
    Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      yield* queue.admit("duplicate-ack", item("delivered", "steer"))
      const receipt = yield* queue.drain({
        runId: "duplicate-ack",
        targetLineageId: "run/root",
        boundary: "same",
        wouldIdle: true
      })
      expect(receipt.duplicate).toBe(true)
      expect(receipt.notifications.map((note) => note.id)).toEqual(["delivered"])
      expect(yield* queue.pending("duplicate-ack")).toEqual([])
    }).pipe(Effect.provide(NotificationQueue.layerWith()), Effect.provide(journal), Effect.scoped)
  )
})

/** Folds `runs` runs, then sweeps them all again and reports the second sweep. */
const sweep = (
  runs: number,
  admissions: number,
  sweeps = 1
): Promise<{ readonly reads: ReadonlyArray<Read>; readonly observed: ReadonlyArray<Notification> }> => {
  const reads: Array<Read> = []
  const ids = Array.from({ length: runs }, (_, index) => `run-${index}`)
  return Effect.runPromise(
    Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      yield* Effect.forEach(ids, (id) =>
        Effect.forEach(
          Array.from({ length: admissions }, (_, index) => index),
          (index) => queue.admit(id, item(`${id}-n-${index}`, "steer")),
          { discard: true }
        ), { discard: true })
      reads.length = 0
      yield* Effect.forEach(
        Array.from({ length: sweeps }, (_, index) => index),
        () => Effect.forEach(ids, (id) => queue.pending(id), { discard: true }),
        { discard: true }
      )
      const swept = reads.slice()
      const observed = yield* queue.pending("run-0")
      return { reads: swept, observed }
    }).pipe(
      Effect.provide(NotificationQueue.layerWith({ capacity: admissions })),
      Effect.provide(recording(reads)),
      Effect.scoped
    )
  )
}

const run = <A, E>(
  effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue | Journal.Journal>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NotificationQueue.layer),
      Effect.provide(TestJournal.layer()),
      Effect.scoped
    )
  )

/** The same stack over a queue built with a capacity the case chooses. */
const runAt = <A, E>(
  capacity: number,
  effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue | Journal.Journal>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NotificationQueue.layerWith({ capacity })),
      Effect.provide(TestJournal.layer()),
      Effect.scoped
    )
  )

/** Narrows the queue's own failure out of the union its methods can fail with. */
const refusal = (
  error: Journal.JournalError | NotificationQueue.NotificationError
): NotificationQueue.NotificationError => {
  expect(error._tag).toBe("/notifications/NotificationError")
  return error as NotificationQueue.NotificationError
}

/** Whatever the caller passes, so a case can hand `admit` a value no type allows. */
const untyped = (value: unknown): Notification => value as Notification

/** A record nested `depth` levels deep, for the depth bound. */
const nested = (depth: number): Record<string, unknown> => {
  let value: Record<string, unknown> = {}
  for (let level = 0; level < depth; level += 1) value = { nested: value }
  return value
}

describe("NotificationQueue", () => {
  it.each(
    [
      { enclosing: "admit", standalone: "admit" },
      { enclosing: "admit", standalone: "drain" },
      { enclosing: "drain", standalone: "admit" },
      { enclosing: "drain", standalone: "drain" }
    ] as const
  )("finishes enclosing $enclosing racing standalone $standalone", async ({ enclosing, standalone }) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const outerStarted = yield* Deferred.make<void>()
        const standaloneEntered = yield* Deferred.make<void>()
        const enterInner = yield* Deferred.make<void>()
        const queue = yield* NotificationQueue.NotificationQueue.pipe(
          Effect.provide(NotificationQueue.layer.pipe(Layer.provide(Layer.succeed(Journal.Journal, {
            ...journal,
            transact: (body) => Effect.andThen(Deferred.succeed(standaloneEntered, undefined), journal.transact(body))
          }))))
        )
        const call = (operation: "admit" | "drain", id: string) =>
          operation === "admit"
            ? queue.admit("run", item(id, "steer")).pipe(Effect.asVoid)
            : queue.drain({ runId: "run", targetLineageId: "run/root", boundary: id, wouldIdle: true }).pipe(
              Effect.asVoid
            )
        const outer = yield* Effect.forkChild(journal.transact(Effect.gen(function*() {
          yield* Deferred.succeed(outerStarted, undefined)
          yield* Deferred.await(enterInner)
          yield* call(enclosing, "outer")
        })))
        yield* Deferred.await(outerStarted)
        const other = yield* Effect.forkChild(call(standalone, "standalone"))
        // The standalone call has reached transact while the outer transaction
        // owns SQLite. Only now may the outer transaction call into the queue.
        yield* Deferred.await(standaloneEntered)
        yield* Deferred.succeed(enterInner, undefined)
        yield* Fiber.join(outer)
        yield* Fiber.join(other)
        const rows = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
        expect(rows.entries).toHaveLength(2)
        const fresh = yield* NotificationQueue.NotificationQueue.pipe(Effect.provide(NotificationQueue.layerWith()))
        expect(yield* queue.pending("run")).toEqual(yield* fresh.pending("run"))
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped, Effect.timeout("5 seconds"))
    )
  })

  it("delivers an eligible steer before queued follow-ups at idle boundaries", async () => {
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      yield* queue.admit("run", item("steer", "steer"))
      yield* queue.admit("run", item("followup-1", "queue"))
      yield* queue.admit("run", item("followup-2", "queue"))
      for (const [index, id] of ["steer", "followup-1", "followup-2"].entries()) {
        const receipt = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: `turn-${index}`,
          wouldIdle: true
        })
        expect(receipt.notifications.map(({ id }) => id)).toEqual([id])
        expect((yield* queue.pending("run")).map(({ id }) => id)).toEqual(
          ["steer", "followup-1", "followup-2"].slice(index + 1)
        )
      }
    }))
  })

  it.each(["above cutoff", "another lineage"])("does not let a steer %s block an idle follow-up", async (reason) => {
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const opened = yield* queue.admit("run", item("followup", "queue"))
      yield* queue.admit("run", item("steer", "steer", reason === "another lineage" ? "run/child" : "run/root"))
      const receipt = yield* queue.drain({
        runId: "run",
        targetLineageId: "run/root",
        boundary: "turn",
        wouldIdle: true,
        ...(reason === "above cutoff" ? { cutoffSeq: opened.seq } : {})
      })
      expect(receipt.notifications.map(({ id }) => id)).toEqual(["followup"])
      expect((yield* queue.pending("run")).map(({ id }) => id)).toEqual(["steer"])
    }))
  })

  it("durably admits an id exactly once with provenance intact", async () => {
    const notification = item("n-1", "steer")
    const result = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const first = yield* queue.admit("run", notification)
        const retry = yield* queue.admit("run", notification)
        return { first, retry }
      })
    )

    expect(result.first).toMatchObject({ decision: "admitted", duplicate: false })
    expect(result.retry).toMatchObject({
      decision: "admitted",
      duplicate: true,
      seq: result.first.seq
    })
  })

  it("rejects reuse of a stable id for different content", async () => {
    const error = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("same", "steer", "run/root", "first"))
        return yield* queue.admit("run", item("same", "steer", "run/root", "second")).pipe(Effect.flip)
      })
    )

    // The queue's own comparison decided this, so it raises the queue's own
    // error rather than borrowing the storage layer's `idempotency_conflict`.
    expect(error.code).toBe("notification_id_reused")
    expect(error).toMatchObject({ notificationId: "same" })
    expect(error.message).not.toContain("first")
    expect(error.message).not.toContain("second")
  })

  it.each([
    { token: "synthetic-test-value" },
    { body: "Bearer synthetic-test-value" }
  ])("deduplicates original content after default journal redaction: %j", async (payload) => {
    const notification = { ...item("redacted", "steer"), payload } satisfies Notification
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const journal = yield* Journal.Journal
      const first = yield* queue.admit("run", notification)
      const pending = yield* queue.pending("run")
      expect(pending[0]?.payload).not.toEqual(payload)
      const retry = yield* queue.admit("run", notification)
      expect(retry).toEqual({ ...first, duplicate: true })
      const replay = yield* NotificationQueue.NotificationQueue.pipe(
        Effect.provide(NotificationQueue.layerWith())
      )
      expect(yield* replay.admit("run", notification)).toEqual(retry)
      const changed = { ...notification, payload: { ...payload, extra: true } }
      expect((yield* replay.admit("run", changed).pipe(Effect.flip)).code).toBe("notification_id_reused")
      // Even two inputs that redact to the same payload must remain distinct.
      const changedSecret = {
        ...notification,
        payload: "token" in payload
          ? { token: "different-synthetic-value" }
          : { body: "Bearer different-synthetic-value" }
      }
      expect((yield* queue.admit("run", changedSecret).pipe(Effect.flip)).code).toBe("notification_id_reused")
      const rows = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
      expect(rows.entries).toHaveLength(1)
      expect(JSON.stringify(rows.entries[0]?.payload)).not.toContain("synthetic-test-value")
    }))
  })

  it.each(["pending", "drain"] as const)("protects cached notifications exposed by %s", async (output) => {
    const notification = {
      ...item("immutable", "steer"),
      payload: { nested: { body: "original" }, tools: ["read"] }
    } satisfies Notification
    const boundary = { runId: "run", targetLineageId: "run/root", boundary: "turn", wouldIdle: false }
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const journal = yield* Journal.Journal
      yield* queue.admit("run", notification)
      const returned = output === "pending"
        ? yield* queue.pending("run")
        : (yield* queue.drain(boundary)).notifications
      // Schema.Json is deeply readonly. Reflect simulates an untyped consumer.
      const exposed = returned[0]!
      const payload = exposed.payload as typeof notification.payload
      Reflect.set(payload.nested, "body", "edited by reader")
      Reflect.set(payload.tools, "0", "write")
      Reflect.set(exposed.provenance, "sourceActor", "edited by reader")
      Reflect.set(exposed, "targetLineageId", "elsewhere")
      const live = yield* queue.drain(boundary)
      const repeated = yield* queue.drain(boundary)
      const replay = yield* NotificationQueue.NotificationQueue.pipe(
        Effect.provide(NotificationQueue.layerWith())
      )
      const fresh = yield* replay.drain(boundary)
      const rows = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
      expect(rows.entries[0]?.payload).toMatchObject({ notification })
      expect(live.notifications).toEqual([notification])
      expect(repeated.notifications).toEqual(fresh.notifications)
      expect(fresh.notifications).toEqual([notification])
      expect((yield* queue.admit("run", notification)).duplicate).toBe(true)
    }))
  })

  it("compares legacy admissions without fingerprints against persisted content", async () => {
    await run(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const queue = yield* NotificationQueue.NotificationQueue
      const notification = item("legacy", "steer")
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make("run"),
          sourceId: JournalEvent.SourceId.make("/notifications/admission/legacy"),
          sourceSeq: JournalEvent.SourceSeq.make(0),
          eventType: "flows/notifications/Admitted",
          payload: { notification, decision: "admitted" }
        })
      )
      expect((yield* queue.admit("run", notification)).duplicate).toBe(true)
      expect((yield* queue.admit("run", { ...notification, payload: null }).pipe(Effect.flip)).code)
        .toBe("notification_id_reused")
    }))
  })

  it("serializes concurrent admissions at the durable capacity", async () => {
    const result = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const receipts = yield* Effect.all(
        Array.from({ length: 129 }, (_, index) => queue.admit("run", item(`n-${index}`, "steer"))),
        { concurrency: "unbounded" }
      )
      const drained = yield* queue.drain({
        runId: "run",
        targetLineageId: "run/root",
        boundary: "turn",
        wouldIdle: false
      })
      return { receipts, drained }
    }))

    expect(result.receipts.filter((receipt) => receipt.decision === "admitted")).toHaveLength(128)
    expect(result.receipts.filter((receipt) => receipt.decision === "rejected-full")).toHaveLength(1)
    expect(result.drained.notifications).toHaveLength(128)
  })

  it("targets lineage, batches steers, and promotes one queued follow-up only at idle", async () => {
    const result = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("root-steer", "steer"))
        yield* queue.admit("run", item("child-steer", "steer", "run/root/child"))
        yield* queue.admit("run", item("root-queued-1", "queue"))
        yield* queue.admit("run", item("root-queued-2", "queue"))

        const active = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "root/turn-1",
          wouldIdle: false
        })
        const child = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root/child",
          boundary: "child/turn-1",
          wouldIdle: false
        })
        const idle = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "root/turn-2",
          wouldIdle: true
        })
        const retry = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "root/turn-2",
          wouldIdle: true
        })
        return { active, child, idle, retry }
      })
    )

    expect(result.active.notifications.map(({ id }) => id)).toEqual(["root-steer"])
    expect(result.child.notifications.map(({ id }) => id)).toEqual(["child-steer"])
    expect(result.idle.notifications.map(({ id }) => id)).toEqual(["root-queued-1"])
    expect(result.retry.notifications.map(({ id }) => id)).toEqual(["root-queued-1"])
    expect(result.retry.duplicate).toBe(true)
  })

  it("provides a typed unavailable noop", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const admit = yield* queue.admit("run", item("noop", "steer")).pipe(Effect.flip)
        const drain = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn",
          wouldIdle: false
        }).pipe(Effect.flip)
        const pending = yield* queue.pending("run").pipe(Effect.flip)
        return [admit, drain, pending]
      }).pipe(Effect.provide(NotificationQueue.layerNoop()))
    )
    expect(errors.map((error) => error.code)).toEqual([
      "notification_unavailable",
      "notification_unavailable",
      "notification_unavailable"
    ])
  })

  it("pages through foreign journal history and refuses missing promoted ids", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const queue = yield* NotificationQueue.NotificationQueue
        yield* Effect.forEach(
          Array.from({ length: 513 }, (_, index) => index),
          (index) =>
            journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make("run"),
                sourceId: JournalEvent.SourceId.make("foreign"),
                sourceSeq: JournalEvent.SourceSeq.make(index),
                eventType: "foreign",
                payload: { index }
              })
            ),
          { discard: true }
        )
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("run"),
            sourceId: JournalEvent.SourceId.make("/notifications/drain/run%2Froot/missing"),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: "flows/notifications/Promoted",
            payload: {
              boundary: "missing",
              targetLineageId: "run/root",
              ids: ["not-admitted"]
            }
          })
        )
        yield* journal.flush
        const missing = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "missing",
          wouldIdle: false
        }).pipe(Effect.flip)
        const arrayPayload = {
          ...item("array", "queue"),
          payload: [1, null, { keep: true }]
        } satisfies Notification
        const admission = yield* queue.admit("run", arrayPayload)
        const duplicate = yield* queue.admit("run", arrayPayload)
        const empty = yield* queue.drain({
          runId: "empty",
          targetLineageId: "empty/root",
          boundary: "empty/turn-1",
          wouldIdle: false
        })
        return { missing, admission, duplicate, empty }
      }).pipe(
        Effect.provide(NotificationQueue.layer),
        Effect.provide(TestJournal.layer()),
        Effect.scoped
      )
    )

    expect(result.missing).toMatchObject({ code: "notification_unavailable", notificationId: "not-admitted" })
    expect(result.admission.decision).toBe("admitted")
    expect(result.duplicate.duplicate).toBe(true)
    expect(result.empty.notifications).toEqual([])
  })

  it("reports what is still pending, and drops what a boundary took", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("steer-1", "steer"))
        yield* queue.admit("run", item("steer-2", "steer"))
        yield* queue.admit("run", item("followup-1", "queue"))
        const before = yield* queue.pending("run")
        yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false
        })
        return { before, after: yield* queue.pending("run") }
      })
    )

    // A steer notification is pending until a boundary promotes it, and a
    // queued follow-up stays pending until the run would otherwise idle.
    expect(observed.before.map((notification) => notification.id)).toEqual([
      "steer-1",
      "steer-2",
      "followup-1"
    ])
    expect(observed.after.map((notification) => notification.id)).toEqual(["followup-1"])
  })

  it("reports nothing pending for a run that was never notified", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        return yield* queue.pending("never-notified")
      })
    )

    expect(observed).toEqual([])
  })

  it("admits a notification the full queue refused, once a boundary has drained", async () => {
    const observed = await runAt(
      1,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const journal = yield* Journal.Journal
        yield* queue.admit("run", item("first", "steer"))
        const refused = yield* queue.admit("run", item("second", "steer"))
        // A refusal that had been journaled as an admission would match on
        // every later attempt and burn the id for the life of the run.
        const admissions = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 }).pipe(
          Effect.map((page) => page.entries.filter((entry) => entry.eventType === "flows/notifications/Admitted"))
        )
        yield* queue.drain({ runId: "run", targetLineageId: "run/root", boundary: "turn-1", wouldIdle: false })
        const retried = yield* queue.admit("run", item("second", "steer"))
        return { refused, admissions: admissions.length, retried, pending: yield* queue.pending("run") }
      })
    )

    expect(observed.refused).toEqual({
      notificationId: "second",
      decision: "rejected-full",
      seq: undefined,
      duplicate: false
    })
    expect(observed.admissions).toBe(1)
    expect(observed.retried).toMatchObject({ decision: "admitted", duplicate: false })
    expect(observed.pending.map(({ id }) => id)).toEqual(["second"])
  })

  it("keeps two lineages that close the same boundary name apart", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("root-steer", "steer", "run/root"))
        yield* queue.admit("run", item("child-steer", "steer", "run/root/child"))
        // ONE boundary name, two lineages. A drain identity keyed on the
        // boundary alone makes the second drain a repeat of the first, and the
        // child's steer stays pending forever.
        const root = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false
        })
        const child = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root/child",
          boundary: "turn-1",
          wouldIdle: false
        })
        return { root, child, pending: yield* queue.pending("run") }
      })
    )

    expect(observed.root.notifications.map(({ id }) => id)).toEqual(["root-steer"])
    expect(observed.root.duplicate).toBe(false)
    expect(observed.child.notifications.map(({ id }) => id)).toEqual(["child-steer"])
    expect(observed.child.duplicate).toBe(false)
    expect(observed.pending).toEqual([])
  })

  it("cannot let a lineage forge another pair's drain identity through a slash", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("a", "steer", "one/two"))
        yield* queue.admit("run", item("b", "steer", "one"))
        const first = yield* queue.drain({
          runId: "run",
          targetLineageId: "one/two",
          boundary: "three",
          wouldIdle: false
        })
        const second = yield* queue.drain({
          runId: "run",
          targetLineageId: "one",
          boundary: "two/three",
          wouldIdle: false
        })
        return { first, second }
      })
    )

    expect(observed.first.notifications.map(({ id }) => id)).toEqual(["a"])
    expect(observed.second.notifications.map(({ id }) => id)).toEqual(["b"])
    expect(observed.second.duplicate).toBe(false)
  })

  it("holds a steer admitted after the turn opened until the next boundary", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const opened = yield* queue.admit("run", item("before", "steer"))
        yield* queue.admit("run", item("after", "steer"))
        // The turn opened at the sequence the first steer committed at, so the
        // steer that arrived while the model was already reading is held.
        const closing = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false,
          cutoffSeq: opened.seq
        })
        const next = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-2",
          wouldIdle: false
        })
        return { closing, next }
      })
    )

    expect(observed.closing.notifications.map(({ id }) => id)).toEqual(["before"])
    expect(observed.next.notifications.map(({ id }) => id)).toEqual(["after"])
  })

  it("refuses a value that is not a notification instead of acknowledging it", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const journal = yield* Journal.Journal
        // Acknowledged at a real sequence and then skipped by `fromEntry` on
        // every replay is the worst failure a durable queue has.
        const error = yield* queue.admit("run", untyped({ id: "bad" })).pipe(Effect.flip)
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
        return { error, entries: entries.entries.length }
      })
    )

    const error = refusal(observed.error)
    expect(error.code).toBe("notification_invalid")
    expect(error.notificationId).toBe("bad")
    expect(error.path).toBeUndefined()
    // A refusal reports the shape it wanted, bounded, and never the value.
    expect(error.message.length).toBeLessThanOrEqual(200)
    expect(error.message.endsWith("...")).toBe(true)
    expect(observed.entries).toBe(0)
  })

  it("names the field that failed and nothing about its value", async () => {
    const error = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        return yield* queue.admit(
          "run",
          untyped({ ...item("n-1", "steer"), provenance: { ...item("n-1", "steer").provenance, sourceTurn: -1 } })
        ).pipe(Effect.flip)
      })
    )

    expect(error).toMatchObject({
      code: "notification_invalid",
      notificationId: "n-1",
      path: "provenance.sourceTurn"
    })
    expect(error.message).not.toContain("-1")
  })

  it("refuses a payload that is not JSON, naming the field and not the value", async () => {
    const error = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        // `payload: Schema.Json` is a compile-time promise only, and an
        // untyped producer forwarding an external body can break it.
        return yield* queue.admit(
          "run",
          untyped({ ...item("callable", "steer"), payload: { onDone: () => undefined } })
        ).pipe(Effect.flip)
      })
    )

    expect(error).toMatchObject({
      code: "notification_invalid",
      notificationId: "callable",
      path: "payload",
      message: "InvalidType"
    })
  })

  it("refuses a value with no readable id without inventing one", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        return {
          text: yield* queue.admit("run", untyped("not a notification")).pipe(Effect.flip),
          nothing: yield* queue.admit("run", untyped(null)).pipe(Effect.flip),
          numeric: yield* queue.admit("run", untyped({ id: 7 })).pipe(Effect.flip)
        }
      })
    )

    for (const raw of [observed.text, observed.nothing, observed.numeric]) {
      const error = refusal(raw)
      expect(error.code).toBe("notification_invalid")
      expect(error.notificationId).toBeUndefined()
    }
  })

  it("refuses a payload nested past the depth bound rather than overflowing the stack", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        return {
          identified: yield* queue.admit(
            "run",
            untyped({ ...item("deep", "steer"), payload: nested(400) })
          ).pipe(Effect.flip),
          anonymous: yield* queue.admit("run", untyped(nested(400))).pipe(Effect.flip)
        }
      })
    )

    expect(observed.identified).toMatchObject({ code: "notification_invalid", notificationId: "deep" })
    expect(refusal(observed.identified).message).toContain("256")
    expect(refusal(observed.anonymous).notificationId).toBeUndefined()
  })

  it.each(["objects", "arrays"])("pins adjacent payload depth limits for %s", async (shape) => {
    const payload = (depth: number): unknown => {
      if (shape === "objects") return nested(depth)
      let value: Array<unknown> = []
      for (let level = 0; level < depth; level += 1) value = [value]
      return value
    }
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const journal = yield* Journal.Journal
      // The notification envelope puts the payload root at depth 1. These
      // leaves are therefore at depths 255 (legal) and 256 (refused).
      const receipt = yield* queue.admit("run", untyped({ ...item("legal", "steer"), payload: payload(254) }))
      expect(receipt.decision).toBe("admitted")
      const error = refusal(
        yield* queue.admit(
          "run",
          untyped({ ...item("too-deep", "steer"), payload: payload(255) })
        ).pipe(Effect.flip)
      )
      expect(error).toMatchObject({ code: "notification_invalid", notificationId: "too-deep" })
      expect(error.message).toContain("256")
      const rows = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })
      expect(rows.entries).toHaveLength(1)
      expect(rows.entries[0]?.payload).toMatchObject({ notification: { id: "legal" } })
      expect((yield* queue.pending("run")).map(({ id }) => id)).toEqual(["legal"])
    }))
  })

  it("refuses an oversized payload before fingerprinting or journaling it", async () => {
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const journal = yield* Journal.Journal
      // One wide value of each kind: a string, an array, and an object whose
      // size is in its keys. Each passes the depth bound.
      const keys: Record<string, number> = {}
      for (let index = 0; index < 70_000; index++) keys[`key-${String(index).padStart(12, "0")}`] = index
      for (
        const [id, payload] of [
          ["long-string", "x".repeat(1_048_577)],
          ["wide-array", Array.from({ length: 1_048_577 }, () => 0)],
          ["wide-keys", keys]
        ] as const
      ) {
        const error = refusal(
          yield* queue.admit("run", untyped({ ...item(id, "steer"), payload })).pipe(Effect.flip)
        )
        expect(error).toMatchObject({ code: "notification_invalid", notificationId: id })
        expect(error.message).toContain("1048576 code unit bound")
      }
      expect((yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })).entries).toEqual([])
      const receipt = yield* queue.admit("run", untyped({ ...item("large", "steer"), payload: "x".repeat(1_000_000) }))
      expect(receipt.decision).toBe("admitted")
    }))
  })

  it("refuses a cyclic payload with a typed error and no journal row", async () => {
    const cycle: Record<string, unknown> = {}
    cycle["self"] = cycle
    await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const journal = yield* Journal.Journal
      const error = refusal(
        yield* queue.admit(
          "run",
          untyped({ ...item("cycle", "steer"), payload: cycle })
        ).pipe(Effect.flip)
      )
      expect(error).toMatchObject({ code: "notification_invalid", notificationId: "cycle" })
      expect(error.message).toContain("256")
      expect((yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 512 })).entries).toEqual([])
    }))
  })

  it("treats an admission written in a different key order as the same notification", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const notification = item("ordered", "steer")
        const first = yield* queue.admit("run", notification)
        // The same content, written the other way round. A comparison over
        // `JSON.stringify` alone would call this a reused id.
        const reordered = yield* queue.admit(
          "run",
          untyped({
            payload: { body: "ordered" },
            provenance: {
              sourceActor: notification.provenance.sourceActor,
              sourceTurn: notification.provenance.sourceTurn,
              sourceLineageId: notification.provenance.sourceLineageId,
              sourceRunId: notification.provenance.sourceRunId
            },
            targetLineageId: notification.targetLineageId,
            delivery: "steer",
            id: "ordered",
            _tag: "human-steer"
          })
        )
        return { first, reordered }
      })
    )

    expect(observed.reordered).toMatchObject({ duplicate: true, decision: "admitted", seq: observed.first.seq })
  })

  it("journals a snapshot the caller cannot edit afterwards", async () => {
    const payload: Record<string, unknown> = { body: "as admitted", tools: ["read"] }
    const notification = untyped({ ...item("snapshot", "steer"), payload })
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification)
        payload["body"] = "edited after the call returned"
        ;(payload["tools"] as Array<string>).push("write")
        return yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false
        })
      })
    )

    expect(observed.notifications[0]?.payload).toEqual({ body: "as admitted", tools: ["read"] })
  })

  it("reads a duplicate's decision back from the record rather than recomputing it", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        // Two independently built queues over ONE journal: two processes.
        const first = yield* NotificationQueue.NotificationQueue.pipe(
          Effect.provide(NotificationQueue.layerWith({ capacity: 1 }))
        )
        const second = yield* NotificationQueue.NotificationQueue.pipe(
          Effect.provide(NotificationQueue.layerWith({ capacity: 1 }))
        )
        const committed = yield* first.admit("run", item("shared", "steer"))
        return { committed, echoed: yield* second.admit("run", item("shared", "steer")) }
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )

    expect(observed.echoed).toEqual({
      notificationId: "shared",
      decision: observed.committed.decision,
      seq: observed.committed.seq,
      duplicate: true
    })
  })

  it("refuses to invent an admission when another writer holds the identity", async () => {
    const error = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const queue = yield* NotificationQueue.NotificationQueue
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("run"),
            sourceId: JournalEvent.SourceId.make("/notifications/admission/squatted"),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: "foreign",
            payload: { squatter: true }
          })
        )
        yield* journal.flush
        return yield* queue.admit("run", item("squatted", "steer")).pipe(Effect.flip)
      })
    )

    expect(error).toMatchObject({ code: "notification_id_reused", notificationId: "squatted" })
  })

  it("refuses to invent a delivery when another writer holds the drain identity", async () => {
    const error = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const queue = yield* NotificationQueue.NotificationQueue
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("run"),
            sourceId: JournalEvent.SourceId.make("/notifications/drain/run%2Froot/turn-1"),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: "foreign",
            payload: { squatter: true }
          })
        )
        yield* journal.flush
        return yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false
        }).pipe(Effect.flip)
      })
    )

    expect(error.code).toBe("notification_unavailable")
  })

  it("pages only the entries committed since the previous fold", async () => {
    const reads = { pages: 0, entries: 0 }
    const counting = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (journal) =>
        Journal.Journal.of({
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap((page) =>
              Effect.sync(() => {
                reads.pages += 1
                reads.entries += page.entries.length
              })
            ))
        }))
    ).pipe(Layer.provide(TestJournal.layer()))

    const admissions = 60
    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* Effect.forEach(
          Array.from({ length: admissions }, (_, index) => index),
          (index) => queue.admit("run", item(`n-${index}`, "steer")),
          { discard: true }
        )
        yield* queue.pending("run")
      }).pipe(
        Effect.provide(NotificationQueue.layerWith({ capacity: admissions })),
        Effect.provide(counting),
        Effect.scoped
      )
    )

    // A fold that re-read the whole run on every call costs entries quadratic
    // in the admissions: 60 admissions read at least 1,800 entries twice over.
    // Paging from the cursor costs each entry a bounded number of reads.
    expect(reads.entries).toBeLessThan(4 * admissions)
    expect(reads.pages).toBeGreaterThan(0)
  })

  it("forgets the least recently folded run rather than growing without bound", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        // One more run than the fold retains, so the first is evicted and has
        // to be folded again from the beginning.
        yield* Effect.forEach(
          Array.from({ length: 65 }, (_, index) => index),
          (index) => queue.admit(`run-${index}`, item(`n-${index}`, "steer")),
          { discard: true }
        )
        return yield* queue.pending("run-0")
      })
    )

    expect(observed.map(({ id }) => id)).toEqual(["n-0"])
  })
  it("pages every fold from its cursor when the sweep fits what the cache holds", async () => {
    const { observed, reads } = await sweep(64, 1)

    expect(reads).toHaveLength(64)
    expect(reads.filter((read) => read.after === undefined)).toEqual([])
    expect(observed.map(({ id }) => id)).toEqual(["run-0-n-0"])
  })

  it("evicts a fold at one run past the bound without replaying every other journal", async () => {
    const { observed, reads } = await sweep(65, 1)
    const refolded = reads.filter((read) => read.after === undefined).map((read) => read.runId)

    // Eviction happened: a cache that retained all 65 folds would page every
    // one of them from its cursor, which is what the count assertions this
    // replaces could not tell apart.
    expect(refolded.length).toBeGreaterThan(0)
    // ...and it cost a fixed handful of refolds, not the whole sweep. Evicting
    // the least recently folded run instead evicts the run the next read wants,
    // so all 65 would page from sequence zero on every sweep.
    expect(refolded.length).toBeLessThanOrEqual(2)
    expect(refolded).not.toContain("run-0")
    expect(observed.map(({ id }) => id)).toEqual(["run-0-n-0"])
  })

  it("reads journal tails when a supervisor sweeps more runs than the cache holds", async () => {
    const runs = 70
    const admissions = 12
    const { observed, reads } = await sweep(runs, admissions, 3)
    const read = reads.reduce((total, page) => total + page.entries, 0)

    // A sweep that evicted the next run on every read would replay all 70
    // journals on each of the three passes: 2,520 entries for no new events.
    expect(read).toBeLessThan(runs * admissions)
    expect(observed).toHaveLength(admissions)
  })

  it("reads a replayed drain's notifications back from the journal instead of retaining them", async () => {
    const reads: Array<Read> = []
    const boundary = { runId: "run", targetLineageId: "run/root", boundary: "turn-0", wouldIdle: false }
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item("n-0", "steer"))
        const first = yield* queue.drain(boundary)
        reads.length = 0
        const replay = yield* queue.drain(boundary)
        return { first, replay, reads: reads.slice() }
      }).pipe(
        Effect.provide(NotificationQueue.layer),
        Effect.provide(recording(reads)),
        Effect.scoped
      )
    )

    expect(observed.first.notifications.map(({ id }) => id)).toEqual(["n-0"])
    expect(observed.replay.duplicate).toBe(true)
    expect(observed.replay.notifications.map(({ id }) => id)).toEqual(["n-0"])
    expect(observed.replay.notifications[0]?.payload).toEqual({ body: "n-0" })
    // The fold holds the drain's identity and the admission's sequence, not
    // the notification: a queue that retained every admitted payload for the
    // run's lifetime would answer the replay without reading anything back.
    expect(observed.reads.filter((read) => read.limit === 1).length).toBeGreaterThanOrEqual(2)
  })

  it("keeps a capacity-one queue's reads bounded across a long history", async () => {
    const cycles = 120
    const measured = 20
    const reads: Array<Read> = []
    const cycle = (index: number) =>
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", item(`n-${index}`, "steer"))
        yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: `turn-${index}`,
          wouldIdle: false
        })
      })
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* Effect.forEach(Array.from({ length: cycles - measured }, (_, index) => index), cycle, {
          discard: true
        })
        reads.length = 0
        yield* Effect.forEach(
          Array.from({ length: measured }, (_, index) => cycles - measured + index),
          cycle,
          { discard: true }
        )
        const tail = reads.reduce((total, page) => total + page.entries, 0)
        // The very first boundary, 120 coalescing cycles later.
        const ancient = yield* queue.drain({
          runId: "run",
          targetLineageId: "run/root",
          boundary: "turn-0",
          wouldIdle: false
        })
        return { tail, ancient }
      }).pipe(
        Effect.provide(NotificationQueue.layerWith({ capacity: 1 })),
        Effect.provide(recording(reads)),
        Effect.scoped
      )
    )

    // One slot, so the pending state never grows. What a cycle reads must not
    // grow with the 100 cycles of history behind it either.
    expect(observed.tail).toBeLessThan(measured * 12)
    expect(observed.ancient.duplicate).toBe(true)
    expect(observed.ancient.notifications.map(({ id }) => id)).toEqual(["n-0"])
  })
})
