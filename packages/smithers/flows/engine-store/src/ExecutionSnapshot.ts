/**
 * Revisioned, round-scoped engine observations.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import type { RunStoreError } from "@smthrs/run-store/RunStore"
import { Context, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Read from "./internal/ExecutionSnapshotRead.ts"
import * as Relations from "./internal/ExecutionSnapshotRelations.ts"

export type { RelatedOptions, RelatedPage } from "./internal/ExecutionSnapshotRelations.ts"

/**
 * Engine database identity and observed watermark.
 *
 * @category models
 * @since 1.0.0
 */
export type Position = Read.Position
/**
 * An authoritative execution row.
 *
 * @category models
 * @since 1.0.0
 */
export type Observed = Read.Observed
/**
 * A structured durable wait.
 *
 * @category models
 * @since 1.0.0
 */
export type Waiting = Read.Waiting
/**
 * Absence is explicit; deleted distinguishes retained deletion evidence.
 *
 * @category models
 * @since 1.0.0
 */
export interface Missing extends Position {
  readonly _tag: "Missing"
  readonly runId: string
  readonly deleted: boolean
}
/**
 * One requested execution observation.
 *
 * @category models
 * @since 1.0.0
 */
export type Snapshot = Observed | Missing
/**
 * Coherent observations in request order, including duplicates.
 *
 * @category models
 * @since 1.0.0
 */
export interface Batch extends Position {
  readonly snapshots: ReadonlyArray<Snapshot>
}
/**
 * Maximum IDs admitted by one read.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumBatchSize = 200
/**
 * Engine observation operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly read: (runIds: ReadonlyArray<string>) => Effect.Effect<Batch, RunStoreError>
  readonly related: (options: Relations.RelatedOptions) => Effect.Effect<Relations.RelatedPage, RunStoreError>
}
/**
 * Engine observation service.
 *
 * @category services
 * @since 1.0.0
 */
export class ExecutionSnapshot extends Context.Service<ExecutionSnapshot, Service>()(
  "@smthrs/engine-store/ExecutionSnapshot"
) {}

/**
 * Guard for applying observations and tombstones to a source-bound projection.
 * Source replacement requires an explicit rebuild, never a revision comparison.
 * @category guards
 * @since 1.0.0
 */
export const isNewer = (incoming: Position, current: Position): boolean =>
  incoming.source === current.source && incoming.revision > current.revision

/**
 * Constructs the SQL read port; migrations must already be applied.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (): Effect.Effect<Service, never, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const read: Service["read"] = (runIds) =>
      Read.boundary(
        "ExecutionSnapshot.read",
        Effect.gen(function*() {
          const ids = yield* Read.decode(
            Schema.Array(Read.Identifier).check(Schema.isMaxLength(maximumBatchSize)),
            runIds
          )
          return yield* Read.transaction(
            sql,
            Effect.gen(function*() {
              const at = yield* Read.position(sql)
              if (ids.length === 0) return { ...at, snapshots: [] }
              const rows = yield* Dialect.query(
                sql,
                `SELECT ${Read.selectColumns} FROM flows_runs r
            LEFT JOIN flows_run_changes c ON c.run_id = r.run_id
            WHERE r.run_id IN (${ids.map(() => "?").join(",")})`,
                ids
              )
              const snapshots = new Map<string, Snapshot>()
              for (const row of rows) {
                const value = yield* Read.observed(row, at)
                snapshots.set(value.runId, value)
              }
              const changes = yield* Dialect.query<{ run_id: string; revision: number; deleted: number }>(
                sql,
                `SELECT run_id, revision, deleted FROM flows_run_changes WHERE run_id IN (${
                  ids.map(() => "?").join(",")
                })`,
                ids
              )
              for (const change of changes) {
                if (snapshots.has(change.run_id)) continue
                const revision = yield* Read.decode(
                  Read.Natural.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(at.revision)),
                  change.revision
                )
                yield* Read.decode(Schema.Literal(1), change.deleted)
                snapshots.set(change.run_id, {
                  _tag: "Missing",
                  runId: change.run_id,
                  source: at.source,
                  revision,
                  deleted: true
                })
              }
              return {
                ...at,
                snapshots: ids.map((runId): Snapshot =>
                  snapshots.get(runId) ?? { _tag: "Missing", runId, ...at, deleted: false }
                )
              }
            })
          )
        })
      )
    return { read, related: Relations.make(sql, read) }
  })

/**
 * Provides the SQL observation port.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<ExecutionSnapshot, never, SqlClient.SqlClient> = Layer.effect(ExecutionSnapshot)(make())
