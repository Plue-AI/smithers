import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { IntegrationError } from "../src/core/IntegrationError.ts"
import { reference, type SourceRecord, tombstone } from "../src/core/SourceRecord.ts"
import { covers, cursorKey, type Grant, layerMemory, MAX_RETRIEVE_LIMIT, SourceStore } from "../src/core/SourceStore.ts"
import type { Changes } from "../src/core/Sync.ts"
import { inContainer, record, runWith, sqlLayer } from "./SourceStoreFixtures.ts"

const general: ReadonlyArray<Grant> = [{ connectionId: "team-chat", containers: ["c-general"] }]
const everything: ReadonlyArray<Grant> = [{ connectionId: "team-chat", containers: ["*"] }]

const page = (changes: Partial<Changes> & Pick<Changes, "records">, stream = "c-general") => ({
  provider: "example",
  connectionId: "team-chat",
  stream,
  changes: { cursor: null, reset: false, done: true, ...changes }
})

describe("covers", () => {
  it("needs a grant for the connection that covers every container the record lives in", () => {
    const split = record({
      access: { scope: "container", containerId: "c-a" },
      thread: { containerId: "c-b", threadId: null, parentId: null }
    })
    expect(covers(general, record())).toBe(true)
    expect(covers([{ connectionId: "other", containers: ["*"] }], record())).toBe(false)
    expect(covers([{ connectionId: "team-chat", containers: ["c-a"] }], split)).toBe(false)
    expect(covers([{ connectionId: "team-chat", containers: ["c-a", "c-b"] }], split)).toBe(true)
    expect(covers([{ connectionId: "team-chat", containers: [] }], record())).toBe(false)
    // A record in no container is readable only connection-wide.
    expect(covers([{ connectionId: "team-chat", containers: ["c-general"] }], inContainer(null))).toBe(false)
    expect(covers(everything, inContainer(null))).toBe(true)
    expect(cursorKey("team-chat", "c-general")).toBe("team-chat:c-general")
  })
})

const contract = (name: string, layer: Layer.Layer<SourceStore>) => {
  const run = runWith(layer)
  const store = SourceStore

  describe(name, () => {
    it("inserts a record and reads it back", async () => {
      const [report, stored] = await run(Effect.gen(function*() {
        const s = yield* store
        const report = yield* s.apply([record()])
        return [report, yield* s.get("team-chat", "m-1")] as const
      }))
      expect(report).toEqual({ inserted: 1, updated: 0, unchanged: 0, tombstoned: 0 })
      expect(Option.getOrThrow(stored)).toEqual({ record: record(), revoked: false, stream: null })
    })

    it("answers none for a record it never stored", async () => {
      expect(Option.isNone(await run(Effect.flatMap(store, (s) => s.get("team-chat", "absent"))))).toBe(true)
    })

    it("treats a duplicate delivery as unchanged", async () => {
      const second = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record()])
        return yield* s.apply([record(), record()])
      }))
      expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 2, tombstoned: 0 })
    })

    it("converges on the newest edit whichever order the edits arrive in", async () => {
      const v1 = record({ updatedAtMs: 1_000, text: "first" })
      const v2 = record({ updatedAtMs: 2_000, text: "second" })
      const v3 = record({ updatedAtMs: 3_000, text: "third" })
      const [forward, backward, reports] = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([v1, v2, v3])
        const forward = yield* s.get("team-chat", "m-1")
        const reports = [
          yield* s.apply([{ ...v2, externalId: "m-2" }]),
          yield* s.apply([{ ...v3, externalId: "m-2" }]),
          yield* s.apply([{ ...v1, externalId: "m-2" }])
        ]
        return [forward, yield* s.get("team-chat", "m-2"), reports] as const
      }))
      expect(Option.getOrThrow(forward).record.text).toBe("third")
      expect(Option.getOrThrow(backward).record.text).toBe("third")
      expect(reports.map((report) => [report.inserted, report.updated, report.unchanged])).toEqual([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ])
    })

    it("orders equal change times by version", async () => {
      const text = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record({ version: "1712345678.000200", text: "later" })])
        yield* s.apply([record({ version: "1712345678.000100", text: "earlier" })])
        return Option.getOrThrow(yield* s.get("team-chat", "m-1")).record.text
      }))
      expect(text).toBe("later")
    })

    // Two edits inside the provider's clock resolution carry the same change
    // time. The fresher observation with different content wins; an older one
    // arriving late does not.
    it("takes a fresher, different observation of an equal copy and ignores a staler one", async () => {
      const [fresher, stale] = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record({ text: "first edit", retrievedAtMs: 2_000 })])
        const fresher = yield* s.apply([record({ text: "second edit", retrievedAtMs: 3_000 })])
        const stale = yield* s.apply([record({ text: "first edit", retrievedAtMs: 2_500 })])
        return [fresher, stale] as const
      }))
      expect(fresher.updated).toBe(1)
      expect(stale.unchanged).toBe(1)
      const text = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record({ text: "first edit", retrievedAtMs: 2_000 })])
        yield* s.apply([record({ text: "second edit", retrievedAtMs: 3_000 })])
        yield* s.apply([record({ text: "first edit", retrievedAtMs: 2_500 })])
        // The same content observed again later is not a change.
        const again = yield* s.apply([record({ text: "second edit", retrievedAtMs: 9_000 })])
        return [Option.getOrThrow(yield* s.get("team-chat", "m-1")).record, again] as const
      }))
      expect(text[0]).toMatchObject({ text: "second edit", retrievedAtMs: 3_000 })
      expect(text[1].unchanged).toBe(1)
      const anonymous = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record({ author: null, retrievedAtMs: 2_000 })])
        return [
          yield* s.apply([record({ author: null, retrievedAtMs: 3_000 })]),
          yield* s.apply([record({ author: { id: "u-2", label: null }, retrievedAtMs: 4_000 })])
        ]
      }))
      expect(anonymous.map((report) => [report.updated, report.unchanged])).toEqual([[0, 1], [1, 0]])
    })

    it("stores a deletion as a tombstone with its content purged, and a later edit restores it", async () => {
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record()])
        // A deletion as a provider reports it may still carry content; the store drops it.
        const deletion = yield* s.apply([{ ...record(), deleted: true, updatedAtMs: 1_500 }])
        const stored = yield* s.get("team-chat", "m-1")
        const visible = yield* s.retrieve({ allowed: general, limit: 10 })
        const stale = yield* s.apply([record()])
        const restored = yield* s.apply([record({ updatedAtMs: 5_000, text: "restored" })])
        return { deletion, stored, visible, stale, restored, after: yield* s.retrieve({ allowed: general, limit: 10 }) }
      }))
      expect(result.deletion).toEqual({ inserted: 0, updated: 1, unchanged: 0, tombstoned: 1 })
      expect(Option.getOrThrow(result.stored).record).toMatchObject({
        deleted: true,
        text: "",
        payload: null,
        url: null,
        author: null,
        updatedAtMs: 1_500
      })
      expect(result.visible).toEqual([])
      expect(result.stale.unchanged).toBe(1)
      expect(result.after.map((found) => found.text)).toEqual(["restored"])
    })

    it("lets a tombstone that arrives before its record win over the stale copy", async () => {
      const [report, stored] = await run(Effect.gen(function*() {
        const s = yield* store
        const report = yield* s.apply([tombstone(record(), 1_500), record()])
        return [report, yield* s.get("team-chat", "m-1")] as const
      }))
      expect(report).toEqual({ inserted: 1, updated: 0, unchanged: 1, tombstoned: 1 })
      expect(Option.getOrThrow(stored).record.deleted).toBe(true)
    })

    it("refuses a batch holding an invalid record and writes none of it", async () => {
      const [failure, stored] = await run(Effect.gen(function*() {
        const s = yield* store
        const failure = yield* Effect.flip(s.apply([record(), record({ externalId: "" })]))
        return [failure, yield* s.get("team-chat", "m-1")] as const
      }))
      expect(failure.reason).toBe("decode-failed")
      expect(Option.isNone(stored)).toBe(true)
    })

    it("refuses a record whose identity is not even a string, without echoing it", async () => {
      const failure = await run(
        Effect.flatMap(store, (s) => Effect.flip(s.apply([record({ externalId: 42 as never })])))
      )
      expect(failure.reason).toBe("decode-failed")
      expect(failure.details?.["externalId"]).toBeNull()
    })

    it("refuses a time that is not a finite number", async () => {
      const failures = await run(Effect.gen(function*() {
        const s = yield* store
        return [
          yield* Effect.flip(s.apply([record({ updatedAtMs: Number.NaN })])),
          yield* Effect.flip(s.apply([record({ createdAtMs: Number.POSITIVE_INFINITY })])),
          yield* Effect.flip(s.apply([record({ retrievedAtMs: Number.NaN })]))
        ]
      }))
      expect(failures.map((failure) => [failure.reason, failure.details?.["externalId"]])).toEqual([
        ["decode-failed", "m-1"],
        ["decode-failed", "m-1"],
        ["decode-failed", "m-1"]
      ])
    })

    it("retrieves only what the grants cover, filtering before any text is returned", async () => {
      const found = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([
          inContainer("c-general", { externalId: "general", updatedAtMs: 3_000 }),
          inContainer("c-random", { externalId: "random", updatedAtMs: 2_000 }),
          inContainer(null, { externalId: "direct", updatedAtMs: 4_000 }),
          record({
            externalId: "split",
            access: { scope: "container", containerId: "c-general" },
            thread: { containerId: "c-random", threadId: null, parentId: null }
          }),
          inContainer("c-general", { connectionId: "other-chat", externalId: "elsewhere" }),
          inContainer("c-general", { connectionId: "another-chat", externalId: "zzz" }),
          inContainer("c-general", { connectionId: "another-chat", externalId: "a2", updatedAtMs: 700 }),
          inContainer("c-general", { connectionId: "other-chat", externalId: "o2", updatedAtMs: 700 })
        ])
        const ids = (records: ReadonlyArray<SourceRecord>) => records.map((found) => found.externalId)
        return {
          general: ids(yield* s.retrieve({ allowed: general, limit: 10 })),
          both: ids(
            yield* s.retrieve({
              allowed: [{ connectionId: "team-chat", containers: ["c-general", "c-random"] }],
              limit: 10
            })
          ),
          everything: ids(yield* s.retrieve({ allowed: everything, limit: 10 })),
          twoGrants: ids(
            yield* s.retrieve({
              allowed: [...general, { connectionId: "other-chat", containers: ["c-general"] }],
              limit: 10
            })
          ),
          threeConnections: ids(
            yield* s.retrieve({
              allowed: [
                { connectionId: "team-chat", containers: ["c-random"] },
                { connectionId: "other-chat", containers: ["c-general"] },
                { connectionId: "another-chat", containers: ["c-general"] }
              ],
              limit: 10
            })
          ),
          empty: ids(yield* s.retrieve({ allowed: [{ connectionId: "team-chat", containers: [] }], limit: 10 })),
          none: ids(yield* s.retrieve({ allowed: [], limit: 10 }))
        }
      }))
      expect(found.general).toEqual(["general"])
      expect(found.both).toEqual(["general", "random", "split"])
      // Newest change first.
      expect(found.everything).toEqual(["direct", "general", "random", "split"])
      expect(found.twoGrants).toEqual(["general", "elsewhere", "o2"])
      // Equal change times order by connection, then by external id.
      expect(found.threeConnections).toEqual(["random", "zzz", "elsewhere", "a2", "o2"])
      expect(found.empty).toEqual([])
      expect(found.none).toEqual([])
    })

    it("filters by kind and by a case-insensitive text query, dates a record without a change time by its creation, orders undated records last, and honors the limit", async () => {
      const found = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([
          record({ externalId: "a", kind: "message", text: "Deploy the Release", updatedAtMs: 2_000 }),
          record({ externalId: "b", kind: "file", text: "release notes", updatedAtMs: 3_000 }),
          record({ externalId: "c", kind: "message", text: "lunch", updatedAtMs: 1_000 }),
          record({ externalId: "d", kind: "message", text: "undated release", createdAtMs: null, updatedAtMs: null }),
          record({ externalId: "e", kind: "message", text: "same time", updatedAtMs: 1_000 }),
          record({ externalId: "f", kind: "message", text: "received release", createdAtMs: 2_500, updatedAtMs: null })
        ])
        const ids = (records: ReadonlyArray<SourceRecord>) => records.map((found) => found.externalId)
        return {
          messages: ids(yield* s.retrieve({ allowed: general, kinds: ["message"], limit: 10 })),
          noKinds: ids(yield* s.retrieve({ allowed: general, kinds: [], limit: 10 })),
          release: ids(yield* s.retrieve({ allowed: general, query: "RELEASE", limit: 10 })),
          blank: ids(yield* s.retrieve({ allowed: general, query: "", limit: 10 })),
          limited: ids(yield* s.retrieve({ allowed: general, limit: 2 }))
        }
      }))
      expect(found.messages).toEqual(["f", "a", "c", "e", "d"])
      expect(found.noKinds).toEqual([])
      expect(found.release).toEqual(["b", "f", "a", "d"])
      expect(found.blank).toEqual(["b", "f", "a", "c", "e", "d"])
      expect(found.limited).toEqual(["b", "f"])
    })

    it("refuses a limit outside 1 to the maximum", async () => {
      const failures = await run(Effect.gen(function*() {
        const s = yield* store
        return yield* Effect.forEach(
          [0, MAX_RETRIEVE_LIMIT + 1, 1.5],
          (limit) => Effect.flip(s.retrieve({ allowed: general, limit }))
        )
      }))
      expect(failures.map((failure) => failure.reason)).toEqual(["invalid-config", "invalid-config", "invalid-config"])
    })

    it("purges a revoked connection, hides it from retrieve and validate, and keeps later syncs content-free", async () => {
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([
          record(),
          inContainer("c-random", { externalId: "m-2" }),
          record({ connectionId: "other-chat", externalId: "kept" })
        ])
        const before = yield* s.retrieve({ allowed: everything, limit: 10 })
        const purged = yield* s.revokeConnection("team-chat")
        const stored = yield* s.get("team-chat", "m-1")
        const repeated = yield* s.apply([record()])
        const untouched = yield* s.retrieve({ allowed: [{ connectionId: "other-chat", containers: ["*"] }], limit: 10 })
        const racing = yield* s.apply([
          record({ updatedAtMs: 9_000, text: "after revocation" }),
          inContainer("c-random", { externalId: "m-3", text: "new after revocation" })
        ])
        return {
          before,
          purged,
          stored,
          repeated,
          untouched,
          racing,
          racedIn: yield* s.get("team-chat", "m-3"),
          visible: yield* s.retrieve({ allowed: everything, limit: 10 }),
          validity: yield* s.validate({ allowed: everything, references: before.map(reference) }),
          revoked: [yield* s.isRevoked("team-chat"), yield* s.isRevoked("team-chat", "c-general")],
          other: yield* s.isRevoked("other-chat")
        }
      }))
      expect(result.before).toHaveLength(2)
      expect(result.purged).toBe(2)
      expect(Option.getOrThrow(result.stored)).toMatchObject({
        revoked: true,
        record: { text: "", payload: null, url: null, author: null, deleted: false }
      })
      expect(result.repeated.unchanged).toBe(1)
      expect(result.untouched.map((found) => found.text)).toEqual(["hello"])
      expect(result.racing).toEqual({ inserted: 1, updated: 1, unchanged: 0, tombstoned: 0 })
      expect(Option.getOrThrow(result.racedIn)).toMatchObject({ revoked: true, record: { text: "", payload: null } })
      expect(result.visible).toEqual([])
      expect(result.validity.map((entry) => entry.validity)).toEqual(["revoked", "revoked"])
      expect(result.revoked).toEqual([true, true])
      expect(result.other).toBe(false)
    })

    it("restores purged records when a revocation is lifted and a sync lists them again", async () => {
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record()])
        yield* s.revokeConnection("team-chat")
        yield* s.reinstate("team-chat")
        const stillPurged = yield* s.retrieve({ allowed: everything, limit: 10 })
        const older = yield* s.apply([record({ updatedAtMs: 500, text: "older" })])
        const relisted = yield* s.apply([record()])
        return {
          stillPurged,
          older,
          relisted,
          revoked: yield* s.isRevoked("team-chat"),
          visible: yield* s.retrieve({ allowed: everything, limit: 10 })
        }
      }))
      expect(result.stillPurged).toEqual([])
      expect(result.older.unchanged).toBe(1)
      expect(result.relisted.updated).toBe(1)
      expect(result.revoked).toBe(false)
      expect(result.visible).toEqual([record()])
    })

    it("revokes one container without touching the others", async () => {
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([
          record(),
          inContainer("c-random", { externalId: "m-2" }),
          record({
            externalId: "m-3",
            access: { scope: "public", containerId: null },
            thread: { containerId: "c-general", threadId: null, parentId: null }
          })
        ])
        const purged = yield* s.revokeContainer("team-chat", "c-general")
        const later = yield* s.apply([record({ externalId: "m-4", text: "posted later" })])
        return {
          purged,
          later,
          visible: (yield* s.retrieve({ allowed: everything, limit: 10 })).map((found) => found.externalId),
          markers: [
            yield* s.isRevoked("team-chat", "c-general"),
            yield* s.isRevoked("team-chat", "c-random"),
            yield* s.isRevoked("team-chat")
          ],
          reinstated: yield* Effect.gen(function*() {
            yield* s.reinstate("team-chat", "c-general")
            return yield* s.isRevoked("team-chat", "c-general")
          })
        }
      }))
      expect(result.purged).toBe(2)
      expect(result.later.inserted).toBe(1)
      expect(result.visible).toEqual(["m-2"])
      expect(result.markers).toEqual([true, false, false])
      expect(result.reinstated).toBe(false)
    })

    it("refuses a malformed connection or container id for revocation", async () => {
      const failures = await run(Effect.gen(function*() {
        const s = yield* store
        return [
          yield* Effect.flip(s.revokeConnection("")),
          yield* Effect.flip(s.revokeConnection("team:chat")),
          yield* Effect.flip(s.revokeContainer("team-chat", "*")),
          yield* Effect.flip(s.revokeContainer("team-chat", "")),
          yield* Effect.flip(s.revokeContainer("", "c-general"))
        ]
      }))
      expect(failures.map((failure: IntegrationError) => failure.reason)).toEqual(Array(5).fill("invalid-config"))
    })

    it("validates kept references against deletion, edits, grants and existence", async () => {
      const validity = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([
          record({ externalId: "kept" }),
          record({ externalId: "edited" }),
          record({ externalId: "deleted" }),
          inContainer("c-random", { externalId: "elsewhere" })
        ])
        const kept = yield* s.retrieve({ allowed: everything, limit: 10 })
        yield* s.apply([
          record({ externalId: "edited", updatedAtMs: 5_000, text: "edited" }),
          tombstone(record({ externalId: "deleted" }), 5_000)
        ])
        const references = [
          ...kept.map(reference),
          { connectionId: "team-chat", externalId: "never", updatedAtMs: null, version: null, retrievedAtMs: 1 }
        ]
        return yield* s.validate({ allowed: general, references })
      }))
      expect(validity.map((entry) => [entry.reference.externalId, entry.validity])).toEqual([
        ["deleted", "deleted"],
        ["edited", "changed"],
        ["elsewhere", "denied"],
        ["kept", "current"],
        ["never", "missing"]
      ])
    })

    it("reports changed when only the version or the retrieval differs", async () => {
      const validity = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.apply([record({ version: "1" }), record({ externalId: "m-2" })])
        const [first] = yield* s.retrieve({ allowed: general, kinds: ["message"], query: "hello", limit: 1 })
        return yield* s.validate({
          allowed: general,
          references: [
            { ...reference(first!), version: "0" },
            { ...reference(first!), retrievedAtMs: 1 }
          ]
        })
      }))
      expect(validity.map((entry) => entry.validity)).toEqual(["changed", "changed"])
    })

    it("commits a page and its cursor together, and answers the cursor per stream", async () => {
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        const before = yield* s.cursor("team-chat", "c-general")
        const report = yield* s.commit(page({ records: [record()], cursor: "p1", done: false }))
        const noCursor = yield* s.commit(page({ records: [], cursor: null }))
        return {
          before,
          report,
          noCursor,
          after: yield* s.cursor("team-chat", "c-general"),
          other: yield* s.cursor("team-chat", "c-random"),
          stored: yield* s.get("team-chat", "m-1")
        }
      }))
      expect(result.before).toBeNull()
      expect(result.report).toEqual({ inserted: 1, updated: 0, unchanged: 0, tombstoned: 0, swept: 0, sweeping: false })
      expect(result.noCursor.inserted).toBe(0)
      expect(result.after).toBe("p1")
      expect(result.other).toBeNull()
      expect(Option.getOrThrow(result.stored).stream).toBe("c-general")
    })

    it("sweeps what a completed full listing did not contain, and only then", async () => {
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        yield* s.commit(page({
          records: [record({ externalId: "a" }), record({ externalId: "b" }), record({ externalId: "c" })],
          cursor: "incremental"
        }))
        // A record another stream listed, and one that only arrived through
        // `apply`, are not this stream's to sweep.
        yield* s.commit(page({ records: [inContainer("c-random", { externalId: "r" })], cursor: "x" }, "c-random"))
        yield* s.apply([record({ externalId: "webhook" })])
        const first = yield* s.commit(
          page({ records: [record({ externalId: "a" })], cursor: "f1", reset: true, done: false })
        )
        const midway = (yield* s.retrieve({ allowed: everything, limit: 10 })).map((found) => found.externalId)
        const last = yield* s.commit(page({ records: [record({ externalId: "c" })], cursor: "f2", done: true }))
        return {
          first,
          midway,
          last,
          visible: (yield* s.retrieve({ allowed: everything, limit: 10 })).map((found) => found.externalId),
          swept: yield* s.get("team-chat", "b"),
          again: yield* s.commit(page({ records: [], cursor: "f3", done: true }))
        }
      }))
      expect(result.first).toMatchObject({ unchanged: 1, swept: 0, sweeping: true })
      expect(result.midway).toEqual(["a", "b", "c", "r", "webhook"])
      expect(result.last).toMatchObject({ unchanged: 1, swept: 1, sweeping: false })
      expect(result.visible).toEqual(["a", "c", "r", "webhook"])
      expect(Option.getOrThrow(result.swept).record).toMatchObject({ deleted: true, text: "", payload: null })
      // The next incremental page sweeps nothing.
      expect(result.again).toMatchObject({ swept: 0, sweeping: false })
    })

    // #2662: a sweep keeps the change time and version of the copy it removed,
    // so it must not outrank that same copy when a later full listing
    // contains it again, whichever page of the listing carries it.
    it("restores an unchanged record a later multi-page full listing contains again", async () => {
      const current = record({ externalId: "current-object", version: "unchanged-v1" })
      const other = record({ externalId: "other" })
      const listing = (pages: ReadonlyArray<ReadonlyArray<SourceRecord>>) =>
        Effect.flatMap(store, (s) =>
          Effect.forEach(pages, (records, index) =>
            s.commit(page({
              records,
              cursor: `p${index}`,
              reset: index === 0,
              done: index === pages.length - 1
            }))))
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        const inserted = yield* listing([[current, other]])
        const absent = yield* listing([[other], []])
        const gone = yield* s.retrieve({ allowed: general, limit: 10 })
        const present = yield* listing([[other], [{ ...current, retrievedAtMs: 3_000 }]])
        const stored = yield* s.get("team-chat", "current-object")
        const visible = (yield* s.retrieve({ allowed: general, limit: 10 })).map((found) => found.externalId)
        // Restored, it is this stream's again: the next omission sweeps it.
        const again = yield* listing([[other]])
        return { inserted, absent, gone, present, stored, visible, again }
      }))
      expect(result.inserted[0]).toMatchObject({ inserted: 2, swept: 0 })
      expect(result.absent[1]).toMatchObject({ swept: 1, sweeping: false })
      expect(result.gone.map((found) => found.externalId)).toEqual(["other"])
      expect(result.present[1]).toMatchObject({ inserted: 0, updated: 1, unchanged: 0, tombstoned: 0, swept: 0 })
      expect(Option.getOrThrow(result.stored)).toEqual({
        record: { ...current, retrievedAtMs: 3_000 },
        revoked: false,
        stream: "c-general"
      })
      expect(result.visible).toEqual(["current-object", "other"])
      expect(result.again[0]).toMatchObject({ swept: 1 })
    })

    it("keeps a swept record deleted against a stale copy, and a provider deletion against an equal one", async () => {
      const listed = record({ externalId: "a" })
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        const full = (records: ReadonlyArray<SourceRecord>) =>
          s.commit(page({ records, cursor: "f", reset: true, done: true }))
        yield* full([listed])
        yield* full([])
        const stale = yield* full([record({ externalId: "a", updatedAtMs: 999 })])
        const staleStored = yield* s.get("team-chat", "a")
        // The provider confirms the deletion at the removed copy's own time:
        // from then on it outranks a live copy with that time, as any
        // provider deletion does.
        const confirmed = yield* s.apply([tombstone(listed, 1_000, 4_000)])
        const equal = yield* full([listed])
        const equalStored = yield* s.get("team-chat", "a")
        // A genuinely newer provider deletion outranks the unchanged copy too.
        yield* s.apply([record({ externalId: "b" })])
        yield* s.apply([tombstone(record({ externalId: "b" }), 1_001)])
        const newer = yield* s.commit(page({ records: [record({ externalId: "b" })], cursor: "g", reset: true }))
        const newerStored = yield* s.get("team-chat", "b")
        return { stale, staleStored, confirmed, equal, equalStored, newer, newerStored }
      }))
      expect(result.stale).toMatchObject({ updated: 0, unchanged: 1 })
      expect(Option.getOrThrow(result.staleStored).record).toMatchObject({ deleted: true, text: "" })
      expect(result.confirmed).toEqual({ inserted: 0, updated: 1, unchanged: 0, tombstoned: 1 })
      expect(result.equal).toMatchObject({ updated: 0, unchanged: 1 })
      expect(Option.getOrThrow(result.equalStored).record).toMatchObject({ deleted: true, text: "" })
      expect(result.newer).toMatchObject({ updated: 0, unchanged: 1 })
      expect(Option.getOrThrow(result.newerStored).record).toMatchObject({ deleted: true, updatedAtMs: 1_001 })
    })

    it("restores a swept record ordered by version alone when the listing carries that version again", async () => {
      const versioned = record({ externalId: "mail", updatedAtMs: null, version: "42" })
      const result = await run(Effect.gen(function*() {
        const s = yield* store
        const full = (records: ReadonlyArray<SourceRecord>) =>
          s.commit(page({ records, cursor: "f", reset: true, done: true }))
        yield* full([versioned])
        const swept = yield* full([])
        const older = yield* full([{ ...versioned, version: "41" }])
        const restored = yield* full([versioned])
        return { swept, older, restored, stored: yield* s.get("team-chat", "mail") }
      }))
      expect(result.swept.swept).toBe(1)
      expect(result.older).toMatchObject({ updated: 0, unchanged: 1 })
      expect(result.restored).toMatchObject({ updated: 1, unchanged: 0 })
      expect(Option.getOrThrow(result.stored).record).toEqual(versioned)
    })

    it("refuses a page carrying another connection's or provider's records, or no stream", async () => {
      const [failures, stored] = await run(Effect.gen(function*() {
        const s = yield* store
        const failures = [
          yield* Effect.flip(s.commit(page({ records: [record(), record({ connectionId: "other-chat" })] }))),
          yield* Effect.flip(s.commit(page({ records: [record({ provider: "else" })] }))),
          yield* Effect.flip(s.commit(page({ records: [record()] }, ""))),
          yield* Effect.flip(s.commit({ ...page({ records: [] }), connectionId: "bad:id" })),
          yield* Effect.flip(s.commit(page({ records: [record({ kind: "" })] })))
        ]
        return [failures, yield* s.get("team-chat", "m-1")] as const
      }))
      expect(failures.map((failure) => failure.reason)).toEqual([
        "invalid-config",
        "invalid-config",
        "invalid-config",
        "invalid-config",
        "decode-failed"
      ])
      expect(Option.isNone(stored)).toBe(true)
    })
  })
}

contract("SourceStore (memory)", layerMemory)
// The durable store runs against a real SQLite database with the real
// migrations applied.
contract("SourceStore (SQLite)", sqlLayer as unknown as Layer.Layer<SourceStore>)
