/**
 * The pending capacity guard under two writers on one database.
 *
 * Every other queue suite runs over one in-memory journal, where a single
 * connection makes interleavings the test's own business. These cases need
 * two real connections to one file, because the guarantee under test is the
 * one the audit asked about: a capacity decision must include a rival's
 * committed insert even when this process cached an older fold. They need a
 * real Clock for the same reason
 * `packages/smithers/flows/journal/test/JournalDurable.test.ts` names: the
 * deferred-transaction conflict retry in `@smthrs/database` backs off on the
 * wall clock.
 */
import { layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import { Context, Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const item = (id: string): Notification => ({
  _tag: "human-steer",
  id,
  targetLineageId: "run/root",
  delivery: "steer",
  provenance: {
    sourceRunId: "operator",
    sourceLineageId: "operator/root",
    sourceTurn: 3,
    sourceActor: "human:will"
  },
  payload: { body: id }
})

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "notifications-queue-"))),
    (directory) => body(join(directory, "journal.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
  )

/**
 * A queue with its own connection to `filename`.
 */
const hostOn = (filename: string, capacity: number) => {
  const journalLayer = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
    Layer.provide(migrated(filename))
  )
  return Effect.map(
    Layer.build(NotificationQueue.layerWith({ capacity }).pipe(Layer.provideMerge(journalLayer))),
    (context) => ({
      queue: Context.get(context, NotificationQueue.NotificationQueue),
      journal: Context.get(context, Journal.Journal)
    })
  )
}

const admitted = (receipts: ReadonlyArray<NotificationQueue.AdmissionReceipt>) =>
  receipts.filter((receipt) => receipt.decision === "admitted")

describe("NotificationQueue capacity across two connections", () => {
  it("serializes edits against turn-boundary consumption across independent connections", async () => {
    await Effect.runPromise(withTempFile((filename) =>
      Effect.scoped(Effect.gen(function*() {
        yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
        const left = yield* hostOn(filename, 1)
        const right = yield* hostOn(filename, 1)
        yield* left.queue.admit("run", item("first"), 1)
        const edited = { ...item("first"), payload: { body: "edited" } }
        const boundary = { runId: "run", targetLineageId: "run/root", boundary: "turn", wouldIdle: false }
        const [edit, drain] = yield* Effect.all([
          left.queue.admit("run", edited, 2),
          right.queue.drain(boundary)
        ], { concurrency: 2 })
        expect(drain.notifications).toEqual([edit.consumed ? item("first") : edited])
        expect(yield* left.queue.pending("run")).toEqual([])
        expect((yield* left.queue.drain(boundary)).notifications).toEqual(drain.notifications)
        expect(yield* right.queue.admit("run", { ...edited, payload: { body: "too late" } }, 3)).toMatchObject({
          consumed: true
        })
        expect((yield* right.queue.drain(boundary)).notifications).toEqual(drain.notifications)
      }))
    ))
  }, 60_000)

  it("admits at most the capacity however many writers race a full queue", async () => {
    const observed = await Effect.runPromise(
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            // Migrate once so both writers open an already-provisioned file.
            yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
            const left = yield* hostOn(filename, 1)
            const right = yield* hostOn(filename, 1)
            const admit = (queue: NotificationQueue.Service, side: string) =>
              Effect.forEach(
                Array.from({ length: 16 }, (_, index) => `${side}-${index}`),
                (id) => queue.admit("run", item(id)),
                { concurrency: "unbounded" }
              )
            const receipts = yield* Effect.all(
              [admit(left.queue, "left"), admit(right.queue, "right")],
              { concurrency: 2 }
            )
            return { receipts: receipts.flat(), pending: yield* left.queue.pending("run") }
          })
        )
      )
    )

    // The process-local semaphore each queue holds cannot see the other
    // writer, so anything short of a storage-layer conditional lets both
    // sides read 0 pending of 1 and commit: 2 admissions from a queue with
    // room for 1.
    expect(admitted(observed.receipts)).toHaveLength(1)
    expect(
      observed.receipts.filter((receipt) => receipt.decision === "rejected-full")
    ).toHaveLength(observed.receipts.length - 1)
    expect(observed.pending).toHaveLength(1)
  }, 60_000)

  it("refuses an admission decided from a fold loaded before a rival's insert committed", async () => {
    const observed = await Effect.runPromise(
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* Effect.scoped(Effect.provide(Effect.void, migrated(filename)))
            const rival = yield* hostOn(filename, 2)
            const host = yield* hostOn(filename, 2)
            // The rival's first admission commits, and this host folds it:
            // its cached fold now says 1 pending of 2.
            expect((yield* rival.queue.admit("run", item("first"))).decision).toBe("admitted")
            expect(yield* host.queue.pending("run")).toHaveLength(1)
            // The rival's second admission commits AFTER that fold was
            // loaded, filling the queue behind this host's back.
            expect((yield* rival.queue.admit("run", item("second"))).decision).toBe("admitted")
            // A decision taken from this host's loaded fold would admit a
            // third notification into a queue with room for 2. The
            // conditional write re-reads inside the serialized write
            // transaction and refuses instead.
            const receipt = yield* host.queue.admit("run", item("late"))
            const entries = yield* rival.journal.entries({
              runId: JournalEvent.RunId.make("run"),
              limit: 512
            })
            return { receipt, entries: entries.entries, pending: yield* rival.queue.pending("run") }
          })
        )
      )
    )

    // The cached fold said 1 pending of 2. The transaction pages the rival's
    // commit before deciding, so it refuses rather than committing a third
    // admission.
    expect(observed.receipt).toEqual({
      notificationId: "late",
      decision: "rejected-full",
      seq: undefined,
      duplicate: false
    })
    expect(
      observed.entries.filter((entry) => entry.eventType === "flows/notifications/Admitted").map((entry) =>
        (entry.payload as { notification: Notification }).notification.id
      )
    ).toEqual(["first", "second"])
    expect(observed.pending.map((notification) => notification.id)).toEqual(["first", "second"])
  }, 60_000)
})
