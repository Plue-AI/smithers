import { describe, expect, spyOn, test } from "bun:test"
import type { AppTransition } from "./AppState"
import { emptyAppProjection, seedAppProjection } from "./AppProjection"
import { digest } from "@smthrs/core/Digest"
import { canonicalEventValue, encodeEventValue } from "./EventValue"
import { freezeProjectionValue } from "./ImmutableProjection"
import {
  appendAppEvent, appProjectionHash, createAppCheckpoint, initializeAppStream,
  normalizeAppProjection, replayAppEvents, verifyAppProjection, StoredAppEventRecordSchema, AppEventRecordSchema,
  type AppEventRecord, type AppStreamState
} from "./AppEventStream"

const fixture = () => initializeAppStream(seedAppProjection(emptyAppProjection(), { createdAt: 100, theme: "light" }), "stream-a", "created")
const append = (state: AppStreamState, transition: AppTransition) => appendAppEvent(state, { kind: "transition", transition }, {
  eventId: `event-${state.head.sequence + 1}`, createdAt: 101 + state.head.sequence, persistenceMode: "localStorage"
})!
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe("authoritative app event stream", () => {
  test("reconstructs the whole state from facts after diagnostic history has been trimmed", () => {
    const initial = fixture()
    let current: AppStreamState = initial
    const events: AppEventRecord[] = []
    current = append(current, { type: "message.submitted", actor: "user", turnId: "durable-turn", text: "Retain this first fact" })
    events.push((current as ReturnType<typeof append>).event)
    for (let index = 0; index < 505; index += 1) {
      const next = append(current, { type: "message.response.delta", actor: "smithers", turnId: "durable-turn", channel: "text", delta: `${index},` })
      current = next; events.push(next.event)
    }
    const finished = append(current, { type: "message.response.completed", actor: "smithers", turnId: "durable-turn" })
    events.push(finished.event)
    expect(finished.snapshot.transitions).toHaveLength(500)
    expect(finished.snapshot.transitions[0]!.revision).toBeGreaterThan(1)
    const replayed = replayAppEvents(wire(initial.checkpoint), wire(events), wire(finished.head))
    expect(verifyAppProjection(replayed, finished.snapshot).valid).toBe(true)
    expect(replayed.snapshot.messages.find(row => row.id === "message-durable-turn-user")?.text).toBe("Retain this first fact")
    expect(replayed.snapshot.messages.find(row => row.id === "message-durable-turn-smithers")?.text).toEndWith("504,")
    expect(() => replayAppEvents(initial.checkpoint, events.slice(1), finished.head)).toThrow("gap")
  }, 30_000)

  test("the upgrade reader accepts retired budgets but new events never emit them", () => {
    const next = append(fixture(), { type: "composer.changed", actor: "user", draft: "kept" })
    expect(Object.hasOwn(next.event, "journalBudgetBytes")).toBe(false)
    expect(StoredAppEventRecordSchema.parse({ ...next.event, projectorVersion: 15, journalBudgetBytes: 400 }).journalBudgetBytes).toBe(400)
    expect(AppEventRecordSchema.safeParse({ ...next.event, journalBudgetBytes: 400 }).success).toBe(false)
  })

  test("checkpoint plus suffix equals full replay, allowing duplicate delivery and unordered batches", () => {
    const initial = fixture()
    const first = append(initial, { type: "composer.changed", actor: "user", draft: "A draft" })
    const checkpoint = createAppCheckpoint(first, "compaction")
    const second = append(first, { type: "theme.changed", actor: "user", theme: "dark" })
    const third = append(second, { type: "plugin.installed", actor: "user", plugin: "wiki" })
    const full = replayAppEvents(initial.checkpoint, [third.event, first.event, second.event, second.event], third.head)
    const suffix = replayAppEvents(checkpoint, [third.event, second.event, second.event], third.head)
    expect(appProjectionHash(full.snapshot)).toBe(appProjectionHash(suffix.snapshot))
    expect(verifyAppProjection(full, third.snapshot).valid).toBe(true)
  })

  test("explicit card payload clears remain distinct from omitted fields after reload", () => {
    const initial = fixture()
    const first = append(initial, { type: "card.upsert", actor: "system", card: {
      id: "comment", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 0,
      payload: { repo: "org/repo", path: "a.ts", content: "line one", truncated: false, line: 3 }
    } })
    const second = append(first, { type: "card.updated", actor: "system", id: "comment", patch: {
      payload: { line: undefined }
    } })
    const replayed = replayAppEvents(initial.checkpoint, wire([first.event, second.event]), second.head)
    expect(verifyAppProjection(replayed, second.snapshot).valid).toBe(true)
    const card = replayed.snapshot.cards.find(row => row.id === "comment")!
    expect(card.kind).toBe("file")
    expect(card.payload).toMatchObject({ repo: "org/repo", path: "a.ts", content: "line one", truncated: false })
    expect(card.payload).toHaveProperty("line", undefined)
  })

  test("refuses changed bytes, scope/version mismatches, missing tails and conflicting positions", () => {
    const initial = fixture()
    const first = append(initial, { type: "theme.changed", actor: "user", theme: "dark" })
    const other = append(initial, { type: "plugin.installed", actor: "user", plugin: "wiki" })
    expect(() => replayAppEvents(initial.checkpoint, [{ ...first.event, actor: "system" }], first.head)).toThrow("event")
    expect(() => replayAppEvents(initial.checkpoint, [{ ...first.event, formatVersion: 100 }], first.head)).toThrow("format")
    expect(() => replayAppEvents(initial.checkpoint, [first.event, other.event], first.head)).toThrow("conflict")
    expect(() => replayAppEvents(initial.checkpoint, [], first.head)).toThrow("head")
    expect(() => replayAppEvents(initial.checkpoint, [first.event], { ...first.head, streamId: "different" })).toThrow("scope")
    const corrupted = wire(initial.checkpoint); corrupted.snapshot.messages = []
    corrupted.snapshot.sessions = []
    expect(() => replayAppEvents(corrupted, [first.event], first.head)).toThrow("checkpoint")
  })

  test("verification finds missing, extra and modified projections without returning private values", () => {
    const initial = fixture()
    const current = append(initial, { type: "message.submitted", actor: "user", turnId: "private-turn", text: "private text" })
    const actual = wire(current.snapshot)
    const tampered = { ...actual, messages: [], sessions: actual.sessions.map(row => ({ ...row, draft: "private draft" })),
      starredTargets: [{ id: "extra", repoKey: "org/repo", label: "//:extra", starredAt: 1 }] }
    const proof = verifyAppProjection(current, tampered)
    expect(proof.valid).toBe(false)
    expect(proof.differences).toContainEqual({ collection: "messages", key: "message-private-turn-user", kind: "missing" })
    expect(proof.differences).toContainEqual({ collection: "sessions", key: "main", kind: "changed" })
    expect(proof.differences).toContainEqual({ collection: "starredTargets", key: "extra", kind: "extra" })
    expect(JSON.stringify(proof)).not.toContain("private text")
    expect(JSON.stringify(proof)).not.toContain("private draft")
  })

  test("replay is detached from clocks and host effects", () => {
    const initial = fixture()
    const first = append(initial, { type: "theme.changed", actor: "user", theme: "dark" })
    const second = append(first, { type: "identity.session.cleared", actor: "user" })
    const clock = spyOn(Date, "now").mockImplementation(() => { throw new Error("replay read clock") })
    const debug = spyOn(console, "debug").mockImplementation(() => { throw new Error("replay logged") })
    try {
      expect(verifyAppProjection(replayAppEvents(initial.checkpoint, [first.event, second.event], second.head), second.snapshot).valid).toBe(true)
    } finally { clock.mockRestore(); debug.mockRestore() }
  })

  test("normalization rejects duplicate identities and stream append refuses unverified state", () => {
    const initial = fixture()
    expect(() => normalizeAppProjection({ ...initial.snapshot, sessions: [...initial.snapshot.sessions, ...initial.snapshot.sessions] })).toThrow("projection")
    const tampered = { ...initial, snapshot: { ...initial.snapshot, messages: [{ id: "unknown" }] } } as unknown as AppStreamState
    expect(() => append(tampered, { type: "theme.changed", actor: "user", theme: "dark" })).toThrow("projection")
  })

  test("optimized projection hashes preserve v1 bytes and never trust mutable row identity", () => {
    const initial = fixture()
    const current = append(initial, { type: "card.upsert", actor: "system", card: {
      id: "file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 0,
      payload: { repo: "org/repo", path: "a.ts", content: "private text", truncated: false, line: undefined }
    } })
    const oldRepresentation = Object.fromEntries(Object.entries(current.snapshot).map(([name, rows]) => [name,
      rows.map(row => [name === "githubAppStatuses" ? (row as { repo: string }).repo : (row as { id: string }).id,
        JSON.parse(JSON.stringify(row))] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]))
    const oldHash = digest(`smithers-app/projection/v1:${canonicalEventValue(oldRepresentation)}`)
    expect(appProjectionHash(current.snapshot)).toBe(oldHash)
    current.snapshot.cards[0]!.title = "Mutated behind the journal"
    expect(appProjectionHash(current.snapshot)).not.toBe(oldHash)
    expect(() => append(current, { type: "theme.changed", actor: "user", theme: "dark" })).toThrow("projection")
  })

  test("only recursively immutable snapshots reuse hashes and copy-on-write successors still verify", () => {
    const initial = fixture()
    const first = append(initial, { type: "card.upsert", actor: "system", card: {
      id: "file", kind: "file", title: "File", status: "active", createdAt: 1, ordinal: 0,
      payload: { repo: "org/repo", path: "a.ts", content: "original", truncated: false }
    } })
    const mutableHash = appProjectionHash(first.snapshot)
    Object.freeze(first.snapshot.cards[0])
    const payload = first.snapshot.cards[0]!.payload as { content: string }
    payload.content = "changed beneath a shallow freeze"
    expect(appProjectionHash(first.snapshot)).not.toBe(mutableHash)

    const owned = fixture()
    freezeProjectionValue(owned.snapshot)
    expect(appProjectionHash(owned.snapshot)).toBe(appProjectionHash(structuredClone(owned.snapshot)))
    expect(Reflect.set(owned.snapshot.sessions[0]!, "draft", "cannot mutate")).toBe(false)
    const next = append(owned, { type: "theme.changed", actor: "user", theme: "dark" })
    expect(Object.isFrozen(next.snapshot)).toBe(true)
    expect(Object.isFrozen(next.snapshot.sessions[0])).toBe(true)
    expect(appProjectionHash(next.snapshot)).toBe(appProjectionHash(structuredClone(next.snapshot)))
    expect(verifyAppProjection(replayAppEvents(owned.checkpoint, [next.event], next.head), next.snapshot).valid).toBe(true)
    expect(owned.snapshot.sessions[0]?.theme).toBe("light")
  })

  test("append and replay reject semantically invalid payloads and forbidden actors", () => {
    const initial = fixture()
    for (const transition of [
      { type: "flow.invoked", actor: "user", name: "help", args: null, hidden: true, outcome: "invented", detail: null, durationMs: 1 },
      { type: "theme.changed", actor: "smithers", theme: "dark" },
      { type: "composer.changed", actor: "user", draft: 123 },
      { type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: "false", scopesPlain: null }
    ]) expect(() => append(initial, transition as unknown as AppTransition)).toThrow("event")
    const valid = append(initial, { type: "theme.changed", actor: "user", theme: "dark" })
    // A recomputed checksum cannot turn a forbidden actor into an admissible domain fact.
    const { hash: _hash, ...body } = { ...valid.event, actor: "smithers" as const,
      input: encodeEventValue({ type: "theme.changed", actor: "smithers", theme: "dark" }) }
    const forged = { ...body, hash: digest(`smithers-app/event/v1:${canonicalEventValue(body)}`) }
    expect(() => replayAppEvents(initial.checkpoint, [forged], { ...valid.head, eventHash: forged.hash })).toThrow("event")
  })
})
