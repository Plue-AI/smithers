import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { homedir, hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { validateCurrentAcceptance } from "../acceptance.ts"
import {
  checksProgram,
  hasPushedReceipt,
  isPushedFailure,
  LandFailed,
  landingFailure,
  landingScript,
  reviewProgram
} from "../land.ts"

// Snapshot leases go to a private ledger so these tests never write the host landing ledger.
const snapshotLedger = mkdtempSync(join(tmpdir(), "burndown-ledger-"))
process.env.BURNDOWN_SNAPSHOT_LEDGER = snapshotLedger
process.on("exit", () => rmSync(snapshotLedger, { recursive: true, force: true }))
const leaseFor = (snapshot: string) => join(snapshotLedger, `${snapshot.split("/").at(-1)}.json`)
const exists = (path: string) =>
  realpath(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false
    throw error
  })

// The embedded review discovers `claude-N` accounts under the host home; give the landing script a private
// account root so these tests never depend on the developer machine's ~/.smithers/accounts.
function withReviewAccounts(script: string, root: string) {
  const home = join(root, "review-home")
  mkdirSync(join(home, ".smithers/accounts/claude-1"), { recursive: true })
  const source = "join(homedir(), \".smithers/accounts\")"
  assert.ok(script.includes(source))
  return script.replace(source, `join(${JSON.stringify(home)}, ".smithers/accounts")`)
    .replace("set -eu", "set -eu\nexport BURNDOWN_REVIEW_ACCOUNT=claude-1")
}

// Substitute only external CLIs: package discovery and subprocess ordering run in real temporary repositories.
async function fixture(t: test.TestContext, paths: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "burndown-land-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  await mkdir(bin)
  async function put(path: string, body: string) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
  }
  for (const [path, body] of Object.entries(paths)) await put(path, body)
  await put(
    "bin/gh",
    `#!${process.execPath}\nconst args=process.argv.slice(2); if(process.env.GH_ACCEPTANCE_MARKER) require('node:fs').writeFileSync(process.env.GH_ACCEPTANCE_MARKER,'started'); if(process.env.GH_ACCEPTANCE_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.GH_ACCEPTANCE_DELAY)); if(process.env.GH_ACCEPTANCE_FAIL) {console.error('issue provider unavailable');process.exit(1);} const number=Number(args[2]); console.log(JSON.stringify(args.at(-1)==='number'?{number}:process.env.REVIEW_ISSUE_FILE?JSON.parse(require('node:fs').readFileSync(process.env.REVIEW_ISSUE_FILE,'utf8')):{number,title:'Acceptance',body:'Acceptance complete.',comments:[]}));\n`
  )
  await chmod(join(bin, "gh"), 0o755)
  for (const command of ["jj", "pnpm", "go", "helm"]) {
    await put(
      `bin/${command}`,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (${
        JSON.stringify(command)
      } === 'jj') { process.stdout.write(args.includes('log') && args.includes('commit_id') ? 'b'.repeat(40) : process.env.REVIEW_DIFF_FILE ? fs.readFileSync(process.env.REVIEW_DIFF_FILE, 'utf8') : process.env.CHANGED_PATHS); } else { fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify([${
        JSON.stringify(command)
      }, ...args]) + '\\n'); if (process.env.FAIL_CHECK === args.at(-1)) { process.stdout.write('x'.repeat(5000) + 'CHECK_RED_END'); process.exit(1); } }\n`
    )
    await chmod(join(bin, command), 0o755)
  }
  const commandLog = join(root, "commands.log")
  return {
    root,
    bin,
    put,
    commandLog,
    run(changed: Array<string>, repo = "smithers", extra: Record<string, string> = {}) {
      return spawnSync(
        process.execPath,
        ["--input-type=module", "-e", checksProgram, repo, "change-one", "change-two"],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CHANGED_PATHS: changed.join("\n") + "\n",
            COMMAND_LOG: commandLog,
            ...extra
          },
          encoding: "utf8",
          timeout: 60_000
        }
      )
    },
    async commands() {
      let contents: string
      try {
        contents = await readFile(commandLog, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
      }
      return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    }
  }
}
const pkg = (name: string, scripts: Record<string, string> = { typecheck: "tsc", test: "node --test" }) =>
  JSON.stringify({ name, scripts })

test("one touched package runs its fast checks once across member changes", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  const result = f.run(["packages/a/src/deleted.ts", "packages/a/test/a.test.ts"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "typecheck"], [
    "pnpm",
    "--fail-if-no-match",
    "--filter",
    "@test/a",
    "run",
    "test"
  ]])
})

test("multiple nearest packages run serially in deterministic path order with check fallback", async (t) => {
  const f = await fixture(t, {
    "packages/z/package.json": pkg("@test/z", { check: "tsc", test: "node --test" }),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/nested/package.json": pkg("@test/nested", { test: "node --test" })
  })
  const result = f.run(["packages/z/z.ts", "packages/a/nested/n.ts", "packages/a/a.ts"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [
    ["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "typecheck"],
    ["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "test"],
    ["pnpm", "--fail-if-no-match", "--filter", "@test/nested", "run", "test"],
    ["pnpm", "--fail-if-no-match", "--filter", "@test/z", "run", "check"],
    ["pnpm", "--fail-if-no-match", "--filter", "@test/z", "run", "test"]
  ])
  assert.match(result.stdout, /SKIP/)
})

test("unowned executable paths and undeclared PACKAGE.ts boundaries fail closed", async (t) => {
  const f = await fixture(t, {
    "package.json": pkg("workspace"),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/native/PACKAGE.ts": "export default {}"
  })
  for (const path of ["scripts/tool.ts", "packages/a/native/deleted.ts"]) {
    const result = f.run([path])
    assert.notEqual(result.status, 0, result.stdout)
    assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
  }
})

test("packages with no verification scripts cannot report passed checks", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a", {}) })
  const result = f.run(["packages/a/a.ts"])
  assert.notEqual(result.status, 0, result.stdout)
  assert.deepEqual(await f.commands(), [])
  assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
})

test("Smithers Go backend changes run vet and test in their module", async (t) => {
  const f = await fixture(t, {
    "go.mod": "module example.test/workspace",
    "packages/backend/go.mod": "module example.test/backend",
    "packages/backend/internal/a/a.go": "package a"
  })
  await f.put(
    "bin/go",
    `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['go', ...process.argv.slice(2), process.cwd()]) + '\\n');\n`
  )
  const result = f.run(["packages/backend/internal/a/deleted.go"])
  assert.equal(result.status, 0, result.stderr)
  const module = await realpath(join(f.root, "packages/backend"))
  assert.deepEqual(await f.commands(), [
    ["go", "vet", "./internal/a/...", module],
    ["go", "test", "./internal/a/...", module]
  ])
})

test("Go module metadata changes check the whole nearest module", async (t) => {
  const f = await fixture(t, { "packages/backend/go.mod": "module example.test/backend" })
  const result = f.run(["packages/backend/go.mod", "packages/backend/go.sum"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [["go", "vet", "./..."], ["go", "test", "./..."]])
})

test("plue checks nearest Go packages serially without a repository-wide command", async (t) => {
  const f = await fixture(t, {
    "internal/a/a.go": "package a",
    "internal/b/b.go": "package b",
    "go.mod": "module example.test/plue"
  })
  const result = f.run(["internal/b/deleted.go", "internal/a/a.go"], "plue")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [["go", "vet", "./internal/a/..."], ["go", "test", "./internal/a/..."], [
    "go",
    "vet",
    "./internal/b/..."
  ], ["go", "test", "./internal/b/..."]])
})

test("Plue Helm and docs changes cannot silently pass without declared checks", async (t) => {
  const f = await fixture(t, { "go.mod": "module example.test/plue" })
  for (const path of ["deploy/helm/plue/templates/deployment.yaml", "docs/deploy.md"]) {
    const result = f.run([path], "plue")
    assert.notEqual(result.status, 0, result.stdout)
    assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
  }
})

test("declared affected graph verifies root and PACKAGE.ts paths before execution", async (t) => {
  const f = await fixture(t, {
    "PACKAGE.ts": "export default {}",
    "packages/smithers/build/build-cli/src/main.js":
      `const fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['graph', ...args]) + '\\n'); if (args.includes('--list')) console.log(JSON.stringify({ targets: [{ label: '//:test' }] }));`,
    "packages/native/PACKAGE.ts": "export default {}"
  })
  const result = f.run(["scripts/tool.ts", "packages/native/deleted.ts"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [
    ["graph", "affected", "ci", "//...", "--files", "packages/native/deleted.ts", "--list", "--json"],
    ["graph", "affected", "ci", "//...", "--files", "scripts/tool.ts", "--list", "--json"],
    [
      "graph",
      "affected",
      "ci",
      "//...",
      "--files",
      "packages/native/deleted.ts",
      "--files",
      "scripts/tool.ts",
      "--no-cache",
      "--jobs",
      "1"
    ]
  ])
})

test("an uncovered path prevents affected execution even alongside a covered path", async (t) => {
  const f = await fixture(t, {
    "PACKAGE.ts": "export default {}",
    "packages/smithers/build/build-cli/src/main.js":
      `const fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['graph', ...args]) + '\\n'); console.log(JSON.stringify({ targets: args.includes('scripts/uncovered.ts') ? [] : [{ label: '//:test' }] }));`
  })
  const result = f.run(["scripts/covered.ts", "scripts/uncovered.ts"])
  assert.notEqual(result.status, 0, result.stdout)
  assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
  assert.ok((await f.commands()).every((args) => args.includes("--list")))
})

test("missing Go module and empty change sets refuse verification", async (t) => {
  const f = await fixture(t, {})
  for (const paths of [["packages/backend/internal/a/a.go"], []]) {
    const result = f.run(paths)
    assert.notEqual(result.status, 0, result.stdout)
    assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
  }
  assert.deepEqual(await f.commands(), [])
})

test("a failed Go vet blocks tests and prevents a passed receipt", async (t) => {
  const f = await fixture(t, {
    "packages/backend/go.mod": "module example.test/backend",
    "packages/backend/internal/a/a.go": "package a"
  })
  const result = f.run(["packages/backend/internal/a/a.go"], "smithers", { FAIL_CHECK: "./internal/a/..." })
  assert.notEqual(result.status, 0, result.stdout)
  assert.deepEqual(await f.commands(), [["go", "vet", "./internal/a/..."]])
  assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
})

test("red check stops verification and becomes LandFailed carrying the last 4000 log bytes", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a"), "packages/z/package.json": pkg("@test/z") })
  const result = f.run(["packages/a/a.ts", "packages/z/z.ts"], "smithers", { FAIL_CHECK: "typecheck" })
  assert.notEqual(result.status, 0)
  assert.deepEqual(await f.commands(), [["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "typecheck"]])
  const failure = landingFailure("member-key", {
    stdout: result.stdout,
    stderr: result.stderr,
    message: "checks failed"
  })
  assert.ok(failure instanceof LandFailed)
  assert.equal(failure.key, "member-key")
  assert.equal(Buffer.byteLength(failure.log), 4000)
  assert.match(failure.log, /CHECK_RED_END/)
})

test("landing verifies rebased commits and records receipt before moving main or pushing", () => {
  const script = landingScript({
    key: "member-key",
    repo: "smithersai/smithers",
    commits: [{ issue: 123, commit: "abc123" }]
  })
  const check = script.indexOf("node --input-type=module")
  assert.ok(check < script.indexOf("jj rebase $revs"), "prepared candidate checks must precede rebase")
  assert.ok(check < script.indexOf("bookmark set main -r \"$verified\""))
  assert.ok(check < script.indexOf("git push"))
  assert.match(script, /member-key\.checks\.log/)
  assert.match(checksProgram, /900_000|900000|15 \* 60/)
})

test("generated landing shell persists a red receipt and never bookmarks or pushes", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  const key = `test-red-${process.pid}-${Date.now()}`
  const receipt = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.prechecks.log`)
  await mkdir(dirname(receipt), { recursive: true })
  t.after(() => rm(receipt, { force: true }))
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.some(x => x.includes('::main@origin'))) process.exit(0); if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('git') && args.includes('root')) console.log(process.cwd()); else if (args.includes('log') && !args.some(x => x.includes('conflicts()') || x.includes('bookmarks()'))) console.log(args.at(-1) === 'commit_id' ? 'a'.repeat(40) : 'change-one');\n`
  )
  await f.put(
    "bin/git",
    `#!${process.execPath}\nconst { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); if (args.includes('rev-parse')) { console.log(process.cwd()); process.exit(0); } if (args[0] === 'init') process.exit(0); const out = args[args.indexOf('--output') + 1]; const result = spawnSync('tar', ['-cf', out, '-C', process.cwd(), 'packages']); process.exit(result.status);\n`
  )
  await chmod(join(f.bin, "git"), 0o755)
  const result = spawnSync("sh", [
    "-c",
    landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "a".repeat(40) }] })
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog, FAIL_CHECK: "typecheck" },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(result.status, 6, result.stderr)
  const commands = await f.commands()
  assert.ok(
    !commands.some((args) => args[0] === "jj" && args[1] === "rebase"),
    "red pre-rebase checks must prevent rebase"
  )
  assert.ok(
    !commands.some((args) =>
      args[0] === "jj" && ((args.includes("bookmark") && !args.includes("main@origin")) || args.includes("push"))
    )
  )
  const log = await readFile(receipt)
  assert.equal(result.stderr, log.subarray(-4000).toString("utf8"))
  const failure = landingFailure(key, {
    code: 6,
    stdout: "unrelated stdout",
    stderr: result.stderr,
    message: "shell failed"
  })
  assert.equal(failure.log, result.stderr)
})

test("unsafe paths and malformed manifests refuse verification before any package command", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": "{broken" })
  const unsafe = f.run(["../outside/file.ts"])
  assert.notEqual(unsafe.status, 0)
  assert.match(unsafe.stderr, /Unsafe changed path/)
  const malformed = f.run(["packages/a/a.ts"])
  assert.notEqual(malformed.status, 0)
  assert.match(malformed.stderr, /JSON/)
  assert.deepEqual(await f.commands(), [])
})

test("the shared verification deadline kills a running check and prevents later checks", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['pnpm', ...process.argv.slice(2)]) + '\\n'); setInterval(() => {}, 1000);\n`
  )
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    checksProgram.replace("900_000", "5000"),
    "smithers",
    "change-one"
  ], {
    cwd: f.root,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      CHANGED_PATHS: "packages/a/a.ts\n",
      COMMAND_LOG: f.commandLog
    },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /CHECK_TIMEOUT: overall 15-minute limit/)
  assert.deepEqual(await f.commands(), [["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "typecheck"]])
})

test("real jj member tree is checked despite a green shared working copy", async (t) => {
  const f = await fixture(t, {
    "package.json": JSON.stringify({ name: "fixture", private: true }),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/result.txt": "BASELINE",
    ".gitattributes": "* export-subst text eol=crlf ident\npackages/a/ignored.go export-ignore\n",
    "packages/a/ignored.go": "package ignored\n",
    "packages/a/format.txt": "literal $Format:%H$",
    "packages/a/raw.txt": "alpha\n$Id$\nomega\n"
  })
  const originalPath = process.env.PATH!
  const jj = (args: Array<string>) => {
    const result = spawnSync("jj", args, { cwd: f.root, env: { ...process.env, PATH: originalPath }, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  jj(["git", "init", "--colocate"])
  jj(["commit", "-m", "baseline fixture"])
  await f.put("packages/a/result.txt", "RED")
  jj(["commit", "-m", "member red check fixture"])
  const member = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  await f.put("packages/a/result.txt", "GREEN")
  const key = `test-snapshot-${process.pid}-${Date.now()}`
  const receipt = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.prechecks.log`)
  await mkdir(dirname(receipt), { recursive: true })
  t.after(() => rm(receipt, { force: true }))
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.includes('fetch') || args.includes('rebase') || (args.includes('bookmark') && args.includes('main@origin'))) process.exit(0); if (args.some(x => x.includes('conflicts()') || x.includes('bookmarks()') || x.includes('::main@origin'))) process.exit(0); if (args.some(x => x.includes('main@origin::') || x.includes('::'))) { console.log('ancestor'); process.exit(0); } const r = spawnSync('jj', args, {env: {...process.env, PATH: process.env.ORIGINAL_PATH}, stdio: 'inherit'}); process.exit(r.status);\n`
  )
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['pnpm', ...args]) + '\\n'); if (args[0] === 'install') process.exit(0); console.log('CHECK_CWD ' + process.cwd()); if (!fs.existsSync('packages/a/ignored.go')) { console.error('ARCHIVE_IGNORED_TRACKED_FILE'); process.exit(1); } if (fs.readFileSync('packages/a/format.txt', 'utf8') !== 'literal $Format:%H$') { console.error('ARCHIVE_SUBSTITUTED_TRACKED_BYTES'); process.exit(1); } if (!fs.readFileSync('packages/a/raw.txt').equals(Buffer.from('alpha\\n$Id$\\nomega\\n'))) { console.error('ARCHIVE_CONVERTED_RAW_BYTES'); process.exit(1); } if (fs.readFileSync('packages/a/result.txt', 'utf8') === 'RED') { console.log('MEMBER_RED'); process.exit(1); }\n`
  )
  const result = spawnSync("sh", [
    "-c",
    landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: member }] })
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${originalPath}`, ORIGINAL_PATH: originalPath, COMMAND_LOG: f.commandLog },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(result.status, 6, result.stderr)
  assert.match(result.stderr, /MEMBER_RED/)
  assert.equal(await readFile(join(f.root, "packages/a/result.txt"), "utf8"), "GREEN")
  const commands = await f.commands()
  assert.ok(
    !commands.some((args) =>
      args[0] === "jj" && ((args.includes("bookmark") && !args.includes("main@origin")) || args.includes("push"))
    )
  )
  assert.deepEqual(commands.filter((args) => args[0] === "pnpm"), [
    ["pnpm", "install", "--offline", "--frozen-lockfile"],
    ["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "typecheck"]
  ])
  const checkedRoot = /CHECK_CWD (.+)/.exec(result.stderr)![1]!
  await assert.rejects(readFile(join(checkedRoot, "packages/a/result.txt")), { code: "ENOENT" })
})

async function fakeSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  await f.put(
    "bin/git",
    `#!${process.execPath}\nconst {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); if (args.includes('rev-parse')) { console.log(process.cwd()); process.exit(0); } if (args[0] === 'init') process.exit(0); const r = spawnSync('tar', ['-cf', args[args.indexOf('--output') + 1], '-C', process.cwd(), 'packages']); process.exit(r.status);\n`
  )
  await chmod(join(f.bin, "git"), 0o755)
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.some(x => x.includes('::main@origin'))) process.exit(0); if (args.includes('root')) console.log(process.cwd()); else if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('log') && !args.some(x => x.includes('conflicts()') || x.includes('bookmarks()'))) { if (args.at(-1) === 'commit_id') { const counter = process.env.COMMAND_LOG + '.sha'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0); fs.writeFileSync(counter, String(n + 1)); console.log((process.env.CHANGE_SHA && n > 0 ? 'b' : 'a').repeat(40)); } else console.log('change-one'); }\n`
  )
}

test("a changed member SHA after green verification refuses bookmark and push", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await fakeSnapshot(f)
  const key = `test-sha-${process.pid}-${Date.now()}`
  const receipt = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.prechecks.log`)
  await mkdir(dirname(receipt), { recursive: true })
  t.after(() => rm(receipt, { force: true }))
  const result = spawnSync("sh", [
    "-c",
    landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "a".repeat(40) }] })
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog, CHANGE_SHA: "1" },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(result.status, 6, result.stderr)
  assert.match(result.stderr, /CHECKS_PASSED/)
  assert.match(result.stderr, /PRECHECK_REVISION_CHANGED/)
  const commands = await f.commands()
  assert.ok(
    !commands.some((args) =>
      args[0] === "jj" && ((args.includes("bookmark") && !args.includes("main@origin")) || args.includes("push"))
    )
  )
  assert.ok(result.stderr.endsWith((await readFile(receipt)).subarray(-4000).toString("utf8")))
})

test("cancellation kills the active check group and cleans its snapshot", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await fakeSnapshot(f)
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nif (process.argv[2] === 'install') process.exit(0); console.log('READY ' + JSON.stringify({ pid: process.pid, cwd: process.cwd(), ci: process.env.CI })); setInterval(() => {}, 1000);\n`
  )
  const child = spawn(process.execPath, ["--input-type=module", "-e", checksProgram, "smithers", "change-one"], {
    cwd: f.root,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      COMMAND_LOG: f.commandLog,
      BURNDOWN_CHECK_REVISION: "change-one",
      CI: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  t.after(() => child.kill("SIGKILL"))
  const completion = new Promise<number | null>((accept) => child.once("close", (code) => accept(code)))
  let output = ""
  const ready = await new Promise<{ pid: number; cwd: string; ci: string }>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("check never started")), 10_000)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      reject(new Error(`check exited before readiness: ${code}`))
    })
    child.stdout.on("data", (data) => {
      output += data
      const match = /READY (.+)\n/.exec(output)
      if (match) {
        clearTimeout(timer)
        accept(JSON.parse(match[1]!))
      }
    })
  })
  assert.equal(ready.ci, "true")
  child.kill("SIGTERM")
  assert.equal(await completion, 143)
  await assert.rejects(readFile(join(ready.cwd, "packages/a/package.json")), { code: "ENOENT" })
  await waitForExit(ready.pid)
})

test("Plue charts run lint and render before reporting passed", async (t) => {
  const f = await fixture(t, { "deploy/chart/Chart.yaml": "apiVersion: v2\nname: plue\nversion: 0.1.0" })
  const result = f.run(["deploy/chart/templates/service.yaml"], "plue")
  assert.equal(result.status, 0, result.stderr)
  const chart = join(await realpath(f.root), "deploy/chart")
  assert.deepEqual(await f.commands(), [["helm", "lint", "--strict", chart], [
    "helm",
    "template",
    "burndown-check",
    chart
  ]])
})

// Substitute provider envelopes, keeping review parsing and account failover in real subprocesses.
const claudeResultEnvelope = String.raw`
if (process.argv.includes('--output-format') && process.argv[2] !== 'auth') {
  const originalWrite = (chunk) => {
    const data = Buffer.from(chunk); let offset = 0;
    while (offset < data.length) {
      try { offset += require('node:fs').writeSync(1, data, offset, data.length - offset); }
      catch (error) { if (error.code !== 'EAGAIN') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
    }
  };
  let output = '';
  process.stdout.write = (chunk) => { output += chunk; return true; };
  const id = require('node:path').basename(process.env.CLAUDE_CONFIG_DIR ?? '');
  const response = JSON.parse(process.env.REVIEW_RESPONSES ?? '{}')[id] ?? {};
  const limited = response.capacity || (process.env.REVIEW_FABLE_LIMIT && id === 'claude-1');
  const quota = process.env.REVIEW_QUOTA && id === 'claude-1';
  if (quota) process.stderr.write = (chunk) => { output += chunk; return true; };
  process.on('exit', () => {
    if (response.resultRaw !== undefined) { originalWrite(response.resultRaw); return; }
    if (!process.env.ACCEPTANCE_SUPPRESS && /^VERDICT: PASS\s*$/m.test(output) && !output.includes('ACCEPTANCE ')) {
      const member=JSON.parse(require('node:fs').readFileSync(process.env.BURNDOWN_ACCEPTANCE_MEMBER_PATH,'utf8'));
      const receipt=JSON.parse(process.env.ACCEPTANCE_RESULT ?? JSON.stringify({version:1,repo:member.repo,revision:process.env.BURNDOWN_CHECK_REVISION,issues:member.commits.map(({issue})=>({issue,disposition:'complete',criteria:[{criterion:'Acceptance complete.',evidence:['CHECKS_PASSED']}],remaining:[]}))}));
      output=output.replace(/VERDICT: PASS\s*$/, 'ACCEPTANCE '+JSON.stringify(receipt)+'\nVERDICT: PASS');
    }
    originalWrite(JSON.stringify(response.envelope ?? {
      type: 'result', subtype: 'success', is_error: Boolean(limited || quota), terminal_reason: 'completed',
      ...(limited || quota ? { terminal_reason: 'api_error', api_error_status: 429, api_error: limited ? 'model_requires_usage_credits' : 'rate_limit_error' } : {}),
      modelUsage: limited || quota ? {} : { 'claude-fable-5-1': { canonicalModel: 'claude-fable-5-1', provider: 'firstParty' } }, result: output.trim()
    }) + '\n');
  });
}
`

async function reviewFixture(t: test.TestContext) {
  const f = await fixture(t, {})
  const reviewHome = join(f.root, "review-home")
  const acceptanceLog = join(f.root, "acceptance-checks.log")
  await writeFile(acceptanceLog, "CHECK_REVISION " + "a".repeat(40) + "\nCHECKS_PASSED\n")
  for (const id of ["claude-1", "claude-5"]) {
    await mkdir(join(reviewHome, ".smithers/accounts", id), { recursive: true })
  }
  await f.put(
    "bin/claude",
    `#!${process.execPath}\n${claudeResultEnvelope}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['claude', ...args, process.env.CLAUDE_CONFIG_DIR, process.env.ANTHROPIC_API_KEY ?? '', process.env.ANTHROPIC_AUTH_TOKEN ?? '', process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '']) + '\\n'); const id = require('node:path').basename(process.env.CLAUDE_CONFIG_DIR); const responses = JSON.parse(process.env.REVIEW_RESPONSES ?? '{}'); const response = responses[id] ?? {}; if (args[0] === 'auth') { if (response.identityRaw !== undefined) { console.log(response.identityRaw); process.exit(response.authExit ?? 0); } console.log(JSON.stringify({loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: response.email ?? process.env.REVIEW_EMAIL ?? id + '@example.test'})); process.exit(response.authExit ?? 0); } else { if (process.env.REVIEW_INPUT_LOG) fs.writeFileSync(process.env.REVIEW_INPUT_LOG, fs.readFileSync(0,'utf8')); if (process.env.REQUIRE_EMPTY_CWD && (process.cwd() === process.env.SOURCE_ROOT || fs.readdirSync(process.cwd()).length !== 0)) { console.error('UNSAFE_REVIEW_CWD'); process.exit(1); } if (process.env.REVIEW_FABLE_LIMIT && process.env.CLAUDE_CONFIG_DIR.endsWith('claude-1')) { console.log('You\\'ve reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.'); process.exit(Number(process.env.REVIEW_EXIT ?? 0)); } if (process.env.REVIEW_QUOTA && process.env.CLAUDE_CONFIG_DIR.endsWith('claude-1')) { console.error('quota exceeded'); process.exit(1); } if (response.signal) process.kill(process.pid, response.signal); if (response.delay) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, response.delay); } console.log(response.output ?? process.env.REVIEW_OUTPUT ?? 'VERDICT: PASS'); if (response.stderr) console.error(response.stderr); process.exit(response.exit ?? 0); }\n`
  )
  await chmod(join(f.bin, "claude"), 0o755)
  return {
    ...f,
    reviewHome,
    review(extra: Record<string, string> = {}, program = reviewProgram, timeout = 60_000) {
      const memberPath = join(f.root, "review-member.json")
      writeFileSync(memberPath, JSON.stringify({ repo: "smithersai/smithers", commits: [{ issue: 1 }] }), {
        mode: 0o600
      })
      return spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        program.replaceAll("homedir()", JSON.stringify(reviewHome))
      ], {
        cwd: f.root,
        env: {
          ...process.env,
          PATH: `${f.bin}:${process.env.PATH}`,
          COMMAND_LOG: f.commandLog,
          CHANGED_PATHS: "diff",
          SOURCE_ROOT: f.root,
          BURNDOWN_REVIEW_ACCOUNT: "",
          BURNDOWN_REVIEW_EXCLUDED_ACCOUNTS: "",
          BURNDOWN_EXCLUDE_EMAILS: "",
          BURNDOWN_CHECK_REVISION: "a".repeat(40),
          BURNDOWN_ACCEPTANCE_MEMBER_PATH: memberPath,
          BURNDOWN_ACCEPTANCE_PATH: join(f.root, "acceptance.json"),
          BURNDOWN_PRECHECKS_LOG: acceptanceLog,
          BURNDOWN_CHECKS_LOG: acceptanceLog,
          ANTHROPIC_API_KEY: "must-clear",
          ANTHROPIC_AUTH_TOKEN: "must-clear",
          CLAUDE_CODE_OAUTH_TOKEN: "must-clear",
          ...extra
        },
        encoding: "utf8",
        timeout
      })
    }
  }
}

test("final candidate review uses allowed subscription and clears credential overrides", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /REVIEW_REVISION a{40}/)
  const commands = await f.commands()
  assert.equal(commands.length, 2)
  for (const args of commands) {
    assert.ok(args.includes(join(f.reviewHome, ".smithers/accounts/claude-1")))
    assert.deepEqual(args.slice(-3), ["", "", ""])
  }
  assert.deepEqual(commands[1]!.slice(1, -4), [
    "-p",
    "--model",
    "claude-fable-5-1",
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}"
  ])
})

test("successful diff verdict without issue acceptance never permits landing review", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({ ACCEPTANCE_SUPPRESS: "1" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ACCEPTANCE_REVIEW_MISSING/)
  await assert.rejects(readFile(join(f.root, "acceptance.json"), "utf8"), /ENOENT/)
})

test("oversized required final-review input refuses before any model call or acceptance save", async (t) => {
  for (const source of ["diff", "checks", "acceptance", "combined"] as const) {
    await t.test(source, async (t) => {
      const f = await reviewFixture(t)
      const size = source === "combined" ? 400_000 : 1_048_577
      const diff = join(f.root, "diff.txt")
      const checks = join(f.root, "large-checks.log")
      const issue = join(f.root, "issue.json")
      await writeFile(diff, source === "diff" || source === "combined" ? "d".repeat(size) : "small diff")
      await writeFile(
        checks,
        `CHECK_REVISION ${"a".repeat(40)}\nCHECKS_PASSED\n` +
          (source === "checks" || source === "combined" ? "c".repeat(size) : "small checks")
      )
      await writeFile(
        issue,
        JSON.stringify({
          number: 1,
          title: "Acceptance",
          body: "Acceptance complete." + (source === "acceptance" || source === "combined" ? "a".repeat(size) : ""),
          comments: []
        })
      )
      const result = f.review({ REVIEW_DIFF_FILE: diff, REVIEW_ISSUE_FILE: issue, BURNDOWN_CHECKS_LOG: checks })
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stderr, /REVIEW_INPUT_INCOMPLETE/)
      assert.equal((await f.commands()).length, 0)
      await assert.rejects(readFile(join(f.root, "acceptance.json")), /ENOENT/)
    })
  }
})

test("oversized optional comments are omitted with a receipt while whole acceptance and exact identity survive", async (t) => {
  const f = await reviewFixture(t)
  const issue = join(f.root, "issue.json")
  const input = join(f.root, "review-input.txt")
  const body = "Acceptance complete.\nWHOLE_ACCEPTANCE_SENTINEL"
  await writeFile(
    issue,
    JSON.stringify({ number: 1, title: "Acceptance", body, comments: [{ body: "z".repeat(100_000) }] })
  )
  const result = f.review({ REVIEW_ISSUE_FILE: issue, REVIEW_INPUT_LOG: input, BURNDOWN_REVIEW_BASE: "b".repeat(40) })
  assert.equal(result.status, 0, result.stderr)
  const prompt = await readFile(input, "utf8")
  assert.ok(Buffer.byteLength(prompt) <= 1_048_576)
  assert.ok(prompt.includes(JSON.stringify(`Acceptance\n${body}`)))
  assert.ok(prompt.includes("a".repeat(40)))
  assert.ok(prompt.includes("b".repeat(40)))
  assert.ok(prompt.includes("historical superset"))
  assert.match(prompt, /optional_input_limit/)
  assert.ok(!prompt.includes("z".repeat(100_000)))
  assert.match(result.stdout, /REVIEW_INPUT_RECEIPT/)
  const record = JSON.parse(await readFile(join(f.root, "acceptance.json"), "utf8"))
  assert.equal(record.context.issues[0].body, `Acceptance\n${body}`)
})

test("acceptance existence and stale rejected-push receipts never classify an unpushed failure as delivered", async (t) => {
  const key = `test-pushed-failure-${process.pid}-${Date.now()}`
  const member = { key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "a".repeat(40) }] }
  const revision = "a".repeat(40)
  const path = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.acceptance.json`)
  await mkdir(dirname(path), { recursive: true })
  t.after(() => rm(path, { force: true }))
  const record = {
    context: {
      repo: member.repo,
      revision,
      commits: member.commits,
      issues: [{ issue: 1, body: "Acceptance complete." }],
      checks: "CHECKS_PASSED"
    },
    receipt: {
      version: 1,
      repo: member.repo,
      revision,
      issues: [{
        issue: 1,
        disposition: "complete",
        criteria: [{ criterion: "Acceptance complete.", evidence: ["CHECKS_PASSED"] }],
        remaining: []
      }]
    }
  }
  assert.equal(isPushedFailure(member, { stdout: `PUSH_ACCEPTED ${revision}\n` }), false)
  await writeFile(path, JSON.stringify(record))
  for (
    const stdout of [
      "",
      "PUSH_REJECTED",
      "CHECK_FAILED",
      `PUSH_ACCEPTED ${"b".repeat(40)}`,
      `untrusted PUSH_ACCEPTED ${revision}`
    ]
  ) {
    assert.equal(isPushedFailure(member, { stdout }), false)
  }
  assert.equal(isPushedFailure(member, { stdout: `PUSH_ACCEPTED ${revision}\n`, stderr: "pushed writer failed" }), true)
  assert.equal(isPushedFailure(member, { stdout: `LANDED 1 ${revision}\n` }), true)
  for (const commits of [undefined, [{ issue: 1, commit: "other" }]]) {
    await writeFile(path, JSON.stringify({ ...record, context: { ...record.context, commits } }))
    assert.equal(isPushedFailure(member, { stdout: `PUSH_ACCEPTED ${revision}\n` }), false)
  }
  await writeFile(
    path,
    JSON.stringify({
      ...record,
      context: { ...record.context, repo: "other/repo" },
      receipt: { ...record.receipt, repo: "other/repo" }
    })
  )
  assert.equal(isPushedFailure(member, { stdout: `PUSH_ACCEPTED ${revision}\n` }), false)
})

test("current issue body must match independently reviewed acceptance before delivery", () => {
  const record = {
    context: {
      repo: "smithersai/smithers",
      revision: "a".repeat(40),
      issues: [{ issue: 1, body: "Acceptance complete." }],
      checks: "CHECKS_PASSED"
    },
    receipt: {
      version: 1 as const,
      repo: "smithersai/smithers",
      revision: "a".repeat(40),
      issues: [{
        issue: 1,
        disposition: "complete" as const,
        criteria: [{ criterion: "Acceptance complete.", evidence: ["CHECKS_PASSED"] }],
        remaining: []
      }]
    }
  }
  assert.doesNotThrow(() => validateCurrentAcceptance(record, [{ issue: 1, body: "Acceptance complete." }]))
  assert.throws(
    () => validateCurrentAcceptance(record, [{ issue: 1, body: "Acceptance complete. Also require deployment." }]),
    /ACCEPTANCE_CHANGED/
  )
  assert.throws(() => validateCurrentAcceptance(record, []), /ACCEPTANCE_CHANGED/)
})

test("public landing receipt orchestration checks current acceptance before any issue mutation", async (t) => {
  for (const changed of [false, true]) {
    const f = await fixture(t, {})
    const key = `test-receipt-orchestration-${process.pid}-${Date.now()}-${changed}`
    const member = { key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "a".repeat(40) }] }
    const revision = "a".repeat(40)
    const criterion = changed ? "Old acceptance." : "Acceptance complete."
    const record = {
      context: {
        repo: member.repo,
        revision,
        commits: member.commits,
        issues: [{ issue: 1, body: `Acceptance\n${criterion}` }],
        checks: "CHECKS_PASSED"
      },
      receipt: {
        version: 1,
        repo: member.repo,
        revision,
        issues: [{
          issue: 1,
          disposition: "complete",
          criteria: [{ criterion, evidence: ["CHECKS_PASSED"] }],
          remaining: []
        }]
      }
    }
    const receipts = join(homedir(), "Smithers-Ops/burndown/landings")
    await mkdir(receipts, { recursive: true })
    for (const suffix of ["acceptance.json", "pushed.json", "sh"]) {
      t.after(() => rm(join(receipts, `${key}.${suffix}`), { force: true }))
    }
    await writeFile(join(receipts, `${key}.acceptance.json`), JSON.stringify(record))
    await writeFile(
      join(receipts, `${key}.pushed.json`),
      JSON.stringify({ version: 1, ...member, landed: [{ issue: 1, sha: revision }], acceptance: record })
    )
    await f.put("bin/python3", `#!${process.execPath}\nconsole.log('LANDED 1 ${revision}');\n`)
    await chmod(join(f.bin, "python3"), 0o755)
    await f.put(
      "claim.mjs",
      `import { appendFileSync } from 'node:fs'; const args=process.argv.slice(2);appendFileSync(process.env.COMMAND_LOG,JSON.stringify(['claim',...args])+'\\n');console.log(JSON.stringify(args[0]==='check'?{mine:true}:{posted:true}));\n`
    )
    const program = `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { landAll } from ${JSON.stringify(new URL("../land.ts", import.meta.url).href)};
const outcome=await Effect.runPromise(landAll(JSON.parse(process.env.READY_RESULT),JSON.parse(process.env.ASSIGNMENT)));
console.log(JSON.stringify(outcome));`
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
      cwd: f.root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        COMMAND_LOG: f.commandLog,
        BURNDOWN_ISSUE_CLAIM_SCRIPT: join(f.root, "claim.mjs"),
        READY_RESULT: JSON.stringify([{ key, commits: member.commits, notes: "Retained confirmed push" }]),
        ASSIGNMENT: JSON.stringify([{ assignment: { key, repo: member.repo } }])
      }
    })
    assert.equal(result.status, 0, result.stderr)
    const outcome = JSON.parse(result.stdout)
    const comments = (await f.commands()).filter((args) => args[0] === "claim" && args[1] === "comment")
    if (changed) {
      assert.deepEqual(outcome.landed, [])
      assert.deepEqual(outcome.quarantined, [])
      assert.equal(outcome.receiptsPending[0].key, key)
      assert.match(outcome.receiptsPending[0].error, /ACCEPTANCE_CHANGED/)
      assert.equal(comments.length, 0)
    } else {
      assert.deepEqual(outcome.landed, [key])
      assert.deepEqual(outcome.receiptsPending, [])
      assert.equal(comments.length, 1)
      assert.ok(comments[0]!.includes("--close"))
    }
  }
})

test("retained pushed receipt is bound to the same assignment, issues and repository acceptance", async (t) => {
  const key = `test-pushed-binding-${process.pid}-${Date.now()}`
  const member = { key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "a".repeat(40) }] }
  const revision = "a".repeat(40)
  const path = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.pushed.json`)
  await mkdir(dirname(path), { recursive: true })
  t.after(() => rm(path, { force: true }))
  const record = {
    version: 1,
    key,
    repo: member.repo,
    commits: member.commits,
    landed: [{ issue: 1, sha: revision }],
    acceptance: {
      context: {
        repo: member.repo,
        revision,
        commits: member.commits,
        issues: [{ issue: 1, body: "Acceptance complete." }],
        checks: "CHECKS_PASSED"
      },
      receipt: {
        version: 1,
        repo: member.repo,
        revision,
        issues: [{
          issue: 1,
          disposition: "complete",
          criteria: [{ criterion: "Acceptance complete.", evidence: ["CHECKS_PASSED"] }],
          remaining: []
        }]
      }
    }
  }
  assert.equal(hasPushedReceipt(member), false)
  await writeFile(path, JSON.stringify(record))
  assert.equal(hasPushedReceipt(member), true)
  assert.equal(isPushedFailure(member, { stdout: "" }), true)
  for (
    const change of [
      { key: "foreign" },
      { repo: "other/repo" },
      { commits: [{ issue: 1, commit: "other" }] },
      { landed: [{ issue: 1, sha: "short" }] },
      {
        acceptance: {
          context: { ...record.acceptance.context, repo: "other/repo" },
          receipt: { ...record.acceptance.receipt, repo: "other/repo" }
        }
      },
      {
        acceptance: {
          context: { ...record.acceptance.context, issues: [{ issue: 2, body: "Acceptance complete." }] },
          receipt: { ...record.acceptance.receipt, issues: [{ ...record.acceptance.receipt.issues[0]!, issue: 2 }] }
        }
      }
    ]
  ) {
    await writeFile(path, JSON.stringify({ ...record, ...change }))
    assert.equal(hasPushedReceipt(member), false, JSON.stringify(change))
  }
  await writeFile(path, "{corrupt")
  assert.equal(hasPushedReceipt(member), false)
})

test("fabricated issue completion evidence and issue provider failure refuse review", async (t) => {
  const f = await reviewFixture(t)
  const receipt = {
    version: 1,
    repo: "smithersai/smithers",
    revision: "a".repeat(40),
    issues: [{
      issue: 1,
      disposition: "complete",
      criteria: [{ criterion: "Acceptance complete.", evidence: ["Cloud deployed PASS"] }],
      remaining: []
    }]
  }
  const invented = f.review({ ACCEPTANCE_RESULT: JSON.stringify(receipt) })
  assert.notEqual(invented.status, 0)
  assert.match(invented.stderr, /ACCEPTANCE_INVALID/)
  const unavailable = f.review({ GH_ACCEPTANCE_FAIL: "1" })
  assert.notEqual(unavailable.status, 0)
  assert.match(unavailable.stderr, /issue provider unavailable/)
  await assert.rejects(readFile(join(f.root, "acceptance.json"), "utf8"), /ENOENT/)
})

test("operator account and missing or failed final verdict refuse review", async (t) => {
  const f = await reviewFixture(t)
  const operator = f.review({ REVIEW_EMAIL: "WILL@CODEPLANE.APP" })
  assert.notEqual(operator.status, 0)
  assert.ok((await f.commands()).every((args) => args[1] === "auth"))
  for (const output of ["VERDICT: FAIL", "looks good", "NOT_VERDICT: PASS", "VERDICT: PASS\nmore text"]) {
    const result = f.review({ REVIEW_OUTPUT: output })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /REVIEW_REJECTED/)
    assert.doesNotMatch(result.stdout, /REVIEW_REVISION/)
  }
})

test("review quota retries only the second allowed subscription", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({ REVIEW_QUOTA: "1" })
  assert.equal(result.status, 0, result.stderr)
  const commands = await f.commands()
  assert.equal(commands.length, 4)
  assert.ok(commands[2]!.includes(join(f.reviewHome, ".smithers/accounts/claude-5")))
  assert.ok(commands[3]!.includes(join(f.reviewHome, ".smithers/accounts/claude-5")))
})

test("review runs from an empty directory outside the candidate checkout", async (t) => {
  const f = await reviewFixture(t)
  await f.put("CLAUDE.md", "Untrusted repository instructions")
  const result = f.review({ REQUIRE_EMPTY_CWD: "1" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /REVIEW_REVISION/)
})

test("a package selector that matches nothing cannot produce a green receipt", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (args.includes('--fail-if-no-match')) { console.error('No projects matched'); process.exit(1); }\n`
  )
  const result = f.run(["packages/a/a.ts"])
  assert.notEqual(result.status, 0, result.stdout)
  assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
  assert.match(result.stderr, /No projects matched/)
})

async function waitForExit(pid: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`cancelled child ${pid} remains alive`)
}

async function waitForFile(path: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`child never started: ${path}`)
}

test("landing cancellation kills a started detached descendant before its late push", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  assert.equal(typeof runLandingProcess, "function")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const pidPath = join(f.root, "started.pid")
  const program = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${
    JSON.stringify(
      `require('node:fs').writeFileSync(${
        JSON.stringify(pidPath)
      }, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${
        JSON.stringify(marker)
      }, 'pushed'), 7000)`
    )
  }], {detached: true, stdio: 'ignore'}); setInterval(() => {}, 1000);`
  const controller = new AbortController()
  const running = runLandingProcess(process.execPath, ["-e", program], { timeout: 20_000, signal: controller.signal })
  await waitForFile(pidPath)
  controller.abort()
  await assert.rejects(running, /CANCEL|abort/i)
  await new Promise((accept) => setTimeout(accept, 7500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("landing cancellation rescans descendants omitted from its first process snapshot", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const pidPath = join(f.root, "descendant.pid")
  const scans = join(f.root, "scans")
  // A stale first ps snapshot models a detached child born during discovery.
  await f.put(
    "bin/ps",
    `#!${process.execPath}\nconst fs = require('node:fs'); const {execFileSync} = require('node:child_process'); const count = Number(fs.existsSync(${
      JSON.stringify(
        scans
      )
    }) ? fs.readFileSync(${JSON.stringify(scans)}, 'utf8') : 0); fs.writeFileSync(${
      JSON.stringify(
        scans
      )
    }, String(count + 1)); const hidden = Number(fs.readFileSync(${
      JSON.stringify(
        pidPath
      )
    }, 'utf8')); const rows = execFileSync('/bin/ps', process.argv.slice(2), {encoding:'utf8'}); process.stdout.write(count === 0 ? rows.split('\\n').filter(row => Number(row.trim().split(/\\s+/)[0]) !== hidden).join('\\n') : rows);\n`
  )
  await chmod(join(f.bin, "ps"), 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${f.bin}:${originalPath}`
  t.after(() => {
    process.env.PATH = originalPath
  })
  const descendant = `require('node:fs').writeFileSync(${
    JSON.stringify(
      pidPath
    )
  }, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${
    JSON.stringify(
      marker
    )
  }, 'pushed'), 7000)`
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${
    JSON.stringify(
      descendant
    )
  }], {detached:true, stdio:'ignore'}); setInterval(() => {}, 1000);`
  const program = `require('node:child_process').spawn(process.execPath, ['-e', ${
    JSON.stringify(
      parent
    )
  }], {detached:true, stdio:'ignore'}); setInterval(() => {}, 1000);`
  const controller = new AbortController()
  const running = runLandingProcess(process.execPath, ["-e", program], { timeout: 20_000, signal: controller.signal })
  await waitForFile(pidPath)
  controller.abort()
  await assert.rejects(running, /CANCEL|abort/i)
  await new Promise((accept) => setTimeout(accept, 7500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
  assert.ok(Number(await readFile(scans, "utf8")) >= 2)
  const pid = Number(await readFile(pidPath, "utf8"))
  await waitForExit(pid)
})

test("landing abort kills child processes and returns a cancellation failure", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  assert.equal(typeof runLandingProcess, "function")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const pidPath = join(f.root, "started.pid")
  const controller = new AbortController()
  const program = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${
    JSON.stringify(
      `require('node:fs').writeFileSync(${
        JSON.stringify(pidPath)
      }, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${
        JSON.stringify(marker)
      }, 'pushed'), 7000)`
    )
  }], {stdio: 'ignore'}); setInterval(() => {}, 1000);`
  const running = runLandingProcess(process.execPath, ["-e", program], { timeout: 10_000, signal: controller.signal })
  await waitForFile(pidPath)
  controller.abort()
  await assert.rejects(running, /CANCEL|abort/i)
  await new Promise((accept) => setTimeout(accept, 7500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("landing output limit safely kills the producer and refuses success", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  assert.equal(typeof runLandingProcess, "function")
  const f = await fixture(t, {})
  const pidPath = join(f.root, "producer.pid")
  const program = `require('node:fs').writeFileSync(${
    JSON.stringify(
      pidPath
    )
  }, String(process.pid)); function emit(){if(process.stdout.write('x'.repeat(1024*1024)))setImmediate(emit);else process.stdout.once('drain',emit)} emit()`
  await assert.rejects(
    runLandingProcess(process.execPath, ["-e", program], { timeout: 10_000 }),
    (error: Error & { stderr?: string }) => {
      assert.match(error.message, /OUTPUT_LIMIT|buffer/i, error.stderr ?? "")
      return true
    }
  )
  const pid = Number(await readFile(pidPath, "utf8"))
  await waitForExit(pid)
})

async function completeLandingFixture(t: test.TestContext) {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await fakeSnapshot(f)
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); const pushed = process.env.COMMAND_LOG + '.pushed'; if (args.includes('push')) { fs.writeFileSync(pushed, '1'); process.exit(0); } if (args.includes('fetch') && process.env.POST_PUSH_FETCH_FAIL && fs.existsSync(pushed)) process.exit(1); if (args.includes('root')) console.log(process.cwd()); else if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('log') && !args.some(x => x.includes('conflicts()') || x.includes('bookmarks()'))) { const rev = args[args.indexOf('-r') + 1]; if (rev.includes('::main@origin')) { if (fs.existsSync(pushed)) console.log(args.at(-1) === 'commit_id' ? 'a'.repeat(40) : 'change-one'); } else if (args.at(-1) === 'commit_id') { const counter = process.env.COMMAND_LOG + '.sha'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0); fs.writeFileSync(counter, String(n + 1)); console.log((process.env.SHA_DRIFT_AT && n >= Number(process.env.SHA_DRIFT_AT) ? 'b' : 'a').repeat(40)); } else console.log('change-one'); }\n`
  )
  await f.put(
    "bin/claude",
    `#!${process.execPath}\nif(process.argv[2]!=='auth')require('node:fs').readFileSync(0);\n${claudeResultEnvelope}\nrequire('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['claude', ...process.argv.slice(2)]) + '\\n'); if (process.argv[2] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'reviewer@example.test'})); else console.log('VERDICT: PASS');\n`
  )
  await chmod(join(f.bin, "claude"), 0o755)
  await f.put(
    "bin/git",
    `#!${process.execPath}\nconst {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); if (args.includes('rev-parse')) { console.log(process.cwd()); process.exit(0); } if (args[0] === 'init') process.exit(0); if (args.includes('ls-remote')) { require('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['git', ...args]) + '\\n'); console.log('a'.repeat(40) + '\\trefs/heads/main'); process.exit(0); } const r = spawnSync('tar', ['-cf', args[args.indexOf('--output') + 1], '-C', process.cwd(), 'packages']); process.exit(r.status);\n`
  )
  const key = `test-complete-${process.pid}-${Date.now()}`
  const receiptRoot = join(homedir(), "Smithers-Ops/burndown/landings")
  await mkdir(receiptRoot, { recursive: true })
  for (const suffix of ["prechecks", "checks", "review"]) {
    t.after(() => rm(join(receiptRoot, `${key}.${suffix}.log`), { force: true }))
  }
  for (const suffix of ["acceptance", "pushed", "member"]) {
    t.after(() => rm(join(receiptRoot, `${key}.${suffix}.json`), { force: true }))
  }
  return {
    ...f,
    key,
    runLanding(extra: Record<string, string> = {}, issue = 1) {
      return spawnSync(
        "sh",
        [
          "-c",
          withReviewAccounts(
            landingScript({ key, repo: "smithersai/smithers", commits: [{ issue, commit: "a".repeat(40) }] }),
            f.root
          )
        ],
        {
          cwd: f.root,
          env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog, ...extra },
          encoding: "utf8",
          timeout: 60_000
        }
      )
    }
  }
}

async function publicQueueFixture(
  t: test.TestContext,
  fixtures: ReadonlyArray<Awaited<ReturnType<typeof completeLandingFixture>>>
) {
  const routes: Record<string, { root: string; commandLog: string }> = {}
  const first = fixtures[0]!
  const receiptRoot = join(homedir(), "Smithers-Ops/burndown/landings")
  for (const f of fixtures) {
    routes[f.key] = { root: f.root, commandLog: f.commandLog }
    await mkdir(join(f.root, "review-home/.smithers/accounts/claude-1"), { recursive: true })
    t.after(() => rm(join(receiptRoot, `${f.key}.sh`), { force: true }))
    const script = join(receiptRoot, `${f.key}.sh`)
    await writeFile(script, "old readable script", { mode: 0o755 })
    await chmod(script, 0o755)
  }
  // The private operations lock is outside this public checkout. Substitute
  // that wrapper only; execute the generated landing shell and real processes.
  await first.put(
    "bin/python3",
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const source=process.argv.at(-1),key=path.basename(source,'.sh'),route=JSON.parse(process.env.LANDING_ROUTES)[key];
if((fs.statSync(source).mode&0o777)!==0o700)throw new Error('LANDING_SCRIPT_NOT_PRIVATE');
const script=fs.readFileSync(source,'utf8').replace('join(homedir(), ".smithers/accounts")',JSON.stringify(path.join(route.root,'review-home/.smithers/accounts')));
const qualified=path.join(route.root,'qualified-landing.sh');fs.writeFileSync(qualified,script,{mode:0o600});
const result=spawnSync('sh',[qualified],{cwd:route.root,env:{...process.env,PATH:path.join(route.root,'bin')+':'+process.env.PATH,COMMAND_LOG:route.commandLog,BURNDOWN_REVIEW_ACCOUNT:'claude-1'},stdio:'inherit'});
process.exit(result.status??1);
`
  )
  await chmod(join(first.bin, "python3"), 0o755)
  await first.put(
    "claim.mjs",
    `import{appendFileSync}from'node:fs';appendFileSync(process.env.COMMAND_LOG,JSON.stringify(['claim',...process.argv.slice(2)])+'\\n');console.log(JSON.stringify(process.argv[2]==='check'?{mine:true}:{posted:true}));`
  )
  return (extra: Record<string, string> = {}, options: unknown = {}) => {
    const optionsPath = join(first.root, "queue-options.json")
    writeFileSync(optionsPath, JSON.stringify(options), { mode: 0o600 })
    const program = `import {Effect} from ${JSON.stringify(import.meta.resolve("effect"))};
import{landAll}from ${JSON.stringify(new URL("../land.ts", import.meta.url).href)};
const keys=JSON.parse(process.env.QUEUE_KEYS);
const results=keys.map(key=>({key,status:'ready',commits:[{issue:1,commit:'a'.repeat(40)}],notes:'READY',agentHours:1}));
const workers=keys.map(key=>({assignment:{key,repo:'smithersai/smithers'},executionId:key,startedAt:0}));
console.log(JSON.stringify(await Effect.runPromise(landAll(results,workers,JSON.parse(process.getBuiltinModule('fs').readFileSync(process.env.QUEUE_OPTIONS_FILE,'utf8'))))));`
    return spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: first.root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${first.bin}:${process.env.PATH}`,
        COMMAND_LOG: first.commandLog,
        BURNDOWN_ISSUE_CLAIM_SCRIPT: join(first.root, "claim.mjs"),
        LANDING_ROUTES: JSON.stringify(routes),
        QUEUE_KEYS: JSON.stringify(fixtures.map((f) => f.key)),
        QUEUE_OPTIONS_FILE: optionsPath,
        ...extra
      }
    })
  }
}

test("actual queue parks oversized required checks before model/push/close while another member lands", async (t) => {
  const large = await completeLandingFixture(t)
  const valid = await completeLandingFixture(t)
  await large.put(
    "bin/pnpm",
    `#!${process.execPath}\nif(process.argv.at(-1)==='typecheck')process.stdout.write('x'.repeat(5*1024*1024));\n`
  )
  const runQueue = await publicQueueFixture(t, [large, valid])
  const result = runQueue()
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.landed, [valid.key], result.stdout + result.stderr)
  assert.deepEqual(report.quarantined, [])
  assert.equal(report.incomplete[0].key, large.key)
  assert.match(report.incomplete[0].error, /REVIEW_INPUT_INCOMPLETE prechecks_input_limit/)
  assert.equal((await large.commands()).some((args) => args.includes("push") || args[0] === "claude"), false)
  assert.equal((await valid.commands()).filter((args) => args.includes("push")).length, 1)
  const comments = (await large.commands()).filter((args) => args[0] === "claim" && args.includes("--close"))
  assert.equal(comments.length, 1, "only the independently accepted member closes")
  const retained = await readFile(join(homedir(), "Smithers-Ops/burndown/landings", `${large.key}.prechecks.log`))
  assert.ok(retained.byteLength > 5 * 1024 * 1024, "full required evidence remains on disk")
  for (const f of [large, valid]) {
    assert.equal(statSync(join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.sh`)).mode & 0o777, 0o700)
  }
})

test("multi-megabyte optional notes reach bounded review through the actual landing file transport", async (t) => {
  const f = await completeLandingFixture(t)
  const notes = "optional notes ".repeat(160_000)
  const memberPath = join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.member.json`)
  await writeFile(memberPath, "old readable member", { mode: 0o644 })
  await chmod(memberPath, 0o644)
  assert.equal(statSync(memberPath).mode & 0o777, 0o644)
  const source = join(f.root, "large-notes.sh")
  await writeFile(
    source,
    withReviewAccounts(
      landingScript({
        key: f.key,
        repo: "smithersai/smithers",
        commits: [{ issue: 1, commit: "a".repeat(40) }],
        notes
      }),
      f.root
    )
  )
  const result = spawnSync("sh", [source], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.equal(result.status, 0, result.stderr)
  const saved = JSON.parse(
    await readFile(join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.acceptance.json`), "utf8")
  )
  const receipt = saved.reviewInput.optional.find((item: { field: string }) => item.field === "notes")
  assert.equal(receipt.omission, "optional_input_limit")
  assert.equal(receipt.includedBytes, 0)
  assert.equal(receipt.providedBytes, Buffer.byteLength(JSON.stringify(notes)))
  assert.equal(receipt.digest, createHash("sha256").update(JSON.stringify(notes)).digest("hex"))
  assert.ok(saved.reviewInput.inputBytes <= 1_048_576)
  assert.equal(statSync(memberPath).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(memberPath, "utf8")).notes, notes)
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
})

test("explicit landed recovery revalidates changed acceptance and original SHA before any issue close", async (t) => {
  const f = await completeLandingFixture(t)
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nif(process.argv.at(-1)==='typecheck')process.stdout.write('EXECUTED'.repeat(20_000));\n`
  )
  const initial = f.runLanding()
  assert.equal(initial.status, 0, initial.stdout + initial.stderr)
  const pushed = join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.pushed.json`)
  const original = JSON.parse(await readFile(pushed, "utf8"))
  assert.ok(
    Buffer.byteLength(JSON.stringify(original)) > 128 * 1024,
    "whole retained evidence exceeds a Linux single-argument bound"
  )
  const runQueue = await publicQueueFixture(t, [f])
  const issue = join(f.root, "current-issue.json")
  await writeFile(
    issue,
    JSON.stringify({ number: 1, title: "Acceptance", body: "Current acceptance changed.", comments: [] })
  )
  const changed = runQueue({ REVIEW_ISSUE_FILE: issue })
  assert.equal(changed.status, 0, changed.stderr)
  assert.match(JSON.parse(changed.stdout).receiptsPending[0].error, /ACCEPTANCE_CHANGED/)
  assert.deepEqual(JSON.parse(await readFile(pushed, "utf8")), original)
  const options = { reverify: [f.key], expectedReceipts: [{ key: f.key, receipt: original }] }
  const drift = runQueue({ SHA_DRIFT_AT: "0" }, options)
  assert.equal(drift.status, 0, drift.stderr)
  assert.match(JSON.parse(drift.stdout).receiptsPending[0].error, /PUSHED_RECEIPT_REMOTE_MISMATCH/)
  assert.deepEqual(JSON.parse(await readFile(pushed, "utf8")), original)
  await unlink(pushed)
  await unlink(f.commandLog + ".pushed")
  const lost = runQueue({}, options)
  assert.equal(lost.status, 0, lost.stderr)
  assert.match(JSON.parse(lost.stdout).receiptsPending[0].error, /PUSHED_RECEIPT_REMOTE_MISMATCH/)
  assert.deepEqual(JSON.parse(lost.stdout).receiptsPending[0].receipt, original)
  await assert.rejects(readFile(pushed), { code: "ENOENT" })
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
  await writeFile(pushed, JSON.stringify(original))
  await writeFile(f.commandLog + ".pushed", "")
  const rejected = runQueue({ REVIEW_ISSUE_FILE: issue }, options)
  assert.equal(rejected.status, 0, rejected.stderr)
  assert.match(JSON.parse(rejected.stdout).receiptsPending[0].error, /ACCEPTANCE_INVALID/)
  assert.deepEqual(JSON.parse(await readFile(pushed, "utf8")), original, "failed re-review retains original acceptance")
  assert.equal((await f.commands()).some((args) => args[0] === "claim" && args.includes("--close")), false)
  const acceptance = {
    version: 1,
    repo: "smithersai/smithers",
    revision: "a".repeat(40),
    issues: [{
      issue: 1,
      disposition: "complete",
      criteria: [{ criterion: "Current acceptance changed.", evidence: ["CHECKS_PASSED"] }],
      remaining: []
    }]
  }
  const resumed = runQueue({ REVIEW_ISSUE_FILE: issue, ACCEPTANCE_RESULT: JSON.stringify(acceptance) }, options)
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.deepEqual(JSON.parse(resumed.stdout).landed, [f.key], resumed.stdout + resumed.stderr)
  assert.equal(
    (await f.commands()).filter((args) => args.includes("push")).length,
    1,
    "the original push is the only push"
  )
  assert.equal((await f.commands()).filter((args) => args[0] === "claim" && args.includes("--close")).length, 1)
  assert.deepEqual(JSON.parse(await readFile(pushed, "utf8")).landed, original.landed)
})

test("successful landing checks both exact candidates, reviews, pushes once, and returns the landed SHA", async (t) => {
  const f = await completeLandingFixture(t)
  const result = f.runLanding()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^LANDED 1 a{40}$/m)
  const commands = await f.commands()
  const rebase = commands.findIndex((args) => args.includes("rebase"))
  const push = commands.findIndex((args) => args.includes("push"))
  const checks = commands
    .map((args, index) => (args[0] === "pnpm" && args.at(-1) === "typecheck" ? index : -1))
    .filter((index) => index >= 0)
  const review = commands.findIndex((args) => args[0] === "claude" && args.includes("-p"))
  assert.match(result.stderr, /REVIEW_REVISION a{40}/)
  assert.ok(review > checks[1]! && review < push)
  assert.equal(checks.length, 2)
  assert.ok(checks[0]! < rebase)
  assert.ok(checks[1]! > rebase && checks[1]! < push)
  assert.equal(commands.filter((args) => args.includes("push")).length, 1)
})

test("partial native identity can land with its full acceptance explicitly remaining open", async (t) => {
  const f = await completeLandingFixture(t)
  const receipt = {
    version: 1,
    repo: "smithersai/smithers",
    revision: "a".repeat(40),
    issues: [{
      issue: 1871,
      disposition: "landed",
      criteria: [],
      remaining: [{
        issue: "smithersai/smithers#1871",
        condition: "Complete native tool identities before enabling default caching."
      }]
    }]
  }
  const result = f.runLanding({ ACCEPTANCE_RESULT: JSON.stringify(receipt) }, 1871)
  assert.equal(result.status, 0, result.stderr)
  const root = join(homedir(), "Smithers-Ops/burndown/landings")
  const record = JSON.parse(await readFile(join(root, `${f.key}.pushed.json`), "utf8"))
  assert.deepEqual(record.acceptance.receipt, receipt)
  assert.equal(record.landed[0].issue, 1871)
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
})

test("cold already-landed READY automatically verifies acceptance without rebasing or pushing", async (t) => {
  const f = await completeLandingFixture(t)
  await writeFile(f.commandLog + ".pushed", "already present on remote main")
  const result = f.runLanding()
  assert.equal(result.status, 0, result.stderr)
  const receipts = join(homedir(), "Smithers-Ops/burndown/landings")
  const acceptance = JSON.parse(await readFile(join(receipts, `${f.key}.acceptance.json`), "utf8"))
  assert.equal(acceptance.receipt.revision, "a".repeat(40))
  assert.equal(acceptance.receipt.issues[0].disposition, "complete")
  const commands = await f.commands()
  assert.equal(commands.filter((args) => args[0] === "pnpm" && args.at(-1) === "typecheck").length, 2)
  assert.equal(commands.filter((args) => args[0] === "claude" && args.includes("-p")).length, 1)
  assert.ok(!commands.some((args) => args.includes("push") || args.includes("rebase")))
})

test("cold landed verification failure retains authoritative landing without completing acceptance", async (t) => {
  const f = await completeLandingFixture(t)
  await writeFile(f.commandLog + ".pushed", "already remote")
  const result = f.runLanding({ GH_ACCEPTANCE_FAIL: "1" })
  assert.notEqual(result.status, 0)
  const pushed = JSON.parse(
    await readFile(join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.pushed.json`), "utf8")
  )
  assert.equal(pushed.version, 2)
  assert.equal(pushed.phase, "landed")
  assert.equal(pushed.acceptance, undefined)
  assert.match(result.stdout, /^LANDING_CONFIRMED /m)
  assert.ok(!(await f.commands()).some((args) => args.includes("push") || args.includes("rebase")))
})

test("missing acceptance and issue provider failure block pipeline push", async (t) => {
  for (const extra of [{ ACCEPTANCE_SUPPRESS: "1" }, { GH_ACCEPTANCE_FAIL: "1" }]) {
    const f = await completeLandingFixture(t)
    const result = f.runLanding(extra)
    assert.notEqual(result.status, 0)
    assert.ok(!(await f.commands()).some((args) => args.includes("push")))
    await assert.rejects(readFile(join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.pushed.json`)), /ENOENT/)
  }
})

test("post-push fetch failure reconciles the remote SHA without a duplicate push", async (t) => {
  const f = await completeLandingFixture(t)
  const result = f.runLanding({ POST_PUSH_FETCH_FAIL: "1" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PUSH_RECONCILED/)
  const gitRoot = await realpath(f.root)
  assert.ok(
    (await f.commands()).some(
      (args) => args[0] === "git" && args[1] === "--git-dir" && args[2] === gitRoot && args.includes("ls-remote")
    )
  )
  assert.match(result.stdout, /^LANDED 1 a{40}$/m)
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
})

test("rebased candidate drift after checks or review prevents bookmark and push", async (t) => {
  for (
    const [at, receipt] of [
      ["3", "CHECK_REVISION_CHANGED"],
      ["4", "REVIEW_REVISION_CHANGED"]
    ]
  ) {
    const f = await completeLandingFixture(t)
    const result = f.runLanding({ SHA_DRIFT_AT: at! })
    assert.equal(result.status, 6, result.stderr)
    assert.match(result.stderr, new RegExp(receipt!))
    const commands = await f.commands()
    assert.ok(
      commands.some((args) => args.includes("rebase")),
      "the pre-rebase gate passed"
    )
    assert.ok(
      !commands.some((args) => (args.includes("bookmark") && !args.includes("main@origin")) || args.includes("push"))
    )
  }
})

test("replaying a reconciled landing returns its SHA without rebase, checks, or another push", async (t) => {
  const f = await completeLandingFixture(t)
  const first = f.runLanding({ POST_PUSH_FETCH_FAIL: "1" })
  assert.equal(first.status, 0, first.stderr)
  const pushedPath = join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.pushed.json`)
  const durable = await readFile(pushedPath, "utf8")
  assert.equal(JSON.parse(durable).acceptance.receipt.issues[0].disposition, "complete")
  await rm(join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.acceptance.json`))
  const before = (await f.commands()).length
  const retry = f.runLanding()
  assert.equal(retry.status, 0, retry.stderr)
  assert.match(retry.stdout, /^LANDED 1 a{40}$/m)
  const replay = (await f.commands()).slice(before)
  assert.ok(
    !replay.some((args) =>
      args.includes("rebase") || args.includes("push") || args[0] === "pnpm" || args[0] === "claude"
    )
  )
  assert.equal(await readFile(pushedPath, "utf8"), durable)
})

test("landing deadline kills grandchildren behind a lock wrapper that does not forward signals", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const started = join(f.root, "push-started")
  const push = `require('node:fs').writeFileSync(${
    JSON.stringify(
      started
    )
  }, 'started'); setTimeout(() => require('node:fs').writeFileSync(${
    JSON.stringify(
      marker
    )
  }, 'pushed'), 4000); setInterval(() => {}, 1000)`
  const shell = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${
    JSON.stringify(
      push
    )
  }], {detached: true, stdio: 'ignore'}); setInterval(() => {}, 1000)`
  const wrapper =
    `const {spawn} = require('node:child_process'); process.on('SIGTERM', () => {}); spawn(process.execPath, ['-e', ${
      JSON.stringify(
        shell
      )
    }], {stdio: 'ignore'}); setInterval(() => {}, 1000)`
  await assert.rejects(runLandingProcess(process.execPath, ["-e", wrapper], { timeout: 2000 }), /TIMEOUT|timeout/i)
  assert.equal(await readFile(started, "utf8"), "started")
  await new Promise((accept) => setTimeout(accept, 4500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("an orphan retaining landing pipes cannot postpone the deadline forever", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const pidPath = join(f.root, "orphan.pid")
  const orphan = `require('node:fs').writeFileSync(${
    JSON.stringify(pidPath)
  }, String(process.pid)); setInterval(() => {}, 1000)`
  // The intermediary exits before cancellation, leaving an orphan outside the pp id walk.
  const intermediary = `const c=require('node:child_process').spawn(process.execPath,['-e',${
    JSON.stringify(orphan)
  }],{detached:true,stdio:['ignore',1,2]}); c.unref()`
  const program = `require('node:child_process').spawn(process.execPath,['-e',${
    JSON.stringify(intermediary)
  }],{stdio:['ignore',1,2]}).on('exit',()=>console.log('ORPHANED')); setInterval(()=>{},1000)`
  const started = Date.now()
  const controller = new AbortController()
  const running = runLandingProcess(process.execPath, ["-e", program], { timeout: 20_000, signal: controller.signal })
  const pid = Number(await waitForFile(pidPath))
  controller.abort()
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The orphan may already have exited.
    }
  })
  await assert.rejects(
    Promise.race([
      running,
      new Promise((_, reject) => setTimeout(() => reject(new Error("UNBOUNDED_ORPHAN_PIPE")), 8000))
    ]),
    /CANCEL|abort/i
  )
  assert.ok(Date.now() - started < 8000)
})

test("forced landing cancellation removes only its owned verification snapshot", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await fakeSnapshot(f)
  const readyPath = join(f.root, "check-ready.json")
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nif(process.argv[2]==='install') process.exit(0); require('node:fs').writeFileSync(${
      JSON.stringify(readyPath)
    },JSON.stringify({pid:process.pid,cwd:process.cwd(),owned:process.env.BURNDOWN_VERIFICATION_ROOT})); setInterval(()=>{},1000);\n`
  )
  const controller = new AbortController()
  const running = runLandingProcess(
    process.execPath,
    ["--input-type=module", "-e", checksProgram, "smithers", "change-one"],
    {
      cwd: f.root,
      timeout: 20_000,
      signal: controller.signal,
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH}`,
        COMMAND_LOG: f.commandLog,
        BURNDOWN_CHECK_REVISION: "change-one"
      }
    }
  )
  const ready = JSON.parse(await waitForFile(readyPath)) as { pid: number; cwd: string; owned: string }
  const neighbor = await mkdtemp(join(dirname(ready.owned), "burndown-verification-"))
  await writeFile(join(neighbor, "keep"), "PRESERVE")
  t.after(() => rm(neighbor, { recursive: true, force: true }))
  controller.abort()
  await assert.rejects(running, /CANCEL|abort/i)
  assert.ok(ready.owned, "runner supplies private verification ownership")
  assert.equal(await readFile(join(neighbor, "keep"), "utf8"), "PRESERVE")
  await assert.rejects(readFile(join(ready.cwd, "packages/a/package.json")), { code: "ENOENT" })
  await waitForExit(ready.pid)
  assert.equal(await readFile(join(f.root, "packages/a/package.json"), "utf8"), pkg("@test/a"))
})

async function realLandingFixture(t: test.TestContext, advancedMain = false) {
  const f = await fixture(t, {
    "package.json": JSON.stringify({ name: "fixture", private: true }),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/result.txt": "BASE",
    ".gitignore": "commands.log*\n"
  })
  const originalPath = process.env.PATH!
  const jj = (args: Array<string>) => {
    const r = spawnSync("jj", args, {
      cwd: f.root,
      env: { ...process.env, PATH: originalPath },
      encoding: "utf8",
      maxBuffer: 16 << 20
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const remote = await mkdtemp(join(tmpdir(), "burndown-remote-"))
  t.after(() => rm(remote, { recursive: true, force: true }))
  const git = spawnSync("git", ["init", "--bare", "--initial-branch=main", remote], {
    env: { ...process.env, PATH: originalPath },
    encoding: "utf8"
  })
  assert.equal(git.status, 0, git.stderr)
  jj(["git", "init", "--colocate"])
  jj(["commit", "-m", "baseline"])
  const baseline = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  jj(["bookmark", "set", "main", "-r", "@-"])
  jj(["bookmark", "set", "mythical", "-r", "@-"])
  const mythical = jj(["log", "--no-graph", "-r", "mythical", "-T", "commit_id"])
  jj(["git", "remote", "add", "origin", remote])
  jj(["git", "push", "--allow-new", "--bookmark", "main"])
  if (advancedMain) {
    await f.put("packages/a/upstream.txt", "UPSTREAM")
    jj(["commit", "-m", "upstream advancement"])
    jj(["bookmark", "set", "main", "-r", "@-"])
    jj(["git", "push", "--bookmark", "main"])
  }
  await f.put("packages/a/result.txt", "MEMBER")
  jj(["commit", "-m", "member"])
  let member = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  if (advancedMain) {
    const memberChange = jj(["log", "--no-graph", "-r", member, "-T", "change_id"])
    jj(["rebase", "-r", member, "-d", baseline])
    member = jj(["log", "--no-graph", "-r", memberChange, "-T", "commit_id"])
  }
  // A shared copy need not descend from the member being landed.
  jj(["rebase", "-r", "@", "-d", "main@origin"])
  await f.put("unrelated.txt", "PRESERVE")
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs=require('node:fs'); const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify(['jj',...args])+'\\n');const pushed=process.env.COMMAND_LOG+'.pushed';if(args.includes('push')&&process.env.PUSH_FAIL_ONCE&&!fs.existsSync(process.env.COMMAND_LOG+'.rejected')){fs.writeFileSync(process.env.COMMAND_LOG+'.rejected','1');if(process.env.REMOTE_ADVANCE_SCRIPT){const a=spawnSync(process.env.REMOTE_ADVANCE_SCRIPT,[],{env:{...process.env,PATH:process.env.ORIGINAL_PATH},stdio:'inherit'});if(a.status!==0)process.exit(a.status);const rejected=spawnSync('jj',args,{env:{...process.env,PATH:process.env.ORIGINAL_PATH},stdio:'inherit'});process.exit(rejected.status)}process.exit(1)}if(args.includes('fetch')&&fs.existsSync(pushed)&&process.env.POST_PUSH_FETCH_FAIL)process.exit(1);if(args.includes('rebase')&&args.includes('@')&&fs.existsSync(pushed)&&process.env.ALIGN_FAIL)process.exit(1);const r=spawnSync('jj',args,{env:{...process.env,PATH:process.env.ORIGINAL_PATH},stdio:'inherit'});if(args.includes('push')&&r.status===0){fs.writeFileSync(pushed,'1');fs.appendFileSync(process.env.COMMAND_LOG+'.successful','1\\n')}process.exit(r.status);\n`
  )
  await f.put(
    "bin/claude",
    `#!${process.execPath}\n${claudeResultEnvelope}\nif(process.argv[2]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'reviewer@example.test'}));else console.log('VERDICT: PASS');\n`
  )
  await chmod(join(f.bin, "claude"), 0o755)
  const key = `test-real-main-${process.pid}-${Date.now()}`
  const receipts = join(homedir(), "Smithers-Ops/burndown/landings")
  await mkdir(receipts, { recursive: true })
  for (const suffix of ["prechecks", "checks", "review"]) {
    t.after(() => rm(join(receipts, `${key}.${suffix}.log`), { force: true }))
  }
  return {
    ...f,
    jj,
    mythical,
    member,
    remote,
    run(extra: Record<string, string> = {}, candidate = member) {
      const candidateKey = candidate === member ? key : `${key}-${candidate.slice(0, 12)}`
      for (
        const suffix of ["prechecks.log", "checks.log", "review.log", "acceptance.json", "pushed.json", "member.json"]
      ) {
        t.after(() => rm(join(receipts, `${candidateKey}.${suffix}`), { force: true }))
      }
      return spawnSync(
        "sh",
        [
          "-c",
          withReviewAccounts(
            landingScript({
              key: candidateKey,
              repo: "smithersai/smithers",
              commits: [{ issue: 1, commit: candidate }]
            }),
            f.root
          )
        ],
        {
          cwd: f.root,
          env: {
            ...process.env,
            PATH: `${f.bin}:${originalPath}`,
            ORIGINAL_PATH: originalPath,
            COMMAND_LOG: f.commandLog,
            ...extra
          },
          encoding: "utf8",
          timeout: 60_000
        }
      )
    }
  }
}

test("real jj landing keeps shared edits on main without moving long-lived bookmarks", async (t) => {
  const f = await realLandingFixture(t)
  const r = f.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(
    f.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]),
    f.jj(["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"])
  )
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  assert.equal(await readFile(join(f.root, "packages/a/result.txt"), "utf8"), "MEMBER")
  assert.equal(f.jj(["log", "--no-graph", "-r", "mythical", "-T", "commit_id"]), f.mythical)
})

test("real jj post-push realignment failure recovers shared edits without another push", async (t) => {
  const f = await realLandingFixture(t)
  const first = f.run({ ALIGN_FAIL: "1", POST_PUSH_FETCH_FAIL: "1" })
  assert.notEqual(first.status, 0, "failed realignment cannot report completed landing")
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  const retry = f.run()
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(
    f.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]),
    f.jj(["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"])
  )
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
  assert.equal(f.jj(["log", "--no-graph", "-r", "mythical", "-T", "commit_id"]), f.mythical)
})

test("non-contiguous historical review retains intervening diff bytes and refuses an oversized superset", async (t) => {
  const f = await realLandingFixture(t)
  const base = f.jj(["log", "--no-graph", "-r", `parents(${f.member})`, "-T", "commit_id"])
  f.jj(["rebase", "-r", "@", "-d", f.member])
  await f.put("packages/a/intervening.txt", "INTERVENING_COMMIT_SENTINEL\n" + "x".repeat(600_000))
  await f.put("packages/a/intervening-more.txt", "SECOND_INTERVENING_SENTINEL\n" + "y".repeat(600_000))
  f.jj([
    "commit",
    "packages/a/intervening.txt",
    "packages/a/intervening-more.txt",
    "-m",
    "intervening commit outside the READY member"
  ])
  await f.put("packages/a/final.txt", "LAST_MEMBER_SENTINEL")
  f.jj(["commit", "packages/a/final.txt", "-m", "last READY member commit"])
  const final = f.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  const historical = f.jj(["diff", "--git", "--from", base, "--to", final])
  assert.ok(historical.includes("INTERVENING_COMMIT_SENTINEL"))
  assert.ok(historical.includes("LAST_MEMBER_SENTINEL"))
  const checks = join(f.root, "historical-checks.log")
  const acceptance = join(f.root, "historical-acceptance.json")
  const memberPath = join(f.root, "historical-member.json")
  await writeFile(
    memberPath,
    JSON.stringify({
      repo: "smithersai/smithers",
      commits: [{ issue: 1, commit: f.member }, { issue: 3, commit: final }]
    }),
    { mode: 0o600 }
  )
  await writeFile(checks, `CHECK_REVISION ${final}\nCHECKS_PASSED\n`)
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", reviewProgram], {
    cwd: f.root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      ORIGINAL_PATH: process.env.PATH,
      COMMAND_LOG: f.commandLog,
      BURNDOWN_CHECK_REVISION: final,
      BURNDOWN_REVIEW_BASE: base,
      BURNDOWN_PRECHECKS_LOG: checks,
      BURNDOWN_CHECKS_LOG: checks,
      BURNDOWN_ACCEPTANCE_PATH: acceptance,
      BURNDOWN_ACCEPTANCE_MEMBER_PATH: memberPath
    }
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ReviewInputIncomplete: REVIEW_INPUT_INCOMPLETE required_input_limit/)
  assert.ok(result.stdout.includes(base))
  assert.ok(result.stdout.includes(final))
  assert.match(result.stdout, /historical superset including intervening commits/)
  assert.match(result.stdout, /REVIEW_INPUT_RECEIPT.*"status":"incomplete"/)
  assert.equal((await f.commands()).some((args) => args[0] === "claude" || args.includes("push")), false)
  await assert.rejects(readFile(acceptance), /ENOENT/)
})

test("landing cancellation retains process cleanup diagnostics", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  await f.put("bin/ps", "#!/bin/sh\necho DISCOVERY_FAILED >&2\nexit 23\n")
  await chmod(join(f.bin, "ps"), 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${f.bin}:${originalPath}`
  t.after(() => {
    process.env.PATH = originalPath
  })
  await assert.rejects(
    runLandingProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100 }),
    /LANDING_TIMEOUT[\s\S]*DISCOVERY_FAILED/
  )
})

test("a pre-aborted landing cannot perform a late action", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const marker = join(f.root, "pushed")
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runLandingProcess(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'pushed')`],
      { signal: controller.signal }
    ),
    /CANCEL|abort/i
  )
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("real jj landing refuses a bookmarked shared revision without changing it", async (t) => {
  const f = await realLandingFixture(t, true)
  f.jj(["rebase", "-r", "@", "-d", f.member])
  f.jj(["bookmark", "set", "protected", "-r", "@"])
  const protectedSha = f.jj(["log", "--no-graph", "-r", "protected", "-T", "commit_id"])
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /PROTECTED_LANDING_REVISION/)
  assert.equal(f.jj(["log", "--no-graph", "-r", "protected", "-T", "commit_id"]), protectedSha)
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  assert.equal((await f.commands()).filter((args) => args.includes("push") || args.includes("rebase")).length, 0)
})

test("pre-aborted landing refuses before attempting to spawn", async () => {
  const { runLandingProcess } = await import("../land.ts")
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runLandingProcess("/nonexistent/burndown-command", [], { signal: controller.signal }),
    /LANDING_CANCELLED/
  )
  await assert.rejects(
    runLandingProcess("invalid\0command", [], { signal: controller.signal }),
    /LANDING_CANCELLED/
  )
})

for (const exitCode of [0, 3]) {
  test(`natural landing exit ${exitCode} settles despite orphan pipes`, async (t) => {
    const { runLandingProcess } = await import("../land.ts")
    const f = await fixture(t, {})
    const pidPath = join(f.root, "orphan.pid")
    const orphan = `require('node:fs').writeFileSync(${
      JSON.stringify(pidPath)
    },String(process.pid)); setInterval(()=>{},1000)`
    const program =
      `const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,['-e',${
        JSON.stringify(orphan)
      }],{detached:true,stdio:['ignore',1,2]}); child.unref(); const timer=setInterval(()=>{if(fs.existsSync(${
        JSON.stringify(pidPath)
      })){clearInterval(timer);console.log('ROOT_EXIT ${exitCode}');process.exit(${exitCode})}},20)`
    const started = Date.now()
    const running = runLandingProcess(process.execPath, ["-e", program], { timeout: 20_000 })
    const pid = Number(await waitForFile(pidPath))
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL")
      } catch { /* Already exited. */ }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("UNBOUNDED_EXIT_DRAIN")), 6000)
      })
    ])
    try {
      if (exitCode === 0) assert.match((await bounded).stdout, /ROOT_EXIT 0/)
      else await assert.rejects(bounded, /LANDING_FAILED exit=3/)
      assert.ok(Date.now() - started < 6000)
    } finally {
      clearTimeout(timer)
    }
  })
}

for (const exitCode of [0, 6]) {
  test(`snapshot cleanup failure after exit ${exitCode} retains diagnostics and the owned path`, async (t) => {
    const { runLandingProcess } = await import("../land.ts")
    const f = await fixture(t, {})
    const ownedPath = join(f.root, "owned.json")
    const program =
      `const fs=require('node:fs');const path=require('node:path');const owned=process.env.BURNDOWN_VERIFICATION_ROOT;fs.mkdirSync(path.join(owned,'snapshot'));fs.writeFileSync(path.join(owned,'snapshot','keep'),'receipt');fs.chmodSync(owned,0o500);fs.writeFileSync(${
        JSON.stringify(ownedPath)
      },JSON.stringify(owned)); console.log('OWNED '+owned); if(${exitCode}===6)process.stderr.write('x'.repeat(5000)+'CHECK_RED_END'); process.exit(${exitCode})`
    let runningError: unknown
    try {
      await runLandingProcess(process.execPath, ["-e", program], { timeout: 20_000 })
    } catch (error) {
      runningError = error
    }
    const owned = JSON.parse(await readFile(ownedPath, "utf8")) as string
    t.after(async () => {
      if (await exists(owned)) await chmod(owned, 0o700)
      await rm(owned, { recursive: true, force: true })
    })
    assert.match(String(runningError), /snapshot cleanup:[\s\S]*EACCES/)
    assert.ok(String(runningError).includes(owned))
    assert.ok(await realpath(owned))
    const receipt = landingFailure("cleanup-receipt", runningError)
    assert.match(receipt.log, /snapshot cleanup:/)
    assert.ok(receipt.log.includes(owned))
    assert.ok(Buffer.byteLength(receipt.log) <= 4000)
    if (exitCode === 6) assert.match(receipt.log, /CHECK_RED_END/)
    // The lease keeps the diagnostic until deletion really succeeds.
    const { recoverRetainedSnapshots } = await import("../land.ts")
    const blocked = await recoverRetainedSnapshots({ ledger: snapshotLedger })
    assert.ok(!blocked.recovered.includes(owned))
    const retained = blocked.retained.find((item) => item.path === owned)
    assert.match(retained?.diagnostics.join("\n") ?? "", /snapshot cleanup:[\s\S]*EACCES[\s\S]*recovery:.*EACCES/)
    assert.match(await readFile(leaseFor(owned), "utf8"), /recovery:.*EACCES/)
    assert.ok(await exists(owned))
    // Real permission repair: the next pass removes the snapshot and releases its lease.
    await chmod(owned, 0o700)
    const repaired = await recoverRetainedSnapshots({ ledger: snapshotLedger })
    assert.ok(repaired.recovered.includes(owned))
    assert.equal(await exists(owned), false)
    assert.equal(await exists(leaseFor(owned)), false)
  })
}

test("snapshot removal deadline reports bounded failure with original output", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const ownedPath = join(f.root, "owned.json")
  const program =
    `const fs=require('node:fs');const path=require('node:path');const owned=process.env.BURNDOWN_VERIFICATION_ROOT;for(let i=0;i<1000;i++)fs.writeFileSync(path.join(owned,String(i)),'snapshot');fs.writeFileSync(${
      JSON.stringify(ownedPath)
    },JSON.stringify(owned));console.log('CHECK_OUTPUT_RETAINED')`
  let failure: (Error & { stdout?: string }) | undefined
  const completion = runLandingProcess(process.execPath, ["-e", program], {
    timeout: 60_000,
    snapshotCleanupTimeout: 1
  }).then(
    () => assert.fail("snapshot timeout must refuse success"),
    (error) => {
      failure = error as Error & { stdout?: string }
    }
  )
  const owned = JSON.parse(await waitForFile(ownedPath, 60_000)) as string
  const started = Date.now()
  await completion
  t.after(() => rm(owned, { recursive: true, force: true }))
  assert.match(String(failure), /snapshot cleanup timeout/)
  assert.match(failure?.stdout ?? "", /CHECK_OUTPUT_RETAINED/)
  assert.ok(String(failure).includes(owned))
  assert.ok(Date.now() - started < 5000)
  // Removal continues after the failure receipt; wait for its real completion.
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      await realpath(owned)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
    assert.ok(Date.now() < deadline, "snapshot removal completes after bounded failure")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // The late removal releases its own lease; nothing is left for recovery.
  while (await exists(leaseFor(owned))) {
    assert.ok(Date.now() < deadline, "late removal releases the lease")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
})

test("successful landing releases its snapshot lease", async () => {
  const { runLandingProcess } = await import("../land.ts")
  const { stdout } = await runLandingProcess(process.execPath, [
    "-e",
    "console.log('OWNED '+process.env.BURNDOWN_VERIFICATION_ROOT)"
  ])
  const owned = /OWNED (\S+)/.exec(stdout)?.[1] ?? assert.fail(stdout)
  assert.equal(await exists(owned), false)
  assert.equal(await exists(leaseFor(owned)), false)
})

// A separate host process runs a real landing; SIGKILL models a crash or host restart mid-landing.
const landingHost = (ledger: string) =>
  spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `const { runLandingProcess } = await import(${
      JSON.stringify(new URL("../land.ts", import.meta.url).href)
    }); await runLandingProcess(process.execPath, ["-e", ${
      JSON.stringify(
        "require('node:fs').writeFileSync(process.env.BURNDOWN_VERIFICATION_ROOT + '/pid', String(process.pid)); setTimeout(() => {}, 60000)"
      )
    }], { snapshotLedger: ${JSON.stringify(ledger)} })`
  ], { stdio: "ignore" })

const orphans = new Set<number>()
test.after(() => {
  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already exited.
    }
  }
})
const waitForLeases = async (ledger: string, count: number) => {
  const deadline = Date.now() + 30_000
  while (true) {
    const names = (await readdir(ledger).catch(() => [])).filter((name) => name.endsWith(".json"))
    if (names.length >= count) {
      // Wait until each landing child is running, then make sure it never outlives the test.
      for (const name of names) {
        const pid = Number(
          await waitForFile(join(JSON.parse(await readFile(join(ledger, name), "utf8")).path, "pid"), 30_000)
        )
        orphans.add(pid)
      }
      return names.sort()
    }
    assert.ok(Date.now() < deadline, "landing host wrote its lease")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test("recovery removes a dead host's snapshot and never a live sibling runner's", async (t) => {
  const { recoverRetainedSnapshots } = await import("../land.ts")
  const ledger = await mkdtemp(join(tmpdir(), "burndown-ledger-"))
  t.after(() => rm(ledger, { recursive: true, force: true }))
  const crashed = landingHost(ledger)
  const [crashedLease] = await waitForLeases(ledger, 1)
  const crashedPath = JSON.parse(await readFile(join(ledger, crashedLease!), "utf8")).path as string
  const sibling = landingHost(ledger)
  t.after(() => sibling.kill("SIGKILL"))
  const siblingLease = (await waitForLeases(ledger, 2)).find((name) => name !== crashedLease)!
  const siblingPath = JSON.parse(await readFile(join(ledger, siblingLease), "utf8")).path as string
  const crashedExit = new Promise((done) => crashed.once("exit", done))
  crashed.kill("SIGKILL")
  await crashedExit
  // The crashed host never ran its cleanup: its snapshot and lease survive it.
  assert.ok(await exists(crashedPath))
  const recovery = await recoverRetainedSnapshots({ ledger })
  assert.deepEqual(recovery.recovered, [crashedPath])
  assert.deepEqual(recovery.retained, [])
  assert.equal(await exists(crashedPath), false)
  assert.equal(await exists(join(ledger, crashedLease!)), false)
  assert.ok(await exists(siblingPath), "a live sibling's snapshot is never deleted")
  assert.ok(await exists(join(ledger, siblingLease)))
  // Its landing child is detached; killing the host alone would orphan the snapshot again.
  const siblingExit = new Promise((done) => sibling.once("exit", done))
  sibling.kill("SIGKILL")
  await siblingExit
  assert.deepEqual((await recoverRetainedSnapshots({ ledger })).recovered, [siblingPath])
})

test("recovery treats a reused pid as a dead owner and refuses foreign or unrecognised leases", async (t) => {
  const { recoverRetainedSnapshots } = await import("../land.ts")
  const ledger = await mkdtemp(join(tmpdir(), "burndown-ledger-"))
  t.after(() => rm(ledger, { recursive: true, force: true }))
  const snapshot = async (lease: Record<string, unknown>) => {
    const path = await mkdtemp(join(tmpdir(), "burndown-verification-"))
    t.after(() => rm(path, { recursive: true, force: true }))
    await writeFile(join(path, "keep"), "snapshot")
    const record = {
      version: 1,
      path,
      host: hostname(),
      pid: process.ppid,
      started: "Thu Jan  1 00:00:00 1970",
      createdAt: new Date().toISOString(),
      diagnostics: [],
      ...lease
    }
    await writeFile(join(ledger, `${path.split("/").at(-1)}.json`), JSON.stringify(record))
    return path
  }
  // Alive pid, different start identity: the pid was reused after the owner (or host) went away.
  const reused = await snapshot({})
  const foreign = await snapshot({ host: `${hostname()}-other` })
  const liveUnknownStart = await snapshot({ started: null })
  const outside = await mkdtemp(join(tmpdir(), "burndown-other-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(
    join(ledger, `${outside.split("/").at(-1)}.json`),
    JSON.stringify({
      version: 1,
      path: outside,
      host: hostname(),
      pid: 2 ** 22 + 1,
      started: null,
      createdAt: "",
      diagnostics: []
    })
  )
  await writeFile(join(ledger, "torn.json"), "{")
  const recovery = await recoverRetainedSnapshots({ ledger })
  assert.deepEqual(recovery.recovered, [reused])
  assert.equal(await exists(reused), false)
  for (const kept of [foreign, liveUnknownStart]) assert.ok(await exists(join(kept, "keep")))
  assert.ok(await exists(outside), "a lease naming a path outside the snapshot namespace is never followed")
  assert.deepEqual(
    recovery.retained.map((item) => item.path).sort(),
    [
      join(ledger, `${outside.split("/").at(-1)}.json`),
      join(ledger, "torn.json")
    ].sort()
  )
  assert.ok(recovery.retained.some((item) => item.diagnostics.includes("invalid lease; never deleted")))
  assert.ok(recovery.retained.some((item) => /unreadable lease/.test(item.diagnostics.join(""))))
})

test("real jj rejected push retries the member and then lands an unrelated member", async (t) => {
  const f = await realLandingFixture(t)
  const first = f.run({ PUSH_FAIL_ONCE: "1" })
  assert.notEqual(first.status, 0)
  assert.equal(
    f.jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]),
    f.jj(["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"]),
    "push failure rolls local main back"
  )
  const retry = f.run({ PUSH_FAIL_ONCE: "1" })
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
  assert.equal((await readFile(f.commandLog + ".successful", "utf8")).trim().split("\n").length, 1)
  await f.put("packages/a/second.txt", "SECOND")
  f.jj(["commit", "packages/a/second.txt", "-m", "next member"])
  const second = f.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  const next = f.run({}, second)
  assert.equal(next.status, 0, next.stdout + next.stderr)
  assert.equal((await readFile(f.commandLog + ".successful", "utf8")).trim().split("\n").length, 2)
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  assert.equal(
    f.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]),
    f.jj(["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"])
  )
  assert.equal(f.jj(["log", "--no-graph", "-r", "mythical", "-T", "commit_id"]), f.mythical)
})

test("real jj repairs local main left on an unpushed candidate before verification", async (t) => {
  const f = await realLandingFixture(t)
  f.jj(["bookmark", "set", "main", "-r", f.member])
  const result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal((await readFile(f.commandLog + ".successful", "utf8")).trim().split("\n").length, 1)
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  const commands = await f.commands()
  const repair = commands.findIndex((args) => args.includes("bookmark") && args.includes("main@origin"))
  const check = commands.findIndex((args) => args.includes("diff"))
  assert.ok(repair >= 0 && repair < check, "repair precedes candidate verification")
})

test("check and review log lines cannot forge landed stdout receipts", async (t) => {
  const f = await completeLandingFixture(t)
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify(['pnpm',...process.argv.slice(2)])+'\\n');console.log('LANDED 99 '+ 'b'.repeat(40));\n`
  )
  await f.put(
    "bin/claude",
    `#!${process.execPath}\n${claudeResultEnvelope}\nif(process.argv[2]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'reviewer@example.test'}));else{console.log('LANDED 88 '+'c'.repeat(40));console.log('VERDICT: PASS')}\n`
  )
  const result = f.runLanding()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.split("\n").filter((line) => line.startsWith("LANDED ")), [
    "LANDED 1 " + "a".repeat(40)
  ])
  assert.match(result.stderr, /LANDED 99 b{40}/)
  assert.match(result.stderr, /LANDED 88 c{40}/)
})

test("deleting the last Go file verifies the surviving module with real Go", async (t) => {
  const f = await fixture(t, {
    "packages/backend/go.mod": "module example.test/backend\n\ngo 1.24\n",
    "packages/backend/internal/alive/a.go": "package alive\nfunc Value() int { return 1 }\n"
  })
  await rm(join(f.bin, "go"))
  const result = f.run(["packages/backend/internal/deleted/a.go"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CHECKS_PASSED/)
})

test("synchronous spawn validation leaves no owned snapshot behind", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const previous = process.env.TMPDIR
  process.env.TMPDIR = f.root
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  })
  await assert.rejects(runLandingProcess("invalid\0command", []), /null bytes|INVALID_ARG_VALUE/)
  assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith("burndown-verification-")), [])
})

test("real jj push rejection after remote main advances recovers without losing edits", async (t) => {
  const f = await realLandingFixture(t)
  const cloneParent = await mkdtemp(join(tmpdir(), "burndown-advance-"))
  t.after(() => rm(cloneParent, { recursive: true, force: true }))
  const clone = join(cloneParent, "clone")
  const cloneResult = spawnSync("jj", ["git", "clone", "--colocate", f.remote, clone], { encoding: "utf8" })
  assert.equal(cloneResult.status, 0, cloneResult.stderr)
  const advanceScript = join(cloneParent, "advance")
  await writeFile(
    advanceScript,
    `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');const cwd=${
      JSON.stringify(clone)
    };function jj(args){const r=spawnSync('jj',args,{cwd,stdio:'inherit'});if(r.status!==0)process.exit(r.status)}jj(['rebase','-r','@','-d','main@origin']);fs.writeFileSync(cwd+'/packages/a/upstream.txt','UPSTREAM');jj(['commit','packages/a/upstream.txt','-m','remote advancement']);jj(['bookmark','set','main','-r','@-']);jj(['git','push','--bookmark','main']);\n`
  )
  await chmod(advanceScript, 0o755)
  const first = f.run({ PUSH_FAIL_ONCE: "1", REMOTE_ADVANCE_SCRIPT: advanceScript })
  assert.notEqual(first.status, 0)
  const retry = f.run()
  assert.equal(retry.status, 0, retry.stdout + retry.stderr)
  assert.equal(await readFile(join(f.root, "packages/a/upstream.txt"), "utf8"), "UPSTREAM")
  assert.equal(await readFile(join(f.root, "unrelated.txt"), "utf8"), "PRESERVE")
  assert.equal((await readFile(f.commandLog + ".successful", "utf8")).trim().split("\n").length, 1)
  assert.equal(
    f.jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]),
    f.jj(["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"])
  )
})

test("a deleted Go package in an empty module cannot report passed checks with real Go", async (t) => {
  const f = await fixture(t, { "packages/backend/go.mod": "module example.test/backend\n\ngo 1.24\n" })
  await rm(join(f.bin, "go"))
  const result = f.run(["packages/backend/internal/deleted/a.go"])
  assert.notEqual(result.status, 0, result.stdout)
  assert.doesNotMatch(result.stdout, /CHECKS_PASSED/)
})

test("code 6 receipts retain process cleanup diagnostics with the check tail", () => {
  for (const diagnostic of ["process-tree cleanup: discovery failed", "root process exit timeout"]) {
    const receipt = landingFailure("cleanup-receipt", {
      code: 6,
      stderr: "x".repeat(5000) + "CHECK_RED_END",
      message: diagnostic
    })
    assert.match(receipt.log, /CHECK_RED_END/)
    assert.ok(receipt.log.includes(diagnostic))
    assert.ok(Buffer.byteLength(receipt.log) <= 4000)
  }
})

for (const guard of ["conflict", "member-bookmarks", "working-copy"]) {
  test(`a failed jj ${guard} query refuses publication and subsequent mutations`, async (t) => {
    const f = await completeLandingFixture(t)
    const wrapper = await readFile(join(f.bin, "jj"), "utf8")
    await f.put(
      "bin/jj",
      wrapper.replace(
        "const pushed =",
        "const rev = args[args.indexOf('-r') + 1] ?? ''; if (args.includes('log') && ((process.env.FAIL_GUARD === 'conflict' && rev.includes('conflicts()')) || (process.env.FAIL_GUARD === 'member-bookmarks' && rev.includes('bookmarks()') && !rev.includes('@')) || (process.env.FAIL_GUARD === 'working-copy' && rev.includes('bookmarks()') && rev.includes('@')))) { console.error('GUARD_QUERY_FAILED ' + process.env.FAIL_GUARD); process.exit(17); } const pushed ="
      )
    )
    const result = f.runLanding({ FAIL_GUARD: guard })
    assert.equal(result.status, 7, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /JJ_QUERY_FAILED/)
    assert.match(result.stdout + result.stderr, /GUARD_QUERY_FAILED/)
    const commands = await f.commands()
    assert.equal(
      commands.filter((args) => args.includes("push") || (args.includes("bookmark") && !args.includes("main@origin")))
        .length,
      0
    )
    assert.equal(commands.filter((args) => args.includes("rebase")).length, guard === "conflict" ? 1 : 0)
  })
}

test("large green check and review logs stay on disk without exceeding landing output limits", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await completeLandingFixture(t)
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify(['pnpm',...args])+'\\n');if(args.at(-1)==='typecheck')process.stdout.write('C'.repeat(64*1024)+'CHECK_LARGE_END\\n');\n`
  )
  await f.put(
    "bin/claude",
    `#!${process.execPath}\nif(process.argv[2]!=='auth')require('node:fs').readFileSync(0);\n${claudeResultEnvelope}\nif(process.argv[2]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'reviewer@example.test'}));else{const member=JSON.parse(require('node:fs').readFileSync(process.env.BURNDOWN_ACCEPTANCE_MEMBER_PATH,'utf8'));const receipt={version:1,repo:member.repo,revision:process.env.BURNDOWN_CHECK_REVISION,issues:member.commits.map(({issue})=>({issue,disposition:'complete',criteria:[{criterion:'Acceptance complete.',evidence:['CHECKS_PASSED']}],remaining:[]}))};process.stdout.write('R'.repeat(7*1024*1024)+'REVIEW_LARGE_END\\nACCEPTANCE '+JSON.stringify(receipt)+'\\nVERDICT: PASS\\n');}\n`
  )
  const result = await runLandingProcess("sh", [
    "-c",
    withReviewAccounts(
      landingScript({ key: f.key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "a".repeat(40) }] }),
      f.root
    )
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog },
    timeout: 60_000
  })
  assert.match(result.stdout, /^LANDED 1 a{40}$/m)
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 16 * 1024)
  assert.match(result.stderr, /CHECK_LARGE_END/)
  assert.match(result.stderr, /REVIEW_LARGE_END/)
  let retained = 0
  for (const suffix of ["prechecks", "checks", "review"]) {
    const contents = await readFile(join(homedir(), "Smithers-Ops/burndown/landings", `${f.key}.${suffix}.log`))
    retained += contents.byteLength
    assert.ok(contents.byteLength > (suffix === "review" ? 7 * 1024 * 1024 : 64 * 1024))
  }
  assert.ok(retained > 7 * 1024 * 1024, "full successful receipts remain on disk")
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
})

test("standalone Fable limit at exit zero retries the next subscription with exact Fable", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({ REVIEW_FABLE_LIMIT: "1" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /REVIEW_CAPACITY claude-1 model:fable/)
  const reviews = (await f.commands()).filter((args) => args[1] === "-p")
  assert.equal(reviews.length, 2)
  assert.ok(reviews[1]!.includes(join(f.reviewHome, ".smithers/accounts/claude-5")))
  assert.ok(reviews.every((args) => args[3] === "claude-fable-5-1"))
})

const fableLimit =
  "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."

test("all discovered Fable accounts exhausted remain unavailable without revision receipt", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({
    REVIEW_RESPONSES: JSON.stringify({
      "claude-1": { output: fableLimit, exit: 1, capacity: true },
      "claude-5": { output: fableLimit, capacity: true }
    })
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /REVIEW_UNAVAILABLE/)
  assert.doesNotMatch(result.stdout, /REVIEW_REVISION/)
  assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 2)
})

test("discovery honors safe preferred account and excludes duplicates and forbidden accounts", async (t) => {
  const f = await reviewFixture(t)
  for (const id of ["claude-2", "claude-4", "claude-6", "claude-9", "claude-11", "claude-other"]) {
    await mkdir(join(f.reviewHome, ".smithers/accounts", id), { recursive: true })
  }
  const result = f.review({
    BURNDOWN_REVIEW_ACCOUNT: "claude-9",
    BURNDOWN_REVIEW_EXCLUDED_ACCOUNTS: "claude-11 claude-5,claude-11",
    REVIEW_RESPONSES: JSON.stringify({
      "claude-9": { email: "SAME@example.test", output: fableLimit, capacity: true },
      "claude-1": { email: "same@EXAMPLE.test" }
    })
  })
  assert.equal(result.status, 0, result.stderr)
  const commands = await f.commands()
  const reviewed = commands.filter((args) => args[1] === "-p").map((args) => args.at(-4))
  assert.deepEqual(reviewed, [
    join(f.reviewHome, ".smithers/accounts/claude-9"),
    join(f.reviewHome, ".smithers/accounts/claude-2")
  ])
  assert.ok(
    commands.every((args) =>
      !["claude-4", "claude-6", "claude-5", "claude-11", "claude-other"].some((id) =>
        args.includes(join(f.reviewHome, ".smithers/accounts", id))
      )
    )
  )
})

test("unsafe or forbidden preferred accounts fail closed before any review", async (t) => {
  const f = await reviewFixture(t)
  for (const id of ["../claude-1", "claude-4", "claude-6", "/home/operator/.claude"]) {
    const result = f.review({ BURNDOWN_REVIEW_ACCOUNT: id })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /REVIEW_REVISION/)
  }
  assert.ok((await f.commands()).every((args) => args[1] !== "-p"))
})

test("review prose mentioning capacity and genuine FAIL never retry another account", async (t) => {
  for (const output of ["Review found a bug: " + fableLimit, fableLimit + "\nVERDICT: FAIL", "VERDICT: FAIL"]) {
    const f = await reviewFixture(t)
    const result = f.review({
      REVIEW_RESPONSES: JSON.stringify({ "claude-1": { output, exit: 1, capacity: output.includes("VERDICT") } })
    })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
    assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
  }
})

test("malformed identity refuses review and does not skip into another account", async (t) => {
  for (
    const identityRaw of [
      "not-json",
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: 42 }),
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "not-an-email" })
    ]
  ) {
    const f = await reviewFixture(t)
    const result = f.review({ REVIEW_RESPONSES: JSON.stringify({ "claude-1": { identityRaw } }) })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /REVIEW_REVISION/)
    const commands = await f.commands()
    assert.equal(commands.length, 1)
    assert.equal(commands[0]![1], "auth")
  }
})

test("a real execution failure with capacity text in diagnostic prose fails closed", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({
    REVIEW_RESPONSES: JSON.stringify({
      "claude-1": { output: "", stderr: "Security failure: rate limit is mentioned in an untrusted diff", exit: 2 }
    })
  })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
  assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
})

test("review deadline stops account failover and cannot emit a late revision receipt", async (t) => {
  const f = await reviewFixture(t)
  const program = reviewProgram.replace("Date.now() + 600_000", "Date.now() + 15_000")
  assert.notEqual(program, reviewProgram, "fixture must shorten the real review deadline")
  const result = f.review(
    { REVIEW_RESPONSES: JSON.stringify({ "claude-1": { output: fableLimit, delay: 20_000 } }) },
    program,
    30_000
  )
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /REVIEW_REVISION/)
  assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
})

test("overall review deadline covers issue reads before any reviewer starts", async (t) => {
  const f = await reviewFixture(t)
  const marker = join(f.root, "gh-started")
  const program = reviewProgram.replace("Date.now() + 600_000", "Date.now() + 10_000")
  assert.notEqual(program, reviewProgram)
  const started = Date.now()
  const result = f.review({ GH_ACCEPTANCE_DELAY: "15000", GH_ACCEPTANCE_MARKER: marker }, program, 30_000)
  assert.notEqual(result.status, null, "the inner review deadline must settle before the outer harness")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ETIMEDOUT/)
  assert.ok(Date.now() - started < 20_000, "the overall ten-second budget must kill the delayed issue read")
  assert.equal(await readFile(marker, "utf8"), "started")
  assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 0)
  assert.doesNotMatch(result.stdout, /REVIEW_REVISION/)
  await assert.rejects(readFile(join(f.root, "acceptance.json")), /ENOENT/)
})

test("genuine authentication execution failure is not capacity or another-account retry", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({ REVIEW_RESPONSES: JSON.stringify({ "claude-1": { authExit: 2 } }) })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /REVIEW_IDENTITY_FAILED/)
  assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
  assert.equal((await f.commands()).length, 1)
})

test("terminated reviewer fails closed without capacity fallback", async (t) => {
  const f = await reviewFixture(t)
  const result = f.review({ REVIEW_RESPONSES: JSON.stringify({ "claude-1": { signal: "SIGTERM" } }) })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /REVIEW_FAILED SIGTERM/)
  assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
  assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
})

test("account discovery skips symlink aliases and explicit excluded email identities", async (t) => {
  const f = await reviewFixture(t)
  await symlink(
    join(f.reviewHome, ".smithers/accounts/claude-1"),
    join(f.reviewHome, ".smithers/accounts/claude-2"),
    "dir"
  )
  const result = f.review({ BURNDOWN_EXCLUDE_EMAILS: "other@example.test,CLAUDE-1@EXAMPLE.TEST" })
  assert.equal(result.status, 0, result.stderr)
  const commands = await f.commands()
  assert.equal(commands.filter((args) => args[1] === "-p").length, 1)
  assert.ok(commands.every((args) => !args.includes(join(f.reviewHome, ".smithers/accounts/claude-2"))))
  assert.ok(commands.at(-1)!.includes(join(f.reviewHome, ".smithers/accounts/claude-5")))
})

test("ordinary model capacity prose cannot reroll reviewer accounts", async (t) => {
  for (const response of [{ output: fableLimit }, { output: "quota exceeded", exit: 1 }]) {
    const f = await reviewFixture(t)
    const result = f.review({ REVIEW_RESPONSES: JSON.stringify({ "claude-1": response }) })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
    assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
  }
})

test("malformed provider envelopes and model downgrade refuse review without failover", async (t) => {
  for (
    const response of [
      { resultRaw: "VERDICT: PASS" },
      { envelope: { type: "result", is_error: false, result: "VERDICT: PASS" } },
      {
        envelope: {
          type: "result",
          subtype: "success",
          terminal_reason: "completed",
          is_error: false,
          result: "VERDICT: PASS",
          modelUsage: { "claude-opus-4-6": {} }
        }
      },
      { envelope: { type: "result", is_error: true, result: fableLimit, api_error_status: 429 } }
    ]
  ) {
    const f = await reviewFixture(t)
    const result = f.review({ REVIEW_RESPONSES: JSON.stringify({ "claude-1": response }) })
    assert.notEqual(result.status, 0)
    if (JSON.stringify(response).includes("claude-opus")) assert.match(result.stderr, /REVIEW_MODEL_MISMATCH/)
    assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
    assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
  }
})

test("provider capacity metadata distinguishes subscription limits and provider overload", async (t) => {
  for (
    const [api_error, api_error_status, category] of [
      ["rate_limit_error", 429, "subscription"],
      ["usage_limit_exceeded", 429, "subscription"],
      ["overloaded_error", 503, "provider"]
    ] as const
  ) {
    const f = await reviewFixture(t)
    const result = f.review({
      REVIEW_RESPONSES: JSON.stringify({
        "claude-1": {
          exit: 1,
          envelope: {
            type: "result",
            subtype: "success",
            is_error: true,
            terminal_reason: "api_error",
            api_error,
            api_error_status,
            result: "Provider unavailable",
            modelUsage: {}
          }
        }
      })
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(`REVIEW_CAPACITY claude-1 ${category}`))
    assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 2)
  }
})

test("valid envelopes with wrong model identity or security API errors fail closed", async (t) => {
  const responses = [
    {
      type: "result",
      subtype: "success",
      terminal_reason: "completed",
      is_error: false,
      result: "VERDICT: PASS",
      modelUsage: { "claude-fable-5-1": { canonicalModel: "claude-opus-4-6", provider: "firstParty" } }
    },
    {
      type: "result",
      subtype: "success",
      terminal_reason: "completed",
      is_error: false,
      result: "VERDICT: PASS",
      modelUsage: { "claude-fable-5-1": { canonicalModel: "claude-fable-5-1", provider: "bedrock" } }
    },
    {
      type: "result",
      subtype: "success",
      terminal_reason: "api_error",
      is_error: true,
      result: "quota exceeded",
      api_error_status: 429,
      api_error: "security_error",
      modelUsage: {}
    }
  ]
  for (const [index, envelope] of responses.entries()) {
    const f = await reviewFixture(t)
    const result = f.review({ REVIEW_RESPONSES: JSON.stringify({ "claude-1": { envelope } }) })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, index < 2 ? /REVIEW_MODEL_MISMATCH/ : /REVIEW_FAILED/)
    assert.doesNotMatch(result.stdout, /REVIEW_CAPACITY|REVIEW_REVISION/)
    assert.equal((await f.commands()).filter((args) => args[1] === "-p").length, 1)
  }
})
