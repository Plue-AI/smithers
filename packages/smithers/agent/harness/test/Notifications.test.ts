import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { NotificationQueue } from "@smthrs/notifications"
import type * as NotificationModel from "@smthrs/notifications/Notification"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Notifications from "../src/Notifications.ts"
import * as Steering from "../src/Steering.ts"

/**
 * A fresh journal per case: the queue is durable, so one shared layer would
 * let an earlier case's admissions drain into a later one.
 */
const notificationLayer = () => {
  const journal = TestJournal.layer()
  return Layer.merge(journal, NotificationQueue.layer.pipe(Layer.provide(journal)))
}

const notification = (
  id: string,
  delivery: "steer" | "queue",
  targetLineageId: string,
  payload: typeof Schema.Json.Type = { body: `body:${id}` }
): NotificationModel.Notification => {
  const base = {
    id,
    targetLineageId,
    provenance: {
      sourceRunId: "operator",
      sourceLineageId: "operator/root",
      sourceTurn: 7,
      sourceActor: "human:operator"
    },
    payload
  }
  return delivery === "steer"
    ? { _tag: "human-steer", delivery, ...base }
    : { _tag: "human-followup", delivery, ...base }
}

const systemEvent = (
  id: string,
  targetLineageId: string,
  payload: typeof Schema.Json.Type,
  coalescingKey?: string
): NotificationModel.Notification => ({
  _tag: "system-event",
  delivery: "queue",
  id,
  targetLineageId,
  provenance: {
    sourceRunId: "ci",
    sourceLineageId: "ci/root",
    sourceTurn: 0,
    sourceActor: "machine:ci"
  },
  payload,
  ...(coalescingKey === undefined ? {} : { coalescingKey })
})

/** The exact text the adapter renders for one delivered notification. */
const rendered = (
  id: string,
  body: string,
  actor = "human:operator",
  lineage = "operator/root",
  turn = 7
): ModelRequest.Message =>
  ModelRequest.Message.user(`[notification ${id} from ${actor} at ${lineage} turn ${turn}]\n${body}`)

describe("harness notification adapter", () => {
  it("carries attribution into the model message without replacing its authenticated source", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const message = notification("member-feedback", "steer", "run/root/child", {
          kind: "Message",
          body: "Keep the question open.\nCheck cancellation."
        })
        yield* queue.admit("run", {
          ...message,
          provenance: {
            ...message.provenance,
            sourceActor: "bearer:product-backend",
            attribution: { person: "ben", via: "codex", session: "terminal-1" }
          }
        })
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        const first = yield* source.drain({ boundary: "model-turn-2", wouldIdle: false })
        const replay = yield* source.drain({ boundary: "model-turn-2", wouldIdle: false })
        return { first, replay }
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )
    expect(result.first.inserts).toEqual([ModelRequest.Message.user(
      "[notification member-feedback from bearer:product-backend at operator/root turn 7 attribution {\"person\":\"ben\",\"session\":\"[REDACTED]\",\"via\":\"codex\"}]\nKeep the question open.\nCheck cancellation."
    )])
    expect(result.replay.inserts).toEqual(result.first.inserts)
    expect(result.replay.duplicate).toBe(true)
  })

  it("drains the target lineage at turn boundaries with queue semantics and provenance", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("steer", "steer", "run/root/child"))
        yield* queue.admit("run", notification("queued", "queue", "run/root/child"))
        yield* queue.admit("run", notification("other", "steer", "run/root/other"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        const active = yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
        const idle = yield* source.drain({ boundary: "child/turn-2", wouldIdle: true })
        return { active, idle }
      }).pipe(
        Effect.provide(notificationLayer()),
        Effect.scoped
      )
    )

    expect(result.active.queued).toBe(false)
    expect(result.active.inserts[0]).toMatchObject({
      role: "user",
      content: [{
        text: expect.stringContaining(
          "[notification steer from human:operator at operator/root turn 7]\nbody:steer"
        )
      }]
    })
    expect(result.idle.queued).toBe(true)
    expect(result.idle.inserts[0]).toMatchObject({
      content: [{ text: expect.stringContaining("body:queued") }]
    })

    // The drain is journaled through `Steering.DrainRecord` at the engine's
    // record boundary, so the rendered inserts must be real `UserMessage`
    // instances — a structurally similar literal fails this encode.
    const journaled = Schema.encodeUnknownSync(Steering.DrainRecord)(Steering.drainRecord(result.active))
    expect(journaled.inserts).toHaveLength(1)
  })

  it("reads an empty queue because the durable queue is only ever drained", async () => {
    const queue = await Effect.runPromise(
      Effect.gen(function*() {
        const durable = yield* NotificationQueue.NotificationQueue
        yield* durable.admit("run", notification("steer", "steer", "run/root/child"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.read()
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    // The snapshot is the host queue's business, so the adapter reports none
    // even while the durable queue holds a pending steer.
    expect(queue.items).toEqual([])
    expect(Object.isFrozen(queue)).toBe(true)
  })

  it("drains nothing at a boundary with an empty queue", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: true })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(drained).toEqual({
      inserts: [],
      seatChanges: [],
      remaining: Steering.empty(),
      queued: false,
      duplicate: false
    })
  })

  it("delivers every pending steer for the lineage in admission order", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("first", "steer", "run/root/child"))
        yield* queue.admit("run", notification("second", "steer", "run/root/child"))
        yield* queue.admit("run", notification("third", "steer", "run/root/child"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(drained.inserts).toEqual([
      rendered("first", "body:first"),
      rendered("second", "body:second"),
      rendered("third", "body:third")
    ])
    expect(drained.queued).toBe(false)
  })

  it("renders payloads that are not string-keyed records as JSON", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("text", "steer", "run/root/child", "plain text"))
        yield* queue.admit("run", notification("nothing", "steer", "run/root/child", null))
        yield* queue.admit("run", notification("list", "steer", "run/root/child", [1, 2]))
        yield* queue.admit("run", notification("keyed", "steer", "run/root/child", { note: "no body key" }))
        yield* queue.admit("run", notification("numeric", "steer", "run/root/child", { body: 12 }))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(drained.inserts).toEqual([
      rendered("text", "\"plain text\""),
      rendered("nothing", "null"),
      rendered("list", "[1,2]"),
      rendered("keyed", "{\"note\":\"no body key\"}"),
      rendered("numeric", "{\"body\":12}")
    ])
  })

  it("promotes exactly one queued follow-up per idle boundary and none while the run is busy", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("one", "queue", "run/root/child"))
        yield* queue.admit("run", notification("two", "queue", "run/root/child"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        const busy = yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
        const firstIdle = yield* source.drain({ boundary: "child/turn-2", wouldIdle: true })
        const secondIdle = yield* source.drain({ boundary: "child/turn-3", wouldIdle: true })
        const exhausted = yield* source.drain({ boundary: "child/turn-4", wouldIdle: true })
        return { busy, firstIdle, secondIdle, exhausted }
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(result.busy.inserts).toEqual([])
    expect(result.busy.queued).toBe(false)
    expect(result.firstIdle.inserts).toEqual([rendered("one", "body:one")])
    expect(result.firstIdle.queued).toBe(true)
    expect(result.secondIdle.inserts).toEqual([rendered("two", "body:two")])
    expect(result.exhausted.inserts).toEqual([])
    expect(result.exhausted.queued).toBe(false)
  })

  it("replays a boundary it already drained instead of draining a second time", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("early", "steer", "run/root/child"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        const first = yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
        // Arrives while the frame is being re-executed.
        yield* queue.admit("run", notification("late", "steer", "run/root/child"))
        const replayed = yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
        const next = yield* source.drain({ boundary: "child/turn-2", wouldIdle: false })
        return { first, replayed, next }
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    // A re-executed frame must rebuild the identical context, so the recorded
    // boundary replays its own promotion and the late arrival waits.
    expect(result.replayed.inserts).toEqual(result.first.inserts)
    expect(result.first.inserts).toEqual([rendered("early", "body:early")])
    expect(result.next.inserts).toEqual([rendered("late", "body:late")])
  })

  it("keeps another lineage's boundary out of this lineage's drain", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("mine", "steer", "run/root/child"))
        yield* queue.admit("run", notification("theirs", "steer", "run/root/other"))
        const child = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        const other = yield* Notifications.make({ runId: "run", lineageId: "run/root/other" })
        const mine = yield* child.drain({ boundary: "child/turn-1", wouldIdle: false })
        const theirs = yield* other.drain({ boundary: "other/turn-1", wouldIdle: false })
        return { mine, theirs }
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(result.mine.inserts).toEqual([rendered("mine", "body:mine")])
    expect(result.theirs.inserts).toEqual([rendered("theirs", "body:theirs")])
  })

  it("delivers one coalesced machine event rather than every superseded one", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", systemEvent("build-1", "run/root/child", { body: "building" }, "build"))
        yield* queue.admit("run", systemEvent("build-2", "run/root/child", { body: "built" }, "build"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: true })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(drained.inserts).toEqual([rendered("build-2", "built", "machine:ci", "ci/root", 0)])
    expect(drained.queued).toBe(true)
  })

  it("reports an unreachable durable queue as an engine failure at the boundary", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
      }).pipe(Effect.provide(NotificationQueue.layerNoop()))
    )

    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({
      _tag: "/harness/HarnessError",
      code: "engine_failed",
      message: "The durable notification queue failed at a turn boundary"
    })
    expect((error as { readonly cause?: { readonly message?: string } })?.cause?.message).toBe(
      "drain is unavailable"
    )
  })

  it("provides the steering source for one run lineage as a layer", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("layered", "steer", "run/root/child"))
        const source = yield* Steering.Source
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
      }).pipe(
        Effect.provide(
          Notifications.layer({ runId: "run", lineageId: "run/root/child" }).pipe(
            Layer.provideMerge(notificationLayer())
          )
        ),
        Effect.scoped
      )
    )

    expect(drained.inserts).toEqual([rendered("layered", "body:layered")])
  })

  it("delivers a typed steer as the seat, thinking, and tool changes it names", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("say", "steer", "run/root/child", { kind: "Message", body: "ship it" }))
        yield* queue.admit("run", notification("seat", "steer", "run/root/child", { kind: "Seat", seat: "reviewer" }))
        yield* queue.admit(
          "run",
          notification("think", "steer", "run/root/child", { kind: "Thinking", thinking: "high" })
        )
        yield* queue.admit(
          "run",
          notification("tools", "steer", "run/root/child", { kind: "Tools", toolNames: ["grep", "edit"] })
        )
        // A second steer that re-names a tool the first already activated.
        // Activation is a set, not a list: naming `grep` twice widens the
        // active set once.
        yield* queue.admit(
          "run",
          notification("tools-again", "steer", "run/root/child", { kind: "Tools", toolNames: ["grep", "read"] })
        )
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    // Only the message reaches the transcript. A seat change is not something
    // to tell the model about; it is something to do to the next turn.
    // Only the message reaches the transcript, and a tool steer reaches it as a
    // refusal: this run has no provider tools to activate, so the operator's
    // steer is answered rather than journaled as delivered and dropped.
    expect(drained.inserts).toHaveLength(3)
    expect(drained.inserts[0]).toEqual(rendered("say", "ship it"))
    expect(JSON.stringify(drained.inserts[1])).toContain("grep, edit")
    expect(JSON.stringify(drained.inserts[1])).toContain("no provider tools")
    expect(JSON.stringify(drained.inserts[2])).toContain("grep, read")
    expect(drained.seatChanges).toEqual([
      { _tag: "SeatChange", delivery: "steer", admittedAt: 0, seat: "reviewer" },
      { _tag: "ThinkingChange", delivery: "steer", admittedAt: 0, thinking: "high" }
    ])
  })

  it("keeps a payload that is not a steering item out of the seat and tool changes", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        // A system event carrying a status, not a steer. It is rendered for
        // the model, and it changes nothing about the turn.
        yield* queue.admit("run", systemEvent("deploy", "run/root/child", { kind: "Seat", seat: 12 }))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: true })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    expect(drained.seatChanges).toEqual([])
    expect(drained.inserts).toEqual([
      rendered("deploy", "{\"kind\":\"Seat\",\"seat\":12}", "machine:ci", "ci/root", 0)
    ])
  })

  it("journals a typed drain through the record boundary", async () => {
    const drained = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("seat", "steer", "run/root/child", { kind: "Seat", seat: "reviewer" }))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        return yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
      }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
    )

    // A seat change that could not survive the record boundary would be
    // delivered once and lost on the re-execution that replays the frame.
    const journaled = Schema.encodeUnknownSync(Steering.DrainRecord)(Steering.drainRecord(drained))
    expect(journaled.seatChanges).toEqual([
      { _tag: "SeatChange", delivery: "steer", admittedAt: 0, seat: "reviewer" }
    ])
  })
})

// These use the real journal-backed queue, not a transient delivery substitute.
describe("outside-change activation", () => {
  it.each(["system", "operator"])(
    "refuses reserved %s payloads at admission without losing a steer",
    async (origin) => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const queue = yield* NotificationQueue.NotificationQueue
          const payload = { kind: "outside_change", files: ["$(touch canary).ts"] }
          const event = origin === "system"
            ? systemEvent("burst-1", "run/root/child", payload)
            : notification("burst-1", "steer", "run/root/child", payload)
          const first = yield* Effect.exit(queue.admit("run", event))
          const retry = yield* Effect.exit(queue.admit("run", event))
          yield* queue.admit("run", notification("say", "steer", "run/root/child", { body: "ship it" }))
          const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
          const drained = yield* source.drain({ boundary: "turn-1", wouldIdle: true })
          const replay = yield* source.drain({ boundary: "turn-1", wouldIdle: true })
          return { first, retry, drained, replay }
        }).pipe(Effect.provide(notificationLayer()), Effect.scoped)
      )
      for (const exit of [result.first, result.retry]) {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ code: "notification_refused" })
          expect(JSON.stringify(Cause.squash(exit.cause))).not.toContain("touch canary")
        }
      }
      expect(result.drained.inserts).toEqual([rendered("say", "ship it")])
      expect(result.replay.inserts).toEqual(result.drained.inserts)
      expect(result.replay.duplicate).toBe(true)
    }
  )
})
