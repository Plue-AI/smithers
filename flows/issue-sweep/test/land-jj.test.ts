/**
 * Landing helpers against a real jj repository: jj prints paths relative to
 * the process's directory, and a landing must still see repository paths.
 */
import { Effect } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { changedFiles } from "../land.ts"

test("changedFiles names repository-relative paths whatever the process's directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-land-"))
  try {
    const jj = (...args: Array<string>) =>
      execFileSync("jj", ["-R", root, "--config", "user.name=t", "--config", "user.email=t@t", ...args], {
        encoding: "utf8",
        cwd: tmpdir()
      })
    execFileSync("jj", ["git", "init", root], { cwd: tmpdir() })
    mkdirSync(join(root, "packages/smithers/flows/patterns/src"), { recursive: true })
    writeFileSync(join(root, "packages/smithers/flows/patterns/src/Burndown.ts"), "export {}\n")
    jj("describe", "-m", "change")
    const change = jj("log", "--no-graph", "-r", "@", "-T", "change_id").trim()
    // From another directory jj alone prints the path relative to that directory.
    assert.notEqual(jj("diff", "--name-only", "-r", change).trim(), "packages/smithers/flows/patterns/src/Burndown.ts")

    const files = await Effect.runPromise(changedFiles(root, change))

    assert.deepEqual(files, ["packages/smithers/flows/patterns/src/Burndown.ts"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
