import { Effect, Schedule } from "effect"
import { describe, expect, it } from "vitest"
import { CursorStore, layerMemory } from "../src/core/CursorStore.ts"
import type { ExternalEvent } from "../src/core/ExternalEvent.ts"
import { type Batch, DEFAULT_SCHEDULE, runWithCursor } from "../src/core/Source.ts"

const event = (id: number): ExternalEvent => ({
  source: "example",
  eventName: "integration:example:message",
  correlationId: null,
  payload: { id },
  dedupeKey: `example:${id}`,
  receivedAtMs: 1
})

const run = <A, E>(effect: Effect.Effect<A, E, CursorStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layerMemory)))

describe("runWithCursor", () => {
  it("commits each proposed cursor only after the handler succeeds, turn after turn", async () => {
    const polled: Array<string | null> = []
    const handled: Array<ReadonlyArray<number>> = []
    const batches: Record<string, Batch> = {
      start: { events: [event(1), event(2)], cursor: "3" },
      "3": { events: [event(3)], cursor: "4" },
      "4": { events: [] }
    }
    const cursor = await run(Effect.gen(function*() {
      yield* runWithCursor(
        "example",
        (cursor) =>
          Effect.sync(() => {
            polled.push(cursor)
            return batches[cursor ?? "start"]!
          }),
        (events) => Effect.sync(() => void handled.push(events.map((found) => (found.payload as { id: number }).id))),
        { schedule: Schedule.recurs(2) }
      )
      return yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("example"))
    }))
    expect(polled).toEqual([null, "3", "4"])
    expect(handled).toEqual([[1, 2], [3], []])
    // The empty turn proposed no cursor, so the last committed one stands.
    expect(cursor).toBe("4")
  })

  it("leaves the cursor where it was when the handler fails", async () => {
    const [failure, cursor] = await run(Effect.gen(function*() {
      const cursors = yield* CursorStore
      yield* cursors.set("example", "7")
      const failure = yield* Effect.flip(runWithCursor(
        "example",
        () => Effect.succeed<Batch>({ events: [event(7)], cursor: "8" }),
        () => Effect.fail("handler refused" as const)
      ))
      return [failure, yield* cursors.get("example")] as const
    }))
    expect(failure).toBe("handler refused")
    expect(cursor).toBe("7")
  })

  it("ends with the poll's failure and commits nothing", async () => {
    const [failure, cursor] = await run(Effect.gen(function*() {
      const failure = yield* Effect.flip(
        runWithCursor("example", () => Effect.fail("poll failed" as const), () => Effect.void)
      )
      return [failure, yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("example"))] as const
    }))
    expect(failure).toBe("poll failed")
    expect(cursor).toBeNull()
  })

  it("polls forever by default, spaced by the default schedule", async () => {
    let turns = 0
    const outcome = await run(
      runWithCursor(
        "example",
        () => Effect.sync(() => ({ events: [], cursor: String(++turns) })),
        () => turns >= 3 ? Effect.fail("stop" as const) : Effect.void
      ).pipe(Effect.flip)
    )
    expect(outcome).toBe("stop")
    expect(turns).toBe(3)
    expect(DEFAULT_SCHEDULE).toBeDefined()
  })
})
