#!/usr/bin/env node
/** Commit the entire shared checkout to main, using jj when present. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const args = process.argv.slice(2)
let message = "chore: checkpoint shared working tree"
let push = false
const tests = []
let noTest
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log("Usage: pnpm commit [--message <message>] [--push] [--test <command> ... | --no-test <reason>]\nCommits ALL nonignored edits, including other contributors' work, on main.\nUses jj when available in this checkout, otherwise Git. --push publishes main to origin.\nAfter validation and pushing, use pnpm deploy to publish production.")
    process.exit(0)
  } else if (args[i] === "--push") push = true
  else if (args[i] === "--test" && args[i + 1]?.trim()) tests.push(args[++i])
  else if (args[i] === "--no-test" && args[i + 1]?.trim() && !/[\r\n]/.test(args[i + 1])) noTest = args[++i]
  else if ((args[i] === "--message" || args[i] === "-m") && args[i + 1]?.trim()) message = args[++i]
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`)
}

if (tests.length && noTest) throw new Error("--test and --no-test are mutually exclusive.")
if (push && !tests.length && !noTest) {
  console.error("NOT LANDED: --push requires --test <command> or --no-test <reason>.")
  process.exit(1)
}
if (tests.length || noTest) message += `\n\nLanding-Tests: ${noTest ? `none (${noTest})` : tests.join("; ")}`

let root = realpathSync(process.cwd())
while (!existsSync(join(root, ".jj")) && !existsSync(join(root, ".git"))) {
  const parent = dirname(root)
  if (parent === root) throw new Error("Run commit inside a jj or Git checkout.")
  root = parent
}
const gateEnvironment = { ...process.env }
for (const key of Object.keys(gateEnvironment)) {
  if (/^npm_config_/i.test(key) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)KEY(?:_|$)|CERTIFICATE|AUTH)/i.test(key)) delete gateEnvironment[key]
}
const run = (command, argv, capture = false, environment = process.env) => {
  const result = spawnSync(command, argv, { cwd: root, env: environment, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${argv[0]} failed (${result.status})${capture ? `: ${result.stderr}` : ""}`)
  return result.stdout?.trim() ?? ""
}

// Serializes users of this entry point without adding a file to the commit.
// Publication must record the exact candidate whose gates ran.
const lock = join(tmpdir(), `smithers-commit-${createHash("sha256").update(root).digest("hex")}.lock`)
try { mkdirSync(lock) } catch (error) {
  if (error.code === "EEXIST") throw new Error(`Another commit is running. If it crashed, remove ${lock} after checking its process.`)
  throw error
}
const jjCheckout = existsSync(join(root, ".jj"))
const candidateDirectory = mkdtempSync(join(tmpdir(), "smithers-candidate-"))
const jjTree = (revision, operation) => createHash("sha256").update(run("jj", [...(operation ? ["--at-operation", operation] : []), "debug", "tree", "-r", revision], true)).digest("hex")
const candidateTree = () => {
  if (jjCheckout) return jjTree("@")
  const environment = { ...process.env, GIT_INDEX_FILE: join(candidateDirectory, "index") }
  rmSync(environment.GIT_INDEX_FILE, { force: true })
  run("git", ["read-tree", "HEAD"], true, environment)
  run("git", ["add", "--all"], true, environment)
  return run("git", ["write-tree"], true, environment)
}
try {
  const validatedTree = push ? candidateTree() : undefined
  gateEnvironment.NPM_CONFIG_USERCONFIG = "/dev/null"
  gateEnvironment.NPM_CONFIG_GLOBALCONFIG = "/dev/null"
  if (push && existsSync(join(root, ".npmrc")) && /(?:_auth|password|token)\s*=/i.test(readFileSync(join(root, ".npmrc"), "utf8"))) {
    throw new Error("Gate checkout contains install credentials in .npmrc.")
  }
  for (const command of tests) {
    const result = spawnSync("bash", ["-o", "pipefail", "-c", command], { cwd: root, env: gateEnvironment, stdio: "inherit" })
    if (result.error || result.status !== 0) throw new Error(`Test command failed: ${command} (${result.error?.message ?? result.status})`)
  }
  run(process.execPath, ["scripts/check-tracked-hygiene.mjs", "--include-untracked"], true, gateEnvironment)
  if (push) {
    for (const label of ["//:driftCi", "//:targetIndex", "//:ci", "//scripts:trackedHygiene", "//scripts:conflictMarkers"]) {
      run(process.execPath, ["packages/smithers/bin/smithers.mjs", "lint", label], false, gateEnvironment)
    }
  }
  if (push && candidateTree() !== validatedTree) throw new Error("Checkout changed during validation; rerun gates.")
  if (jjCheckout) {
    const eligible = run("jj", ["log", "-r", "main & (@ | @-)", "--no-graph", "-T", "commit_id"], true)
    if (!eligible) throw new Error("The shared checkout must be on main or its working-copy child.")
    if (run("jj", ["log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id"], true)) throw new Error("Resolve conflicts before committing.")
    if (run("jj", ["diff", "--summary"], true)) {
      run("jj", ["commit", "-m", message])
      run("jj", ["bookmark", "set", "main", "-r", "@-"])
    } else console.log("No uncommitted changes.")
    if (push) {
      const operation = run("jj", ["op", "log", "--limit", "1", "--no-graph", "-T", "id"], true)
      const sha = run("jj", ["--at-operation", operation, "log", "-r", "main", "--no-graph", "-T", "commit_id"], true)
      if (jjTree("main", operation) !== validatedTree) throw new Error("Committed tree differs from validated candidate; refusing push.")
      run("jj", ["--at-operation", operation, "git", "push", "--remote", "origin", "-b", "main"])
      run("jj", ["git", "fetch", "--remote", "origin"])
      if (!run("jj", ["log", "-r", `${sha} & ::main@origin`, "--no-graph", "-T", "commit_id"], true)) throw new Error("remote main moved; pushed commit is absent")
      console.log(`LANDED ${sha}`)
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
      const sha = run("git", ["rev-parse", "main"], true)
      if (run("git", ["rev-parse", "main^{tree}"], true) !== validatedTree) throw new Error("Committed tree differs from validated candidate; refusing push.")
      run("git", ["push", "origin", `${sha}:refs/heads/main`])
      run("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"])
      try {
        run("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], true)
      } catch (error) {
        throw new Error(`remote main moved or ancestry verification failed: ${error.message}`)
      }
      console.log(`LANDED ${sha}`)
    }
    console.log(`main: ${run("git", ["rev-parse", "main"], true)}`)
  }
} catch (error) {
  console.error(`${push ? "NOT LANDED: " : ""}${error.message}`)
  process.exitCode = 1
} finally {
  rmSync(candidateDirectory, { recursive: true, force: true })
  rmSync(lock, { recursive: true, force: true })
}
