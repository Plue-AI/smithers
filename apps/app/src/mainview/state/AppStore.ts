import { releaseInterruptedApproval } from "./ApprovalRecovery"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence"
import type { InferSchemaOutput,StorageApi,StorageEventApi } from "@tanstack/db"
import { localOnlyCollectionOptions } from "@tanstack/db"
import type { Transaction } from "@tanstack/react-db"
import { createCollection,createTransaction } from "@tanstack/react-db"
import type { CollectionPersistence,DurableRowSink } from "../chain/DurableCollection"
import { createCollectionPersistence,durableCollectionOptions } from "../chain/DurableCollection"
import type { PersistedLoadReport } from "../chain/PersistenceBudget"
import { EMPTY_PERSISTED_LOAD,PERSISTED_JOURNAL_COMPACTION_BYTES,PERSISTED_LOAD_TOAST_KEY,PERSISTED_LOAD_TOAST_TITLE,persistedLoadNotice } from "../chain/PersistenceBudget"
import { PrivacyAuthorityMissing,PrivacyCleanupPending,PrivacyKeyNotRemoved,PrivacyMarkerMismatch,PrivacyStorageUnavailable,isPrivacyRetirementError,RESET_ERASURE_OUTBOX_KEY,addPendingTurnErasures,beginPrivacyRetirement,completePrivacyRetirement,deriveTurnErasures,enqueueTurnErasure,eraseLocalRecoveryCopies,preserveResetErasures,privacyStorage,readPrivacyRetirement,readResetErasures,retargetPrivacyRetirement,type PermittedStorageRows,type PrivacyRetirement } from "../chain/PrivacyRetirement"
import { createRemoteRetirementWorker } from "../chain/RemoteRetirement"
import {
APP_SCHEMA_VERSION,
PERSISTED_KEY_PREFIX,
PERSISTENCE_BACKEND_STORAGE_KEY,
SCHEMA_QUARANTINE_PREFIX,
SCHEMA_VERSION_STORAGE_KEY,
enforceSchemaVersion,
readRecordedBackend,
recordBackend
} from "../chain/SchemaVersion"
import { eraseSqliteRecoveryCopies } from "../chain/SqlitePrivacyRetirement"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { openSqliteRowStorage } from "../chain/SqliteRowStorage"
import type { EnumerableRecoveryStorage,RecoveryTable,StorageRecoverySnapshot } from "../chain/StorageRecovery"
import { StorageRecoveryError,readSqliteRecovery } from "../chain/StorageRecovery"
import type { TransactionalStorage } from "../chain/TransactionalStorage"
import { ENVELOPE_STORAGE_KEY,STAGED_ENVELOPE_STORAGE_KEY,acquireLocalStorageWriter,matchesStoredStringId,openTransactionalStorage,parseStorageEnvelope } from "../chain/TransactionalStorage"
import type { EraseRemoteTurn } from "../runtime/TurnErasure"
import {
AppEventCheckpointSchema,
StoredAppEventHeadSchema, StoredAppEventCheckpointSchema, StoredAppEventRecordSchema, needsAppProjectorUpgrade,
AppEventHeadSchema,
AppEventIntegrityError,
AppEventRecordSchema,
AppEventRetirementSchema,
appendAppEvent,
createAppCheckpoint,
initializeAppStream,replayAppEvents,
retiredAppStreamKey,
verifyAppProjection,
type AppEventCheckpoint,
type AppEventRecord,
type AppStateVerification,
type AppStreamState
} from "./AppEventStream"
import {
APP_PROJECTION_COLLECTION_NAMES,

TRACE_MESSAGE_PREFIX,appProjectionKey,
appTransitionErasesPrivateState,
seedAppProjection,
type AppProjectionSnapshot
} from "./AppProjection"
import type {
AppTransition,
Card,
CloudWorkspaceRow,
LocalRepositoryConnector,
Message,
Palette,
Session,
TabRow,
Toast,
WorldDocument
} from "./AppState"
import {
AgentRoleSchema,
BillingAccountSchema,
BranchSchema,
CardHistorySchema,
CardSchema,
ChangeRowSchema,
CloudRepositorySchema,
CloudSessionRowSchema,
CloudWorkspaceRowSchema,
ConnectorOperationSchema,
DEFAULT_PALETTE,
FlowDurationsRowSchema,
FrameSchema,
GitHubAppStatusRowSchema,
IdentitySessionSchema,
LocalRepositoryConnectorSchema,
MAIN_TAB_ID,
MessageSchema,
RecommendationSchema,
RepoTreeRowSchema,
RepositoryFlowsRowSchema,
SeatAssignmentSchema,
SessionSchema,
StarredTargetSchema,
StoredModelSchema,
TabSchema,
ToastSchema,
ToolCallRecordSchema,
TransitionRecordSchema,
WorkingCopySchema,
WorkspaceSchema,
WorldDocumentSchema,
conversationTabIdOf,
inConversation
} from "./AppState"
import { PALETTE_MIRROR_KEY,THEME_MIRROR_KEY,rememberAppearance } from "./Appearance"
import { consumeWriterTakeover, reportWriterMoved } from "./WriterOwnership"
import { reportStorageFailure, type StoreFailure } from "./StorageFailure"
import { isCurrentApprovalAnswer,type ApprovalAnswerInput } from "./ApprovalAnswerState"
import { captureBrowserStorageRecovery,recoveryStorage } from "./BrowserStorageRecovery"
import { CommandIntentSchema } from "./CommandIntent"
import { DRAFT_RECOVERY_STORAGE_KEY,clearDraftRecovery,readDraftRecovery,writeDraftRecovery } from "./DraftRecovery"
import { ENTITY_RECOVERY_STORAGE_KEY,clearEntityRecovery,readEntityRecoveries,writeEntityRecovery,type EntityRecoveryRecord } from "./EntityRecovery"
import { canonicalStoredJsonValue } from "./EventValue"
import { HttpTurnLegSchema,HttpTurnSchema, type HttpTurn } from "./HttpTurn"
import { freezeProjectionValue } from "./ImmutableProjection"
import { admitsPendingRecovery,pendingRecoveryScope,sameRecoveryScope,type PendingRecoveryAuthority,type PendingRecoveryBoundary } from "./PendingRecovery"
import { RepositoryContextSchema } from "./RepositoryContext"
import { NotificationReadReceiptSchema,RepositoryNotificationSchema } from "./RepositoryNotifications"
import { RuntimeApprovalSchema,RuntimeRunSchema,type RuntimeApproval,type RuntimeRun } from "./RuntimeProjection"
import { HeldBrowserStorageError, StorageWriteFailedError } from "./StorageRecoveryContract"
import { WIKI_RECOVERY_STORAGE_KEY,clearWikiRecovery,readWikiRecovery,writeWikiRecovery } from "./WikiRecovery"
import { createWorkspaceViews } from "./WorkspaceViews"
import { createSavedSignInPrompts } from "./SavedSignInPrompts"

export { MAX_TRANSITION_PAYLOAD_BYTES,journalPayload } from "./TransitionDiagnostics"


const SESSION_ID = "main"
/** The recents ledger keeps this many items (§5): enough for seven days of opens, never a wall. */

/*
 * Retention bounds for derived diagnostic logs (apps/app/docs/persistence.md §
 * "Retention and compaction"). Compaction runs inside the same dispatch
 * transaction that appends, so it is part of the atomic commit, and it keeps
 * the newest records: the debuggable tail is the valuable end of a log.
 */
export {
MAX_TOOL_CALL_RECORDS,MAX_TRANSITION_RECORDS,THEME_PICKER_CARD_ID,
TRACE_MESSAGE_PREFIX,VERBOSE_OFF_TEXT,VERBOSE_ON_TEXT,verboseTrace
} from "./AppProjection"

/*
 * localStorage-fallback composer keystrokes share one durable envelope commit
 * (docs/persistence.md "Composer drafts"). It lands after this pause in
 * typing, and never later than the second bound after the first unsaved edit.
 */
const DRAFT_COMMIT_IDLE_MS = 250
const DRAFT_COMMIT_MAX_MS = 1_000

const preferredTheme = (): Session["theme"] =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"

const applyTheme = (theme: Session["theme"]): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme
  // §20.4: the next boot paints this before the store is even open.
  rememberAppearance(THEME_MIRROR_KEY, theme)
}

/*
 * The color theme, stamped on the same element as data-theme and read by the
 * palette blocks in styles/tokens.css. The default is stamped explicitly too,
 * so the attribute always states which palette is live (tokens.css falls back
 * to night-owl either way).
 */
const applyPalette = (palette: Palette): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.palette = palette
  rememberAppearance(PALETTE_MIRROR_KEY, palette)
}

type ApprovalRequest = Extract<Card, { kind: "approval" | "approvals-inbox" }>
const isApprovalRequest = (card: Card | undefined): card is ApprovalRequest =>
  card?.kind === "approval" || card?.kind === "approvals-inbox"

const frozenRows = new WeakSet<object>()
const freezeRequest = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !frozenRows.has(value)) {
    for (const child of Object.values(value)) freezeRequest(child)
    Object.freeze(value)
    frozenRows.add(value)
  }
  return value
}

/**
 * Which store the running app is reading. "memory" is the degraded launch: the
 * store that holds the user's data could not be opened, so nothing is read and
 * nothing is written over it.
 */
export type PersistenceMode = "opfs" | "localStorage" | "memory"

export type PersistenceBackend =
  | {
    readonly kind: "opfs"
    readonly storage: StorageApi
    readonly storageEventApi: StorageEventApi
    readonly beginBatch: () => void
    readonly commitBatch: () => void
    readonly abortBatch: () => void
    readonly flush: () => Promise<void>
    readonly close: () => Promise<void>
    /** Read on the owning connection, serialized with writes. Older injected hosts may refuse recovery. */
    readonly readRecovery?: () => Promise<ReadonlyArray<RecoveryTable>>
    /** Normalized row writes. Older injected hosts only accept whole collections. */
    readonly applyRows?: DurableRowSink["applyRows"]
    /** Normalized row reads, so no collection is materialized as one string. */
    readonly readRows?: DurableRowSink["readRows"]
    /** What the bounded load admitted (chain/PersistenceBudget.ts). */
    readonly load?: PersistedLoadReport
    readonly retireRecoveryCopies?: (permitted: PermittedStorageRows) => Promise<void>
  }
  | {
    readonly kind: "localStorage"
    readonly storage?: StorageApi
  }

/** The store a launch reads, as `resolvePersistence` chose it. */
export interface ResolvedPersistence {
  readonly backend: PersistenceBackend
  readonly mode: PersistenceMode
  /** True when the store holding the user's data could not be opened. */
  readonly degraded: boolean
  /** Record adoption only after the selected legacy store validates and initializes. */
  readonly recordSuccessfulOpen?: () => void
  /** Production always supplies this; isolated legacy injected hosts own their own storage contract. */
  readonly privacy?: {
    readonly record: StorageApi | undefined
    readonly eraseInactiveDatabase: () => Promise<void>
  }
}

const OPFS_DATABASE_NAME = "smithers-mvp.sqlite"


/** Attempts spent waiting out a locked access-handle pool. See `openOpfsDatabase`. */
const OPFS_OPEN_ATTEMPTS = 5
/** The whole OPFS open, retries included. A store that never answers must not hang boot. */
const OPFS_OPEN_BUDGET_MS = 4_000

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A localStorage-shaped store that lives only as long as this document. */
const memoryStorage = (): StorageApi & EnumerableRecoveryStorage => {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/* OPFS has no window `storage` events; localStorage events name another host. */
const inertStorageEvents: StorageEventApi = {
  addEventListener: () => {},
  removeEventListener: () => {}
}

/*
 * Where the boot stamps live. Always window.localStorage, whichever backend
 * holds the data: it is the one store that is synchronous and readable before
 * anything else is open. A browser with storage disabled throws on the property
 * itself, so the read is guarded.
 */
const bootRecordStorage = (): StorageApi | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Read-only existence check for the installed OPFSCoopSyncVFS's database path. */
const browserDatabaseExists = async (): Promise<boolean> => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return false
  const root = await navigator.storage.getDirectory()
  try {
    await root.getFileHandle(OPFS_DATABASE_NAME)
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false
    throw error
  }
}

const hasLegacyLocalState = (storage: StorageApi): boolean => {
  const keys = [ENVELOPE_STORAGE_KEY, STAGED_ENVELOPE_STORAGE_KEY, ...PERSISTED_COLLECTION_SPECS.map((spec) => `${PERSISTED_KEY_PREFIX}${spec.id}`)]
  if (keys.some((key) => storage.getItem(key) !== null)) return true
  // Include historical collection names the current schema no longer lists.
  const scannable = storage as StorageApi & { readonly length?: number; readonly key?: (index: number) => string | null }
  if (typeof scannable.length === "number" && typeof scannable.key === "function") {
    const length = scannable.length
    for (let index = 0; index < length; index++) {
      const key = scannable.key(index)
      if (key !== null && key.startsWith(PERSISTED_KEY_PREFIX) && key !== SCHEMA_VERSION_STORAGE_KEY &&
        key !== PERSISTENCE_BACKEND_STORAGE_KEY && key !== THEME_MIRROR_KEY && key !== PALETTE_MIRROR_KEY &&
        key !== DRAFT_RECOVERY_STORAGE_KEY &&
        storage.getItem(key) !== null) return true
    }
  }
  return false
}

export class AmbiguousPersistenceBackendError extends Error {
  constructor() {
    super("Saved local browser data has no recorded backend and another database may exist. Opening either could select a stale history. Recover or explicitly select the existing backend before continuing; neither store was reset.")
  }
}

/*
 * Stamping the backend is bookkeeping, not the boot. A storage that refuses the
 * write (a full or blocked localStorage) costs the next launch its shortcut; it
 * must never cost this one its start.
 */
const stampBackend = (storage: StorageApi, backend: "opfs" | "localStorage"): void => {
  try {
    recordBackend(storage, backend)
  } catch (error) {
    console.warn("Smithers: could not record which store holds this app's data.", error)
  }
}

/*
 * Open the OPFS database, retrying while the access-handle pool is still held.
 *
 * A reload overlaps two documents: the outgoing one still owns wa-sqlite's
 * access handles when the incoming one asks for them, so the first open throws
 * for a database that is present and healthy. Retrying turns that race into a
 * short wait. Callers pass one attempt when nothing is known to live in OPFS,
 * so a browser without OPFS at all still boots without paying the backoff.
 */
const openOpfsDatabase = async (attempts: number) => {
  let failure: unknown = new Error("OPFS was never attempted")
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(100 * 2 ** (attempt - 1))
    try {
      return await openBrowserWASQLiteOPFSDatabase({ databaseName: OPFS_DATABASE_NAME })
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

/*
 * The same open under a wall-clock budget. A worker that neither answers nor
 * fails would otherwise leave the app on a splash screen forever. A database
 * that arrives after the budget is closed rather than abandoned, so it does not
 * sit on the access handles the next launch needs.
 */
const openOpfsDatabaseWithinBudget = async (attempts: number) => {
  const open = openOpfsDatabase(attempts)
  let timer: ReturnType<typeof setTimeout> | undefined
  let won = false
  try {
    const database = await Promise.race([
      open,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OPFS did not open within ${OPFS_OPEN_BUDGET_MS}ms`)),
          OPFS_OPEN_BUDGET_MS
        )
      })
    ])
    won = true
    return database
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (!won) void open.then((database) => database.close?.()).catch(() => {})
  }
}

/** Raw recovery never invokes AppStore initialization, migrations or backend selection. */
const existingBrowserDatabaseRecovery = async (): Promise<ReadonlyArray<RecoveryTable> | undefined> => {
  if (!await browserDatabaseExists()) return undefined
  const database = await openOpfsDatabaseWithinBudget(OPFS_OPEN_ATTEMPTS)
  try {
    return await readSqliteRecovery(database)
  } finally {
    await database.close?.()
  }
}

const browserSqliteRecoveryReader = () => typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
  ? existingBrowserDatabaseRecovery
  : undefined

/** Lazily imported by the startup panel only when the human requests a download. */
export const readUnopenedBrowserRecovery = (): Promise<StorageRecoverySnapshot> => captureBrowserStorageRecovery({
  session: "unopened",
  requirePrivacyBarrier: true,
  localStorage: recoveryStorage(bootRecordStorage()),
  sqlite: browserSqliteRecoveryReader()
})

/** The OPFS store this document opened, if it still holds its access handles. */
let openBrowserStore: (() => Promise<void>) | undefined
/** The complete owner, including dispatcher and cross-tab lease. */
let openBrowserAppStore: (() => Promise<void>) | undefined

/**
 * Every OPFS entry this app owns: the database, its `-wal`/`-journal`
 * sidecars, and the `.ahp-*` access-handle pools wa-sqlite creates beside it.
 * The origin's OPFS root holds nothing else of ours, and nothing of anyone
 * else's is matched.
 */
const ownedOpfsEntry = (name: string): boolean =>
  name === OPFS_DATABASE_NAME || name.startsWith(`${OPFS_DATABASE_NAME}-`) || name.startsWith(".ahp-")

/** `FileSystemDirectoryHandle.keys()` is in the spec, not yet in this TS lib. */
type OpfsDirectory = FileSystemDirectoryHandle & { readonly keys: () => AsyncIterableIterator<string> }

const removeOpfsEntry = async (root: FileSystemDirectoryHandle, name: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await root.removeEntry(name, { recursive: true })
      return
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return
      // A handle pool released a moment ago can still be held for a tick.
      if (attempt >= 3 || !(error instanceof DOMException) || error.name !== "NoModificationAllowedError") {
        if (error instanceof DOMException && error.name === "NoModificationAllowedError") throw new HeldBrowserStorageError()
        throw error
      }
      await wait(100 * 2 ** attempt)
    }
  }
}

/** Remove every owned OPFS entry: the database, its sidecars and handle pools. */
const removeBrowserDatabase = async (): Promise<void> => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return
  const root = await navigator.storage.getDirectory() as OpfsDirectory
  const owned: Array<string> = []
  for await (const name of root.keys()) if (ownedOpfsEntry(name)) owned.push(name)
  for (const name of owned) await removeOpfsEntry(root, name)
}

/**
 * Erase this browser's saved Smithers data and reload.
 *
 * The store's own handles are released first: this document may be the page
 * that holds them. Only this app's OPFS entries and only the app's own
 * localStorage prefixes are removed; nothing else on the origin is touched.
 * The reload is the caller's, so a test can observe the erase without one.
 */
export const resetLocalBrowserStorage = async (reload: () => void = () => window.location.reload()): Promise<void> => {
  const release = openBrowserAppStore ?? openBrowserStore
  openBrowserAppStore = undefined
  openBrowserStore = undefined
  if (release !== undefined) {
    // A store that cannot flush is still a store whose handles must go: the
    // erase is what the human asked for, and the bytes are about to be gone.
    await release().catch(() => {
      console.warn("Smithers: the saved store could not be closed cleanly before the reset.")
    })
  }
  // Reset is a writer too. A second tab must not repopulate a store while it
  // is erased, and a failed acquisition must leave all original bytes intact.
  const writer = await acquireLocalStorageWriter().catch(() => { throw new HeldBrowserStorageError() })
  try {
  const record = bootRecordStorage() as (StorageApi & Partial<EnumerableRecoveryStorage>) | undefined
  if (record !== undefined) preserveResetErasures(record)
  if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") {
    const root = await navigator.storage.getDirectory() as OpfsDirectory
    const owned: Array<string> = []
    for await (const name of root.keys()) if (ownedOpfsEntry(name)) owned.push(name)
    for (const name of owned) { writer.assertOwned(); await removeOpfsEntry(root, name) }
  }
  if (record !== undefined && typeof record.length === "number" && typeof record.key === "function") {
    const keys: Array<string> = []
    for (let index = 0; index < record.length; index += 1) {
      const key = record.key(index)
      if (key !== null && key !== RESET_ERASURE_OUTBOX_KEY && (key.startsWith(PERSISTED_KEY_PREFIX) || key.startsWith(SCHEMA_QUARANTINE_PREFIX))) keys.push(key)
    }
    for (const key of keys) { writer.assertOwned(); record.removeItem(key) }
  }
  writer.assertOwned()
  reload()
  } finally { await writer.release() }
}

/*
 * Choose the store this launch reads, and honour the choice the last launch
 * made (E3.6).
 *
 * The two backends cannot be merged, so "try OPFS, fall back on any error" is
 * not a fallback at all: the launch after a fallback opens the other store,
 * finds it empty, and the user's whole transcript is gone with no message. The
 * recorded backend is therefore authoritative.
 *
 * A recorded OPFS store that will not open is the one case with no good answer.
 * Reading localStorage instead would present a stale store as the current
 * conversation, and writing into it would fork the history; refusing to boot
 * would strand the user completely. This launch runs on a memory store instead:
 * the app starts, the real store is untouched and returns on the next launch,
 * and `persistenceDegraded` plus a console error say so rather than passing the
 * empty surface off as a fresh start.
 *
 * Only failure to acquire the database may take that path. Once it is open,
 * any read, validation, migration or commit failure must refuse this launch.
 * An unreadable execution journal is not permission to start work from zero.
 */
/** Browser-owned capabilities; injected hosts exercise the actual boot resolver without module mocks. */
export interface BrowserPersistenceHost {
  readonly bootRecord: () => StorageApi | undefined
  readonly openDatabase: (attempts: number) => Promise<SqliteRowDatabase>
  /** Inspect existence without opening/creating SQLite; needed only for unstamped legacy data. */
  readonly databaseExists?: () => Promise<boolean>
  /**
   * Remove the whole inactive database without opening it. A privacy cleanup
   * resumed at boot uses it when that database will not open, so one broken
   * file cannot fail every later launch.
   */
  readonly removeDatabase?: () => Promise<void>
}

export const resolvePersistence = async (host: BrowserPersistenceHost = {
  bootRecord: bootRecordStorage,
  openDatabase: openOpfsDatabaseWithinBudget,
  databaseExists: browserDatabaseExists,
  removeDatabase: removeBrowserDatabase
}, assertOwned: () => void = () => {}): Promise<ResolvedPersistence> => {
  const record = fenceStorage(host.bootRecord(), assertOwned)
  const retirement = record === undefined ? undefined : readPrivacyRetirement(record)
  const privacy: NonNullable<ResolvedPersistence["privacy"]> = {
    record,
    eraseInactiveDatabase: async () => {
      if (host.databaseExists === undefined) throw new PrivacyStorageUnavailable()
      if (!await host.databaseExists()) return
      try {
        const inactive = fenceDatabase(await host.openDatabase(OPFS_OPEN_ATTEMPTS), assertOwned)
        try { await eraseSqliteRecoveryCopies(inactive) } finally { await inactive.close?.() }
        return
      } catch (error) {
        // The inactive store is not the live authority: removing it whole is a
        // stricter erasure than dropping its tables. Without that door, or when
        // removal fails too, the cleanup stays pending with a typed cause.
        if (host.removeDatabase === undefined) throw error
        console.warn("Smithers: the inactive SQLite store would not open for cleanup; removing it instead.")
      }
      assertOwned()
      try { await host.removeDatabase() } catch { throw new PrivacyStorageUnavailable() }
      if (await host.databaseExists()) throw new PrivacyKeyNotRemoved()
    }
  }
  const recorded = record === undefined ? null : readRecordedBackend(record)
  if (retirement !== undefined && retirement.backend !== recorded) throw new PrivacyMarkerMismatch()
  if (recorded === "localStorage") {
    return {
      backend: { kind: "localStorage", storage: record },
      mode: "localStorage",
      degraded: false,
      privacy
    }
  }
  if (recorded === null && record !== undefined && hasLegacyLocalState(record)) {
    if (host.databaseExists === undefined || await host.databaseExists()) throw new AmbiguousPersistenceBackendError()
    return {
      backend: { kind: "localStorage", storage: record },
      mode: "localStorage",
      degraded: false,
      recordSuccessfulOpen: () => stampBackend(record, "localStorage"),
      privacy
    }
  }
  /*
   * An unstamped boot may still have data in OPFS: clearing site data removes
   * the stamp but not the database. A present database is owned data, so it
   * gets the full retry and a failed open never stamps localStorage over it.
   * A probe that fails is no proof of absence, so it counts as present.
   */
  const opfsHoldsData = recorded === "opfs" ||
    (recorded === null && await host.databaseExists?.().catch((error: unknown) => {
      console.warn("Smithers: could not check for an existing OPFS SQLite store; treating it as present.", error)
      return true
    }) === true)
  let database: SqliteRowDatabase
  try {
    database = fenceDatabase(await host.openDatabase(opfsHoldsData ? OPFS_OPEN_ATTEMPTS : 1), assertOwned)
  } catch (error) {
    if (opfsHoldsData) {
      if (retirement?.phase === "pending") throw new PrivacyStorageUnavailable()
      console.error(
        "Smithers: this app's data lives in OPFS SQLite and that store could not be opened, so this session starts empty and saves nothing. The conversation is still on disk and comes back once the store opens again.",
        error
      )
      return { backend: { kind: "localStorage", storage: memoryStorage() }, mode: "memory", degraded: true, privacy }
    }
    if (record === undefined) {
      console.error(
        "Smithers: neither OPFS SQLite nor localStorage is available in this browser context, so this session saves nothing.",
        error
      )
      return { backend: { kind: "localStorage", storage: memoryStorage() }, mode: "memory", degraded: true, privacy }
    }
    console.warn(
      "Smithers: OPFS SQLite persistence is unavailable in this browser context; falling back to localStorage persistence.",
      error
    )
    stampBackend(record, "localStorage")
    return { backend: { kind: "localStorage", storage: record }, mode: "localStorage", degraded: false, privacy }
  }
  const sqlite = await (async () => {
    if (retirement !== undefined) {
      const tables = await database.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'smithers_collection_rows'")
      if (tables.length !== 1) throw new PrivacyAuthorityMissing()
      const authority = await database.execute<{ readonly collection_id: string }>("SELECT DISTINCT collection_id FROM smithers_collection_rows WHERE collection_id IN ('app-event-heads', 'app-event-checkpoints')")
      if (authority.length !== 2) throw new PrivacyAuthorityMissing()
    }
    return openSqliteRowStorage(database, {
    collections: PERSISTED_COLLECTION_SPECS,
    schemaVersion: APP_SCHEMA_VERSION
    })
  })().catch(async (error) => {
    try {
      await database.close?.()
    } catch {
      // Do not mask the original refusal, or log private database error data.
      console.warn("Smithers: the refused SQLite store could not be closed; reload before retrying recovery.")
    }
    throw error
  })
  if (record !== undefined) stampBackend(record, "opfs")
  /*
   * wa-sqlite's OPFSCoopSyncVFS holds sync access handles for the life of the
   * connection, and a page that still owns them cannot remove the files —
   * `removeEntry` throws NoModificationAllowedError. Remember this document's
   * one store so `resetLocalBrowserStorage` can release it before erasing.
   */
  const release = async (): Promise<void> => {
    try {
      await sqlite.close()
    } finally {
      if (openBrowserStore === release) openBrowserStore = undefined
    }
  }
  openBrowserStore = release
  return {
    backend: {
      kind: "opfs",
      storage: sqlite.storage,
      storageEventApi: inertStorageEvents,
      beginBatch: sqlite.beginBatch,
      commitBatch: sqlite.commitBatch,
      abortBatch: sqlite.abortBatch,
      flush: sqlite.flush,
      close: release,
      readRecovery: sqlite.readRecovery,
      applyRows: sqlite.applyRows,
      readRows: sqlite.readRows,
      load: sqlite.loadReport,
      retireRecoveryCopies: sqlite.retireRecoveryCopies
    },
    mode: "opfs",
    degraded: false,
    privacy
  }
}

/*
 * The storage object a localStorage-backed store actually reads, so the schema
 * gate runs over the same bytes as the durable collection coordinator. An
 * omitted host resolves to the boot record store, then to an isolated memory
 * store when browser storage is unavailable.
 */
const storageOf = (backend: PersistenceBackend): StorageApi | undefined =>
  backend.kind === "opfs" ? backend.storage : (backend.storage ?? bootRecordStorage())

export type StoredCollections = {
  readonly [K in keyof typeof COLLECTION_DEFINITIONS]: ReturnType<typeof COLLECTION_DEFINITIONS[K]["create"]>
}

type PrivateCollectionName = "approvalRequests" | "appEvents" | "appEventHeads" | "appEventCheckpoints" | "appEventRetirements"
type ReadableCollections = Omit<StoredCollections, "cards" | "workingCopies" | PrivateCollectionName> & ReturnType<typeof createWorkspaceViews> & { savedSignInPrompts: ReturnType<typeof createSavedSignInPrompts>["collection"] }
/** Keep TanStack's collection identity for queries, while forbidding writes at the public boundary. */
type ReadOnlyCollection<C extends { readonly utils: object }> = C & {
  readonly insert: never
  readonly update: never
  readonly delete: never
  readonly utils: C["utils"] & { readonly acceptMutations: never }
}
export type AppCollections = { readonly [K in keyof ReadableCollections]: ReadOnlyCollection<ReadableCollections[K]> }

const readOnlyCollection = <C extends { readonly utils: object }>(collection: C, guard: () => void): ReadOnlyCollection<C> => {
  const refuse = (): never => { throw new Error("Application collections are read-only. Use the event dispatcher.") }
  // TanStack supports frozen input rows in its copy-on-write update tracker.
  // Guard reads on the owning instance so values/entries/state and query
  // subscriptions also receive immutable rows, including nested payloads.
  const getRow = Reflect.get(collection, "get") as (key: unknown) => unknown
  Object.defineProperty(collection, "get", { configurable: true,
    value: (key: unknown) => freezeRequest(Reflect.apply(getRow, collection, [key])) })
  const subscribe = Reflect.get(collection, "subscribeChanges") as (...args: unknown[]) => unknown
  Object.defineProperty(collection, "subscribeChanges", { configurable: true,
    value: (callback: (changes: ReadonlyArray<{ readonly value: unknown; readonly previousValue?: unknown }>) => unknown, ...args: unknown[]) =>
      Reflect.apply(subscribe, collection, [(changes: ReadonlyArray<{ readonly value: unknown; readonly previousValue?: unknown }>) => {
        // A rejected privacy owner must not deliver rolled-back old account
        // rows to previously registered UI/effect subscribers.
        try { guard() } catch { return }
        for (const change of changes) { freezeRequest(change.value); freezeRequest(change.previousValue) }
        return callback(changes)
      }, ...args]) })
  const methods = new WeakMap<object, unknown>()
  const read = (target: object, property: PropertyKey): unknown => {
    const guarded = property === "get" || property === "has" || property === "forEach" || property === "values" || property === "keys" || property === "entries" ||
      property === "state" || property === "size" || property === "toArray" || property === Symbol.iterator
    if (guarded) guard()
    const value: unknown = Reflect.get(target, property, target)
    if (typeof value !== "function") return value
    let bound = methods.get(value)
    if (bound === undefined) {
      bound = (...args: unknown[]) => { if (guarded) guard(); return Reflect.apply(value, target, args) }
      methods.set(value, bound)
    }
    return bound
  }
  const utils = new Proxy(collection.utils, {
    get: (target, property) => property === "acceptMutations" ? refuse : read(target, property),
    set: refuse, defineProperty: refuse, deleteProperty: refuse
  })
  return new Proxy(collection, {
    get: (target, property) => property === "utils" ? utils :
      property === "insert" || property === "update" || property === "delete" ? refuse : read(target, property),
    set: refuse, defineProperty: refuse, deleteProperty: refuse
  }) as ReadOnlyCollection<C>
}

export interface WorldStateSnapshot {
  readonly capturedAt: number
  readonly revision: number
  readonly documents: ReadonlyArray<WorldDocument>
  readonly markdown: string
}

export interface AgentContextSnapshot {
  readonly capturedAt: number
  readonly revision: number
  readonly messages: ReadonlyArray<Message>
  readonly connectors: ReadonlyArray<LocalRepositoryConnector>
  /** Every open tab in strip order: Smithers is the first and knows the rest. */
  readonly tabs: ReadonlyArray<TabRow>
  readonly worldState: WorldStateSnapshot
}

export interface AppStore {
  readonly collections: AppCollections
  /**
   * Apply one transition. Its change is visible in `collections` when this
   * returns, before it is saved, except runtime approval decision updates, which become
   * visible only after their durable receipt. The returned transaction is the durability
   * receipt: await `isPersisted.promise` before treating the change as saved,
   * for example before a reload or an outbound side effect.
   *
   * ```ts
   * await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
   * ```
   *
   * A transition the reducer refuses changes nothing and its receipt resolves
   * at once; an impossible request (a conversation id already in use) throws
   * here. A failed commit rejects the receipt and rolls the change back, with
   * any queued transition derived from it. After `app.reset`, every dispatch
   * returns the reset's receipt and changes nothing. OPFS-backed
   * `composer.changed` edits start separate SQLite commits immediately;
   * localStorage-backed keystrokes share one receipt, which resolves after a
   * pause in typing, the next other dispatch, page hide or `dispose`.
   */
  readonly dispatch: (transition: AppTransition) => Transaction
  /** Runtime ownership of the current input; later edits or a reopened composer revoke it. */
  readonly captureComposerDraft: (text: string) => () => boolean
  /** Private preparation of validated human form input; never changes accepted projections. */
  readonly stagePendingApprovalAnswer: (input: ApprovalAnswerInput, intentId: string) => { clear(): void } | undefined
  readonly stagePendingSignupInput: (field: string, value: string, intentId: string) => { clear(): void } | undefined
  readonly stagePendingCardInput: (cardId: string, card: Extract<Card, { kind: "flow-form" }>, intentId: string, field: string) => { clear(): void } | undefined
  /** Immutable runtime request; legacy model-authored cards have no authority. */
  readonly approvalRequest: (id: string) => ApprovalRequest | undefined
  /** Committed immutable evidence, excluding optimistic rows; used for observation cursors and deduplication. */
  readonly committedCard: (id: string) => Card | undefined
  readonly committedWorkspace: (id: string) => CloudWorkspaceRow | undefined
  readonly committedToast: (id: string) => Toast | undefined
  readonly committedWorldDocument: (id: string) => WorldDocument | undefined
  readonly committedRuntimeRun: (id: string) => RuntimeRun | undefined
  readonly committedRuntimeApproval: (id: string) => RuntimeApproval | undefined
  readonly committedHttpTurn: (turnId: string, owner: string | null) => HttpTurn | undefined
  readonly persistenceMode: PersistenceMode
  /**
   * What the bounded load admitted this launch. Application collections require
   * complete admission; disposable host collections may report skipped rows.
   */
  readonly persistedLoad: PersistedLoadReport
  /**
   * True when the store holding this user's data could not be opened, so the
   * session runs on memory and saves nothing. A surface that shows a
   * conversation must say this rather than render the empty one as current.
   */
  readonly persistenceDegraded: boolean
  readonly session: () => Session
  /** The transcript ordinal after every message and card: where the next row lands. */
  readonly nextOrdinal: () => number
  readonly worldStateSnapshot: () => WorldStateSnapshot
  readonly agentContextSnapshot: () => AgentContextSnapshot
  /** Verify committed materializations against a fresh replay. Never executes application effects. */
  readonly verifyState: () => Promise<AppStateVerification>
  /** Private host recovery contract; never included in model context or diagnostic traces. */
  readonly eventHistory: () => Promise<{
    readonly checkpoint: AppEventCheckpoint
    readonly events: ReadonlyArray<AppEventRecord>
    readonly head: AppStreamState["head"]
  }>
  /** Cover the committed suffix with a verified checkpoint before removing its event bytes. */
  readonly compactEvents: () => Promise<void>
  /** Private host capability, never a model/tool payload. */
  readonly readRecovery: () => Promise<StorageRecoverySnapshot>
  /** Content-free diagnostics; delete capabilities never leave the storage owner. */
  readonly privacyRetirementStatus: () => { readonly phase: "none" | PrivacyRetirement["phase"]; readonly remotePending: number }
  /** Safe to read even when a failed privacy retirement has closed saved-state reads. */
  readonly privacyWriteState: () => "ready" | "pending" | "failed"
  /** Stop consumers synchronously before a fatal storage failure rolls back live state. */
  readonly onStorageFailure: (listener: (reason: StoreFailure) => void) => () => void
  /** Save a delete-only obligation before releasing an ephemeral side-turn token. */
  readonly queueTurnErasure: (runId: string, journal: { readonly legId: string; readonly token: string }) => boolean
  /** Report failed background compaction attempts with their consecutive failure count. */
  readonly onMaintenanceFailure: (listener: (error: unknown, streak: number) => void) => () => void
  /** Stop controller producers before replacing the revoked document's UI. */
  readonly onWriterLost?: (listener: () => void) => () => void
  /** Commit a pending draft, then release persistence resources acquired for this store. */
  readonly dispose?: () => void | Promise<void>
  /** Durable writes accepted so far, settled (chain/DurableCollection.ts); awaited before a navigation that leaves the page. */
  readonly settled?: () => Promise<void>
}

/** A persisted collection declares its storage identity and row schema once. */
const persistedCollection = <TSchema extends StandardSchemaV1>(
  id: string,
  schema: TSchema,
  getKey: (row: InferSchemaOutput<TSchema>) => string,
  recovery: { readonly invalidRows?: "refuse"; readonly validateKey?: typeof matchesStoredStringId } = {}
) => ({
  id,
  schema,
  persisted: true as const,
  partialLoad: "refuse" as const,
  ...recovery,
  /* Every collection shares one coordinator, so a dispatch is one atomic commit. */
  create: (persistence: CollectionPersistence) =>
    createCollection({ ...durableCollectionOptions(persistence, { id, schema, getKey }), schema })
})

const byId = (row: { readonly id: string }): string => row.id
const strictJournalRows = { invalidRows: "refuse" as const, validateKey: matchesStoredStringId }
const refuseDirectMutation = async (): Promise<void> => {
  throw new Error("Application state changes must enter through the event dispatcher.")
}

/** Construction, recovery, preload, and the public collection types share this roster. */
const COLLECTION_DEFINITIONS = {
  appEvents: persistedCollection("app-events", AppEventRecordSchema, byId, strictJournalRows),
  appEventHeads: persistedCollection("app-event-heads", AppEventHeadSchema, byId, strictJournalRows),
  appEventCheckpoints: persistedCollection("app-event-checkpoints", AppEventCheckpointSchema, byId, strictJournalRows),
  appEventRetirements: persistedCollection("app-event-retirements", AppEventRetirementSchema, byId, strictJournalRows),
  sessions: persistedCollection("app-sessions", SessionSchema, byId),
  messages: persistedCollection("app-messages", MessageSchema, byId),
  connectors: persistedCollection("app-connectors", LocalRepositoryConnectorSchema, byId),
  connectorOperations: persistedCollection("app-connector-operations", ConnectorOperationSchema, byId),
  worldDocuments: persistedCollection("world-documents", WorldDocumentSchema, byId),
  cards: persistedCollection("app-cards", CardSchema, byId),
  repositoryContexts: persistedCollection("app-repository-contexts", RepositoryContextSchema, byId),
  repositoryNotifications: persistedCollection("app-repository-notifications", RepositoryNotificationSchema, byId),
  notificationReceipts: persistedCollection("app-notification-receipts", NotificationReadReceiptSchema, byId),
  cardHistories: persistedCollection("app-card-histories", CardHistorySchema, byId),
  approvalRequests: persistedCollection("app-approval-requests", CardSchema, byId),
  transitions: persistedCollection("app-transitions", TransitionRecordSchema, byId),
  commandIntents: persistedCollection("app-command-intents", CommandIntentSchema, byId),
  httpTurns: persistedCollection("app-http-turns", HttpTurnSchema, byId),
  httpTurnLegs: persistedCollection("app-http-turn-legs", HttpTurnLegSchema, byId),
  runtimeRuns: persistedCollection("app-runtime-runs", RuntimeRunSchema, byId),
  runtimeApprovals: persistedCollection("app-runtime-approvals", RuntimeApprovalSchema, byId),
  identitySessions: persistedCollection("app-identity-sessions", IdentitySessionSchema, byId),
  billingAccounts: persistedCollection("app-billing-accounts", BillingAccountSchema, byId),
  toasts: persistedCollection("app-toasts", ToastSchema, byId),
  toolCalls: persistedCollection("app-tool-calls", ToolCallRecordSchema, byId),
  tabs: persistedCollection("app-tabs", TabSchema, byId),
  agents: persistedCollection("app-agents", AgentRoleSchema, byId),
  models: persistedCollection("app-models", StoredModelSchema, byId),
  seats: persistedCollection("app-seats", SeatAssignmentSchema, byId),
  starredTargets: persistedCollection("app-starred-targets", StarredTargetSchema, byId),
  workspaces: persistedCollection("app-workspaces", WorkspaceSchema, byId),
  branches: persistedCollection("app-branches", BranchSchema, byId),
  recommendations: persistedCollection("app-recommendations", RecommendationSchema, byId),
  frames: persistedCollection("app-frames", FrameSchema, byId),
  repositories: persistedCollection("app-cloud-repositories", CloudRepositorySchema, byId),
  workingCopies: persistedCollection("app-working-copies", WorkingCopySchema, byId),
  cloudSessions: persistedCollection("app-cloud-sessions", CloudSessionRowSchema, byId),
  cloudWorkspaces: persistedCollection("app-cloud-workspaces", CloudWorkspaceRowSchema, byId),
  changes: persistedCollection("app-changes", ChangeRowSchema, byId),
  githubAppStatuses: persistedCollection("app-github-app-statuses", GitHubAppStatusRowSchema, (row) => row.repo),
  repoTree: {
    persisted: false as const,
    create: (_persistence: CollectionPersistence) => createCollection(localOnlyCollectionOptions({
      id: "app-repo-tree", schema: RepoTreeRowSchema, getKey: byId,
      onInsert: refuseDirectMutation, onUpdate: refuseDirectMutation, onDelete: refuseDirectMutation
    }))
  },
  repositoryFlows: {
    persisted: false as const,
    create: (_persistence: CollectionPersistence) => createCollection(localOnlyCollectionOptions({
      id: "app-repository-flows", schema: RepositoryFlowsRowSchema, getKey: byId,
      onInsert: refuseDirectMutation, onUpdate: refuseDirectMutation, onDelete: refuseDirectMutation
    }))
  },
  /* One flow's measured node durations, re-read per session: a prediction
   * carried across launches would be made from a history that has moved. */
  flowDurations: {
    persisted: false as const,
    create: (_persistence: CollectionPersistence) => createCollection(localOnlyCollectionOptions({
      id: "app-flow-durations", schema: FlowDurationsRowSchema, getKey: byId,
      onInsert: refuseDirectMutation, onUpdate: refuseDirectMutation, onDelete: refuseDirectMutation
    }))
  }
} as const

export const PERSISTED_COLLECTION_SPECS = Object.values(COLLECTION_DEFINITIONS).filter((definition) => definition.persisted).map(definition => ({
  ...definition,
  // Load older authority unchanged until boot atomically commits its replacement.
  schema: definition.id === "app-event-heads" ? StoredAppEventHeadSchema
    : definition.id === "app-event-checkpoints" ? StoredAppEventCheckpointSchema
    : definition.id === "app-events" ? StoredAppEventRecordSchema : definition.schema
}))

/** The strip's order: main first, then creation order. */
const orderedTabs = (collections: Pick<StoredCollections, "tabs">): Array<TabRow> =>
  [...collections.tabs.values()].sort((left, right) => left.ordinal - right.ordinal)

/** TanStack virtual sync metadata describes the reader, never persisted domain facts. */
const storedRow = <T>(row: T): T => {
  if (typeof row !== "object" || row === null) return row
  const { $synced: _synced, $origin: _origin, $key: _key, $collectionId: _collectionId, ...data } = row as Record<string, unknown>
  return data as T
}

/** The private stream and the reactive collections never share mutable row objects. */
const readProjection = (collections: StoredCollections): AppProjectionSnapshot => structuredClone(Object.fromEntries(
  APP_PROJECTION_COLLECTION_NAMES.map(name => [name, [...collections[name].values()].map(storedRow)])
)) as unknown as AppProjectionSnapshot

interface ProjectionWriter {
  readonly get: (key: string) => unknown
  readonly keys: () => Iterable<string>
  readonly insert: (row: unknown) => unknown
  readonly update: (key: string, config: { optimistic: boolean }, mutate: (draft: Record<string, unknown>) => void) => unknown
  readonly delete: (keys: string[]) => unknown
}

/** Apply a derived result; the only live mutation algorithm is the pure projector. */
const installProjection = (collections: StoredCollections, snapshot: AppProjectionSnapshot, before?: AppProjectionSnapshot): void => {
  for (const name of APP_PROJECTION_COLLECTION_NAMES) {
    if (before?.[name] === snapshot[name]) continue
    const collection = collections[name] as unknown as ProjectionWriter
    const rows = new Map(snapshot[name].map(row => [appProjectionKey(name, row), row]))
    const priorRows = before === undefined ? undefined : new Map(before[name].map(row => [appProjectionKey(name, row), row]))
    const removed = [...collection.keys()].filter(key => !rows.has(key))
    if (removed.length > 0) collection.delete(removed)
    for (const [key, row] of rows) {
      if (priorRows?.get(key) === row) continue
      // A server receipt still needs a local commit before a reload can show
      // it. Keep the pending projection until persistence confirms the row;
      // a failed save must never flash an approved/denied gate. This applies
      // to later writes of the same row too, so queued input cannot reveal it.
      const previous = storedRow(collection.get(key))
      // Keep inserts visible to subsequent projection diffs: reset/signout
      // must still find and delete a newly observed row before it commits.
      if (previous === undefined) collection.insert(structuredClone(row))
      else if (JSON.stringify(previous) !== JSON.stringify(row)) collection.update(key,
        { optimistic: name !== "runtimeApprovals" || (row as RuntimeApproval).row.status === "pending" }, draft => {
        for (const field of Object.keys(draft)) if (!Object.hasOwn(row, field)) draft[field] = undefined
        Object.assign(draft, structuredClone(row))
      })
    }
  }
}

const nextOrdinal = (collections: Pick<StoredCollections, "messages" | "cards">): number => {
  let highest = -1
  for (const message of collections.messages.values()) highest = Math.max(highest, message.ordinal)
  for (const card of collections.cards.values()) highest = Math.max(highest, card.ordinal)
  return highest + 1
}

/*
 * No argument resolves the browser's store. A bare backend is a healthy store
 * of its own kind; a resolution (from `resolvePersistence` with an injected
 * host) carries its mode and degraded flag, so a memory launch boots as one.
 */
export interface AppStoreOptions {
  readonly eraseTurn?: EraseRemoteTurn
}

export const createAppStore = async (
  persistence?: PersistenceBackend | ResolvedPersistence,
  options: AppStoreOptions = {}
): Promise<AppStore> => {
  // One origin owner covers BOTH backends, boot/migration, retirement and writes.
  // Explicit isolated injected hosts provide their own exclusion contract.
  const writer = persistence === undefined ? await acquireLocalStorageWriter(undefined, { steal: consumeWriterTakeover() }) : undefined
  const assertOwned = () => writer?.assertOwned()
  const lostListeners = new Set<() => void>()
  let stopLostStore: (() => void | Promise<void>) | undefined
  if (writer !== undefined) void writer.lost.then(() => {
    // The lease is already fenced. Disposal rejects queued writes before
    // closing SQLite; the UI must not keep dispatching into the stale owner.
    for (const listener of lostListeners) listener()
    const closing = stopLostStore?.()
    reportWriterMoved()
    void Promise.resolve(closing).catch(() => {})
  })
  let resolved: ResolvedPersistence | undefined
  try {
    resolved = persistence === undefined
      ? await resolvePersistence(undefined, assertOwned)
      : "backend" in persistence ? persistence : { backend: persistence, mode: persistence.kind, degraded: false }
    assertOwned()
    const store = await initializeAppStore(resolved, options, assertOwned)
    if (writer !== undefined) store.onStorageFailure(reportStorageFailure)
    stopLostStore = store.dispose
    assertOwned()
    resolved.recordSuccessfulOpen?.()
    if (writer === undefined) return store
    const dispose = async (): Promise<void> => {
      try { await store.dispose?.() } finally {
        if (openBrowserAppStore === dispose) openBrowserAppStore = undefined
        await writer.release()
      }
    }
    openBrowserAppStore = dispose
    return { ...store, dispose, onWriterLost: listener => {
      lostListeners.add(listener)
      return () => { lostListeners.delete(listener) }
    } }
  } catch (error) {
    try {
      await Promise.resolve(stopLostStore?.()).catch(() => {})
      if (resolved?.backend.kind === "opfs") {
        try { await resolved.backend.close() } catch {
          // Preserve the boot failure; close can repeat a failed durable flush.
          console.warn("Smithers: closing the failed app store also failed; reload before retrying recovery.")
        }
      }
    } finally { await writer?.release() }
    throw error
  }
}

/** Check again at every SQL statement, especially COMMIT after asynchronous I/O.
 * Rollback and close must remain available to the revoked owner. */
const fenceDatabase = (database: SqliteRowDatabase, assertOwned: () => void): SqliteRowDatabase => ({
  execute: (sql, params) => {
    if (sql !== "ROLLBACK") assertOwned()
    return database.execute(sql, params)
  },
  close: () => database.close?.()
})

/** Fence sidecar writes as well as queued collection commits after ownership loss. */
const fenceStorage = (storage: StorageApi | undefined, assertOwned: () => void): StorageApi | undefined =>
  storage === undefined ? undefined : new Proxy(storage, {
    get: (target, key) => {
      if (key === "setItem") return (name: string, value: string) => { assertOwned(); target.setItem(name, value) }
      if (key === "removeItem") return (name: string) => { assertOwned(); target.removeItem(name) }
      // Recovery export also needs Storage.length/key; native Storage methods
      // and accessors require their original receiver.
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })

/** Ownership transfers to the returned store only after every boot step succeeds. */
const initializeAppStore = async (
  resolved: ResolvedPersistence, options: AppStoreOptions, assertOwned: () => void = () => {}
): Promise<AppStore> => {
  let resolvedBackend = resolved.backend
  const draftRecoveryStorage = resolved.mode === "memory" ? undefined : fenceStorage(bootRecordStorage(), assertOwned)
  const draftRecovery = readDraftRecovery(draftRecoveryStorage)
  const wikiRecovery = readWikiRecovery(draftRecoveryStorage)
  const entityRecoveries = readEntityRecoveries(draftRecoveryStorage)
  let recoveryBoundary: PendingRecoveryBoundary | undefined
  let recoverySnapshot: AppProjectionSnapshot | undefined
  let recoveringInputs = true
  const privacyRecord = fenceStorage(resolved.privacy?.record, assertOwned)
  let bootRetirement = privacyRecord === undefined ? undefined : readPrivacyRetirement(privacyRecord)
  let wakeRemoteRetirement = (): void => {}
  let stopRemoteRetirement = async (): Promise<void> => {}
  /* Validate persisted rows before creating collections. Compatible older
   * rows migrate; a newer store stays untouched. Only a successful open
   * advances the version stamp. */
  const persistedLocally = fenceStorage(storageOf(resolvedBackend), assertOwned)
  let transactional: TransactionalStorage | undefined
  if (persistedLocally !== undefined && resolvedBackend.kind === "localStorage") {
    if (bootRetirement !== undefined) {
      const raw = persistedLocally.getItem(ENVELOPE_STORAGE_KEY)
      const envelope = raw === null ? undefined : parseStorageEnvelope(raw)
      if (envelope?.version !== 1 || envelope.entries["smithers-mvp.app-event-heads"] === undefined ||
        envelope.entries["smithers-mvp.app-event-checkpoints"] === undefined) throw new PrivacyAuthorityMissing()
    }
    enforceSchemaVersion(persistedLocally, { onMismatch: "validate" })
    /* Open recovers any interrupted localStorage commit and validates the
     * envelope before the first collection reads it. */
    transactional = await openTransactionalStorage(persistedLocally, { collections: PERSISTED_COLLECTION_SPECS })
    resolvedBackend = { ...resolvedBackend, storage: transactional.storage }
  }
  /* A normalized host takes row deltas, so an append costs its own rows rather
   * than the whole retained collection. Whole-collection JSON stays the
   * localStorage envelope's format, and any host without row writes. */
  const loadReport = (resolvedBackend.kind === "opfs" ? resolvedBackend.load : undefined) ?? EMPTY_PERSISTED_LOAD
  const rowSink = resolvedBackend.kind === "opfs" && resolvedBackend.applyRows !== undefined
    ? {
      applyRows: resolvedBackend.applyRows,
      ...(resolvedBackend.readRows === undefined ? {} : { readRows: resolvedBackend.readRows })
    }
    : undefined
  const durable = createCollectionPersistence({
    authorize: assertOwned,
    storage: storageOf(resolvedBackend) ?? memoryStorage(),
    batch: resolvedBackend.kind === "opfs" ? resolvedBackend : transactional,
    ...(resolvedBackend.kind === "opfs" ? { flush: resolvedBackend.flush } : {}),
    ...(rowSink === undefined ? {} : { rows: rowSink })
  })
  const authorizedWrites = new WeakSet<object>()
  const collectionPersistence: CollectionPersistence = {
    ...durable,
    persist: transaction => authorizedWrites.has(transaction)
      ? durable.persist(transaction)
      : Promise.reject(new Error("Application state changes must enter through the event dispatcher."))
  }
  const collections = Object.fromEntries(
    Object.entries(COLLECTION_DEFINITIONS).map(([name, definition]) => [name, definition.create(collectionPersistence)])
  ) as StoredCollections

  const persist = async (transaction: Parameters<typeof collections.sessions.utils.acceptMutations>[0], guardHead: AppStreamState["head"]) => {
    // The coordinator commits every durable projection before local-only sync
    // confirms any of them. A failed commit can therefore roll back optimism
    // without retaining failed rows in an adapter cache or the live collection.
    // TanStack elides unchanged updates. Repair and checkpoint commits still
    // need the head in their durable read set, including its stored row version.
    const durableTransaction = transaction.mutations.some(mutation => mutation.collection.id === "app-event-heads")
      ? transaction
      : { mutations: [...transaction.mutations, {
        collection: { id: "app-event-heads" }, key: "current", type: "update" as const,
        original: guardHead, modified: guardHead, retainUnchanged: true
      }] }
    authorizedWrites.add(durableTransaction)
    try { await collectionPersistence.persist(durableTransaction) } finally { authorizedWrites.delete(durableTransaction) }
    for (const collection of Object.values(collections)) {
      collection.utils.acceptMutations(transaction)
    }
  }


  await Promise.all(Object.values(collections).map(collection => collection.preload()))

  type StreamWrite = {
    readonly state: AppStreamState
    readonly event?: AppEventRecord
    readonly checkpoint?: AppEventCheckpoint
    readonly retire?: string
    readonly clearEvents?: boolean
    readonly retirement?: PrivacyRetirement
  }
  const privacyBookkeeping = new Set([SCHEMA_VERSION_STORAGE_KEY, PERSISTENCE_BACKEND_STORAGE_KEY, THEME_MIRROR_KEY, PALETTE_MIRROR_KEY])
  const finishRetirement = async (intent: PrivacyRetirement): Promise<void> => {
    if (resolved.privacy === undefined || resolved.mode === "memory") throw new PrivacyStorageUnavailable()
    const record = privacyStorage(privacyRecord)
    if (readPrivacyRetirement(record)?.id !== intent.id) throw new PrivacyMarkerMismatch()
    const permitted: PermittedStorageRows = new Map(Object.values(collections).map(collection => [collection.id,
      new Map([...collection.keys()].map(key => [typeof key === "number" ? `n:${key}` : `s:${key}`, storedRow(collection.get(key)!)]))]))
    if (resolvedBackend.kind === "opfs") {
      if (resolvedBackend.retireRecoveryCopies === undefined) throw new PrivacyStorageUnavailable()
      await resolvedBackend.retireRecoveryCopies(permitted)
      eraseLocalRecoveryCopies(record, privacyBookkeeping)
    } else {
      if (transactional === undefined) throw new PrivacyStorageUnavailable()
      transactional.retireRecoveryCopies(privacyBookkeeping, permitted)
      await resolved.privacy.eraseInactiveDatabase()
    }
    // These are explicit public scalar values, not opaque old bookkeeping bytes.
    const permittedSession = collections.sessions.get(SESSION_ID)
    for (const [key, value] of [
      [SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION)], [PERSISTENCE_BACKEND_STORAGE_KEY, resolved.mode],
      [THEME_MIRROR_KEY, permittedSession?.theme ?? "light"], [PALETTE_MIRROR_KEY, permittedSession?.palette ?? DEFAULT_PALETTE]
    ] as const) {
      record.setItem(key, value)
      if (record.getItem(key) !== value) throw new PrivacyKeyNotRemoved()
    }
    completePrivacyRetirement(record, intent)
    wakeRemoteRetirement()
  }
  let installedProjection: AppProjectionSnapshot | undefined
  const writeStream = (write: StreamWrite): void => {
    freezeProjectionValue(write.state.snapshot)
    installProjection(collections, write.state.snapshot, installedProjection)
    if (write.clearEvents) {
      const keys = [...collections.appEvents.keys()]
      if (keys.length > 0) collections.appEvents.delete(keys)
    }
    if (write.event !== undefined) {
      const event = structuredClone(write.event)
      if (collections.appEvents.has(event.id)) collections.appEvents.update(event.id, draft => Object.assign(draft, event))
      else collections.appEvents.insert(event)
    }
    if (write.checkpoint !== undefined) {
      const checkpoint = structuredClone(write.checkpoint)
      if (collections.appEventCheckpoints.has("current")) collections.appEventCheckpoints.update("current", draft => Object.assign(draft, checkpoint))
      else collections.appEventCheckpoints.insert(checkpoint)
    }
    const head = structuredClone(write.state.head)
    if (!collections.appEventHeads.has("current")) collections.appEventHeads.insert(head)
    else {
      // Even repair/compaction must compare-and-swap the head it read. A stale
      // writer cannot repair a disjoint row against a newer accepted stream.
      collections.appEventHeads.update("current", draft => Object.assign(draft, head))
    }
    if (write.retire !== undefined) {
      const id = retiredAppStreamKey(write.retire)
      if (!collections.appEventRetirements.has(id)) collections.appEventRetirements.insert({ id })
    }
    installedProjection = write.state.snapshot
  }

  const seedContext = { createdAt: Date.now(), theme: preferredTheme() }
  const savedHead = storedRow(collections.appEventHeads.get("current"))
  const savedCheckpoint = storedRow(collections.appEventCheckpoints.get("current"))
  let initial: StreamWrite
  if (savedHead === undefined && savedCheckpoint === undefined && collections.appEvents.size === 0) {
    // A privacy intent can only have been accepted after event authority existed.
    // Never recover it by importing an opaque backup or inventing a fresh history.
    if (bootRetirement !== undefined) throw new PrivacyAuthorityMissing()
    // Old row snapshots are an explicit coverage boundary, never invented history.
    const previous = readProjection(collections)
    const baseline = initializeAppStream(seedAppProjection(previous, seedContext), crypto.randomUUID(),
      previous.sessions.length === 0 ? "created" : "legacy-baseline")
    initial = { state: baseline, checkpoint: baseline.checkpoint }
  } else {
    if (savedHead === undefined || savedCheckpoint === undefined || collections.appEventHeads.size !== 1 ||
      collections.appEventCheckpoints.size !== 1) throw new AppEventIntegrityError("head")
    if (collections.appEventRetirements.has(retiredAppStreamKey(savedHead.streamId))) throw new AppEventIntegrityError("scope")
    const upgrading = needsAppProjectorUpgrade(savedHead, savedCheckpoint)
    const upgraded = upgrading
      ? initializeAppStream(seedAppProjection(readProjection(collections), seedContext), crypto.randomUUID(), "projector-upgrade")
      : undefined
    const verified = upgraded ?? replayAppEvents(savedCheckpoint, [...collections.appEvents.values()].map(storedRow), savedHead)
    if (bootRetirement?.phase !== "pending") {
      recoveryBoundary = { head: verified.head, checkpoint: upgraded?.checkpoint ?? savedCheckpoint,
        events: upgraded === undefined ? [...collections.appEvents.values()].map(storedRow) : [], commands: verified.snapshot.commandIntents }
      recoverySnapshot = verified.snapshot
    }
    // A verified upgrade and the target tombstone also prove a privacy rotation
    // committed when the subsequent marker update was interrupted.
    const retirementApplied = bootRetirement !== undefined && (savedHead.streamId === bootRetirement.targetStreamId ||
      (savedCheckpoint.reason === "projector-upgrade" && collections.appEventRetirements.has(retiredAppStreamKey(bootRetirement.targetStreamId))))
    if (bootRetirement !== undefined && bootRetirement.phase !== "pending" && !retirementApplied) throw new PrivacyAuthorityMissing()
    const boot = appendAppEvent(verified, { kind: "boot", seed: seedContext }, {
      eventId: crypto.randomUUID(), createdAt: seedContext.createdAt, persistenceMode: resolved.mode
    })
    initial = upgraded !== undefined
      ? { state: upgraded, checkpoint: upgraded.checkpoint, clearEvents: true, retire: savedHead.streamId }
      : boot === undefined ? { state: verified } : { state: boot, event: boot.event }
    if (bootRetirement?.phase === "pending") {
      addPendingTurnErasures(privacyRecord!, bootRetirement, deriveTurnErasures(verified.snapshot.httpTurnLegs))
      if (!retirementApplied) {
        const transition: AppTransition = bootRetirement.mode === "reset"
          ? { type: "app.reset", actor: "system" }
          : { type: "identity.session.cleared", actor: "user" }
        const cleaned = appendAppEvent(initial.state, { kind: "transition", transition }, {
          eventId: crypto.randomUUID(), createdAt: seedContext.createdAt, persistenceMode: resolved.mode
        })
        if (cleaned === undefined) throw new PrivacyAuthorityMissing()
        const rotated = initializeAppStream(cleaned.snapshot, bootRetirement.targetStreamId, "privacy-reset")
        initial = { state: rotated, checkpoint: rotated.checkpoint, clearEvents: true, retire: savedHead.streamId }
      }
    }
  }
  const bootTransaction = createTransaction({ metadata: { actor: "system", type: "app.event.boot" },
    mutationFn: ({ transaction }) => persist(transaction, initial.state.head) })
  bootTransaction.mutate(() => writeStream(initial))
  await bootTransaction.isPersisted.promise
  if (bootRetirement !== undefined && initial.state.head.streamId !== bootRetirement.targetStreamId) {
    retargetPrivacyRetirement(privacyRecord!, bootRetirement, initial.state.head.streamId)
    bootRetirement = { ...bootRetirement, targetStreamId: initial.state.head.streamId }
  }
  if (bootRetirement?.phase === "pending") await finishRetirement(bootRetirement)
  if (persistedLocally !== undefined && resolvedBackend.kind === "localStorage") {
    persistedLocally.setItem(SCHEMA_VERSION_STORAGE_KEY, String(APP_SCHEMA_VERSION))
  }

  let committed = initial.state
  const savedSignInPrompts = createSavedSignInPrompts(committed.snapshot.messages)
  let optimistic = committed
  let committedCheckpoint: AppEventCheckpoint = structuredClone(storedRow(collections.appEventCheckpoints.get("current")!))
  let committedEvents: AppEventRecord[] = [...collections.appEvents.values()].map(event => structuredClone(storedRow(event)))
  /** The uncovered suffix's stored bytes, charged the way the bounded loader charges them. */
  const eventBytes = (event: AppEventRecord): number => new TextEncoder().encode(JSON.stringify(event)).byteLength
  let committedEventBytes = committedEvents.reduce((total, event) => total + eventBytes(event), 0)
  let generation = 0
  let rejectedStorage: StoreFailure | undefined
  const storageFailureListeners = new Set<(reason: StoreFailure) => void>()
  const rejectStorage = (reason: StoreFailure) => {
    // An already-queued retirement may fail after the first ordinary write.
    // Its privacy fence must still close reads and own the recovery reason.
    if (rejectedStorage !== undefined && (!isPrivacyRetirementError(reason) || isPrivacyRetirementError(rejectedStorage))) return
    rejectedStorage = reason
    for (const listener of storageFailureListeners) listener(reason)
  }
  // A failed privacy retirement closes reads too. An ordinary failed write
  // still leaves committed rows available for inspection and recovery.
  const assertReadable = (): void => { assertOwned(); if (isPrivacyRetirementError(rejectedStorage)) throw rejectedStorage }
  let scheduleAutoCompaction = (): void => {}
  let compactionTimer: ReturnType<typeof setTimeout> | undefined
  let compacting = false
  const pendingWrites = new Set<Transaction>()
  const mutateTracked = (transaction: Transaction, mutate: () => void): void => {
    pendingWrites.add(transaction)
    void transaction.isPersisted.promise.then(() => { pendingWrites.delete(transaction); scheduleAutoCompaction() }, () => pendingWrites.delete(transaction))
    try { transaction.mutate(mutate) } catch (error) { pendingWrites.delete(transaction); throw error }
  }
  const persistStream = async (transaction: Transaction, write: StreamWrite, acceptedGeneration: number): Promise<void> => {
    try {
      if (acceptedGeneration !== generation) throw new AppEventIntegrityError("conflict")
      await persist(transaction, write.state.head)
      committed = write.state
      savedSignInPrompts.publish(committed.snapshot.messages)
      if (write.clearEvents) { committedEvents = []; committedEventBytes = 0 }
      if (write.event !== undefined) { committedEvents.push(write.event); committedEventBytes += eventBytes(write.event) }
      if (write.checkpoint !== undefined) committedCheckpoint = write.checkpoint
      if (write.retirement !== undefined) await finishRetirement(write.retirement)
    } catch (error) {
      if (write.retirement !== undefined) rejectStorage(isPrivacyRetirementError(error) ? error : new PrivacyCleanupPending())
      else if (resolvedBackend.kind === "opfs" && acceptedGeneration === generation) {
        // SQLite retains its failed writer state. A notice written through
        // that same journal would fail silently, so stop consumers and notify
        // the host before rollback wakes them. Never replay the refused act.
        rejectStorage(new StorageWriteFailedError())
      }
      if (acceptedGeneration === generation) {
        generation += 1
        optimistic = committed
        installedProjection = undefined
        applyTheme(committed.snapshot.sessions.find(row => row.id === SESSION_ID)?.theme ?? "light")
        applyPalette(committed.snapshot.sessions.find(row => row.id === SESSION_ID)?.palette ?? DEFAULT_PALETTE)
      }
      throw error
    }
    // Console output is an effect of a newly committed transition, never of
    // boot/replay/verification. Use its already-redacted projected trace.
    if (write.event?.kind === "transition") {
      const trace = write.state.snapshot.messages.find(row => row.id === `${TRACE_MESSAGE_PREFIX}${write.event!.revision}`)?.act
      if (trace !== undefined) {
        try { console.debug(trace) } catch { /* Diagnostics cannot reject a committed fact. */ }
      }
    }
  }

  const views = { ...createWorkspaceViews(collections), savedSignInPrompts: savedSignInPrompts.collection }
  await Promise.all(Object.values(views).map((view) => view.preload()))
  if (resolvedBackend.kind === "opfs") await resolvedBackend.flush()
  applyTheme(collections.sessions.get(SESSION_ID)?.theme ?? "light")
  applyPalette(collections.sessions.get(SESSION_ID)?.palette ?? DEFAULT_PALETTE)

  const session = (): Session => {
    assertReadable()
    const current = collections.sessions.get(SESSION_ID)
    if (current === undefined) throw new Error("Smithers app state is not initialized")
    return freezeRequest(current)
  }

  const worldStateSnapshot = (): WorldStateSnapshot => {
    assertReadable()
    const capturedAt = Date.now()
    const documents = [...collections.worldDocuments.values()].sort((left, right) =>
      left.path.localeCompare(right.path)
    )
    const markdown = documents
      .map(
        (document) =>
          `<!-- world-document: ${document.path}; confidence: ${document.confidence}; sources: ${
            document.sources.join(", ")
          } -->\n${document.body.trim()}`
      )
      .filter((document) => document.length > 0)
      .join("\n\n---\n\n")
    return { capturedAt, revision: session().revision, documents, markdown }
  }

  const agentContextSnapshot = (): AgentContextSnapshot => {
    assertReadable()
    const capturedAt = Date.now()
    return {
      capturedAt,
      revision: session().revision,
      // The model sees the conversation it is answering in, never another tab's.
      messages: [...collections.messages.values()]
        .filter((message) => inConversation(message, conversationTabIdOf(session())))
        .sort((left, right) => left.ordinal - right.ordinal),
      connectors: [...collections.connectors.values()].sort((left, right) => left.name.localeCompare(right.name)),
      tabs: orderedTabs(collections),
      worldState: worldStateSnapshot()
    }
  }


  const approvalRequest = (id: string): ApprovalRequest | undefined => {
    assertReadable()
    const request = collections.approvalRequests.get(id)
    return isApprovalRequest(request) ? freezeRequest(structuredClone(CardSchema.parse(request)) as ApprovalRequest) : undefined
  }

  // Reset fences late streams and command-settlement writes until the new boot.
  let resetTransaction: Transaction | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined

  /*
   * Only the localStorage fallback keeps a draft transaction open across
   * keystrokes. It rewrites the whole envelope, so one commit per character
   * would copy every saved collection. OPFS/SQLite transactions start their
   * commit in the input event: pagehide cannot make a deferred asynchronous
   * worker write durable once an immediate reload is already departing.
   */
  const batchesDraftCommits = resolvedBackend.kind !== "opfs"
  let pendingDraft: {
    readonly transaction: Transaction
    readonly previous: AppStreamState
    write: StreamWrite
    readonly eventId: string
    readonly createdAt: number
    readonly deadline: number
    recoveryRaw: string | undefined
  } | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  const commitDraft = (): void => {
    clearTimeout(draftTimer)
    const pending = pendingDraft
    pendingDraft = undefined
    // A failed commit this draft depended on may already have rolled it back.
    // A failure of its own rejects the receipt its callers hold.
    if (pending?.transaction.state === "pending") pending.transaction.commit().catch(() => {})
  }
  const awaitTypingPause = (deadline: number): void => {
    clearTimeout(draftTimer)
    draftTimer = setTimeout(commitDraft, Math.max(0, Math.min(DRAFT_COMMIT_IDLE_MS, deadline - Date.now())))
  }

  const recoveryAuthority = (state: AppStreamState, actor: AppTransition["actor"], intentId: string): PendingRecoveryAuthority => ({
    ...pendingRecoveryScope(state.snapshot.sessions.find(row => row.id === SESSION_ID)!),
    streamId: committed.head.streamId, baseSequence: committed.head.sequence, baseEventHash: committed.head.eventHash, actor, intentId
  })
  const signupMetadata = (signup: NonNullable<Session["signup"]>) => {
    const { draft: _draft, ...metadata } = signup
    return canonicalStoredJsonValue(metadata)
  }
  const stagePendingSignupInput: AppStore["stagePendingSignupInput"] = (field, value, intentId) => {
    if (disposed || resetTransaction || recoveringInputs || rejectedStorage !== undefined || !intentId || typeof field !== "string" || typeof value !== "string" ||
      (privacyRecord !== undefined && readPrivacyRetirement(privacyRecord)?.phase === "pending")) return undefined
    const signup = optimistic.snapshot.sessions.find(row => row.id === SESSION_ID)?.signup
    if (signup === undefined) return undefined
    const authority = recoveryAuthority(optimistic, "user", intentId)
    const pending = readEntityRecoveries(draftRecoveryStorage).find(row => row.key === "signup")
    const previous = pending?.preparedCommandId && pending.authority?.streamId === authority.streamId && sameRecoveryScope(pending.authority, authority) &&
      admitsPendingRecovery(pending, { head: committed.head, checkpoint: committedCheckpoint, events: committedEvents, commands: optimistic.snapshot.commandIntents }) &&
      pending.value.kind === "signup" && signupMetadata(pending.value.signup) === signupMetadata(signup) ? pending.value.signup : signup
    const record = writeEntityRecovery(draftRecoveryStorage, {
      key: "signup", revision: optimistic.head.revision + 1, authority, preparedCommandId: intentId,
      value: { kind: "signup", signup: { ...signup, draft: { ...previous.draft, [field]: value } } }
    })
    return record === undefined ? undefined : { clear: () => clearEntityRecovery(draftRecoveryStorage, record) }
  }
  const stagePendingApprovalAnswer: AppStore["stagePendingApprovalAnswer"] = (input, intentId) => {
    if (disposed || resetTransaction || recoveringInputs || rejectedStorage !== undefined || !intentId || typeof input.text !== "string") return undefined
    const row = optimistic.snapshot.runtimeApprovals.find(row => row.id === input.id)
    if (!isCurrentApprovalAnswer(row, input)) return undefined
    const authority = recoveryAuthority(optimistic, "user", intentId)
    const record = writeEntityRecovery(draftRecoveryStorage, {
      key: `approval-answer:${input.id}:${input.question}`, revision: optimistic.head.revision + 1, authority, preparedCommandId: intentId,
      value: { kind: "approval-answer", id: input.id, question: input.question, text: input.text }
    })
    return record === undefined ? undefined : { clear: () => clearEntityRecovery(draftRecoveryStorage, record) }
  }
  const stagePendingCardInput: AppStore["stagePendingCardInput"] = (cardId, input, intentId, field) => {
    if (disposed || resetTransaction || recoveringInputs || rejectedStorage !== undefined || !intentId ||
      (privacyRecord !== undefined && readPrivacyRetirement(privacyRecord)?.phase === "pending")) return undefined
    const original = optimistic.snapshot.cards.find(row => row.id === cardId)
    if (original?.kind !== "flow-form" || original.status === "acted" || original.payload.submitting || original.payload.flow === "env.set") return undefined
    const decoded = CardSchema.safeParse(input)
    if (!decoded.success || decoded.data.kind !== "flow-form" || decoded.data.status !== "active" || decoded.data.id !== cardId || decoded.data.payload.flow === "env.set") return undefined
    let card = decoded.data
    if (!original.payload.fields.some(candidate => candidate.name === field)) return undefined
    // The preparation hook may only change validated draft fields and clear an old error.
    // It cannot replace field options, the target flow, caller, history or capabilities.
    const withoutDraft = (row: Extract<Card, { kind: "flow-form" }>) => {
      const { draft: _draft, error: _error, ...payload } = row.payload
      return { ...row, status: "active", payload }
    }
    if (canonicalStoredJsonValue(withoutDraft(card)) !== canonicalStoredJsonValue(withoutDraft(original))) return undefined
    const beforeOther = { ...original.payload.draft }, afterOther = { ...card.payload.draft }
    delete beforeOther[field]; delete afterOther[field]
    if (canonicalStoredJsonValue(beforeOther) !== canonicalStoredJsonValue(afterOther)) return undefined
    const authority = recoveryAuthority(optimistic, "user", intentId)
    const key = `card:${authority.workspaceId}:${authority.branchId}:${cardId}`
    const pending = readEntityRecoveries(draftRecoveryStorage).find(row => row.key === key)
    if (pending?.preparedCommandId && pending.authority?.streamId === authority.streamId && sameRecoveryScope(pending.authority, authority) &&
      admitsPendingRecovery(pending, { head: committed.head, checkpoint: committedCheckpoint, events: committedEvents, commands: optimistic.snapshot.commandIntents }) &&
      pending.value.kind === "card" && pending.value.card?.kind === "flow-form" &&
      canonicalStoredJsonValue(withoutDraft(pending.value.card)) === canonicalStoredJsonValue(withoutDraft(card))) {
      const merged = { ...pending.value.card.payload.draft }
      if (Object.hasOwn(card.payload.draft, field)) merged[field] = card.payload.draft[field]!
      else delete merged[field]
      card = { ...card, payload: { ...card.payload, draft: merged } }
    }
    const record = writeEntityRecovery(draftRecoveryStorage, {
      key, revision: optimistic.head.revision + 1, authority, preparedCommandId: intentId,
      value: { kind: "card", workspaceId: authority.workspaceId, branchId: authority.branchId, id: cardId, card }
    })
    return record === undefined ? undefined : { clear: () => clearEntityRecovery(draftRecoveryStorage, record) }
  }
  const recordPendingEntity = (before: AppStreamState, after: AppStreamState, transition: AppTransition, intentId: string): EntityRecoveryRecord | undefined => {
    if (recoveringInputs || transition.actor !== "user") return undefined
    const authority = recoveryAuthority(before, transition.actor, intentId)
    if (transition.type === "approval.answer.changed") {
      const key = `approval-answer:${transition.id}:${transition.question}`
      const pending = readEntityRecoveries(draftRecoveryStorage).find(row => row.key === key)
      // A previous command cannot overwrite a newer keystroke's preparation.
      if (pending?.preparedCommandId && pending.authority?.streamId === authority.streamId && sameRecoveryScope(pending.authority, authority) &&
        admitsPendingRecovery(pending, { head: committed.head, checkpoint: committedCheckpoint, events: committedEvents, commands: after.snapshot.commandIntents }) &&
        pending.value.kind === "approval-answer" && pending.value.text !== transition.text) return undefined
      return writeEntityRecovery(draftRecoveryStorage, { key, revision: after.head.revision, authority,
        value: { kind: "approval-answer", id: transition.id, question: transition.question, text: transition.text } })
    }
    if (transition.type === "target.starred" || transition.type === "target.unstarred") {
      const id = transition.type === "target.starred" ? transition.star.id : transition.id
      return writeEntityRecovery(draftRecoveryStorage, { key: `target-star:${id}`, revision: after.head.revision, authority,
        value: { kind: "target-star", id, repoId: transition.repoId, star: after.snapshot.starredTargets.find(row => row.id === id) ?? null } })
    }
    // Session answers a person expects to survive an immediate reload.
    if (transition.type === "hint.dismissed") {
      return writeEntityRecovery(draftRecoveryStorage, { key: `hint-dismissed:${transition.id}`, revision: after.head.revision,
        authority, value: { kind: "hint-dismissed", id: transition.id } })
    }
    if (transition.type === "first-run.dismissed") {
      return writeEntityRecovery(draftRecoveryStorage, { key: "first-run-dismissed", revision: after.head.revision, authority, value: { kind: "first-run-dismissed" } })
    }
    if (transition.type === "signup.changed") {
      const signup = after.snapshot.sessions.find(row => row.id === SESSION_ID)?.signup
      if (signup === undefined) return undefined
      // A completed earlier keystroke cannot replace the latest prepared
      // draft while that command still waits for its own saved receipt.
      const pending = readEntityRecoveries(draftRecoveryStorage).find(row => row.key === "signup")
      if (pending?.preparedCommandId && pending.authority?.streamId === authority.streamId && sameRecoveryScope(pending.authority, authority) &&
        admitsPendingRecovery(pending, { head: committed.head, checkpoint: committedCheckpoint, events: committedEvents, commands: after.snapshot.commandIntents }) &&
        pending.value.kind === "signup" && signupMetadata(pending.value.signup) === signupMetadata(signup) &&
        canonicalStoredJsonValue(pending.value.signup.draft) !== canonicalStoredJsonValue(signup.draft)) return undefined
      return writeEntityRecovery(draftRecoveryStorage, { key: "signup", revision: after.head.revision, authority, value: { kind: "signup", signup } })
    }
    const id = transition.type === "card.upsert" || transition.type === "card.view.loaded" || transition.type === "card.navigated" ? transition.card.id
      : transition.type === "card.updated" || transition.type === "card.removed" || transition.type === "card.history.moved" ? transition.id : undefined
    if (id === undefined) return undefined
    const card = after.snapshot.cards.find(row => row.id === id) ?? null, prior = before.snapshot.cards.find(row => row.id === id)
    const history = after.snapshot.cardHistories.find(row => row.id === id)
    const secret = (row: Card): boolean => row.kind === "env" || row.kind === "approval" || row.kind === "approvals-inbox" ||
      (row.kind === "flow-form" && row.payload.flow === "env.set")
    if ((card === null && prior === undefined) || (card && secret(card)) || (prior && secret(prior)) || history?.entries.some(secret)) return undefined
    // An earlier command's completed card edit must not overwrite a newer human
    // preparation that is still waiting for its own command receipt.
    const pending = readEntityRecoveries(draftRecoveryStorage).find(row => row.key === `card:${authority.workspaceId}:${authority.branchId}:${id}`)
    if (pending?.preparedCommandId && pending.authority?.streamId === authority.streamId && sameRecoveryScope(pending.authority, authority) &&
      admitsPendingRecovery(pending, { head: committed.head, checkpoint: committedCheckpoint, events: committedEvents, commands: after.snapshot.commandIntents }) &&
      pending.value.kind === "card" && pending.value.card?.kind === "flow-form" && card?.kind === "flow-form" &&
      pending.value.card.payload.flow === card.payload.flow &&
      canonicalStoredJsonValue(pending.value.card.payload.draft) !== canonicalStoredJsonValue(card.payload.draft)) return undefined
    return writeEntityRecovery(draftRecoveryStorage, { key: `card:${authority.workspaceId}:${authority.branchId}:${id}`, revision: after.head.revision, authority,
      value: { kind: "card", workspaceId: authority.workspaceId, branchId: authority.branchId, id, card,
        ...(history === undefined ? {} : { history }) } })
  }

  // This is a capability for in-flight work, not another draft store. Only
  // authoritative dispatcher writes revoke it, including identical edits in
  // one batched typing transaction. Draft content remains in the collection.
  let composerInput = {}
  const advanceComposerInput = (transition: AppTransition, before: AppStreamState, after: AppStreamState): void => {
    const previous = before.snapshot.sessions.find(row => row.id === SESSION_ID)!
    const next = after.snapshot.sessions.find(row => row.id === SESSION_ID)!
    if (transition.type === "composer.changed" || before.head.streamId !== after.head.streamId ||
      previous.draft !== next.draft || previous.activeWorkspaceId !== next.activeWorkspaceId ||
      previous.activeBranchId !== next.activeBranchId || previous.activeRepoKey !== next.activeRepoKey ||
      previous.composerOwner !== next.composerOwner ||
      (!previous.paletteOpen && next.paletteOpen)) composerInput = {}
  }
  const captureComposerDraft = (text: string): (() => boolean) => {
    const input = composerInput, acceptedGeneration = generation
    const matched = session().draft.trim() === text.trim()
    return () => !disposed && matched && generation === acceptedGeneration && composerInput === input &&
      session().draft.trim() === text.trim()
  }

  const dispatch = (transition: AppTransition): Transaction => {
    if (disposed) throw new Error("The app state owner is closed. Open the current store before dispatching.")
    assertReadable()
    if (rejectedStorage !== undefined) throw rejectedStorage
    if (privacyRecord !== undefined && readPrivacyRetirement(privacyRecord)?.phase === "pending") throw new PrivacyCleanupPending()
    if (resetTransaction !== undefined) return resetTransaction
    if (transition.type === "composer.changed" && pendingDraft?.transaction.state === "pending") {
      const pending = pendingDraft
      const next = appendAppEvent(pending.previous, { kind: "transition", transition }, {
        eventId: pending.eventId, createdAt: pending.createdAt, persistenceMode: resolved.mode
      })
      if (next === undefined) return pending.transaction
      if (!recoveringInputs && transition.actor === "user") pending.recoveryRaw = writeDraftRecovery(draftRecoveryStorage, next.head.revision, transition.draft,
        recoveryAuthority(pending.previous, transition.actor, pending.eventId)) ?? pending.recoveryRaw
      advanceComposerInput(transition, optimistic, next)
      pending.write = { state: next, event: next.event }
      optimistic = next
      pending.transaction.mutate(() => writeStream(pending.write))
      awaitTypingPause(pending.deadline)
      return pending.transaction
    }
    commitDraft()
    const previous = optimistic
    const createdAt = Date.now()
    const eventId = crypto.randomUUID()
    const next = appendAppEvent(previous, { kind: "transition", transition }, { eventId, createdAt, persistenceMode: resolved.mode })
    if (next === undefined) {
      const refused = createTransaction({ mutationFn: async () => {} })
      refused.mutate(() => {})
      return refused
    }
    let write: StreamWrite = { state: next, event: next.event }
    if (appTransitionErasesPrivateState(previous.snapshot, transition)) {
      const recovery = readDraftRecovery(draftRecoveryStorage)
      if (recovery !== undefined) clearDraftRecovery(draftRecoveryStorage, recovery.raw)
      for (const key of [WIKI_RECOVERY_STORAGE_KEY, ENTITY_RECOVERY_STORAGE_KEY]) draftRecoveryStorage?.removeItem(key)
      const rotated = initializeAppStream(next.snapshot, crypto.randomUUID(), "privacy-reset")
      write = { state: rotated, checkpoint: rotated.checkpoint, clearEvents: true, retire: previous.head.streamId }
      if (resolved.privacy !== undefined) {
        try {
          const record = privacyStorage(privacyRecord)
          const backend = resolved.mode === "memory" ? readRecordedBackend(record) : resolved.mode
          if (backend === null) throw new PrivacyStorageUnavailable()
          const retirement = beginPrivacyRetirement(record, { id: crypto.randomUUID(),
            mode: transition.type === "app.reset" ? "reset" : "account", backend, targetStreamId: rotated.head.streamId },
            deriveTurnErasures(previous.snapshot.httpTurnLegs))
          if (resolved.mode === "memory") throw new PrivacyStorageUnavailable()
          write = { ...write, retirement }
        } catch (error) { rejectStorage(isPrivacyRetirementError(error) ? error : new PrivacyCleanupPending()); throw error }
      }
    }
    const acceptedGeneration = generation
    // The provisional draft can be replaced only before its single commit begins.
    const recoveryRaw = !recoveringInputs && transition.type === "composer.changed" && transition.actor === "user"
      ? writeDraftRecovery(draftRecoveryStorage, next.head.revision, transition.draft, recoveryAuthority(previous, transition.actor, eventId)) : undefined
    const recoveredWikiRaw = !recoveringInputs && transition.type === "world.document.upserted" && transition.actor === "user"
      ? writeWikiRecovery(draftRecoveryStorage, next.head.revision, transition.document, recoveryAuthority(previous, transition.actor, eventId)) : undefined
    const recoveredEntity = recordPendingEntity(previous, next, transition, eventId)
    const draft = { previous, write, eventId, createdAt, deadline: createdAt + DRAFT_COMMIT_MAX_MS, recoveryRaw }
    const clearPendingInputs = (): void => {
      try { assertOwned() } catch { return }
      if (draft.recoveryRaw !== undefined) clearDraftRecovery(draftRecoveryStorage, draft.recoveryRaw)
      if (recoveredWikiRaw !== undefined) clearWikiRecovery(draftRecoveryStorage, recoveredWikiRaw)
      if (recoveredEntity !== undefined) clearEntityRecovery(draftRecoveryStorage, recoveredEntity)
    }
    const transaction = createTransaction({
      id: `app-event-${eventId}`,
      autoCommit: transition.type !== "composer.changed" || !batchesDraftCommits,
      metadata: { actor: transition.actor, type: transition.type },
      mutationFn: ({ transaction }) => persistStream(transaction, draft.write, acceptedGeneration)
    })
    if (transition.type === "app.reset") resetTransaction = transaction
    advanceComposerInput(transition, previous, write.state)
    optimistic = write.state
    try { mutateTracked(transaction, () => writeStream(draft.write)) } catch (error) {
      optimistic = previous
      installedProjection = undefined
      clearPendingInputs()
      if (resetTransaction === transaction) resetTransaction = undefined
      throw error
    }
    const current = write.state.snapshot.sessions.find(row => row.id === SESSION_ID)
    if (current !== undefined) { applyTheme(current.theme); applyPalette(current.palette ?? DEFAULT_PALETTE) }
    if (transition.type === "app.reset") void transaction.isPersisted.promise.catch(() => { resetTransaction = undefined })
    void transaction.isPersisted.promise.then(clearPendingInputs, clearPendingInputs)
    if (transition.type === "composer.changed" && batchesDraftCommits) {
      pendingDraft = Object.assign(draft, { transaction })
      awaitTypingPause(draft.deadline)
    }
    return transaction
  }


  // Every slot is compared with the same verified pre-boot boundary. Recovery
  // receipts add fresh events and cannot prove that a later input already landed.
  const pendingRecoveries = [
    ...(draftRecovery ? [{ kind: "draft" as const, record: draftRecovery }] : []),
    ...(wikiRecovery ? [{ kind: "wiki" as const, record: wikiRecovery }] : []),
    ...entityRecoveries.map(record => ({ kind: "entity" as const, record }))
  ].sort((a, b) => {
    const left = a.record.authority?.intentId ?? "", right = b.record.authority?.intentId ?? ""
    return a.record.revision - b.record.revision || (left < right ? -1 : left > right ? 1 : 0)
  })
  const preparedInputStillCurrent = (record: EntityRecoveryRecord): boolean => {
    if (record.value.kind === "approval-answer") {
      const value = record.value
      const row = recoverySnapshot?.runtimeApprovals.find(row => row.id === value.id)
      const session = recoverySnapshot?.sessions.find(row => row.id === SESSION_ID)
      return !!record.authority && !!session && sameRecoveryScope(record.authority, pendingRecoveryScope(session)) &&
        isCurrentApprovalAnswer(row, value)
    }
    if (record.preparedCommandId === undefined) return true
    const value = record.value
    if (value.kind === "signup") {
      const saved = recoverySnapshot?.sessions.find(row => row.id === SESSION_ID)
      return !!record.authority && !!saved?.signup && sameRecoveryScope(record.authority, pendingRecoveryScope(saved)) &&
        signupMetadata(saved.signup) === signupMetadata(value.signup)
    }
    if (!record.authority || value.kind !== "card" || value.card?.kind !== "flow-form" || !recoverySnapshot) return false
    const scope = record.authority, savedSession = recoverySnapshot.sessions.find(row => row.id === SESSION_ID)!
    const currentScope = pendingRecoveryScope(savedSession)
    const cards = scope.branchId === currentScope.branchId && scope.workspaceId === currentScope.workspaceId ? recoverySnapshot.cards
      : recoverySnapshot.branches.find(branch => branch.id === scope.branchId && branch.workspaceId === scope.workspaceId)?.snapshot?.cards
    const prior = cards?.find(row => row.id === value.id)
    if (prior?.kind !== "flow-form" || prior.status === "acted" || prior.payload.submitting) return false
    const metadata = (card: Extract<Card, { kind: "flow-form" }>) => {
      const { draft: _draft, error: _error, ...payload } = card.payload
      return { ...card, status: "active", payload }
    }
    return canonicalStoredJsonValue(metadata(prior)) === canonicalStoredJsonValue(metadata(value.card))
  }
  for (const pending of pendingRecoveries) {
    const authority = pending.record.authority
    if (!authority) continue // Unscoped legacy evidence never overrides event authority.
    if (admitsPendingRecovery(pending.record, recoveryBoundary) && (pending.kind !== "entity" || preparedInputStillCurrent(pending.record))) {
      const scope = { workspaceId: authority.workspaceId, branchId: authority.branchId, conversationTabId: authority.conversationTabId }
      if (pending.kind === "draft") {
        await dispatch({ type: "composer.changed", actor: authority.actor, draft: pending.record.draft, recoveryScope: scope }).isPersisted.promise
      } else if (pending.kind === "wiki") {
        await dispatch({ type: "world.document.upserted", actor: authority.actor, document: pending.record.document, select: false, recoveryScope: scope }).isPersisted.promise
      } else {
        const value = pending.record.value
        if (value.kind === "card") {
          if (value.workspaceId === authority.workspaceId && value.branchId === authority.branchId) await dispatch({
            type: "card.recovered", actor: authority.actor, workspaceId: value.workspaceId, branchId: value.branchId,
            id: value.id, card: value.card, history: value.history
          }).isPersisted.promise
        } else if (value.kind === "approval-answer") {
          await dispatch({ type: "approval.answer.changed", actor: "user", id: value.id, question: value.question, text: value.text }).isPersisted.promise
        } else if (value.kind === "first-run-dismissed") {
          await dispatch({ type: "first-run.dismissed", actor: authority.actor }).isPersisted.promise
        } else if (value.kind === "hint-dismissed") {
          await dispatch({ type: "hint.dismissed", actor: authority.actor, id: value.id }).isPersisted.promise
        } else if (value.kind === "signup") {
          await dispatch({ type: "signup.changed", actor: authority.actor, patch: value.signup }).isPersisted.promise
        } else if (value.star === null) await dispatch({ type: "target.unstarred", actor: authority.actor, repoId: value.repoId, id: value.id }).isPersisted.promise
        else await dispatch({ type: "target.starred", actor: authority.actor, repoId: value.repoId, star: value.star }).isPersisted.promise
      }
    }
    if (pending.kind === "draft") clearDraftRecovery(draftRecoveryStorage, pending.record.raw)
    else if (pending.kind === "wiki") clearWikiRecovery(draftRecoveryStorage, pending.record.raw)
    else clearEntityRecovery(draftRecoveryStorage, pending.record)
  }
  recoveringInputs = false

  // A lost controller cannot finish an in-flight submission. Preserve the
  // reviewed request and uncertain outcome; projection reads or an idempotent
  // retry will establish whether the decision reached its authority.
  for (const card of collections.cards.values()) {
    await releaseInterruptedApproval({ dispatch }, card,
      "The decision was interrupted. Its outcome is unknown; check the run or retry the same decision.")
  }

  // Boot reconciliation: a persisted "responding" phase means the app went
  // away mid-turn — no done frame can ever arrive for that stream. Name it
  // through the dispatcher (journaled, actor system) instead of restoring a
  // silently stuck pending surface (Launch Checklist B-1).
  // Awaited like every other boot write in `seed`: the reconciliation is durable
  // before the store is handed out, and its persistence failure surfaces as a
  // rejected boot rather than an unhandled rejection nobody sees.
  if (collections.sessions.get(SESSION_ID)?.phase === "responding") {
    await dispatch({ type: "session.turn.orphaned", actor: "system" }).isPersisted.promise
  }

  // A submission belongs to the previous controller's lifetime. Preserve
  // its inputs, release the busy guard, and name the uncertain outcome so
  // the user can check for a completed side effect before retrying.
  for (const card of collections.cards.values()) {
    if (card.kind !== "flow-form" || card.payload.submitting !== true) continue
    await dispatch({
      type: "card.updated",
      actor: "system",
      id: card.id,
      patch: {
        status: "error",
        payload: {
          ...card.payload,
          submitting: false,
          error: "Submission was interrupted. Check the result before submitting again."
        }
      }
    }).isPersisted.promise
  }

  /*
   * Boot reconciliation: a question is not state either. A pending
   * `/world.delete` confirm that survived a restart opened its modal over an
   * app the user had not asked anything of — and the overlay swallowed every
   * pointer press, so the whole app was unreachable. An unanswered question
   * is dropped, never re-asked.
   */
  if (collections.sessions.get(SESSION_ID)?.pendingWorldDeleteId != null) {
    await dispatch({ type: "world.delete.asked", actor: "system", id: null }).isPersisted.promise
  }

  // The composer overlay is presentation state. Preserve its independently
  // persisted draft, but never reopen the overlay merely because a page died
  // or reloaded while it was visible.
  if (collections.sessions.get(SESSION_ID)?.paletteOpen === true) {
    await dispatch({ type: "palette.toggled", actor: "system", open: false }).isPersisted.promise
  }

  // Boot reconciliation: toasts are notifications, not state — a toast left
  // behind by a closed session would resurrect a "running" notice for work
  // that is gone. They never survive a restart.
  for (const key of [...collections.toasts.keys()]) {
    await dispatch({ type: "toast.dismissed", actor: "system", id: key }).isPersisted.promise
  }

  /*
   * A card tab whose card was cleared closes through the dispatcher. The
   * selected tab falls back to main when it no longer exists — including a
   * terminal or harness tab a store saved before those retired (the row
   * itself fails `TabSchema` and is quarantined at open).
   */
  for (const tab of orderedTabs(collections)) {
    const stale = tab.kind === "card" && collections.cards.get(tab.cardId) === undefined
    if (stale) await dispatch({ type: "tab.closed", actor: "system", id: tab.id }).isPersisted.promise
  }
  if (collections.tabs.get(collections.sessions.get(SESSION_ID)?.activeTabId ?? MAIN_TAB_ID) === undefined) {
    await dispatch({ type: "tab.selected", actor: "system", id: MAIN_TAB_ID }).isPersisted.promise
  }

  /*
   * A degraded launch runs on a memory store: the transcript is empty and
   * nothing typed in this session will survive it. Refusing to read or
   * overwrite the recorded store is the right call, but the person looking at
   * the empty surface has to be told why, or an honest recovery reads as
   * silent data loss. The failure toast is the one notice that stays until
   * dismissed, which is what this state needs — it is true for the whole
   * session, not for 300ms.
   *
   * Raised after the stale-toast sweep above so it is not swept with them.
   */
  if (resolved.degraded) {
    await dispatch({
      type: "toast.shown",
      actor: "system",
      key: "store.degraded",
      title: "This session will not be saved"
    }).isPersisted.promise
    await dispatch({
      type: "toast.resolved",
      actor: "system",
      key: "store.degraded",
      status: "failed",
      title: "This session will not be saved",
      detail:
        "The saved conversation could not be opened, so this session is running in memory. Nothing typed now will be kept. The saved conversation is untouched and returns on the next launch."
    }).isPersisted.promise
  }

  /*
   * A partial load is a boot that survived, not a boot that failed: the store
   * refused to hand the launch more than one collection's budget, older rows
   * are still on disk, and the recovery download reaches them. Say so once, in
   * the same durable transition vocabulary every other system notice uses.
   */
  if (loadReport.skipped > 0) {
    await dispatch({
      type: "toast.shown",
      actor: "system",
      key: PERSISTED_LOAD_TOAST_KEY,
      title: PERSISTED_LOAD_TOAST_TITLE
    }).isPersisted.promise
    await dispatch({
      type: "toast.resolved",
      actor: "system",
      key: PERSISTED_LOAD_TOAST_KEY,
      status: "failed",
      title: PERSISTED_LOAD_TOAST_TITLE,
      detail: persistedLoadNotice(loadReport)
    }).isPersisted.promise
  }

  // A hidden page may never run the typing-pause timer; commit what was typed.
  const page = typeof window === "undefined" || typeof window.addEventListener !== "function" ? undefined : window
  page?.addEventListener("pagehide", commitDraft)

  const { approvalRequests: _approvalRequests, appEvents: _appEvents, appEventHeads: _appEventHeads,
    appEventCheckpoints: _appEventCheckpoints, appEventRetirements: _appEventRetirements, ...publicCollections } = collections
  if (privacyRecord !== undefined) {
    const remoteRetirement = createRemoteRetirementWorker(privacyRecord, options.eraseTurn)
    wakeRemoteRetirement = remoteRetirement.wake
    stopRemoteRetirement = remoteRetirement.dispose
    wakeRemoteRetirement()
  }
  const compactEvents = async (): Promise<void> => {
      assertReadable()
      if (disposed) throw new Error("The app state owner is closed.")
      if (privacyRecord !== undefined && readPrivacyRetirement(privacyRecord)?.phase === "pending") throw new PrivacyCleanupPending()
      commitDraft()
      // Compact a settled head. Preparations created while the checkpoint write
      // is in flight then reference that same retained head, never an ancestor
      // of optimistic writes that this compaction is about to discard.
      while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites].map(transaction => transaction.isPersisted.promise))
      assertReadable()
      if (disposed) throw new Error("The app state owner is closed.")
      if (privacyRecord !== undefined && readPrivacyRetirement(privacyRecord)?.phase === "pending") throw new PrivacyCleanupPending()
      // A prepared human form edit may await command admission without any row
      // write to drain. Retain the exact verified ancestor it references until
      // its owning command applies or refuses it; never rebind pending input to
      // a newer head just to make compaction possible.
      const boundary = { head: committed.head, checkpoint: committedCheckpoint, events: committedEvents,
        commands: committed.snapshot.commandIntents }
      if (readEntityRecoveries(draftRecoveryStorage).some(record => record.preparedCommandId !== undefined &&
        record.authority !== undefined && record.authority.baseSequence < optimistic.head.sequence && admitsPendingRecovery(record, boundary))) {
        throw new Error("Event compaction is deferred while a prepared form input awaits its command receipt.")
      }
      const write: StreamWrite = { state: optimistic, checkpoint: createAppCheckpoint(optimistic, "compaction"), clearEvents: true }
      const acceptedGeneration = generation
      const transaction = createTransaction({ metadata: { actor: "system", type: "app.event.compact" },
        mutationFn: ({ transaction }) => persistStream(transaction, write, acceptedGeneration) })
      mutateTracked(transaction, () => writeStream(write))
      await transaction.isPersisted.promise
  }
  // Bound replay work without discarding any materialized conversation, frame,
  // draft or run. The existing atomic checkpoint path retains those rows and
  // refuses compaction while a prepared edit still needs the covered prefix.
  const maintenanceListeners = new Set<(error: unknown, streak: number) => void>()
  let maintenanceStreak = 0
  scheduleAutoCompaction = () => {
    if (disposed || compacting || compactionTimer !== undefined || pendingWrites.size > 0 ||
      (committedEvents.length < 64 && committedEventBytes < PERSISTED_JOURNAL_COMPACTION_BYTES)) return
    compactionTimer = setTimeout(() => {
      compactionTimer = undefined
      if (disposed || pendingWrites.size > 0) return
      compacting = true
      void compactEvents().then(() => { maintenanceStreak = 0 }).catch(error => {
        maintenanceStreak += 1
        for (const listener of maintenanceListeners) {
          try { listener(error, maintenanceStreak) } catch { /* Maintenance observers cannot break persistence. */ }
        }
        // Optional maintenance must not turn saved work into an app failure.
        // The original suffix remains authoritative; retry after a later write.
      }).finally(() => { compacting = false })
    }, 1_000)
  }
  scheduleAutoCompaction()
  return {
    collections: Object.fromEntries(Object.entries({ ...publicCollections, ...views })
      .map(([name, collection]) => [name, readOnlyCollection(collection, assertReadable)])) as AppCollections,
    dispatch,
    captureComposerDraft,
    approvalRequest,
    committedCard: id => { assertReadable(); return committed.snapshot.cards.find(row => row.id === id) },
    committedWorkspace: id => { assertReadable(); return committed.snapshot.cloudWorkspaces.find(row => row.id === id) },
    committedToast: id => { assertReadable(); return committed.snapshot.toasts.find(row => row.id === id) },
    committedWorldDocument: id => { assertReadable(); return committed.snapshot.worldDocuments.find(row => row.id === id) },
    committedRuntimeRun: id => { assertReadable(); return committed.snapshot.runtimeRuns.find(row => row.id === id) },
    committedRuntimeApproval: id => { assertReadable(); return committed.snapshot.runtimeApprovals.find(row => row.id === id) },
    committedHttpTurn: (turnId, owner) => { assertReadable(); return committed.snapshot.httpTurns.find(row => row.turnId === turnId && row.owner === owner) },
    persistenceMode: resolved.mode,
    persistedLoad: loadReport,
    persistenceDegraded: resolved.degraded,
    session,
    stagePendingCardInput,
    stagePendingSignupInput,
    stagePendingApprovalAnswer,
    nextOrdinal: () => { assertReadable(); return nextOrdinal(collections) },
    worldStateSnapshot,
    agentContextSnapshot,
    eventHistory: async () => {
      assertReadable()
      commitDraft()
      while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites].map(transaction => transaction.isPersisted.promise))
      assertReadable()
      return structuredClone({ checkpoint: committedCheckpoint, events: committedEvents, head: committed.head })
    },
    verifyState: async () => {
      assertReadable()
      commitDraft()
      // Check and capture in one continuation. A settled durable tail alone
      // does not exclude a newer optimistic transaction or pending rollback.
      while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites].map(transaction => transaction.isPersisted.promise))
      assertReadable()
      return verifyAppProjection(replayAppEvents(committedCheckpoint, committedEvents, committed.head), readProjection(collections))
    },
    compactEvents,
    onMaintenanceFailure: listener => { maintenanceListeners.add(listener); return () => { maintenanceListeners.delete(listener) } },
    readRecovery: () => captureBrowserStorageRecovery({
      session: resolved.mode,
      requirePrivacyBarrier: resolved.privacy !== undefined,
      assertCurrent: assertReadable,
      localStorage: recoveryStorage(resolved.privacy !== undefined ? privacyRecord : resolved.mode === "localStorage" ? persistedLocally : bootRecordStorage()),
      sqlite: resolvedBackend.kind === "opfs"
        ? resolvedBackend.readRecovery ?? (() => Promise.reject(new StorageRecoveryError("unreadable")))
        : browserSqliteRecoveryReader(),
      ...(resolved.mode === "memory" ? { memory: recoveryStorage(persistedLocally) } : {})
    }),
    privacyWriteState: () => isPrivacyRetirementError(rejectedStorage) ? "failed"
      : privacyRecord !== undefined && readPrivacyRetirement(privacyRecord)?.phase === "pending" ? "pending" : "ready",
    onStorageFailure: listener => {
      storageFailureListeners.add(listener)
      return () => { storageFailureListeners.delete(listener) }
    },
    privacyRetirementStatus: () => {
      const intent = privacyRecord === undefined ? undefined : readPrivacyRetirement(privacyRecord)
      const reset = privacyRecord === undefined ? [] : readResetErasures(privacyRecord)
      const remotePending = new Set([...(intent?.erasures ?? []), ...reset].map(entry => JSON.stringify([entry.runId, entry.legId]))).size
      return { phase: reset.length > 0 && (intent === undefined || intent.phase === "complete") ? "remote-pending" : intent?.phase ?? "none", remotePending }
    },
    queueTurnErasure: (runId, journal) => {
      assertReadable()
      if (privacyRecord === undefined) return false
      enqueueTurnErasure(privacyRecord, deriveTurnErasures([{ turnId: runId, journal }])[0]!)
      wakeRemoteRetirement()
      return true
    },
    settled: async () => {
      commitDraft()
      // A collection subscriber runs before its transaction reaches the durable
      // queue. Drain accepted transactions too, including their committed views.
      while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites].map(transaction => transaction.isPersisted.promise))
      await collectionPersistence.settled()
    },
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      if (compactionTimer !== undefined) clearTimeout(compactionTimer)
      disposePromise = (async () => {
        await stopRemoteRetirement()
        page?.removeEventListener("pagehide", commitDraft)
        const draft = pendingDraft?.transaction
        commitDraft()
        // Release the writer only after all accepted commits have settled.
        await draft?.isPersisted.promise.catch(() => {})
        while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites].map(transaction => transaction.isPersisted.promise))
        try { await collectionPersistence.settled() } finally {
          try { await Promise.all(Object.values(views).map((view) => view.cleanup())) } finally {
            if (resolvedBackend.kind === "opfs") await resolvedBackend.close()
          }
        }
      })()
      return disposePromise
    }
  }
}
