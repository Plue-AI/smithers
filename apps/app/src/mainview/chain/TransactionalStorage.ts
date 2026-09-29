import { Data } from "effect"
import { WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "../state/StorageRecoveryContract"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { StorageApi } from "@tanstack/db"
import { DurableStorageConflictError } from "./DurableCollection"
import { retainRecoveryCopy } from "./RecoveryCopy"
import { decodeStoredRow } from "./StoredRowDecoder"
import { eraseLocalRecoveryCopies, privacyStorage, permittedRows, type PermittedStorageRows } from "./PrivacyRetirement"

/*
 * The transactional storage host for the localStorage backend (see
 * apps/app/docs/persistence.md).
 *
 * localStorage has no transaction primitive, and persisted collections write
 * independent host keys, so a dispatch's mutationFn fan-out
 * could die half-applied. This facade gives the host one atomic commit point:
 * the whole persisted state lives in ONE versioned envelope
 * (`smithers-mvp.store`), and every commit runs a three-step write-ahead
 * protocol — stage, commit, clear — that a boot can always finish or always
 * undo. Collections keep reading and writing their own TanStack keys through
 * the `storage` facade; nothing above this module changes shape.
 */

/** The one host key holding the whole persisted state as a versioned envelope. */
export const ENVELOPE_STORAGE_KEY = "smithers-mvp.store"

/** The write-ahead key: the next envelope, staged before the commit point. */
export const STAGED_ENVELOPE_STORAGE_KEY = `${ENVELOPE_STORAGE_KEY}.staged`

/** The envelope shape version this build writes. */
export const ENVELOPE_VERSION = 1

/** Raw envelopes retained until an explicit durable privacy retirement. */
export const ENVELOPE_QUARANTINE_PREFIX = "smithers-mvp-quarantine.store."
export const ROW_QUARANTINE_PREFIX = "smithers-mvp-quarantine.row."

export interface StorageWriterLease {
  readonly lost: Promise<void>
  readonly assertOwned: () => void
  /** Release only after the AppStore has stopped accepting and flushed writes. */
  readonly release: () => Promise<void>
}

/** Injectable protocol; production passes the browser's origin-wide Web Locks manager. */
export interface StorageWriterLockManager {
  readonly request: (
    name: string,
    options: { readonly mode: "exclusive"; readonly signal?: AbortSignal; readonly steal?: boolean },
    callback: (lock: object | null) => Promise<void>
  ) => Promise<void>
}

/**
 * Hold one browser writer for the complete AppStore lifetime, including open,
 * migration and synchronous envelope commits. CAS without this lock is not
 * atomic across tabs. An isolated injected host can instead serialize itself.
 * The caller must release on boot failure and after store disposal, and must
 * never select a different persistent backend when acquisition is refused.
 */
export const acquireLocalStorageWriter = async (
  locks: StorageWriterLockManager | undefined = globalThis.navigator?.locks,
  options: { readonly timeoutMs?: number; readonly steal?: boolean } = {}
): Promise<StorageWriterLease> => {
  if (locks === undefined) {
    throw new Error("This browser cannot safely own local storage without Web Locks. Opening was refused.")
  }
  const acquired = Promise.withResolvers<StorageWriterLease>()
  const released = Promise.withResolvers<void>()
  const lost = Promise.withResolvers<void>()
  const abort = new AbortController()
  let owned = false
  let granted = false
  const timer = options.steal ? undefined : setTimeout(() => abort.abort(), options.timeoutMs ?? 1500)
  // Deferring also captures synchronous host failures and initializes request
  // before an injected manager can invoke the callback synchronously.
  const request = Promise.resolve().then(() => locks.request(`${ENVELOPE_STORAGE_KEY}.writer`, {
    // Web Locks forbids combining steal with signal; stealing does not queue.
    mode: "exclusive", ...(options.steal ? { steal: true } : { signal: abort.signal })
  }, async (lock) => {
    if (lock === null) throw new WriterHeldByAnotherTabError()
    clearTimeout(timer)
    owned = granted = true
    acquired.resolve({
      lost: lost.promise,
      assertOwned: () => { if (!owned) throw new WriterMovedToAnotherTabError() },
      release: async () => {
        owned = false
        released.resolve()
        await request.catch(() => {})
      }
    })
    await released.promise
  }))
  void request.catch(error => {
    clearTimeout(timer)
    owned = false
    if (granted) {
      // Fence synchronously before any store/UI listener runs. A stolen
      // request rejects even while its callback still awaits release.
      lost.resolve()
      released.resolve()
    } else {
      acquired.reject(abort.signal.aborted ? new WriterHeldByAnotherTabError() : error)
    }
  })
  return acquired.promise
}

export class UnsupportedStorageEnvelopeError extends Data.TaggedError("UnsupportedStorageEnvelopeError")<{
  readonly found: number
  readonly supported: number
  readonly message: string
}> {
  constructor(found: number, supported: number) {
    super({ found, supported, message: `Storage envelope ${found} is newer than this build's envelope ${supported}.` })
  }
}

export interface LegacyCollectionSpec {
  readonly id: string
  /** Pure, JSON-closed, idempotent decoder; one-shot transforms require an explicit migration. */
  readonly schema: StandardSchemaV1
  /** Execution evidence cannot be removed by generic row quarantine. */
  readonly invalidRows?: "quarantine" | "refuse"
  /** Never admit an incomplete authority or snapshot as a new baseline. */
  readonly partialLoad?: "refuse"
  readonly validateKey?: (key: string, data: unknown) => boolean
}

export class AuthoritativeStorageError extends Data.TaggedError("AuthoritativeStorageError")<{
  readonly collectionId: string
  readonly message: string
}> {
  constructor(collectionId: string) {
    super({ collectionId, message: `The authoritative ${collectionId} store contains unreadable evidence. Opening it without that evidence could repeat work. Its source was preserved; recover it before continuing.` })
  }
}

export const assertRowRecoveryPolicy = (collection: LegacyCollectionSpec, rejected: number): void => {
  if (rejected > 0 && collection.invalidRows === "refuse") throw new AuthoritativeStorageError(collection.id)
}

/** Refuse unreadable execution evidence before any repair writes. */
export const assertStoredRowsRecovery = (collections: ReadonlyArray<LegacyCollectionSpec>, rejected: ReadonlySet<string>): void => {
  for (const collection of collections) if (rejected.has(collection.id)) assertRowRecoveryPolicy(collection, 1)
}

/** App entities use string IDs; historical keys may omit TanStack's prefix. */
export const matchesStoredStringId = (key: string, data: unknown): boolean =>
  typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" &&
  (key === data.id || key === `s:${data.id}`)

interface Envelope {
  readonly version: number
  readonly entries: Record<string, string>
}

export type RecoveryOutcome = "clean" | "complete" | "rollback"

export interface TransactionalStorage {
  /** The StorageApi the persisted collections read and write. */
  readonly storage: StorageApi
  /**
   * Open a batch: writes accumulate into a pending delta. Batches nest;
   * only the outermost commit writes the envelope.
   */
  readonly beginBatch: () => void
  /** Close a batch, committing every write it buffered as ONE envelope write. */
  readonly commitBatch: () => void
  /** Abandon a batch: nothing it buffered reaches the host. */
  readonly abortBatch: () => void
  /**
   * Run `work` against a pending delta and commit every write it made as ONE
   * envelope write. A throw (or rejection) aborts the batch: no projection of
   * it reaches the host.
   */
  readonly batch: <T>(work: () => T) => T
  /** How the boot recovered the interrupted commit it found, if any. */
  readonly recovery: RecoveryOutcome
  /** The quarantine keys this open wrote for unreadable or unsupported shapes. */
  readonly quarantinedKeys: ReadonlyArray<string>
  /** After a verified privacy checkpoint, discard unknown entries and all old raw copies. */
  readonly retireRecoveryCopies: (bookkeeping: ReadonlySet<string>, permitted: PermittedStorageRows) => void
}

export const parseStorageEnvelope = (raw: string): Envelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "version" in parsed &&
      typeof parsed.version === "number" &&
      Number.isInteger(parsed.version) &&
      "entries" in parsed &&
      typeof parsed.entries === "object" &&
      parsed.entries !== null &&
      !Array.isArray(parsed.entries) &&
      Object.values(parsed.entries).every((value) => typeof value === "string")
    ) {
      return parsed as Envelope
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Decode the historical TanStack StorageApi map, preserving rejected bytes. */
export const validateStoredRows = async (
  raw: string,
  schema: StandardSchemaV1,
  validateKey?: (key: string, data: unknown) => boolean
) => {
  const rows = new Map<string, { readonly versionKey: string; readonly data: unknown }>()
  const rejected: Array<{ readonly rowKey: string; readonly raw: string }> = []
  let normalized = false
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { /* Quarantine the whole collection below. */ }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { rows, rejected: [{ rowKey: "", raw }], normalized }
  }
  for (const [rowKey, stored] of Object.entries(parsed)) {
    const original = JSON.stringify(stored)
    if (typeof stored === "object" && stored !== null && !Array.isArray(stored) &&
      "versionKey" in stored && typeof stored.versionKey === "string" && "data" in stored) {
      // Only a returned validation failure rejects a row. A validator or key
      // check that throws is broken code, not permission to remove user data.
      const result = await decodeStoredRow(schema, stored.data)
      if (result.valid && (validateKey === undefined || validateKey(rowKey, result.data))) {
        normalized ||= result.changed || Object.keys(stored).length !== 2
        rows.set(rowKey, { versionKey: stored.versionKey, data: result.data })
        continue
      }
    }
    rejected.push({ rowKey, raw: original })
  }
  return { rows, rejected, normalized }
}

/*
 * Finish or undo an interrupted commit.
 *
 * The commit point is the envelope write itself, so a staged key can only
 * mean two things: the crash came after the commit (staged bytes equal the
 * live envelope — complete it by clearing the stage) or before it (they
 * differ — roll back by dropping the stage; the old envelope is untouched).
 */
export const recoverInterruptedCommit = (host: StorageApi): RecoveryOutcome => {
  const staged = host.getItem(STAGED_ENVELOPE_STORAGE_KEY)
  if (staged === null) return "clean"
  const outcome: RecoveryOutcome = host.getItem(ENVELOPE_STORAGE_KEY) === staged ? "complete" : "rollback"
  host.removeItem(STAGED_ENVELOPE_STORAGE_KEY)
  return outcome
}

/**
 * Open the transactional store over `host`: recover any interrupted commit,
 * load or migrate the envelope, and hand out the facade the collections write
 * through.
 */
export const openTransactionalStorage = async (
  host: StorageApi,
  options: { readonly collections: ReadonlyArray<LegacyCollectionSpec> } = { collections: [] }
): Promise<TransactionalStorage> => {
  const observed = new Map<string, string | null>()
  const readSource = (key: string): string | null => {
    const value = host.getItem(key)
    if (observed.has(key) && observed.get(key) !== value) {
      throw new Error("Stored state changed while opening. No replacement was committed; retry opening the current state.")
    }
    observed.set(key, value)
    return value
  }
  // A newer build's live or staged envelope is opaque to this build. Refuse
  // before recovery can remove a stage or any replacement can hide the data.
  for (const key of [ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY]) {
    const candidate = readSource(key)
    if (candidate === null) continue
    let parsed: unknown
    try { parsed = JSON.parse(candidate) } catch { continue }
    // Future envelopes may change the entries shape, so inspect only their
    // version here instead of requiring today's complete envelope schema.
    if (typeof parsed === "object" && parsed !== null && "version" in parsed &&
      typeof parsed.version === "number" && parsed.version > ENVELOPE_VERSION) {
      throw new UnsupportedStorageEnvelopeError(parsed.version, ENVELOPE_VERSION)
    }
  }
  const quarantinedKeys: string[] = []
  const quarantineWrites: Array<{ readonly key: string; readonly raw: string }> = []
  const protectedCollection = options.collections.find((collection) => collection.invalidRows === "refuse")
  let entries: Record<string, string> = {}
  const raw = readSource(ENVELOPE_STORAGE_KEY)
  if (raw !== null) {
    const envelope = parseStorageEnvelope(raw)
    if (envelope === undefined) {
      if (protectedCollection !== undefined) throw new AuthoritativeStorageError(protectedCollection.id)
      const quarantineKey = `${ENVELOPE_QUARANTINE_PREFIX}corrupt`
      quarantineWrites.push({ key: quarantineKey, raw })
    } else if (envelope.version !== ENVELOPE_VERSION && envelope.version !== 0) {
      // Newer envelopes never reach here: the pre-check above refuses every
      // version over ENVELOPE_VERSION, so this is an unsupported older stamp.
      if (protectedCollection !== undefined) throw new AuthoritativeStorageError(protectedCollection.id)
      const quarantineKey = `${ENVELOPE_QUARANTINE_PREFIX}unsupported.${envelope.version}`
      quarantineWrites.push({ key: quarantineKey, raw })
    } else {
      entries = { ...envelope.entries }
    }
  }

  // Version zero was the per-collection layout. A present current, corrupt,
  // or unsupported envelope is authoritative: never resurrect older host keys.
  const adoptLegacy = raw === null || parseStorageEnvelope(raw)?.version === 0
  let normalized = false
  const rejectedCollections = new Set<string>()
  for (const collection of options.collections) {
    const key = `smithers-mvp.${collection.id}`
    const collectionRaw = entries[key] ?? (adoptLegacy ? readSource(key) : null)
    if (collectionRaw === null || collectionRaw === undefined) continue
    const validated = await validateStoredRows(collectionRaw, collection.schema, collection.validateKey)
    if (validated.rejected.length > 0) rejectedCollections.add(collection.id)
    normalized ||= validated.normalized
    entries[key] = JSON.stringify(Object.fromEntries(validated.rows))
    for (const rejected of validated.rejected) {
      const quarantineKey = rejected.rowKey === ""
        ? `${ENVELOPE_QUARANTINE_PREFIX}unparseable.${collection.id}`
        : `${ROW_QUARANTINE_PREFIX}${collection.id}.${rejected.rowKey}`
      quarantineWrites.push({ key: quarantineKey, raw: rejected.raw })
    }
  }
  assertStoredRowsRecovery(options.collections, rejectedCollections)
  // Legacy keys remain untouched as recovery copies. The committed envelope
  // records adoption, including empty collections, so deletion stays deleted.
  if (normalized && raw !== null) {
    quarantineWrites.push({ key: `${ENVELOPE_QUARANTINE_PREFIX}before-normalization`, raw })
  }

  // No byte changes until every authoritative collection passed validation.
  // This detects changes across async validators; it is not a cross-tab lock.
  // No await separates this check from the synchronous recovery/commit below.
  for (const key of observed.keys()) readSource(key)
  const recovery = recoverInterruptedCommit(host)
  for (const write of quarantineWrites) {
    quarantinedKeys.push(retainRecoveryCopy(host, write.key, write.raw))
  }

  let base = new Map<string, string>(Object.entries(entries))
  // Exact committed bytes include every collection row's version. Reading
  // through this adapter's mirror cannot detect another adapter's commit.
  let committedRaw = raw
  let pending: Map<string, string | null> | undefined
  let batchDepth = 0

  // Most collection strings do not change in a commit. Their JSON escaping is
  // pure work over immutable bytes; retain only the current encoding per key.
  // Object.keys preserves JSON's ordering for numeric-looking legacy keys too.
  const encodedEntries = new Map<string, { readonly raw: string; readonly encoded: string }>()
  const serialize = (next: ReadonlyMap<string, string>): string => {
    for (const key of encodedEntries.keys()) if (!next.has(key)) encodedEntries.delete(key)
    const entries = Object.keys(Object.fromEntries(next)).map(key => {
      const raw = next.get(key)!
      const cached = encodedEntries.get(key)
      if (cached?.raw === raw) return cached.encoded
      const encoded = `${JSON.stringify(key)}:${JSON.stringify(raw)}`
      encodedEntries.set(key, { raw, encoded })
      return encoded
    })
    return `{"version":${ENVELOPE_VERSION},"entries":{${entries.join(",")}}}`
  }

  /*
   * The one commit point. Stage the next envelope, commit it with a single
   * atomic write, then clear the stage. A crash before the middle write
   * leaves the old envelope authoritative; a crash after it leaves the new
   * one; the boot's recovery finishes either direction.
   *
   * The in-memory mirror adopts `next` only after the host write returns.
   * A commit that throws (a quota rejection, a revoked host) must leave the
   * mirror on the last committed envelope: otherwise the live session would
   * read a projection the host never took, and the NEXT successful commit
   * would persist it — the half-applied transition this facade exists to
   * prevent.
   */
  const commit = (next: Map<string, string>): void => {
    const serialized = serialize(next)
    if (host.getItem(ENVELOPE_STORAGE_KEY) !== committedRaw) {
      throw new DurableStorageConflictError(ENVELOPE_STORAGE_KEY)
    }
    host.setItem(STAGED_ENVELOPE_STORAGE_KEY, serialized)
    host.setItem(ENVELOPE_STORAGE_KEY, serialized)
    committedRaw = serialized
    base = next
    // The durable commit point already succeeded. A failed cleanup must not
    // report rollback to the collections; boot can clear the matching stage.
    try { host.removeItem(STAGED_ENVELOPE_STORAGE_KEY) } catch { /* Recover on next open. */ }
  }

  /** The mirror the pending delta would produce, without touching `base`. */
  const withPending = (): Map<string, string> => {
    const next = new Map(base)
    if (pending !== undefined) {
      for (const [key, value] of pending) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
    }
    return next
  }

  const storage: StorageApi = {
    getItem: (key) => {
      if (pending !== undefined && pending.has(key)) return pending.get(key) ?? null
      return base.get(key) ?? null
    },
    setItem: (key, value) => {
      if (pending !== undefined) {
        pending.set(key, value)
        return
      }
      const next = new Map(base)
      next.set(key, value)
      commit(next)
    },
    removeItem: (key) => {
      if (pending !== undefined) {
        pending.set(key, null)
        return
      }
      const next = new Map(base)
      next.delete(key)
      commit(next)
    }
  }

  const beginBatch = (): void => {
    if (batchDepth === 0) pending = new Map()
    batchDepth += 1
  }

  const commitBatch = (): void => {
    if (batchDepth === 0) return
    batchDepth -= 1
    if (batchDepth > 0) return
    const next = withPending()
    // `pending` is cleared before the write so a throwing commit leaves the
    // facade out of the batch entirely, on the last committed mirror.
    pending = undefined
    commit(next)
  }

  const abortBatch = (): void => {
    batchDepth = 0
    pending = undefined
  }

  const batch = <T>(work: () => T): T => {
    beginBatch()
    try {
      const out = work()
      if (out instanceof Promise) {
        return out.then(
          (value) => {
            commitBatch()
            return value
          },
          (error: unknown) => {
            abortBatch()
            throw error
          }
        ) as T
      }
      commitBatch()
      return out
    } catch (error) {
      abortBatch()
      throw error
    }
  }

  // Persist the freshly recovered/migrated/adopted state as one committed
  // write. Rewriting identical bytes in the common case costs one write per
  // boot and keeps every open's end state committed by construction.
  commit(base)

  const retireRecoveryCopies = (bookkeeping: ReadonlySet<string>, permitted: PermittedStorageRows): void => {
    if (batchDepth !== 0) throw new Error("Finish the active persistence batch before privacy cleanup.")
    const raw = privacyStorage(host)
    const next = new Map<string, string>()
    for (const collection of options.collections) {
      const key = `smithers-mvp.${collection.id}`
      const rows = new Map<string, { readonly versionKey: string }>(Object.entries(JSON.parse(base.get(key) ?? "{}")))
      const accepted = permitted.get(collection.id)
      if (accepted === undefined) throw new Error("Privacy cleanup requires every declared collection.")
      next.set(key, JSON.stringify(Object.fromEntries(permittedRows(rows, accepted))))
    }
    commit(next)
    eraseLocalRecoveryCopies(raw, new Set([...bookkeeping, ENVELOPE_STORAGE_KEY]))
  }
  return { storage, beginBatch, commitBatch, abortBatch, batch, recovery, quarantinedKeys, retireRecoveryCopies }
}
