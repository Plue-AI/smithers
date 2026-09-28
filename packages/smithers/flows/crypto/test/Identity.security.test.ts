/**
 * Regressions from the 2026-09-27 security review.
 *
 * Native source text such as `function () { [native code] }` names no
 * behavior, so it cannot key a deterministic identity. The shared realm state
 * must refuse a malformed pre-seeded value instead of adopting it.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { capture, functionIdentity } from "../src/Identity.ts"

const stateKey = Symbol.for("@smthrs/crypto/Identity/state/v5")

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("native source", () => {
  it("refuses bound functions, which would otherwise share one captured digest", () => {
    const one = function(this: { value: number }) {
      return this.value
    }.bind({ value: 1 })
    const two = function(this: { value: number }) {
      return this.value
    }.bind({ value: 2 })
    expect(Function.prototype.toString.call(one)).toBe(Function.prototype.toString.call(two))
    expect(() => capture({}, one)).toThrow(/Node\.capture: .*native source/)
    expect(() => capture({}, two)).toThrow(/Node\.capture: .*native source/)
  })

  it("refuses built-ins and function Proxies", () => {
    expect(() => capture({}, Math.max)).toThrow(/native source/)
    expect(() => capture({}, new Proxy((value: number) => value, {}))).toThrow(/native source/)
  })

  it("keeps undeclared native functions on the per-function ephemeral path", () => {
    const one = (() => 1).bind(null)
    const two = (() => 2).bind(null)
    expect(functionIdentity(one).algorithm).toBe("sha256-source-ephemeral/v4")
    expect(functionIdentity(one)).not.toEqual(functionIdentity(two))
  })

  it("still admits ordinary source that mentions native code", () => {
    const operation = capture({}, () => "{ [native code] }")
    expect(functionIdentity(operation).algorithm).toBe("sha256-source-captures/v5")
  })
})

describe("shared realm state", () => {
  const importWith = (value: unknown) => {
    vi.resetModules()
    vi.stubGlobal(stateKey, value)
    return import("../src/Identity.ts")
  }
  const valid = () => ({ captured: new WeakMap(), ephemeral: new WeakMap(), ordinal: 0, nonce: undefined })

  it.each([
    ["a non-object", 1],
    ["a forged captured map", { ...valid(), captured: { get: () => undefined, set: () => undefined } }],
    ["a forged ephemeral map", { ...valid(), ephemeral: new Map() }],
    ["a fixed short nonce", { ...valid(), nonce: "0" }],
    ["an uppercase nonce", { ...valid(), nonce: "A".repeat(32) }],
    ["a fractional ordinal", { ...valid(), ordinal: 0.5 }],
    ["a negative ordinal", { ...valid(), ordinal: -1 }]
  ])("refuses %s", async (_, value) => {
    await expect(importWith(value)).rejects.toThrow(/@smthrs\/crypto: malformed shared Identity state/)
  })

  it("adopts a well-formed state from a compatible copy", async () => {
    const shared = { ...valid(), nonce: "0123456789abcdef0123456789abcdef", ordinal: 7 }
    const identity = await importWith(shared)
    expect(identity.processNonce()).toBe(shared.nonce)
    identity.functionIdentity(() => 1)
    expect(shared.ordinal).toBe(8)
  })

  it("creates the shared state as a non-writable global", async () => {
    await importWith(undefined)
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, stateKey)!
    expect(descriptor.writable).toBe(false)
    expect(descriptor.enumerable).toBe(false)
    expect(() => {
      ;(globalThis as Record<symbol, unknown>)[stateKey] = valid()
    }).toThrow(TypeError)
  })

  it("never runs an adopted map's overridden methods", async () => {
    class Hostile extends WeakMap<object, never> {
      override get(): never {
        throw new Error("hostile get")
      }
    }
    const identity = await importWith({ ...valid(), captured: new Hostile(), ephemeral: new Hostile() })
    const operation = identity.capture({}, () => 1)
    expect(identity.functionIdentity(operation).algorithm).toBe("sha256-source-captures/v5")
    expect(identity.functionIdentity(() => 1).algorithm).toBe("sha256-source-ephemeral/v4")
  })
})
