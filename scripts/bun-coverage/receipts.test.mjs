import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import vm from "node:vm"
import { prepare, verifyManifest } from "./manifest.mjs"
import { collect, directories, receipt, report } from "./receipts.mjs"

const source = `function pick(value?: { text?: string }): string {
  return value?.text ?? "fallback"
}
globalThis.result = [pick(), pick({ text: "ok" })]
`

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-coverage-receipts-")))
  assert.notEqual(root, realpathSync(process.cwd()))
  mkdirSync(join(root, "nested"))
  writeFileSync(join(root, "nested/source.ts"), source)
  writeFileSync(join(root, "types.d.ts"), "export interface Shape { text: string }\n")
  const prepared = prepare(root, ["nested/source.ts", "types.d.ts"])
  const context = vm.createContext({})
  vm.runInContext(prepared.codes.get(join(root, "nested/source.ts")).code, context)
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), ["fallback", "ok"])
  const run = join(root, "run")
  directories(run)
  const identity = { id: "root", runId: "regression", manifest: prepared.manifest.digest }
  receipt(run, "expected", "root", identity)
  receipt(run, "started", "root", identity)
  receipt(run, "coverage", "root", {
    ...identity,
    coverage: { ...JSON.parse(JSON.stringify(context.__coverage__)), "types.d.ts": prepared.zero["types.d.ts"] }
  })
  return { root, run, prepared, identity }
}

test("collects real TypeScript coverage from an owning root outside cwd and publishes reports", async () => {
  const { root, run, prepared, identity } = fixture()
  try {
    verifyManifest(prepared.manifest)
    receipt(run, "exits", "root", { ...identity, code: 0 })
    const result = await collect(run, prepared, identity.runId, identity.id)
    assert.deepEqual(result.coverage.files().sort(), ["nested/source.ts", "types.d.ts"])
    assert.ok(result.summary.statements.covered > 0)
    assert.ok(result.summary.functions.covered > 0)
    assert.ok(result.summary.branches.covered > 0)
    const directory = join(root, "reports")
    report(result, directory)
    const published = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"))
    assert.deepEqual(published.summary, result.summary)
    assert.deepEqual(published.exits, [{ ...identity, code: 0 }])
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(directory, "coverage-final.json"), "utf8"))).sort(), ["nested/source.ts", "types.d.ts"])
    assert.match(readFileSync(join(directory, "lcov.info"), "utf8"), /^SF:nested\/source\.ts$/m)
    assert.throws(() => receipt(run, "expected", "root", identity), { code: "EEXIST" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("refuses completion without the actual process exit", async () => {
  const { root, run, prepared, identity } = fixture()
  try {
    await assert.rejects(() => collect(run, prepared, identity.runId, identity.id), /Missing actual process exit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a sealed manifest after its real source changes", () => {
  const { root, prepared } = fixture()
  try {
    writeFileSync(join(root, "nested/source.ts"), `${source}\nconsole.log("changed")\n`)
    assert.throws(() => verifyManifest(prepared.manifest), /Coverage source, version, options or map changed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
