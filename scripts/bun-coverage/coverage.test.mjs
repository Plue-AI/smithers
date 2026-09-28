import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { prepare, verifyManifest } from "./manifest.mjs"
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
    ["missing complete", (row) => rmSync(join(row.run, "coverage", `${row.id}.json`))],
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
    ["missing branch arm", (row) => mutate(row, "coverage", (value) => { value.coverage["source.ts"].b["0"].pop() })]
  ]) {
    it(`refuses ${name}`, async (t) => {
      const row = protocol(t)
      edit(row)
      await assert.rejects(collect(row.run, row.prepared, row.runId, row.id))
    })
  }
})

describe("real Bun process collection", () => {
  for (const mode of ["node-sync", "node-async", "bun-sync", "bun-async"]) {
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
