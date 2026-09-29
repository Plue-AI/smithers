import { describe, expect, it } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"

describe("CanonicalJson", () => {
  it("encodes differently constructed objects as identical bytes", () => {
    const first: Record<string, unknown> = {}
    first["z"] = { b: 2, a: 1 }
    first["a"] = "value"
    const second: Record<string, unknown> = {}
    second["a"] = "value"
    second["z"] = { a: 1, b: 2 }

    expect([...CanonicalJson.bytes(first)]).toEqual([...CanonicalJson.bytes(second)])
    expect(CanonicalJson.stringify(first)).toBe("{\"a\":\"value\",\"z\":{\"a\":1,\"b\":2}}")
  })

  it("preserves array order", () => {
    expect(CanonicalJson.stringify({ a: [3, { a: 1 }, 2] })).toBe("{\"a\":[3,{\"a\":1},2]}")
  })

  it("rejects nested values which JSON.stringify would silently coerce", () => {
    for (
      const invalid of [
        { schema: { multipleOf: Number.NaN } },
        { schema: { generatedAt: new Date(0) } },
        { schema: { metadata: new Map([["key", "value"]]) } },
        { schema: { omitted: undefined } }
      ]
    ) {
      expect(() => CanonicalJson.stringify(invalid)).toThrow(/not valid JSON/)
    }
  })

  it("encodes an own __proto__ member instead of dropping it", () => {
    // `JSON.parse` produces `__proto__` as an own data property, and a tool's
    // JSON Schema may declare a property with that name. Copying members into a
    // `{}` literal would route it through `Object.prototype`'s setter and lose
    // it, so the sealed-step key would not describe the body actually sent.
    const parsed = JSON.parse("{\"a\":1,\"__proto__\":{\"changed\":true}}") as Record<string, unknown>

    expect(CanonicalJson.stringify(parsed)).toBe("{\"__proto__\":{\"changed\":true},\"a\":1}")
    expect(new TextDecoder().decode(CanonicalJson.bytes(parsed))).toBe(CanonicalJson.stringify(parsed))
    // `JSON.stringify` keeps the member too; only the key order differs.
    expect(JSON.stringify(parsed)).toContain("\"__proto__\"")
    // The member is data, never a prototype mutation.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as { readonly changed?: unknown }).changed).toBeUndefined()
  })

  it("keeps pi's short-hash algorithm golden-vectored", () => {
    expect(CanonicalJson.shortHash("pi-tool-search")).toBe("10rp88s7t1h18")
  })

  it("rejects a self-referential array or object instead of recursing forever", () => {
    const cyclicArray: Array<unknown> = ["first"]
    cyclicArray.push(cyclicArray)
    expect(() => CanonicalJson.stringify({ items: cyclicArray })).toThrow("Value at $.items[1] is not valid JSON")

    const cyclicObject: Record<string, unknown> = { a: 1 }
    cyclicObject["self"] = cyclicObject
    expect(() => CanonicalJson.stringify(cyclicObject)).toThrow("Value at $.self is not valid JSON")

    // The same object twice is a diamond, not a cycle, and stays encodable.
    const shared = { b: 2 }
    expect(CanonicalJson.stringify({ left: shared, right: shared })).toBe("{\"left\":{\"b\":2},\"right\":{\"b\":2}}")
  })

  it("rejects symbol-keyed objects and non-finite numbers", () => {
    expect(() => CanonicalJson.stringify({ [Symbol("hidden")]: 1, visible: 2 })).toThrow(
      "Value at $ is not valid JSON"
    )
    expect(() => CanonicalJson.stringify({ a: Number.POSITIVE_INFINITY })).toThrow("Value at $.a is not valid JSON")
    expect(() => CanonicalJson.stringify({ a: Number.NEGATIVE_INFINITY })).toThrow("Value at $.a is not valid JSON")
    expect(() => CanonicalJson.stringify(() => 1)).toThrow("Value at $ is not valid JSON")
    expect(() => CanonicalJson.stringify(undefined)).toThrow("Value at $ is not valid JSON")
  })

  it("rejects Array subclass instances", () => {
    class Wrapped extends Array<unknown> {}
    expect(() => CanonicalJson.stringify({ items: Wrapped.from([1, 2]) })).toThrow("Value at $.items is not valid JSON")

    class Reshaped extends Array<unknown> {
      toJSON() {
        return "x"
      }
    }
    expect(() => CanonicalJson.stringify({ items: Reshaped.of(1) })).toThrow("Value at $.items is not valid JSON")

    const speciesProto = Object.create(Array.prototype)
    Object.defineProperty(speciesProto, "constructor", {
      value: { [Symbol.species]: class extends Array<unknown> {} }
    })
    const speciesArray = Object.setPrototypeOf([1], speciesProto)
    expect(Array.isArray(speciesArray)).toBe(true)
    expect(() => CanonicalJson.stringify({ items: speciesArray })).toThrow("Value at $.items is not valid JSON")
  })

  it("builds plain arrays without consulting Symbol.species", () => {
    const original = Object.getOwnPropertyDescriptor(Array, Symbol.species)!
    Object.defineProperty(Array, Symbol.species, {
      configurable: true,
      get: () => {
        throw new Error("species consulted")
      }
    })
    let encoded: string
    try {
      encoded = CanonicalJson.stringify({ items: [1, [2]] })
    } finally {
      Object.defineProperty(Array, Symbol.species, original)
    }
    expect(encoded).toBe("{\"items\":[1,[2]]}")
  })

  it("accepts plain arrays however they were constructed", () => {
    expect(CanonicalJson.stringify({ items: Array(3).fill(0) })).toBe("{\"items\":[0,0,0]}")
    expect(CanonicalJson.stringify({ items: Array.from({ length: 2 }, (_, index) => index) })).toBe("{\"items\":[0,1]}")
    expect(CanonicalJson.stringify({ items: Object.freeze([1, 2, 3]) })).toBe("{\"items\":[1,2,3]}")
  })

  it("rejects arrays which JSON.stringify would reshape", () => {
    // `JSON.stringify` writes a hole as `null` and drops every non-index
    // member, so the key and the wire body would describe different arrays.
    expect(() => CanonicalJson.stringify({ items: Array(1) })).toThrow("Value at $.items[0] is not valid JSON")
    expect(() => CanonicalJson.stringify({ items: [1, , 3] })).toThrow("Value at $.items[1] is not valid JSON")

    const symbolMember = Object.assign([1], { [Symbol("hidden")]: 2 })
    expect(() => CanonicalJson.stringify({ items: symbolMember })).toThrow("Value at $.items is not valid JSON")

    const namedMember = Object.assign([1], { extra: 2 })
    expect(() => CanonicalJson.stringify({ items: namedMember })).toThrow("Value at $.items is not valid JSON")

    const hiddenMember = [1]
    Object.defineProperty(hiddenMember, "extra", { value: 2, enumerable: false })
    expect(() => CanonicalJson.stringify({ items: hiddenMember })).toThrow("Value at $.items is not valid JSON")

    // Controls: an explicit `null` is JSON, an explicit `undefined` is not.
    expect(CanonicalJson.stringify({ items: [null] })).toBe("{\"items\":[null]}")
    expect(() => CanonicalJson.stringify({ items: [undefined] })).toThrow("Value at $.items[0] is not valid JSON")
  })

  it("encodes the empty, single-member, and primitive boundaries", () => {
    expect(CanonicalJson.stringify({})).toBe("{}")
    expect(CanonicalJson.stringify([])).toBe("[]")
    expect(CanonicalJson.stringify({ only: [] })).toBe("{\"only\":[]}")
    expect(CanonicalJson.stringify({ "": "" })).toBe("{\"\":\"\"}")
    expect(CanonicalJson.stringify({ a: null })).toBe("{\"a\":null}")
    expect(CanonicalJson.stringify(null)).toBe("null")
    expect(CanonicalJson.stringify(true)).toBe("true")
    expect(CanonicalJson.stringify("text")).toBe("\"text\"")
    expect(CanonicalJson.stringify(0)).toBe("0")
    expect(CanonicalJson.stringify(-1.5)).toBe("-1.5")
  })

  it("keeps the digest stable across key insertion order at every nesting depth", () => {
    const deep = (order: "forward" | "reverse"): unknown => {
      const leaf: Record<string, unknown> = {}
      if (order === "forward") {
        leaf["a"] = "é😀"
        leaf["b"] = [1, { y: 2, x: 1 }]
      } else {
        leaf["b"] = [1, { x: 1, y: 2 }]
        leaf["a"] = "é😀"
      }
      const middle: Record<string, unknown> = {}
      if (order === "forward") {
        middle["nested"] = leaf
        middle["zero"] = 0
      } else {
        middle["zero"] = 0
        middle["nested"] = leaf
      }
      return { root: middle }
    }

    expect(CanonicalJson.stringify(deep("forward"))).toBe(CanonicalJson.stringify(deep("reverse")))
    expect([...CanonicalJson.bytes(deep("forward"))]).toEqual([...CanonicalJson.bytes(deep("reverse"))])
    expect(CanonicalJson.stringify(deep("forward"))).toBe(
      "{\"root\":{\"nested\":{\"a\":\"é😀\",\"b\":[1,{\"x\":1,\"y\":2}]},\"zero\":0}}"
    )
    // UTF-8 bytes, not UTF-16 code units: `é` is two bytes and the emoji four.
    expect(CanonicalJson.bytes({ k: "é😀" })).toHaveLength(14)
    expect(new TextDecoder().decode(CanonicalJson.bytes({ k: "é😀" }))).toBe("{\"k\":\"é😀\"}")
  })

  it("hashes the empty string and distinguishes single-character inputs", () => {
    expect(CanonicalJson.shortHash("")).toBe("k4n83c7h0j2b")
    expect(CanonicalJson.shortHash("a")).toBe("m8735310ae7sx")
    expect(CanonicalJson.shortHash("b")).toBe("jbf49n1hx4dkv")
    expect(CanonicalJson.shortHash("é😀")).toBe("102l7zrk951la")
    expect(CanonicalJson.shortHash("a")).toBe(CanonicalJson.shortHash("a"))
  })
})
