/** Durable workspace routing shared by the CLI and every engine host.
 * @since 1.0.0
 */

import { NodeServices } from "@effect/platform-node"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { resolve } from "node:path"
import { databasePath } from "../internal/ControlDatabasePath.ts"
import * as DatabaseLocation from "../internal/DatabaseLocation.ts"
import { executionDatabasePath } from "../internal/ExecutionDatabasePath.ts"
import * as WorkspaceRouting from "../internal/WorkspaceRouting.ts"

const routing = (root: string) =>
  Effect.gen(function*() {
    const engine = Context.get(
      yield* Layer.build(NodeDatabase.layer({
        filename: executionDatabasePath(root),
        sqlite: { readonly: true, disableWAL: true }
      })),
      SqlClient
    )
    const control = DatabaseLocation.exists(databasePath(root))
      ? Context.get(
        yield* Layer.build(NodeDatabase.layer({
          filename: databasePath(root),
          sqlite: { readonly: true, disableWAL: true }
        })),
        SqlClient
      )
      : undefined
    return yield* WorkspaceRouting.make({ root, engine, control })
  })

/** Undefined means a fork has not finished linking its retained workspace.
 * @category getters
 * @since 1.0.0
 */
export const workspaceFor = async (root: string, runId: string): Promise<string | undefined> => {
  if (!DatabaseLocation.exists(executionDatabasePath(root))) return resolve(root)
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      return yield* (yield* routing(root)).workspaceFor(runId)
    })).pipe(Effect.provide(NodeServices.layer))
  )
}

/** Only the host bound to a committed workspace identity may execute its run.
 * @category guards
 * @since 1.0.0
 */
export const canExecute = async (root: string, workspace: string, runId: string): Promise<boolean> => {
  if (!DatabaseLocation.exists(executionDatabasePath(root))) return resolve(root) === resolve(workspace)
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      return yield* (yield* routing(root)).canExecute(workspace, runId)
    })).pipe(Effect.provide(NodeServices.layer))
  )
}
