import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import { forkWorkspaceName } from "@smthrs/time-travel/TimeTravel"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import * as History from "../src/history/History.ts"
import * as Workspace from "../src/history/Workspace.ts"
import * as ControlDatabaseMigrations from "../src/internal/ControlDatabaseMigrations.ts"

it(
  "reads and reconciles PostgreSQL history without SQLite files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "postgres-history-"))
    const prefix = `test_history_${randomUUID().replaceAll("-", "")}`
    vi.stubEnv("SMITHERS_POSTGRES_URL", process.env.SMITHERS_HISTORY_TEST_PG_URL!)
    vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
    vi.stubEnv("SMITHERS_BACKEND", "postgres")
    const database = (kind: string) => NodeDatabase.layer({ filename: join(root, ".flows", `${kind}.db`) })
    const query = <A, E>(kind: string, body: Effect.Effect<A, E, SqlClient>) =>
      Effect.runPromise(body.pipe(Effect.provide(database(kind))))
    try {
      await Effect.runPromise(Effect.void.pipe(
        Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeCrypto.layer)
      ))
      await Effect.runPromise(
        Effect.void.pipe(Effect.provide(ControlDatabaseMigrations.layer), Effect.provide(database("control")))
      )
      await query("engine", TimeTravelMigrations.run)
      await query(
        "engine",
        Effect.gen(function*() {
          const sql = yield* SqlClient
          for (const id of ["parent", "child"]) {
            yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES(${id},'suspended',0,${
              JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
            })`
          }
          yield* sql`INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('parent',1,'one','source',1,0,'example.output','{"value":"retained"}','{"lineageId":"parent/root"}')`
          yield* sql`INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES('parent',1,'child','fork',0)`
        })
      )
      await query(
        "control",
        Effect.gen(function*() {
          const sql = yield* SqlClient
          yield* sql`INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan','{}','{}','approved')`
          yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('parent','suspended',0,${
            JSON.stringify({
              runId: "parent",
              planId: "plan",
              flowId: "fixture",
              status: "parked",
              createdAt: 0,
              updatedAt: 0
            })
          })`
        })
      )
      expect(existsSync(join(root, ".flows", "engine.db"))).toBe(false)
      expect((await History.read(root, "parent", {}, false)).status).toBe("suspended")
      expect(await Workspace.workspaceFor(root, "child")).toBeUndefined()
      const workspace = join(root, ".flows", "forks", forkWorkspaceName("child"))
      await mkdir(join(workspace, ".jj"), { recursive: true })
      await History.reconcile(root)
      expect(await History.prepare(root, "child")).toEqual({ executionRoot: workspace })
      expect(await Workspace.canExecute(root, workspace, "child")).toBe(true)
      expect(await Workspace.canExecute(root, root, "child")).toBe(false)
      await query(
        "engine",
        Effect.gen(function*() {
          const sql = yield* SqlClient
          yield* sql`INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status) VALUES('rewound','parent','parent/root',1,'completed')`
        })
      )
      expect(await Workspace.canExecute(root, root, "parent")).toBe(false)
      await History.reconcile(root)
      expect(await Workspace.canExecute(root, root, "parent")).toBe(true)
    } finally {
      for (const kind of ["engine", "control"]) {
        await query(
          kind,
          Effect.gen(function*() {
            const sql = yield* SqlClient
            yield* sql`DROP SCHEMA ${sql(`${prefix}_${kind}_db`)} CASCADE`
          })
        )
      }
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  }
)
