/**
 * Portable history admission over the control and engine SQL clients the host
 * already owns, shared by the host and native CLI.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { Effect, Option, Path, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/** Corrupt ancestry cannot grant permission to execute a workspace.
 * @since 1.0.0
 * @category errors
 */
export class WorkspaceRoutingError
  extends Schema.TaggedError<WorkspaceRoutingError>()("history/WorkspaceRoutingError", {
    runId: Schema.String,
    message: Schema.String
  })
{}

/** Captured clients are separate authorities; this module opens no database.
 * @since 1.0.0
 * @category models
 */
export interface Options {
  readonly root: string
  readonly engine: SqlClient
  readonly control: SqlClient | undefined
}

interface ResolvedWorkspace {
  readonly path: string
  readonly boundRunId?: string
}

const hasTable = (sql: SqlClient, name: string) =>
  Dialect.tables(sql).pipe(Effect.map((rows) => rows.some((row) => row.name === name)))

/** Build the admission functions once in the host's existing Effect scope.
 * @since 1.0.0
 * @category constructors
 */
export const make = ({ root, engine, control }: Options) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const rootPath = path.resolve(root)

    const resolveWorkspace = (
      runId: string
    ): Effect.Effect<ResolvedWorkspace | undefined, SqlError | WorkspaceRoutingError> =>
      Effect.gen(function*() {
        const routes = yield* hasTable(engine, "smthrs_history_workspaces")
        const edges = yield* hasTable(engine, "flows_time_travel_edges")
        const seen = new Set<string>()
        let id: string | null = runId
        while (id !== null) {
          if (seen.has(id)) return yield* new WorkspaceRoutingError({ runId, message: `Cyclic run ancestry at ${id}` })
          seen.add(id)
          if (routes) {
            const route = yield* engine<
              { workspace: string }
            >`SELECT workspace FROM smthrs_history_workspaces WHERE run_id=${id}`
            if (route[0] !== undefined) return { path: path.resolve(route[0].workspace), boundRunId: id }
          }
          if (edges) {
            const fork = yield* engine`SELECT 1 FROM flows_time_travel_edges WHERE child_run_id=${id} AND kind='fork'`
            if (fork.length > 0) return undefined
          }
          const rows: ReadonlyArray<{ parent_run_id: string | null }> = yield* engine<
            { parent_run_id: string | null }
          >`SELECT parent_run_id FROM flows_runs WHERE run_id=${id}`
          id = rows[0]?.parent_run_id ?? null
        }
        return { path: rootPath }
      })

    return {
      workspaceFor: (runId: string) => resolveWorkspace(runId).pipe(Effect.map((route) => route?.path)),
      canExecute: (workspace: string, runId: string) =>
        Effect.gen(function*() {
          // Routing itself must also be committed. Seeing a provisional route or
          // its deletion through an ambient engine transaction cannot grant entry.
          if (Option.isSome(yield* Effect.serviceOption(engine.transactionService))) return false
          const expected = yield* resolveWorkspace(runId)
          if (expected === undefined || expected.path !== path.resolve(workspace)) return false
          if (control === undefined) return expected.boundRunId === undefined
          const audits = (yield* hasTable(engine, "flows_time_travel_audits"))
            ? yield* engine<
              { id: string }
            >`SELECT id FROM flows_time_travel_audits WHERE run_id=${runId} AND status IN ('in_progress','completed')`
            : []
          if (audits.length === 0 && expected.boundRunId === undefined) return true
          // The legacy guard observes committed control state through an independent
          // read connection. An ambient transaction on the captured control client
          // would see uncommitted identity rows; refuse instead of treating them as
          // proof or waiting on the connection held by our own transaction.
          if (Option.isSome(yield* Effect.serviceOption(control.transactionService))) return false
          if (expected.boundRunId !== undefined) {
            const identity = yield* control`SELECT 1 FROM flows_runs WHERE run_id=${expected.boundRunId}`
            if (identity.length === 0) return false
          }
          if (audits.length === 0) return true
          if (!(yield* hasTable(control, "smthrs_history_applied"))) return false
          for (const audit of audits) {
            const applied = yield* control`SELECT 1 FROM smthrs_history_applied WHERE audit_id=${audit.id}`
            if (applied.length === 0) return false
          }
          return true
        })
    }
  })
