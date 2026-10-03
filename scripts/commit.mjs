#!/usr/bin/env node
/** Commit the entire shared checkout to main, using jj when present. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const args = process.argv.slice(2)
let message = "chore: checkpoint shared working tree"
let push = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log("Usage: pnpm commit [--message <message>] [--push]\nCommits ALL nonignored edits, including other contributors' work, on main.\nUses jj when available in this checkout, otherwise Git. --push publishes main to origin.\nAfter validation and pushing, use pnpm deploy to publish production.")
    process.exit(0)
  } else if (args[i] === "--push") push = true
  else if ((args[i] === "--message" || args[i] === "-m") && args[i + 1]?.trim()) message = args[++i]
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`)
}

let root = realpathSync(process.cwd())
while (!existsSync(join(root, ".jj")) && !existsSync(join(root, ".git"))) {
  const parent = dirname(root)
  if (parent === root) throw new Error("Run commit inside a jj or Git checkout.")
  root = parent
}
const run = (command, argv, capture = false) => {
  const result = spawnSync(command, argv, { cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${argv[0]} failed (${result.status})${capture ? `: ${result.stderr}` : ""}`)
  return result.stdout?.trim() ?? ""
}

// Serializes users of this entry point without adding a file to the commit.
// Editors can keep working; the VCS snapshots the edits present at commit time.
const lock = join(tmpdir(), `smithers-commit-${createHash("sha256").update(root).digest("hex")}.lock`)
try { mkdirSync(lock) } catch (error) {
  if (error.code === "EEXIST") throw new Error(`Another commit is running. If it crashed, remove ${lock} after checking its process.`)
  throw error
}
try {
  run(process.execPath, ["scripts/check-tracked-hygiene.mjs", "--include-untracked"], true)
  if (existsSync(join(root, ".jj"))) {
    const eligible = run("jj", ["log", "-r", "main & (@ | @-)", "--no-graph", "-T", "commit_id"], true)
    if (!eligible) throw new Error("The shared checkout must be on main or its working-copy child.")
    if (run("jj", ["log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id"], true)) throw new Error("Resolve conflicts before committing.")
    if (run("jj", ["diff", "--summary"], true)) {
      run("jj", ["commit", "-m", message])
      run("jj", ["bookmark", "set", "main", "-r", "@-"])
    } else console.log("No uncommitted changes.")
    if (push) {
      run("go", ["test", "-run", "TestMigrationGate|TestMigrationRegistry", "./packages/backend/db/product/"])
      run("jj", ["git", "push", "--remote", "origin", "-b", "main"])
    }
    console.log(`main: ${run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"], true)}`)
  } else {
    if (run("git", ["branch", "--show-current"], true) !== "main") throw new Error("The shared checkout must be on main.")
    if (run("git", ["ls-files", "--unmerged"], true)) throw new Error("Resolve conflicts before committing.")
    if (run("git", ["status", "--porcelain"], true)) {
      run("git", ["add", "--all"])
      run("git", ["commit", "-m", message])
    } else console.log("No uncommitted changes.")
    if (push) {
      run("go", ["test", "-run", "TestMigrationGate|TestMigrationRegistry", "./packages/backend/db/product/"])
      run("git", ["push", "origin", "main"])
    }
    console.log(`main: ${run("git", ["rev-parse", "main"], true)}`)
  }
} finally { rmSync(lock, { recursive: true, force: true }) }
