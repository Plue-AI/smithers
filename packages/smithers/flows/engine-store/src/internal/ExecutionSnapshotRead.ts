/**
 * Shared transactional execution decoding.
 *
 * @since 1.0.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import { OwnerId } from "@smthrs/journal/OwnerId"
import { RunStatus, RunStoreError } from "@smthrs/run-store/RunStore"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Batch } from "../ExecutionSnapshot.ts"
import { RunState } from "../RunState.ts"

/**
 * Non-negative safe integer for timestamps and revisions.
 *
 * @private
 * @since 1.0.0
 */
export const Natural = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
/**
 * Bounded identifier with a durable text encoding.
 *
 * @private
 * @since 1.0.0
 */
export const Identifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter((value) =>
    !value.includes("\0") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  )
)
/**
 * Engine database source identity.
 *
 * @private
 * @since 1.0.0
 */
export const Source = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))
/**
 * Source identity and observed high-water mark.
 *
 * @private
 * @since 1.0.0
 */
export const Position = Schema.Struct({ source: Source, revision: Natural })
/**
 * Source identity and observed high-water mark.
 *
 * @private
 * @since 1.0.0
 */
export type Position = typeof Position.Type

/**
 * A deferred read transaction on the reserved engine connection. The normal
 * writable client's transaction starts IMMEDIATE; a read needs only SQLite's
 * snapshot and must allow a WAL writer to commit while it reads. PostgreSQL
 * reads at REPEATABLE READ so every statement shares the snapshot the position
 * was read from; READ COMMITTED would let a concurrent commit make a row look
 * newer than its position. Reuse the SQL
 * client's transaction service to join an existing transaction. No read body
 * exposes a mutation callback. Connection reservation and interruption release
 * remain scoped, including when BEGIN or the read fails.
 * @since 1.0.0
 * @private
 */
export const transaction = <A, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(
    Effect.serviceOption(sql.transactionService),
    (existing) =>
      Option.isSome(existing) ? effect : Effect.scoped(Effect.gen(function*() {
        const connection = yield* sql.reserve
        return yield* Effect.acquireUseRelease(
          connection.executeUnprepared(
            sql.onDialectOrElse({ pg: () => "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", orElse: () => "BEGIN" }),
            [],
            undefined
          ),
          () => effect.pipe(Effect.provideService(sql.transactionService, [connection, 0])),
          (_, exit) =>
            connection.executeUnprepared(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK", [], undefined).pipe(Effect.orDie)
        )
      }))
  )

/**
 * Preserves failure causes and interruption at the read boundary.
 *
 * @private
 * @since 1.0.0
 */
export const boundary = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, RunStoreError, R> =>
  effect.pipe(Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
    const original = Cause.squash(cause)
    return Effect.fail(
      original instanceof RunStoreError ? original : new RunStoreError({
        method,
        code: "persistence_failed",
        message: "engine execution observation failed",
        cause: original
      })
    )
  }))

/**
 * Decodes stored SQL values with the original schema error.
 *
 * @private
 * @since 1.0.0
 */
export const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError((cause) =>
    new RunStoreError({
      method: "ExecutionSnapshot.decode",
      code: "decode_failed",
      message: "stored execution observation is malformed",
      cause
    })
  ))

/**
 * Reads the engine database identity and revision.
 *
 * @private
 * @since 1.0.0
 */
export const position = (sql: SqlClient.SqlClient) =>
  sql`SELECT source, revision FROM flows_run_source WHERE singleton = 1`.pipe(
    Effect.flatMap((rows) => decode(Position, rows[0]))
  )

const Row = Schema.Struct({
  run_id: Identifier,
  status: RunStatus,
  created_at_ms: Natural,
  started_at_ms: Schema.NullOr(Natural),
  finished_at_ms: Schema.NullOr(Natural),
  owner_host_id: Schema.NullOr(Identifier),
  owner_pid: Schema.NullOr(Natural),
  owner_nonce: Schema.NullOr(Identifier),
  heartbeat_at_ms: Schema.NullOr(Natural),
  state_json: Schema.fromJsonString(RunState),
  parent_run_id: Schema.NullOr(Identifier),
  spawn_parent_id: Schema.NullOr(Identifier),
  spawn_seq: Schema.NullOr(Natural),
  execution_parent_id: Schema.NullOr(Identifier),
  lineage_id: Schema.NullOr(Identifier),
  round_ordinal: Schema.NullOr(Natural),
  cancel_requested_at_ms: Schema.NullOr(Natural),
  cancel_acknowledgement_json: Schema.NullOr(Schema.fromJsonString(Schema.Struct({
    observedAtMs: Natural,
    owner: OwnerId
  }))),
  // These opaque values use DurableEngineState's existing non-empty-string
  // contract. They are not run IDs and must not acquire an identifier ceiling.
  waiting_reason: Schema.NullOr(Schema.NonEmptyString),
  waiting_wake_at_ms: Schema.NullOr(Natural),
  waiting_token: Schema.NullOr(Schema.NonEmptyString),
  waiting_request: Schema.optional(Schema.NullOr(Schema.fromJsonString(Schema.Json))),
  revision: Natural,
  deleted: Schema.Literal(0)
})

/**
 * Structured waiting condition; nullable fields preserve older unknown values.
 * The opaque wake token leaves the engine only as its SHA-256 `tokenDigest`,
 * the same digest `ExecutionFacts` records: a reader may correlate a wait but
 * never holds the address that resolves it.
 *
 * @private
 * @since 1.0.0
 */
export interface Waiting {
  readonly kind: "timer" | "signal" | "approval" | "quota" | "human" | "other"
  readonly reason: string
  readonly wakeAtMs: number | null
  readonly tokenDigest: Sha256.Digest | null
  readonly request?: typeof Schema.Json.Type | undefined
}

const waitingKind = (reason: string): Waiting["kind"] => {
  switch (reason) {
    case "timer":
    case "approval":
    case "quota":
    case "human":
      return reason
    case "event":
    case "signal":
      return "signal"
    default:
      return "other"
  }
}

/**
 * Page-scoped lifecycle fields and indexed earliest spawn edge.
 *
 * @private
 * @since 1.0.0
 */
export const selectColumns = `r.*, c.revision, c.deleted,
  (SELECT parent_id FROM flows_run_parents WHERE child_id = r.run_id ORDER BY seq, parent_id LIMIT 1) AS spawn_parent_id,
  (SELECT seq FROM flows_run_parents WHERE child_id = r.run_id ORDER BY seq, parent_id LIMIT 1) AS spawn_seq`

/**
 * Decodes a run row and validates observation invariants.
 *
 * @private
 * @since 1.0.0
 */
export const observed = (input: unknown, at: Position) =>
  Effect.gen(function*() {
    const row = yield* decode(Row, input)
    const parentRunId = row.parent_run_id ?? row.spawn_parent_id
    const ownerFields = [row.owner_host_id, row.owner_pid, row.owner_nonce, row.heartbeat_at_ms]
    const validOwner = row.status === "running"
      ? ownerFields.every((value) => value !== null)
      : ownerFields.every((value) => value === null)
    if (
      !validOwner || row.revision === 0 || row.revision > at.revision ||
      parentRunId !== row.execution_parent_id || parentRunId === row.run_id ||
      (row.lineage_id === null) !== (row.round_ordinal === null) ||
      (row.waiting_reason === null && (row.waiting_wake_at_ms !== null || row.waiting_token !== null ||
        row.waiting_request !== undefined && row.waiting_request !== null)) ||
      (row.cancel_acknowledgement_json !== null && row.cancel_requested_at_ms === null)
    ) {
      return yield* Effect.fail(
        new RunStoreError({
          method: "ExecutionSnapshot.decode",
          code: "decode_failed",
          message: "stored execution observation violates its invariants",
          cause: new Error("inconsistent execution identity, wait, cancellation or revision")
        })
      )
    }
    return {
      _tag: "Observed" as const,
      runId: row.run_id,
      source: at.source,
      revision: row.revision,
      status: row.status,
      flowName: row.state_json.flowName,
      createdAtMs: row.created_at_ms,
      startedAtMs: row.started_at_ms,
      finishedAtMs: row.finished_at_ms,
      parentRunId,
      lineageId: row.lineage_id ?? row.run_id,
      roundOrdinal: row.round_ordinal ?? 0,
      cancellation: {
        requestedAtMs: row.cancel_requested_at_ms,
        acknowledgement: row.cancel_acknowledgement_json
      },
      waiting: row.waiting_reason === null ? null : {
        kind: waitingKind(row.waiting_reason),
        reason: row.waiting_reason,
        wakeAtMs: row.waiting_wake_at_ms,
        tokenDigest: row.waiting_token === null ? null : Sha256.digestSync(row.waiting_token),
        ...(row.waiting_request === undefined || row.waiting_request === null ? {} : { request: row.waiting_request })
      }
    }
  })

/**
 * The result of a successful execution observation.
 *
 * @private
 * @since 1.0.0
 */
export type Observed = Effect.Success<ReturnType<typeof observed>>

/**
 * Validates source, identity, ordering and revision coherence at the batch boundary.
 *
 * @private
 * @since 1.0.0
 */
export const coherentBatch = (runIds: ReadonlyArray<string>, batch: Batch): Effect.Effect<Batch, RunStoreError> => {
  const validPosition = Schema.is(Position)
  if (
    !validPosition(batch) || batch.snapshots.length !== runIds.length ||
    batch.snapshots.some((row, index) =>
      !validPosition(row) || row.runId !== runIds[index] || row.source !== batch.source ||
      row.revision > batch.revision
    )
  ) {
    return Effect.fail(new RunStoreError({
      method: "ExecutionSnapshot.read",
      code: "persistence_failed",
      message: "stored execution batch is incoherent: source, identity, order or revision mismatch",
      cause: undefined
    }))
  }
  return Effect.succeed(batch)
}
