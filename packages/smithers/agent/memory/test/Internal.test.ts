import * as Digest from "@smthrs/core/Digest"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Canonical from "../src/internal/Canonical.ts"
import * as MemoryDigest from "../src/internal/Digest.ts"
import * as FactProjection from "../src/internal/FactProjection.ts"
import * as FtsQuery from "../src/internal/FtsQuery.ts"
import * as Ranking from "../src/internal/Ranking.ts"
import * as Bank from "../src/internal/ResolveNamespace.ts"
import * as Store from "../src/internal/Store.ts"
import * as VectorBytes from "../src/internal/VectorBytes.ts"
import * as Namespace from "../src/Namespace.ts"

describe("memory internal helpers", () => {
  it("reads affected-row counts from SQLite and PostgreSQL results", () => {
    expect(Store.changed({ changes: 2 })).toBe(2)
    expect(Store.changed({ rowCount: 3 })).toBe(3)
    expect(Store.changed({ rowsAffected: 4 })).toBe(4)
    expect(Store.changed({ changes: undefined, rowCount: 5 })).toBe(5)
    expect(Store.changed({ changes: "2", rowsAffected: "4" })).toBe(0)
    expect(Store.changed(null)).toBe(0)
    expect(Store.changed(undefined)).toBe(0)
  })

  it("retains structured failures and bounds unstructured store causes", () => {
    const underlying = new Error("database unavailable")
    expect(Store.storeError("read failed")(underlying).cause).toBe(underlying)
    expect(Store.error("store", "null cause", null).cause).toEqual({ type: "null" })
    expect(Store.error("store", "long cause", "x".repeat(2_000)).cause).toHaveLength(1_024)
  })

  it("normalizes text and hashes every JavaScript string with SHA-256", () => {
    expect(Canonical.compareText("a", "b")).toBe(-1)
    expect(Canonical.compareText("b", "a")).toBe(1)
    expect(Canonical.compareText("a", "a")).toBe(0)
    expect(MemoryDigest.wellFormed("a\uD800b\uDC00c\uD83D\uDE00")).toBe("a\uFFFDb\uFFFDc\uD83D\uDE00")
    expect(MemoryDigest.digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(MemoryDigest.digest("\uD800")).toBe(Digest.digest("\uFFFD"))
  })

  it("extracts searchable text and retained string tags", () => {
    expect(FactProjection.searchableText("root")).toBe("root")
    expect(FactProjection.searchableText({ content: "body", tags: ["scope:x"] })).toBe("body")
    expect(FactProjection.searchableText({ other: "value" })).toBe("{\"other\":\"value\"}")
    expect(FactProjection.searchableText(undefined)).toBe("")
    expect(FactProjection.retainedTags({ tags: ["scope:x", 1, "branch:main"] })).toEqual(["scope:x", "branch:main"])
    expect(FactProjection.retainedTags(null)).toEqual([])
  })

  it("encodes vectors explicitly little-endian and truncates on UTF-8 boundaries", () => {
    expect([...VectorBytes.vectorBytes([1, -2, 0.5])]).toEqual([
      0,
      0,
      128,
      63,
      0,
      0,
      0,
      192,
      0,
      0,
      0,
      63
    ])
  })

  it("scores cosine similarity and recency decay at their boundaries", () => {
    const withHole = new Array<number>(2)
    withHole[1] = 1
    expect(Object.hasOwn(withHole, 0)).toBe(false)
    expect(Ranking.cosine([], [])).toBe(0)
    expect(Ranking.cosine([1, 0], [1])).toBe(0)
    expect(Ranking.cosine([0, 0], [1, 0])).toBe(0)
    expect(Ranking.cosine([1, 0], [0, 0])).toBe(0)
    expect(Ranking.cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(Ranking.cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(Ranking.cosine(withHole, [0, 1])).toBeCloseTo(1)
    expect(Ranking.cosine([0, 1], withHole)).toBeCloseTo(1)
    expect(Ranking.recency(10, 5, 1_000)).toBe(1)
    expect(Ranking.recency(0, 0, 1_000)).toBe(1)
    expect(Ranking.recency(0, 1_000, 1_000)).toBeCloseTo(0.5)
    expect(Ranking.recency(0, 2_000, 1_000)).toBeCloseTo(0.25)
    expect(Ranking.recency(0, 3_000, 1_000)).toBeCloseTo(0.125)
    expect(Ranking.recency(0, 7 * 86_400_000, 7 * 86_400_000)).toBeCloseTo(0.5)
  })

  it("always treats FTS query text as data", () => {
    expect(FtsQuery.literalFtsQuery("alpha beta")).toBe("\"alpha\" \"beta\"")
    expect(FtsQuery.literalFtsQuery("\"alpha beta\"")).toBe("\"\"\"alpha\" \"beta\"\"\"")
    expect(FtsQuery.literalFtsQuery(" alpha\0beta ")).toBe("\"alpha\" \"beta\"")
    expect(FtsQuery.literalFtsQuery("\uD800")).toBe("\"\uFFFD\"")
  })

  it("validates structured namespaces and resolves every bank form", async () => {
    const resolved = await Effect.runPromise(Effect.all([
      Bank.resolveNamespace({ kind: "agent", id: "worker" }),
      Bank.resolveNamespace("user-person"),
      Bank.resolveNamespace("flow-"),
      Bank.resolveNamespace("plain")
    ]))
    const empty = await Effect.runPromise(Effect.flip(Bank.resolveNamespace("")))
    const invalid = await Effect.runPromise(Effect.flip(
      Bank.resolveNamespace({ kind: "flow", id: "" })
    ))

    expect(resolved).toEqual([
      { namespace: { kind: "agent", id: "worker" }, bank: "agent-worker" },
      { namespace: { kind: "user", id: "person" }, bank: "user-person" },
      { namespace: { kind: "flow", id: "flow-" }, bank: "flow-" },
      { namespace: { kind: "flow", id: "plain" }, bank: "plain" }
    ])
    expect(empty.code).toBe("invalid_namespace")
    expect(invalid.code).toBe("invalid_namespace")
  })

  it("formats and parses banks with one pair the validating resolver reuses", async () => {
    for (const kind of Namespace.Kind.literals) {
      const namespace = { kind, id: "id" } as const
      const bank = Bank.bankForNamespace(namespace)
      expect(bank).toBe(`${kind}-id`)
      expect(Bank.namespaceForBank(bank)).toEqual(namespace)
      expect(await Effect.runPromise(Bank.resolveNamespace(bank))).toEqual({ namespace, bank })
      expect(await Effect.runPromise(Bank.resolveNamespace(namespace))).toEqual({ namespace, bank })
    }
    expect(Bank.namespaceForBank("plain")).toEqual({ kind: "flow", id: "plain" })
    expect(Bank.namespaceForBank("user-")).toEqual({ kind: "flow", id: "user-" })
  })
})
