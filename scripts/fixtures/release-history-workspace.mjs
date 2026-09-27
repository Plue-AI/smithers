import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const mode = process.argv[2]
assert.ok(mode === "esm" || mode === "cjs")
const require = createRequire(import.meta.url)
const Workspace = mode === "cjs"
  ? require("@smthrs/cli/history/Workspace")
  : await import("@smthrs/cli/history/Workspace")
const root = mkdtempSync(join(tmpdir(), "smthrs-installed-history-"))
const workspace = join(root, "retained-worktree")
const enginePath = join(root, ".flows", "engine.db")
const controlPath = join(root, ".flows", "control.db")

try {
  mkdirSync(join(root, ".flows"))
  const engine = new DatabaseSync(enginePath)
  try {
    // Every 1.0 database carries the migration ledger; a file without it is
    // refused as 0.x state before routing reads it.
    engine.exec(`
      CREATE TABLE flows_migrations(migration_id INTEGER PRIMARY KEY NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, name VARCHAR(255) NOT NULL);
      CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY, parent_run_id TEXT);
      INSERT INTO flows_runs VALUES('parent',NULL),('child','parent'),('grandchild','child');
      CREATE TABLE flows_time_travel_edges(child_run_id TEXT, parent_run_id TEXT, kind TEXT);
      INSERT INTO flows_time_travel_edges VALUES('child','parent','fork');
      CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY, workspace TEXT);
    `)
    engine.prepare("INSERT INTO smthrs_history_workspaces VALUES('child',?)").run(workspace)
  } finally {
    engine.close()
  }
  const engineBefore = readFileSync(enginePath)
  const checkAdmission = async (allowed, reason) => {
    for (const runId of ["child", "grandchild"]) {
      assert.equal(await Workspace.workspaceFor(root, runId), workspace, `${mode}: retained route for ${runId}`)
      assert.equal(await Workspace.canExecute(root, workspace, runId), allowed, `${mode}: ${reason}: ${runId}`)
      assert.equal(await Workspace.canExecute(root, root, runId), false, `${mode}: wrong workspace admitted ${runId}`)
    }
  }
  await checkAdmission(false, "missing control database")
  const control = new DatabaseSync(controlPath)
  try {
    control.exec("CREATE TABLE flows_migrations(migration_id INTEGER PRIMARY KEY NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, name VARCHAR(255) NOT NULL); CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY)")
    control.exec("BEGIN; INSERT INTO flows_runs VALUES('child'); ROLLBACK;")
    await checkAdmission(false, "rolled-back control identity")
    control.exec("BEGIN; INSERT INTO flows_runs VALUES('child'); COMMIT;")
    await checkAdmission(true, "committed control identity")
  } finally {
    control.close()
  }
  rmSync(controlPath)
  await checkAdmission(false, "removed control database")
  assert.deepEqual(readFileSync(enginePath), engineBefore, `${mode}: routing changed engine database bytes`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`Installed history admission contract passed under ${mode}`)
