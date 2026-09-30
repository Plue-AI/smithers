import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { checksProgram, LandFailed, landingFailure, landingScript } from "../land.ts"

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
  for (const command of ["jj", "pnpm", "go"]) {
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
  assert.deepEqual(await f.commands(), [["pnpm", "--filter", "@test/a", "run", "typecheck"], [
    "pnpm",
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
    ["pnpm", "--filter", "@test/a", "run", "typecheck"],
    ["pnpm", "--filter", "@test/a", "run", "test"],
    ["pnpm", "--filter", "@test/nested", "run", "test"],
    ["pnpm", "--filter", "@test/z", "run", "check"],
    ["pnpm", "--filter", "@test/z", "run", "test"]
  ])
  assert.match(result.stdout, /SKIP/)
})

test("unowned paths, root workspace and PACKAGE.ts-only boundaries never run workspace checks", async (t) => {
  const f = await fixture(t, {
    "package.json": pkg("workspace"),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/native/PACKAGE.ts": "export default {}"
  })
  const result = f.run(["README.md", "scripts/tool.ts", "packages/a/native/deleted.ts"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [])
  assert.match(result.stdout, /SKIP/)
})

test("packages with no scripts explicitly skip verification", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a", {}) })
  const result = f.run(["packages/a/a.ts"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [])
  assert.match(result.stdout, /SKIP/)
})

test("plue checks nearest Go packages serially without a repository-wide command", async (t) => {
  const f = await fixture(t, {
    "internal/a/a.go": "package a",
    "internal/b/b.go": "package b",
    "go.mod": "module example.test/plue"
  })
  const result = f.run(["internal/b/deleted.go", "internal/a/a.go", "README.md"], "plue")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await f.commands(), [["go", "vet", "./internal/a/..."], ["go", "test", "./internal/a/..."], [
    "go",
    "vet",
    "./internal/b/..."
  ], ["go", "test", "./internal/b/..."]])
})

test("red check stops verification and becomes LandFailed carrying the last 4000 log bytes", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a"), "packages/z/package.json": pkg("@test/z") })
  const result = f.run(["packages/a/a.ts", "packages/z/z.ts"], "smithers", { FAIL_CHECK: "typecheck" })
  assert.notEqual(result.status, 0)
  assert.deepEqual(await f.commands(), [["pnpm", "--filter", "@test/a", "run", "typecheck"]])
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
  assert.ok(check > script.indexOf("jj rebase"))
  assert.ok(check > script.indexOf("NOT_ON_MAIN"))
  assert.ok(check < script.indexOf("bookmark set main"))
  assert.ok(check < script.indexOf("git push"))
  assert.match(script, /member-key\.checks\.log/)
  assert.match(checksProgram, /900_000|900000|15 \* 60/)
})

test("generated landing shell persists a red receipt and never bookmarks or pushes", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  const key = `test-red-${process.pid}-${Date.now()}`
  const receipt = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.checks.log`)
  await mkdir(dirname(receipt), { recursive: true })
  t.after(() => rm(receipt, { force: true }))
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('git') && args.includes('root')) console.log(process.cwd()); else if (args.includes('log') && !args.some(x => x.includes('conflicts()'))) console.log(args.at(-1) === 'commit_id' ? 'a'.repeat(40) : 'change-one');\n`
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
  assert.ok(commands.some((args) => args[0] === "jj" && args[1] === "rebase"))
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
  assert.deepEqual(await f.commands(), [["pnpm", "--filter", "@test/a", "run", "typecheck"]])
})

test("real jj member tree is checked despite a green shared working copy", async (t) => {
  const f = await fixture(t, {
    "package.json": JSON.stringify({ name: "fixture", private: true }),
    "packages/a/package.json": pkg("@test/a"),
    "packages/a/result.txt": "RED"
  })
  const originalPath = process.env.PATH!
  const jj = (args: Array<string>) => {
    const result = spawnSync("jj", args, { cwd: f.root, env: { ...process.env, PATH: originalPath }, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  jj(["git", "init", "--colocate"])
  jj(["commit", "-m", "member red check fixture"])
  const member = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  await f.put("packages/a/result.txt", "GREEN")
  const key = `test-snapshot-${process.pid}-${Date.now()}`
  const receipt = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.checks.log`)
  await mkdir(dirname(receipt), { recursive: true })
  t.after(() => rm(receipt, { force: true }))
  await f.put(
    "bin/jj",
    `#!${process.execPath}\nconst fs = require('node:fs'); const {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.includes('fetch') || args.includes('rebase')) process.exit(0); if (args.some(x => x.includes('conflicts()'))) process.exit(0); if (args.some(x => x.includes('main@origin::') || x.includes('::'))) { console.log('ancestor'); process.exit(0); } const r = spawnSync('jj', args, {env: {...process.env, PATH: process.env.ORIGINAL_PATH}, stdio: 'inherit'}); process.exit(r.status);\n`
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
    ["pnpm", "--filter", "@test/a", "run", "typecheck"]
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
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(['jj', ...args]) + '\\n'); if (args.includes('root')) console.log(process.cwd()); else if (args.includes('diff')) console.log('packages/a/a.ts'); else if (args.includes('log') && !args.some(x => x.includes('conflicts()'))) { if (args.at(-1) === 'commit_id') { const counter = process.env.COMMAND_LOG + '.sha'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0); fs.writeFileSync(counter, String(n + 1)); console.log((process.env.CHANGE_SHA && n > 0 ? 'b' : 'a').repeat(40)); } else console.log('change-one'); }\n`
  )
}

test("a changed member SHA after green verification refuses bookmark and push", async (t) => {
  const f = await fixture(t, { "packages/a/package.json": pkg("@test/a") })
  await fakeSnapshot(f)
  const key = `test-sha-${process.pid}-${Date.now()}`
  const receipt = join(homedir(), "Smithers-Ops/burndown/landings", `${key}.checks.log`)
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
  assert.match(result.stderr, /CHECK_REVISION_CHANGED/)
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
