/**
 * Hot backup, verified restore, and restore-time fencing for the durable
 * flows store.
 *
 * A backup captures the whole SQLite database — journal, run store, step
 * cache, engine state, and the out-of-ladder objects created by
 * `internal/EngineStateSchema.ts` — with `VACUUM INTO`, which reads one
 * consistent snapshot under WAL while writers stay live. The content-addressed
 * artifact blobs are copied beside it, digest-verified, after the database
 * snapshot: results reference artifacts only after publication
 * (`packages/smithers/flows/step-cache/docs/api.md`), so a blob walk taken after the
 * database snapshot is a superset of every digest the snapshot references.
 * A manifest written last records the digests a restore must verify, so a
 * partial backup is detectable by its missing manifest.
 *
 * Restore never lets a pre-backup owner resurrect. The fencing token here is
 * the `OwnerId` triple persisted on `flows_runs` — Temporal's shard `rangeID`
 * equality check reduced to one SQL predicate (`reference/temporal`
 * `service/history/shard/context_impl.go`, `renewRangeLocked`). Temporal
 * fences a restored shard by bumping the persisted epoch above anything a
 * surviving owner could hold; the equivalent bump for an identity fence is
 * {@link fence}: clear every persisted claim and owner in one serialized write
 * transaction, so every pre-backup `OwnerId` fails its equality
 * compare-and-swap (`FenceLost`, journal `fence_lost`) and the restored runs
 * are claimable immediately instead of after the heartbeat staleness cutoff.
 *
 * Host access arrives through Effect's `FileSystem` and `SqlClient` tags and
 * hashing through the injected `Crypto` service, so the module carries no
 * platform binding. The SQL dialect is SQLite — a non-SQLite backend fails
 * with the `sql` code rather than pretending to snapshot. Every file is
 * stat-checked before it is buffered for hashing or copying. The configurable
 * ceiling defaults to {@link defaultMaxFileSizeBytes}; an oversized file fails
 * with the typed `io` code instead of reaching the host's allocation limit.
 *
 * @since 0.1.0
 */

import * as ArtifactBackupLease from "@smthrs/artifacts/ArtifactBackupLease"
import { Sha256 } from "@smthrs/crypto"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as ArtifactRoots from "./internal/ArtifactRoots.ts"

/**
 * The database file name inside a backup directory and a restored store
 * directory.
 *
 * @since 0.1.0
 * @category constants
 */
export const databaseFileName = "store.sqlite3"

/**
 * The manifest file name inside a backup directory. It is written last, so
 * its presence marks a complete backup.
 *
 * @since 0.1.0
 * @category constants
 */
export const manifestFileName = "manifest.json"

/**
 * The artifact blob directory name inside a backup directory and a restored
 * store directory, laid out with the store's own two-hex-prefix fanout.
 *
 * @since 0.1.0
 * @category constants
 */
export const objectsDirectoryName = "objects"

/**
 * The marker file a restore writes into the target directory, recording when
 * the restore happened and which backup it came from.
 *
 * @since 0.1.0
 * @category constants
 */
export const restoredMarkerFileName = "restored.json"

/**
 * Default ceiling for one backup file read into memory: 512 MiB.
 *
 * @since 1.0.0
 * @category constants
 */
export const defaultMaxFileSizeBytes = 512 * 1024 * 1024

/**
 * One applied row of the shared `flows_migrations` table, recorded at backup
 * time and re-verified at fence time as the schema version of the snapshot.
 *
 * @since 0.1.0
 * @category schemas
 */
export const AppliedMigration = Schema.Struct({
  migrationId: Schema.Number,
  name: Schema.String
})

/**
 * One applied row of the shared `flows_migrations` table.
 *
 * @since 0.1.0
 * @category models
 */
export type AppliedMigration = typeof AppliedMigration.Type

/**
 * One captured artifact blob. `sizeBytes` is informational for operators; the
 * digest is the integrity check.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ArtifactEntry = Schema.Struct({
  digest: Sha256.Digest,
  sizeBytes: Schema.Number
})

/**
 * One captured artifact blob.
 *
 * @since 0.1.0
 * @category models
 */
export type ArtifactEntry = typeof ArtifactEntry.Type

/**
 * The verification contract of a backup: the database snapshot's digest and
 * schema version, and the digest of every captured artifact blob.
 *
 * @since 0.1.0
 * @category schemas
 */
export const BackupManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  createdAtMs: Schema.Number,
  database: Schema.Struct({
    file: Schema.Literal(databaseFileName),
    sha256: Sha256.Digest,
    sizeBytes: Schema.Number,
    migrations: Schema.Array(AppliedMigration)
  }),
  artifacts: Schema.Array(ArtifactEntry)
})

/**
 * The verification contract of a backup.
 *
 * @since 0.1.0
 * @category models
 */
export type BackupManifest = typeof BackupManifest.Type

/** JSON text carrying a decoded backup manifest. */
const ManifestFromJsonString = Schema.fromJsonString(BackupManifest)

/**
 * Stable failure codes surfaced by backup, verify, restore, and fence.
 * `invalid_options` reports a public option that cannot be admitted safely.
 *
 * @since 0.1.0
 * @category errors
 */
export const DisasterRecoveryErrorCode = Schema.Literals([
  "invalid_options",
  "not_empty",
  "invalid_manifest",
  "missing_file",
  "digest_mismatch",
  "artifact_corruption",
  "snapshot_incomplete",
  "schema_mismatch",
  "io",
  "sql"
])

/**
 * A stable disaster-recovery failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type DisasterRecoveryErrorCode = typeof DisasterRecoveryErrorCode.Type

/**
 * A normalized backup or restore failure. The identity string equals this
 * module's package path, per the house rule that a new identity is the
 * defining module path.
 *
 * @since 0.1.0
 * @category errors
 */
export class DisasterRecoveryError extends Schema.TaggedError<DisasterRecoveryError>()(
  "@smthrs/engine-store/DisasterRecoveryError",
  {
    code: DisasterRecoveryErrorCode,
    method: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown
  }
) {}

/**
 * Shared buffering limit for backup, verification, and restore operations.
 *
 * @since 1.0.0
 * @category models
 */
export interface FileSizeOptions {
  /**
   * Largest file, in bytes, that backup, verification, or restore may buffer.
   * The value must be a finite non-negative safe integer. Defaults to
   * {@link defaultMaxFileSizeBytes}.
   */
  readonly maxFileSizeBytes?: number | undefined
}

/**
 * Where a backup is written and which artifact store it captures.
 *
 * @since 0.1.0
 * @category models
 */
export interface BackupOptions<R = never, E = never> extends FileSizeOptions {
  /** The directory the backup is written into. Created when absent; must be empty when present. */
  readonly directory: string
  /**
   * The live store's content-addressed objects directory (the
   * `ArtifactStore.layerFileSystem` directory). When set, the whole capture
   * holds the cross-process artifact backup lease, so a concurrent
   * `ArtifactGc.gc` sweep cannot delete a blob between the database snapshot
   * and its copy. Absent means the composition has no filesystem artifact
   * tier: the backup carries no blobs and takes no lease, because there is
   * no objects directory to fence, and a frozen snapshot that references any
   * artifact digest fails with `snapshot_incomplete` instead of reporting
   * success. A filesystem-backed composition must therefore pass the same
   * directory it gives `ArtifactStore.layerFileSystem`.
   */
  readonly objectsDirectory?: string | undefined
  /**
   * Opens the frozen `VACUUM INTO` file so backup can enumerate artifact
   * roots and migrations from that exact snapshot, independently of the live
   * connection. The host should open this file without applying migrations.
   */
  readonly snapshotDatabaseLayer: (databaseFile: string) => Layer.Layer<SqlClient.SqlClient, E, R>
}

/**
 * Which backup to restore and where the restored store lands.
 *
 * @since 0.1.0
 * @category models
 */
export interface RestoreOptions extends FileSizeOptions {
  /** The directory a previous {@link backup} wrote. */
  readonly backupDirectory: string
  /** The fresh directory the restored store is written into. Created when absent; must be empty when present. */
  readonly targetDirectory: string
}

/**
 * Which backup to restore and how to open the freshly restored SQLite file
 * for restore-time fencing.
 *
 * @since 0.1.0
 * @category models
 */
export interface RestoreAndFenceOptions<R = never, E = never> extends RestoreOptions {
  /**
   * Builds the database and durable-writer layer for the newly restored file.
   * This keeps database opening as the caller's host composition rather than
   * importing a Node-only driver into this browser-safe module.
   */
  readonly databaseLayer: (databaseFile: string) => Layer.Layer<DurableWriter | SqlClient.SqlClient, E, R>
}

/**
 * The restored store's on-disk locations, ready to compose database and
 * artifact layers over.
 *
 * @since 0.1.0
 * @category models
 */
export interface RestoredStore {
  readonly databaseFile: string
  readonly objectsDirectory: string
  readonly manifest: BackupManifest
}

/**
 * A restored store after restore-time fencing has invalidated pre-backup
 * owners.
 *
 * @since 0.1.0
 * @category models
 */
export interface FencedRestoredStore extends RestoredStore {
  readonly fence: FenceSummary
}

/**
 * What {@link fence} invalidated on the restored store.
 *
 * @since 0.1.0
 * @category models
 */
export interface FenceSummary {
  /** Runs whose pending claim columns were cleared. */
  readonly clearedClaims: number
  /** Runs that were `running` at backup time, now suspended with their owner fence cleared. */
  readonly suspendedRuns: number
}

const error = (
  method: string,
  code: DisasterRecoveryErrorCode,
  message: string,
  cause: unknown
): DisasterRecoveryError =>
  new DisasterRecoveryError({
    code,
    method,
    message: `${code}: DisasterRecovery.${method}: ${message}`,
    cause
  })

/**
 * One mapper per failure family, shared across every call site so the
 * vocabulary stays uniform.
 */
const ioFailure = (method: string, subject: string) => (cause: unknown): DisasterRecoveryError =>
  error(method, "io", `the host filesystem refused ${subject}`, cause)

const sqlFailure = (method: string, subject: string) => (cause: unknown): DisasterRecoveryError =>
  error(method, "sql", `the database refused ${subject}`, cause)

/** Hashes bytes with the injected crypto service; a broken host is a defect. */
const measure = (bytes: Uint8Array): Effect.Effect<typeof Sha256.Digest.Type, never, Crypto.Crypto> =>
  Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)

/** Resolves and validates the shared whole-file buffering ceiling. */
const fileSizeLimit = (
  method: string,
  options: FileSizeOptions
): number | DisasterRecoveryError => {
  const limit = options.maxFileSizeBytes
  if (limit === undefined) return defaultMaxFileSizeBytes
  if (Number.isSafeInteger(limit) && limit >= 0) return limit
  return error(
    method,
    "invalid_options",
    `maxFileSizeBytes must be a finite non-negative safe integer; received ${String(limit)}`,
    limit
  )
}

/**
 * Refuses an oversized file before a whole-file read allocates its buffer.
 * Every caller admits `limit` through `fileSizeLimit`, so `BigInt` cannot
 * reject it.
 */
const checkFileSize = (
  fs: FileSystem.FileSystem,
  method: string,
  path: string,
  limit: number
): Effect.Effect<void, DisasterRecoveryError> =>
  Effect.gen(function*() {
    const info = yield* fs.stat(path).pipe(Effect.mapError(ioFailure(method, `stating ${path}`)))
    if (info.size <= BigInt(limit)) return
    const message = `${path} is ${info.size} bytes, which exceeds the ${limit}-byte file limit`
    return yield* Effect.fail(error(method, "io", message, new RangeError(message)))
  })

/**
 * Admits a target directory that does not exist yet — created recursively —
 * or exists empty. Anything else is refused rather than merged over.
 */
const ensureEmptyDirectory = (
  fs: FileSystem.FileSystem,
  method: string,
  directory: string
): Effect.Effect<void, DisasterRecoveryError> =>
  Effect.gen(function*() {
    const present = yield* fs.exists(directory).pipe(Effect.mapError(ioFailure(method, `probing ${directory}`)))
    if (!present) {
      return yield* fs.makeDirectory(directory, { recursive: true }).pipe(
        Effect.mapError(ioFailure(method, `creating ${directory}`))
      )
    }
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError(ioFailure(method, `listing ${directory}`))
    )
    if (entries.length > 0) {
      return yield* Effect.fail(
        error(method, "not_empty", `${directory} already holds ${entries.length} entries`, directory)
      )
    }
  })

/**
 * A relative blob path in the store's fanout layout: a two-hex directory
 * holding a 64-hex digest that begins with it. Anything else under the
 * objects directory — a scratch `.tmp-*` file, the fanout directory itself —
 * is not part of the store's address space.
 */
const blobEntry = (entry: string): string | undefined => {
  const match = entry.match(/^([0-9a-f]{2})[/\\]([0-9a-f]{64})$/)
  if (match === null || !match[2]!.startsWith(match[1]!)) return undefined
  return match[2]
}

const blobPath = (directory: string, digest: string): string => `${directory}/${digest.slice(0, 2)}/${digest}`

/** The applied rows of the shared migrations table, in ladder order. */
const appliedMigrations = (
  sql: SqlClient.SqlClient,
  method: string
): Effect.Effect<Array<AppliedMigration>, DisasterRecoveryError> =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM flows_migrations ORDER BY migration_id ASC
  `.withoutTransform.pipe(
    Effect.mapError(sqlFailure(method, "reading flows_migrations")),
    Effect.map((rows) => rows.map((row) => ({ migrationId: Number(row.migration_id), name: row.name })))
  )

interface SnapshotState {
  readonly migrations: Array<AppliedMigration>
  readonly artifactRoots: ReadonlySet<string>
}

/** Reads every artifact root from the frozen database, never the live one. */
const inspectSnapshot = (
  sql: SqlClient.SqlClient
): Effect.Effect<SnapshotState, DisasterRecoveryError> =>
  Effect.gen(function*() {
    const migrations = yield* appliedMigrations(sql, "backup")
    const cacheRows = yield* sql<{ readonly meta_json: string }>`
      SELECT meta_json FROM flows_step_cache
    `.withoutTransform.pipe(
      Effect.mapError(sqlFailure("backup", "reading artifact roots from snapshot step cache"))
    )
    const attemptRows = yield* sql<{
      readonly checkpoint_json: string | null
      readonly meta_json: string
    }>`
      SELECT checkpoint_json, meta_json FROM flows_attempts
    `.withoutTransform.pipe(
      Effect.mapError(sqlFailure("backup", "reading artifact roots from snapshot attempts"))
    )
    const artifactRoots = new Set<string>()
    const decodeFailure = (cause: ArtifactRoots.ArtifactRootDecodeError): DisasterRecoveryError =>
      error("backup", "snapshot_incomplete", cause.message, cause.cause)
    for (const row of cacheRows) {
      for (
        const digest of yield* ArtifactRoots.rootDigests("flows_step_cache", row.meta_json).pipe(
          Effect.mapError(decodeFailure)
        )
      ) artifactRoots.add(digest)
    }
    for (const row of attemptRows) {
      for (
        const digest of yield* ArtifactRoots.rootDigests("flows_attempts", row.meta_json).pipe(
          Effect.mapError(decodeFailure)
        )
      ) artifactRoots.add(digest)
      for (
        const digest of yield* ArtifactRoots.checkpointDigests(row.checkpoint_json).pipe(
          Effect.mapError(decodeFailure)
        )
      ) artifactRoots.add(digest)
    }
    return { migrations, artifactRoots }
  })

/** Reads and decodes the manifest a backup directory must carry. */
const readManifest = (
  fs: FileSystem.FileSystem,
  method: string,
  backupDirectory: string,
  maxFileSizeBytes: number
): Effect.Effect<BackupManifest, DisasterRecoveryError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const path = `${backupDirectory}/${manifestFileName}`
    const present = yield* fs.exists(path).pipe(Effect.mapError(ioFailure(method, `probing ${path}`)))
    if (!present) {
      return yield* Effect.fail(
        error(method, "missing_file", `${path} does not exist — the backup is incomplete or not a backup`, path)
      )
    }
    yield* checkFileSize(fs, method, path, maxFileSizeBytes)
    const text = yield* fs.readFileString(path).pipe(Effect.mapError(ioFailure(method, `reading ${path}`)))
    return yield* Schema.decodeUnknownEffect(ManifestFromJsonString)(text).pipe(
      Effect.mapError((cause) =>
        error(method, "invalid_manifest", `${path} does not decode as a backup manifest`, cause)
      )
    )
  })

/** Reads a backup file and refuses bytes that no longer hash to the manifest. */
const checkedFile = (
  fs: FileSystem.FileSystem,
  method: string,
  path: string,
  expected: string,
  maxFileSizeBytes: number
): Effect.Effect<Uint8Array, DisasterRecoveryError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const present = yield* fs.exists(path).pipe(Effect.mapError(ioFailure(method, `probing ${path}`)))
    if (!present) {
      return yield* Effect.fail(error(method, "missing_file", `${path} does not exist`, path))
    }
    yield* checkFileSize(fs, method, path, maxFileSizeBytes)
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError(ioFailure(method, `reading ${path}`)))
    const measured = yield* measure(bytes)
    if (measured !== expected) {
      return yield* Effect.fail(
        error(method, "digest_mismatch", `${path} hashes to ${measured}, the manifest records ${expected}`, path)
      )
    }
    return bytes
  })

/**
 * Captures a hot backup of the live store into an empty directory.
 *
 * The database is snapshotted first with `VACUUM INTO` — a read transaction
 * under WAL, so live writers are never blocked and the copy is one consistent
 * point in time. The artifact walk runs after it, so every digest the
 * snapshot references is captured (publication precedes reference). Blobs are
 * digest-verified as they are copied; a blob whose bytes no longer hash to
 * its address fails the backup loudly rather than capturing corruption. The
 * manifest is encoded and admitted under the same file-size ceiling before it
 * is written last, so a successful backup remains readable with its own
 * options.
 *
 * With an `objectsDirectory`, the whole capture holds the artifact backup
 * lease, so concurrent sweep deletion cannot remove a referenced blob
 * mid-copy. Without one, no lease is taken; the frozen-root verification
 * still fails the backup loudly when the snapshot references any blob, so an
 * unfenced capture can never report success while missing artifact bytes.
 *
 * @since 0.1.0
 * @category operations
 */
export const backup = <R = never, E = never>(
  options: BackupOptions<R, E>
): Effect.Effect<
  BackupManifest,
  DisasterRecoveryError | E,
  SqlClient.SqlClient | FileSystem.FileSystem | Crypto.Crypto | R
> =>
  Effect.gen(function*() {
    const limit = fileSizeLimit("backup", options)
    if (typeof limit !== "number") return yield* Effect.fail(limit)
    const maxFileSizeBytes = limit
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const fs = yield* FileSystem.FileSystem
    const createdAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    yield* ensureEmptyDirectory(fs, "backup", options.directory)

    const capture = Effect.gen(function*() {
      const databasePath = `${options.directory}/${databaseFileName}`
      yield* sql`VACUUM INTO ${databasePath}`.pipe(
        Effect.mapError(sqlFailure("backup", `snapshotting the database into ${databasePath}`))
      )
      const snapshot = yield* Effect.flatMap(
        Effect.service(SqlClient.SqlClient),
        inspectSnapshot
      ).pipe(Effect.provide(options.snapshotDatabaseLayer(databasePath)))
      // Opening the frozen file may normalize SQLite journal metadata, so its
      // manifest digest is measured only after the inspection connection closes.
      yield* checkFileSize(fs, "backup", databasePath, maxFileSizeBytes)
      const databaseBytes = yield* fs.readFile(databasePath).pipe(
        Effect.mapError(ioFailure("backup", `reading ${databasePath} back`))
      )
      const sha256 = yield* measure(databaseBytes)

      const artifacts: Array<ArtifactEntry> = []
      const captured = new Set<string>()
      if (options.objectsDirectory !== undefined) {
        const objectsDirectory = options.objectsDirectory
        const entries = yield* fs.readDirectory(objectsDirectory, { recursive: true }).pipe(
          Effect.mapError(ioFailure("backup", `listing ${objectsDirectory}`))
        )
        for (const entry of [...entries].sort()) {
          const digest = blobEntry(entry)
          if (digest === undefined) continue
          const source = blobPath(objectsDirectory, digest)
          yield* checkFileSize(fs, "backup", source, maxFileSizeBytes)
          const bytes = yield* fs.readFile(source).pipe(
            Effect.mapError(ioFailure("backup", `reading ${source}`))
          )
          const measured = yield* measure(bytes)
          if (measured !== digest) {
            return yield* Effect.fail(
              error(
                "backup",
                "artifact_corruption",
                `${source} hashes to ${measured}; repair the store before backing it up`,
                source
              )
            )
          }
          const target = blobPath(`${options.directory}/${objectsDirectoryName}`, digest)
          yield* fs.makeDirectory(`${options.directory}/${objectsDirectoryName}/${digest.slice(0, 2)}`, {
            recursive: true
          }).pipe(Effect.mapError(ioFailure("backup", `creating the objects directory for ${digest}`)))
          yield* fs.writeFile(target, bytes).pipe(Effect.mapError(ioFailure("backup", `writing ${target}`)))
          artifacts.push({ digest: measured, sizeBytes: bytes.length })
          captured.add(measured)
        }
      }

      const missing = [...snapshot.artifactRoots].filter((digest) => !captured.has(digest)).sort()
      if (missing.length > 0) {
        return yield* Effect.fail(
          error(
            "backup",
            "snapshot_incomplete",
            `the frozen database references ${missing.length} artifact blobs absent from the backup`,
            { missing }
          )
        )
      }

      const manifest: BackupManifest = {
        formatVersion: 1,
        createdAtMs,
        database: {
          file: databaseFileName,
          sha256,
          sizeBytes: databaseBytes.length,
          migrations: snapshot.migrations
        },
        artifacts
      }
      const manifestPath = `${options.directory}/${manifestFileName}`
      const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
      if (manifestBytes.byteLength > maxFileSizeBytes) {
        const message =
          `${manifestPath} is ${manifestBytes.byteLength} bytes, which exceeds the ${maxFileSizeBytes}-byte file limit`
        return yield* Effect.fail(error("backup", "io", message, new RangeError(message)))
      }
      yield* fs.writeFile(manifestPath, manifestBytes).pipe(
        Effect.mapError(ioFailure("backup", `writing ${manifestFileName}`))
      )
      return manifest
    })

    // The directory was empty when the capture began, so everything in it is
    // this capture's: the snapshot, any SQLite sidecar the inspection
    // connection left, and the copied blobs. A failed capture removes them and
    // leaves the directory reusable for a retry. Cleanup is best effort; the
    // original failure is the one reported.
    const discardPartial = fs.readDirectory(options.directory).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          (entry) => fs.remove(`${options.directory}/${entry}`, { recursive: true, force: true }),
          { discard: true }
        )
      ),
      Effect.ignore
    )

    return yield* (options.objectsDirectory === undefined
      ? capture
      : ArtifactBackupLease.withLease(
        fs,
        options.objectsDirectory,
        capture,
        ioFailure("backup", `coordinating artifact backup in ${options.objectsDirectory}`)
      )).pipe(Effect.onError(() => discardPartial))
  }).pipe(Effect.withSpan("DisasterRecovery.backup"))

/**
 * Verifies a backup directory against its manifest without restoring it:
 * the manifest decodes, the database snapshot hashes to its recorded digest,
 * and every listed artifact blob is present and hashes to its address.
 *
 * @since 0.1.0
 * @category operations
 */
export const verify = Effect.fn("DisasterRecovery.verify")(function*(
  backupDirectory: string,
  options: FileSizeOptions = {}
) {
  const limit = fileSizeLimit("verify", options)
  if (typeof limit !== "number") return yield* Effect.fail(limit)
  const maxFileSizeBytes = limit
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* readManifest(fs, "verify", backupDirectory, maxFileSizeBytes)
  yield* checkedFile(
    fs,
    "verify",
    `${backupDirectory}/${manifest.database.file}`,
    manifest.database.sha256,
    maxFileSizeBytes
  )
  for (const entry of manifest.artifacts) {
    yield* checkedFile(
      fs,
      "verify",
      blobPath(`${backupDirectory}/${objectsDirectoryName}`, entry.digest),
      entry.digest,
      maxFileSizeBytes
    )
  }
  return manifest
})

/**
 * Restores a verified backup into an empty target directory.
 *
 * Every byte is re-verified against the manifest as it is copied, so a backup
 * that rotted in storage is refused rather than restored. The target holds
 * the database file, the objects directory, and a `restored.json` marker; it
 * is a fresh store directory to compose `NodeDatabase.layer` and
 * `ArtifactStore.layerFileSystem` over. The database is restored with the
 * pre-backup owner fences still in place — run {@link fence} against it
 * before any engine adopts it.
 *
 * @since 0.1.0
 * @category operations
 */
export const restore = Effect.fn("DisasterRecovery.restore")(function*(options: RestoreOptions) {
  const limit = fileSizeLimit("restore", options)
  if (typeof limit !== "number") return yield* Effect.fail(limit)
  const maxFileSizeBytes = limit
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* readManifest(fs, "restore", options.backupDirectory, maxFileSizeBytes)
  yield* ensureEmptyDirectory(fs, "restore", options.targetDirectory)

  const databaseBytes = yield* checkedFile(
    fs,
    "restore",
    `${options.backupDirectory}/${manifest.database.file}`,
    manifest.database.sha256,
    maxFileSizeBytes
  )
  const databaseFile = `${options.targetDirectory}/${databaseFileName}`
  yield* fs.writeFile(databaseFile, databaseBytes).pipe(
    Effect.mapError(ioFailure("restore", `writing ${databaseFile}`))
  )

  const objectsDirectory = `${options.targetDirectory}/${objectsDirectoryName}`
  for (const entry of manifest.artifacts) {
    const bytes = yield* checkedFile(
      fs,
      "restore",
      blobPath(`${options.backupDirectory}/${objectsDirectoryName}`, entry.digest),
      entry.digest,
      maxFileSizeBytes
    )
    yield* fs.makeDirectory(`${objectsDirectory}/${entry.digest.slice(0, 2)}`, { recursive: true }).pipe(
      Effect.mapError(ioFailure("restore", `creating the objects directory for ${entry.digest}`))
    )
    yield* fs.writeFile(blobPath(objectsDirectory, entry.digest), bytes).pipe(
      Effect.mapError(ioFailure("restore", `writing the blob for ${entry.digest}`))
    )
  }

  const restoredAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
  const marker = {
    formatVersion: 1,
    restoredAtMs,
    backupCreatedAtMs: manifest.createdAtMs,
    databaseSha256: manifest.database.sha256
  }
  yield* fs.writeFileString(
    `${options.targetDirectory}/${restoredMarkerFileName}`,
    `${JSON.stringify(marker, null, 2)}\n`
  ).pipe(Effect.mapError(ioFailure("restore", `writing ${restoredMarkerFileName}`)))
  return { databaseFile, objectsDirectory, manifest } satisfies RestoredStore
})

/**
 * Bumps the restored store's fencing epoch so pre-backup owners are fenced
 * out.
 *
 * The store's fence is `OwnerId` equality, so the epoch bump is fence
 * invalidation: in one serialized write transaction every pending claim is
 * cleared and every run that was `running` at backup time is suspended with
 * its owner and heartbeat cleared. A surviving pre-backup owner then fails
 * every fenced operation against the restored store — `heartbeat` and
 * `transitionOwned` report `FenceLost`, fenced journal appends fail
 * `fence_lost` — exactly as a stale Temporal owner fails its `rangeID`
 * compare-and-swap. The suspended runs are claimable immediately, without
 * waiting out the heartbeat staleness cutoff and without liveness evidence.
 *
 * Every migration recorded in the manifest must remain applied with the same
 * ID and namespaced name. Forward additions within any installed block are
 * compatible, including engine-store `3006` below an existing plan `4003`;
 * the current database layer applies them on open. A missing or renamed
 * historical entry fails `schema_mismatch` before ownership is cleared.
 *
 * In-flight attempt rows are deliberately untouched: attempt writes are
 * fenced on the run row's ownership, and the resuming engine adopts or
 * retries them under its own fresh owner.
 *
 * @since 0.1.0
 * @category operations
 */
export const fence = Effect.fn("DisasterRecovery.fence")(function*(manifest: BackupManifest) {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  const applied = yield* appliedMigrations(sql, "fence")
  const expected = manifest.database.migrations
  const key = (migration: AppliedMigration): string => `${migration.migrationId}:${migration.name}`
  // IDs identify migrations within their reserved blocks. Compare historical
  // identities independently so additions in lower blocks cannot shift them.
  const appliedById = new Map(applied.map((migration) => [migration.migrationId, migration.name]))
  if (expected.some((migration) => appliedById.get(migration.migrationId) !== migration.name)) {
    return yield* Effect.fail(
      error(
        "fence",
        "schema_mismatch",
        `the restored database applied [${applied.map(key).join(", ")}] but the manifest records [${
          expected.map(key).join(", ")
        }]`,
        { applied, expected }
      )
    )
  }
  return yield* writer.write(
    Effect.gen(function*() {
      const claims = yield* sql<{ readonly run_id: string }>`
        UPDATE flows_runs
        SET
          claim_host_id = NULL,
          claim_pid = NULL,
          claim_nonce = NULL,
          claimed_at_ms = NULL
        WHERE claim_host_id IS NOT NULL
        RETURNING run_id
      `.withoutTransform
      const running = yield* sql<{ readonly run_id: string }>`
        UPDATE flows_runs
        SET
          status = 'suspended',
          owner_host_id = NULL,
          owner_pid = NULL,
          owner_nonce = NULL,
          heartbeat_at_ms = NULL,
          waiting_reason = 'released',
          waiting_wake_at_ms = NULL,
          waiting_token = NULL
        WHERE status = 'running'
        RETURNING run_id
      `.withoutTransform
      return { clearedClaims: claims.length, suspendedRuns: running.length } satisfies FenceSummary
    })
  ).pipe(Effect.mapError(sqlFailure("fence", "invalidating the persisted fences")))
})

/**
 * Restores a backup and immediately fences the restored database.
 *
 * This is the one-shot operator API for disaster recovery. The database
 * driver itself still arrives through a caller-supplied Layer so this module
 * remains host-neutral and browser-bundleable; the bundled Node script passes
 * `NodeDatabase.layer` for the restored file.
 *
 * @since 0.1.0
 * @category operations
 */
export const restoreAndFence = <R = never, E = never>(
  options: RestoreAndFenceOptions<R, E>
): Effect.Effect<FencedRestoredStore, DisasterRecoveryError | E, FileSystem.FileSystem | Crypto.Crypto | R> =>
  Effect.gen(function*() {
    const restored = yield* restore(options)
    const summary = yield* fence(restored.manifest).pipe(
      Effect.provide(options.databaseLayer(restored.databaseFile))
    )
    return { ...restored, fence: summary } satisfies FencedRestoredStore
  })
