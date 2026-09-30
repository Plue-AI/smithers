import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { memoryStorage, storageFrom } from "./DurableStorage"
import { StorageFailure } from "./Failures"

describe("storageFrom over the platform storage", () => {
  test("prefix pagination reads cloned rows and proves the final partial page", async () => {
    const storage = memoryStorage({ "r:b": { value: 2 }, "r:a": { value: 1 }, "other:a": 3 })
    const rows = await Effect.runPromise(storageFrom(storage).list<{ value: number }>({ prefix: "r:", limit: 1 }))
    expect([...rows.keys()]).toEqual(["r:a"])
    rows.get("r:a")!.value = 9
    const rest = await Effect.runPromise(storageFrom(storage).list<{ value: number }>({ prefix: "r:", limit: 50, startAfter: "r:a" }))
    expect([...rest]).toEqual([["r:b", { value: 2 }]])
    expect(await storage.get<{ value: number }>("r:a")).toEqual({ value: 1 })
  })

  test("a throwing or absent listing is a StorageFailure naming the operation", async () => {
    const broken = { ...memoryStorage(), list: async () => { throw new Error("storage unavailable") } }
    for (const storage of [broken, { get: broken.get, put: broken.put }]) {
      const result = await Effect.runPromise(storageFrom(storage).list({ prefix: "", limit: 1 }).pipe(Effect.result))
      expect(Result.isFailure(result)).toBe(true)
      const failure = Result.isFailure(result) ? result.failure : undefined
      expect(failure).toBeInstanceOf(StorageFailure)
      expect(failure?.operation).toBe("storage.list")
    }
  })

  test("memory storage clones on write and read", async () => {
    const storage = memoryStorage({ retained: 1 })
    const value = { id: 1 }
    await storage.put({ request: value, pointer: 1 })
    value.id = 2
    const row = await storage.get<{ id: number }>("request"); row!.id = 99
    expect(await storage.get<{ id: number }>("request")).toEqual({ id: 1 })
    await storage.delete!("pointer")
    expect([...storage.data.keys()]).toEqual(["retained", "request"])
  })
})
