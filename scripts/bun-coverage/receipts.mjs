import assert from "node:assert/strict"
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"
import coverageLibrary from "istanbul-lib-coverage"
import sourceMapLibrary from "istanbul-lib-source-maps"
import reportLibrary from "istanbul-lib-report"
import reports from "istanbul-reports"
import { mapDigest } from "./instrument.mjs"

export function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 })
    // A same-directory hard link publishes a complete immutable receipt without
    // rename's overwrite race. Both the temporary and final file are private.
    linkSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
export function directories(run) {
  for (const kind of ["expected", "started", "coverage", "exits", "errors"]) mkdirSync(join(run, kind), { recursive: true, mode: 0o700 })
}
export function receipt(run, kind, id, value) {
  assert.match(id, /^[a-zA-Z0-9-]+$/, "Invalid process receipt identity")
  atomicJSON(join(run, kind, `${id}.json`), value)
}
function read(run, kind) {
  return readdirSync(join(run, kind)).map((file) => {
    assert.match(file, /^[a-zA-Z0-9-]+\.json$/, "Incomplete or unexpected coverage artifact")
    const value = JSON.parse(readFileSync(join(run, kind, file), "utf8"))
    assert.equal(`${value.id}.json`, file, "Receipt identity does not match its filename")
    return value
  })
}
function validCounts(counts, expected) {
  assert.deepEqual(Object.keys(counts).sort(), Object.keys(expected).sort(), "Missing or extra coverage counters")
  for (const key of Object.keys(expected)) {
    const values = Array.isArray(expected[key]) ? counts[key] : [counts[key]]
    if (Array.isArray(expected[key])) assert.ok(Array.isArray(values) && values.length === expected[key].length, "Branch counter shape changed")
    for (const value of values) assert.ok(Number.isSafeInteger(value) && value >= 0, "Invalid coverage hit count")
  }
}
export async function collect(run, prepared, runId, rootId) {
  assert.equal(read(run, "errors").length, 0, "Coverage collector reported an integrity error")
  const expected = read(run, "expected")
  const started = read(run, "started")
  const complete = read(run, "coverage")
  const exits = read(run, "exits")
  const index = (rows) => {
    const result = new Map()
    for (const row of rows) {
      assert.equal(row.runId, runId, "Coverage run identity changed")
      assert.equal(row.manifest, prepared.manifest.digest, "Coverage manifest changed")
      assert.ok(!result.has(row.id), "Duplicate process receipt")
      result.set(row.id, row)
    }
    return result
  }
  const expectedMap = index(expected), startMap = index(started), completeMap = index(complete), exitMap = index(exits)
  assert.ok(expectedMap.has(rootId), "Missing root process registration")
  assert.equal(expectedMap.get(rootId).parent, null, "Root process cannot have a parent")
  for (const id of expectedMap.keys()) assert.ok(startMap.has(id), `Missing child startup receipt: ${id}`)
  assert.equal(startMap.size, completeMap.size, "Missing or extra completed process coverage")
  for (const row of started) {
    assert.equal(row.parent, expectedMap.get(row.id)?.parent, "Process parent differs from registration")
    const ancestors = new Set([row.id])
    let ancestor = row
    while (ancestor.id !== rootId) {
      assert.ok(startMap.has(ancestor.parent), "Unrelated process coverage")
      assert.ok(!ancestors.has(ancestor.parent), "Cyclic process parent chain")
      ancestors.add(ancestor.parent)
      ancestor = startMap.get(ancestor.parent)
    }
    assert.ok(expectedMap.has(row.id), "Unregistered Bun process; use a qualified spawn boundary")
    assert.ok(completeMap.has(row.id), `Missing child coverage: ${row.id}`)
    assert.ok(exitMap.has(row.id), `Missing actual process exit: ${row.id}`)
  }
  assert.equal(exitMap.size, startMap.size, "Missing or extra process exit receipts")
  const merged = coverageLibrary.createCoverageMap(structuredClone(prepared.zero))
  for (const row of complete) {
    const exit = exitMap.get(row.id)
    assert.ok(exit && ((Number.isSafeInteger(exit.code) && exit.code >= 0 && exit.signal == null)
      || (exit.code === null && typeof exit.signal === "string" && exit.signal.length > 0)), "Invalid actual exit status")
    assert.equal(row.parent, startMap.get(row.id).parent, "Completed process parent changed")
    assert.ok(row.phase === "exit" || row.phase === "globalAfterAll", "Invalid collection phase")
    if (row.phase === "exit") assert.equal(row.code, exit.code, "Collected exit status differs from actual exit")
    assert.deepEqual(Object.keys(row.coverage).sort(), Object.keys(prepared.zero).sort(), "Owning source roster changed")
    for (const [path, file] of Object.entries(row.coverage)) {
      assert.equal(mapDigest(file), prepared.manifest.sources.find((source) => source.path === path).mapDigest, "Coverage source map changed")
      for (const kind of ["s", "f", "b"]) validCounts(file[kind], prepared.zero[path][kind])
    }
    merged.merge(row.coverage)
  }
  // Istanbul resolves sources relative to the instrumented filename and emits
  // absolute paths. Anchor those filenames to the sealed owner, never cwd.
  const absolute = coverageLibrary.createCoverageMap({})
  for (const path of merged.files()) {
    absolute.addFileCoverage({ ...merged.fileCoverageFor(path).toJSON(), path: resolve(prepared.manifest.root, path) })
  }
  const transformed = await sourceMapLibrary.createSourceMapStore().transformCoverage(absolute)
  const remapped = coverageLibrary.createCoverageMap({})
  for (const path of transformed.files()) {
    const owned = relative(prepared.manifest.root, path).split(sep).join("/")
    assert.ok(Object.hasOwn(prepared.zero, owned), `Remapping escaped owning sources: ${path}`)
    remapped.addFileCoverage({ ...transformed.fileCoverageFor(path).toJSON(), path: owned })
  }
  // Type-only files have no executable mappings, but remain in the owning roster.
  for (const path of Object.keys(prepared.zero)) if (!remapped.files().includes(path)) {
    assert.equal(Object.keys(prepared.zero[path].s).length, 0, `Lost executable source map: ${path}`)
    remapped.addFileCoverage({ path, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} })
  }
  assert.deepEqual(remapped.files().sort(), Object.keys(prepared.zero).sort(), "Remapping escaped owning sources")
  return { coverage: remapped, summary: remapped.getCoverageSummary().toJSON(), exits }
}
export function report(result, directory) {
  mkdirSync(directory)
  const context = reportLibrary.createContext({ dir: directory, coverageMap: result.coverage })
  for (const name of ["json", "lcovonly", "json-summary"]) reports.create(name).execute(context)
  atomicJSON(join(directory, "receipt.json"), { summary: result.summary, exits: result.exits })
}
