/**
 * Authoritative source observations for one durable plan execution. These are
 * replay state, not approval data, journal projections, or evictable cache rows.
 * @since 1.0.0
 */

import { Sha256 } from "@smthrs/crypto"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { FileSet, Plan } from "@smthrs/plan"
import { OwnerId } from "@smthrs/run-store/Ownership"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Address of an append-only observation generation. `environmentDigest` comes
 * from `StepKey.environmentIdentity` and binds every generation of the run.
 * @since 1.0.0
 * @category schemas
 */
export const Address = Schema.Struct({
  runId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  baseDigest: Schema.NonEmptyString,
  environmentDigest: Schema.NonEmptyString,
  generation: Natural
})
/**
 * Address of an append-only observation generation.
 * @since 1.0.0
 * @category models
 */
export type Address = typeof Address.Type

/**
 * Maximum encoded snapshot size, in JavaScript string code units.
 * @since 1.0.0
 * @category constants
 */
export const maximumSnapshotCharacters = 16 * 1024 * 1024

/**
 * Frozen membership and newly pinned source digests for one generation.
 * @since 1.0.0
 * @category schemas
 */
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  generation: Natural,
  nodes: Schema.Array(Schema.Struct({
    id: Schema.NonEmptyString,
    key: Schema.NonEmptyString,
    reads: Schema.Array(Schema.Struct({
      entry: FileSet.ReadEntry,
      sourcePaths: Schema.Array(FileSet.Pattern)
    }))
  })).check(Schema.isMaxLength(Plan.maximumPlanNodes)),
  pins: Schema.Array(Schema.Struct({ path: FileSet.Pattern, digest: Schema.NonEmptyString }))
})
/**
 * Frozen membership and newly pinned source digests for one generation.
 * @since 1.0.0
 * @category models
 */
export type Snapshot = typeof Snapshot.Type

/**
 * A durable observation cannot be read or safely admitted.
 * @since 1.0.0
 * @category errors
 */
export class PlanInputError extends Schema.TaggedError<PlanInputError>()("@smthrs/engine-store/PlanInputError", {
  code: Schema.Literals([
    "invalid_input",
    "corrupt_state",
    "incompatible_state",
    "fence_lost",
    "transaction_open",
    "persistence_failed"
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * `get` is a committed-state admission gate and refuses an enclosing SQL
 * transaction. `record` is first-writer-wins and may join a write transaction;
 * callers must wait for its outer commit before executing affected actions.
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly get: (address: Address, owner: OwnerId) => Effect.Effect<Option.Option<Snapshot>, PlanInputError>
  readonly record: (address: Address, snapshot: Snapshot, owner: OwnerId) => Effect.Effect<Snapshot, PlanInputError>
}

/**
 * Durable plan-input service.
 * @since 1.0.0
 * @category services
 */
export class PlanInputStore extends Context.Service<PlanInputStore, Service>()("@smthrs/engine-store/PlanInputStore") {}

const failure = (code: PlanInputError["code"], message: string, cause?: unknown) =>
  new PlanInputError({ code, message, ...(cause === undefined ? {} : { cause }) })
const persistError = (cause: unknown) =>
  cause instanceof PlanInputError ?
    cause :
    failure("persistence_failed", "could not access durable plan inputs", cause)

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  code: "invalid_input" | "corrupt_state"
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }),
    catch: (cause) => failure(code, "invalid plan input observation", cause)
  })

const validateSnapshot = (snapshot: Snapshot, generation: number, code: "invalid_input" | "corrupt_state") => {
  if (
    snapshot.generation !== generation ||
    new Set(snapshot.nodes.map((node) => node.id)).size !== snapshot.nodes.length ||
    new Set(snapshot.pins.map((pin) => pin.path)).size !== snapshot.pins.length ||
    snapshot.nodes.some((node) =>
      node.reads.some((read) =>
        new Set(read.sourcePaths).size !== read.sourcePaths.length ||
        read.sourcePaths.some((path) =>
          typeof read.entry === "string" ? path !== read.entry : !FileSet.matchesGlob(read.entry, path)
        )
      )
    )
  ) {
    return Effect.fail(failure(code, "plan input observation has inconsistent membership or generation"))
  }
  return Effect.void
}

/**
 * Builds the SQL-backed, owner-fenced store.
 * @since 1.0.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, SqlClient.SqlClient | DurableWriter | Crypto.Crypto> = Effect.gen(
  function*() {
    const sql = yield* SqlClient.SqlClient
    const writer = yield* DurableWriter
    const crypto = yield* Effect.context<Crypto.Crypto>()
    const checksum = (value: string) => Schema.decodeUnknownEffect(Sha256)(value).pipe(Effect.provide(crypto))

    const fence = (address: Address, owner: OwnerId) =>
      Effect.gen(function*() {
        const owned = yield* sql`SELECT run_id FROM flows_runs WHERE run_id = ${address.runId}
      AND status = 'running' AND cancel_requested_at_ms IS NULL
      AND owner_host_id = ${owner.hostId} AND owner_pid = ${owner.pid} AND owner_nonce = ${owner.nonce}`
        if (owned.length !== 1) {
          return yield* Effect.fail(failure("fence_lost", "plan input owner no longer owns the run"))
        }
        const legacy = yield* sql`SELECT run_id FROM flows_plan_input_legacy_runs WHERE run_id = ${address.runId}`
        if (legacy.length > 0) {
          return yield* Effect.fail(
            failure(
              "incompatible_state",
              "this run executed before durable plan inputs were recorded; its original sources cannot be reconstructed"
            )
          )
        }
      })

    const load = (address: Address) =>
      Effect.gen(function*() {
        const heads = yield* sql<
          { planId: string; baseDigest: string; environmentDigest: string | null; generation: number }
        >`SELECT plan_id AS "planId", base_digest AS "baseDigest", environment_digest AS "environmentDigest", generation
      FROM flows_plan_input_heads WHERE run_id = ${address.runId}`
        const head = heads[0]
        if (head === undefined) {
          const orphan = yield* sql`SELECT 1 FROM flows_plan_input_generations
        WHERE run_id = ${address.runId} AND plan_id = ${address.planId} LIMIT 1`
          if (address.generation !== 0 || orphan.length > 0) {
            return yield* Effect.fail(failure("corrupt_state", "plan input history has no initial generation"))
          }
          return Option.none<Snapshot>()
        }
        yield* decode(
          Schema.Struct({
            planId: Schema.NonEmptyString,
            baseDigest: Schema.NonEmptyString,
            environmentDigest: Schema.NullOr(Schema.NonEmptyString),
            generation: Natural
          }),
          head,
          "corrupt_state"
        )
        if (head.planId !== address.planId || head.baseDigest !== address.baseDigest) {
          return yield* Effect.fail(
            failure("incompatible_state", "this run already observed a different approved plan")
          )
        }
        if (head.environmentDigest === null || head.environmentDigest !== address.environmentDigest) {
          return yield* Effect.fail(failure(
            "incompatible_state",
            "this run has a different or unrecorded execution environment; recover with its original runtime or explicitly reconcile before starting a new run"
          ))
        }
        const counts = yield* sql<{ count: number; first: number; last: number }>`SELECT COUNT(*) AS count,
      MIN(generation) AS first, MAX(generation) AS last FROM flows_plan_input_generations
      WHERE run_id = ${address.runId} AND plan_id = ${address.planId}`
        if (
          counts[0]!.count !== head.generation + 1 || counts[0]!.first !== 0 || counts[0]!.last !== head.generation ||
          address.generation > head.generation + 1
        ) {
          return yield* Effect.fail(failure("corrupt_state", "plan input history has a missing generation"))
        }
        if (address.generation > head.generation) return Option.none<Snapshot>()
        const rows = yield* sql<
          { snapshotJson: string; checksum: string }
        >`SELECT snapshot_json AS "snapshotJson", checksum
      FROM flows_plan_input_generations WHERE run_id = ${address.runId} AND plan_id = ${address.planId}
      AND generation = ${address.generation}`
        const row = rows[0]!
        if (
          row.snapshotJson.length > maximumSnapshotCharacters || (yield* checksum(row.snapshotJson)) !== row.checksum
        ) {
          return yield* Effect.fail(failure("corrupt_state", "plan input snapshot failed its size or integrity check"))
        }
        const snapshot = yield* decode(Schema.fromJsonString(Snapshot), row.snapshotJson, "corrupt_state")
        yield* validateSnapshot(snapshot, address.generation, "corrupt_state")
        return Option.some(snapshot)
      })

    const get: Service["get"] = Effect.fn("PlanInputStore.get")((input, ownerInput) =>
      Effect.gen(function*() {
        const address = yield* decode(Address, input, "invalid_input")
        const owner = yield* decode(OwnerId, ownerInput, "invalid_input")
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
          return yield* Effect.fail(
            failure("transaction_open", "plan execution requires committed source observations")
          )
        }
        return yield* writer.write(Effect.gen(function*() {
          yield* fence(address, owner)
          return yield* load(address)
        }))
      }).pipe(Effect.mapError(persistError))
    )

    const record: Service["record"] = Effect.fn("PlanInputStore.record")((input, value, ownerInput) =>
      Effect.gen(function*() {
        const address = yield* decode(Address, input, "invalid_input")
        const owner = yield* decode(OwnerId, ownerInput, "invalid_input")
        const snapshot = yield* decode(Snapshot, value, "invalid_input")
        yield* validateSnapshot(snapshot, address.generation, "invalid_input")
        const encoded = JSON.stringify(snapshot)
        if (encoded.length > maximumSnapshotCharacters) {
          return yield* Effect.fail(failure("invalid_input", "plan input snapshot exceeds the durable size limit"))
        }
        const hash = yield* checksum(encoded)
        return yield* writer.write(Effect.gen(function*() {
          yield* fence(address, owner)
          const existing = yield* load(address)
          if (Option.isSome(existing)) return existing.value
          if (address.generation === 0) {
            yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation)
          VALUES (${address.runId}, ${address.planId}, ${address.baseDigest}, ${address.environmentDigest}, 1, 0)`
          } else {
            yield* sql`UPDATE flows_plan_input_heads SET generation = ${address.generation}
          WHERE run_id = ${address.runId} AND plan_id = ${address.planId}`
          }
          yield* sql`INSERT INTO flows_plan_input_generations (run_id, plan_id, generation, snapshot_json, checksum)
        VALUES (${address.runId}, ${address.planId}, ${address.generation}, ${encoded}, ${hash})`
          return snapshot
        }))
      }).pipe(Effect.mapError(persistError))
    )

    return { get, record }
  }
)

/**
 * Provides the SQL-backed input store over the same database as the run/attempt stores.
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<PlanInputStore, never, SqlClient.SqlClient | DurableWriter | Crypto.Crypto> = Layer
  .effect(
    PlanInputStore
  )(make)
