import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const item = (id: string, body: string): Notification => ({
  _tag: "human-steer",
  delivery: "steer",
  id,
  targetLineageId: "run",
  provenance: { sourceRunId: "run", sourceLineageId: "run", sourceTurn: 0, sourceActor: "human:owner" },
  payload: { body }
})
const boundary = { runId: "run", targetLineageId: "run", boundary: "turn", wouldIdle: false }
const withQueue = <A, E>(journal: Journal.Service, effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue>) =>
  effect.pipe(Effect.provide(NotificationQueue.layer.pipe(Layer.provide(Layer.succeed(Journal.Journal, journal)))))

describe("versioned steering consumption fence", () => {
  it("replaces pending input in place, survives restart, refuses stale edits and preserves consumed replay", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            yield* queue.admit("run", item("first", "original"), 1)
            yield* queue.admit("run", item("second", "later"), 1)
            expect(yield* queue.admit("run", item("first", "edited"), 2)).toMatchObject({ duplicate: false })
            expect(yield* queue.admit("run", item("first", "edited"), 2)).toMatchObject({ duplicate: true })
            yield* queue.admit("run", item("first", "original"), 1)
            expect(yield* queue.pending("run")).toEqual([item("first", "edited"), item("second", "later")])
          })
        )
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            expect(yield* queue.pending("run")).toEqual([item("first", "edited"), item("second", "later")])
            expect((yield* queue.drain(boundary)).notifications).toEqual([
              item("first", "edited"),
              item("second", "later")
            ])
            expect(yield* queue.admit("run", item("first", "too late"), 3)).toMatchObject({ consumed: true })
            expect(yield* queue.pending("run")).toEqual([])
            expect((yield* queue.drain(boundary)).notifications).toEqual([
              item("first", "edited"),
              item("second", "later")
            ])
          })
        )
        expect((yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 100 })).entries).toHaveLength(4)
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("refuses invalid versions, conflicting versions and changes to the original author", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
          expect((yield* queue.admit("run", item("first", "original"), version).pipe(Effect.exit))._tag).toBe("Failure")
        }
        expect(yield* queue.pending("run")).toEqual([])
        yield* queue.admit("run", item("first", "original"), 1)
        expect((yield* queue.admit("run", item("first", "conflict"), 1).pipe(Effect.exit))._tag).toBe("Failure")
        const forged = {
          ...item("first", "forged"),
          provenance: { ...item("first", "forged").provenance, sourceActor: "human:outsider" }
        }
        expect((yield* queue.admit("run", forged, 2).pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* queue.pending("run")).toEqual([item("first", "original")])
      }).pipe(Effect.provide(NotificationQueue.layer.pipe(Layer.provide(TestJournal.layer()))), Effect.scoped)
    )
  })

  it("rolls back an edit with its enclosing transaction", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            yield* queue.admit("run", item("first", "original"), 1)
            yield* journal.transact(Effect.gen(function*() {
              yield* queue.admit("run", item("first", "edited"), 2)
              return yield* Effect.fail(new Journal.JournalError({ code: "unknown", message: "crash before commit" }))
            })).pipe(Effect.exit)
            expect(yield* queue.pending("run")).toEqual([item("first", "original")])
            yield* queue.admit("run", item("first", "edited"), 2)
            expect((yield* queue.drain(boundary)).notifications).toEqual([item("first", "edited")])
          })
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })
})
