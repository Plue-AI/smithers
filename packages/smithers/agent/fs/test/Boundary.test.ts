import { describe, expect, it, vi } from "vitest"
import * as Boundary from "../src/internal/Boundary.ts"

const limits = (overrides: Partial<Boundary.JsonLimits> = {}): Boundary.JsonLimits => ({
  maxBytes: 1_024,
  maxDepth: 8,
  maxMembers: 16,
  maxNodes: 32,
  maxStringBytes: 128,
  maxKeyBytes: 32,
  ...overrides
})

const admit = (value: unknown, overrides?: Partial<Boundary.JsonLimits>) => Boundary.admitJson(value, limits(overrides))

describe("the inert fs boundary", () => {
  it("reads array length from the own descriptor, never the get trap", () => {
    let reads = 0
    const input = new Proxy([], {
      get: (target, key, receiver) => {
        reads++
        return key === "length" ? Number.NaN : Reflect.get(target, key, receiver)
      }
    })
    expect(Array.isArray(input)).toBe(true)
    expect(admit(input)).toEqual({ ok: true, value: [] })
    expect(reads).toBe(0)
  })

  it("refuses a proxy whose own length descriptor is invalid", () => {
    const input = new Proxy([], {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        return key === "length" ? { ...descriptor, value: Number.NaN } : descriptor
      }
    })
    expect(Object.getOwnPropertyDescriptor(input, "length")?.value).toBeNaN()
    expect(admit(input)).toEqual({ ok: false, path: "$", complaint: "has an invalid array length" })
  })

  it("copies every JSON scalar without normalizing text", () => {
    for (const value of [null, true, false, 0, -1.5, "", "é", "e\u0301", "😀"] as const) {
      expect(admit(value)).toEqual({ ok: true, value })
    }
    expect(Boundary.isWellFormedText("😀")).toBe(true)
    expect(Boundary.isWellFormedText("\ud800")).toBe(false)
    expect(Boundary.isWellFormedText("\udc00")).toBe(false)
  })

  it("rejects non-JSON scalars and malformed strings", () => {
    for (const value of [undefined, 1n, Symbol("x"), () => 1, Number.NaN, Infinity, -Infinity, "\ud800", "\udc00"]) {
      expect(admit(value)).toMatchObject({ ok: false })
    }
  })

  it("detaches and recursively freezes dense arrays and records", () => {
    const nested = { value: 1 }
    const input = { first: [nested], second: { ok: true } }
    const admitted = admit(input)
    expect(admitted).toMatchObject({ ok: true, value: input })
    if (!admitted.ok) return
    const copied = admitted.value as {
      readonly first: ReadonlyArray<{ readonly value: number }>
      readonly second: object
    }
    expect(copied).not.toBe(input)
    expect(copied.first[0]).not.toBe(nested)
    expect(Object.isFrozen(copied)).toBe(true)
    expect(Object.isFrozen(copied.first)).toBe(true)
    expect(Object.isFrozen(copied.first[0])).toBe(true)
    nested.value = 2
    expect(copied.first[0]?.value).toBe(1)
  })

  it("admits only undecorated, valid native dates in decoded values", () => {
    const original = new Date("2026-01-01T00:00:00.000Z")
    const admitted = Boundary.admitDecoded({ dates: [original] })
    expect(admitted).toMatchObject({ ok: true })
    if (!admitted.ok) return
    const copy = admitted.value as { readonly dates: ReadonlyArray<Date> }
    expect(copy.dates[0]).toBeInstanceOf(Date)
    expect(Object.getPrototypeOf(copy.dates[0])).toBe(Date.prototype)
    expect(copy.dates[0]).not.toBe(original)
    expect(copy.dates[0]?.getTime()).toBe(original.getTime())
    expect(Object.isFrozen(copy)).toBe(true)
    expect(Object.isFrozen(copy.dates)).toBe(true)
    // Date setters can mutate their internal slot; isolation comes from detaching the leaf.
    original.setUTCFullYear(2030)
    expect(copy.dates[0]?.toISOString()).toBe("2026-01-01T00:00:00.000Z")

    class DerivedDate extends Date {}
    const enumerable = Object.assign(new Date("2026-01-01"), { extra: 1 })
    const hidden = new Date("2026-01-01")
    Object.defineProperty(hidden, "extra", { value: 1, enumerable: false })
    const symbol = new Date("2026-01-01")
    Object.defineProperty(symbol, Symbol("extra"), { value: 1 })
    for (
      const [caseName, value] of [
        ["invalid", new Date(Number.NaN)],
        ["enumerable", enumerable],
        ["hidden", hidden],
        ["symbol", symbol],
        ["subclass", new DerivedDate("2026-01-01")],
        ["other native", new Map()]
      ] as const
    ) {
      expect({ caseName, ...Boundary.admitDecoded({ dates: [value] }) }).toEqual({
        caseName,
        ok: false,
        path: "$.dates[0]",
        complaint: "must be an ordinary record"
      })
    }
    for (const value of [Object.create(Date.prototype), new Proxy(new Date("2026-01-01"), {})]) {
      expect(Boundary.admitDecoded({ dates: [value] })).toEqual({
        ok: false,
        path: "$.dates[0]",
        complaint: "could not be inspected without executing user code"
      })
    }
  })

  it("rejects malformed arrays without invoking accessors", () => {
    const sparse = new Array(1)
    const decorated = Object.assign([1], { extra: true })
    class Derived extends Array<number> {}
    const getter = vi.fn(() => 1)
    const accessor = [1]
    Object.defineProperty(accessor, "0", { get: getter, enumerable: true, configurable: true })
    const hidden = [1]
    Object.defineProperty(hidden, "0", { value: 1, enumerable: false, configurable: true })
    for (const value of [sparse, decorated, new Derived(1), accessor, hidden]) {
      expect(admit(value)).toMatchObject({ ok: false })
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it("rejects exotic records, symbols, hidden fields, and accessors", () => {
    const getter = vi.fn(() => "secret")
    const accessor = Object.defineProperty({}, "value", { get: getter, enumerable: true })
    const hidden = Object.defineProperty({}, "value", { value: 1, enumerable: false })
    const symbolic = { [Symbol("x")]: 1 }
    const inherited = Object.create({ inherited: true })
    for (
      const value of [new Date(), new Map(), new Set(), new Uint8Array([1]), accessor, hidden, symbolic, inherited]
    ) {
      expect(admit(value)).toMatchObject({ ok: false })
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it("rejects prototype-control keys at every depth", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const direct = JSON.parse(`{"${key}":1}`)
      expect(admit(direct)).toMatchObject({ ok: false, path: `$.${key}` })
      expect(admit({ safe: direct })).toMatchObject({ ok: false, path: `$.safe.${key}` })
    }
  })

  it("rejects cycles, repeated references, and hostile proxies", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const shared = { value: 1 }
    const proxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    expect(admit(cycle)).toMatchObject({ ok: false, path: "$.self" })
    expect(admit({ left: shared, right: shared })).toMatchObject({ ok: false, path: "$.right" })
    expect(admit({ nested: proxy })).toMatchObject({ ok: false, path: "$.nested" })
  })

  it("enforces every JSON resource bound", () => {
    expect(admit(null, { maxBytes: 3 })).toMatchObject({ ok: false })
    expect(admit(true, { maxBytes: 3 })).toMatchObject({ ok: false })
    expect(admit(123, { maxBytes: 2 })).toMatchObject({ ok: false })
    expect(admit("1234", { maxBytes: 5 })).toMatchObject({ ok: false })
    expect(admit("1234", { maxStringBytes: 5 })).toMatchObject({ ok: false })
    expect(admit({ longKey: 1 }, { maxKeyBytes: 4 })).toMatchObject({ ok: false })
    expect(admit({ "\ud800": 1 })).toMatchObject({ ok: false })
    expect(admit({ a: 1, b: 2 }, { maxMembers: 1 })).toMatchObject({ ok: false })
    expect(admit([1, 2], { maxMembers: 1 })).toMatchObject({ ok: false })
    expect(admit([], { maxBytes: 1 })).toMatchObject({ ok: false })
    expect(admit({}, { maxBytes: 1 })).toMatchObject({ ok: false })
    expect(admit({ a: 1 }, { maxNodes: 1 })).toMatchObject({ ok: false })
    expect(admit({ a: { b: 1 } }, { maxDepth: 1 })).toMatchObject({ ok: false })
    expect(admit({ a: true }, { maxBytes: 10 })).toMatchObject({ ok: true })
  })

  it("inspects fixed records without inherited or executable fields", () => {
    expect(Boundary.inspectRecord({ a: 1, b: 2 }, ["a"], ["b"])).toMatchObject({
      ok: true,
      value: { a: 1, b: 2 }
    })
    expect(Boundary.inspectRecord({ a: 1 }, ["a"], ["b"])).toMatchObject({ ok: true, value: { a: 1 } })
    for (const value of [null, [], new Date(), { a: 1, extra: 2 }, { [Symbol("x")]: 1, a: 1 }]) {
      expect(Boundary.inspectRecord(value, ["a"])).toMatchObject({ ok: false })
    }
    const getter = vi.fn(() => 1)
    const accessor = Object.defineProperty({}, "a", { enumerable: true, get: getter })
    expect(Boundary.inspectRecord(accessor, ["a"])).toMatchObject({ ok: false })
    const optionalAccessor = Object.defineProperty({ a: 1 }, "b", { enumerable: true, get: getter })
    expect(Boundary.inspectRecord(optionalAccessor, ["a"], ["b"])).toMatchObject({ ok: false, path: "$.b" })
    expect(getter).not.toHaveBeenCalled()
    expect(Boundary.inspectRecord({}, ["a-b"])).toMatchObject({ ok: false, path: "$[\"a-b\"]" })
    const hostile = new Proxy({ a: 1 }, {
      ownKeys: () => {
        throw new Error("trap")
      }
    })
    expect(Boundary.inspectRecord(hostile, ["a"])).toMatchObject({ ok: false })
  })

  it("copies only bounded dense string arrays", () => {
    const options = { maxItems: 2, maxLength: 4 }
    expect(Boundary.stringArray(["a", "😀"], options)).toMatchObject({ ok: true, value: ["a", "😀"] })
    expect(Boundary.stringArray([""], options)).toMatchObject({ ok: false })
    expect(Boundary.stringArray([""], { ...options, allowEmpty: true })).toMatchObject({ ok: true })
    for (const value of [null, new Array(1), Object.assign(["a"], { extra: true }), ["abcde"], [1], ["\ud800"]]) {
      expect(Boundary.stringArray(value, options)).toMatchObject({ ok: false })
    }
    const getter = vi.fn(() => "a")
    const accessor = Object.defineProperty(["a"], "0", { enumerable: true, get: getter })
    expect(Boundary.stringArray(accessor, options)).toMatchObject({ ok: false })
    expect(getter).not.toHaveBeenCalled()
  })
})
