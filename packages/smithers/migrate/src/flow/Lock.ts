/**
 * One apply owner per canonical project, independent of the report layout.
 *
 * SQLite's transaction lock is the authority. Its file is permanent: unlinking
 * it would let two processes lock different inodes at the same path. The JSON
 * record carries diagnostics and the recovery directory, published atomically
 * while the transaction is held. A crash releases the operating-system lock
 * even if it happens before that record is written, and only the next
 * transaction owner may reclaim it.
 *
 * @see https://www.sqlite.org/lockingv3.html
 * @since 1.0.0-rc.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import * as Fs from "../internal/Fs.ts"
import { io, make, type MigrateError } from "../MigrateError.ts"
import * as Pending from "./internal/Pending.ts"
import * as Options from "./Options.ts"

/**
 * Ownership diagnostics and the recovery directory. Older pre-release records
 * may lack the token and report directory; neither an old pid nor a partial record decides
 * whether the operating-system lock is held.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Record = Schema.Struct({
  pid: Schema.Number,
  startedAt: Schema.String,
  root: Schema.String,
  token: Schema.optional(Schema.String),
  reportDir: Schema.optional(Schema.String)
})

/**
 * Who holds the lock.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Record = typeof Record.Type

/**
 * A lock this process holds. Release requires this exact acquired handle;
 * reconstructing a record cannot release another owner's transaction.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Held {
  readonly file: string
  readonly record: Record
  /** The abandoned diagnostic record, for the next run's recovery report. */
  readonly reclaimed: Record | undefined
}

/** A live connection, kept private so callers cannot release its transaction. */
interface Lease {
  readonly database: DatabaseSync
  readonly file: string
  readonly token: string
  readonly reportDirectory: string
}
const leases = new WeakMap<Held, Lease>()

/**
 * The fixed project lock record. `reportDir` is retained for source
 * compatibility; choosing another report directory never creates another lock.
 * `acquire` resolves the project root before calling this path helper.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const file = (path: Path.Path, root: string, _reportDir?: string): string =>
  path.join(root, Options.defaultReportDir, "apply.lock")

const refusal = (target: string, held: Record | undefined): MigrateError =>
  make(
    "apply-in-progress",
    `another apply run already holds ${target}${
      held === undefined ? " (owner record is being initialized)" : ` (pid ${held.pid}, started ${held.startedAt})`
    }`,
    "wait for that run to finish; the operating system releases its lock if the process exits"
  )

/** A missing or incomplete record never grants permission to enter. */
const readRecord = (text: string): Record | undefined => {
  try {
    return Schema.decodeUnknownSync(Record)(JSON.parse(text))
  } catch {
    return undefined
  }
}

const read = (target: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* Fs.optionalNotFound(fs.readFileString(target)).pipe(
      Effect.mapError(io(`could not read the apply lock ${target}`))
    )
    return Option.isNone(text) ? undefined : readRecord(text.value)
  })

/** SQLite extended result codes retain BUSY (5) / LOCKED (6) in the low byte. */
const busy = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null || !("errcode" in cause)) return false
  const code = cause.errcode
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6)
}

/** Closing the connection rolls back the held transaction and releases its locks. */
const close = (database: DatabaseSync): Effect.Effect<void> => Effect.try(() => database.close()).pipe(Effect.ignore)

/**
 * Takes the canonical project's apply lock without waiting for another owner.
 *
 * A reserved SQLite writer lock is exclusive across connections and processes.
 * No database rows are needed: the transaction stays open until release, and
 * the guard file is never removed. A contender can read diagnostic metadata,
 * but only the transaction winner can change it. There is no read/unlink/retry
 * takeover window and no timeout that can mistake a paused owner for a crash.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const acquire = (options: {
  readonly root: string
  readonly reportDir: string
}): Effect.Effect<Held, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.realPath(options.root).pipe(Effect.mapError(io(`could not resolve ${options.root}`)))
    const target = file(path, root)
    const directory = path.dirname(target)
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(io(`could not create ${directory}`))
    )
    // A symlinked root is supported, but lock state must stay at its fixed
    // location inside that root, where layout and rollback exclude it.
    const realDirectory = yield* fs.realPath(directory).pipe(Effect.mapError(io(`could not resolve ${directory}`)))
    if (realDirectory !== directory) {
      return yield* Effect.fail(make("invalid-layout", `the apply lock directory must not be a symlink: ${directory}`))
    }
    const database = yield* Effect.try({
      try: () => {
        const connection = new DatabaseSync(`${target}.sqlite`)
        try {
          connection.exec("BEGIN IMMEDIATE")
          return connection
        } catch (cause) {
          connection.close()
          throw cause
        }
      },
      catch: (cause) => cause
    }).pipe(Effect.catch((cause) =>
      busy(cause)
        ? Effect.flatMap(read(target), (held) => Effect.fail(refusal(target, held)))
        : Effect.fail(io(`could not take the apply lock ${target}`)(cause))
    ))
    return yield* Effect.gen(function*() {
      const reclaimed = yield* read(target)
      // Check under the authority transaction, before changing the owner
      // pointer. A crash/retry must retain the directory with the original
      // checkpoint, even when the next invocation chooses another layout.
      const reports = new Set([
        options.reportDir,
        reclaimed?.reportDir ?? Options.defaultReportDir,
        Options.defaultReportDir
      ])
      for (const report of reports) {
        const invalid = Options.relativePathIssue("reportDir", report)
        if (invalid !== undefined) {
          return yield* Effect.fail(make("invalid-layout", `cannot inspect migration recovery state: ${invalid}`))
        }
        yield* Pending.assertClear(path.join(root, report))
      }
      const token = randomUUID()
      const record: Record = Object.freeze({
        pid: process.pid,
        startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        root,
        token,
        reportDir: options.reportDir
      })
      yield* Fs.writeAtomic(target, `${JSON.stringify(record, null, 2)}\n`).pipe(
        Effect.mapError(io(`could not record the apply lock ${target}`))
      )
      const held: Held = Object.freeze({ file: target, record, reclaimed })
      leases.set(held, { database, file: target, token, reportDirectory: path.join(root, options.reportDir) })
      return held
    }).pipe(Effect.onError(() => close(database)))
  }).pipe(Effect.uninterruptible)

/**
 * Removes this handle's diagnostic record while its transaction is still
 * held, then closes the connection. Repeated or reconstructed releases are
 * no-ops. A changed record, or one pointing to an unresolved checkpoint, is
 * preserved; the permanent guard file is never
 * unlinked. Cleanup failures cannot mask the migration's own result.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const release = (
  held: Held
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.suspend(() => {
    const lease = leases.get(held)
    if (lease === undefined) return Effect.void
    leases.delete(held)
    return Effect.gen(function*() {
      // If the unit failed before settling its checkpoint, retain the owner
      // record as the durable pointer to its report directory. A later apply
      // must recover there even when it selects a different report layout.
      yield* Pending.assertClear(lease.reportDirectory)
      const current = yield* read(lease.file)
      if (current?.token !== lease.token) return
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(lease.file, { force: true })
    }).pipe(Effect.ensuring(close(lease.database)), Effect.ignore)
  }).pipe(Effect.uninterruptible)
