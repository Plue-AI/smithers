import { describe, expect, it } from "vitest"
import * as BoundedJson from "../src/BoundedJson.ts"

const limits: BoundedJson.StrictLimits = {
  maxBytes: 4096,
  maxDepth: 8,
  maxMembers: 32,
  maxNodes: 64,
  maxStringBytes: 256,
  maxKeyBytes: 128
}
const admissions = [
  ["ordinary", (value: unknown) => BoundedJson.admit(value, limits)],
  ["strict", (value: unknown) => BoundedJson.admitStrict(value, limits)]
] as const
const record = (value: BoundedJson.Json): { readonly [key: string]: BoundedJson.Json } => {
  const isRecord = (candidate: BoundedJson.Json): candidate is { readonly [key: string]: BoundedJson.Json } =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
  if (!isRecord(value)) throw new Error("Expected admitted record")
  return value
}

describe("BoundedJson descriptor and snapshot contracts", () => {
  it.each(admissions)("%s admits a transparent array proxy without any ordinary property reads", (_policy, admit) => {
    const target = [1, { value: 2 }]
    const reads: Array<PropertyKey> = []
    const inspected: Array<PropertyKey> = []
    const input = new Proxy(target, {
      get: (object, key, receiver) => {
        reads.push(key)
        return Reflect.get(object, key, receiver)
      },
      getOwnPropertyDescriptor: (object, key) => {
        inspected.push(key)
        return Reflect.getOwnPropertyDescriptor(object, key)
      }
    })
    const result = admit(input)
    expect(result).toMatchObject({ ok: true, value: [1, { value: 2 }] })
    expect(reads).toEqual([])
    expect(inspected).toContain("length")
    if (!result.ok) throw new Error("Transparent proxy was refused")
    expect(result.value).not.toBe(target)
    expect(Object.isFrozen(result.value)).toBe(true)
    target[1] = { value: 9 }
    expect(result.value).toEqual([1, { value: 2 }])
  })

  it.each(admissions)("%s uses descriptors even when the array get trap would throw", (_policy, admit) => {
    let reads = 0
    const input = new Proxy([1], {
      get: () => {
        reads++
        throw new Error("must not invoke ordinary get trap")
      }
    })
    expect(admit(input)).toMatchObject({ ok: true, value: [1] })
    expect(reads).toBe(0)
  })

  it.each(admissions)("%s refuses a throwing length descriptor trap without invoking ordinary get", (policy, admit) => {
    let reads = 0
    let inspections = 0
    const input = new Proxy([1], {
      get: (object, key, receiver) => {
        reads++
        return Reflect.get(object, key, receiver)
      },
      getOwnPropertyDescriptor: (object, key) => {
        if (key === "length") {
          inspections++
          throw new Error("descriptor inspection denied")
        }
        return Reflect.getOwnPropertyDescriptor(object, key)
      }
    })
    expect(admit(input)).toMatchObject(
      policy === "ordinary"
        ? { ok: false, code: "inspection", path: [], complaint: "cannot be inspected without executing object code" }
        : { ok: false, path: "$", complaint: "could not be inspected without executing user code" }
    )
    expect(reads).toBe(0)
    expect(inspections).toBe(1)
  })

  for (const [policy, admit] of admissions) {
    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000, "1", null, undefined, 1n])(
      `${policy} refuses an invalid reflected array length %s`,
      (length) => {
        const input = new Proxy([1], {
          getOwnPropertyDescriptor: (object, key) => {
            const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
            return key === "length" ? { ...descriptor, value: length } : descriptor
          }
        })
        // A writable array-length data descriptor can legally report another value through a Proxy.
        expect(Object.getOwnPropertyDescriptor(input, "length")?.value).toBe(length)
        expect(admit(input)).toMatchObject(
          policy === "ordinary"
            ? { ok: false, code: "arrayLength", path: [], complaint: "has an invalid array length" }
            : { ok: false, path: "$", complaint: "has an invalid array length" }
        )
      }
    )
  }

  it.each(admissions)(
    "%s checks a uint32 maximum length against the member budget before inspecting entries",
    (policy, admit) => {
      const inspected: Array<PropertyKey> = []
      const input = new Proxy([], {
        getOwnPropertyDescriptor: (object, key) => {
          inspected.push(key)
          const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
          return key === "length" ? { ...descriptor, value: 0xffffffff } : descriptor
        }
      })
      expect(admit(input)).toEqual(
        policy === "ordinary"
          ? { ok: false, code: "members", path: [], complaint: "exceeds the JSON members limit" }
          : { ok: false, path: "$", complaint: "exceeds the 32-member limit" }
      )
      expect(inspected).toEqual(["length"])
    }
  )

  it("ordinary admission copies reserved own data keys into detached null-prototype records at every depth", () => {
    const input: Record<string, unknown> = Object.create(null)
    const hostile = { polluted: "source value" }
    Object.defineProperties(input, {
      ["__proto__"]: { value: hostile, enumerable: true },
      constructor: { value: { name: "own constructor" }, enumerable: true },
      prototype: { value: [{ nested: true }], enumerable: true }
    })
    const result = BoundedJson.admit(input, limits)
    if (!result.ok) throw new Error(`Reserved own data was refused: ${result.complaint}`)
    const root = record(result.value)
    expect(root).toEqual({
      ["__proto__"]: { polluted: "source value" },
      constructor: { name: "own constructor" },
      prototype: [{ nested: true }]
    })
    expect(Object.getPrototypeOf(root)).toBeNull()
    expect(Object.getOwnPropertyDescriptor(root, "__proto__")).toMatchObject({
      enumerable: true,
      writable: false,
      configurable: false,
      value: { polluted: "source value" }
    })
    const proto = record(root["__proto__"]!)
    const constructor = record(root["constructor"]!)
    const nested = Object.getOwnPropertyDescriptor(root["prototype"], "0")?.value
    expect(Object.getPrototypeOf(proto)).toBeNull()
    expect(Object.getPrototypeOf(constructor)).toBeNull()
    expect(Object.getPrototypeOf(nested)).toBeNull()
    expect(proto).not.toBe(hostile)
    expect(Object.isFrozen(proto)).toBe(true)
    expect(Object.isFrozen(constructor)).toBe(true)
    expect(Object.isFrozen(root["prototype"])).toBe(true)
    expect(Object.isFrozen(nested)).toBe(true)
    expect(Object.hasOwn(root, "constructor")).toBe(true)
    expect(Object.hasOwn(root, "prototype")).toBe(true)
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false)
    hostile.polluted = "changed"
    expect(proto["polluted"]).toBe("source value")
  })

  it.each([false, true])(
    "strict ordinaryRecords=%s applies its prototype policy to nested records as well as the root",
    (ordinaryRecords) => {
      const input = { array: [{ value: 1 }], child: { value: 2 } }
      const result = BoundedJson.admitStrict(input, limits, { ordinaryRecords })
      if (!result.ok) throw new Error("Ordinary strict tree was refused")
      const root = record(result.value)
      const nested = Object.getOwnPropertyDescriptor(root["array"], "0")?.value
      const expected = ordinaryRecords ? Object.prototype : null
      expect(Object.getPrototypeOf(root)).toBe(expected)
      expect(Object.getPrototypeOf(root["child"])).toBe(expected)
      expect(Object.getPrototypeOf(nested)).toBe(expected)
      expect(Object.getPrototypeOf(root["array"])).toBe(Array.prototype)
      expect(Object.isFrozen(root["child"])).toBe(true)
      expect(Object.isFrozen(nested)).toBe(true)
      expect(root["child"]).not.toBe(input.child)
      expect(nested).not.toBe(input.array[0])
      input.child.value = 9
      input.array[0]!.value = 8
      expect(root).toEqual({ array: [{ value: 1 }], child: { value: 2 } })
    }
  )

  for (const ordinaryRecords of [false, true]) {
    for (const boundedText of [false, true]) {
      it.each(
        [
          ["__proto__", "$.__proto__"],
          ["constructor", "$.constructor"],
          ["prototype", "$.prototype"]
        ] as const
      )(`strict ordinaryRecords=${ordinaryRecords}, boundedText=${boundedText} refuses %s`, (key, path) => {
        const input = Object.defineProperty({}, key, { value: { harmless: 1 }, enumerable: true })
        expect(BoundedJson.admitStrict(input, limits, { ordinaryRecords, boundedText }))
          .toEqual({ ok: false, path, complaint: "uses a reserved property name" })
      })
    }
  }

  it("ordinary shared references become separate frozen children while strict trees reject repetition", () => {
    const shared = { value: 1 }
    const input = { left: shared, right: shared }
    const result = BoundedJson.admit(input, limits)
    if (!result.ok) throw new Error("Shared ordinary reference was refused")
    const output = record(result.value)
    expect(output).toEqual({ left: { value: 1 }, right: { value: 1 } })
    expect(output["left"]).not.toBe(shared)
    expect(output["right"]).not.toBe(shared)
    expect(output["left"]).not.toBe(output["right"])
    expect(Object.getPrototypeOf(output["left"])).toBeNull()
    expect(Object.getPrototypeOf(output["right"])).toBeNull()
    expect(Object.isFrozen(output["left"])).toBe(true)
    expect(Object.isFrozen(output["right"])).toBe(true)
    expect(BoundedJson.admitStrict(input, limits))
      .toEqual({ ok: false, path: "$.right", complaint: "contains a cycle or repeated object reference" })
    shared.value = 9
    expect(output).toEqual({ left: { value: 1 }, right: { value: 1 } })
  })

  for (const enumerable of [false, true]) {
    for (const hook of ["function", "getter"] as const) {
      it(`never executes an ${enumerable ? "enumerable" : "hidden"} toJSON ${hook}`, () => {
        let calls = 0
        const input = { kept: 1 }
        Object.defineProperty(
          input,
          "toJSON",
          hook === "getter"
            ? {
              enumerable,
              get: () => {
                calls++
                return () => {
                  calls++
                  return { forged: 1 }
                }
              }
            }
            : {
              enumerable,
              value: () => {
                calls++
                return { forged: 1 }
              }
            }
        )
        const ordinary = BoundedJson.admit(input, limits)
        expect(ordinary).toMatchObject(
          !enumerable
            ? { ok: true, value: { kept: 1 }, bytes: 10 }
            : hook === "function"
            ? { ok: false, code: "value", path: ["toJSON"], complaint: "contains a non-JSON function" }
            : { ok: false, code: "accessor", path: ["toJSON"], complaint: "contains an accessor" }
        )
        const strict = BoundedJson.admitStrict(input, limits)
        expect(strict).toEqual({
          ok: false,
          path: "$.toJSON",
          complaint: enumerable && hook === "function"
            ? "must contain only JSON values"
            : "must be an enumerable data property"
        })
        expect(calls).toBe(0)
      })
    }
  }
})

describe("BoundedJson strict native leaves", () => {
  const stamp = new Date(0)
  const native = (bytes: number) => (value: object) =>
    value instanceof Date ? { value: new Date(value.getTime()), bytes } : undefined

  it("admits a leaf the native hook detaches, and charges its declared size", () => {
    const result = BoundedJson.admitStrict({ at: stamp }, limits, { native: native(26) })
    if (!result.ok) throw new Error(result.complaint)
    const at = record(result.value)["at"] as unknown
    expect(at).toEqual(stamp)
    expect(at).not.toBe(stamp)
  })

  it("still refuses a non-ordinary object the native hook declines", () => {
    expect(BoundedJson.admitStrict({ at: new Map() }, limits, { native: native(26) }))
      .toEqual({ ok: false, path: "$.at", complaint: "must be an ordinary record" })
  })

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("refuses a native size of %s", (bytes) => {
    expect(BoundedJson.admitStrict({ at: stamp }, limits, { native: native(bytes) }))
      .toEqual({ ok: false, path: "$.at", complaint: "has an invalid native size" })
  })

  it("refuses a native leaf whose size overruns the byte budget", () => {
    expect(BoundedJson.admitStrict({ at: stamp }, limits, { native: native(limits.maxBytes) }))
      .toEqual({ ok: false, path: "$.at", complaint: `exceeds the ${limits.maxBytes}-byte limit` })
    expect(BoundedJson.admitStrict({ at: stamp }, limits, { native: native(limits.maxBytes - 16) }).ok).toBe(true)
  })
})
