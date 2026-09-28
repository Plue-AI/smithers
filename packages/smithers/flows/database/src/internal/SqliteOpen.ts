/** Shared SQLite schema guard and bounded startup retries for native drivers.
 * @since 1.0.0
 */

import { Cause, Context, Duration, Effect, Exit, Layer, Schedule, Schema, Scope } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlConnection from "effect/unstable/sql/SqlConnection"
import { closeSync, openSync } from "node:fs"
import * as ReleasePolicy from "./ReleasePolicy.ts"

/**
 * The driver's own reader for the tables of a file, without joining the WAL
 * or converting it.
 *
 * SQLite `file:` URIs bypass the filesystem stat because the URI itself is not
 * a pathname; the driver receives it directly. Returns `undefined` when the
 * file cannot be inspected at all: a path that does not exist, a directory, an
 * in-memory name, or a file SQLite refuses to read. None of those is a 0.x
 * database, so the driver's own open behavior decides what happens next and
 * the guard says nothing.
 *
 * A file a peer holds locked is not one of those cases and is rethrown, so
 * `guardOpen` outwaits the lock on the same ladder the open uses. Answering
 * `undefined` there would wave the file through: the open ladder outwaits the
 * same peer, so a 0.x `smithers.db` whose 0.x writer held it for a moment
 * would be opened and migrated, which is the refusal the release policy
 * states without condition.
 */
type InspectTables = (filename: string) => ReadonlyArray<string> | undefined

/**
 * Creates a plain-path database before SQLite does, so WAL and SHM sidecars
 * inherit restrictive permissions from the main file on every native driver.
 * Exclusive creation preserves existing files, including a file another opener
 * just created, and never follows a planted symlink. SQLite retains ownership
 * of URI, memory and temporary opens, and of any open whose driver settings
 * forbid creation (`create` is false).
 *
 * @since 1.0.0
 * @category constructors
 */
export const createDatabaseFile = (filename: string, create: boolean, mode = 0o600): void => {
  if (!create || filename === "" || filename === ":memory:" || filename.startsWith("file:")) return
  let descriptor: number
  try {
    descriptor = openSync(filename, "wx", mode)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return
    throw error
  }
  closeSync(descriptor)
}

/**
 * The three stable codes covering the rc.0 exclusions this driver enforces.
 *
 * `unsupported_runtime` reports selection of an incompatible driver.
 * `unsupported_database_file` refuses a 0.x `smithers.db`, and
 * `database_locked` refuses a file the guard could not read because a peer
 * held it for longer than the open ladder waits.
 *
 * @category models
 * @since 1.0.0
 */
export const UnsupportedDatabaseCode = Schema.Literals([
  "unsupported_runtime",
  "unsupported_database_file",
  "database_locked"
])

/**
 * Stable code for an rc.0 refusal to open a durable database.
 *
 * @category models
 * @since 1.0.0
 */
export type UnsupportedDatabaseCode = typeof UnsupportedDatabaseCode.Type

/**
 * Refusal to open a durable database in rc.0.
 *
 * Raised as a *defect* by `layer`, not as a typed failure, for the same
 * reason a non-lock open failure is a defect: `layer` is a leaf client layer
 * whose error channel every durable package composes against as `never`, and
 * neither refusal is recoverable at run time. Both are operator mistakes
 * fixed by pointing the runtime somewhere else or selecting the matching host driver. The
 * value carried by the defect is still typed and matchable with
 * `isUnsupportedDatabase`.
 *
 * @category errors
 * @since 1.0.0
 */
export class UnsupportedDatabase extends Schema.TaggedError<UnsupportedDatabase>()(
  "@smthrs/database/UnsupportedDatabase",
  {
    code: UnsupportedDatabaseCode,
    message: Schema.String
  }
) {}

/**
 * Narrows an unknown defect to this driver's refusal.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isUnsupportedDatabase = (input: unknown): input is UnsupportedDatabase =>
  input instanceof UnsupportedDatabase

/**
 * The ledger table every flows migration set records its progress in
 * (`Migrations.table`). Its absence from a database that already has tables
 * is what separates a 0.x `smithers.db` from a Smithers 1.0 file. Repeated
 * here rather than imported so the guard stays free of the migration module.
 */
const migrationLedgerTable = "flows_migrations"

/**
 * The whole transient vocabulary of an open: the two texts SQLite raises for a
 * file a peer holds.
 *
 * Deliberately narrower than `WriteRetry`'s classification, and not shared
 * with it. A failure here is a raw throw from the driver's constructor, so it
 * carries no `SqlError` and no `code` to key off, and the Postgres SQLSTATEs
 * and the rollback text that policy also replays cannot come out of opening a
 * SQLite file. Every native driver's table probe rethrows on this same
 * predicate, so the probe and the ladder give up on a peer together.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isLockedError = (error: unknown): boolean => {
  const text = String(error)
  return text.includes("database is locked") || text.includes("database is busy")
}

/**
 * A defect SQLite raised because a peer holds the file, and not one this driver
 * raised about the file itself.
 *
 * Reading the text is the only test a raw driver throw allows, and the text
 * carries a path the caller chose: a 0.x database at
 * `.../database is locked.db` makes this driver's own refusal read as a lock.
 * Excluding the refusal keeps the ladder from retrying a decision the guard has
 * already made, and keeps the code it reports the code the guard chose.
 */
const isLockedDefect = (defect: unknown): boolean => !isUnsupportedDatabase(defect) && isLockedError(defect)

/**
 * The database a SQLite `file:` URI names, without the query that says how to
 * open it.
 *
 * The probe opens read-only, and SQLite refuses that outright when the URI
 * itself asks for write access: `file:/path/smithers.db?mode=rw` fails with
 * `access mode not allowed: rw` before a single table is read. Reporting
 * "cannot inspect" there would wave a 0.x database straight through, because
 * the client that follows opens read-write and succeeds — the exact bypass of
 * the refusal the release policy states without condition. Query parameters
 * only tell SQLite how to open the file, never which tables it holds, so the
 * probe drops them (and the fragment SQLite ignores) and asks its one question
 * about the file itself.
 * @since 1.0.0
 * @category layers
 */
export const probeTarget = (filename: string): string => {
  if (!filename.startsWith("file:")) return filename
  const query = filename.search(/[?#]/)
  return query === -1 ? filename : filename.slice(0, query)
}

/**
 * Returns whether a file URI names a pure in-memory SQLite database.
 *
 * SQLite honors the LAST `mode` parameter when the query repeats it, so only a
 * URI whose final mode is `memory` qualifies: `?mode=memory&mode=rw` opens the
 * on-disk file read-write, and skipping the probe for it would reopen the
 * mode=rw bypass the guard closed.
 */
const isMemoryModeUri = (filename: string): boolean => {
  if (!filename.startsWith("file:")) return false
  const target = filename.split("#", 1)[0]!
  const query = target.indexOf("?")
  if (query === -1) return false
  const modes = new URLSearchParams(target.slice(query + 1)).getAll("mode")
  return modes[modes.length - 1] === "memory"
}

/**
 * Refuses the open when rc.0 does not support it, and says nothing otherwise.
 */
const unsupportedOpen = (filename: string, readTableNames: InspectTables): UnsupportedDatabase | undefined => {
  if (isMemoryModeUri(filename)) return undefined
  const tables = readTableNames(probeTarget(filename))
  if (tables === undefined || tables.length === 0) return undefined
  if (tables.includes(migrationLedgerTable)) return undefined
  return new UnsupportedDatabase({
    code: "unsupported_database_file",
    message:
      `${filename} is not a Smithers 1.0 database (${ReleasePolicy.releaseVersion} does not load a 0.x smithers.db)`
  })
}

/**
 * Names the one defect the guard's ladder can end on that is not already a
 * refusal: a peer held the file for longer than the ladder waits, so rc.0
 * never learned whether it was a 0.x database.
 *
 * It is refused rather than passed on. The open ladder waits the same peer out
 * on the same schedule, so handing SQLite's raw lock error to the caller would
 * report a database rc.0 declined to open as a transient driver failure, and
 * `isUnsupportedDatabase` would answer `false` about a refusal this driver made.
 * That refinement is the one narrowing every caller matches on.
 */
const guardDefect = (filename: string) => (defect: unknown): unknown =>
  isLockedDefect(defect)
    ? new UnsupportedDatabase({
      code: "database_locked",
      message: `${filename} could not be inspected because another process holds it`
    })
    : defect

/**
 * The rc.0 open guard, evaluated once per layer build.
 *
 * A `smithers.db` opened through this ladder would gain `flows_*` tables
 * beside its `_smithers_*` ones and silently mix two schemas. Refuse that
 * before opening the writable client, on every native runtime.
 */
const guardOpen = (filename: string, readTableNames: InspectTables): Effect.Effect<void> =>
  retryWhileLocked(Effect.suspend(() => {
    const refusal = unsupportedOpen(filename, readTableNames)
    return refusal === undefined ? Effect.void : Effect.die(refusal)
  })).pipe(Effect.catchDefect((defect) => Effect.die(guardDefect(filename)(defect))))

/** Bounds how long a connection keeps retrying a peer that holds the database. */
const openAttempts = 40
const openBaseDelayMs = 5
const openMaxDelayMs = 250

/** Carries an open-time defect through a retry as a typed failure. */
interface OpenFailure {
  readonly defect: unknown
}

/**
 * Deliberately not an option. Unlike the write-retry policy — which callers
 * tune through `WriteRetryOptions` — this ladder bounds a driver-internal
 * race during layer construction, before any service exists to configure. Its
 * bounds are dictated by SQLite's WAL conversion behavior described below,
 * not by workload, so a caller has nothing to say about them.
 */
const openSchedule = Schedule.exponential(Duration.millis(openBaseDelayMs)).pipe(
  // Jitter before the cap, as `WriteRetry` does, so `openMaxDelayMs` bounds
  // the delay that is actually slept.
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.millis(Math.min(openMaxDelayMs, Duration.toMillis(duration))))
  ),
  Schedule.upTo({ times: openAttempts - 1 })
)

/**
 * Retries `self` on the fixed ladder while SQLite reports the file as locked,
 * then re-raises the original defect unchanged.
 *
 * One ladder serves the guard's probe and the open itself, so the guard is
 * never the first to give up on a peer the open would have waited out.
 */
const retryWhileLocked = <A>(self: Effect.Effect<A>): Effect.Effect<A> =>
  self.pipe(
    Effect.catchDefect((defect) => Effect.fail<OpenFailure>({ defect })),
    Effect.retry({ schedule: openSchedule, while: (error) => isLockedDefect(error.defect) }),
    Effect.catch((error) => Effect.die(error.defect))
  )

/**
 * Retries opening a connection while SQLite reports the database as locked.
 *
 * `SqliteClient` opens the file, sets `PRAGMA busy_timeout`, and then issues
 * `PRAGMA journal_mode = WAL` inside its constructor. Two processes opening one
 * file concurrently collide there in two distinct ways, and neither is
 * reachable by `WriteRetry` — the failure is a raw throw during layer
 * construction, so it arrives as a *defect* rather than as the `SqlError` the
 * retry policy classifies:
 *
 * - `SQLITE_BUSY` on the conversion itself. SQLite moves a database into or out
 *   of WAL only with the file to itself, and a peer connection holding a lock
 *   defeats that. The mode change does consult the busy handler — measured on
 *   node:sqlite against a peer holding a shared read lock, it waits the whole
 *   `busy_timeout` and then reports `database is locked` — so the client's
 *   timeout sets the pace of a contended attempt, and a lock that outlasts it
 *   still fails.
 * - `SQLITE_BUSY_RECOVERY` when opening a WAL database whose log needs
 *   recovery while a peer is already recovering it.
 *
 * Both clear on their own as soon as the peer finishes, so the open is retried
 * on the vocabulary `isLockedError` names, and on nothing else. This is what
 * made `DurableWaitingRestart` flake: a child process lost the race and died
 * during startup. Because a contended attempt can spend up to the client's
 * `busy_timeout` inside SQLite before the ladder's own delay, the wall-clock
 * cost of exhausting the ladder is bounded by the timeout the caller
 * configured, not by the delays below. Each attempt builds into its own scope,
 * which this closes on failure, so a failed open leaves no connection behind. A
 * defect that is not a lock is re-raised unchanged on the first attempt.
 */
const retryLockedOpen = <A>(self: Layer.Layer<A>): Layer.Layer<A> =>
  Layer.fromBuild((_memoMap, scope) =>
    retryWhileLocked(Effect.suspend(() => {
      // Exactly what `Layer.fromBuild` does with a build that fails, done once
      // per attempt. `Layer.fromBuild` cannot do it here: the retry lives
      // INSIDE one build, so nothing above this closes anything until every
      // attempt has been spent. Without the per-attempt fork, a failed attempt
      // that registered a connection finalizer registers it in a scope that
      // survives, and the connection it holds is one more peer for the next
      // attempt to lose to.
      const attempt = Scope.forkUnsafe(scope)
      return Effect.onExit(
        // A fresh memo map per attempt: reusing the caller's would hand every
        // retry the first attempt's memoized (failed) build instead of opening
        // again. `self` is a leaf client layer, so there is nothing to share.
        Effect.flatMap(Layer.makeMemoMap, (memoMap) => Layer.buildWithMemoMap(self, memoMap, attempt)),
        (exit) => exit._tag === "Failure" ? Scope.close(attempt, exit) : Effect.void
      )
    }))
  )

// Effect rc.112 releases its transaction reservation when COMMIT fails,
// without rolling back. Supply the same SQLite transaction commands with a
// commit finalizer that recovers BEFORE releasing that reservation. Only this
// driver layer owns the database lifetime, so it can discard the connection if
// rollback itself fails. Keep upstream's nesting, serialization and tracing.
const recoverFailedCommit = <A>(
  self: Layer.Layer<SqlClient.SqlClient | A>,
  spanAttributes: Readonly<Record<string, unknown>>
): Layer.Layer<SqlClient.SqlClient | A> =>
  Layer.fromBuild((memoMap, scope) => {
    const driverScope = Scope.forkUnsafe(scope)
    return Effect.map(Layer.buildWithMemoMap(self, memoMap, driverScope), (context) => {
      const sql = Context.get(context, SqlClient.SqlClient)
      const rollback = (conn: SqlConnection.Connection) =>
        conn.executeUnprepared("ROLLBACK", [], undefined).pipe(
          Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(driverScope, exit) : Effect.void)
        )
      const withTransaction = SqlClient.makeWithTransaction({
        transactionService: sql.transactionService,
        spanAttributes: [...Object.entries(spanAttributes), ["db.system.name", "sqlite"]],
        acquireConnection: Effect.flatMap(Scope.make(), (reservation) =>
          Scope.provide(sql.reserve, reservation).pipe(
            Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(reservation, exit) : Effect.void),
            Effect.map((conn) => [reservation, conn] as const)
          )),
        begin: (conn) => conn.executeUnprepared("BEGIN IMMEDIATE", [], undefined),
        savepoint: (conn, id) => conn.executeUnprepared(`SAVEPOINT effect_sql_${id}`, [], undefined),
        commit: (conn) =>
          conn.executeUnprepared("COMMIT", [], undefined).pipe(
            Effect.catchCause((commitCause) =>
              Effect.flatMap(Effect.exit(rollback(conn)), (rolledBack) =>
                // makeWithTransaction's orDie retains only the first typed
                // error. Convert every reason here so failed cleanup survives.
                Effect.failCause(Cause.fromReasons((Exit.isFailure(rolledBack)
                  ? Cause.combine(commitCause, rolledBack.cause)
                  : commitCause).reasons.map((reason) =>
                    Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason
                  ))))
            )
          ),
        rollback,
        rollbackSavepoint: (conn, id) => conn.executeUnprepared(`ROLLBACK TO SAVEPOINT effect_sql_${id}`, [], undefined)
      })
      Object.assign(sql, { withTransaction })
      return context
    })
  })

/** Builds a driver only after checking the existing file, closing every failed attempt.
 * @since 1.0.0
 * @category layers
 */
export const layer = <A>(
  filename: string,
  inspect: InspectTables,
  client: Layer.Layer<SqlClient.SqlClient | A>,
  spanAttributes: Readonly<Record<string, unknown>> = {}
): Layer.Layer<SqlClient.SqlClient | A> =>
  Layer.unwrap(Effect.as(guardOpen(filename, inspect), recoverFailedCommit(retryLockedOpen(client), spanAttributes)))
