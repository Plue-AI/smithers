import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { prepare, verifyArtifacts, verifyManifest } from "./manifest.mjs"
import { digest } from "./instrument.mjs"
import { atomicJSON, collect, directories, receipt } from "./receipts.mjs"
import { runCoverage } from "./run.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const roster = ["source.ts", "entry.ts", "view.tsx", "types.d.ts"]
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "smithers-coverage space's-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(here, "fixtures"), root, { recursive: true })
  symlinkSync(join(here, "../../node_modules"), join(root, "node_modules"), "dir")
  writeFileSync(join(root, "package.json"), '{"type":"module"}')
  return root
}
function protocol(t) {
  const root = fixture(t), prepared = prepare(root, roster), run = join(root, "receipts")
  directories(run)
  const runId = randomUUID(), id = randomUUID()
  const envelope = { id, runId, manifest: prepared.manifest.digest }
  receipt(run, "expected", id, { ...envelope, parent: null })
  receipt(run, "started", id, { ...envelope, parent: null, pid: 7 })
  receipt(run, "coverage", id, { ...envelope, parent: null, phase: "exit", code: 0, coverage: structuredClone(prepared.zero) })
  receipt(run, "exits", id, { ...envelope, code: 0, signal: null })
  return { root, prepared, run, runId, id, envelope }
}
async function collectZero(prepared) {
  const run = join(prepared.manifest.root, "zero-run")
  directories(run)
  const runId = randomUUID(), id = randomUUID()
  const envelope = { id, parent: null, runId, manifest: prepared.manifest.digest }
  receipt(run, "expected", id, envelope)
  receipt(run, "started", id, envelope)
  receipt(run, "coverage", id, { ...envelope, phase: "exit", code: 0, coverage: prepared.zero })
  receipt(run, "exits", id, { ...envelope, code: 0, signal: null })
  return collect(run, prepared, runId, id)
}

function mutate(row, kind, edit) {
  const path = join(row.run, kind, `${row.id}.json`)
  const value = JSON.parse(readFileSync(path, "utf8"))
  edit(value)
  writeFileSync(path, JSON.stringify(value))
}

describe("owning coverage manifest", () => {
  it("seeds unimported entrypoints and keeps type-only files without executing either", (t) => {
    const root = fixture(t), prepared = prepare(root, roster)
    assert.deepEqual(Object.keys(prepared.zero).sort(), [...roster].sort())
    assert.equal(prepared.manifest.sources.find((source) => source.path === "types.d.ts").typeOnly, true)
    assert.deepEqual(prepared.zero["types.d.ts"].s, {})
    assert.ok(Object.keys(prepared.zero["entry.ts"].s).length > 0)
    for (const file of Object.values(prepared.zero)) {
      assert.ok(Object.values(file.s).every((count) => count === 0))
      assert.ok(Object.values(file.f).every((count) => count === 0))
      assert.ok(Object.values(file.b).flat().every((count) => count === 0))
    }
    assert.deepEqual(verifyManifest(prepared.manifest).manifest, prepared.manifest)
  })
  it("refuses duplicate, escaping, noncanonical, missing and symlink source admission", (t) => {
    const root = fixture(t)
    for (const paths of [[], ["source.ts", "source.ts"], ["../source.ts"], ["./source.ts"], ["absent.ts"]]) {
      assert.throws(() => prepare(root, paths))
    }
    symlinkSync(join(root, "source.ts"), join(root, "alias.ts"))
    assert.throws(() => prepare(root, ["alias.ts"]), /canonical source/)
  })
  it("refuses ignored production while allowing an ordinary string mentioning a directive", (t) => {
    const root = fixture(t)
    writeFileSync(join(root, "ignore.ts"), '/* istanbul ignore next */\nexport const skip = () => 1')
    assert.throws(() => prepare(root, ["ignore.ts"]), /ignore directive/)
    writeFileSync(join(root, "literal.ts"), 'export const text = "istanbul ignore next"')
    assert.doesNotThrow(() => prepare(root, ["literal.ts"]))
  })
  it("rejects source, tool, options and static map drift", (t) => {
    const root = fixture(t), prepared = prepare(root, roster)
    for (const edit of [
      (manifest) => { manifest.sources[0].sha256 = "changed" },
      (manifest) => { manifest.sources[0].mapDigest = "changed" },
      (manifest) => { manifest.pipeline.options.loose = true },
      (manifest) => { manifest.pipeline.versions["@babel/core"] = "different" }
    ]) {
      const changed = structuredClone(prepared.manifest)
      edit(changed)
      assert.throws(() => verifyManifest(changed), /changed/)
    }
    writeFileSync(join(root, "entry.ts"), 'throw new Error("changed")')
    assert.throws(() => verifyManifest(prepared.manifest), /changed/)
  })
  it("reuses sealed standard compiler artifacts with byte-identical zero maps and code", (t) => {
    const root = fixture(t), compiled = prepare(root, roster)
    const verified = verifyArtifacts(compiled.manifest, JSON.parse(JSON.stringify(compiled.artifacts)))
    assert.deepEqual(verified.zero, compiled.zero)
    assert.deepEqual([...verified.codes.entries()], [...compiled.codes.entries()].map(([path, entry]) =>
      [path, { code: entry.code, loader: entry.loader, zero: compiled.zero[entry.zero.path] }]))
    assert.equal(verified.manifest.artifactDigest, digest(compiled.artifacts))
  })
  for (const [name, edit] of [
    ["code", (artifacts) => { artifacts["source.ts"].code += "\nthrow new Error('tampered')" }],
    ["map", (artifacts) => { artifacts["source.ts"].zero.statementMap["0"].start.line = 999 }],
    ["loader", (artifacts) => { artifacts["view.tsx"].loader = "js" }],
    ["seed hit", (artifacts) => { artifacts["source.ts"].zero.s["0"] = 1 }],
    ["extra entry", (artifacts) => { artifacts["extra.ts"] = artifacts["source.ts"] }],
    ["missing entry", (artifacts) => { delete artifacts["entry.ts"] }]
  ]) {
    it(`refuses altered ${name} in sealed artifacts`, (t) => {
      const root = fixture(t), compiled = prepare(root, roster), artifacts = structuredClone(compiled.artifacts)
      edit(artifacts)
      assert.throws(() => verifyArtifacts(compiled.manifest, artifacts), /artifact/)
    })
  }
  it("checks seed/loader shape independently of the whole-artifact digest", (t) => {
    const root = fixture(t), compiled = prepare(root, roster)
    for (const edit of [
      (artifacts) => { artifacts["source.ts"].zero.f["0"] = 1 },
      (artifacts) => { artifacts["source.ts"].zero.b["0"].pop() },
      (artifacts) => { artifacts["source.ts"].loader = "jsx" }
    ]) {
      const artifacts = structuredClone(compiled.artifacts), manifest = structuredClone(compiled.manifest)
      edit(artifacts)
      manifest.artifactDigest = digest(artifacts)
      const { root: ignoredRoot, digest: ignoredDigest, ...identity } = manifest
      manifest.digest = digest(identity)
      assert.throws(() => verifyArtifacts(manifest, artifacts), /seed|loader/)
    }
    writeFileSync(join(root, "entry.ts"), 'throw new Error("changed source")')
    assert.throws(() => verifyArtifacts(compiled.manifest, compiled.artifacts), /source changed/)
  })

})

describe("coverage receipt admission", () => {
  it("publishes immutable complete JSON atomically and refuses overwrite", (t) => {
    const root = fixture(t), path = join(root, "receipt.json")
    atomicJSON(path, { value: "complete" })
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { value: "complete" })
    assert.throws(() => atomicJSON(path, { value: "replaced" }), /EEXIST/)
    assert.equal(readFileSync(path, "utf8"), '{"value":"complete"}')
  })
  it("retains the complete zero-hit roster and standard integer counts", async (t) => {
    const row = protocol(t), result = await collect(row.run, row.prepared, row.runId, row.id)
    assert.deepEqual(result.coverage.files().sort(), [...roster].sort())
    assert.equal(result.summary.statements.covered, 0)
    assert.ok(result.summary.statements.total > 0)
    assert.equal(result.coverage.fileCoverageFor("types.d.ts").toSummary().statements.total, 0)
  })
  for (const [name, edit] of [
    ["missing complete after owner load", (row) => {
      receipt(row.run, "loads", row.id, { ...row.envelope, parent: null, source: "source.ts" })
      rmSync(join(row.run, "coverage", `${row.id}.json`))
    }],
    ["missing actual exit", (row) => rmSync(join(row.run, "exits", `${row.id}.json`))],
    ["missing startup", (row) => rmSync(join(row.run, "started", `${row.id}.json`))],
    ["corrupt JSON", (row) => writeFileSync(join(row.run, "coverage", `${row.id}.json`), "{")],
    ["duplicate identity", (row) => cpSync(join(row.run, "coverage", `${row.id}.json`), join(row.run, "coverage", "duplicate.json"))],
    ["wrong run", (row) => mutate(row, "coverage", (value) => { value.runId = "other" })],
    ["wrong manifest", (row) => mutate(row, "coverage", (value) => { value.manifest = "other" })],
    ["missing source", (row) => mutate(row, "coverage", (value) => { delete value.coverage["entry.ts"] })],
    ["changed source map", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].statementMap["0"].start.line = 999 })],
    ["negative hit", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].s["0"] = -1 })],
    ["fractional hit", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].s["0"] = 0.5 })],
    ["root parent", (row) => mutate(row, "expected", (value) => { value.parent = row.id })],
    ["changed registered parent", (row) => mutate(row, "started", (value) => { value.parent = "elsewhere" })],
    ["changed completed parent", (row) => mutate(row, "coverage", (value) => { value.parent = "elsewhere" })],
    ["contradictory code and signal", (row) => mutate(row, "exits", (value) => { value.signal = "SIGKILL" })],
    ["different completed exit", (row) => mutate(row, "coverage", (value) => { value.code = 1 })],
    ["unknown completion phase", (row) => mutate(row, "coverage", (value) => { value.phase = "unknown" })],
    ["corrupt load JSON", (row) => writeFileSync(join(row.run, "loads", `${row.id}.json`), "{")],
    ["incomplete load publication", (row) => writeFileSync(join(row.run, "loads", `${row.id}.tmp`), "{")],
    ["foreign owning load", (row) => receipt(row.run, "loads", row.id, { ...row.envelope, parent: null, source: "elsewhere.ts" })],
    ["changed load parent", (row) => receipt(row.run, "loads", row.id, { ...row.envelope, parent: "other", source: "source.ts" })],
    ["unmarked positive function hit", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].f["0"] = 1 })],
    ["unmarked positive branch hit", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].b["0"][0] = 1 })],
    ["unmarked positive hit", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].s["0"] = 1 })],
    ["missing branch arm", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].b["0"].pop() })]
  ]) {
    it(`refuses ${name}`, async (t) => {
      const row = protocol(t)
      edit(row)
      await assert.rejects(collect(row.run, row.prepared, row.runId, row.id))
    })
  }
  it("rejects a registered child cycle disconnected from the root", async (t) => {
    const row = protocol(t), first = randomUUID(), second = randomUUID()
    for (const [id, parent] of [[first, second], [second, first]]) {
      const envelope = { ...row.envelope, id, parent }
      receipt(row.run, "expected", id, envelope)
      receipt(row.run, "started", id, envelope)
      receipt(row.run, "coverage", id, { ...envelope, phase: "exit", code: 0, coverage: row.prepared.zero })
      receipt(row.run, "exits", id, { ...envelope, code: 0, signal: null })
    }
    await assert.rejects(collect(row.run, row.prepared, row.runId, row.id), /Cyclic process parent chain/)
  })

})

describe("real Bun process collection", () => {
  for (const mode of ["node-sync", "node-async", "bun-sync", "bun-async", "exec-file"]) {
    it(`inherits collection through ${mode} with original output, status and env`, { timeout: 20_000 }, async (t) => {
      const root = fixture(t), run = join(root, "run")
      const result = await runCoverage({ root, sources: roster, run, args: [join(root, "parent.ts"), mode], timeout: 15_000 })
      assert.equal(result.status.code, 0)
      assert.equal(result.exits.length, 2)
      assert.equal(new Set(result.exits.map((exit) => exit.id)).size, 2)
      assert.ok(result.exits.some((exit) => exit.code === (mode === "node-sync" ? 4 : 0)))
      assert.equal(result.coverage.fileCoverageFor("entry.ts").toSummary().statements.covered, 0)
      assert.equal(result.coverage.fileCoverageFor("types.d.ts").toSummary().statements.total, 0)
      assert.ok(result.coverage.fileCoverageFor("view.tsx").toSummary().functions.covered > 0)
      const source = result.coverage.fileCoverageFor("source.ts").toJSON()
      assert.ok(Object.values(source.b).some((arms) => arms.length === 2 && arms.every((hits) => hits > 0)))
      assert.ok(existsSync(join(run, "report", "lcov.info")))
      const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"))
      assert.equal(manifest.sources.find((file) => file.path === "source.ts").sha256,
        digest(readFileSync(join(here, "fixtures/source.ts"), "utf8")))
    })
  }
  it("remaps nested sources to original lines and columns across root relocation and changed cwd", { timeout: 20_000 }, async (t) => {
    const nested = 'export function decide(flag: boolean) {\n  if (flag) {\n    return "yes"\n  }\n  return "no"\n}\n'
    const snapshots = []
    for (const flag of [true, false]) {
      const root = fixture(t)
      mkdirSync(join(root, "src/deep"), { recursive: true })
      writeFileSync(join(root, "src/deep/a.ts"), nested)
      writeFileSync(join(root, "nested.ts"), `import assert from "node:assert/strict"; import {decide} from "./src/deep/a.ts"; assert.equal(decide(${flag}), ${JSON.stringify(flag ? "yes" : "no")})`)
      const result = await runCoverage({ root, sources: ["src/deep/a.ts"], run: join(root, "nested-run"),
        cwd: tmpdir(), args: [join(root, "nested.ts")], timeout: 15_000 })
      assert.deepEqual(result.coverage.files(), ["src/deep/a.ts"])
      const file = result.coverage.fileCoverageFor("src/deep/a.ts").toJSON()
      const yes = Object.entries(file.statementMap).find(([, location]) => location.start.line === 3)
      const no = Object.entries(file.statementMap).find(([, location]) => location.start.line === 5)
      assert.deepEqual(yes[1], { start: { line: 3, column: 4 }, end: { line: 3, column: Infinity } })
      assert.deepEqual(no[1], { start: { line: 5, column: 2 }, end: { line: 5, column: Infinity } })
      assert.equal(file.s[yes[0]], flag ? 1 : 0)
      assert.equal(file.s[no[0]], flag ? 0 : 1)
      snapshots.push({ statementMap: file.statementMap, fnMap: file.fnMap, branchMap: file.branchMap })
    }
    assert.deepEqual(snapshots[0], snapshots[1])
  })

  it("lowers modern branch syntax and TS runtime helpers without hiding generated counters", { timeout: 20_000 }, async (t) => {
    const root = fixture(t)
    const result = await runCoverage({ root, sources: ["syntax.ts"], run: join(root, "syntax-run"),
      args: ["test", join(root, "syntax.test.ts")], timeout: 15_000 })
    assert.equal(result.status.code, 0)
    const file = result.coverage.fileCoverageFor("syntax.ts").toJSON()
    const arms = (line) => Object.entries(file.branchMap).filter(([, branch]) => branch.loc.start.line === line)
      .map(([id]) => file.b[id])
    // Independent literal call counts from the fixture: input is absent/present
    // once each; nullish assignment has three distinct incoming values.
    assert.deepEqual(arms(1), [[1, 1], [2, 2]])
    assert.deepEqual(arms(2), [[1, 1], [2, 1]])
    assert.deepEqual(arms(3), [[2, 1]])
    assert.deepEqual(arms(6), [[3, 2]])
    assert.deepEqual(arms(7), [[3, 1]])
    assert.deepEqual(arms(8), [[2, 1], [3, 2]])
    assert.deepEqual(arms(11), [[1]]) // Istanbul default-parameter counter is one arm.
    assert.deepEqual(arms(12), [[1, 1]])
    assert.deepEqual(arms(13), [[1, 1]])
    assert.deepEqual(arms(15), [[1, 1]])
    assert.deepEqual(arms(20), [[1, 1], [1, 1]]) // Namespace initialization also evaluates both OR operands.
    assert.equal(Object.keys(file.fnMap).length, 12)
    assert.ok(Object.values(file.f).every((hits) => hits > 0))
  })

  for (const mode of ["node", "bun"]) {
    it(`preserves ${mode} child signal handling and independently records its exit`, { timeout: 20_000 }, async (t) => {
      const root = fixture(t)
      const result = await runCoverage({ root, sources: roster, run: join(root, "signal-run"),
        args: [join(root, "signal-parent.ts"), mode], timeout: 15_000 })
      assert.equal(result.status.code, 0)
      assert.equal(result.exits.length, 2)
      assert.ok(result.exits.some((exit) => exit.code === 23 && exit.signal == null))
    })
  }
  it("refuses a timed-out command instead of publishing a success report", { timeout: 10_000 }, async (t) => {
    const root = fixture(t), run = join(root, "timeout-run")
    writeFileSync(join(root, "hold.ts"), 'import {choose} from "./source.ts"; choose(true); setInterval(()=>{},1000)')
    await assert.rejects(runCoverage({ root, sources: roster, run,
      args: [join(root, "hold.ts")], timeout: 1_000 }), /timed out/)
    assert.equal(existsSync(join(run, "report")), false)
    const exits = (await import("node:fs")).readdirSync(join(run, "exits"))
    assert.equal(exits.length, 1)
    const exit = JSON.parse(readFileSync(join(run, "exits", exits[0]), "utf8"))
    assert.equal(exit.code, null)
    assert.equal(exit.signal, "SIGKILL")
  })

  it("merges concurrent children once without multiplying the denominator", { timeout: 20_000 }, async (t) => {
    const root = fixture(t), baseline = prepare(root, roster)
    const result = await runCoverage({ root, sources: roster, run: join(root, "parallel-run"),
      args: [join(root, "parallel-parent.ts")], timeout: 15_000 })
    assert.equal(result.status.code, 0)
    assert.equal(result.exits.length, 4)
    assert.equal(new Set(result.exits.map((exit) => exit.id)).size, 4)
    const source = result.coverage.fileCoverageFor("source.ts").toJSON()
    const choose = Object.entries(source.fnMap).find(([, fn]) => fn.name === "choose")[0]
    assert.equal(source.f[choose], 3)
    const zero = await collectZero(baseline)
    for (const kind of ["statements", "branches", "functions", "lines"]) {
      assert.equal(result.summary[kind].total, zero.summary[kind].total)
    }
  })
  it("keeps mocked production unhit and collects a nested Bun test after teardown", { timeout: 20_000 }, async (t) => {
    const root = fixture(t)
    writeFileSync(join(root, "mock.test.ts"), 'import {mock,test,expect} from "bun:test"; mock.module("./source.ts",()=>({choose:()=>"boundary fake"})); test("mock boundary",async()=>{const {choose}=await import("./source.ts");expect(choose(true)).toBe("boundary fake")})')
    const mocked = await runCoverage({ root, sources: roster, run: join(root, "mock-run"),
      args: ["test", join(root, "mock.test.ts")], timeout: 15_000 })
    assert.equal(mocked.status.code, 0)
    assert.equal(mocked.coverage.fileCoverageFor("source.ts").toSummary().statements.covered, 0)
    writeFileSync(join(root, "test-parent.ts"), 'import assert from "node:assert/strict"; import {spawnSync} from "node:child_process"; import {fileURLToPath} from "node:url"; const result=spawnSync(process.execPath,["test",fileURLToPath(new URL("./parent.test.ts",import.meta.url))],{encoding:"utf8"});assert.equal(result.status,0,result.stderr)')
    const nested = await runCoverage({ root, sources: roster, run: join(root, "nested-test-run"),
      args: [join(root, "test-parent.ts")], timeout: 15_000 })
    assert.equal(nested.status.code, 0)
    assert.equal(nested.exits.length, 2)
    const source = nested.coverage.fileCoverageFor("source.ts").toJSON()
    const late = Object.entries(source.fnMap).find(([, fn]) => fn.name === "late")[0]
    assert.equal(source.f[late], 1)
  })

  it("refuses direct Bun shell launch before dispatching a child", { timeout: 20_000 }, async (t) => {
    const root = fixture(t)
    writeFileSync(join(root, "shell-parent.ts"), 'import assert from "node:assert/strict"; import childProcess from "node:child_process"; assert.throws(()=>childProcess.spawnSync(process.execPath,["--version"],{shell:true}), /requires a direct spawn boundary/);')
    const result = await runCoverage({ root, sources: roster, run: join(root, "shell-run"),
      args: [join(root, "shell-parent.ts")], timeout: 15_000 })
    assert.equal(result.status.code, 0)
    assert.equal(result.exits.length, 1)
  })
  it("kills ordinary descendants when the owned command times out", { timeout: 10_000 }, async (t) => {
    const root = fixture(t), run = join(root, "group-timeout-run")
    writeFileSync(join(root, "group-child.ts"), 'import {writeFileSync} from "node:fs";writeFileSync(new URL("./held-child-pid",import.meta.url),String(process.pid));setInterval(()=>{},1000)')
    writeFileSync(join(root, "group-parent.ts"), 'import {spawn} from "node:child_process";import {fileURLToPath} from "node:url";spawn(process.execPath,[fileURLToPath(new URL("./group-child.ts",import.meta.url))],{stdio:"inherit"});setInterval(()=>{},1000)')
    await assert.rejects(runCoverage({ root, sources: roster, run,
      args: [join(root, "group-parent.ts")], timeout: 2_000 }), /timed out/)
    const pid = Number(readFileSync(join(root, "held-child-pid"), "utf8"))
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    // SIGKILL group delivery is synchronous; OS child reaping is not. Poll only
    // this real process lifetime, with a bounded deadline and cleanup on failure.
    try {
      const deadline = Date.now() + 2_000
      while (true) {
        try { process.kill(pid, 0) }
        catch (error) { assert.equal(error.code, "ESRCH"); break }
        assert.ok(Date.now() < deadline, "Owned descendant survived timeout")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally { try { process.kill(pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error } }
    assert.equal(existsSync(join(run, "report")), false)
  })

  it("runs its CLI through a symlinked entrypoint instead of silently doing nothing", { timeout: 20_000 }, async (t) => {
    const root = fixture(t), alias = join(root, "collector.mjs"), run = join(root, "cli-run")
    symlinkSync(join(here, "run.mjs"), alias)
    writeFileSync(join(root, "roster.json"), JSON.stringify(roster))
    const { spawnSync } = await import("node:child_process")
    const result = spawnSync(process.execPath, [alias, "--root", root, "--roster", join(root, "roster.json"),
      "--run", run, "--", "test", join(root, "parent.test.ts")], { encoding: "utf8", timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1))
    assert.ok(summary.statements.covered > 0)
    assert.ok(existsSync(join(run, "report", "coverage-final.json")))
  })

  for (const owning of [false, true]) {
    it(`hard-killed child ${owning ? "with an owning load refuses incomplete hits" : "without an owning load contributes proven zero"}`, { timeout: 20_000 }, async (t) => {
      const root = fixture(t), run = join(root, "hard-kill-run")
      writeFileSync(join(root, "hard-kill-child.ts"), `${owning ? 'import {choose} from "./source.ts";if(choose(true)!=="positive")throw new Error("bad source");' : ''}console.log("ready");setInterval(()=>{},1000)`)
      const execute = () => runCoverage({ root, sources: roster, run,
        args: [join(root, "hard-kill-parent.ts")], timeout: 15_000 })
      if (owning) {
        await assert.rejects(execute(), /Missing completed owning-source coverage/)
        assert.equal(existsSync(join(run, "report")), false)
      } else {
        const result = await execute()
        assert.equal(result.status.code, 0)
        assert.equal(result.exits.length, 2)
        assert.ok(result.exits.some((exit) => exit.code === 137 && exit.signal === "SIGKILL"))
        assert.equal(result.summary.statements.covered, 0)
        assert.ok(result.summary.statements.total > 0)
        assert.equal(result.processes.filter((process) => process.measurement === "zero-no-owning-load").length, 1)
        assert.ok(result.processes.every((process) => process.owningSource === null))
      }
    })
  }

  for (const tamper of ["artifact", "source"]) {
    it(`refuses ${tamper} drift at final child flush`, { timeout: 20_000 }, async (t) => {
      const root = fixture(t), run = join(root, "drift-run")
      const edit = tamper === "artifact"
        ? 'const config=JSON.parse(readFileSync(process.env.SMITHERS_BUN_COVERAGE_CONFIG,"utf8"));const artifact=JSON.parse(readFileSync(config.artifactPath,"utf8"));artifact["source.ts"].code+=" changed";writeFileSync(config.artifactPath,JSON.stringify(artifact))'
        : 'writeFileSync(new URL("./entry.ts",import.meta.url),"throw new Error(\"changed\")")'
      writeFileSync(join(root, "drift.ts"), `import {readFileSync,writeFileSync} from "node:fs";import {choose} from "./source.ts";if(choose(true)!=="positive")throw new Error("bad source");${edit}`)
      await assert.rejects(runCoverage({ root, sources: roster, run,
        args: [join(root, "drift.ts")], timeout: 15_000 }), /artifact|source changed|integrity error/)
      assert.equal(existsSync(join(run, "report")), false)
    })
  }

  it("records a Bun test's actual failure after collecting file teardown", { timeout: 20_000 }, async (t) => {
    const root = fixture(t)
    writeFileSync(join(root, "failure.test.ts"), 'import {test,expect,afterAll} from "bun:test"; import {choose,late} from "./source.ts"; test("deliberate failure",()=>expect(choose(false)).toBe("wrong")); afterAll(()=>late())')
    const result = await runCoverage({ root, sources: roster, run: join(root, "failed-run"), args: ["test", join(root, "failure.test.ts")], timeout: 15_000 })
    assert.equal(result.status.code, 1)
    assert.equal(result.exits[0].code, 1)
    const source = result.coverage.fileCoverageFor("source.ts").toJSON()
    const late = Object.entries(source.fnMap).find(([, fn]) => fn.name === "late")[0]
    assert.equal(source.f[late], 1)
  })
})
