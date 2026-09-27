import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  compare,
  compareVersion,
  containers,
  decode,
  reference,
  type SourceRecord,
  supersedes,
  tombstone
} from "../src/core/SourceRecord.ts"

const record = (overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  provider: "example",
  connectionId: "team-chat",
  externalId: "m-1",
  kind: "message",
  url: "https://chat.example.test/m-1",
  author: { id: "u-1", label: "builder" },
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  version: null,
  retrievedAtMs: 2_000,
  access: { scope: "container", containerId: "c-general" },
  thread: { containerId: "c-general", threadId: null, parentId: null },
  text: "hello",
  deleted: false,
  payload: { text: "hello" },
  ...overrides
})

describe("compareVersion", () => {
  it("sorts a missing token first and equal tokens level", () => {
    expect(compareVersion(null, null)).toBe(0)
    expect(compareVersion(null, "1")).toBe(-1)
    expect(compareVersion("1", null)).toBe(1)
    expect(compareVersion("abc", "abc")).toBe(0)
  })

  // Slack's `ts` is seconds with a microsecond fraction. A float comparison
  // would merge two distinct values; a string comparison would misorder
  // different integer widths.
  it("compares decimal tokens as numbers without floating point", () => {
    expect(compareVersion("9.75", "10.5")).toBe(-1)
    expect(compareVersion("10.5", "9.75")).toBe(1)
    expect(compareVersion("1712345678.000200", "1712345678.000100")).toBe(1)
    expect(compareVersion("1712345678.0001", "1712345678.000100")).toBe(-1)
    expect(compareVersion("0012", "12.1")).toBe(-1)
    expect(compareVersion("12", "12.000001")).toBe(-1)
    expect(compareVersion("7", "8")).toBe(-1)
  })

  it("falls back to code-unit order for non-decimal and numerically equal tokens", () => {
    expect(compareVersion("\"etag-b\"", "\"etag-a\"")).toBe(1)
    expect(compareVersion("\"etag-a\"", "\"etag-b\"")).toBe(-1)
    // Numerically equal spellings still resolve deterministically.
    expect(compareVersion("1.0", "1")).toBe(1)
    expect(compareVersion("1", "1.0")).toBe(-1)
  })
})

describe("compare and supersedes", () => {
  it("orders by change time first, with a missing time oldest", () => {
    const older = record({ updatedAtMs: 1_000, version: "9" })
    const newer = record({ updatedAtMs: 2_000, version: "1" })
    expect(compare(older, newer)).toBe(1)
    expect(compare(newer, older)).toBe(-1)
    expect(compare(record({ updatedAtMs: null }), older)).toBe(1)
    expect(compare(older, record({ updatedAtMs: null }))).toBe(-1)
    expect(supersedes(older, newer)).toBe(true)
    expect(supersedes(newer, older)).toBe(false)
  })

  it("lets a deletion follow the live copy at the same time", () => {
    const live = record()
    const gone = tombstone(live, 1_000)
    expect(compare(live, gone)).toBe(1)
    expect(compare(gone, live)).toBe(-1)
  })

  it("orders copies without a change time by version before deletion (#2175)", () => {
    const live = (version: string) => record({ updatedAtMs: null, version })
    const gone = (version: string) => record({ updatedAtMs: null, version, deleted: true, text: "", payload: null })
    expect(supersedes(live("10"), gone("11"))).toBe(true)
    expect(supersedes(gone("11"), live("12"))).toBe(true)
    expect(supersedes(gone("11"), live("10"))).toBe(false)
    expect(supersedes(live("11"), gone("11"))).toBe(true)
  })

  it("orders equal times and deletion by version, and a duplicate never supersedes", () => {
    expect(supersedes(record({ version: "1.1" }), record({ version: "1.2" }))).toBe(true)
    expect(supersedes(record({ version: "1.2" }), record({ version: "1.1" }))).toBe(false)
    expect(supersedes(record(), record())).toBe(false)
    expect(compare(record(), record({ text: "different", retrievedAtMs: 9_999 }))).toBe(0)
  })
})

describe("tombstone", () => {
  it("keeps identity, placement, times and version and nothing else", () => {
    const live = record({ version: "3", createdAtMs: 500, updatedAtMs: 1_000 })
    const gone = tombstone(live, 4_000, 4_500)
    expect(gone).toEqual({
      provider: "example",
      connectionId: "team-chat",
      externalId: "m-1",
      kind: "message",
      url: null,
      author: null,
      createdAtMs: 500,
      updatedAtMs: 4_000,
      version: "3",
      retrievedAtMs: 4_500,
      access: live.access,
      thread: live.thread,
      text: "",
      deleted: true,
      payload: null
    })
    expect(supersedes(live, gone)).toBe(true)
  })

  it("builds from a bare identity and never predates the version it removes", () => {
    const gone = tombstone({
      provider: "example",
      connectionId: "team-chat",
      externalId: "m-2",
      kind: "message",
      access: { scope: "private", containerId: null },
      thread: { containerId: null, threadId: null, parentId: null }
    }, 3_000)
    expect(gone).toMatchObject({ createdAtMs: null, updatedAtMs: 3_000, version: null, retrievedAtMs: 3_000 })
    // A deletion stamped before the stored edit still removes that edit.
    expect(tombstone(record({ updatedAtMs: 5_000 }), 3_000).updatedAtMs).toBe(5_000)
    expect(Effect.runSync(decode(gone))).toEqual(gone)
  })
})

describe("containers and reference", () => {
  it("lists the access and thread containers once each", () => {
    expect(containers(record())).toEqual(["c-general"])
    expect(containers(record({
      access: { scope: "container", containerId: "c-a" },
      thread: { containerId: "c-b", threadId: null, parentId: null }
    }))).toEqual(["c-a", "c-b"])
    expect(containers(record({
      access: { scope: "private", containerId: null },
      thread: { containerId: null, threadId: null, parentId: null }
    }))).toEqual([])
  })

  it("points at one retrieved copy", () => {
    expect(reference(record({ version: "2" }))).toEqual({
      connectionId: "team-chat",
      externalId: "m-1",
      updatedAtMs: 1_000,
      version: "2",
      retrievedAtMs: 2_000
    })
  })
})
