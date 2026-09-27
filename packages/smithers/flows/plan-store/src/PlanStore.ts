/**
 * Durable, append-only plan persistence.
 *
 * A plan is serializable data. Plans are values, so they diff and travel, and
 * this is where the value is kept: nodes,
 * edges, computed keys, effect declarations, conflict annotations, and the
 * digest a run's approval binds to. The store verifies the compiler's keys,
 * digests, and graph invariants on admission and read before returning a plan.
 *
 * Growth is append-only and the SQL enforces it (see `Migrations`, whose current
 * trigger is `0003_forward_only_identity`). {@link Service.append} inserts the newest generation's
 * rows and advances the plan row's digest; nothing rewrites a node.
 *
 * @since 0.1.0
 */

import { affectedRows, DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import { StoredKey } from "@smthrs/keys"
import * as Plan from "@smthrs/plan/Plan"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"

/**
 * Stable error codes returned by plan persistence operations.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const PlanStoreErrorCode = Schema.Literals([
  "invalid_plan",
  "constraint",
  "decode_failed",
  "persistence_failed"
])

/**
 * The value form of {@link PlanStoreErrorCode}.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PlanStoreErrorCode = typeof PlanStoreErrorCode.Type

/**
 * Error raised by plan persistence operations.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class PlanStoreError extends Schema.TaggedError<PlanStoreError>()("@smthrs/plan-store/PlanStoreError", {
  code: PlanStoreErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * The outcome of recording a plan under its id, in the shape
 * `CacheStore.put` established: first writer wins, an identical re-record is
 * not an error, and a different plan under the same id is a conflict rather
 * than a silent overwrite.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RecordResult =
  | { readonly _tag: "Recorded" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict"; readonly digest: string }

/**
 * Plan persistence operations.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Service {
  /** Records generation 0 of a plan. */
  readonly record: (plan: Plan.Plan, createdAtMs: number) => Effect.Effect<RecordResult, PlanStoreError>
  /** Appends the newest generation's nodes and edges and advances the digest. */
  readonly append: (plan: Plan.Plan) => Effect.Effect<void, PlanStoreError>
  /** Reads the whole plan back, nodes in recorded order. */
  readonly get: (planId: string) => Effect.Effect<Option.Option<Plan.Plan>, PlanStoreError>
}

/**
 * Service tag for durable plan persistence.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export class PlanStore extends Context.Service<PlanStore, Service>()("@smthrs/plan-store/PlanStore") {}

const error = (code: PlanStoreErrorCode, message: string, cause: unknown): PlanStoreError =>
  new PlanStoreError({ code, message, cause })

const mapPersistenceError = (cause: unknown): PlanStoreError => {
  if (Schema.is(PlanStoreError)(cause)) return cause
  const constraint = Schema.is(DatabaseError)(cause)
    ? cause.code === "constraint"
    : SqlError.isSqlError(cause) &&
      (cause.reason instanceof SqlError.ConstraintError || cause.reason instanceof SqlError.UniqueViolation)
  return error(constraint ? "constraint" : "persistence_failed", "plan persistence failed", cause)
}

const encodeNode = Schema.encodeEffect(Schema.fromJsonString(Plan.PlanNode))
const decodeNode = Schema.decodeUnknownEffect(Schema.fromJsonString(Plan.PlanNode))

const PlanRow = Schema.Struct({
  plan_id: Schema.NonEmptyString,
  flow: Schema.NonEmptyString,
  base_digest: StoredKey,
  digest: StoredKey,
  generation: Schema.Int
})

const decodePlanRow = Schema.decodeUnknownEffect(PlanRow)

const validate = (plan: Plan.Plan): Effect.Effect<void, PlanStoreError> =>
  Schema.decodeUnknownEffect(Plan.Plan)(plan).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => error("invalid_plan", "plan violates the persistence contract", cause))
  )

// Only rebuilt, frozen, JSON-compatible nodes from Plan.verify reach storage.
const nodeJson = (node: Plan.PlanNode): Effect.Effect<string> => encodeNode(node).pipe(Effect.orDie)

/**
 * Builds the SQL-backed plan store.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient | Crypto.Crypto> = Effect.gen(
  function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter
    const crypto = yield* Crypto.Crypto
    const verified = (plan: unknown) =>
      Plan.verify(plan).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((cause) => error("invalid_plan", "plan does not match its compiled integrity contract", cause))
      )

    const insertNodes = (
      planId: string,
      nodes: ReadonlyArray<Plan.PlanNode>,
      firstOrdinal: number
    ) =>
      Effect.gen(function*() {
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index]!
          const json = yield* nodeJson(node)
          yield* sql`
          INSERT INTO flows_plan_nodes (plan_id, node_id, generation, ordinal, kind, key_digest, node_json)
          VALUES (${planId}, ${node.id}, ${node.generation}, ${
            firstOrdinal + index
          }, ${node.kind}, ${node.key}, ${json})
        `
          for (const dependency of node.dependsOn) {
            yield* sql`
            INSERT INTO flows_plan_edges (plan_id, from_node, to_node) VALUES (${planId}, ${dependency}, ${node.id})
          `
          }
        }
      })

    const record: Service["record"] = Effect.fn("PlanStore.record")((plan, createdAtMs) =>
      Effect.gen(function*() {
        yield* validate(plan)
        if (plan.generation !== 0) {
          return yield* Effect.fail(
            error(
              "invalid_plan",
              `plan ${plan.planId} has generation ${plan.generation}; record requires generation 0`,
              undefined
            )
          )
        }
        if (plan.baseDigest !== plan.digest) {
          return yield* Effect.fail(
            error(
              "invalid_plan",
              `plan ${plan.planId} has base digest ${plan.baseDigest}, but generation 0 digest is ${plan.digest}`,
              undefined
            )
          )
        }
        const wrongGeneration = plan.nodes.find((node) => node.generation !== 0)
        if (wrongGeneration !== undefined) {
          return yield* Effect.fail(
            error(
              "invalid_plan",
              `plan ${plan.planId} node ${wrongGeneration.id} has generation ${wrongGeneration.generation}; record requires node generation 0`,
              undefined
            )
          )
        }
        plan = yield* verified(plan)
        return yield* writer.write(
          Effect.gen(function*() {
            const inserted = yield* sql`
            INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
            VALUES (${plan.planId}, ${plan.flow}, ${plan.baseDigest}, ${plan.digest}, ${plan.generation}, ${createdAtMs})
            ON CONFLICT (plan_id) DO NOTHING
          `.raw
            if ((yield* affectedRows(inserted)) === 0) {
              // Equality with an unverified stored digest is not an integrity
              // proof. A corrupt existing row must not answer ExistingSame.
              yield* get(plan.planId)
              const rows = yield* sql<{ digest: string }>`
              SELECT digest FROM flows_plans WHERE plan_id = ${plan.planId}
            `
              const existing = rows[0]!.digest
              return existing === plan.digest
                ? { _tag: "ExistingSame" } as const
                : { _tag: "Conflict", digest: existing } as const
            }
            yield* insertNodes(plan.planId, plan.nodes, 0)
            return { _tag: "Recorded" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const append: Service["append"] = Effect.fn("PlanStore.append")((plan) =>
      Effect.gen(function*() {
        // A verified snapshot passed the persistence contract's schema when
        // it was frozen; only an imported value needs the guard before its
        // nodes are read.
        if (!Plan.isVerified(plan)) yield* validate(plan)
        let appended = Plan.generationNodes(plan)
        if (appended.length === 0) {
          return yield* Effect.fail(
            error(
              "invalid_plan",
              `plan ${plan.planId} generation ${plan.generation} has no nodes to append`,
              undefined
            )
          )
        }
        plan = yield* verified(plan)
        appended = Plan.generationNodes(plan)
        const prefix = plan.nodes.filter((node) => node.generation < plan.generation)
        // The digest the stored envelope must carry before this append lands:
        // the approval digest of this append's already-verified prefix.
        // Matching it in the compare-and-swap proves the recorded prefix is
        // the caller's — the envelope-integrity guarantee `get` gave the
        // append — without decoding and re-verifying every stored row.
        // Verification rebuilt and froze the prefix, so the derivation
        // cannot fail.
        const prefixDigest = yield* Plan.prefixDigest(plan).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.orDie
        )
        yield* writer.write(
          Effect.gen(function*() {
            // The compare-and-swap matches the whole envelope this append
            // grew from: the previous generation, the flow, the approved
            // base digest, and the running prefix digest. A stored plan
            // whose rows diverge from this append's verified prefix carries
            // a different digest, so the match also proves the recorded
            // prefix is the caller's, without reading a single node row.
            const advanced = yield* sql`
            UPDATE flows_plans SET digest = ${plan.digest}, generation = ${plan.generation}
            WHERE plan_id = ${plan.planId}
              AND generation = ${plan.generation - 1}
              AND flow = ${plan.flow}
              AND base_digest = ${plan.baseDigest}
              AND digest = ${prefixDigest}
          `.raw
            // An elaboration grows a plan that was recorded. Without this the
            // UPDATE matching nothing is silently fine while the node rows land
            // anyway, leaving a generation of a plan that does not exist — and
            // the append-only triggers guarantee those rows can never be
            // removed. The whole write is one transaction, so refusing here
            // takes them back with it.
            if ((yield* affectedRows(advanced)) === 0) {
              const envelopes = yield* sql<{ generation: number; flow: string; base_digest: string }>`
              SELECT generation, flow, base_digest FROM flows_plans WHERE plan_id = ${plan.planId}
            `
              const envelope = envelopes[0]
              if (envelope !== undefined) {
                // The swap matched nothing although the plan exists. Stored
                // corruption must report decode_failed rather than read as a
                // moved or divergent plan, and only the verifying read tells
                // it apart from a plan that merely grew past this append.
                yield* get(plan.planId)
              }
              const moved = envelope !== undefined &&
                (envelope.generation !== plan.generation - 1 || envelope.flow !== plan.flow ||
                  envelope.base_digest !== plan.baseDigest)
              return yield* Effect.fail(
                moved || envelope === undefined
                  ? error(
                    "constraint",
                    `plan ${plan.planId} was never recorded, or generation ${plan.generation} was skipped or moved under the append`,
                    undefined
                  )
                  : error(
                    "constraint",
                    `plan ${plan.planId} recorded plan's nodes diverge from the plan this append was grown from`,
                    undefined
                  )
              )
            }
            yield* insertNodes(plan.planId, appended, prefix.length)
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const get: Service["get"] = Effect.fn("PlanStore.get")((planId) =>
      Effect.gen(function*() {
        const rows = yield* sql<Record<string, unknown>>`
        SELECT p.plan_id, p.flow, p.base_digest, p.digest, p.generation, n.node_json
        FROM flows_plans p LEFT JOIN flows_plan_nodes n ON n.plan_id = p.plan_id
        WHERE p.plan_id = ${planId} ORDER BY n.ordinal
      `.pipe(Effect.mapError(mapPersistenceError))
        if (rows.length === 0) return Option.none()
        // The `flows_plans` CHECK constraints only require nonempty digest
        // strings, while this row requires `StoredKey` syntax, so a legal
        // INSERT from outside this module reaches here.
        const row = yield* decodePlanRow(rows[0]).pipe(
          Effect.mapError((cause) => error("decode_failed", "could not decode flows_plans row", cause))
        )
        // One statement observes the envelope and nodes at the same generation,
        // even when another connection appends between reads.
        const nodes = yield* Effect.forEach(rows.filter((nodeRow) => nodeRow.node_json !== null), (nodeRow) =>
          decodeNode(nodeRow.node_json).pipe(
            Effect.mapError((cause) =>
              error("decode_failed", "could not decode flows_plan_nodes row", cause)
            )
          ))
        const plan = yield* verified({
          planId: row.plan_id,
          flow: row.flow,
          generation: row.generation,
          baseDigest: row.base_digest,
          digest: row.digest,
          nodes
        }).pipe(Effect.mapError((cause) => error("decode_failed", "stored plan failed integrity verification", cause)))
        return Option.some(plan)
      })
    )

    return { record, append, get }
  }
)

/**
 * Provides the SQL-backed plan store.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer: Layer.Layer<PlanStore, never, DurableWriter | SqlClient.SqlClient | Crypto.Crypto> = Layer.effect(
  PlanStore,
  make
)
