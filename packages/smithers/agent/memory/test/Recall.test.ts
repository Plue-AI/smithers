import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Bank from "../src/Bank.ts"
import * as BankInternal from "../src/internal/ResolveNamespace.ts"
import * as Namespace from "../src/Namespace.ts"
import * as Recall from "../src/Recall.ts"

describe("Recall", () => {
  it("ranks by score, newest update, key, then bank for every binding", () => {
    const row = { bank: "b", key: "k", text: "t", score: 1, updatedAtMs: 5 }
    const results = [
      { ...row, bank: "z" },
      row,
      { ...row, key: "a" },
      { ...row, updatedAtMs: 6 },
      { ...row, score: 2 },
      { ...row, updatedAtMs: undefined }
    ]
    expect([...results].sort(Recall.compareResults)).toEqual([
      { ...row, score: 2 },
      { ...row, updatedAtMs: 6 },
      { ...row, key: "a" },
      row,
      { ...row, bank: "z" },
      { ...row, updatedAtMs: undefined }
    ])
    expect(Recall.requestedRows(undefined)).toBe(Recall.DEFAULT_MAX_TOKENS / 256)
    expect([0, 1, 256, 257].map(Recall.requestedRows)).toEqual([1, 1, 1, 2])
    const undated = { bank: "b", key: "k", text: "t", score: 1 }
    expect(Recall.compareResults(row, undated)).toBe(-5)
    expect(Recall.compareResults(undated, row)).toBe(5)
  })

  it("caps whole results and truncates only the first overflowing result", () => {
    const results = [
      { bank: "a", key: "one", text: "short", score: 1 },
      { bank: "b", key: "two", text: "a long result that must be truncated", score: 0.5 },
      { bank: "c", key: "three", text: "never reached", score: 0.1 }
    ]
    const capped = Recall.capRecallResults(results, 105)
    expect(capped).toHaveLength(2)
    expect(capped[0]).toEqual(results[0])
    const overflowing = results[1]
    expect(overflowing).toBeDefined()
    if (overflowing === undefined) return
    expect(capped[1]?.text.length).toBeLessThan(overflowing.text.length)
  })

  // The previous implementation, kept as the oracle: it re-serialized the
  // whole selection for every candidate, so its output is the contract the
  // incremental version must reproduce byte for byte.
  const capByReserializing = (results: ReadonlyArray<Recall.Result>, maxTokens: number): Array<Recall.Result> => {
    const byteLength = (rows: ReadonlyArray<Recall.Result>) => new TextEncoder().encode(JSON.stringify(rows)).byteLength
    const normalized = results.filter((result) => result.text.length > 0)
    const byteBudget = Math.max(0, Math.floor(maxTokens))
    const selected: Array<Recall.Result> = []
    for (const result of normalized) {
      if (byteLength([...selected, result]) <= byteBudget) {
        selected.push(result)
        continue
      }
      const characters = [...result.text]
      let low = 0
      let high = characters.length
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (byteLength([...selected, { ...result, text: characters.slice(0, middle).join("") }]) <= byteBudget) {
          low = middle
        } else {
          high = middle - 1
        }
      }
      if (low > 0) selected.push({ ...result, text: characters.slice(0, low).join("") })
      break
    }
    return selected
  }

  // RecallKeyword can hand the cap up to 512 banks x 16 rows.
  const wideRecall = Array.from({ length: 512 * 16 }, (_, index) => ({
    bank: `bank-${index % 512}`,
    key: `key-${index}`,
    text: index % 7 === 0 ? `ünïcödé row ${index} 🚀` : `row ${index} ${"x".repeat(index % 13)}`,
    score: 1 / (index + 1),
    ...(index % 3 === 0 ? { updatedAtMs: index } : {})
  }))

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The oracle is quadratic, so the budgets stop at the largest one the
  // schema admits; the spy test below covers selecting every row.
  it.each([0, 1, 17, 2048, 4096, 30_000, Recall.MAX_RECALL_TOKENS])(
    "matches the whole-selection re-serializing implementation on 512 x 16 rows (budget %s)",
    (budget) => {
      const capped = Recall.capRecallResults(wideRecall, budget)
      expect(capped).toEqual(capByReserializing(wideRecall, budget))
      // An empty selection still serializes to `[]`, two bytes.
      const floor = new TextEncoder().encode(JSON.stringify([])).byteLength
      expect(new TextEncoder().encode(JSON.stringify(capped)).byteLength).toBeLessThanOrEqual(Math.max(budget, floor))
    }
  )

  it("serializes each selected row exactly once instead of the whole selection per candidate", () => {
    // One bank's worth of rows: re-serializing the selection per candidate
    // would count 512 * 513 / 2 row serializations instead of 512.
    const rows = wideRecall.slice(0, 512)
    let rowsSerialized = 0
    const stringify = JSON.stringify.bind(JSON)
    vi.spyOn(JSON, "stringify").mockImplementation((value, ...rest) => {
      rowsSerialized += Array.isArray(value) ? value.length : 1
      return stringify(value, ...(rest as []))
    })
    const capped = Recall.capRecallResults(rows, 10_000_000)
    expect(capped).toHaveLength(rows.length)
    expect(rowsSerialized).toBe(rows.length)
  })

  it.each([
    [0, 0],
    [-1, 0],
    [Number.NaN, 0]
  ])("uses a non-negative byte budget (%s)", (budget, expected) => {
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "text", score: 1 }], budget)).toHaveLength(expected)
  })

  it("keeps a result that fits exactly and drops one that overflows by a single byte", () => {
    const single = [{ bank: "a", key: "k", text: "text", score: 1 }]
    const exact = new TextEncoder().encode(JSON.stringify(single)).byteLength
    expect(Recall.capRecallResults(single, exact)).toEqual(single)
    expect(Recall.capRecallResults(single, exact - 1)?.[0]?.text).toBe("tex")
  })

  it("drops empty-text rows and accepts an empty result set", () => {
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "", score: 1 }], 2048)).toEqual([])
    expect(Recall.capRecallResults([], 2048)).toEqual([])
    expect(Recall.capRecallResults([{ bank: "a", key: "k", text: "kept", score: 1 }])).toHaveLength(1)
  })

  it("returns no rows from the empty recall implementation and its layer", async () => {
    const direct = await Effect.runPromise(Recall.makeNoop().recall({ banks: ["a"], query: "q" }))
    const layered = await Effect.runPromise(
      Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["a"], query: "q" })),
        Effect.provide(Recall.layerNoop)
      )
    )
    expect([direct, layered]).toEqual([[], []])
  })

  it("round-trips schema-valid namespaces and rejects an empty bank through the validating parser", async () => {
    for (
      const namespace of [
        { kind: "flow", id: "one" },
        { kind: "agent", id: "fleet" },
        { kind: "user", id: "will" },
        { kind: "global", id: "history" }
      ] as const
    ) {
      expect(Recall.namespaceForBank(Recall.bankForNamespace(namespace))).toEqual(namespace)
    }
    // An unprefixed name, and a bare prefix with no id after it, are both
    // flow-local rather than a parse failure.
    expect(Recall.namespaceForBank("plain")).toEqual({ kind: "flow", id: "plain" })
    expect(Recall.namespaceForBank("agent-")).toEqual({ kind: "flow", id: "agent-" })
    // One parser and one formatter: Recall re-exports the internal pair rather
    // than keeping a second kind list, and the syntactic parser agrees with the
    // validating one for every declared kind.
    expect(Recall.namespaceForBank).toBe(BankInternal.namespaceForBank)
    expect(Recall.bankForNamespace).toBe(BankInternal.bankForNamespace)
    for (const kind of Namespace.Kind.literals) {
      const bank = `${kind}-id`
      expect(Recall.namespaceForBank(bank)).toEqual(await Effect.runPromise(Bank.parse(bank)))
      expect(Recall.bankForNamespace({ kind, id: "id" })).toBe(bank)
    }
    await expect(Effect.runPromise(Effect.flip(Bank.parse("")))).resolves.toMatchObject({
      code: "invalid_namespace"
    })
  })

  it("enforces every model-facing recall ceiling at decode", () => {
    const decode = Schema.decodeUnknownSync(Recall.Input)
    const base = { banks: ["bank"], query: "q" }
    expect(
      decode({
        ...base,
        banks: Array.from({ length: Recall.MAX_RECALL_BANKS }, (_, index) => `bank-${index}`)
      }).banks
    ).toHaveLength(Recall.MAX_RECALL_BANKS)
    expect(() =>
      decode({
        ...base,
        banks: Array.from({ length: Recall.MAX_RECALL_BANKS + 1 }, (_, index) => `bank-${index}`)
      })
    ).toThrow()

    expect(decode({ ...base, banks: ["b".repeat(Recall.MAX_RECALL_BANK_NAME_LENGTH)] }).banks[0]).toHaveLength(
      Recall.MAX_RECALL_BANK_NAME_LENGTH
    )
    expect(() =>
      decode({
        ...base,
        banks: ["b".repeat(Recall.MAX_RECALL_BANK_NAME_LENGTH + 1)]
      })
    ).toThrow()

    expect(decode({ ...base, query: "q".repeat(Recall.MAX_RECALL_QUERY_BYTES) }).query).toHaveLength(
      Recall.MAX_RECALL_QUERY_BYTES
    )
    expect(() => decode({ ...base, query: "q".repeat(Recall.MAX_RECALL_QUERY_BYTES + 1) })).toThrow()

    expect(decode({ ...base, maxTokens: Recall.MAX_RECALL_TOKENS }).maxTokens).toBe(Recall.MAX_RECALL_TOKENS)
    expect(() => decode({ ...base, maxTokens: Recall.MAX_RECALL_TOKENS + 1 })).toThrow()
    expect(() => decode({ ...base, maxTokens: -1 })).toThrow()

    // Each group is depth- and node-bounded on its own, but the array is what
    // multiplies that budget across every candidate row in every binding.
    const group = { tags: ["scope:project"] }
    expect(
      decode({ ...base, tagGroups: Array.from({ length: Recall.MAX_RECALL_TAG_GROUPS }, () => group) }).tagGroups
    ).toHaveLength(Recall.MAX_RECALL_TAG_GROUPS)
    expect(() => decode({ ...base, tagGroups: Array.from({ length: Recall.MAX_RECALL_TAG_GROUPS + 1 }, () => group) }))
      .toThrow()
  })

  it("rejects a several-hundred-level tag group through the model-facing input without overflowing", () => {
    let group: unknown = { tags: ["scope:project"] }
    for (let level = 0; level < 500; level++) group = { or: [group] }

    let failure: unknown
    try {
      Schema.decodeUnknownSync(Recall.Input)({ banks: ["bank"], query: "q", tagGroups: [group] })
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeDefined()
    expect(failure).not.toBeInstanceOf(RangeError)
    expect(String(failure)).toContain("invalid_tag")
  })
})
