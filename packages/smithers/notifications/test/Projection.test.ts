import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationEvent from "../src/NotificationEvent.ts"
import * as NotificationState from "../src/NotificationState.ts"
import * as Projection from "../src/Projection.ts"

const runId = "notification-projection" as JournalEvent.RunId
const sourceId = "notification-test" as JournalEvent.SourceId

const notification = (
  id: string,
  payload = id
): Notification => ({
  id,
  _tag: "human-followup",
  delivery: "queue",
  targetLineageId: "notification-projection/root",
  provenance: {
    sourceRunId: "source",
    sourceLineageId: "source/root",
    sourceTurn: 0,
    sourceActor: "test"
  },
  payload
})

/**
 * The source the queue itself writes an owned event under, so the projection
 * reads it as the queue's own record rather than a forgery.
 */
const ownedSource = (eventType: string, payload: unknown): JournalEvent.SourceId => {
  const fields = payload as { notification?: { id?: unknown }; targetLineageId?: unknown; boundary?: unknown }
  if (eventType === NotificationEvent.AdmittedEventType && typeof fields.notification?.id === "string") {
    return NotificationEvent.admissionSourceId(fields.notification.id)
  }
  if (
    eventType === NotificationEvent.PromotedEventType && typeof fields.targetLineageId === "string" &&
    typeof fields.boundary === "string"
  ) {
    return NotificationEvent.drainSourceId(fields.targetLineageId, fields.boundary)
  }
  return sourceId
}

const input = (eventType: string, payload: unknown): JournalEvent.Input =>
  new JournalEvent.Input(
    {
      runId,
      sourceId: ownedSource(eventType, payload),
      eventType,
      payload
    },
    { disableChecks: true }
  )

const runJournal = <A, E>(effect: Effect.Effect<A, E, Journal.Journal>) =>
  effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped)

describe("Notification projection", () => {
  it("rejects malformed owned event payloads", () => {
    const malformedAdmitted = new JournalEvent.Entry({
      ...input(NotificationEvent.AdmittedEventType, {
        notification: { _tag: "human-followup", id: 1, payload: null },
        decision: "unknown"
      }),
      seq: 0 as JournalEvent.Seq,
      eventId: "malformed-admitted",
      sourceSeq: 0 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      meta: null
    })
    const malformedPromoted = new JournalEvent.Entry({
      ...input(NotificationEvent.PromotedEventType, {
        boundary: 1,
        ids: ["one", 2]
      }),
      seq: 1 as JournalEvent.Seq,
      eventId: "malformed-promoted",
      sourceSeq: 1 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      meta: null
    })

    expect(NotificationEvent.fromEntry(malformedAdmitted)._tag).toBe("None")
    expect(NotificationEvent.fromEntry(malformedPromoted)._tag).toBe("None")
  })

  it("replays admitted events to the same state as the pure fold", async () => {
    const notifications = [notification("one"), notification("two"), notification("three")]
    let expected = Projection.derive.initial
    for (let index = 0; index < notifications.length; index++) {
      expected = NotificationState.admit(expected, notifications[index]!, index).state
    }

    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* Effect.forEach(
            notifications,
            (value) =>
              journal.emitDurableUnfenced(
                input("flows/notifications/Admitted", {
                  notification: value,
                  decision: "admitted"
                })
              ),
            { discard: true }
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(4), Stream.runCollect)
        })
      )
    )

    expect(states.at(-1)).toEqual(expected)
  })

  it("removes promoted notification ids during replay", async () => {
    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced(
            input("flows/notifications/Admitted", {
              notification: notification("one"),
              decision: "admitted"
            })
          )
          yield* journal.emitDurableUnfenced(
            input("flows/notifications/Promoted", {
              boundary: "would-idle",
              targetLineageId: "notification-projection/root",
              ids: ["one"]
            })
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(3), Stream.runCollect)
        })
      )
    )

    expect(states.at(-1)?.items).toEqual([])
  })

  it("replays every committed admission past the projection's own capacity", async () => {
    const overCapacity = NotificationState.defaultCapacity + 1
    const notifications = Array.from({ length: overCapacity }, (_, index) => notification(`n-${index}`))

    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* Effect.forEach(
            notifications,
            (value) =>
              journal.emitDurableUnfenced(
                input(NotificationEvent.AdmittedEventType, {
                  notification: value,
                  decision: "admitted"
                })
              ),
            { discard: true }
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(
            Stream.take(overCapacity + 1),
            Stream.runCollect
          )
        })
      )
    )

    const last = states.at(-1)
    expect(last?.capacity).toBe(NotificationState.defaultCapacity)
    expect(last?.items.length).toBe(overCapacity)
    expect(last?.items.at(-1)?.notification.id).toBe(`n-${overCapacity - 1}`)
  })

  it("ignores foreign events and records rejected admissions without queueing them", async () => {
    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced(input("foreign", { value: true }))
          yield* journal.emitDurableUnfenced(
            input(NotificationEvent.AdmittedEventType, {
              notification: notification("full"),
              decision: "rejected-full"
            })
          )
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(3), Stream.runCollect)
        })
      )
    )
    expect(states.at(-1)?.items).toEqual([])
  })

  it("reads no admission or promotion another writer journaled under the queue's event types", async () => {
    const forged = (eventType: string, payload: unknown, forgedSource: string) =>
      new JournalEvent.Input({
        runId,
        sourceId: JournalEvent.SourceId.make(forgedSource),
        eventType,
        payload
      })
    const states = await Effect.runPromise(
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced(
            input(NotificationEvent.AdmittedEventType, { notification: notification("real"), decision: "admitted" })
          )
          // A step writing to the shared journal forges an operator steer...
          yield* journal.emitDurableUnfenced(forged(
            NotificationEvent.AdmittedEventType,
            {
              notification: { ...notification("forged"), _tag: "human-steer", delivery: "steer" },
              decision: "admitted"
            },
            "/flow/step"
          ))
          // ...one under another notification's admission source...
          yield* journal.emitDurableUnfenced(forged(
            NotificationEvent.AdmittedEventType,
            { notification: notification("borrowed"), decision: "admitted" },
            "/notifications/admission/real"
          ))
          // ...and a promotion that would drop the real steer undelivered.
          yield* journal.emitDurableUnfenced(forged(
            NotificationEvent.PromotedEventType,
            { boundary: "forged", targetLineageId: "notification-projection/root", ids: ["real"] },
            "/flow/step"
          ))
          yield* journal.flush
          return yield* journal.project(Projection.derive, { runId }).pipe(Stream.take(5), Stream.runCollect)
        })
      )
    )
    expect(states.at(-1)?.items.map((item) => item.notification.id)).toEqual(["real"])
  })
})
