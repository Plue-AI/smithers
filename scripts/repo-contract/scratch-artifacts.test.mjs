/**
 * No app ships a run's scratch output.
 *
 * An enrollment sweep left its shell exit codes (`.enrollment-*.exit`) and a
 * 444 KB macOS `sample` trace of a bun process in `apps/app`, and one exit code
 * in `apps/server`. Nothing read them, yet every clone and every packed app
 * carried them, the trace with its local pids and paths.
 *
 * The gate is a class, not those files: any tracked file under `apps/` whose
 * name marks it as a captured exit code or enrollment scratch fails. The
 * matching names are gitignored at the root, so the next sweep writes them
 * where they stay local.
 *
 * The registry's module load siblings are scratch of the same kind: a copy of
 * each flow module written beside it for one import. A jj snapshot taken
 * mid-load committed six of them under `flows/coding`, so the root
 * `.gitignore` must ignore that name shape.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

/**
 * Every tracked path under `apps/`. A jj checkout is read from its last
 * snapshot, without snapshotting edits; a plain Git checkout (CI) from its
 * index.
 */
const tracked = (repositoryRoot = root, run = spawnSync) => {
  const jj = existsSync(join(repositoryRoot, ".jj"))
  const command = jj ? "jj" : "git"
  const args = jj ? ["file", "list", "--ignore-working-copy", "apps"] : ["ls-files", "--", "apps"]
  const result = run(command, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, `${command} inventory failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.split("\n").filter((path) => path.startsWith("apps/"))
}

/** A captured shell exit code, or anything an enrollment sweep wrote beside it. */
const isScratch = (path) => {
  const name = basename(path)
  return name.startsWith(".enrollment-") || name.endsWith(".exit")
}

describe("the apps' tracked files", () => {
  it("has files to check", () => {
    assert.ok(tracked().length > 0, "VCS inventory found no tracked file under apps/")
  })

  it("carries no run scratch", () => {
    const offenders = tracked().filter(isScratch)
    assert.deepEqual(offenders, [], "run scratch is tracked and ships with the app:\n  " + offenders.join("\n  "))
  })
})

it("reads jj when the checkout has one, Git otherwise, and flags only scratch names", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scratch-artifacts-inventory-"))
  try {
    mkdirSync(join(fixture, ".git"))
    assert.deepEqual(tracked(fixture, (command, args, options) => {
      assert.equal(command, "git")
      assert.deepEqual(args, ["ls-files", "--", "apps"])
      assert.equal(options.cwd, fixture)
      return { status: 0, stdout: "apps/app/package.json\n", stderr: "" }
    }), ["apps/app/package.json"])
    mkdirSync(join(fixture, ".jj"))
    const files = tracked(fixture, (command, args) => {
      assert.equal(command, "jj")
      assert.deepEqual(args, ["file", "list", "--ignore-working-copy", "apps"])
      return {
        status: 0,
        stdout: "apps/app/.enrollment-e2e.exit\napps/app/.enrollment-sample.txt\napps/server/probe.exit\napps/app/src/exit.ts\napps/app/.gitignore\n",
        stderr: ""
      }
    })
    assert.deepEqual(files.filter(isScratch), [
      "apps/app/.enrollment-e2e.exit",
      "apps/app/.enrollment-sample.txt",
      "apps/server/probe.exit"
    ])
    assert.throws(() => tracked(fixture, () => ({ status: 1, stdout: "", stderr: "inventory unavailable" })), /inventory unavailable/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

/**
 * The paths the root `.gitignore` ignores, out of `paths`. Git reads only the
 * copied root file in a fresh repository, so the answer depends on no checkout
 * state and no nested ignore file.
 */
const ignoredByRoot = (paths) => {
  const fixture = mkdtempSync(join(tmpdir(), "load-siblings-"))
  try {
    copyFileSync(join(root, ".gitignore"), join(fixture, ".gitignore"))
    const init = spawnSync("git", ["init", "-q"], { cwd: fixture, encoding: "utf8", timeout: 30_000 })
    assert.equal(init.status, 0, `git init failed: ${init.error?.message ?? init.stderr}`)
    const check = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: fixture, input: paths.join("\n") + "\n", encoding: "utf8", timeout: 30_000
    })
    // 0: some path is ignored; 1: none is. Anything else is a failed check.
    assert.ok(check.status === 0 || check.status === 1, `git check-ignore failed: ${check.error?.message ?? check.stderr}`)
    return check.stdout.split("\n").filter(Boolean)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
}

it("ignores the registry's module load siblings and none of their originals", () => {
  // The six siblings the mid-load snapshot committed were shaped like this one.
  const digest = "35e97ae33074c50c174a90d629d94f35ec8f70baf0bb94f0560fcf54e818e689"
  const siblings = [
    `flows/coding/.smithers-${digest}-7-murhou7y.ts`,
    `flows/coding/dispatch/.smithers-${digest}-6-murhou7f.ts`,
    `flows/review/.smithers-${digest}-a-murhou89.mjs`,
    `packages/smithers/flows/.smithers-${digest}-b-murhou8c.tsx`
  ]
  const originals = [
    "flows/coding/flow.ts",
    "flows/review/prompt.mdx",
    ".smithers/WORKSPACE.ts",
    ".smithers/target-index.json"
  ]
  assert.deepEqual(ignoredByRoot([...siblings, ...originals]), siblings)
})
