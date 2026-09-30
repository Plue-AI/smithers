import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import ts from "typescript"
import { apiSurface, assertApiBaseline, canonicalDeclaration, withDeclarationBuild } from "./check-api-baseline.mjs"
import { copyInputDeclarations } from "../packages/repo-targets/scripts/build-library.mjs"
import { repoRoot } from "./workspace-packages.mjs"

it("detects signature changes through private declarations even when export paths stay fixed", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-api-baseline-"))
  const write = (name, text) => { mkdirSync(join(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), text) }
  try {
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n')
    write("packages/example/package.json", JSON.stringify({ name: "@smthrs/example", publishConfig: { exports: { ".": "./dist/esm/index.js" } } }))
    assert.throws(() => apiSurface(root), /ENOENT/)
    write("packages/example/dist/esm/index.d.ts", 'export type { Options } from "./internal/options.js"\n')
    write("packages/example/dist/esm/internal/options.d.ts", "export interface Options { retries?: number }\n")
    const baseline = apiSurface(root)
    assert.doesNotThrow(() => assertApiBaseline(baseline, apiSurface(root)))
    write("packages/example/dist/esm/internal/options.d.ts", "export interface Options { retries: number }\n")
    assert.throws(() => assertApiBaseline(baseline, apiSurface(root)), /@smthrs\/example/)
    assert.throws(() => assertApiBaseline(baseline, {}), /@smthrs\/example/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("emits the build-cli release declaration surface with its package compiler and copied declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-api-build-cli-"))
  const packageRoot = join(repoRoot, "packages/smithers/build/build-cli")
  const memberDir = "packages/build-cli"
  const releaseRoot = join(root, "release")
  const releaseDir = join(releaseRoot, memberDir, "dist/esm")
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n')
    mkdirSync(join(root, "packages"))
    symlinkSync(packageRoot, join(root, memberDir), "dir")

    const result = spawnSync(process.execPath, [
      join(packageRoot, "node_modules/typescript/bin/tsc"),
      "-p", join(packageRoot, "tsconfig.json"),
      "--outDir", releaseDir,
    ], { cwd: packageRoot, encoding: "utf8" })
    assert.equal(result.status, 0, `build-cli release compiler failed:\n${result.stdout}${result.stderr}`)

    copyInputDeclarations(join(packageRoot, "src"), releaseDir)

    const releaseSurface = apiSurface(root, releaseRoot)
    assert.deepEqual(Object.keys(releaseSurface), ["@smthrs/build-cli"])
    const releaseDeclarations = releaseSurface["@smthrs/build-cli"].declarations
    assert.ok(releaseDeclarations["effect-resolution.d.ts"])
    assert.ok(releaseDeclarations["internal/js-extension-siblings.d.ts"])

    await withDeclarationBuild(root, async (emittedRoot) => {
      assert.deepEqual(apiSurface(root, emittedRoot), releaseSurface)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Emits one in-memory program's declarations with the real TypeScript emitter. */
const emitDeclarations = (files) => {
  const options = {
    declaration: true, emitDeclarationOnly: true, strict: true, noLib: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext
  }
  const host = ts.createCompilerHost(options)
  const output = {}
  host.getSourceFile = (name, language) =>
    files[name] === undefined ? undefined : ts.createSourceFile(name, files[name], language)
  host.fileExists = (name) => files[name] !== undefined
  host.readFile = (name) => files[name]
  host.writeFile = (name, text) => { output[name] = text }
  ts.createProgram(Object.keys(files), options, host).emit()
  return output
}

it("keeps equivalent inferred union order from the real emitter out of the drift gate", () => {
  const api = 'export const status = (ok: boolean, n: number) => ok ? "ready" : n > 0 ? "busy" : "idle"\n'
  const alone = emitDeclarations({ "/p/api.ts": api })["/p/api.d.ts"]
  // An unrelated module earlier in the same program creates the literal
  // types first, so the emitter prints the same union in another order.
  const beside = emitDeclarations({
    "/p/other.ts": 'export const seen: "idle" | "busy" = "idle"\n',
    "/p/api.ts": api
  })["/p/api.d.ts"]
  assert.notEqual(alone, beside)
  assert.equal(alone.replace(/"\w+" \| "\w+" \| "\w+"/, "U"), beside.replace(/"\w+" \| "\w+" \| "\w+"/, "U"))
  assert.equal(canonicalDeclaration(alone), canonicalDeclaration(beside))
  const changed = emitDeclarations({
    "/p/api.ts": api.replace('"busy"', '"working"')
  })["/p/api.d.ts"]
  assert.notEqual(canonicalDeclaration(changed), canonicalDeclaration(alone))
})

it("canonicalizes inferred member order but keeps every order-sensitive or real change", () => {
  const same = (left, right) => assert.equal(canonicalDeclaration(left), canonicalDeclaration(right))
  const differ = (left, right) => assert.notEqual(canonicalDeclaration(left), canonicalDeclaration(right))
  same(
    "export declare const make: () => {\n    name: string;\n    count: number;\n    run(): void;\n};",
    "export declare const make: () => {\n    run(): void;\n    count: number;\n    name: string;\n};"
  )
  same(
    "export type Event = { readonly _tag: \"b\"; x: 1 | 2 } | { readonly _tag: \"a\" };",
    "export type Event = { readonly _tag: \"a\" } | { x: 2 | 1; readonly _tag: \"b\" };"
  )
  // Overloads, call and construct signatures are order-sensitive.
  differ(
    "export type F = { on(event: \"a\"): 1; on(event: string): 2 };",
    "export type F = { on(event: string): 2; on(event: \"a\"): 1 };"
  )
  differ(
    "export type F = { (x: \"a\"): 1; (x: string): 2 };",
    "export type F = { (x: string): 2; (x: \"a\"): 1 };"
  )
  differ(
    "export declare function f(x: \"a\"): 1;\nexport declare function f(x: string): 2;",
    "export declare function f(x: string): 2;\nexport declare function f(x: \"a\"): 1;"
  )
  // Authored interfaces and tuples keep their written order.
  differ("export interface I { a: 1; b: 2 }", "export interface I { b: 2; a: 1 }")
  differ("export type T = [string, number];", "export type T = [number, string];")
  // Real signature and export changes still differ.
  differ("export type T = { a?: number };", "export type T = { a: number };")
  differ("export type T = \"a\" | \"b\";", "export type T = \"a\" | \"c\";")
  differ("export declare const a: 1;\nexport declare const b: 2;", "export declare const a: 1;")
  differ("/** Old. */\nexport declare const a: 1;", "/** New. */\nexport declare const a: 1;")
})
