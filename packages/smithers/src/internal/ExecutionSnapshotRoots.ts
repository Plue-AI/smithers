/**
 * Snapshot liveness follows existing run rows and ancestry across both stores.
 * @since 1.0.0
 */

import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { existsSync } from "node:fs"

class SnapshotRootError extends Schema.TaggedError<SnapshotRootError>()(
  "@smthrs/cli/SnapshotRootError",
  { message: Schema.String }
) {}

interface Row {
  readonly runId: string
  readonly status: string
  readonly parentRunId: string | null
  readonly stateJson: string | null
}
interface Edge {
  readonly childId: string
  readonly parentId: string
}

/**
 * Reads all live roots before sweeping. Invalid state fails the whole mark.
 * @since 1.0.0
 * @private
 */
export const live = (files: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const rows: Array<Row> = []
    const edges: Array<Edge> = []
    for (const filename of files) {
      if (!existsSync(filename)) continue
      const found = yield* Effect.gen(function*() {
        const sql = yield* SqlClient
        const tables = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
        if (!tables.some((table) => table.name === "flows_runs")) return { rows: [], edges: [] }
        const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(flows_runs)`
        const state = columns.some((column) => column.name === "state_json")
          ? sql.literal("state_json") :
          sql.literal("NULL")
        const runs = yield* sql<Row>`SELECT run_id AS "runId", status, parent_run_id AS "parentRunId",
        ${state} AS "stateJson" FROM flows_runs`
        const parents = tables.some((table) => table.name === "flows_run_parents")
          ? yield* sql<Edge>`SELECT child_id AS "childId", parent_id AS "parentId" FROM flows_run_parents`
          : []
        return { rows: runs, edges: parents }
      }).pipe(Effect.provide(NodeDatabase.layer({ filename })))
      rows.push(...found.rows)
      edges.push(...found.edges)
    }
    const parents = new Map<string, Set<string>>()
    for (const row of rows) if (row.parentRunId !== null) edges.push({ childId: row.runId, parentId: row.parentRunId })
    for (const edge of edges) {
      const values = parents.get(edge.childId) ?? new Set<string>()
      values.add(edge.parentId)
      parents.set(edge.childId, values)
    }
    const pending = rows.filter((row) => !["completed", "failed", "cancelled"].includes(row.status)).map((row) =>
      row.runId
    )
    const live = new Set<string>()
    while (pending.length > 0) {
      const id = pending.pop()!
      if (live.has(id)) continue
      live.add(id)
      pending.push(...(parents.get(id) ?? []))
    }
    const digests = new Set<string>()
    for (const row of rows) {
      if (!live.has(row.runId) || row.stateJson === null) continue
      const state = yield* Effect.try(() => JSON.parse(row.stateJson!) as { readonly executionDigest?: unknown })
      if (state.executionDigest === undefined) continue
      if (typeof state.executionDigest !== "string" || !/^[a-f0-9]{64}$/.test(state.executionDigest)) {
        return yield* Effect.fail(new SnapshotRootError({ message: "Invalid live execution snapshot identity" }))
      }
      digests.add(state.executionDigest)
    }
    return { runIds: [...live], digests: [...digests] }
  })
