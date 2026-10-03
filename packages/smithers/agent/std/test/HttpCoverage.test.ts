import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Http from "../src/internal/Http.ts"
import * as StdError from "../src/StdError.ts"

describe("bounded HTTP helpers", () => {
  it("preserves standard failures and describes opaque transport failures", () => {
    const existing = new StdError.StdError({ code: "permission_denied", message: "refused" })
    expect(Http.requestError("https://example.test", existing)).toBe(existing)
    expect(Http.requestError("https://example.test", { detail: "private" })).toMatchObject({
      code: "request_failed",
      message: "Request failed: https://example.test"
    })
    expect(Http.requestError("https://example.test", new Error("disconnected"))).toMatchObject({
      code: "request_failed",
      message: "Request failed: https://example.test (disconnected)"
    })
  })

  it("finds mixed-case headers and distinguishes absent and undefined values", () => {
    expect(Http.header({ "Retry-After": "3", "X-Other": "unused" }, "RETRY-AFTER")).toBe("3")
    expect(Http.header({ "Retry-After": undefined }, "retry-after")).toBeUndefined()
    expect(Http.header({ "X-Other": "unused" }, "retry-after")).toBeUndefined()
  })

  it.each([0, -1, NaN, Infinity, -Infinity])("refuses deadline %s before starting the effect", async (timeout) => {
    let started = false
    const error = await Effect.runPromise(Effect.flip(Http.withDeadline(
      Effect.sync(() => {
        started = true
      }),
      "https://example.test",
      timeout
    )))
    expect(error).toMatchObject({ code: "invalid_input", path: "https://example.test" })
    expect(started).toBe(false)
  })

  it("uses a caller's timeout error and finalizes the interrupted operation", async () => {
    const timeout = new StdError.StdError({ code: "timeout", message: "custom deadline" })
    let closed = false
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Http.withDeadline(
          Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
            closed = true
          }))),
          "https://example.test",
          1,
          (seconds) => {
            expect(seconds).toBe(1)
            return timeout
          }
        ).pipe(Effect.flip, Effect.forkChild)
        yield* TestClock.adjust(999)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result).toBe(timeout)
    expect(closed).toBe(true)
  })

  it("reads an empty body and a body at the exact capture limit without truncating", async () => {
    expect(await Effect.runPromise(Http.readBounded(Stream.empty, "https://example.test")))
      .toEqual(new Uint8Array(0))
    const first = new Uint8Array(Http.MAX_RESPONSE_BYTES - 1).fill(42)
    const last = new Uint8Array([43])
    const bytes = await Effect.runPromise(Http.readBounded(Stream.make(first, last), "https://example.test"))
    expect(bytes.byteLength).toBe(Http.MAX_RESPONSE_BYTES)
    expect(bytes[0]).toBe(42)
    expect(bytes[bytes.length - 1]).toBe(43)
  })
})
