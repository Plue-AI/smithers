import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Effect, Fiber } from "effect"
import { describe, expect, it, vi } from "vitest"
import { makeHostAdapterLoader } from "../src/SandboxMerge/HostAdapter.ts"

describe("host adapter loading", () => {
  it("returns a typed failure and retries a rejected import", async () => {
    const cause = new Error("adapter unavailable")
    const importer = vi.fn<() => Promise<typeof NodeJj>>()
      .mockRejectedValueOnce(cause)
      .mockResolvedValue(NodeJj)
    const load = makeHostAdapterLoader(importer)
    const error = await Effect.runPromise(Effect.flip(load))
    expect(error._tag).toBe("@smthrs/sandbox/SandboxMerge/MergeError")
    expect(error.reason).toBe("vcs_failed")
    expect(error.message).toContain("could not load")
    expect(error.cause).toBe(cause)
    expect(await Effect.runPromise(load)).toBe(NodeJj)
    expect(await Effect.runPromise(load)).toBe(NodeJj)
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it("shares one pending import across concurrent and subsequent callers", async () => {
    const { promise, resolve } = Promise.withResolvers<typeof NodeJj>()
    const importer = vi.fn(() => promise)
    const load = makeHostAdapterLoader(importer)
    const first = Effect.runPromise(load)
    const second = Effect.runPromise(load)
    expect(importer).toHaveBeenCalledTimes(1)
    resolve(NodeJj)
    expect(await first).toBe(NodeJj)
    expect(await second).toBe(NodeJj)
    expect(await Effect.runPromise(load)).toBe(NodeJj)
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it("allows a second caller to succeed after cancelling the first pending load", async () => {
    const { promise, resolve } = Promise.withResolvers<typeof NodeJj>()
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>()
    const importer = vi.fn(() => {
      enter()
      return promise
    })
    const load = makeHostAdapterLoader(importer)
    const first = Effect.runFork(load)
    await entered
    await Effect.runPromise(Fiber.interrupt(first))
    expect(first.pollUnsafe()?._tag).toBe("Failure")
    const second = Effect.runPromise(load)
    resolve(NodeJj)
    expect(await second).toBe(NodeJj)
    expect(await Effect.runPromise(load)).toBe(NodeJj)
    expect(importer).toHaveBeenCalledTimes(1)
  })
})
