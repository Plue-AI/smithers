import { JournalEvent } from "@smthrs/journal"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as BranchProjection from "../src/BranchProjection.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as TestEntry from "./fixtures/entry.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const participant = (id: string) => id as BranchProtocol.ParticipantId

let nextSourceSeq = 0

const entry = (fields: {
  readonly seq: number
  readonly payload: unknown
  readonly runId?: JournalEvent.RunId
  readonly eventType?: string
  readonly participantId?: string
}) =>
  TestEntry.entry(fields.runId ?? runId, fields.seq, {
    eventId: `event-${fields.seq}`,
    sourceId: BranchProtocol.commandSourceId(`event-${fields.seq}` as BranchProtocol.CommandId),
    sourceSeq: (nextSourceSeq += 1) as JournalEvent.SourceSeq,
    eventType: fields.eventType ?? BranchProtocol.CommandEvent,
    payload: fields.payload
  })

const command = (fields: {
  readonly seq: number
  readonly commandId: string
  readonly participantId?: string
  readonly name?: string
  readonly args?: string
  readonly target?: string
}) =>
  entry({
    seq: fields.seq,
    ...(fields.participantId === undefined ? {} : { participantId: fields.participantId }),
    payload: {
      branchId,
      commandId: fields.commandId,
      participantId: fields.participantId ?? "alice",
      name: fields.name ?? BranchProtocol.SayCommand,
      args: fields.args ?? "",
      target: fields.target ?? ""
    }
  })

const field = (fields: { readonly seq: number; readonly participantId: string }): BranchProjection.Field => ({
  target: "title",
  value: `by-${fields.participantId}`,
  seq: fields.seq as JournalEvent.Seq,
  participantId: participant(fields.participantId),
  capabilityId: ""
})

describe("BranchProjection", () => {
  // Throughput lives in BranchProjection.bench.ts; a wall-clock bound here
  // fails on a loaded host with no code change.
  it("rebuilds 10,000 ordered chat commands in one pass over the entries", () => {
    const entries = Array.from(
      { length: 10_000 },
      (_, seq) => command({ seq, commandId: `c-${seq}`, args: `message ${seq}` })
    )
    let reads = 0
    const counted: Iterable<JournalEvent.Entry> = {
      *[Symbol.iterator]() {
        for (const entry of entries) {
          reads++
          yield entry
        }
      }
    }
    const state = BranchProjection.project(branchId, counted)

    expect(reads).toBe(10_000)
    expect(state.seq).toBe(9_999)
    expect(state.commands).toHaveLength(10_000)
    expect(state.messages).toHaveLength(10_000)
    expect(state.messages[9_999]?.text).toBe("message 9999")
  })

  it("matches incremental folding for shuffled, repeated, and uninterpretable entries", () => {
    const entries = Array.from({ length: 64 }, (_, seq) =>
      command({
        seq,
        commandId: `c-${seq}`,
        participantId: seq % 2 === 0 ? "alice" : "bob",
        name: seq % 3 === 0 ? "branch.edit" : BranchProtocol.SayCommand,
        args: `value ${seq}`,
        target: seq % 3 === 0 ? `field-${seq % 5}` : ""
      }))
    const expected = BranchProjection.project(branchId, entries)
    // Multiplication by an odd number permutes all 64 indices.
    const shuffled = entries.map((_, index) => entries[(index * 37) % entries.length]!)
    const delivered = [...shuffled, ...shuffled].flatMap((item) => [item, item])
    expect(BranchProjection.project(branchId, delivered)).toEqual(expected)
    expect(delivered.reduce(BranchProjection.apply, BranchProjection.empty(branchId))).toEqual(expected)

    const mixed = [
      ...delivered,
      entry({ seq: 64, payload: null }),
      entry({ seq: 65, eventType: "engine/step", payload: null }),
      entry({ seq: 90, runId: BranchProtocol.branchRunId("foreign" as BranchProtocol.BranchId), payload: null }),
      command({ seq: 66, commandId: "c-0" }),
      command({ seq: 66, commandId: "cursor-tip" })
    ]
    const projected = BranchProjection.project(branchId, mixed)
    expect(projected).toEqual(mixed.reduce(BranchProjection.apply, BranchProjection.empty(branchId)))
    expect(projected).toEqual({ ...expected, seq: 66 })
  })

  it("keeps prior states and independent continuations immutable, including restored states", () => {
    const first = command({ seq: 3, commandId: "first", args: "original", target: "title" })
    const last = command({ seq: 9, commandId: "last", args: "newest", target: "title" })
    const projected = BranchProjection.project(branchId, [first, last])
    const restored = Schema.decodeUnknownSync(BranchProjection.State)(JSON.parse(JSON.stringify(projected)))

    for (const base of [projected, restored]) {
      Object.freeze(base.commands)
      Object.freeze(base.messages)
      Object.freeze(base.fields)
      Object.freeze(base)
      const snapshot = JSON.stringify(base)
      const early = command({ seq: 1, commandId: "early", target: "title", args: "oldest" })
      const middle = command({ seq: 6, commandId: "middle", args: "middle" })
      const append = command({ seq: 10, commandId: "append", name: "goal" })
      const left = BranchProjection.apply(base, early)
      const right = BranchProjection.apply(base, middle)
      const advanced = BranchProjection.apply(base, append)

      expect(left).toEqual(BranchProjection.project(branchId, [early, first, last]))
      expect(right).toEqual(BranchProjection.project(branchId, [first, middle, last]))
      expect(advanced).toEqual(BranchProjection.project(branchId, [first, last, append]))
      expect(BranchProjection.apply(right, early)).toEqual(BranchProjection.apply(left, middle))
      expect(BranchProjection.apply(advanced, command({ seq: 11, commandId: "first" })))
        .toEqual({ ...advanced, seq: 11 })
      expect(JSON.stringify(base)).toBe(snapshot)
    }
  })

  it("folds commands into an ordered chat projection", () => {
    const state = BranchProjection.project(branchId, [
      command({ seq: 0, commandId: "c1", args: "hello" }),
      command({ seq: 1, commandId: "c2", participantId: "bob", args: "hi back" }),
      command({ seq: 2, commandId: "c3", name: "goal", args: "ship it" })
    ])

    expect(state.seq).toBe(2)
    expect(state.messages.map((message) => message.text)).toEqual(["hello", "hi back"])
    expect(state.messages[1]?.participantId).toBe("bob")
    expect(state.commands.map((applied) => applied.name)).toEqual([
      BranchProtocol.SayCommand,
      BranchProtocol.SayCommand,
      "goal"
    ])
  })

  it("converges regardless of how many times a frame is delivered", () => {
    const entries = [
      command({ seq: 0, commandId: "c1", args: "hello" }),
      command({ seq: 1, commandId: "c2", args: "world" })
    ]
    const once = BranchProjection.project(branchId, entries)
    const thrice = BranchProjection.project(branchId, [...entries, ...entries, ...entries])

    expect(thrice).toEqual(once)
  })

  it("converges regardless of the order frames are delivered in", () => {
    const entries = [
      command({ seq: 0, commandId: "c1", args: "first" }),
      command({ seq: 1, commandId: "c2", participantId: "bob", args: "second" }),
      command({ seq: 2, commandId: "c3", args: "third" })
    ]
    const inOrder = BranchProjection.project(branchId, entries)
    const reversed = BranchProjection.project(branchId, [...entries].reverse())
    const interleaved = BranchProjection.project(branchId, [entries[2]!, entries[0]!, entries[2]!, entries[1]!])

    expect(reversed).toEqual(inOrder)
    expect(interleaved).toEqual(inOrder)
    expect(inOrder.messages.map((message) => message.text)).toEqual(["first", "second", "third"])
  })

  it("ignores a redelivery of the cursor tip, so a resumed read replays nothing", () => {
    const applied = BranchProjection.project(branchId, [command({ seq: 4, commandId: "c1", args: "hello" })])
    const replayed = BranchProjection.apply(applied, command({ seq: 4, commandId: "c-other", args: "again" }))

    expect(replayed).toBe(applied)
    expect(replayed.messages).toHaveLength(1)
  })

  it("ignores a command id it already applied even when the sequence advanced", () => {
    const state = BranchProjection.project(branchId, [
      command({ seq: 0, commandId: "c1", args: "hello" }),
      command({ seq: 1, commandId: "c1", args: "hello" })
    ])

    expect(state.seq).toBe(1)
    expect(state.messages).toHaveLength(1)
  })

  it("ignores entries belonging to another branch's run", () => {
    const foreign = BranchProtocol.branchRunId("other-branch" as BranchProtocol.BranchId)
    const state = BranchProjection.apply(
      BranchProjection.empty(branchId),
      entry({ seq: 0, runId: foreign, payload: { commandId: "c1", participantId: "mallory", name: "branch.say" } })
    )

    expect(state).toEqual(BranchProjection.empty(branchId))
  })

  it("advances the cursor past entries it cannot interpret", () => {
    const undecodable: ReadonlyArray<JournalEvent.Entry> = [
      entry({ seq: 0, eventType: "flows/engine/step", payload: { commandId: "c0", participantId: "a", name: "n" } }),
      entry({ seq: 1, payload: "not an object" }),
      entry({ seq: 2, payload: null }),
      entry({ seq: 3, payload: { participantId: "alice", name: "branch.say" } }),
      entry({ seq: 4, payload: { commandId: "c4", name: "branch.say" } }),
      entry({ seq: 5, payload: { commandId: "c5", participantId: "alice" } })
    ]
    const state = BranchProjection.project(branchId, undecodable)

    expect(state.seq).toBe(5)
    expect(state.commands).toEqual([])
  })

  it("defaults absent optional command fields instead of dropping the command", () => {
    const state = BranchProjection.project(branchId, [
      entry({ seq: 0, payload: { commandId: "c1", participantId: "alice", name: "branch.rename" } })
    ])

    expect(state.commands).toEqual([
      { seq: 0, commandId: "c1", participantId: "alice", name: "branch.rename", args: "", target: "", capabilityId: "" }
    ])
  })

  it("resolves conflicting durable edits by highest sequence, then by participant", () => {
    expect(BranchProjection.resolveField(undefined, field({ seq: 1, participantId: "alice" }))).toEqual(
      field({ seq: 1, participantId: "alice" })
    )
    expect(
      BranchProjection.resolveField(field({ seq: 1, participantId: "alice" }), field({ seq: 2, participantId: "bob" }))
    ).toEqual(field({ seq: 2, participantId: "bob" }))
    expect(
      BranchProjection.resolveField(field({ seq: 2, participantId: "bob" }), field({ seq: 1, participantId: "alice" }))
    ).toEqual(field({ seq: 2, participantId: "bob" }))
    expect(
      BranchProjection.resolveField(field({ seq: 1, participantId: "alice" }), field({ seq: 1, participantId: "bob" }))
    ).toEqual(field({ seq: 1, participantId: "bob" }))
    expect(
      BranchProjection.resolveField(field({ seq: 1, participantId: "bob" }), field({ seq: 1, participantId: "alice" }))
    ).toEqual(field({ seq: 1, participantId: "bob" }))
  })

  it("keeps one deterministic winner per edited field, sorted by target", () => {
    const state = BranchProjection.project(branchId, [
      command({ seq: 0, commandId: "e1", name: "branch.rename", args: "Alice's title", target: "title" }),
      command({ seq: 1, commandId: "e2", name: "branch.note", args: "shared note", target: "note" }),
      command({
        seq: 2,
        commandId: "e3",
        participantId: "bob",
        name: "branch.rename",
        args: "Bob's title",
        target: "title"
      }),
      command({ seq: 3, commandId: "e4", name: "branch.assign", args: "alice", target: "assignee" })
    ])

    expect(state.fields).toEqual([
      { target: "assignee", value: "alice", seq: 3, participantId: "alice", capabilityId: "" },
      { target: "note", value: "shared note", seq: 1, participantId: "alice", capabilityId: "" },
      { target: "title", value: "Bob's title", seq: 2, participantId: "bob", capabilityId: "" }
    ])
  })

  it("starts empty at a cursor of -1", () => {
    expect(BranchProjection.empty(branchId)).toEqual({
      branchId,
      seq: -1,
      messages: [],
      commands: [],
      fields: []
    })
  })
})
