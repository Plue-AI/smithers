/**
 * Serialized, retryable write boundary for the durable flows stores.
 *
 * Governing persistence designs: `docs/api.md` and
 * `docs/concepts/write-boundary.md`.
 *
 * The SQL client is Effect's own `SqlClient` service and is consumed
 * directly for queries; this module adds only the write policy the durable
 * stores share, plus the dialect-neutral error vocabulary. Domain schema and
 * operations remain in `@smthrs/journal`.
 *
 * @since 0.1.0
 */
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as CommitScope from "./internal/CommitScope.ts"
import * as WriteRetry from "./internal/WriteRetry.ts"

/**
 * Configuration for durable write retries.
 *
 * @category models
 * @since 1.0.0
 */
export type WriteRetryOptions = WriteRetry.WriteRetryOptions

/**
 * Stable categories exposed for database failures.
 *
 * @category models
 * @since 0.1.0
 */
export const DatabaseErrorCode = Schema.Literals(["busy", "constraint", "io", "unsupported", "unknown"])

/**
 * Stable database failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type DatabaseErrorCode = typeof DatabaseErrorCode.Type

/**
 * A normalized database error suitable for consumers outside a driver.
 *
 * @category errors
 * @since 0.1.0
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("@smthrs/database/DatabaseError", {
  code: DatabaseErrorCode,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Runtime shape of the durable writer.
 *
 * `write` replaces typed SqlError failures with DatabaseError, removing
 * SqlError from the error channel while preserving other application errors.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly write: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, Exclude<E, SqlError.SqlError> | DatabaseError, R>
}

/**
 * The write boundary shared by the durable stores, deliberately free of
 * journal or Host knowledge. Queries go through Effect's `SqlClient`
 * directly; only writes come here.
 *
 * **The `write` contract.** `write` runs its effect inside one transaction
 * with transaction-scoped retries, and implementations MUST guarantee that
 * write transactions are mutually serialized: two concurrent `write`
 * transactions may not both commit results computed from snapshots that
 * exclude each other's writes. Consumers depend on this for correctness,
 * not just isolation hygiene — the engine store's cycle detector inserts an
 * edge and walks the ancestor graph inside one `write`, and its safety
 * argument ("of two edges that jointly close a cycle, exactly the later
 * one fails") holds only under serialized writers. SQLite satisfies the
 * contract with its single-writer transaction lock; a PostgreSQL-backed
 * implementation must serialize them with a transaction-scoped advisory lock
 * before reads, or use `SERIALIZABLE` and retry `40001`. Plain READ COMMITTED
 * without that locking does not satisfy this contract.
 *
 * **Acquisition.** Outermost writes sharing this service queue for one permit
 * BEFORE entering Effect SQL's masked connection acquisition, and they queue at
 * the caller's own interruptibility. An interruptible caller can therefore be
 * interrupted or time out while queued, and acquires nothing when it is: no
 * transaction is opened and the holder's permit is untouched. A caller that
 * masked interruption keeps waiting, which is what a cleanup write running in
 * a finalizer needs. The permit spans the whole retry loop and is released
 * after SQL finishes, before commit publication can start another write.
 *
 * **Nesting.** A `write` inside the client's open transaction joins it as a
 * savepoint and does not retry: a transient conflict dooms the enclosing
 * transaction's snapshot, so replaying the savepoint alone can never resolve
 * it. Only the outermost `write` retries, replaying the whole transaction
 * body verbatim against the committed state. Its retry classification
 * follows `cause` chains, so a transient failure keeps replaying the
 * outermost transaction even after a nested store has wrapped it in a domain
 * error that preserves `cause`. A store may redact driver payloads by keeping
 * only a new `DatabaseError({ code })` in that cause chain; its normalized
 * category is sufficient retry provenance.
 *
 * @category services
 * @since 0.1.0
 */
export class DurableWriter extends Context.Service<DurableWriter, Service>()("@smthrs/database/DurableWriter") {}

/**
 * Schedules a non-failing process-local update after the outermost managed
 * write commits. Failed savepoints and retried attempts discard their updates.
 *
 * Returns false without running the update outside a managed write, including
 * raw SQL transactions/savepoints whose commit this writer does not own.
 * Callers may skip optional cache publication in that case; they must never
 * interpret false as permission to publish uncommitted state. Keep updates
 * short: publication is uninterruptible and is not retried with the SQL body.
 * Pass the store's SQL client when an update belongs to a particular database;
 * a nested transaction on another client must not own its publication.
 *
 * @category transactions
 * @since 1.0.0
 */
export const afterCommit = CommitScope.afterCommit

/**
 * Converts an Effect SQL error into the package's stable error vocabulary.
 *
 * The category comes from `WriteRetry.classifySqlError`, the same call the
 * retry decision reads, so the code a caller is told and the decision to replay
 * cannot disagree about one error.
 *
 * @category converting
 * @since 0.1.0
 */
export const fromSqlError = (error: SqlError.SqlError): DatabaseError =>
  new DatabaseError({ code: WriteRetry.classifySqlError(error), cause: error })

const normalizeSqlErrors = <E>(
  cause: Cause.Cause<E>
): Cause.Cause<Exclude<E, SqlError.SqlError> | DatabaseError> =>
  Cause.map(
    cause,
    (error) => SqlError.isSqlError(error) ? fromSqlError(error) : error
  ) as Cause.Cause<Exclude<E, SqlError.SqlError> | DatabaseError>

// Only a driver's own data property counts: an inherited field or accessor is
// not a result the statement returned. Safe bigint counts are exact and occur
// when Effect SQL's SafeIntegers service is enabled; an out-of-range bigint or
// double cannot be represented without changing the count.
const rowCountOf = (raw: unknown, field: string): number | undefined => {
  if (typeof raw !== "object" || raw === null) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(raw, field)
  if (descriptor === undefined || !("value" in descriptor)) {
    return undefined
  }
  const count = descriptor.value
  if (typeof count === "number") {
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined
  }
  if (typeof count === "bigint") {
    return count >= 0n && count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : undefined
  }
  return undefined
}

const rawShape = (raw: unknown) => ({
  type: Array.isArray(raw) ? "array" : typeof raw,
  keys: typeof raw === "object" && raw !== null ? Object.keys(raw).slice(0, 8) : [],
  length: Array.isArray(raw) ? raw.length : undefined
})

/**
 * Reads how many rows a write statement affected from a driver's raw result.
 *
 * `SqlClient`'s `.raw` yields the driver's native result object, whose
 * affected-row field is dialect-specific: SQLite drivers (bun:sqlite,
 * better-sqlite3) report `changes`, node-postgres reports `rowCount`. A
 * consumer that casts to one shape silently reads `undefined` on the other
 * backend, turning a successful compare-and-swap delete into a reported
 * no-op. Reading it here keeps the whole vocabulary dialect-agnostic, as
 * `fromSqlError` already does for failure codes (issue #134).
 *
 * @category accessors
 * @since 0.1.0
 */
export const affectedRows = (raw: unknown): Effect.Effect<number, DatabaseError> =>
  Effect.suspend(() => {
    try {
      const count = rowCountOf(raw, "changes") ?? rowCountOf(raw, "rowCount")
      return count === undefined
        ? Effect.fail(new DatabaseError({ code: "unsupported", cause: rawShape(raw) }))
        : Effect.succeed(count)
    } catch {
      return Effect.fail(
        new DatabaseError({
          code: "unsupported",
          cause: { type: typeof raw, keys: [] }
        })
      )
    }
  })

/**
 * Builds the durable writer around an existing SQL client.
 *
 * Typed SqlError failures are replaced by DatabaseError in the error channel.
 * SQL failures from COMMIT receive the same normalization.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (sql: SqlClient.SqlClient, options?: WriteRetryOptions | undefined): Service => {
  const gate = Semaphore.makeUnsafe(1)
  return DurableWriter.of({
    write: Effect.fn("DurableWriter.write")(<A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, Exclude<E, SqlError.SqlError> | DatabaseError, R> =>
      Effect.gen(function*() {
        const enclosing = yield* Effect.serviceOption(sql.transactionService)
        const parent = yield* CommitScope.Current
        const nested = Option.isSome(enclosing)
        const managed = !nested || CommitScope.matches(parent, sql.transactionService, enclosing.value)
        yield* Effect.annotateCurrentSpan({ nested })
        // Allocate inside the retry boundary. Each savepoint also owns a fresh
        // list so a failure caught by its parent cannot publish rolled-back data.
        const attempt = Effect.suspend(() => {
          const effects: Array<Effect.Effect<void>> = []
          let scope: CommitScope.CommitScope | undefined
          let bodySucceeded = false
          return sql.withTransaction(
            Effect.flatMap(Effect.serviceOption(sql.transactionService), (transaction) => {
              scope = managed && Option.isSome(transaction)
                ? { key: sql.transactionService, transaction: transaction.value, effects, open: true }
                : undefined
              return Effect.provideService(effect, CommitScope.Current, scope).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    bodySucceeded = true
                  })
                )
              )
            })
          ).pipe(
            // Effect SQL puts COMMIT errors on the defect channel. Only a
            // successful outer body can reach COMMIT; intentional body defects
            // and nested savepoint failures keep their original channels.
            Effect.catchCause((cause) =>
              Effect.failCause(
                !nested && bodySucceeded
                  ? Cause.fromReasons(cause.reasons.map((reason) =>
                    Cause.isDieReason(reason) && SqlError.isSqlError(reason.defect)
                      ? Cause.makeFailReason(reason.defect)
                      : reason
                  ))
                  : cause
              )
            ),
            Effect.ensuring(Effect.sync(() => {
              if (scope !== undefined) scope.open = false
            })),
            Effect.map((value) => ({ value, effects }))
          )
        })
        return yield* Effect.uninterruptibleMask((restore) => {
          // Only an outer write queues for the permit; a savepoint already owns
          // the connection. The permit is taken at the CALLER's interruptibility
          // and BEFORE Effect SQL masks its connection acquisition, so a queued
          // caller's interruption or deadline still lands, and a cancelled
          // waiter acquires nothing: it neither opens a transaction nor
          // releases the holder. A caller that masked itself keeps waiting, so
          // a shutdown finalizer's write is queued rather than dropped.
          const transaction = restore(
            nested ? attempt : gate.withPermit(WriteRetry.withWriteRetry(attempt, options))
          )
          return transaction.pipe(
            Effect.catchCause((cause) => Effect.failCause(normalizeSqlErrors(cause))),
            Effect.flatMap(({ value, effects }) =>
              (nested
                ? Effect.sync(() => {
                  if (managed) parent!.effects.push(...effects)
                })
                // A defective update must not suppress the other committed
                // publications. Retain every failure, but never retry SQL.
                : Effect.forEach(effects, (update) => Effect.exit(update)).pipe(
                  Effect.flatMap((exits) => Exit.asVoidAll(exits))
                )).pipe(Effect.as(value))
            )
          )
        })
      })
    )
  })
}

/**
 * Provides the durable writer over the context's SQL client.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options?: WriteRetryOptions | undefined
): Layer.Layer<DurableWriter, never, SqlClient.SqlClient> =>
  Layer.effect(
    DurableWriter,
    Effect.map(Effect.service(SqlClient.SqlClient), (sql) => make(sql, options))
  )

/**
 * Builds a writer stub whose writes fail with `unsupported`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  DurableWriter.of({
    write: Effect.fn("DurableWriter.write")(() => Effect.fail(new DatabaseError({ code: "unsupported" })))
  })

/**
 * Provides the unsupported writer stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<DurableWriter> = Layer.succeed(DurableWriter)(makeNoop())
