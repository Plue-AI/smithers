/**
 * Owner-fenced scheduler decisions, distinct from action failure evidence and
 * redacted journal projections. Intent survives before a merge is appended.
 * @since 1.0.0
 */

import { Sha256 } from "@smthrs/crypto"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Plan } from "@smthrs/plan"
import { OwnerId } from "@smthrs/run-store/Ownership"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Names = Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(Plan.maximumPlanNodes))

/** Execution binding shared by every decision of one plan run.
 * @since 1.0.0
 * @category schemas
 */
export const Identity = Schema.Struct({
  runId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  baseDigest: Schema.NonEmptyString,
  environmentDigest: Schema.NonEmptyString
})
/** Execution binding.
 * @since 1.0.0
 * @category models
 */
export type Identity = typeof Identity.Type
/** A stopped attempt and the exact cohort eligible to supply merge winners.
 * @since 1.0.0
 * @category schemas
 */
export const Intent = Schema.Struct({
  version: Schema.Literal(1),
  nodeId: Schema.NonEmptyString,
  nodeKey: Schema.NonEmptyString,
  dispatchKey: Schema.NonEmptyString,
  attempts: Positive,
  rebases: Natural,
  peers: Names
})
/** Durable stopped-attempt decision.
 * @since 1.0.0
 * @category models
 */
export type Intent = typeof Intent.Type
/** The plan extension committed for an intent.
 * @since 1.0.0
 * @category schemas
 */
export const Completion = Schema.Struct({
  version: Schema.Literal(1),
  generation: Positive,
  parentDigest: Schema.NonEmptyString,
  planDigest: Schema.NonEmptyString,
  mergeId: Schema.NonEmptyString,
  mergeKey: Schema.NonEmptyString,
  winners: Names
})
/** Committed merge extension.
 * @since 1.0.0
 * @category models
 */
export type Completion = typeof Completion.Type
/** Intent with its optional committed extension.
 * @since 1.0.0
 * @category models
 */
export interface Decision {
  readonly intent: Intent
  readonly completion?: Completion
}
/** Typed admission/storage refusal.
 * @since 1.0.0
 * @category errors
 */
export class PlanMergeError extends Schema.TaggedError<PlanMergeError>()("@smthrs/engine-store/PlanMergeError", {
  code: Schema.Literals([
    "invalid_input",
    "corrupt_state",
    "incompatible_state",
    "fence_lost",
    "transaction_open",
    "transaction_required",
    "persistence_failed"
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
/** Store operations; writes may join the owning transaction, reads require committed state.
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly list: (identity: Identity, owner: OwnerId) => Effect.Effect<ReadonlyArray<Decision>, PlanMergeError>
  readonly intend: (identity: Identity, intent: Intent, owner: OwnerId) => Effect.Effect<Intent, PlanMergeError>
  readonly complete: (
    identity: Identity,
    nodeId: string,
    completion: Completion,
    owner: OwnerId
  ) => Effect.Effect<Completion, PlanMergeError>
}
/** Durable merge decision service.
 * @since 1.0.0
 * @category services
 */
export class PlanMergeStore extends Context.Service<PlanMergeStore, Service>()("@smthrs/engine-store/PlanMergeStore") {}
/** Encoded decision limit, in JavaScript code units.
 * @since 1.0.0
 * @category constants
 */
export const maximumDecisionCharacters = 16 * 1024 * 1024
const error = (code: PlanMergeError["code"], message: string, cause?: unknown) =>
  new PlanMergeError({ code, message, ...(cause === undefined ? {} : { cause }) })
const storageError = (cause: unknown) =>
  cause instanceof PlanMergeError ? cause : error("persistence_failed", "could not access plan merge decisions", cause)
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  code: "invalid_input" | "corrupt_state"
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }),
    catch: (cause) => error(code, "invalid plan merge decision", cause)
  })
const unique = (names: ReadonlyArray<string>, code: "invalid_input" | "corrupt_state") =>
  new Set(names).size === names.length ? Effect.void : Effect.fail(error(code, "duplicate merge peer identity"))

/** SQL constructor; all collaborating stores must use the same database/writer.
 * @since 1.0.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, SqlClient.SqlClient | DurableWriter | Crypto.Crypto> = Effect.gen(
  function*() {
    const sql = yield* SqlClient.SqlClient
    const writer = yield* DurableWriter
    const crypto = yield* Effect.context<Crypto.Crypto>()
    const hash = (value: string) => Schema.decodeUnknownEffect(Sha256)(value).pipe(Effect.provide(crypto))
    const fence = (identity: Identity, owner: OwnerId, requireHead: boolean) =>
      Effect.gen(function*() {
        const owned = yield* sql`SELECT run_id FROM flows_runs WHERE run_id = ${identity.runId}
      AND status = 'running' AND cancel_requested_at_ms IS NULL
      AND owner_host_id = ${owner.hostId} AND owner_pid = ${owner.pid} AND owner_nonce = ${owner.nonce}`
        if (owned.length !== 1) {
          return yield* Effect.fail(error("fence_lost", "merge decision owner no longer owns the run"))
        }
        const heads = yield* sql<
          { planId: string; baseDigest: string; environmentDigest: string | null; version: number | null }
        >`SELECT
      plan_id AS "planId", base_digest AS "baseDigest", environment_digest AS "environmentDigest", merge_state_version AS version
      FROM flows_plan_input_heads WHERE run_id = ${identity.runId}`
        const head = heads[0]
        if (head === undefined) {
          const orphan = yield* sql`SELECT 1 FROM flows_plan_merge_intents WHERE run_id = ${identity.runId} LIMIT 1`
          if (requireHead || orphan.length > 0) {
            return yield* Effect.fail(error("corrupt_state", "merge intent has no admitted input generation"))
          }
          return
        }
        if (
          head.version !== 1 || head.planId !== identity.planId || head.baseDigest !== identity.baseDigest ||
          head.environmentDigest !== identity.environmentDigest
        ) {
          return yield* Effect.fail(
            error(
              "incompatible_state",
              "this run has different or unrecorded merge execution state; recover with its original runtime or reconcile before starting a new run"
            )
          )
        }
      })
    const encoded = <A>(value: A) =>
      Effect.gen(function*() {
        const json = JSON.stringify(value)
        if (json.length > maximumDecisionCharacters) {
          return yield* Effect.fail(error("invalid_input", "merge decision exceeds its durable size limit"))
        }
        return { json, checksum: yield* hash(json) }
      })
    const stored = <S extends Schema.Top & { readonly DecodingServices: never }>(
      schema: S,
      row: { json: string; checksum: string }
    ) =>
      Effect.gen(function*() {
        if (row.json.length > maximumDecisionCharacters || (yield* hash(row.json)) !== row.checksum) {
          return yield* Effect.fail(error("corrupt_state", "merge decision failed its size or integrity check"))
        }
        return yield* decode(Schema.fromJsonString(schema), row.json, "corrupt_state")
      })
    const load = (identity: Identity, nodeId?: string) =>
      Effect.gen(function*() {
        const rows = yield* sql<
          {
            nodeId: string
            json: string
            checksum: string
            generation: number | null
            mergeId: string | null
            completionJson: string | null
            completionChecksum: string | null
          }
        >`SELECT i.stopped_node_id AS "nodeId", i.intent_json AS json, i.checksum,
        c.generation, c.merge_node_id AS "mergeId", c.completion_json AS "completionJson",
        c.checksum AS "completionChecksum"
      FROM flows_plan_merge_intents i LEFT JOIN flows_plan_merge_completions c
        ON c.run_id = i.run_id AND c.stopped_node_id = i.stopped_node_id
      WHERE i.run_id = ${identity.runId} ${nodeId === undefined ? sql`` : sql`AND i.stopped_node_id = ${nodeId}`}
      ORDER BY i.stopped_node_id LIMIT ${Plan.maximumPlanNodes + 1}`
        if (rows.length > Plan.maximumPlanNodes) {
          return yield* Effect.fail(error("corrupt_state", "too many merge decisions for one plan"))
        }
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function*() {
            const intent = yield* stored(Intent, row)
            yield* unique(intent.peers, "corrupt_state")
            if (intent.nodeId !== row.nodeId || intent.peers.includes(intent.nodeId)) {
              return yield* Effect.fail(error("corrupt_state", "merge intent identity is inconsistent"))
            }
            if (row.completionJson === null) return { intent } satisfies Decision
            const completion = yield* stored(Completion, {
              json: row.completionJson,
              checksum: row.completionChecksum!
            })
            yield* unique(completion.winners, "corrupt_state")
            if (
              completion.generation !== row.generation || completion.mergeId !== row.mergeId ||
              completion.winners.some((id) => !intent.peers.includes(id))
            ) {
              return yield* Effect.fail(error("corrupt_state", "merge completion does not match its intent"))
            }
            return { intent, completion } satisfies Decision
          }))
      })
    const list: Service["list"] = (input, ownerInput) =>
      Effect.gen(function*() {
        const identity = yield* decode(Identity, input, "invalid_input")
        const owner = yield* decode(OwnerId, ownerInput, "invalid_input")
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
          return yield* Effect.fail(error("transaction_open", "merge recovery requires committed decisions"))
        }
        return yield* writer.write(Effect.gen(function*() {
          yield* fence(identity, owner, false)
          return yield* load(identity)
        }))
      }).pipe(Effect.mapError(storageError))
    const intend: Service["intend"] = (input, value, ownerInput) =>
      Effect.gen(function*() {
        const identity = yield* decode(Identity, input, "invalid_input")
        const owner = yield* decode(OwnerId, ownerInput, "invalid_input")
        const intent = yield* decode(Intent, value, "invalid_input")
        yield* unique(intent.peers, "invalid_input")
        if (intent.peers.includes(intent.nodeId)) {
          return yield* Effect.fail(error("invalid_input", "a merge cannot stop its own peer"))
        }
        const data = yield* encoded(intent)
        return yield* writer.write(Effect.gen(function*() {
          yield* fence(identity, owner, true)
          const [existing] = yield* load(identity, intent.nodeId)
          if (existing !== undefined) return existing.intent
          const [count] = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM flows_plan_merge_intents WHERE run_id = ${identity.runId}`
          if (count!.count >= Plan.maximumPlanNodes) {
            return yield* Effect.fail(error("invalid_input", "too many merge intents for one plan"))
          }
          yield* sql`INSERT INTO flows_plan_merge_intents (run_id, stopped_node_id, intent_json, checksum)
        VALUES (${identity.runId}, ${intent.nodeId}, ${data.json}, ${data.checksum})`
          return intent
        }))
      }).pipe(Effect.mapError(storageError))
    const complete: Service["complete"] = (input, nodeIdInput, value, ownerInput) =>
      Effect.gen(function*() {
        if (Option.isNone(yield* Effect.serviceOption(sql.transactionService))) {
          return yield* Effect.fail(
            error("transaction_required", "merge completion must join the plan/input append transaction")
          )
        }
        const identity = yield* decode(Identity, input, "invalid_input")
        const owner = yield* decode(OwnerId, ownerInput, "invalid_input")
        const nodeId = yield* decode(Schema.NonEmptyString, nodeIdInput, "invalid_input")
        const completion = yield* decode(Completion, value, "invalid_input")
        yield* unique(completion.winners, "invalid_input")
        const data = yield* encoded(completion)
        return yield* writer.write(Effect.gen(function*() {
          yield* fence(identity, owner, true)
          const [decision] = yield* load(identity, nodeId)
          if (decision === undefined) {
            return yield* Effect.fail(error("corrupt_state", "merge completion has no intent"))
          }
          if (decision.completion !== undefined) {
            if (JSON.stringify(decision.completion) !== JSON.stringify(completion)) {
              return yield* Effect.fail(
                error("incompatible_state", "a merge intent already committed a different extension")
              )
            }
            return decision.completion
          }
          if (completion.winners.some((id) => !decision.intent.peers.includes(id))) {
            return yield* Effect.fail(error("invalid_input", "merge winner was not an admitted peer"))
          }
          const appended =
            yield* sql`SELECT p.plan_id FROM flows_plans p JOIN flows_plan_input_generations i ON i.plan_id = p.plan_id
        JOIN flows_plan_nodes n ON n.plan_id = p.plan_id AND n.generation = p.generation
        WHERE p.plan_id = ${identity.planId} AND p.digest = ${completion.planDigest} AND p.generation = ${completion.generation}
        AND i.run_id = ${identity.runId} AND i.generation = ${completion.generation}
        AND n.node_id = ${completion.mergeId} AND n.key_digest = ${completion.mergeKey} AND n.kind = 'merge'`
          if (appended.length !== 1) {
            return yield* Effect.fail(
              error("corrupt_state", "merge completion requires its plan and input generation in the same transaction")
            )
          }
          yield* sql`INSERT INTO flows_plan_merge_completions (run_id, stopped_node_id, generation, merge_node_id, completion_json, checksum)
        VALUES (${identity.runId}, ${nodeId}, ${completion.generation}, ${completion.mergeId}, ${data.json}, ${data.checksum})`
          return completion
        }))
      }).pipe(Effect.mapError(storageError))
    return { list, intend, complete }
  }
)
/** SQL-backed merge decisions; migrations must run first.
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<PlanMergeStore, never, SqlClient.SqlClient | DurableWriter | Crypto.Crypto> = Layer
  .effect(PlanMergeStore)(make)
