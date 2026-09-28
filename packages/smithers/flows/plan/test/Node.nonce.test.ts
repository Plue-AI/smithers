/**
 * The ephemeral-identity nonce must not be seeded while the module evaluates.
 *
 * Cloudflare Workers rejects an upload whose script calls
 * `crypto.getRandomValues` at global scope with error 10021, "Disallowed
 * operation called within global scope", so any bundle containing this module
 * would fail to deploy.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Replaces `globalThis.crypto` with a proxy that counts `getRandomValues` calls
 * and rejects them until the test allows them, mimicking the Workers global
 * scope restriction.
 */
const guardCrypto = () => {
  const real = globalThis.crypto
  let allowed = false
  let calls = 0
  const getRandomValues = <A extends ArrayBufferView | null>(array: A): A => {
    calls++
    if (!allowed) throw new Error("Disallowed operation called within global scope")
    return real.getRandomValues(array as never) as A
  }
  vi.stubGlobal(
    "crypto",
    new Proxy(real, {
      get: (target, property, receiver) =>
        property === "getRandomValues" ? getRandomValues : Reflect.get(target, property, receiver)
    })
  )
  return {
    allow: () => {
      allowed = true
    },
    deny: () => {
      allowed = false
    },
    calls: () => calls
  }
}

/** Evaluates a fresh copy of the module under the guarded global. */
const importFresh = async () => {
  vi.resetModules()
  return import("../src/internal/node.ts")
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("Node ephemeral nonce", () => {
  it("evaluates the module without reading entropy", async () => {
    const crypto = guardCrypto()

    await expect(importFresh()).resolves.toBeDefined()
    expect(crypto.calls()).toBe(0)
  })

  it("seeds the nonce on the first unannotated identity and memoizes it", async () => {
    const crypto = guardCrypto()
    const internal = await importFresh()

    crypto.allow()
    const first = internal.functionIdentity((value: number) => value + 1)
    expect(first.algorithm).toBe("sha256-source-ephemeral/v4")
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(crypto.calls()).toBe(1)

    // A memoized nonce never reaches entropy again, so a second identity
    // succeeds even after the guard closes.
    crypto.deny()
    const second = internal.functionIdentity((value: number) => value * 2)
    expect(second.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(second.digest).not.toBe(first.digest)
    expect(crypto.calls()).toBe(1)
  })

  it("digests a captured function without reading entropy at all", async () => {
    const crypto = guardCrypto()
    const internal = await importFresh()

    const captured = internal.capture({ step: 1 }, (value: number) => value + 1)
    expect(internal.functionIdentity(captured).algorithm).toBe("sha256-source-captures/v5")
    expect(crypto.calls()).toBe(0)
  })
})
