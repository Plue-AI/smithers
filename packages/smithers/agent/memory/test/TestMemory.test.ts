import { Crypto, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "project-1" } as const

const createThreads = (count: number) =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const ids: Array<string> = []
    for (let index = 0; index < count; index += 1) {
      const thread = yield* store.createThread({ namespace })
      ids.push(thread.id)
    }
    return ids
  })

describe("TestMemory", () => {
  it("provides deterministic digest bytes to tests", async () => {
    const input = new Uint8Array([0, 1, 255])
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const crypto = yield* Crypto.Crypto
        return yield* crypto.digest("SHA-256", input)
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result).toEqual(input)
  })

  it("generates a distinct thread id past the 256th request", async () => {
    const ids = await Effect.runPromise(createThreads(257).pipe(Effect.provide(TestMemory.layer)))

    expect(new Set(ids).size).toBe(257)
  })

  it("restarts its generated ids on every build of the same layer", async () => {
    const first = await Effect.runPromise(createThreads(3).pipe(Effect.provide(TestMemory.layer)))
    const second = await Effect.runPromise(createThreads(3).pipe(Effect.provide(TestMemory.layer)))

    expect(second).toEqual(first)
  })
})
