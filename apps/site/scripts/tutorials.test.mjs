/** Execute the files readers assemble from the docs, against workspace sources. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import ts from "typescript"

const root = resolve(import.meta.dirname, "../../..")
const pages = join(root, "apps/site/src/content/docs/docs")
const cli = join(root, "packages/smithers/src/bin.ts")
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|PASSWORD|API_KEY|^SMITHERS_|^SMTHRS_|^SMITHERS_INSIDE_RUN$/.test(key)
))
env.PATH = `${dirname(process.execPath)}:${env.PATH}`

function blocks(page) {
  const text = readFileSync(join(pages, `${page}.mdx`), "utf8")
  return [...text.matchAll(/^\s*```(?:ts|js) title="([^"]+)"[^\n]*\n([\s\S]*?)\n\s*```/gm)]
    .map(([, name, body]) => ({ name, body: body.replace(/^   /gm, "") }))
}

function project(t, page, context = []) {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-docs-"))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  symlinkSync(join(root, "examples/node_modules"), join(cwd, "node_modules"), "dir")
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n')
  const files = new Map()
  for (const source of [...context, page]) {
    for (const { name, body } of blocks(source)) files.set(name, `${files.get(name) ?? ""}${body}\n`)
  }
  for (const [name, body] of files) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), body)
  }
  return cwd
}

function command(cwd, executable, args) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined, `${executable} ${args.join(" ")}: ${result.error}`)
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
const run = (cwd, file, ...args) => command(cwd, process.execPath, [file, ...args])

test("testing-flows journal assertion fence typechecks and runs", (t) => {
  const cwd = project(t, "guides/testing-flows")
  const guide = readFileSync(join(pages, "guides/testing-flows.mdx"), "utf8")
  const section = guide.split("## 3. Assert on journal entries")[1]?.split("## 4.")[0]
  const fence = /```ts[^\n]*\n([\s\S]*?)\n```/.exec(section ?? "")?.[1]
  assert.ok(fence, "the guide includes a journal assertion example")
  const imports = fence.split("\n").filter((line) => line.startsWith("import ")).join("\n")
  const body = fence.split("\n").filter((line) => !line.startsWith("import ")).join("\n")
  // Supply the preceding durable read's entry type. Passing these rows to
  // expectJournal must not silently stand in for a conformance journal.
  const file = join(cwd, "journal-assertions.ts")
  writeFileSync(file, `
import * as TestEffect from "effect/Effect"
import type { JournalEvent } from "@smthrs/journal"
${imports}
const entries: ReadonlyArray<JournalEvent.Entry> = []
await TestEffect.runPromise(TestEffect.gen(function*() {
${body}
}).pipe(TestEffect.scoped))
console.log("journal assertions passed")
`)
  const program = ts.createProgram({
    rootNames: [file],
    options: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022
    }
  })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => cwd,
    getNewLine: () => "\n"
  }))
  assert.match(run(cwd, "journal-assertions.ts"), /journal assertions passed/)
})

test("first-flow creates its named files and reopens the durable result", (t) => {
  const cwd = project(t, "tutorials/first-flow")
  assert.match(run(cwd, "run-memory.ts"), /Hello, Ada\./)
  const first = run(cwd, "run-durable.ts")
  assert.match(first, /Hello, Ada\./)
  assert.match(first, /flows\.engine\.attempt-started/)
  assert.equal(run(cwd, "run-durable.ts"), first, "reopening returns the same result and journal")
})

test("crash-and-resume replays the sealed action across engine incarnations", (t) => {
  const cwd = project(t, "tutorials/crash-and-resume", ["tutorials/first-flow"])
  const output = run(cwd, "review.ts")
  assert.match(output, /rfc:draft body:approved/)
  assert.match(output, /readDispatches: 1/)
  assert.match(output, /stepEntries: 2/)
})

test("retry-policy executes the documented attempt ladder", (t) => {
  const cwd = project(t, "tutorials/retry-policy", ["tutorials/first-flow"])
  assert.match(run(cwd, "policy.ts"), /100, 200, 400, null/)
  const output = run(cwd, "publish.ts")
  assert.match(output, /v1:uploaded/)
  assert.match(output, /dispatches: 3/)
  assert.match(output, /attempts: \[ 1, 2, 3 \]/)
})

test("human-approval rejects the wrong type and answers the persisted next attempt", (t) => {
  const cwd = project(t, "tutorials/human-approval", ["tutorials/first-flow"])
  assert.match(run(cwd, "release.ts"), /result: true, parkedOn: \[ 1, 2 \]/)
})

test("time-travel forks in another process and rewinds to an inspectable frame", (t) => {
  const cwd = project(t, "tutorials/time-travel")
  const parent = JSON.parse(run(cwd, "parent.ts"))
  assert.equal(parent.result, "published v1.4.0 to the stable channel")
  assert.equal(parent.tagDispatches, 1)
  const fork = JSON.parse(run(cwd, "fork.ts"))
  assert.equal(fork.forkResult, "published v1.4.0 to the beta channel")
  assert.equal(fork.tagDispatches, 0)
  const rewind = JSON.parse(run(cwd, "rewind.ts"))
  assert.ok(rewind.archived > 0)
  assert.equal(rewind.attemptsAfter, rewind.attemptsAtFrame)
  assert.equal(rewind.auditStatus, "completed")
})

test("first-agent-flow executes the real read/write tools under a Jujutsu snapshot boundary", (t) => {
  const cwd = project(t, "tutorials/first-agent-flow")
  command(cwd, "jj", ["git", "init", "sandbox-work"])
  const summary = JSON.parse(run(cwd, "sandbox.ts"))
  assert.equal(summary.tally.totalLines, 3)
  assert.equal(summary.tally.bytesWritten, 2)
  assert.equal(readFileSync(join(cwd, "sandbox-work/line-count.txt"), "utf8"), "3\n")
})

test("agent-outputs runs every named entry point and reopens the recorded chain", (t) => {
  const cwd = project(t, "tutorials/agent-outputs")
  const brief = JSON.parse(run(cwd, "run-research.ts"))
  assert.equal(typeof brief.summary, "string")
  assert.deepEqual(brief.keyPoints, ["steps are journaled", "replay is deterministic"])
  const article = JSON.parse(run(cwd, "run-article.ts"))
  assert.equal(article.wordCount, 12)
  assert.match(article.article, /Durable workflows survive restarts/)
  assert.deepEqual(JSON.parse(run(cwd, "run-durable-article.ts")), article)
  assert.deepEqual(JSON.parse(run(cwd, "run-durable-article.ts")), article)
})

test("memory notebook records, reopens, and exposes the same namespace through the CLI", (t) => {
  const cwd = project(t, "tutorials/memory")
  run(cwd, cli, "init", "notes")
  const recorded = JSON.parse(run(cwd, "notebook.ts", "record"))
  const recalled = JSON.parse(run(cwd, "notebook.ts", "recall"))
  assert.equal(recorded.task, "record")
  assert.equal(recalled.task, "recall")
  assert.deepEqual([...recalled.keys].sort(), [...recorded.keys].sort())
  assert.equal(recorded.keys.length, 3)
  const listed = run(cwd, cli, "memory", "list", "--namespace", "flow:release-notes", "--json")
  for (const key of recorded.keys) assert.match(listed, new RegExp(key))
})

test("child-flows joins planned child results and reuses the completed parent", (t) => {
  const cwd = project(t, "guides/child-flows", ["tutorials/first-flow"])
  const summary = JSON.parse(run(cwd, "run-children.ts"))
  assert.equal(summary.first, "dist/app.js + app.sig")
  assert.equal(summary.second, summary.first)
  assert.deepEqual(summary.dispatches, { bundle: 1, sign: 1, report: 1 })
})

test("first-target plans, caches, invalidates, and fails through its workspace-local CLI", (t) => {
  const cwd = project(t, "tutorials/first-target")
  // Source-checkout equivalent of installing CLI and targets together. Each
  // declaration package resolves to the same physical copy as this local CLI.
  rmSync(join(cwd, "node_modules"))
  mkdirSync(join(cwd, "node_modules/@smthrs"), { recursive: true })
  const modules = join(root, "examples/node_modules")
  for (const name of readdirSync(modules).filter((name) => ![".bin", "@smthrs"].includes(name))) {
    symlinkSync(join(modules, name), join(cwd, "node_modules", name), "dir")
  }
  // The CLI and targets are always this checkout's copies, whether or not the
  // examples workspace also depends on them.
  const pinned = { cli: "packages/smithers", targets: "packages/smithers/build/targets" }
  for (const name of readdirSync(join(modules, "@smthrs")).filter((name) => !(name in pinned))) {
    symlinkSync(join(modules, "@smthrs", name), join(cwd, "node_modules/@smthrs", name), "dir")
  }
  for (const [name, path] of Object.entries(pinned)) {
    symlinkSync(join(root, path), join(cwd, "node_modules/@smthrs", name), "dir")
  }
  mkdirSync(join(cwd, "node_modules/.bin"))
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(join(cwd, "node_modules/.bin/smthrs"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 })
  command(cwd, "git", ["init"])
  run(cwd, cli, "init", "cache-demo")
  const snippets = blocks("tutorials/first-target")
  writeFileSync(join(cwd, "PACKAGE.ts"), snippets.find(({ name }) => name === "PACKAGE.ts").body)
  const messages = snippets.filter(({ name }) => name === "src/message.js")
  writeFileSync(join(cwd, "src/message.js"), messages[0].body)
  const smthrs = (...args) => command(cwd, "pnpm", ["exec", "smthrs", ...args])
  assert.match(smthrs("test", "//:greeting", "--plan"), /greeting/)
  const first = smthrs("test", "//:greeting")
  const firstKey = /"\/\/:greeting",Shell.Test,ran,[^,\n]*,(\w+)/.exec(first)?.[1]
  assert.ok(firstKey, first)
  assert.match(smthrs("test", "//:greeting"), /"\/\/:greeting",Shell.Test,hit,/)
  writeFileSync(join(cwd, "src/message.js"), messages[1].body)
  const changed = smthrs("test", "//:greeting")
  const changedKey = /"\/\/:greeting",Shell.Test,ran,[^,\n]*,(\w+)/.exec(changed)?.[1]
  assert.ok(changedKey, changed)
  assert.notEqual(changedKey, firstKey)
  assert.match(smthrs("explain", "//:greeting"), /greeting/)
  writeFileSync(join(cwd, "src/message.js"), "process.exit(1)\n")
  const failure = spawnSync("pnpm", ["exec", "smthrs", "test", "//:greeting"], { cwd, env, encoding: "utf8", timeout: 60_000 })
  assert.equal(failure.status, 1, failure.stdout + failure.stderr)
})
