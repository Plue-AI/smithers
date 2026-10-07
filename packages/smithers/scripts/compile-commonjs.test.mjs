import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { compileCommonJs } from "./compile-commonjs.mjs"

test("CJS output preserves import.meta paths and delegates top-level-await executables to ESM", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-commonjs-"))
  try {
    const src = join(root, "src")
    const esm = join(root, "dist/esm")
    const cjs = join(root, "dist/cjs")
    mkdirSync(src, { recursive: true })
    mkdirSync(esm, { recursive: true })
    writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}\n")
    writeFileSync(
      join(src, "Library.ts"),
      "export const url = import.meta.url; export async function work() { return (await import('./support.ts')).value }\n"
    )
    writeFileSync(join(src, "support.ts"), "export const value = 42\n")
    writeFileSync(join(src, "bin.ts"), "if (true) { await Promise.resolve(); console.log(\"esm-runtime\") }\n")
    writeFileSync(join(esm, "bin.js"), "if (true) { await Promise.resolve(); console.log(\"esm-runtime\") }\n")
    await compileCommonJs(src, cjs, esm)
    const library = readFileSync(join(cjs, "Library.js"), "utf8")
    assert.match(library, /__smthrsImportMetaUrl/)
    assert.doesNotMatch(library, /void import/)
    assert.match(readFileSync(join(cjs, "bin.js"), "utf8"), /void import/)
    const imported = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(join(cjs, "Library.js"))}).work().then(console.log)`], { encoding: "utf8" })
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout.trim(), "42")
    const result = spawnSync(process.execPath, [join(cjs, "bin.js")], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "esm-runtime")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test("CJS output includes nested JSON required by the public catalog export", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-catalog-commonjs-"))
  try {
    const src = join(root, "src"), esm = join(root, "dist/esm"), cjs = join(root, "dist/cjs")
    mkdirSync(join(src, "internal"), { recursive: true })
    mkdirSync(esm, { recursive: true })
    writeFileSync(join(root, "package.json"), '{"type":"module"}')
    writeFileSync(join(src, "internal/catalog.json"), '{"operations":[{"name":"todo.stop","agent":"run"}]}')
    writeFileSync(join(src, "Catalog.ts"), `import catalog from "./internal/catalog.json" with { type: "json" }; export const descriptors = catalog.operations`)
    await compileCommonJs(src, cjs, esm)
    const loaded = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(join(cjs, "Catalog.js"))}).descriptors))`], { encoding: "utf8" })
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.deepEqual(JSON.parse(loaded.stdout), [{name:"todo.stop",agent:"run"}])
    assert.equal(readFileSync(join(cjs,"internal/catalog.json"),"utf8"),readFileSync(join(src,"internal/catalog.json"),"utf8"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
