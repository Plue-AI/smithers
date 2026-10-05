import { Data } from "effect"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { localOnlyCollectionOptions } from "@tanstack/db"
import type { InferSchemaOutput, StorageApi } from "@tanstack/db"
import { normalizeStorageRowKey, storageRowKey as rowKey } from "./StorageRowKey"
import { randomUuid } from "../runtime/RandomUuid"

interface StoredItem {
  readonly versionKey: string
  readonly data: unknown
}

export interface DurableBatch {
  readonly beginBatch: () => void
  readonly commitBatch: () => void
  readonly abortBatch: () => void
}

/** One committed row transition. An absent `versionKey` removes the row. */
export interface DurableRowDelta {
  readonly key: string
  /** The row version this mutation read; undefined requires an absent row. */
  readonly expectedVersionKey?: string | undefined
  readonly versionKey: string | undefined
  readonly data: unknown
}

/** A host that stores rows individually, so a commit costs its own rows only. */
export interface DurableRowSink {
  readonly applyRows: (collectionId: string, deltas: ReadonlyArray<DurableRowDelta>) => void
  /**
   * The host's rows, handed over as rows. Without it a collection is read by
   * serializing the whole host view to JSON and parsing it straight back — the
   * round trip that made a large store exceed V8's string ceiling and fail
   * boot outright (chain/PersistenceBudget.ts). Optional: the localStorage
   * envelope and older injected hosts keep the string view.
   */
  readonly readRows?: (collectionId: string) => ReadonlyMap<string, StoredItem>
}

export interface PersistedTransaction {
  readonly id?: string | undefined
  readonly mutations: ReadonlyArray<{
    readonly collection: { readonly id: string }
    readonly key: string | number
    readonly type: "insert" | "update" | "delete"
    readonly original: unknown
    readonly modified: unknown
    /** Keep an unchanged row in the durable CAS read set (for authority fences). */
    readonly retainUnchanged?: boolean
  }>
}

export interface CollectionPersistence {
  readonly register: (id: string) => ReadonlyArray<unknown>
  readonly persist: (transaction: PersistedTransaction) => Promise<void>
  /**
   * Every durable write accepted so far, settled. Writes are serialized and a
   * backend flush is asynchronous, so a caller about to leave the page (the
   * OAuth hop, the GitHub App install) waits for this first; otherwise the
   * navigation outruns the queue and the state that click just changed is lost.
   */
  readonly settled: () => Promise<void>
}

const storageKey = (id: string): string => `smithers-mvp.${id}`

const comparableJson = (value: unknown): string | undefined => JSON.stringify(value, (_key, nested: unknown) =>
  typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested
)

export class StaleDurableMutationError extends Data.TaggedError("StaleDurableMutationError")<{ readonly message: string }> {
  constructor(collectionId: string, key: string | number) {
    super({ message: `The ${collectionId}/${key} mutation was based on state that did not persist. Retry after rollback.` })
  }
}

/** A different writer committed after this adapter loaded its base. */
export class DurableStorageConflictError extends Data.TaggedError("DurableStorageConflictError")<{
  readonly boundary: string
  readonly message: string
}> {
  constructor(boundary: string) {
    super({ boundary, message: `Stored state changed at ${boundary}. This stale writer was refused; reload the current state before retrying.` })
  }
}

const normalizedRowKey = normalizeStorageRowKey

const readStringRows = (storage: StorageApi, id: string, raw = storage.getItem(storageKey(id))): Map<string, StoredItem> => {
  if (raw === null) return new Map()
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid persisted collection ${id}.`)
  const rows = new Map<string, StoredItem>()
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || !("versionKey" in value) || typeof value.versionKey !== "string" || !("data" in value)) {
      throw new Error(`Invalid persisted row ${id}/${key}.`)
    }
    rows.set(normalizedRowKey(key), { versionKey: value.versionKey, data: value.data })
  }
  return rows
}

/** Rows from the host that stores rows, else from its whole-collection string. */
const readRows = (
  options: { readonly storage: StorageApi; readonly rows?: DurableRowSink },
  id: string
): Map<string, StoredItem> => {
  const direct = options.rows?.readRows
  if (direct === undefined) return readStringRows(options.storage, id)
  const rows = new Map<string, StoredItem>()
  for (const [key, value] of direct(id)) rows.set(normalizedRowKey(key), value)
  return rows
}

/** One serialized durable commit per transaction, with rollback of uncommitted rows. */
export const createCollectionPersistence = (options: {
  readonly storage: StorageApi
  readonly batch?: DurableBatch
  readonly flush?: () => Promise<void>
  /** Given a normalized host, commits carry row deltas instead of collection JSON. */
  readonly rows?: DurableRowSink
  /** Refuse writes that did not enter through the owner's transition protocol. */
  readonly authorize?: (transaction: PersistedTransaction) => void
}): CollectionPersistence => {
  const registered = new Set<string>()
  // The registered projection of every durable row, so neither the stale-state
  // check nor a commit has to reparse a whole collection out of the store.
  const projected = new Map<string, Map<string, StoredItem>>()
  // A local collection's encoded string is immutable evidence of its exact
  // rows. Re-read that string on every transaction, but do not parse an
  // unchanged collection again. These maps never escape through register().
  const localCache = new Map<string, { readonly raw: string | null; readonly rows: Map<string, StoredItem> }>()
  let tail: Promise<void> = Promise.resolve()
  let generation = 0
  let priorFailure: unknown

  const projection = (id: string): Map<string, StoredItem> => {
    const known = projected.get(id)
    if (known !== undefined) return known
    const rows = readRows(options, id)
    projected.set(id, rows)
    return rows
  }

  const localProjection = (id: string): Map<string, StoredItem> => {
    const raw = options.storage.getItem(storageKey(id))
    const cached = localCache.get(id)
    if (cached !== undefined && cached.raw === raw) return cached.rows
    const rows = readStringRows(options.storage, id, raw)
    localCache.set(id, { raw, rows })
    return rows
  }

  const persist = (transaction: PersistedTransaction): Promise<void> => {
    const acceptedGeneration = generation
    const mutations = transaction.mutations.filter((mutation) => registered.has(mutation.collection.id))
    const operation = tail.then(async () => {
      // Already queued transitions may have been derived from the failed
      // optimistic state. Reject them too; a later fresh dispatch may retry.
      if (acceptedGeneration !== generation) throw priorFailure
      options.authorize?.(transaction)
      const deltas = new Map<string, Array<DurableRowDelta>>()
      const localRows = new Map<string, Map<string, StoredItem>>()
      // The projection advances in place; a refused commit rewinds these.
      const applied: Array<{ readonly rows: Map<string, StoredItem>; readonly key: string; readonly prior: StoredItem | undefined }> = []
      try {
        for (const mutation of mutations) {
          const id = mutation.collection.id
          const rows = options.rows === undefined
            ? localRows.get(id) ?? localProjection(id)
            : projection(id)
          localRows.set(id, rows)
          const key = rowKey(mutation.key)
          const prior = rows.get(key)
          if (mutation.type === "insert" ? prior !== undefined : prior === undefined || comparableJson(prior.data) !== comparableJson(mutation.original)) {
            // A rejection handler can dispatch while another failed optimistic
            // transaction is still rolling back. Its generation is current but
            // its original row is not; never persist that stale derived state.
            throw new StaleDurableMutationError(id, mutation.key)
          }
          /*
           * An identical update preserves the existing stored row and version.
           * Previously, repeated run polling rewrote unchanged card payloads;
           * this also suppresses redundant writes from other callers. Explicit
           * authority fences still enter the physical CAS read set.
           */
          if (mutation.retainUnchanged !== true && prior !== undefined && mutation.type === "update" && comparableJson(prior.data) === comparableJson(mutation.modified)) continue
          applied.push({ rows, key, prior })
          const delta: DurableRowDelta = mutation.type === "delete"
            ? { key, expectedVersionKey: prior?.versionKey, versionKey: undefined, data: undefined }
            : { key, expectedVersionKey: prior?.versionKey, versionKey: randomUuid(), data: JSON.parse(JSON.stringify(mutation.modified)) as unknown }
          if (delta.versionKey === undefined) rows.delete(key)
          else rows.set(key, { versionKey: delta.versionKey, data: delta.data })
          const changed = deltas.get(id) ?? []
          changed.push(delta)
          deltas.set(id, changed)
        }
        // Serialize every projection before opening the synchronous batch. A
        // normalized host takes the deltas instead, so neither side pays for
        // the rows this transaction did not touch.
        const writes = options.rows === undefined
          ? [...deltas.keys()].map((id) => [storageKey(id), JSON.stringify(Object.fromEntries(localRows.get(id)!))] as const)
          : []
        options.batch?.beginBatch()
        try {
          if (options.rows === undefined) for (const [key, value] of writes) options.storage.setItem(key, value)
          else for (const [id, rowDeltas] of deltas) options.rows.applyRows(id, rowDeltas)
          options.batch?.commitBatch()
          await options.flush?.()
          // Cache only accepted bytes. A failed/partially committed host is
          // detected by the next raw-string read, and applied maps roll back.
          if (options.rows === undefined) for (const [key, raw] of writes) {
            const id = key.slice("smithers-mvp.".length)
            localCache.set(id, { raw, rows: localRows.get(id)! })
          }
        } catch (error) {
          options.batch?.abortBatch()
          throw error
        }
      } catch (error) {
        for (let index = applied.length - 1; index >= 0; index -= 1) {
          const entry = applied[index]!
          if (entry.prior === undefined) entry.rows.delete(entry.key)
          else entry.rows.set(entry.key, entry.prior)
        }
        throw error
      }
    }).catch((error: unknown) => {
      if (acceptedGeneration === generation) {
        generation += 1
        priorFailure = error
      }
      throw error
    })
    tail = operation.catch(() => {})
    return operation
  }

  return {
    register: (id) => {
      registered.add(id)
      // Re-read: a caller may have replaced the stored collection since boot.
      const rows = readRows(options, id)
      if (options.rows !== undefined) projected.set(id, rows)
      return [...rows.values()].map((row) => row.data)
    },
    persist,
    settled: () => tail.then(() => undefined, () => undefined)
  }
}

/** The store opener validates rows; this adapter confirms only durable writes. */
export const durableCollectionOptions = <TSchema extends StandardSchemaV1>(
  persistence: CollectionPersistence,
  spec: {
    readonly id: string
    readonly schema: TSchema
    readonly getKey: (item: InferSchemaOutput<TSchema>) => string
  }
) => {
  const options = localOnlyCollectionOptions({
    ...spec,
    initialData: [...persistence.register(spec.id)] as Array<InferSchemaOutput<TSchema>>,
    onInsert: ({ transaction }) => persistence.persist(transaction),
    onUpdate: ({ transaction }) => persistence.persist(transaction),
    onDelete: ({ transaction }) => persistence.persist(transaction)
  })
  return {
    ...options,
    sync: {
      ...options.sync,
      sync: (params: Parameters<typeof options.sync.sync>[0]) => options.sync.sync({
        ...params,
        // These confirmations already passed the serialized durable commit.
        // Apply each confirmed base beneath any newer optimistic changes now:
        // parking it until all transactions settle lets intervening updates
        // invalidate TanStack's captured previous row and corrupt live queries.
        begin: () => params.begin({ immediate: true })
      })
    }
  }
}
