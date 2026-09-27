/**
 * SQLite-backed score observation store.
 *
 * Package documentation: `packages/smithers/agent/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Json from "./internal/json.ts"
import * as Text from "./internal/text.ts"
import * as Migrations from "./Migrations.ts"
import { ScorerError } from "./ScorerError.ts"
import * as ScoreStore from "./ScoreStore.ts"

interface ObservationRow {
  readonly id: number
  readonly kind: "score" | "inconclusive"
  readonly target_step_key: string
  readonly scorer_key: string
  readonly value: number | null
  readonly reason: string | null
  readonly failure_code: string | null
  readonly metadata_json: string | null
  readonly at_ms: number
}

interface AggregateRow {
  readonly count: number
  readonly mean: number | null
  readonly min: number | null
  readonly inconclusive: number
}

/** A validated, fully encoded observation, snapshotted before the transaction opens. */
interface Insertable {
  readonly kind: "score" | "inconclusive"
  readonly targetStepKey: string
  readonly scorerKey: string
  readonly value: number | null
  readonly reason: string | null
  readonly failureCode: string | null
  readonly metadataJson: string | null
  readonly at: number
}

const failure = (message: string) => (cause: unknown): ScorerError => new ScorerError({ code: "store", message, cause })

/**
 * Maps a write failure to one stable scorer code.
 *
 * The outer mapper cannot simply be dropped: `DurableWriter.write` widens the
 * error channel with `DatabaseError`, and removing it is what keeps that off a
 * scorer caller's channel. Mapping every failure through one fixed sentence
 * was the defect. A permanent constraint violation, which retrying can never
 * fix, was indistinguishable from a transient `busy`, and the underlying
 * database text never surfaced at all.
 *
 * Every statement below normalizes its own `SqlError` with
 * `DurableWriter.fromSqlError` first, so this sees exactly one error type and
 * has no unreachable arm for a shape the runtime never produces.
 *
 * @internal
 */
const classify = (message: string) => (error: DurableWriter.DatabaseError): ScorerError =>
  new ScorerError({
    code: error.code === "constraint" ? "constraint" : "store",
    message: `${message} (database: ${error.code})`,
    cause: error
  })

/**
 * The scrub every stored `reason` and `meta` passes through.
 *
 * `flows_scores` is kept until a host calls `prune` and is read back by `observations()`, by eval
 * reports, and by gate summaries printed in CI, so a credential that reaches
 * `reason` or `metadata_json` is exactly as durable and as broadly readable as
 * one in a journal payload. A scorer earns those strings from places nobody
 * controls: a judge client whose failure message quotes the request it sent,
 * a judge whose prose quotes the agent output it graded. The byte bounds do
 * not help, because a bearer token, an `Authorization` header, or a URL with
 * embedded credentials fits inside the first kilobyte.
 *
 * The journal's own rule set is used rather than a second one, so both durable
 * prose surfaces of this database scrub the same shapes. `onTooDeep` names a
 * member past the redactor's depth bound instead of throwing: refusing the
 * write is how a scorer diagnostic gets lost, which is the opposite of what
 * this store is for.
 *
 * @internal
 */
const redactor = Redaction.make({ onTooDeep: "name" })

/**
 * Scrubs a reason and re-applies its byte bound.
 *
 * A placeholder is longer than some of the credentials it replaces, so a
 * producer that already truncated to `maxReasonBytes` can hand this prose that
 * the bound would then reject, dropping exactly the diagnostic that carried the
 * credential. Prose truncates on a code-point boundary and stays prose; JSON
 * does not, which is why `meta` is refused instead.
 *
 * `Redactor` is typed over `unknown` because it walks arbitrary payloads; a
 * string always redacts to a string.
 *
 * @internal
 */
const redactReason = (reason: string): string => Text.truncate(String(redactor(reason)), ScoreStore.maxReasonBytes)

const invalid = (message: string, cause?: unknown): ScorerError =>
  new ScorerError({
    code: "invalid_observation",
    message,
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Encodes `meta` through the canonical form the scorer key already uses.
 *
 * A bare `JSON.stringify` inside `writer.write` ran caller code (getters,
 * Proxy traps, `toJSON`) while holding the single-writer transaction, and
 * preserved insertion order rather than the canonical key order every other
 * identity in this package is built from. Encoding here, before the
 * transaction opens, also bounds the stored size.
 *
 * @internal
 */
const metadataJson = (observation: ScoreStore.Observation): Effect.Effect<string | null, ScorerError> => {
  if (observation.kind === "inconclusive" || observation.meta === undefined) return Effect.succeed(null)
  const meta = observation.meta
  const lossy = Json.lossyPath(meta, "meta")
  if (lossy !== undefined) {
    return Effect.fail(
      invalid(`Score observation metadata is not representable as canonical JSON: ${lossy}`)
    )
  }
  let canonical: string
  try {
    canonical = Digest.canonical(meta)
  } catch (cause) {
    return Effect.fail(invalid("Score observation metadata is not representable as canonical JSON", cause))
  }
  // Redacting the encoded text rather than the caller's object keeps the walk
  // over plain JSON: no getter, Proxy trap, or `toJSON` of the caller's runs a
  // second time, and the canonical key order survives. The bound is measured on
  // what is stored, so a payload the scrub grows past it is refused.
  const encoded = Redaction.redactJsonString(canonical, redactor)
  return Text.byteLength(encoded) > ScoreStore.maxMetadataBytes
    ? Effect.fail(
      invalid(
        `Score observation metadata exceeds ${ScoreStore.maxMetadataBytes} UTF-8 bytes`
      )
    )
    : Effect.succeed(encoded)
}

const withinReasonBound = (observation: ScoreStore.Observation): Effect.Effect<void, ScorerError> =>
  typeof observation.reason === "string" && Text.byteLength(observation.reason) > ScoreStore.maxReasonBytes
    ? Effect.fail(invalid(`An observation reason exceeds ${ScoreStore.maxReasonBytes} UTF-8 bytes`))
    : Effect.void

/**
 * Snapshots and fully encodes an observation at the moment `record` or
 * `recordOnce` is *called*.
 *
 * Everything here runs eagerly, in the function body, and the returned Effect
 * only reports the outcome. Building this inside `Effect.gen` read the caller's
 * object when the Effect ran instead: a caller could construct
 * `record(observation)`, change the score, and then run it, and the changed
 * score is what the store persisted. `readonly` is a compile-time promise only.
 *
 * The whole capture is guarded because a caller can hand this a hostile object.
 * A throwing getter has to become a failed Effect; throwing synchronously out
 * of `record()` would escape a caller who is only building a program.
 *
 * @internal
 */
const prepare = (observation: ScoreStore.Observation): Effect.Effect<Insertable, ScorerError> => {
  try {
    const kind = observation.kind
    const snapshot: ScoreStore.Observation = kind === "inconclusive"
      ? {
        kind,
        targetStepKey: observation.targetStepKey,
        scorerKey: observation.scorerKey,
        reason: observation.reason,
        code: observation.code,
        at: observation.at
      }
      : {
        kind,
        targetStepKey: observation.targetStepKey,
        scorerKey: observation.scorerKey,
        score: observation.score,
        reason: observation.reason,
        meta: observation.meta,
        at: observation.at
      }
    const reasonBound = withinReasonBound(snapshot)
    const metadata = metadataJson(snapshot)
    return ScoreStore.validate(snapshot).pipe(
      Effect.andThen(reasonBound),
      Effect.andThen(metadata),
      Effect.map((encoded): Insertable => ({
        kind: snapshot.kind,
        targetStepKey: snapshot.targetStepKey,
        scorerKey: snapshot.scorerKey,
        value: snapshot.kind === "score" ? snapshot.score : null,
        reason: snapshot.reason === undefined ? null : redactReason(snapshot.reason),
        failureCode: snapshot.kind === "inconclusive" ? snapshot.code : null,
        metadataJson: encoded,
        at: snapshot.at
      }))
    )
  } catch (cause) {
    return Effect.fail(invalid("An observation could not be snapshotted", cause))
  }
}

const identity = (value: string): Effect.Effect<string, ScorerError> => {
  if (value.trim().length === 0) {
    return Effect.fail(new ScorerError({ code: "invalid_request", message: "A scorer job identity must not be empty" }))
  }
  return Text.byteLength(value) > ScoreStore.maxIdentityBytes
    ? Effect.fail(
      new ScorerError({
        code: "invalid_request",
        message: `A scorer job identity exceeds ${ScoreStore.maxIdentityBytes} UTF-8 bytes`
      })
    )
    : Effect.succeed(value)
}

const pageLimit = (page: ScoreStore.Page | undefined): Effect.Effect<number, ScorerError> => {
  const limit = page?.limit
  if (limit === undefined) return Effect.succeed(ScoreStore.maxObservations)
  return Number.isSafeInteger(limit) && limit > 0 && limit <= ScoreStore.maxObservations
    ? Effect.succeed(limit)
    : Effect.fail(
      new ScorerError({
        code: "invalid_request",
        message: `An observation page limit must be an integer in [1, ${ScoreStore.maxObservations}], received ${
          String(limit)
        }`
      })
    )
}

const pageBefore = (page: ScoreStore.Page | undefined): Effect.Effect<number | undefined, ScorerError> => {
  const before = page?.before
  if (before === undefined) return Effect.succeed(undefined)
  return Number.isSafeInteger(before) && before >= 0
    ? Effect.succeed(before)
    : Effect.fail(
      new ScorerError({
        code: "invalid_request",
        message: `An observation page before must be a non-negative safe integer, received ${String(before)}`
      })
    )
}

const pageOffset = (page: ScoreStore.Page | undefined): Effect.Effect<number, ScorerError> => {
  const offset = page?.offset
  if (offset === undefined) return Effect.succeed(0)
  return Number.isSafeInteger(offset) && offset >= 0
    ? Effect.succeed(offset)
    : Effect.fail(
      new ScorerError({
        code: "invalid_request",
        message: `An observation page offset must be a non-negative safe integer, received ${String(offset)}`
      })
    )
}

const decodeStored = Schema.decodeUnknownEffect(ScoreStore.Observation)

/**
 * Reads one row back through the same contract the write path decodes against.
 *
 * Every guarantee is stated once, in {@link ScoreStore.Observation}, and the
 * row id travels with the failure: the earlier hand-written guards reported
 * "Stored inconclusive observation is missing its reason" with no way to find
 * which row, so one poisoned row made every later read of that target fail
 * with nothing to act on.
 *
 * @internal
 */
const decode = (row: ObservationRow): Effect.Effect<ScoreStore.Observation, ScorerError> =>
  Effect.try({
    try: (): unknown => {
      const at = Number(row.at_ms)
      return row.kind === "inconclusive"
        ? {
          kind: "inconclusive",
          targetStepKey: row.target_step_key,
          scorerKey: row.scorer_key,
          reason: row.reason,
          code: row.failure_code,
          at
        }
        : {
          kind: "score",
          targetStepKey: row.target_step_key,
          scorerKey: row.scorer_key,
          score: row.value === null ? null : Number(row.value),
          ...(row.reason === null ? {} : { reason: row.reason }),
          ...(row.metadata_json === null ? {} : { meta: JSON.parse(row.metadata_json) as unknown }),
          at
        }
    },
    catch: failure(`Could not decode the metadata of stored observation ${row.id}`)
  }).pipe(
    Effect.flatMap((candidate) =>
      decodeStored(candidate).pipe(
        Effect.mapError(
          failure(`Stored observation ${row.id} does not match the durable observation contract`)
        )
      )
    )
  )

/**
 * Builds the SQL-backed score store, bootstraps the shared database ledger,
 * and applies score-store migrations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<
  ScoreStore.Service,
  ScorerError,
  DurableWriter.DurableWriter | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter.DurableWriter
  yield* Migrations.run.pipe(Effect.mapError(failure("Could not run score-store migrations")))

  const observations: ScoreStore.Service["observations"] = (targetStepKey, scorerKey, page) =>
    Effect.gen(function*() {
      const limit = yield* pageLimit(page)
      const before = yield* pageBefore(page)
      const offset = yield* pageOffset(page)
      const scorerFilter = scorerKey === undefined ? sql`` : sql`AND scorer_key = ${scorerKey}`
      const beforeFilter = before === undefined ? sql`` : sql`AND at_ms < ${before}`
      // The lookup index serves this ordering only when scorer_key is filtered.
      // Unscoped reads use SQLite's temporary ordering B-tree; `id` breaks
      // timestamp ties in insertion order for both query shapes.
      const rows = yield* sql<ObservationRow>`SELECT id, kind, target_step_key, scorer_key, value, reason, failure_code,
          metadata_json, at_ms
        FROM flows_scores
        WHERE target_step_key = ${targetStepKey} ${scorerFilter} ${beforeFilter}
        ORDER BY at_ms, id
        LIMIT ${limit}
        OFFSET ${offset}`.pipe(Effect.mapError(failure("Could not read score observations")))
      return yield* Effect.forEach(rows, decode)
    })

  const aggregate: ScoreStore.Service["aggregate"] = (targetStepKey, scorerKey) => {
    const scorerFilter = scorerKey === undefined ? sql`` : sql`AND scorer_key = ${scorerKey}`
    return sql<AggregateRow>`SELECT
        count(*) FILTER (WHERE kind = 'score') AS count,
        avg(value) FILTER (WHERE kind = 'score') AS mean,
        min(value) FILTER (WHERE kind = 'score') AS min,
        count(*) FILTER (WHERE kind = 'inconclusive') AS inconclusive
      FROM flows_scores
      WHERE target_step_key = ${targetStepKey} ${scorerFilter}`.pipe(
      Effect.mapError(failure("Could not aggregate score observations")),
      Effect.map((rows) =>
        rows
          .map((row): ScoreStore.Aggregate => ({
            count: Number(row.count),
            mean: row.mean === null ? undefined : Number(row.mean),
            min: row.min === null ? undefined : Number(row.min),
            inconclusive: Number(row.inconclusive)
          }))
          .find((value) => value.count > 0 || value.inconclusive > 0)
      )
    )
  }

  const insert = (row: Insertable) =>
    sql`INSERT INTO flows_scores (
      kind, target_step_key, scorer_key, value, reason, failure_code, metadata_json, at_ms
    ) VALUES (
      ${row.kind},
      ${row.targetStepKey},
      ${row.scorerKey},
      ${row.value},
      ${row.reason},
      ${row.failureCode},
      ${row.metadataJson},
      ${row.at}
    )`.pipe(Effect.mapError(DurableWriter.fromSqlError))

  return ScoreStore.ScoreStore.of({
    record: (observation) => {
      const prepared = prepare(observation)
      return prepared.pipe(
        Effect.flatMap((row) =>
          writer.write(insert(row)).pipe(
            Effect.asVoid,
            Effect.mapError(classify("Could not record score observation"))
          )
        )
      )
    },
    recordOnce: (jobIdentity, observation) => {
      const prepared = prepare(observation)
      return Effect.gen(function*() {
        const claim = yield* identity(jobIdentity)
        const row = yield* prepared
        return yield* writer.write(
          Effect.gen(function*() {
            const claimed = yield* sql`INSERT INTO flows_score_jobs (identity, created_at_ms)
                VALUES (${claim}, ${row.at})
                ON CONFLICT (identity) DO NOTHING`.raw.pipe(Effect.mapError(DurableWriter.fromSqlError))
            // `DurableWriter.affectedRows` is dialect-agnostic and accepts a
            // safe bigint. Reading an own numeric `changes` here treated the
            // bigint that `SqlClient.SafeIntegers` produces as "already
            // claimed", so the claim committed and the observation was lost
            // forever, silently, on every retry. It also refuses anything that
            // is not a non-negative safe integer, and this single-row insert
            // affects at most one, so zero is the only "already claimed"
            // answer.
            const count = yield* DurableWriter.affectedRows(claimed)
            if (count === 0) return false
            if (count !== 1) {
              return yield* Effect.fail(
                new DurableWriter.DatabaseError({
                  code: "unknown",
                  cause: { operation: "claim scorer job", affectedRows: count }
                })
              )
            }
            yield* insert(row)
            return true
          })
        ).pipe(Effect.mapError(classify("Could not atomically record scorer job")))
      })
    },
    observations,
    aggregate,
    prune: ({ olderThan }) =>
      Number.isSafeInteger(olderThan)
        ? writer.write(
          Effect.gen(function*() {
            const observations = yield* sql`DELETE FROM flows_scores WHERE at_ms < ${olderThan}`.raw.pipe(
              Effect.mapError(DurableWriter.fromSqlError),
              Effect.flatMap(DurableWriter.affectedRows)
            )
            const jobs = yield* sql`DELETE FROM flows_score_jobs WHERE created_at_ms < ${olderThan}`.raw.pipe(
              Effect.mapError(DurableWriter.fromSqlError),
              Effect.flatMap(DurableWriter.affectedRows)
            )
            return { observations, jobs }
          })
        ).pipe(Effect.mapError(classify("Could not prune score observations")))
        : Effect.fail(
          new ScorerError({
            code: "invalid_request",
            message: `A prune cutoff must be a safe integer, received ${String(olderThan)}`
          })
        )
  })
})

/**
 * Provides the SQL-backed score store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  ScoreStore.ScoreStore,
  ScorerError,
  DurableWriter.DurableWriter | SqlClient.SqlClient
> = Layer.effect(
  ScoreStore.ScoreStore,
  make
)
