import { Context, Effect, Layer, Path } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import * as WorkspaceRouting from "../../src/internal/WorkspaceRouting.ts"

const runtime = process.argv[2]
const database = runtime === "bun"
  ? await import("@smthrs/database/bun/BunDatabase")
  : await import("@smthrs/database/node/NodeDatabase")

await Effect.runPromise(
  Effect.scoped(Effect.gen(function*() {
    const engine = Context.get(yield* Layer.build(database.layer({ filename: ":memory:" })), SqlClient)
    const control = Context.get(yield* Layer.build(database.layer({ filename: ":memory:" })), SqlClient)
    for (
      const statement of [
        "CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY,parent_run_id TEXT)",
        "CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY,workspace TEXT)",
        "CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT)",
        "CREATE TABLE flows_time_travel_audits(id TEXT,run_id TEXT,status TEXT)",
        "INSERT INTO flows_runs VALUES('original',NULL),('fork','original'),('descendant','fork')",
        "INSERT INTO flows_time_travel_edges VALUES('fork','original','fork')",
        "INSERT INTO smthrs_history_workspaces VALUES('fork','/project/branch')"
      ]
    ) yield* engine.unsafe(statement)
    yield* control`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY)`
    const routing = yield* WorkspaceRouting.make({ root: "/project", engine, control })
    assert.equal(yield* routing.canExecute("/project", "original"), true)
    assert.equal(yield* routing.canExecute("/wrong", "original"), false)
    assert.equal(yield* routing.workspaceFor("descendant"), "/project/branch")
    assert.equal(yield* routing.canExecute("/project/branch", "descendant"), false)
    yield* control`INSERT INTO flows_runs VALUES('descendant')`
    assert.equal(yield* routing.canExecute("/project/branch", "descendant"), false)

    const rolledBack = yield* control.withTransaction(Effect.gen(function*() {
      yield* control`INSERT INTO flows_runs VALUES('fork')`
      assert.equal(yield* routing.canExecute("/project/branch", "fork"), false)
      assert.equal(yield* routing.canExecute("/project/branch", "descendant"), false)
      assert.equal(yield* routing.canExecute("/project", "original"), true)
      return yield* Effect.fail("rollback")
    })).pipe(Effect.flip)
    assert.equal(rolledBack, "rollback")
    assert.equal(yield* routing.canExecute("/project/branch", "descendant"), false)
    yield* control.withTransaction(control`INSERT INTO flows_runs VALUES('fork')`)
    assert.equal(yield* routing.canExecute("/project/branch", "fork"), true)
    assert.equal(yield* routing.canExecute("/project/branch", "descendant"), true)
    assert.equal(yield* routing.canExecute("/project", "descendant"), false)
    yield* engine.withTransaction(Effect.gen(function*() {
      yield* engine`UPDATE smthrs_history_workspaces SET workspace='/project/provisional' WHERE run_id='fork'`
      assert.equal(yield* routing.canExecute("/project/provisional", "fork"), false)
      assert.equal(yield* routing.canExecute("/project", "original"), false)
      return yield* Effect.fail("rollback-route")
    })).pipe(Effect.flip)
    assert.equal(yield* routing.canExecute("/project/branch", "fork"), true)

    yield* engine`INSERT INTO flows_runs VALUES('nested','descendant'),('leaf','nested')`
    yield* engine`INSERT INTO flows_time_travel_edges VALUES('nested','descendant','fork')`
    assert.equal(yield* routing.workspaceFor("leaf"), undefined)
    assert.equal(yield* routing.canExecute("/project/branch", "leaf"), false)
    yield* engine`INSERT INTO smthrs_history_workspaces VALUES('nested','/project/nested')`
    assert.equal(yield* routing.workspaceFor("leaf"), "/project/nested")
    assert.equal(yield* routing.canExecute("/project/nested", "leaf"), false)
    yield* control`INSERT INTO flows_runs VALUES('nested')`
    assert.equal(yield* routing.canExecute("/project/nested", "leaf"), true)

    yield* engine`INSERT INTO flows_time_travel_audits VALUES('a','fork','in_progress'),('b','fork','completed')`
    assert.equal(yield* routing.canExecute("/project/branch", "fork"), false)
    yield* control`CREATE TABLE smthrs_history_applied(audit_id TEXT PRIMARY KEY)`
    yield* control`INSERT INTO smthrs_history_applied VALUES('a')`
    assert.equal(yield* routing.canExecute("/project/branch", "fork"), false)
    yield* control`INSERT INTO smthrs_history_applied VALUES('b')`
    assert.equal(yield* routing.canExecute("/project/branch", "fork"), true)
    const beforeEngine = yield* engine`SELECT total_changes() AS count`
    const beforeControl = yield* control`SELECT total_changes() AS count`
    for (let i = 0; i < 3; i++) assert.equal(yield* routing.canExecute("/project/branch", "fork"), true)
    assert.deepEqual(yield* engine`SELECT total_changes() AS count`, beforeEngine)
    assert.deepEqual(yield* control`SELECT total_changes() AS count`, beforeControl)

    yield* engine`INSERT INTO flows_runs VALUES('cycle-a','cycle-b'),('cycle-b','cycle-a')`
    const failure = yield* routing.canExecute("/project", "cycle-a").pipe(Effect.flip)
    assert.equal(failure._tag, "history/WorkspaceRoutingError")
    assert.equal(yield* routing.canExecute("/project", "original"), true)
    process.stdout.write(
      JSON.stringify({
        runtime,
        passed: true,
        checks:
          "committed routing and identity, rollback, inherited routes, unlinked forks, complete audits, cycle refusal, read-only queries"
      }) + "\n"
    )
  })).pipe(
    // POSIX by design: the routes are literal `/project` strings, never host
    // paths, so the same assertions hold on every host.
    Effect.provide(Path.layer)
  )
)
