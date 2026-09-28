import { describe, expect, it, vi } from "vitest"
import * as Config from "../src/Config.ts"
import * as Boundary from "../src/internal/Boundary.ts"
import { PluginError } from "../src/PluginError.ts"

const limits = (overrides: Partial<Boundary.Limits> = {}): Boundary.Limits => ({
  maxBytes: 1_024,
  maxDepth: 8,
  maxMembers: 16,
  maxNodes: 32,
  maxStringBytes: 128,
  maxKeyBytes: 32,
  ...overrides
})

const admit = (value: unknown, overrides?: Partial<Boundary.Limits>) => Boundary.admit(value, limits(overrides))

describe("the inert plugin JSON boundary", () => {
  it.each(["string", "key"] as const)(
    "refuses an oversized %s before scanning, serializing, or encoding it",
    (kind) => {
      const oversized = "x".repeat(1024 * 1024)
      const input = kind === "string" ? oversized : { [oversized]: null }
      const encode = vi.spyOn(TextEncoder.prototype, "encode")
      const stringify = vi.spyOn(JSON, "stringify")
      const charCodeAt = vi.spyOn(String.prototype, "charCodeAt")
      let result: Boundary.Admission
      let calls: Array<number>
      try {
        result = Boundary.admit(input)
        calls = [encode.mock.calls.length, stringify.mock.calls.length, charCodeAt.mock.calls.length]
      } finally {
        encode.mockRestore()
        stringify.mockRestore()
        charCodeAt.mockRestore()
      }
      expect(result).toMatchObject({
        ok: false,
        complaint: `exceeds the ${kind === "string" ? 65536 : 1024}-byte ${kind} limit`
      })
      expect(calls).toEqual([0, 0, 0])
    }
  )

  it("locates oversized keys by index without retaining the key", () => {
    for (const key of ["x".repeat(1024 * 1024), "\"".repeat(1024 * 1024), "é".repeat(512), "\"".repeat(512)]) {
      const result = Boundary.admit({ safe: { first: null, [key]: null } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.path.length).toBeLessThan(192)
      expect(result).toEqual({
        ok: false,
        path: "$.safe[key:1]",
        complaint: "exceeds the 1024-byte key limit"
      })
    }
  })

  it("still measures JSON quotes, escapes, and UTF-8 below the length prechecks", () => {
    for (const value of ["abc", "é", "中", "😀", "\"", "\n"]) {
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
      expect(admit(value, { maxStringBytes: bytes })).toEqual({ ok: true, value })
      expect(admit(value, { maxStringBytes: bytes - 1 })).toMatchObject({
        ok: false,
        complaint: `exceeds the ${bytes - 1}-byte string limit`
      })
      expect(admit({ [value]: null }, { maxKeyBytes: bytes })).toEqual({ ok: true, value: { [value]: null } })
      expect(admit({ [value]: null }, { maxKeyBytes: bytes - 1 })).toEqual({
        ok: false,
        path: "$[key:0]",
        complaint: `exceeds the ${bytes - 1}-byte key limit`
      })
    }
  })

  it("keeps oversized-key and nested-path PluginErrors below the journal byte bound", () => {
    const inputs: Array<unknown> = [{ ["x".repeat(1024 * 1024)]: null }]
    for (const character of ["a", "é", "中", "😀", "\"", "\\", "\u0000"]) {
      let nested: unknown = undefined
      for (let depth = 0; depth < 10; depth++) nested = { [character.repeat(100)]: nested }
      inputs.push(nested)
    }
    for (const input of inputs) {
      let error: unknown
      try {
        Config.merge({}, input)
      } catch (cause) {
        error = cause
      }
      expect(error).toBeInstanceOf(PluginError)
      const failure = error as PluginError
      expect(failure.code).toBe("config_invalid")
      expect(new TextEncoder().encode(JSON.stringify(failure.path)).byteLength).toBeLessThanOrEqual(192)
      expect(new TextEncoder().encode(JSON.stringify(failure)).byteLength).toBeLessThan(512)
      expect(Boundary.isWellFormedText(failure.path!)).toBe(true)
    }
  })

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

  it("copies every JSON scalar without normalizing valid text", () => {
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
    expect(copied.first).not.toBe(input.first)
    expect(copied.first[0]).not.toBe(nested)
    expect(Object.isFrozen(copied)).toBe(true)
    expect(Object.isFrozen(copied.first)).toBe(true)
    expect(Object.isFrozen(copied.first[0])).toBe(true)
    expect(Object.isFrozen(copied.second)).toBe(true)
    nested.value = 2
    expect(copied.first[0]?.value).toBe(1)
    expect(Object.keys(copied)).toEqual(["first", "second"])
  })

  it("rejects sparse, decorated, subclassed, and accessor arrays without invoking accessors", () => {
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

  it("rejects exotic records, symbols, hidden fields, and accessors without executing them", () => {
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
      const nested = { safe: direct }
      expect(admit(direct)).toMatchObject({ ok: false, path: `$.${key}` })
      expect(admit(nested)).toMatchObject({ ok: false, path: `$.safe.${key}` })
    }
  })

  it("rejects cycles, repeated references, and hostile proxies with the active path", () => {
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

  // A transparent proxy is undetectable by specification, so admission does not
  // claim to reject one. The guarantee it does make is narrower and is what this
  // pins: reflection is descriptor-only and bounded, so a non-throwing trap runs
  // a fixed number of times and only the inert data it returns is copied.
  it("copies a transparent proxy's data without letting its traps reach the result", () => {
    let traps = 0
    const proxy = new Proxy({ a: 1 }, {
      ownKeys: (target) => {
        traps += 1
        return Reflect.ownKeys(target)
      },
      getPrototypeOf: (target) => {
        traps += 1
        return Reflect.getPrototypeOf(target)
      },
      getOwnPropertyDescriptor: (target, key) => {
        traps += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const admitted = admit({ nested: proxy })
    // Sampled here because vitest's own comparators read the proxy afterwards.
    // ownKeys, getPrototypeOf, and one descriptor read for the single member.
    const during = traps
    expect(during).toBe(3)
    expect(admitted).toMatchObject({ ok: true, value: { nested: { a: 1 } } })
    const nested = ((admitted as Boundary.AdmissionSuccess).value as { readonly nested: object }).nested
    expect(nested).not.toBe(proxy)
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype)
    expect(Object.isFrozen(nested)).toBe(true)
  })

  it("enforces byte, string, key, depth, member, and node bounds", () => {
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

  it("accounts for cached JSON bytes, members, nodes and container depth exactly", () => {
    const snapshot = (input: unknown) => {
      const result = Boundary.record(input)
      if (!result.ok) throw new Error(result.complaint)
      return result.value as { readonly [key: string]: Boundary.Json }
    }
    const left = snapshot({ kept: [null, true, false, -1.5, "é\n"], nested: { left: {} }, replace: { old: true } })
    const right = snapshot({ nested: { right: ["😀"] }, replace: 0, added: { "\"": 1 } })
    const expected = { ...left, nested: { left: {}, right: ["😀"] }, replace: 0, added: { "\"": 1 } }
    const bytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength
    const exact = { ...Boundary.defaultLimits, maxBytes: bytes, maxMembers: 13, maxNodes: 14, maxDepth: 3 }
    const merged = Boundary.mergeRecords(left, right, exact)
    expect(merged).toEqual({ ok: true, value: expected })
    for (const key of ["maxBytes", "maxMembers", "maxNodes", "maxDepth"] as const) {
      const bounded = { ...exact, [key]: exact[key] - 1 }
      expect(Boundary.admit(expected, bounded).ok).toBe(false)
      expect(Boundary.mergeRecords(left, right, bounded).ok).toBe(false)
    }
    expect(Boundary.mergeRecords(snapshot({ nested: { a: 1 } }), snapshot({ nested: { b: 2 } }), {
      ...Boundary.defaultLimits,
      maxMembers: 1
    })).toMatchObject({ ok: false, path: "$.nested" })
    // A nested key that is not a JavaScript identifier reports the bracketed path.
    expect(Boundary.mergeRecords(snapshot({ "nested-key": { a: 1 } }), snapshot({ "nested-key": { b: 2 } }), {
      ...Boundary.defaultLimits,
      maxMembers: 1
    })).toMatchObject({ ok: false, path: "$[\"nested-key\"]" })
  })

  it("admits only records through the record entry point", () => {
    expect(Boundary.record({ ok: true }, limits())).toMatchObject({ ok: true })
    for (const value of [null, false, 1, "x", []]) {
      expect(Boundary.record(value, limits())).toEqual({ ok: false, path: "$", complaint: "must be a JSON record" })
    }
  })
})
