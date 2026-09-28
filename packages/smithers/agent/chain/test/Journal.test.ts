import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type * as Event from "../src/Event.ts"
import * as Journal from "../src/Journal.ts"

const started: Event.Event = { _tag: "ChainStarted", envelope: null, goal: "g" }

const withJournal = <A, E>(
  layer: ReturnType<typeof Journal.layerMemory>,
  use: (journal: Journal.Service) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(Journal.Journal, use).pipe(Effect.provide(layer))
  )

describe("Journal", () => {
  it("appends and reads in order", async () => {
    const events = await withJournal(Journal.layerMemory(), (journal) =>
      Effect.gen(function*() {
        yield* journal.append(started, 0)
        yield* journal.append({ _tag: "LinkEnded", link: 0, outcome: { _tag: "Done", value: null } }, 1)
        return yield* journal.read
      }))
    expect(events.map((event) => event._tag)).toEqual(["ChainStarted", "LinkEnded"])
  })

  it("seeds from prior events", async () => {
    const events = await withJournal(Journal.layerMemory([started]), (journal) => journal.read)
    expect(events).toEqual([started])
  })

  it("snapshots a caller-owned seed array when the layer is constructed", async () => {
    const other: Event.Event = { _tag: "LinkEnded", link: 0, outcome: { _tag: "Done", value: null } }
    const seed: Array<Event.Event> = [started]
    const layer = Journal.layerMemory(seed)
    seed.push(other)

    const events = await withJournal(layer, (journal) => journal.read)
    expect(events).toEqual([started])
  })

  it("hands readers a snapshot that later appends do not mutate", async () => {
    const [before, after] = await withJournal(Journal.layerMemory([started]), (journal) =>
      Effect.gen(function*() {
        const first = yield* journal.read
        yield* journal.append({ _tag: "LinkEnded", link: 0, outcome: { _tag: "Done", value: null } }, 1)
        return [first, yield* journal.read] as const
      }))
    expect(before.map((event) => event._tag)).toEqual(["ChainStarted"])
    expect(after.map((event) => event._tag)).toEqual(["ChainStarted", "LinkEnded"])
  })

  it("defaults to an empty journal", async () => {
    const events = await withJournal(Journal.layerMemory(), (journal) => journal.read)
    expect(events).toEqual([])
  })

  it("fails as noop with a typed error", async () => {
    const noop = Journal.makeNoop()
    const appendError = await Effect.runPromise(Effect.flip(noop.append(started, 0)))
    expect(appendError.code).toBe("journal_unavailable")
    const readError = await Effect.runPromise(Effect.flip(noop.read))
    expect(readError.message).toBe("read is unavailable")
  })

  it("accepts noop overrides", async () => {
    const noop = Journal.makeNoop({ read: Effect.succeed([started]) })
    const events = await Effect.runPromise(noop.read)
    expect(events).toEqual([started])
  })

  it("rejects an append at a stale expected position", async () => {
    const error = await withJournal(
      Journal.layerMemory([started]),
      (journal) =>
        Effect.flip(journal.append({ _tag: "LinkEnded", link: 0, outcome: { _tag: "Done", value: null } }, 0))
    )

    expect(error.code).toBe("journal_conflict")
    expect(error.message).toContain("expected journal position 0, found 1")
  })

  it("provides the noop layer", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(Journal.Journal, (journal) => journal.read)).pipe(
        Effect.provide(Journal.layerNoop())
      )
    )
    expect(error.code).toBe("journal_unavailable")
  })
})
