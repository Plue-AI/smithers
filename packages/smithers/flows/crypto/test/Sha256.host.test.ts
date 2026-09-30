import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Cause, Crypto, Effect, Exit, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { digest, digestSync, Sha256, Sha256Error, syncCrypto } from "../src/index.ts"
import { vectors } from "./fixtures.ts"

const encoder = new TextEncoder()

const bytesFromHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))

const host = (operation: Crypto.Crypto["digest"]): Crypto.Crypto =>
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: operation
  })

const run = (input: string | Uint8Array, crypto: Crypto.Crypto) =>
  Effect.runSync(Effect.provideService(digest(input), Crypto.Crypto, crypto))

const fail = (input: string | Uint8Array, crypto: Crypto.Crypto) =>
  Effect.runSync(Effect.flip(Effect.provideService(digest(input), Crypto.Crypto, crypto)))

const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("injected Crypto boundary", () => {
  it.each([31, 33])("rejects a %i-byte host digest", (length) => {
    expect(fail("secret", host(() => Effect.succeed(new Uint8Array(length))))).toMatchObject({
      code: "invalid_digest",
      message: `The injected Crypto service returned ${length} SHA-256 bytes; expected 32`
    })
  })

  it("rejects a non-byte host digest", () => {
    const malformed = host(() => Effect.succeed([] as unknown as Uint8Array))
    expect(fail("secret", malformed)).toMatchObject({
      code: "invalid_digest",
      message: "The injected Crypto service returned a non-Uint8Array SHA-256 digest"
    })
  })

  it("rejects host digest bytes that cannot be copied", () => {
    const output = new Uint8Array(32)
    structuredClone(output.buffer, { transfer: [output.buffer] })
    expect(fail("secret", host(() => Effect.succeed(output)))).toMatchObject({
      code: "invalid_digest",
      message: "The injected Crypto service returned SHA-256 bytes that could not be copied",
      cause: expect.any(TypeError)
    })
  })

  it("preserves typed host failures under a stable, input-safe error", () => {
    const cause = PlatformError.systemError({
      _tag: "Unknown",
      module: "test-host",
      method: "digest",
      description: "hardware failure"
    })
    const error = fail("do-not-log-this-secret", host(() => Effect.fail(cause)))
    expect(error).toBeInstanceOf(Sha256Error)
    expect(error).toMatchObject({
      code: "digest_failed",
      message: "The injected Crypto service failed to compute SHA-256",
      cause
    })
    expect(error.message).not.toContain("do-not-log-this-secret")
  })

  it("preserves a synchronous throw from an adversarial host", () => {
    const cause = { reason: "synchronous host throw" }
    const crypto = host(() => {
      throw cause
    })
    expect(fail("secret", crypto)).toMatchObject({
      code: "digest_failed",
      cause
    })
  })

  it("rejects a host that returns a non-Effect operation", () => {
    const crypto = host((() => new Uint8Array(32)) as never)
    expect(fail("secret", crypto)).toMatchObject({
      code: "digest_failed",
      message: "The injected Crypto service returned a non-Effect SHA-256 operation"
    })
  })

  it("turns a host Effect defect into a cause-preserving typed failure", () => {
    const cause = { reason: "host defect" }
    expect(fail("secret", host(() => Effect.die(cause)))).toMatchObject({
      code: "digest_failed",
      cause
    })
  })

  it("redacts schema input while retaining a typed cause annotation", () => {
    const cause = new Error("backend unavailable")
    const secret = "schema-secret-that-must-not-appear"
    const crypto = host(() =>
      Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "test-host",
        method: "digest",
        cause
      }))
    )
    const error = Effect.runSync(Effect.flip(
      Schema.decodeUnknownEffect(Sha256)(secret, { reportInput: true }).pipe(
        Effect.provideService(Crypto.Crypto, crypto)
      )
    ))
    expect(error.message).toContain("[digest_failed] The injected Crypto service failed to compute SHA-256")
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
    expect(error.issue).toMatchObject({
      issue: {
        annotations: {
          code: "digest_failed",
          cause: expect.objectContaining({
            _tag: "@smthrs/crypto/Sha256Error",
            cause: expect.objectContaining({ reason: expect.objectContaining({ cause }) })
          })
        }
      }
    })
  })

  it("reports a missing Crypto service as an Effect configuration defect", () => {
    const exit = Effect.runSyncExit(digest("hello") as Effect.Effect<never, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("Service not found: effect/Crypto")
    }
  })

  it("snapshots caller bytes before an asynchronous host can observe mutation", async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    const crypto = host((_algorithm, input) =>
      Effect.promise(async () => {
        started.resolve()
        await release.promise
        const output = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(input))
        return new Uint8Array(output)
      })
    )
    const input = encoder.encode("abc")
    const running = Effect.runPromise(Effect.provideService(digest(input), Crypto.Crypto, crypto))

    await started.promise
    input.fill(0)
    release.resolve()

    await expect(running).resolves.toBe(vectors[1][1])
  })

  it("isolates caller input from a host that mutates its byte argument", () => {
    const input = encoder.encode("abc")
    const crypto = host((_algorithm, snapshot) =>
      Effect.sync(() => {
        snapshot.fill(0)
        return bytesFromHex(digestSync(snapshot))
      })
    )
    run(input, crypto)
    expect(input).toEqual(encoder.encode("abc"))
  })

  it("copies a mutable, reused host output before returning", () => {
    const output = bytesFromHex(vectors[1][1])
    const crypto = host(() => Effect.succeed(output))
    const first = run("abc", crypto)
    output.fill(0)
    const second = run("abc", crypto)

    expect(first).toBe(vectors[1][1])
    expect(second).toBe("0".repeat(64))
    expect(first).toBe(vectors[1][1])
  })

  it("copies host output without invoking an adversarial iterator", () => {
    const output = bytesFromHex(vectors[1][1])
    let iterated = false
    Object.defineProperty(output, Symbol.iterator, {
      value: function*() {
        iterated = true
        output.fill(0)
        yield* Uint8Array.prototype[Symbol.iterator].call(output)
      }
    })

    expect(run("abc", host(() => Effect.succeed(output)))).toBe(vectors[1][1])
    expect(iterated).toBe(false)
  })
})

describe("host parity and synchronous service policy", () => {
  it.each(vectors)("agrees with Node and Web Crypto for %j", async (input, expected) => {
    const bytes = encoder.encode(input)
    const web = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
    expect(bytesFromHex(digestSync(input))).toEqual(web)
    expect(Effect.runSync(digest(input).pipe(Effect.provide(NodeCrypto.layer)))).toBe(expected)
  })

  it("accepts SHA-256 through syncCrypto", () => {
    const output = Effect.runSync(syncCrypto.digest("SHA-256", encoder.encode("abc")))
    expect(output).toEqual(bytesFromHex(vectors[1][1]))
  })

  it("rejects every non-SHA-256 algorithm through syncCrypto", () => {
    const error = Effect.runSync(Effect.flip(syncCrypto.digest("SHA-384", encoder.encode("abc"))))
    expect(error).toMatchObject({
      reason: {
        _tag: "BadArgument",
        module: "@smthrs/crypto",
        method: "digest",
        description: "syncCrypto supports only SHA-256, not SHA-384"
      }
    })
  })

  it("reports an uncopyable syncCrypto input as BadArgument", () => {
    const input = encoder.encode("abc")
    structuredClone(input.buffer, { transfer: [input.buffer] })
    const error = Effect.runSync(Effect.flip(syncCrypto.digest("SHA-256", input)))
    expect(error).toMatchObject({
      reason: {
        _tag: "BadArgument",
        module: "@smthrs/crypto",
        method: "digest",
        description: "syncCrypto could not snapshot SHA-256 input",
        cause: expect.any(TypeError)
      }
    })
  })

  it("refuses randomness instead of returning weak bytes", () => {
    expect(() => Effect.runSync(syncCrypto.randomBytes(16))).toThrow(
      "@smthrs/crypto syncCrypto provides SHA-256 only; supply a platform Crypto layer for randomness"
    )
    const exit = Effect.runSyncExit(syncCrypto.randomBytes(16))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      _tag: "PlatformError",
      reason: {
        _tag: "BadArgument",
        module: "@smthrs/crypto",
        method: "randomBytes",
        description: "@smthrs/crypto syncCrypto provides SHA-256 only; supply a platform Crypto layer for randomness"
      }
    })
  })
})
