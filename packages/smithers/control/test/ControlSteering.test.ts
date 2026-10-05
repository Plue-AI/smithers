/**
 * Live steering end to end over the durable stack: what a typed steer is
 * stored as, what a watcher sees between enqueue and delivery, which parked
 * runs a steer wakes, and what a steer to a finished run answers.
 *
 * The durable stack is the point. A steer crosses three durable surfaces — the
 * control mutation, the notification queue's journal, and the run row's
 * waiting reason — and an in-memory double for any of them would prove the
 * shape of a fixture rather than the behavior of a control plane.
 */
import { NotificationQueue } from "@smthrs/notifications"
import { Effect, type Layer, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { ListResponse, Principal, RunSummary, SteerMessage } from "../src/ControlSchema.ts"
import * as Steering from "../src/Steering.ts"
import { durable, type DurableStack } from "./DurableStack.ts"
import { park as releaseOwnership } from "./Park.ts"

const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }

const run = <A, E>(
  body: Effect.Effect<A, E, DurableStack>,
  stack: Layer.Layer<DurableStack> = durable()
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

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

/**
 * One steer variant with the envelope removed.
 *
 * `Omit` over a union collapses to the shared fields, which would hide every
 * variant's own payload, so the omission distributes over the union first.
 */
type SteerBody = SteerMessage extends infer Variant
  ? Variant extends SteerMessage ? Omit<Variant, "runId" | "principal" | "createdAt"> : never
  : never

const steer = (runId: string, message: SteerBody) =>
  Effect.flatMap(Control, (control) =>
    control.steer({
      runId,
      message: { ...message, runId, principal, createdAt: 1 } as SteerMessage,
      idempotencyKey: `steer:${message.messageId}`
    }))

const summaryOf = (listed: ListResponse): RunSummary | undefined => listed._tag === "runs" ? listed.items[0] : undefined

/** The run's summary as `list` projects it. */
const summary = (runId: string) =>
  Effect.map(
    Effect.flatMap(Control, (control) => control.list({ _tag: "runs", filters: { runId } })),
    summaryOf
  )

/** Parks a run the way the engine parks one: suspended, with a waiting reason. */
const park = (runId: string, reason?: string) =>
  Effect.gen(function*() {
    yield* releaseOwnership(yield* ControlRuntime, runId)
    if (reason === undefined) return
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`UPDATE flows_runs SET waiting_reason = ${reason} WHERE run_id = ${runId}`.pipe(Effect.orDie)
  })

describe("live steering", () => {
  it("retains producer attribution separately from the authenticated source", async () => {
    const observed = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const runId = yield* start("attributed")
      const message = {
        messageId: "member-feedback",
        body: "Keep the question open.\nCheck cancellation.",
        attribution: { person: "ben", via: "codex", session: "terminal-1" }
      }
      expect((yield* steer(runId, message))._tag).toBe("Accepted")
      expect((yield* steer(runId, message))._tag).toBe("AlreadyApplied")
      expect((yield* steer(runId, { ...message, attribution: { person: "someone-else" } }))._tag).toBe("Conflict")
      return yield* queue.pending(runId)
    }))
    expect(observed).toHaveLength(1)
    expect(observed[0]?.provenance).toMatchObject({
      sourceActor: "test:operator",
      attribution: { person: "ben", via: "codex", session: "[REDACTED]" }
    })
    expect(observed[0]?.payload).toEqual({ kind: "Message", body: "Keep the question open.\nCheck cancellation." })
  })

  it("stores a typed steer as the item the harness reads back", async () => {
    const observed = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const runId = yield* start("typed")
      yield* steer(runId, { messageId: "steer-seat", kind: "Seat", seat: "reviewer" })
      yield* steer(runId, { messageId: "steer-body", body: "ship it" })
      return yield* queue.pending(runId)
    }))

    expect(observed.map((notification) => notification.payload)).toEqual([
      { kind: "Seat", seat: "reviewer" },
      { kind: "Message", body: "ship it" }
    ])
  })

  it("shows a watcher the enqueue and then the delivery of the same message id", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const queue = yield* NotificationQueue.NotificationQueue
      const runId = yield* start("watched")
      yield* steer(runId, { messageId: "steer-1", kind: "Thinking", thinking: "high" })
      yield* queue.drain({
        runId,
        targetLineageId: runId,
        boundary: `${runId}/turn-1`,
        wouldIdle: false
      })
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return events.filter((event) =>
        event.kind === "control.steer.enqueued" || event.kind === Steering.deliveredEventType
      )
    }))

    expect(observed.map((event) => event.kind)).toEqual([
      "control.steer.enqueued",
      Steering.deliveredEventType
    ])
    expect(observed[0]?.payload).toMatchObject({ messageId: "steer-1", kind: "Thinking" })
    expect(observed[1]?.payload).toMatchObject({ messageId: "steer-1" })
  })

  it("counts what is still pending on the run summary and drops it at the boundary", async () => {
    const observed = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const runId = yield* start("pending")
      yield* steer(runId, { messageId: "steer-1", body: "one" })
      yield* steer(runId, { messageId: "steer-2", body: "two" })
      const before = yield* summary(runId)
      yield* queue.drain({
        runId,
        targetLineageId: runId,
        boundary: `${runId}/turn-1`,
        wouldIdle: false
      })
      return { before, after: yield* summary(runId) }
    }))

    expect(observed.before?.steering).toEqual({ pending: 2 })
    expect(observed.after?.steering).toEqual({ pending: 0 })
  })

  it("wakes a run a sweep released from a dead owner", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("released")
      // `released` is what `DisasterRecovery.fence` writes on a run whose owner
      // died: nothing is coming back to claim it, so the steer claims it.
      yield* park(runId, "released")
      const parked = yield* summary(runId)
      yield* steer(runId, { messageId: "steer-1", body: "carry on" })
      return { parked, woken: yield* summary(runId) }
    }))

    expect(observed.parked?.status).toBe("parked")
    expect(observed.woken?.status).toBe("accepted")
  })

  it("leaves a run the operator parked exactly where the operator left it", async () => {
    const observed = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const runId = yield* start("operator-park")
      // An operator's own park writes no waiting reason, which is the one park
      // a steer must not end: the message waits for the operator's own resume.
      yield* park(runId)
      yield* steer(runId, { messageId: "steer-1", body: "read this when you are back" })
      return { summary: yield* summary(runId), pending: yield* queue.pending(runId) }
    }))

    expect(observed.summary?.status).toBe("parked")
    expect(observed.summary?.waitingReason).toBeUndefined()
    // Stored, not delivered: the steer is queued behind the park.
    expect(observed.pending).toHaveLength(1)
  })

  it("wakes a run parked on an event and leaves an approval, timer, or quota park alone", async () => {
    const observed = await run(Effect.gen(function*() {
      const statuses: Array<[string, string | undefined]> = []
      for (const reason of ["event", "approval", "timer", "quota"]) {
        const runId = yield* start(`park-${reason}`)
        yield* park(runId, reason)
        yield* steer(runId, { messageId: `steer-${reason}`, body: "look at this" })
        statuses.push([reason, (yield* summary(runId))?.status])
      }
      return statuses
    }))

    expect(observed).toEqual([
      ["event", "accepted"],
      ["approval", "parked"],
      ["timer", "parked"],
      ["quota", "parked"]
    ])
  })

  it("reports the waiting reason a park is holding on", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("reason")
      yield* park(runId, "approval")
      return yield* summary(runId)
    }))

    expect(observed?.waitingReason).toBe("approval")
  })

  it("refuses a steer to a run that already finished", async () => {
    const observed = await run(Effect.gen(function*() {
      const queue = yield* NotificationQueue.NotificationQueue
      const control = yield* Control
      const runId = yield* start("terminal")
      yield* control.cancel({ runId, idempotencyKey: `cancel:${runId}` })
      const receipt = yield* steer(runId, { messageId: "steer-late", body: "too late" })
      return { receipt, pending: yield* queue.pending(runId) }
    }))

    expect(observed.receipt).toEqual({ _tag: "Terminal", runId: expect.any(String), status: "cancelled" })
    // A refused steer is not a stored steer: nothing is waiting to be
    // delivered to a run that will never take another turn.
    expect(observed.pending).toEqual([])
  })
})
