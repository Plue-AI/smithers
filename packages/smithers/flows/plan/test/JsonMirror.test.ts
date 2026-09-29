/**
 * The JSON mirror shared by AST payloads, plan key material, and plan diffs.
 * Each caller supplies its own planned-value policy; everything else is what
 * `JSON.stringify` would see.
 */
import { describe, expect, it } from "vitest"
import { GraphBuildError } from "../src/GraphBuildError.ts"
import { jsonMirror } from "../src/internal/JsonMirror.ts"
import * as Planned from "../src/Planned.ts"

const refuseEveryPlannedValue = () => {
  throw new Error("no planned value expected")
}

const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
  } catch (cause) {
    return cause
  }
  throw new Error("expected a refusal")
}

describe("jsonMirror", () => {
  it("mirrors exactly what JSON.stringify sees", () => {
    const input = {
      when: new Date(0),
      list: [undefined, () => 1, Symbol("s"), 3],
      nested: { dropped: undefined, kept: null },
      [Symbol("key")]: "ignored"
    }
    const mirror = jsonMirror(input, refuseEveryPlannedValue)
    expect(JSON.stringify(mirror)).toBe(JSON.stringify(input))
    expect(mirror).toEqual({ when: "1970-01-01T00:00:00.000Z", list: [null, null, null, 3], nested: { kept: null } })
    expect(jsonMirror(undefined, refuseEveryPlannedValue)).toBeUndefined()
  })

  it("omits undefined data toJSON on own, nested, and nonenumerable members", () => {
    const hidden = Object.defineProperty({ value: 3 }, "toJSON", { value: undefined })
    const input = { toJSON: undefined, value: 1, nested: { toJSON: undefined, value: 2 }, hidden }
    expect(jsonMirror(input, refuseEveryPlannedValue)).toEqual({
      value: 1,
      nested: { value: 2 },
      hidden: { value: 3 }
    })

    let called = false
    const getter = Object.defineProperty({}, "toJSON", {
      get: () => {
        called = true
        return undefined
      }
    })
    expect(thrownBy(() => jsonMirror({ getter }, refuseEveryPlannedValue))).toMatchObject({
      code: "invalid_payload",
      path: ["getter"],
      message: "Plan payload at $.getter has an accessor-backed toJSON member"
    })
    expect(called).toBe(false)
  })

  it("hands each planned value and its reference to the caller's policy", () => {
    const planned = (Planned.make<{ readonly x: unknown }>("upstream") as unknown as { readonly x: unknown }).x
    const seen: Array<unknown> = []
    const mirror = jsonMirror({ at: [planned] }, (value, reference) => {
      seen.push(value)
      return { node: reference.node, path: reference.path }
    })
    expect(seen).toEqual([planned])
    expect(mirror).toEqual({ at: [{ node: "upstream", path: ["x"] }] })
  })

  it("keeps shared references shared and cycles cyclic", () => {
    const shared = { value: 1 }
    const cyclic: Record<string, unknown> = { first: shared, second: shared }
    cyclic.self = cyclic
    const mirror = jsonMirror(cyclic, refuseEveryPlannedValue) as Record<string, unknown>
    expect(mirror.first).toBe(mirror.second)
    expect(mirror.self).toBe(mirror)
    expect(mirror.first).not.toBe(shared)
  })

  it("refuses an accessor, naming its path", () => {
    const input = { outer: [Object.defineProperty({}, "getter", { enumerable: true, get: () => 1 })] }
    const thrown = thrownBy(() => jsonMirror(input, refuseEveryPlannedValue))
    expect(thrown).toBeInstanceOf(GraphBuildError)
    expect(thrown).toMatchObject({
      code: "invalid_payload",
      node: "payload",
      path: ["outer", "0", "getter"],
      message: "Plan payload at $.outer.0.getter is an accessor"
    })
  })

  it("refuses a toJSON that returns itself", () => {
    const selfish = {
      toJSON() {
        return selfish
      }
    }
    const thrown = thrownBy(() => jsonMirror({ selfish }, refuseEveryPlannedValue))
    expect(thrown).toBeInstanceOf(GraphBuildError)
    expect(thrown).toMatchObject({
      code: "cyclic_payload",
      path: ["selfish"],
      message: "Plan payload at $.selfish has a toJSON method that returns itself"
    })
  })
})
