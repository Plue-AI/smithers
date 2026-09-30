import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { checksProgram, LandFailed, landingFailure, landingScript, reviewProgram } from "../land.ts"

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
  for (const command of ["jj", "pnpm", "go", "helm"]) {
    await put(
      `bin/${command}`,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (${
        JSON.stringify(command)
      } === 'jj') { process.stdout.write(process.env.CHANGED_PATHS); } else { fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify([${
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
          timeout: 10_000
        }
      )
    },
    async commands() {
      return (await readFile(commandLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) =>
        JSON.parse(line)
      )
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
  const f = await fixture(t, { "packages/backend/go.mod": "module example.test/backend" })
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
  assert.ok(check < script.indexOf("jj rebase"), "prepared candidate checks must precede rebase")
  assert.ok(check < script.indexOf("bookmark set main"))
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
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.some(x => x.includes('::main@origin'))) process.exit(0); if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('git') && args.includes('root')) console.log(process.cwd()); else if (args.includes('log') && !args.some(x => x.includes('conflicts()'))) console.log(args.at(-1) === 'commit_id' ? 'a'.repeat(40) : 'change-one');\n`
  )
  await f.put(
    "bin/git",
    `#!${process.execPath}\nconst { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); const out = args[args.indexOf('--output') + 1]; const result = spawnSync('tar', ['-cf', out, '-C', process.cwd(), 'packages']); process.exit(result.status);\n`
  )
  await chmod(join(f.bin, "git"), 0o755)
  const result = spawnSync("sh", [
    "-c",
    landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "abc" }] })
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog, FAIL_CHECK: "typecheck" },
    encoding: "utf8",
    timeout: 10_000
  })
  assert.equal(result.status, 6, result.stderr)
  const commands = await f.commands()
  assert.ok(
    !commands.some((args) => args[0] === "jj" && args[1] === "rebase"),
    "red pre-rebase checks must prevent rebase"
  )
  assert.ok(!commands.some((args) => args[0] === "jj" && (args.includes("bookmark") || args.includes("push"))))
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
    timeout: 15_000
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /CHECK_TIMEOUT: overall 15-minute limit/)
  assert.deepEqual(await f.commands(), [["pnpm", "--fail-if-no-match", "--filter", "@test/a", "run", "typecheck"]])
})

test("real jj member tree is checked despite a green shared working copy", async (t) => {
  const f = await fixture(t, {
    "package.json": JSON.stringify({ name: "fixture", private: true }),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/result.txt": "BASELINE"
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
    `#!${process.execPath}\nconst fs = require('node:fs'); const {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.includes('fetch') || args.includes('rebase')) process.exit(0); if (args.some(x => x.includes('conflicts()') || x.includes('::main@origin'))) process.exit(0); if (args.some(x => x.includes('main@origin::') || x.includes('::'))) { console.log('ancestor'); process.exit(0); } const r = spawnSync('jj', args, {env: {...process.env, PATH: process.env.ORIGINAL_PATH}, stdio: 'inherit'}); process.exit(r.status);\n`
  )
  await f.put(
    "bin/pnpm",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['pnpm', ...args]) + '\\n'); if (args[0] === 'install') process.exit(0); console.log('CHECK_CWD ' + process.cwd()); if (fs.readFileSync('packages/a/result.txt', 'utf8') === 'RED') { console.log('MEMBER_RED'); process.exit(1); }\n`
  )
  const result = spawnSync("sh", [
    "-c",
    landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: member }] })
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${originalPath}`, ORIGINAL_PATH: originalPath, COMMAND_LOG: f.commandLog },
    encoding: "utf8",
    timeout: 15_000
  })
  assert.equal(result.status, 6, result.stderr)
  assert.match(result.stderr, /MEMBER_RED/)
  assert.equal(await readFile(join(f.root, "packages/a/result.txt"), "utf8"), "GREEN")
  const commands = await f.commands()
  assert.ok(!commands.some((args) => args[0] === "jj" && (args.includes("bookmark") || args.includes("push"))))
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
    `#!${process.execPath}\nconst {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); const r = spawnSync('tar', ['-cf', args[args.indexOf('--output') + 1], '-C', process.cwd(), 'packages']); process.exit(r.status);\n`
  )
  await chmod(join(f.bin, "git"), 0o755)
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.some(x => x.includes('::main@origin'))) process.exit(0); if (args.includes('root')) console.log(process.cwd()); else if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('log') && !args.some(x => x.includes('conflicts()'))) { if (args.at(-1) === 'commit_id') { const counter = process.env.COMMAND_LOG + '.sha'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0); fs.writeFileSync(counter, String(n + 1)); console.log((process.env.CHANGE_SHA && n > 0 ? 'b' : 'a').repeat(40)); } else console.log('change-one'); }\n`
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
    landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "abc" }] })
  ], {
    cwd: f.root,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog, CHANGE_SHA: "1" },
    encoding: "utf8",
    timeout: 15_000
  })
  assert.equal(result.status, 6, result.stderr)
  assert.match(result.stderr, /CHECKS_PASSED/)
  assert.match(result.stderr, /PRECHECK_REVISION_CHANGED/)
  const commands = await f.commands()
  assert.ok(!commands.some((args) => args[0] === "jj" && (args.includes("bookmark") || args.includes("push"))))
  assert.equal(result.stderr, (await readFile(receipt)).subarray(-4000).toString("utf8"))
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
  assert.throws(() => process.kill(ready.pid, 0), { code: "ESRCH" })
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

async function reviewFixture(t: test.TestContext) {
  const f = await fixture(t, {})
  await f.put(
    "bin/claude",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['claude', ...args, process.env.CLAUDE_CONFIG_DIR, process.env.ANTHROPIC_API_KEY ?? '', process.env.ANTHROPIC_AUTH_TOKEN ?? '', process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '']) + '\\n'); if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn: true, authMethod: 'claude.ai', email: process.env.REVIEW_EMAIL ?? 'reviewer@example.test'})); } else { if (process.env.REQUIRE_EMPTY_CWD && (process.cwd() === process.env.SOURCE_ROOT || fs.readdirSync(process.cwd()).length !== 0)) { console.error('UNSAFE_REVIEW_CWD'); process.exit(1); } if (process.env.REVIEW_QUOTA && process.env.CLAUDE_CONFIG_DIR.endsWith('claude-1')) { console.error('quota exceeded'); process.exit(1); } console.log(process.env.REVIEW_OUTPUT ?? 'VERDICT: PASS'); }\n`
  )
  await chmod(join(f.bin, "claude"), 0o755)
  return {
    ...f,
    review(extra: Record<string, string> = {}) {
      return spawnSync(process.execPath, ["--input-type=module", "-e", reviewProgram], {
        cwd: f.root,
        env: {
          ...process.env,
          PATH: `${f.bin}:${process.env.PATH}`,
          COMMAND_LOG: f.commandLog,
          CHANGED_PATHS: "diff",
          SOURCE_ROOT: f.root,
          BURNDOWN_CHECK_REVISION: "a".repeat(40),
          ANTHROPIC_API_KEY: "must-clear",
          ANTHROPIC_AUTH_TOKEN: "must-clear",
          CLAUDE_CODE_OAUTH_TOKEN: "must-clear",
          ...extra
        },
        encoding: "utf8",
        timeout: 10_000
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
    assert.ok(args.includes(join(homedir(), ".smithers/accounts/claude-1")))
    assert.deepEqual(args.slice(-3), ["", "", ""])
  }
  assert.deepEqual(commands[1]!.slice(1, -4), [
    "-p",
    "--model",
    "claude-fable-5-1",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}"
  ])
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
  assert.ok(commands[2]!.includes(join(homedir(), ".smithers/accounts/claude-5")))
  assert.ok(commands[3]!.includes(join(homedir(), ".smithers/accounts/claude-5")))
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

test("all landed issue receipt attempts run even when an earlier receipt fails", async () => {
  const { completeLandingReceipts } = await import("../land.ts")
  assert.equal(typeof completeLandingReceipts, "function")
  const attempted: Array<Array<string>> = []
  const member = {
    key: "receipts",
    repo: "smithersai/smithers",
    commits: [{ issue: 1, commit: "a" }, { issue: 2, commit: "b" }]
  }
  await assert.rejects(
    completeLandingReceipts(
      member,
      [{ issue: 1, sha: "a".repeat(40) }, { issue: 2, sha: "b".repeat(40) }],
      async (_command, args) => {
        attempted.push([...args])
        if (args.includes("smithersai/smithers#1")) throw new Error("first receipt rejected")
        return { stdout: "", stderr: "" }
      }
    ),
    /first receipt rejected/
  )
  assert.equal(attempted.length, 2)
  assert.ok(attempted[1]!.includes("smithersai/smithers#2"))
})

test("landing deadline kills a detached descendant before it can perform a late push", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  assert.equal(typeof runLandingProcess, "function")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const program = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${
    JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pushed'), 1200)`)
  }], {detached: true, stdio: 'ignore'}); setInterval(() => {}, 1000);`
  await assert.rejects(runLandingProcess(process.execPath, ["-e", program], { timeout: 500 }), /TIMEOUT|timeout/i)
  await new Promise((accept) => setTimeout(accept, 1500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("landing abort kills child processes and returns a cancellation failure", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  assert.equal(typeof runLandingProcess, "function")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const controller = new AbortController()
  const program = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${
    JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pushed'), 1200)`)
  }], {stdio: 'ignore'}); setInterval(() => {}, 1000);`
  const running = runLandingProcess(process.execPath, ["-e", program], { timeout: 10_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 500)
  await assert.rejects(running, /CANCEL|abort/i)
  await new Promise((accept) => setTimeout(accept, 1500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})

test("landing output limit safely kills the producer and refuses success", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  assert.equal(typeof runLandingProcess, "function")
  const f = await fixture(t, {})
  const pidPath = join(f.root, "producer.pid")
  const program = `require('node:fs').writeFileSync(${
    JSON.stringify(pidPath)
  }, String(process.pid)); setInterval(() => process.stdout.write('x'.repeat(1024 * 1024)), 1)`
  await assert.rejects(
    runLandingProcess(process.execPath, ["-e", program], { timeout: 10_000 }),
    /OUTPUT_LIMIT|buffer/i
  )
  const pid = Number(await readFile(pidPath, "utf8"))
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
})

async function completeLandingFixture(t: test.TestContext) {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await fakeSnapshot(f)
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); const pushed = process.env.COMMAND_LOG + '.pushed'; if (args.includes('push')) { fs.writeFileSync(pushed, '1'); process.exit(0); } if (args.includes('fetch') && process.env.POST_PUSH_FETCH_FAIL && fs.existsSync(pushed)) process.exit(1); if (args.includes('root')) console.log(process.cwd()); else if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('log') && !args.some(x => x.includes('conflicts()'))) { const rev = args[args.indexOf('-r') + 1]; if (rev.includes('::main@origin')) { if (fs.existsSync(pushed)) console.log(args.at(-1) === 'commit_id' ? 'a'.repeat(40) : 'change-one'); } else if (args.at(-1) === 'commit_id') { const counter = process.env.COMMAND_LOG + '.sha'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0); fs.writeFileSync(counter, String(n + 1)); console.log((process.env.SHA_DRIFT_AT && n >= Number(process.env.SHA_DRIFT_AT) ? 'b' : 'a').repeat(40)); } else console.log('change-one'); }\n`
  )
  await f.put(
    "bin/claude",
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['claude', ...process.argv.slice(2)]) + '\\n'); if (process.argv[2] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'reviewer@example.test'})); else console.log('VERDICT: PASS');\n`
  )
  await chmod(join(f.bin, "claude"), 0o755)
  await f.put(
    "bin/git",
    `#!${process.execPath}\nconst {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); if (args.includes('ls-remote')) { console.log('a'.repeat(40) + '\\trefs/heads/main'); process.exit(0); } const r = spawnSync('tar', ['-cf', args[args.indexOf('--output') + 1], '-C', process.cwd(), 'packages']); process.exit(r.status);\n`
  )
  const key = `test-complete-${process.pid}-${Date.now()}`
  const receiptRoot = join(homedir(), "Smithers-Ops/burndown/landings")
  await mkdir(receiptRoot, { recursive: true })
  for (const suffix of ["prechecks", "checks", "review"]) {
    t.after(() => rm(join(receiptRoot, `${key}.${suffix}.log`), { force: true }))
  }
  return {
    ...f,
    key,
    runLanding(extra: Record<string, string> = {}) {
      return spawnSync("sh", [
        "-c",
        landingScript({ key, repo: "smithersai/smithers", commits: [{ issue: 1, commit: "abc" }] })
      ], {
        cwd: f.root,
        env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMMAND_LOG: f.commandLog, ...extra },
        encoding: "utf8",
        timeout: 20_000
      })
    }
  }
}

test("successful landing checks both exact candidates, reviews, pushes once, and returns the landed SHA", async (t) => {
  const f = await completeLandingFixture(t)
  const result = f.runLanding()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^LANDED 1 a{40}$/m)
  const commands = await f.commands()
  const rebase = commands.findIndex((args) => args.includes("rebase"))
  const push = commands.findIndex((args) => args.includes("push"))
  const checks = commands.map((args, index) => args[0] === "pnpm" && args.at(-1) === "typecheck" ? index : -1).filter(
    (index) => index >= 0
  )
  const review = commands.findIndex((args) => args[0] === "claude" && args.includes("-p"))
  assert.match(result.stdout, /REVIEW_REVISION a{40}/)
  assert.ok(review > checks[1]! && review < push)
  assert.equal(checks.length, 2)
  assert.ok(checks[0]! < rebase)
  assert.ok(checks[1]! > rebase && checks[1]! < push)
  assert.equal(commands.filter((args) => args.includes("push")).length, 1)
})

test("post-push fetch failure reconciles the remote SHA without a duplicate push", async (t) => {
  const f = await completeLandingFixture(t)
  const result = f.runLanding({ POST_PUSH_FETCH_FAIL: "1" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PUSH_RECONCILED/)
  assert.match(result.stdout, /^LANDED 1 a{40}$/m)
  assert.equal((await f.commands()).filter((args) => args.includes("push")).length, 1)
})

test("rebased candidate drift after checks or review prevents bookmark and push", async (t) => {
  for (const [at, receipt] of [["3", "CHECK_REVISION_CHANGED"], ["4", "REVIEW_REVISION_CHANGED"]]) {
    const f = await completeLandingFixture(t)
    const result = f.runLanding({ SHA_DRIFT_AT: at! })
    assert.equal(result.status, 6, result.stderr)
    assert.match(result.stderr, new RegExp(receipt!))
    const commands = await f.commands()
    assert.ok(commands.some((args) => args.includes("rebase")), "the pre-rebase gate passed")
    assert.ok(!commands.some((args) => args.includes("bookmark") || args.includes("push")))
  }
})

test("replaying a reconciled landing returns its SHA without rebase, checks, or another push", async (t) => {
  const f = await completeLandingFixture(t)
  const first = f.runLanding({ POST_PUSH_FETCH_FAIL: "1" })
  assert.equal(first.status, 0, first.stderr)
  const before = (await f.commands()).length
  const retry = f.runLanding()
  assert.equal(retry.status, 0, retry.stderr)
  assert.match(retry.stdout, /^LANDED 1 a{40}$/m)
  const replay = (await f.commands()).slice(before)
  assert.ok(!replay.some((args) => args.includes("rebase") || args.includes("push") || args[0] === "pnpm"))
})

test("landing deadline kills grandchildren behind a lock wrapper that does not forward signals", async (t) => {
  const { runLandingProcess } = await import("../land.ts")
  const f = await fixture(t, {})
  const marker = join(f.root, "late-push")
  const started = join(f.root, "push-started")
  const push = `require('node:fs').writeFileSync(${
    JSON.stringify(started)
  }, 'started'); setTimeout(() => require('node:fs').writeFileSync(${
    JSON.stringify(marker)
  }, 'pushed'), 4000); setInterval(() => {}, 1000)`
  const shell = `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${
    JSON.stringify(push)
  }], {detached: true, stdio: 'ignore'}); setInterval(() => {}, 1000)`
  const wrapper =
    `const {spawn} = require('node:child_process'); process.on('SIGTERM', () => {}); spawn(process.execPath, ['-e', ${
      JSON.stringify(shell)
    }], {stdio: 'ignore'}); setInterval(() => {}, 1000)`
  await assert.rejects(runLandingProcess(process.execPath, ["-e", wrapper], { timeout: 2000 }), /TIMEOUT|timeout/i)
  assert.equal(await readFile(started, "utf8"), "started")
  await new Promise((accept) => setTimeout(accept, 4500))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})
