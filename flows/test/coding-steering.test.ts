import { NodeCrypto } from "@effect/platform-node"
import * as Control from "@smthrs/control/Control"
import { RunNotFound } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as Notifications from "../../packages/smithers/agent/harness/src/Notifications.ts"
import * as DurableWriter from "../../packages/smithers/flows/database/src/DurableWriter.ts"
import * as Journal from "../../packages/smithers/flows/journal/src/Journal.ts"
import * as JournalEvent from "../../packages/smithers/flows/journal/src/JournalEvent.ts"
import * as Migrations from "../../packages/smithers/flows/journal/src/Migrations.ts"
import * as SqlJournal from "../../packages/smithers/flows/journal/src/SqlJournal.ts"
import type { Notification } from "../../packages/smithers/notifications/src/Notification.ts"
import * as NotificationEvent from "../../packages/smithers/notifications/src/NotificationEvent.ts"
import * as NotificationQueue from "../../packages/smithers/notifications/src/NotificationQueue.ts"
import * as LocalControl from "../../packages/smithers/src/internal/LocalControl.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import {
  appendFeedback,
  feedbackBoundary,
  feedbackLayer,
  FeedbackReceipt,
  ReceiveFeedback,
  routeMessages
} from "../coding/steering.ts"

const controlLayer = ControlRuntime.layerMemory({
  flows: ["coding/request", "todo", "other"].map((flowId) => ({
    flowId,
    description: "Steering fixture",
    deployClass: false,
    executionDigest: "sha256:fixture",
    envelope: { capabilities: [], flows: [], budget: {} }
  }))
}).pipe(Layer.provide(NodeCrypto.layer))

const launch = (control: ControlRuntime.Service, flowId = "coding/request") =>
  Effect.gen(function*() {
    const { card } = yield* control.plan({ flowId, input: {} })
    const token = yield* control.lookupApproval(card.approval.target)
    const principal = yield* control.stampPrincipal()
    yield* control.resolveApproval(token, "approved", principal)
    const result = yield* control.launch(card.planId, card.digest, card.envelope)
    if (result._tag !== "Started") return yield* Effect.die("expected approved fixture")
    return result.run
  })
const message = (
  id: string,
  runId: string,
  payload: Notification["payload"] = { kind: "Message", body: id }
): Notification => ({
  _tag: "human-steer",
  id,
  delivery: "steer",
  targetLineageId: runId,
  // This is attribution, not an authenticated role claim. Message routing
  // must not infer human authority from its spelling.
  provenance: { sourceRunId: runId, sourceLineageId: runId, sourceTurn: 0, sourceActor: "automation:fixture" },
  payload
})

const journalLayer = async (filename: string) => {
  const database = "Bun" in globalThis
    ? await import("../../packages/smithers/flows/database/src/bun/BunDatabase.ts")
    : await import("../../packages/smithers/flows/database/src/node/NodeDatabase.ts")
  const db = DurableWriter.layer().pipe(Layer.provideMerge(database.layer({ filename })))
  return SqlJournal.layer({ capacity: 128, overflow: "reject" }).pipe(
    Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(db)))
  )
}

test("messages use coordinator receipts while settings, other roots and explicit lineages retain native delivery", {
  timeout: 60_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journal = await journalLayer(join(root, "control.db"))
  const host = ManagedRuntime.make(
    Layer.mergeAll(controlLayer, NotificationQueue.layer.pipe(Layer.provideMerge(journal)))
  )
  t.after(() => host.dispose())
  const captured = await host.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    const native = yield* NotificationQueue.NotificationQueue
    const queue = routeMessages(native, control, yield* Journal.Journal)
    const owner = yield* launch(control), other = yield* launch(control, "other")
    const note = message("prototype-feedback", owner.runId, { body: "Keep the retained prototype's compact layout." })
    const admitted = yield* queue.admit(owner.runId, note)
    assert.equal(admitted.duplicate, false)
    assert.equal((yield* queue.admit(owner.runId, note)).duplicate, true)
    for (
      const [id, payload] of [["seat", { kind: "Seat", seat: "configured:model" }], ["thinking", {
        kind: "Thinking",
        thinking: "high"
      }], ["tools", { kind: "Tools", toolNames: ["read"] }]] as const
    ) {
      yield* queue.admit(owner.runId, message(id, owner.runId, payload))
    }
    yield* queue.admit(other.runId, message("other-message", other.runId))
    yield* queue.admit(owner.runId, message("leaf-message", "explicit-native-leaf"))
    const source = yield* Notifications.make({ runId: owner.runId, lineageId: owner.runId }).pipe(
      Effect.provideService(NotificationQueue.NotificationQueue, queue)
    )
    const drained = yield* source.drain({ boundary: "model-close", wouldIdle: true })
    assert.deepEqual(drained.seatChanges.map((change) => change._tag), ["SeatChange", "ThinkingChange"])
    assert.equal(drained.inserts.length, 1) // existing unsupported-Tools explanation
    assert.equal(JSON.stringify(drained).includes("compact layout"), false)
    assert.deepEqual(
      (yield* native.drain({ runId: other.runId, targetLineageId: other.runId, boundary: "other", wouldIdle: true }))
        .notifications.map((n) => n.id),
      ["other-message"]
    )
    assert.deepEqual(
      (yield* native.drain({
        runId: owner.runId,
        targetLineageId: "explicit-native-leaf",
        boundary: "leaf",
        wouldIdle: true
      })).notifications.map((n) => n.id),
      ["leaf-message"]
    )
    const pending = yield* queue.pending(owner.runId)
    assert.equal(pending.length, 1)
    assert.notEqual(pending[0]!.targetLineageId, owner.runId)
    assert.deepEqual(pending[0]!.provenance, note.provenance)
    return { runId: owner.runId, notification: pending[0]!, control }
  }))
  // Close the real SQLite services. A fresh queue must recover the same
  // committed admission and the same boundary receipt, including an empty one.
  await host.dispose()
  const reopened = ManagedRuntime.make(
    NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(join(root, "control.db"))))
  )
  t.after(() => reopened.dispose())
  await reopened.runPromise(Effect.gen(function*() {
    const queue = routeMessages(yield* NotificationQueue.NotificationQueue, captured.control, yield* Journal.Journal)
    const input = {
      runId: captured.runId,
      targetLineageId: captured.notification.targetLineageId,
      boundary: feedbackBoundary("coordinator", { boundary: "after-poc", revision: 0 }),
      wouldIdle: true
    }
    const first = yield* queue.drain(input)
    assert.deepEqual(first.notifications, [captured.notification])
    assert.equal(first.duplicate, false)
    yield* queue.admit(captured.runId, message("later-feedback", captured.runId))
    const replay = yield* queue.drain(input)
    assert.equal(replay.duplicate, true)
    assert.deepEqual(replay.notifications, first.notifications)
    assert.deepEqual((yield* queue.pending(captured.runId)).map((n) => n.id), ["later-feedback"])
    const next = yield* queue.drain({
      ...input,
      boundary: feedbackBoundary("coordinator", { boundary: "before-implementation", revision: 1 })
    })
    assert.deepEqual(next.notifications.map((n) => n.id), ["later-feedback"])
    const final = { ...input, boundary: feedbackBoundary("coordinator", { boundary: "after-correction", revision: 1 }) }
    assert.equal((yield* queue.drain(final)).notifications.length, 0)
    const closed = yield* queue.admit(captured.runId, message("after-final-boundary", captured.runId)).pipe(Effect.flip)
    assert.match(closed.message, /finished receiving feedback/)
    assert.equal((yield* queue.drain(final)).notifications.length, 0)
  }))
  await reopened.dispose()
  const cold = ManagedRuntime.make(
    NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(join(root, "control.db"))))
  )
  t.after(() => cold.dispose())
  await cold.runPromise(Effect.gen(function*() {
    const queue = routeMessages(yield* NotificationQueue.NotificationQueue, captured.control, yield* Journal.Journal)
    const input = {
      runId: captured.runId,
      targetLineageId: captured.notification.targetLineageId,
      boundary: feedbackBoundary("coordinator", { boundary: "after-poc", revision: 0 }),
      wouldIdle: true
    }
    assert.deepEqual((yield* queue.drain(input)).notifications, [captured.notification])
    assert.equal(
      (yield* queue.drain({
        ...input,
        boundary: feedbackBoundary("coordinator", { boundary: "after-correction", revision: 1 })
      })).duplicate,
      true
    )
    assert.deepEqual(yield* queue.pending(captured.runId), [])
    assert.equal(
      (yield* queue.admit(captured.runId, { ...captured.notification, targetLineageId: captured.runId })).duplicate,
      true
    )
    const closed = yield* queue.admit(captured.runId, message("cold-late", captured.runId)).pipe(Effect.flip)
    assert.match(closed.message, /finished receiving feedback/)
  }))
})

test("routing refuses absent, stale or unapproved coding owners and preserves the caller transaction", {
  timeout: 60_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-transaction-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = ManagedRuntime.make(
    Layer.mergeAll(
      controlLayer,
      NotificationQueue.layerWith({ capacity: 1 }).pipe(
        Layer.provideMerge(await journalLayer(join(root, "control.db")))
      )
    )
  )
  t.after(() => host.dispose())
  await host.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    const native = yield* NotificationQueue.NotificationQueue
    const journal = yield* Journal.Journal
    const owner = yield* launch(control)
    for (
      const altered of [
        { ...control, getRun: (runId: string) => Effect.fail(new RunNotFound({ runId })) },
        {
          ...control,
          getRun: (id: string) =>
            control.getRun(id).pipe(Effect.map((run) => ({ ...run, status: "completed" as const })))
        },
        {
          ...control,
          getPlan: (id: string) =>
            control.getPlan(id).pipe(Effect.map((plan) => ({ ...plan, decision: "pending" as const })))
        },
        {
          ...control,
          getPlan: (id: string) =>
            control.getPlan(id).pipe(Effect.map((plan) => ({ ...plan, card: { ...plan.card, digest: "stale" } })))
        },
        // An approved envelope that names a delegate belongs to a descriptor
        // that hands the work elsewhere, so the coordinator refuses it.
        {
          ...control,
          getPlan: (id: string) =>
            control.getPlan(id).pipe(
              Effect.map((plan) => ({
                ...plan,
                card: { ...plan.card, envelope: { ...plan.card.envelope, flows: ["coding/CommandCheck"] } }
              }))
            )
        }
      ]
    ) {
      const refused = yield* routeMessages(native, altered, journal).admit(owner.runId, message("refused", owner.runId))
        .pipe(Effect.flip)
      assert.equal(refused._tag, "/notifications/NotificationError")
    }
    assert.deepEqual(yield* native.pending(owner.runId), [])
    const queue = routeMessages(native, control, journal)
    yield* journal.transact(Effect.gen(function*() {
      yield* queue.admit(owner.runId, message("rolled-back", owner.runId))
      return yield* Effect.fail("rollback")
    })).pipe(Effect.flip)
    assert.deepEqual(yield* native.pending(owner.runId), [])
    assert.equal((yield* queue.admit(owner.runId, message("rolled-back", owner.runId))).duplicate, false)
    const full = yield* queue.admit(owner.runId, message("overflow", owner.runId)).pipe(Effect.flip)
    assert.equal(full._tag, "/notifications/NotificationError")
    assert.match(full.message, /queue is full/)
    assert.deepEqual((yield* native.pending(owner.runId)).map((n) => n.id), ["rolled-back"])
  }))
})

test(
  "independent SQLite writers serialize final feedback closure with new admissions",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coding-steering-final-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const filename = join(root, "control.db")
    const writer = ManagedRuntime.make(
      Layer.mergeAll(controlLayer, NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(filename))))
    )
    const closer = ManagedRuntime.make(NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(filename))))
    t.after(() => writer.dispose())
    t.after(() => closer.dispose())
    const control = await writer.runPromise(ControlRuntime.ControlRuntime)
    const queue = await writer.runPromise(Effect.gen(function*() {
      return routeMessages(yield* NotificationQueue.NotificationQueue, control, yield* Journal.Journal)
    }))
    const native = await closer.runPromise(NotificationQueue.NotificationQueue)
    for (let iteration = 0; iteration < 8; iteration++) {
      const owner = await writer.runPromise(launch(control))
      const targetLineageId = JSON.stringify(["coding/request", owner.runId])
      const note = message(`simultaneous-${iteration}`, owner.runId)
      const input = {
        runId: owner.runId,
        targetLineageId,
        wouldIdle: true,
        boundary: feedbackBoundary("coordinator", { boundary: "after-correction", revision: 0 })
      }
      // Neither writer has a process-local lock in common. The same database's
      // transaction must decide whether this boundary consumes the message or
      // the admission refuses; a committed message may never be left behind.
      const admission = () => writer.runPromise(queue.admit(owner.runId, note))
      const closure = () => closer.runPromise(native.drain(input))
      const [admitted, drained] = iteration % 2 === 0
        ? await Promise.allSettled([admission(), closure()])
        : await (async () => {
          const [closed, accepted] = await Promise.allSettled([closure(), admission()])
          return [accepted, closed] as const
        })()
      assert.equal(drained.status, "fulfilled")
      if (admitted.status === "fulfilled") {
        assert.deepEqual(drained.value.notifications.map((note) => note.id), [note.id])
      } else {
        assert.match(String(admitted.reason), /finished receiving feedback/)
        assert.deepEqual(drained.value.notifications, [])
      }
      assert.deepEqual(await writer.runPromise(queue.pending(owner.runId)), [])
    }
  }
)

test("only canonical native final receipts close the coordinator; malformed closure evidence refuses", {
  timeout: 60_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-proof-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = ManagedRuntime.make(
    Layer.mergeAll(
      controlLayer,
      NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(join(root, "control.db"))))
    )
  )
  t.after(() => host.dispose())
  await host.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    const native = yield* NotificationQueue.NotificationQueue
    const journal = yield* Journal.Journal
    const queue = routeMessages(native, control, journal)
    const owner = yield* launch(control)
    const target = JSON.stringify(["coding/request", owner.runId])
    const final = feedbackBoundary("coordinator", { boundary: "after-correction", revision: 0 })
    // A real, empty final-looking receipt in somebody else's lineage has no
    // authority over the request coordinator.
    yield* native.drain({ runId: owner.runId, targetLineageId: "another-lineage", boundary: final, wouldIdle: true })
    yield* native.drain({
      runId: owner.runId,
      targetLineageId: target,
      boundary: feedbackBoundary("coordinator", { boundary: "after-poc", revision: 0 }),
      wouldIdle: true
    })
    yield* queue.admit(owner.runId, message("still-open", owner.runId))
    const consumed = yield* native.drain({
      runId: owner.runId,
      targetLineageId: target,
      boundary: final,
      wouldIdle: true
    })
    assert.equal(consumed.notifications.length, 1)
    assert.equal((yield* queue.admit(owner.runId, message("after-nonempty-final", owner.runId))).decision, "admitted")

    for (const fault of ["source", "sequence", "boundary", "noncanonical", "payload"] as const) {
      const owner = yield* launch(control)
      const target = JSON.stringify(["coding/request", owner.runId])
      const boundary = fault === "boundary" ? "after-correction" : fault === "noncanonical"
        ? "[ \"coordinator\", \"after-correction\", 0 ]" :
        final
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(owner.runId),
          sourceId: JournalEvent.SourceId.make(
            fault === "source" ?
              "forged-drain" :
              `/notifications/drain/${encodeURIComponent(target)}/${encodeURIComponent(boundary)}`
          ),
          sourceSeq: JournalEvent.SourceSeq.make(fault === "sequence" ? 1 : 0),
          eventType: NotificationEvent.PromotedEventType,
          payload: { targetLineageId: target, boundary, ids: fault === "payload" ? "invalid" : [] }
        })
      )
      const refused = yield* queue.admit(owner.runId, message(`refused-${fault}`, owner.runId)).pipe(Effect.flip)
      assert.match(refused.message, /closure evidence is unreadable/)
      assert.deepEqual(yield* native.pending(owner.runId), [])
    }
  }))
})

test("closure reads refuse non-advancing or unbounded journal pages before admission", async () => {
  const host = ManagedRuntime.make(controlLayer)
  try {
    await host.runPromise(Effect.gen(function*() {
      const control = yield* ControlRuntime.ControlRuntime
      const owner = yield* launch(control)
      let admissions = 0
      const queue = NotificationQueue.makeNoop({
        admit: () =>
          Effect.sync(() => {
            admissions++
            return { notificationId: "never", decision: "admitted", duplicate: false, seq: 0 } as const
          })
      })
      const row = (seq: number) =>
        new JournalEvent.Entry({
          runId: JournalEvent.RunId.make(owner.runId),
          seq: JournalEvent.Seq.make(seq),
          eventId: `fixture-${seq}`,
          sourceId: JournalEvent.SourceId.make("fixture"),
          sourceSeq: JournalEvent.SourceSeq.make(seq),
          emittedAtMs: 0,
          eventType: "test.foreign",
          payload: {},
          meta: {}
        })
      for (const fault of ["empty", "repeated", "unordered", "oversized", "unbounded"] as const) {
        let pages = 0
        const journal = Journal.makeNoop({
          entries: ({ after }) =>
            Effect.sync(() => {
              pages++
              return {
                hasMore: true,
                entries: fault === "empty" ? [] : fault === "repeated" ?
                  [row(0)] :
                  fault === "unordered" ?
                  [row(1), row(0)] :
                  fault === "oversized" ?
                  Array.from({ length: 1001 }, (_, i) => row(i)) :
                  [row((after ?? -1) + 1)]
              }
            })
        })
        const error = yield* routeMessages(queue, control, journal).admit(owner.runId, message(fault, owner.runId))
          .pipe(Effect.flip)
        assert.match(error.message, /closure evidence is unreadable/)
        assert.equal(pages, fault === "unbounded" ? 100 : fault === "repeated" ? 2 : 1)
        assert.equal(admissions, 0)
      }
    }))
  } finally {
    await host.dispose()
  }
})

test("closure reads only promotion receipts beyond 100,000 projected engine events", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-noise-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = ManagedRuntime.make(Layer.mergeAll(controlLayer, await journalLayer(join(root, "control.db"))))
  t.after(() => host.dispose())
  const measurement = await host.runPromise(
    Effect.gen(function*() {
      const control = yield* ControlRuntime.ControlRuntime, journal = yield* Journal.Journal
      const sql = yield* SqlClient.SqlClient
      const owner = yield* launch(control)
      // Bulk fixture loading models the existing projection's event type/volume.
      // These rows are valid journal evidence, not a second production write path.
      const fixtureStart = performance.now()
      yield* journal.transact(sql`WITH RECURSIVE noise(seq) AS (
      SELECT 0 UNION ALL SELECT seq + 1 FROM noise WHERE seq < 100004
    ) INSERT INTO flows_journal_events (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      SELECT ${owner.runId}, seq, 'fixture-engine-' || seq, '/fixture/engine-projection', seq, 0,
        'control.engine.event', ${
        JSON.stringify({
          executionId: "native-child",
          kind: "flows.engine.run-decision",
          payload: { decision: "updated", status: "running" }
        })
      }, '{}'
      FROM noise`)
      const fixtureMs = performance.now() - fixtureStart
      const [volume] =
        yield* sql`SELECT COUNT(*) AS count, MAX(seq) AS last FROM flows_journal_events WHERE run_id = ${owner.runId}`
      assert.equal(volume!.count, 100005)
      assert.equal(volume!.last, 100004)

      // Observe the real SQLite reads for both the queue fold and closure policy.
      // Reject a missing filter before decoding noise, so a regression fails by
      // work count instead of spending the timeout benchmarking the old fold.
      const queueReads: number[] = []
      const notificationTypes = [NotificationEvent.AdmittedEventType, NotificationEvent.PromotedEventType]
      const counted = Journal.make({
        ...journal,
        entries: (options) =>
          Effect.gen(function*() {
            if (options.limit !== 1) assert.deepEqual(options.eventTypes, notificationTypes)
            const page = yield* journal.entries(options)
            assert.ok(page.entries.every((row) => notificationTypes.includes(row.eventType)))
            queueReads.push(page.entries.length)
            return page
          })
      })
      const context = yield* Layer.build(
        NotificationQueue.layer.pipe(Layer.provide(Layer.succeed(Journal.Journal, counted)))
      )
      const native = Context.get(context, NotificationQueue.NotificationQueue)
      const reads: Array<{ count: number; ms: number }> = []
      const filtered = Journal.make({
        ...journal,
        entries: (options) =>
          Effect.gen(function*() {
            assert.deepEqual(options.eventTypes, [NotificationEvent.PromotedEventType])
            const start = performance.now()
            const page = yield* journal.entries(options)
            reads.push({ count: page.entries.length, ms: performance.now() - start })
            assert.ok(page.entries.every((row) => row.eventType === NotificationEvent.PromotedEventType))
            return page
          })
      })
      const queue = routeMessages(native, control, filtered)
      const admissionMs: number[] = []
      for (let index = 0; index < 5; index++) {
        const start = performance.now()
        assert.equal(
          (yield* queue.admit(owner.runId, message(`after-noise-${index}`, owner.runId))).decision,
          "admitted"
        )
        admissionMs.push(performance.now() - start)
        if (index === 0) assert.deepEqual(queueReads, [0, 1], "cold admission reads only its new notification")
      }
      const targetLineageId = JSON.stringify(["coding/request", owner.runId])
      const first = yield* queue.drain({
        runId: owner.runId,
        targetLineageId,
        wouldIdle: true,
        boundary: feedbackBoundary("coordinator", { boundary: "after-correction", revision: 0 })
      })
      assert.deepEqual(
        first.notifications.map((note) => note.id),
        Array.from({ length: 5 }, (_, index) => `after-noise-${index}`)
      )
      const final = yield* queue.drain({
        runId: owner.runId,
        targetLineageId,
        wouldIdle: true,
        boundary: feedbackBoundary("coordinator", { boundary: "after-correction", revision: 1 })
      })
      assert.deepEqual(final.notifications, [])
      const refused = yield* queue.admit(owner.runId, message("after-close", owner.runId)).pipe(Effect.flip)
      assert.equal(refused.code, "notification_closed")
      assert.match(refused.message, /start a new request/)
      assert.deepEqual(yield* queue.pending(owner.runId), [])
      assert.equal(reads.length, 6, "one filtered page per steer, regardless of projected engine volume")
      assert.deepEqual(reads.map((read) => read.count), [0, 0, 0, 0, 0, 2])
      // Five admissions, two promotions, and one rolled-back admission each
      // need at most a pre/post-write read, plus the final pending read.
      const writes = 5 + 2 + 1
      assert.ok(queueReads.length <= 2 * writes + 1, "queue reads are bounded by notifications, not engine events")
      assert.ok(
        queueReads.reduce((sum, count) => sum + count, 0) <= writes,
        "queue decodes only new notification evidence"
      )
      const [committed] = yield* sql`SELECT COUNT(*) AS count FROM flows_journal_events WHERE run_id = ${owner.runId}`
      assert.equal(committed!.count, 100005 + 5 + 2, "the refused admission leaves no journal event")
      return { projectedEngineRows: volume!.count, fixtureMs, filteredReads: reads, queueReads, admissionMs }
    }).pipe(Effect.scoped)
  )
  t.diagnostic(JSON.stringify(measurement))
})

test("actual feedback action needs a proved owner and retains attributed overflow before refusing planning", {
  timeout: 60_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-steering-action-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parent = ManagedRuntime.make(
    Layer.mergeAll(
      controlLayer,
      NotificationQueue.layer.pipe(Layer.provideMerge(await journalLayer(join(root, "control.db"))))
    )
  )
  t.after(() => parent.dispose())
  const { queue, owner } = await parent.runPromise(Effect.gen(function*() {
    const control = yield* ControlRuntime.ControlRuntime
    return {
      owner: yield* launch(control),
      queue: routeMessages(yield* NotificationQueue.NotificationQueue, control, yield* Journal.Journal)
    }
  }))
  await parent.runPromise(
    queue.admit(owner.runId, message("oversized", owner.runId, { kind: "Message", body: "x".repeat(65_539) }))
  )
  const Probe = Flow.make("test/ReceiveFeedback", {
    payload: {},
    success: FeedbackReceipt,
    error: ReceiveFeedback.errorSchema,
    body: () => ReceiveFeedback.call({ boundary: "after-poc", revision: 0 })
  })
  const build = (identity?: { rootId: string; flowId: string }) =>
    ManagedRuntime.make(
      Layer.mergeAll(
        Interpreter.layer(Probe),
        feedbackLayer
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provide(Layer.succeed(NotificationQueue.NotificationQueue, queue)),
        Layer.provide(identity === undefined ? Layer.empty : Layer.succeed(ModuleOwner, identity)),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
  for (const identity of [undefined, { rootId: owner.runId, flowId: "other" }]) {
    const runtime = build(identity)
    try {
      const error = await runtime.runPromise(Probe.execute({}).pipe(Effect.flip, Effect.scoped))
      assert.equal(error._tag, "coding/Error")
      assert.ok("code" in error)
      assert.equal(error.code, "unavailable")
    } finally {
      await runtime.dispose()
    }
  }
  assert.equal((await parent.runPromise(queue.pending(owner.runId))).length, 1)
  const runtime = build({ rootId: owner.runId, flowId: "coding/request" })
  t.after(() => runtime.dispose())
  const receipt = await runtime.runPromise(Probe.execute({}).pipe(Effect.scoped))
  assert.match(receipt.boundary, /after-poc/)
  assert.equal(receipt.messages[0]!.id, "oversized")
  assert.equal((await parent.runPromise(queue.pending(owner.runId))).length, 0)
  const error = await Effect.runPromise(appendFeedback("", receipt).pipe(Effect.flip))
  assert.equal(error.code, "invalid_plan")
  assert.match(error.message, /oversized/)
  assert.equal(
    Schema.decodeUnknownSync(FeedbackReceipt)(receipt).messages[0]!.provenance.sourceActor,
    "automation:fixture"
  )
  const small = {
    ...receipt,
    messages: [message("small", owner.runId, { kind: "Message", body: "Use a compact list." })]
  }
  const combined = await Effect.runPromise(appendFeedback("POC feedback.", small))
  assert.match(combined, /^POC feedback\./)
  assert.match(combined, /automation:fixture/)
  assert.match(combined, /Use a compact list\./)
})

test(
  "private host composition shares one decorated queue with Control and the executor",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coding-steering-composition-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    let executorQueue: NotificationQueue.Service | undefined
    let decorated: NotificationQueue.Service | undefined
    let decorations = 0
    const executor = Layer.effect(
      ControlExecutor.ControlExecutor,
      Effect.map(NotificationQueue.NotificationQueue, (queue) => {
        executorQueue = queue
        return ControlExecutor.makeNoop()
      })
    )
    const host = ManagedRuntime.make(
      LocalControl.layer(
        Registry.layerNoop(),
        {
          runtime: controlLayer,
          journal: (await journalLayer(join(root, "control.db"))).pipe(Layer.orDie)
        },
        executor,
        (queue, control, journal) => {
          decorations++
          decorated = routeMessages(queue, control, journal)
          return decorated
        }
      ).pipe(Layer.provideMerge(controlLayer))
    )
    t.after(() => host.dispose())
    await host.runPromise(Effect.gen(function*() {
      const runtime = yield* ControlRuntime.ControlRuntime
      const control = yield* Control.Control
      const run = yield* launch(runtime)
      const receipt = yield* control.steer({
        runId: run.runId,
        idempotencyKey: "composition-message",
        message: {
          runId: run.runId,
          messageId: "composition-message",
          principal: yield* runtime.stampPrincipal(),
          createdAt: 0,
          body: "Revise the next plan."
        }
      })
      assert.equal(receipt._tag, "Accepted")
      assert.equal(decorations, 1)
      assert.equal(executorQueue, decorated)
      assert.ok(executorQueue)
      const pending = yield* executorQueue.pending(run.runId)
      assert.equal(pending[0]!.id, "composition-message")
      assert.notEqual(pending[0]!.targetLineageId, run.runId)
      assert.equal(
        (yield* executorQueue.drain({
          runId: run.runId,
          targetLineageId: run.runId,
          boundary: "model",
          wouldIdle: true
        })).notifications.length,
        0
      )
    }))
  }
)


test("TODO messages refuse before queue effects while the pinned delivery providers are unavailable", async () => {
  const host = ManagedRuntime.make(Layer.mergeAll(controlLayer, Journal.layerNoop()))
  try {
    await host.runPromise(Effect.gen(function*() {
      const control = yield* ControlRuntime.ControlRuntime
      const owner = yield* launch(control, "todo")
      let admissions = 0
      const queue = {
        admit: () => Effect.sync(() => { admissions++; throw new Error("unexpected admission") })
      } as unknown as NotificationQueue.Service
      const journal = yield* Journal.Journal
      for (const target of [owner.runId, "explicit-todo-step"]) {
        const error = yield* routeMessages(queue, control, journal)
          .admit(owner.runId, message("todo-steer", target)).pipe(Effect.flip)
        assert.equal(error.code, "notification_unavailable")
        assert.equal(error.notificationId, "todo-steer")
      }
      assert.equal(admissions, 0)
    }))
  } finally {
    await host.dispose()
  }
})
