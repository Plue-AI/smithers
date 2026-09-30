import * as Effect from "effect/Effect"
import { StorageFailure } from "./Failures"

/*
 * Durable Object storage as this Worker's Effects see it: the sealed export
 * (src/MaintenanceExport.ts) pages a retained object's keys through here. The
 * keys it reads are the legacy Worker's persisted identities; nothing here
 * writes them.
 */

/** The platform storage surface the export needs (a subset of `DurableObjectStorage`). */
export interface NativeStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>
  readonly put: (key: string | Record<string, unknown>, value?: unknown) => Promise<void>
  readonly list?: <T>(options: StorageListOptions) => Promise<Map<string, T>>
  readonly delete?: (key: string) => Promise<boolean | void>
}

export interface StorageListOptions { readonly prefix: string; readonly limit: number; readonly startAfter?: string }

/** Key-ordered listing as an Effect; a throwing platform call is a StorageFailure. */
export const storageFrom = (storage: NativeStorage) => ({
  list: <T>(options: StorageListOptions): Effect.Effect<Map<string, T>, StorageFailure> => Effect.tryPromise({
    try: () => storage.list ? storage.list<T>(options) : Promise.reject(new Error("Storage listing is unavailable")),
    catch: cause => new StorageFailure({ operation: "storage.list", cause })
  })
})

/** An in-memory storage for tests. */
export const memoryStorage = (initial?: Record<string, unknown>, retained?: Map<string, unknown>): NativeStorage & { readonly data: Map<string, unknown> } => {
  const data = retained ?? new Map<string, unknown>(Object.entries(structuredClone(initial ?? {})))
  return {
    data,
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => {
      const entries = structuredClone(typeof key === "string" ? [[key, value]] : Object.entries(key)) as Array<[string, unknown]>
      for (const [name, item] of entries) data.set(name, item)
    },
    list: async <T>({ prefix, limit, startAfter }: StorageListOptions) => new Map([...data.entries()]
      .filter(([name]) => name.startsWith(prefix) && (startAfter === undefined || name > startAfter))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([name, item]) => [name, structuredClone(item) as T])),
    delete: async (key: string) => { data.delete(key) }
  }
}
