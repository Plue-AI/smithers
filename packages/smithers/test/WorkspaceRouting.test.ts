import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import * as WorkspaceRouting from "../src/internal/WorkspaceRouting.ts"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/workspace-routing-portable.ts", import.meta.url))

for (const runtime of ["node", "bun"]) {
  it(`uses the existing ${runtime} SQL clients for history admission`, async () => {
    const { stdout } = await execute(
      runtime,
      runtime === "node"
        ? ["--experimental-strip-types", fixture, runtime]
        : [fixture, runtime],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    )
    expect(JSON.parse(stdout)).toMatchObject({ runtime, passed: true })
  }, 65_000)
}

const databases = Effect.gen(function*() {
  const engine = Context.get(yield* Layer.build(NodeDatabase.layer({ filename: ":memory:" })), SqlClient)
  const control = Context.get(yield* Layer.build(NodeDatabase.layer({ filename: ":memory:" })), SqlClient)
  yield* engine`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY,parent_run_id TEXT)`
  yield* control`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY)`
  const routing = yield* WorkspaceRouting.make({ root: "./project", engine, control })
  return { engine, control, routing }
})

it("resolves ordinary ancestry before optional history tables have been installed", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const { engine, routing } = yield* databases
      yield* engine`INSERT INTO flows_runs VALUES('root',NULL),('child','root')`
      expect(yield* routing.workspaceFor("child")).toBe(resolve("project"))
      expect(yield* routing.canExecute("./project/nested/..", "child")).toBe(true)
      expect(yield* routing.canExecute("./elsewhere", "child")).toBe(false)
      expect(yield* routing.workspaceFor("unknown")).toBe(resolve("project"))
      yield* engine`INSERT INTO flows_runs VALUES('a','b'),('b','a')`
      const failure = yield* routing.workspaceFor("a").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "history/WorkspaceRoutingError", runId: "a" })
    }).pipe(Effect.provide(NodePath.layer), Effect.scoped)
  )
})

it("requires every active audit receipt to be committed, including on an unbound root", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const { engine, control, routing } = yield* databases
      yield* engine`INSERT INTO flows_runs VALUES('root',NULL)`
      yield* engine`CREATE TABLE flows_time_travel_audits(id TEXT,run_id TEXT,status TEXT)`
      yield* engine`INSERT INTO flows_time_travel_audits VALUES('irrelevant','root','failed')`
      expect(yield* routing.canExecute("./project", "root")).toBe(true)
      yield* engine`INSERT INTO flows_time_travel_audits VALUES('first','root','in_progress'),('second','root','completed')`
      expect(yield* routing.canExecute("./project", "root")).toBe(false)
      yield* control`CREATE TABLE smthrs_history_applied(audit_id TEXT PRIMARY KEY)`
      yield* control`INSERT INTO smthrs_history_applied VALUES('first')`
      expect(yield* routing.canExecute("./project", "root")).toBe(false)
      const rollback = yield* control.withTransaction(Effect.gen(function*() {
        yield* control`INSERT INTO smthrs_history_applied VALUES('second')`
        expect(yield* routing.canExecute("./project", "root")).toBe(false)
        return yield* Effect.fail("rollback")
      })).pipe(Effect.flip)
      expect(rollback).toBe("rollback")
      expect(yield* routing.canExecute("./project", "root")).toBe(false)
      yield* control`INSERT INTO smthrs_history_applied VALUES('second')`
      expect(yield* routing.canExecute("./project", "root")).toBe(true)
    }).pipe(Effect.provide(NodePath.layer), Effect.scoped)
  )
})

it("does not expose a fallback root when an uncommitted route deletion rolls back", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const { engine, control, routing } = yield* databases
      yield* engine`CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY,workspace TEXT)`
      yield* engine`CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT)`
      yield* engine`INSERT INTO flows_runs VALUES('root',NULL),('fork','root'),('child','fork')`
      yield* engine`INSERT INTO flows_time_travel_edges VALUES('fork','root','fork')`
      yield* engine`INSERT INTO smthrs_history_workspaces VALUES('fork','./project/fork')`
      expect(yield* routing.canExecute("./project/fork", "child")).toBe(false)
      yield* control`INSERT INTO flows_runs VALUES('fork')`
      expect(yield* routing.canExecute("./project/fork", "child")).toBe(true)
      yield* engine.withTransaction(Effect.gen(function*() {
        yield* engine`DELETE FROM smthrs_history_workspaces WHERE run_id='fork'`
        yield* engine`DELETE FROM flows_time_travel_edges WHERE child_run_id='fork'`
        expect(yield* routing.canExecute("./project", "child")).toBe(false)
        return yield* Effect.fail("rollback")
      })).pipe(Effect.flip)
      expect(yield* routing.workspaceFor("child")).toBe(resolve("project/fork"))
      expect(yield* routing.canExecute("./project/fork", "child")).toBe(true)
      yield* engine`DELETE FROM smthrs_history_workspaces WHERE run_id='fork'`
      expect(yield* routing.workspaceFor("child")).toBeUndefined()
      expect(yield* routing.canExecute("./project", "child")).toBe(false)
    }).pipe(Effect.provide(NodePath.layer), Effect.scoped)
  )
})

it("routes drive-letter workspaces under the win32 path", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const engine = Context.get(yield* Layer.build(NodeDatabase.layer({ filename: ":memory:" })), SqlClient)
      const control = Context.get(yield* Layer.build(NodeDatabase.layer({ filename: ":memory:" })), SqlClient)
      yield* engine`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY,parent_run_id TEXT)`
      yield* engine`CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY,workspace TEXT)`
      yield* engine`CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT)`
      yield* engine`INSERT INTO flows_runs VALUES('root',NULL),('fork','root'),('child','fork')`
      yield* engine`INSERT INTO flows_time_travel_edges VALUES('fork','root','fork')`
      yield* engine`INSERT INTO smthrs_history_workspaces VALUES('fork',${"D:\\work\\fork"})`
      yield* control`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY)`
      yield* control`INSERT INTO flows_runs VALUES('fork')`
      const routing = yield* WorkspaceRouting.make({ root: "D:\\work", engine, control })
      expect(yield* routing.canExecute("D:/work/", "root")).toBe(true)
      expect(yield* routing.workspaceFor("child")).toBe("D:\\work\\fork")
      expect(yield* routing.canExecute("D:/work/fork/", "child")).toBe(true)
      expect(yield* routing.canExecute("D:\\work", "child")).toBe(false)
    }).pipe(Effect.provide(NodePath.layerWin32), Effect.scoped)
  )
})
