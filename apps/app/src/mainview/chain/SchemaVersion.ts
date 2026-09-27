import type { StorageApi } from "@tanstack/db"
import { ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY } from "./TransactionalStorage"
import { retainRecoveryCopy } from "./RecoveryCopy"
import { parseSchemaStamp } from "./SchemaStamp"

/*
 * The boot gate for the persisted store: which backend holds it (E3.6) and
 * which shape version it was written under (E14.2).
 *
 * AppStore calls both halves before it constructs a single collection.
 *
 * The version half. TanStack's localStorage loader does not validate rows.
 * AppStore uses the validation gate, then opens TransactionalStorage
 * with the collection schemas before stamping the new version. Compatible
 * older rows survive; ordinary rejected rows are quarantined. Future versions
 * refuse open without mutation. A destructive reset requires the explicit
 * onMismatch: "reset" option. SQLite performs its own schema gate and
 * row validation in SqliteRowStorage.
 *
 * The backend half. AppStore can persist into either store, and it cannot
 * merge them. A launch that opens the store the previous launch did not write
 * reads an empty database and greets a returning user with a first-run app
 * while their whole transcript sits in the other one. `recordBackend` stamps
 * the store a launch committed to, and `readRecordedBackend` is what the next
 * launch honours.
 *
 * Both stamps live in localStorage, under the same prefix as the data, and
 * neither is ever cleared as data: they describe where the store is and what
 * shape it has, so losing them with a reset would strand the next launch.
 */

/**
 * The shape version of everything AppStore persists. Bump it whenever a
 * persisted schema changes in a way an older row cannot satisfy, or an
 * older writer would misinterpret new authority fields.
 */
// Version 14 writers do not understand private, unadmitted Wiki deltas.
export const APP_SCHEMA_VERSION = 15

/** The prefix AppStore gives every persisted collection's storage key. */
export const PERSISTED_KEY_PREFIX = "smithers-mvp."

/** Where the gate stamps the version it last wrote the store under. */
export const SCHEMA_VERSION_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}schemaVersion`

/** Where boot stamps the backend that holds the live store. */
export const PERSISTENCE_BACKEND_STORAGE_KEY = `${PERSISTED_KEY_PREFIX}persistenceBackend`

/** Raw pre-migration envelopes retained outside the live namespace on a reset. */
export const SCHEMA_QUARANTINE_PREFIX = "smithers-mvp-quarantine."

/** The two stores AppStore can persist into. */
export type PersistenceBackendKind = "opfs" | "localStorage"

export class UnknownPersistenceBackendError extends Error {
  constructor() {
    super("The recorded persistence backend is unknown to this build. No other store was selected; recover the backend record before continuing.")
  }
}

/*
 * The gate's own bookkeeping, as opposed to the data. A reset clears the data
 * and keeps these: the version stamp is rewritten by the reset itself, and the
 * backend stamp names where the store lives, which a reset does not change.
 */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  SCHEMA_VERSION_STORAGE_KEY,
  PERSISTENCE_BACKEND_STORAGE_KEY
])

/**
 * The backend the last launch committed to, or null when no launch has stamped
 * one (a first run, or a store written before the stamp existed).
 */
export const readRecordedBackend = (storage: StorageApi): PersistenceBackendKind | null => {
  const stamped = storage.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)
  if (stamped === null) return null
  if (stamped === "opfs" || stamped === "localStorage") return stamped
  throw new UnknownPersistenceBackendError()
}

/** Stamp the backend this launch committed to, for the next launch to honour. */
export const recordBackend = (storage: StorageApi, backend: PersistenceBackendKind): void => {
  storage.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, backend)
}

/**
 * Stable collection storage ids, plus the historical cleanup-only id below.
 * SchemaVersion.test.ts compares this list with the storage keys a real store
 * reads. Derived live views have their own ids and never own persisted rows.
 * Adding durable storage without declaring it here must fail the suite rather
 * than leave a stale key behind after an explicit reset.
 */
export const PERSISTED_COLLECTION_IDS: ReadonlyArray<string> = [
  "app-events",
  "app-event-heads",
  "app-event-checkpoints",
  "app-event-retirements",
  "app-sessions",
  "app-messages",
  "app-connectors",
  "app-connector-operations",
  "world-documents",
  "app-cards",
  "app-card-histories",
  "app-repository-notifications",
  "app-notification-receipts",
  "app-repository-contexts",
  "app-approval-requests",
  "app-transitions",
  "app-command-intents",
  "app-http-turns",
  "app-http-turn-legs",
  "app-runtime-runs",
  "app-runtime-approvals",
  "app-identity-sessions",
  "app-billing-accounts",
  "app-toasts",
  "app-tool-calls",
  "app-tabs",
  "app-harnesses",
  /* Agents as data (custom-agents.md): the mirror of `GET /api/agents`. */
  "app-agents",
  /* Models as data: a user's records, the rows the host's catalog reported, and the seat each answers for. */
  "app-models",
  "app-seats",
  "app-repos",
  "app-pinned-repos",
  "app-starred-targets",
  "app-workspaces",
  "app-branches",
  "app-frames",
  "app-recommendations",
  "app-cloud-repositories",
  "app-cloud-sessions",
  "app-working-copies",
  "app-cloud-workspaces",
  "app-changes",
  "app-linear-integrations",
  "app-github-app-statuses",
  /*
   * The sidebar's file tree rows live in a per-launch memory store (a
   * checkout changes on disk, so nothing survives a relaunch). Retain its
   * historical cleanup key so a stray persisted tree is cleared on reset.
   */
  "app-chain-events",
  "app-retired-chain-lineages",
  "app-repo-tree"
]

/** The storage keys the gate clears on a mismatch. */
export const persistedStorageKeys = (): ReadonlyArray<string> => [
  ...PERSISTED_COLLECTION_IDS.map((id) => `${PERSISTED_KEY_PREFIX}${id}`),
  // The transactional envelope and its write-ahead stage
  // (TransactionalStorage.ts): persisted state, cleared with the rest.
  ENVELOPE_STORAGE_KEY,
  STAGED_ENVELOPE_STORAGE_KEY
]

export interface SchemaVersionOutcome {
  /**
   * "match" left the store alone. "reset" cleared a different version.
   * "validate" requires validated storage open before the caller stamps `to`.
   */
  readonly action: "match" | "reset" | "validate"
  /** The stamp the gate read, or null when the store carried none. */
  readonly from: string | null
  /** The target version; `validate` leaves the existing stamp untouched. */
  readonly to: number
  /** The keys the gate removed, sorted. */
  readonly clearedKeys: ReadonlyArray<string>
  /** Backup keys holding the raw envelopes removed from the live namespace. */
  readonly quarantinedKeys: ReadonlyArray<string>
}

export interface SchemaVersionOptions {
  /** Defaults to APP_SCHEMA_VERSION. Tests pass a bump. */
  readonly version?: number
  /** Defaults to validation without writes. "reset" is an explicit destructive recovery operation. */
  readonly onMismatch?: "validate" | "reset"
}

export class UnsupportedLocalStorageSchemaError extends Error {
  constructor(readonly found: string, readonly supported: number) {
    super(`Local storage state schema ${found} cannot be opened by this build's schema ${supported}.`)
  }
}

/*
 * StorageApi is the three-method subset TanStack needs. A real Storage also
 * enumerates, which lets the gate reach keys the declared list has forgotten
 * (a collection deleted in an earlier release, say). Enumeration is a bonus,
 * never the contract: the declared list is always cleared too.
 */
interface EnumerableStorage {
  readonly length: number
  key: (index: number) => string | null
}

const enumerable = (storage: StorageApi): EnumerableStorage | undefined => {
  const candidate = storage as Partial<EnumerableStorage>
  return typeof candidate.length === "number" && typeof candidate.key === "function"
    ? (candidate as EnumerableStorage)
    : undefined
}

const keysToClear = (storage: StorageApi): ReadonlyArray<string> => {
  const keys = new Set<string>(persistedStorageKeys())
  const scannable = enumerable(storage)
  if (scannable !== undefined) {
    for (let index = 0; index < scannable.length; index += 1) {
      const key = scannable.key(index)
      if (key === null) continue
      if (!key.startsWith(PERSISTED_KEY_PREFIX)) continue
      if (BOOKKEEPING_KEYS.has(key)) continue
      keys.add(key)
    }
  }
  return [...keys].sort()
}

/**
 * Reconciles a localStorage-backed store with the current schema version.
 *
 * Call it before any collection is constructed.
 *
 * A matching stamp is untouched. By default, older/absent stamps
 * await the storage opener's validated commit and future/invalid stamps
 * refuse open. Only onMismatch: "reset" permits a destructive reset with
 * recovery copies. Merely checking a version never silently clears user data.
 */
export const enforceSchemaVersion = (
  storage: StorageApi,
  options: SchemaVersionOptions = {}
): SchemaVersionOutcome => {
  const version = options.version ?? APP_SCHEMA_VERSION
  parseSchemaStamp(version, "Local storage configuration")
  const from = storage.getItem(SCHEMA_VERSION_STORAGE_KEY)
  if (from === String(version)) {
    return { action: "match", from, to: version, clearedKeys: [], quarantinedKeys: [] }
  }
  if (options.onMismatch !== "reset") {
    if (from !== null && (!/^\d+$/.test(from) || !Number.isSafeInteger(Number(from)) || Number(from) > version)) {
      throw new UnsupportedLocalStorageSchemaError(from, version)
    }
    // Validation and its durable commit must succeed before the caller stamps
    // this version. This branch never moves, removes, or rewrites source data.
    return { action: "validate", from, to: version, clearedKeys: [], quarantinedKeys: [] }
  }
  const clearedKeys = keysToClear(storage)
  const quarantinedKeys: string[] = []
  for (const key of clearedKeys) {
    const raw = storage.getItem(key)
    if (raw === null) continue
    const quarantineKey = `${SCHEMA_QUARANTINE_PREFIX}${from ?? "unversioned"}.${key.slice(PERSISTED_KEY_PREFIX.length)}`
    quarantinedKeys.push(retainRecoveryCopy(storage, quarantineKey, raw))
  }
  for (const key of clearedKeys) storage.removeItem(key)
  storage.setItem(SCHEMA_VERSION_STORAGE_KEY, String(version))
  return { action: "reset", from, to: version, clearedKeys, quarantinedKeys }
}
