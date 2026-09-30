/**
 * Write retry policy.
 *
 * Governing persistence design: `docs/concepts/write-boundary.md`.
 *
 * Retry
 * only structured transient failures, bound exponential delay, and use Effect
 * scheduling so interruption and `TestClock` remain native.
 *
 * Classification is dialect-blind by construction. `DurableWriter.make`
 * accepts any `SqlClient`, so a caller can already hand it a Postgres or
 * PGlite client; keying only off SQLite codes made the retry silently inert
 * there, and a serialization failure — the normal, expected outcome of two
 * drivers fencing one run — surfaced as a hard write error (issue #78). Both
 * vocabularies are recognised, and a code from the wrong dialect simply never
 * matches.
 *
 * @since 0.1.0
 */

import { Cause, Duration, Effect, Metric, Schedule } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as DatabaseMetrics from "../DatabaseMetrics.ts"
// Type-only, so the module graph stays one-way: `DurableWriter` imports this
// file at runtime, this file borrows only its code union.
import type * as DurableWriter from "../DurableWriter.ts"

/**
 * Configuration for write retries.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteRetryOptions {
  /** Total attempts, including the initial write. */
  readonly maxAttempts?: number | undefined
  /** Initial exponential backoff delay in milliseconds. */
  readonly baseDelayMs?: number | undefined
  /** Upper bound for a single retry delay in milliseconds. */
  readonly maxDelayMs?: number | undefined
}

const defaultMaxAttempts = 10
const defaultBaseDelayMs = 50
const defaultMaxDelayMs = 10_000

const boundedPositiveInteger = (value: number | undefined, fallback: number): number => {
  const candidate = value ?? fallback
  return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : 1
}

const Uninspectable = Symbol("@smthrs/database/internal/WriteRetry/Uninspectable")

// Driver errors sometimes inherit their fields, so reads stay inheritance-aware
// rather than requiring own data properties. Each read is isolated so a hostile
// accessor or Proxy is treated as uninspectable instead of escaping as a defect.
const readProperty = (value: object, property: "cause" | "code" | "message" | "_tag"): unknown => {
  try {
    return (value as Record<typeof property, unknown>)[property]
  } catch {
    return Uninspectable
  }
}

const sqlErrorOf = (value: unknown): SqlError.SqlError | undefined => {
  try {
    return SqlError.isSqlError(value) ? value : undefined
  } catch {
    return undefined
  }
}

const causeCode = (cause: object): string | undefined | typeof Uninspectable =>
  ((code) => code === Uninspectable || typeof code === "string" ? code : undefined)(
    readProperty(cause, "code")
  )

/**
 * Postgres SQLSTATEs a write may legitimately be replayed on:
 * `40001` serialization_failure, `40P01` deadlock_detected, `55P03`
 * lock_not_available. `23505` (unique_violation) is deliberately absent — it
 * is the first-writer-wins signal the stores decide on, not a transient fault.
 */
const retryablePostgresStates = new Set(["40001", "40P01", "55P03"])

/**
 * Postgres SQLSTATEs for a statement that names what the schema lacks:
 * `42P01` undefined_table, `42703` undefined_column.
 */
const missingSchemaPostgresStates = new Set(["42P01", "42703"])

const isRetryableCode = (code: string | undefined): boolean =>
  code !== undefined &&
  (code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    retryablePostgresStates.has(code))

// PGlite runs Postgres in-process and does not always surface a SQLSTATE, so
// the canonical server texts are matched too.
const isRetryableMessage = (message: string): boolean =>
  message.includes("database is locked") ||
  message.includes("database is busy") ||
  message.includes("cannot rollback - no transaction is active") ||
  message.includes("could not serialize access") ||
  message.includes("deadlock detected")

const hasCause = (
  cause: unknown,
  match: (code: string | undefined, message: string) => boolean
): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const sqlError = sqlErrorOf(current)
    if (sqlError !== undefined) {
      current = sqlError.reason.cause
      continue
    }
    const code = causeCode(current)
    const messageValue = readProperty(current, "message")
    const next = readProperty(current, "cause")
    if (code === Uninspectable || messageValue === Uninspectable || next === Uninspectable) {
      return false
    }
    const message = typeof messageValue === "string" ? messageValue.toLowerCase() : ""
    if (match(code, message)) {
      return true
    }
    current = next
  }
  return false
}

/**
 * Returns whether a cause chain carries a recognized transient database
 * conflict.
 *
 * @category guards
 * @since 1.0.0
 */
export const isBusyCause = (cause: unknown): boolean =>
  hasCause(cause, (code, message) => isRetryableCode(code) || isRetryableMessage(message))

/**
 * Returns whether a cause chain carries a recognized SQLite I/O failure.
 *
 * @category guards
 * @since 1.0.0
 */
export const isIoCause = (cause: unknown): boolean =>
  hasCause(
    cause,
    (code, message) => code?.startsWith("SQLITE_IOERR") === true || message.includes("disk i/o error")
  )

/**
 * Returns whether a cause chain names a table or column the database does not
 * have: SQLite's `no such table` / `no such column`, or PostgreSQL's
 * `undefined_table` / `undefined_column`. A store written by an older schema
 * answers this way to a statement a newer binary issues.
 *
 * @category guards
 * @since 1.0.0
 */
export const isSchemaCause = (cause: unknown): boolean =>
  hasCause(
    cause,
    (code, message) =>
      (code !== undefined && missingSchemaPostgresStates.has(code)) ||
      message.includes("no such table") || message.includes("no such column")
  )

/**
 * The stable category a structured SQL failure normalizes to.
 *
 * Every code `DurableWriter.DatabaseError` reports except `unsupported`, which
 * a refused open raises before any statement runs and no classifier here can
 * produce. Derived rather than restated so the two cannot drift.
 *
 * @category models
 * @since 1.0.0
 */
export type SqlFailureCode = Exclude<DurableWriter.DatabaseErrorCode, "unsupported">

/**
 * Classifies a structured SQL error once, for both the retry decision and the
 * code `DurableWriter.DatabaseError` reports.
 *
 * One function rather than two predicates, because the two used to disagree on
 * a mixed cause chain: an `SQLITE_IOERR` whose own cause carried `SQLITE_BUSY`
 * was reported as `io` — the category the package documents as never replayed
 * — and retried anyway. Precedence is decided here, in one place, so a code and
 * a retry decision can no longer drift apart: a lock timeout is always busy, a
 * constraint violation is never transient, and an I/O failure outranks a busy
 * cause nested beneath it, because the write did reach the disk.
 *
 * @category classifying
 * @since 1.0.0
 */
export const classifySqlError = (error: SqlError.SqlError): SqlFailureCode =>
  error.reason._tag === "LockTimeoutError"
    ? "busy"
    : error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation"
    ? "constraint"
    : isIoCause(error.reason.cause)
    ? "io"
    : isBusyCause(error.reason.cause)
    ? "busy"
    : isSchemaCause(error.reason.cause)
    ? "schema"
    : "unknown"

/**
 * The category SQL provenance in a cause chain normalizes to, including a
 * redacted normalized error, or `undefined` when the chain carries none.
 *
 * @category classifying
 * @since 1.0.0
 */
export const findFailureCode = (error: unknown): DurableWriter.DatabaseErrorCode | undefined => {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const sqlError = sqlErrorOf(current)
    if (sqlError !== undefined) {
      return classifySqlError(sqlError)
    }
    // Check the tagged vocabulary without importing DurableWriter at runtime:
    // it owns the retry loop and imports this module. A bare code or message
    // remains insufficient provenance for replaying application failures.
    if (readProperty(current, "_tag") === "@smthrs/database/DatabaseError") {
      const code = readProperty(current, "code")
      if (code === "busy" || code === "io" || code === "constraint" || code === "schema" || code === "unsupported" ||
        code === "unknown") {
        return code
      }
    }
    const next = readProperty(current, "cause")
    if (next === Uninspectable) return undefined
    current = next
  }
  return undefined
}

/**
 * Returns whether a failure represents a transient write conflict in either
 * the SQLite or the Postgres vocabulary. The failure may be
 * the structured SQL error, a normalized DatabaseError, or a domain error wrapping one — the walk
 * follows `cause` chains (and a `SqlError`'s reason cause) either way, so the
 * outermost `DurableWriter.write` still replays a transaction whose failing
 * savepoint a nested store already normalized into its own error type.
 * Constraint, syntax, and arbitrary application errors are deliberately never
 * retried, and neither is an I/O failure with a busy cause beneath it: the
 * classification {@link classifySqlError} makes is the whole decision.
 *
 * A defect is judged by this same function, so a raw throw qualifies only when
 * it carries SQL or normalized database provenance too.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRetryableWriteError = (error: unknown): boolean => findFailureCode(error) === "busy"

/** Returns whether one typed reason carries an I/O failure. */
const isIoFailure = (error: unknown): boolean => {
  const code = findFailureCode(error)
  return code === undefined ? isIoCause(error) : code === "io"
}

interface ClassifiedCause<E> {
  readonly cause: Cause.Cause<E>
  readonly retryable: boolean
}

/**
 * Decides whether a cause is worth replaying, reading every reason it carries.
 *
 * `Cause.findError`/`findDefect` answer with the FIRST reason of a kind, so a
 * parallel cause that pairs a busy SQL failure with an application error was
 * retried or not depending on which half arrived first. A write that raced two
 * effects is exactly where that shape comes from, so the whole reason list is
 * scanned instead.
 *
 * Both channels are then read under one rule: the first pass vetoes on I/O,
 * the second admits a busy conflict, and neither cares which channel carries
 * it. The defect channel is read at all because a transaction whose BEGIN or
 * ROLLBACK fails reaches the caller through Effect's own
 * `Effect.orDie(options.rollback(conn))`, which dies with the `SqlError` that
 * step failed with. It is not a licence to replay an application defect whose
 * message happens to quote database text.
 */
const classifyCause = <E>(cause: Cause.Cause<E>): ClassifiedCause<E> => {
  for (const reason of cause.reasons) {
    if (
      (Cause.isFailReason(reason) && isIoFailure(reason.error)) ||
      (Cause.isDieReason(reason) && (isIoCause(reason.defect) || isIoFailure(reason.defect)))
    ) {
      return { cause, retryable: false }
    }
  }
  for (const reason of cause.reasons) {
    if (
      (Cause.isFailReason(reason) && isRetryableWriteError(reason.error)) ||
      (Cause.isDieReason(reason) && isRetryableWriteError(reason.defect))
    ) {
      return { cause, retryable: true }
    }
  }
  return { cause, retryable: false }
}

/**
 * Retries recognized transient write errors using exponential backoff and
 * jitter. Delays use Effect's Clock and therefore work with TestClock.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withWriteRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: WriteRetryOptions | undefined
): Effect.Effect<A, E, R> => {
  const maxAttempts = boundedPositiveInteger(options?.maxAttempts, defaultMaxAttempts)
  const baseDelayMs = boundedPositiveInteger(options?.baseDelayMs, defaultBaseDelayMs)
  const maxDelayMs = boundedPositiveInteger(options?.maxDelayMs, defaultMaxDelayMs)
  // Jitter runs before the cap so `maxDelayMs` bounds the delay that is
  // actually slept: capping first and jittering after lets a jitter draw
  // above 1 stretch a delay past the documented upper bound.
  const schedule = Schedule.exponential(Duration.millis(baseDelayMs)).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.millis(Math.min(maxDelayMs, Duration.toMillis(duration))))
    ),
    Schedule.upTo({ times: maxAttempts - 1 }),
    // The tap sits after `upTo`, so it fires once per step that actually
    // schedules a replay and never for the exhausted attempt that surfaces
    // the error instead.
    Schedule.tap(() => Metric.update(DatabaseMetrics.writeRetries, 1))
  )
  const retryableEffect = Effect.catchCause(effect, (cause) => Effect.fail(classifyCause(cause)))
  return Effect.retry(retryableEffect, { schedule, while: (classified) => classified.retryable }).pipe(
    Effect.catch((classified) => Effect.failCause(classified.cause))
  )
}
