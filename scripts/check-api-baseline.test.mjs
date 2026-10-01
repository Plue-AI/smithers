import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import ts from "typescript"
import { copyInputDeclarations } from "../packages/repo-targets/scripts/build-library.mjs"
import { buildPrivateEffectAdapters } from "../packages/repo-targets/scripts/private-effect-adapters.mjs"
import { apiSurface, assertApiBaseline, canonicalDeclaration, withDeclarationBuild } from "./check-api-baseline.mjs"
import { repoRoot } from "./workspace-packages.mjs"

it("detects signature changes through private declarations even when export paths stay fixed", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-api-baseline-"))
  const write = (name, text) => {
    mkdirSync(join(root, name, ".."), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  try {
    write("pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n")
    write(
      "packages/example/package.json",
      JSON.stringify({ name: "@smthrs/example", publishConfig: { exports: { ".": "./dist/esm/index.js" } } })
    )
    assert.throws(() => apiSurface(root), /ENOENT/)
    write("packages/example/dist/esm/index.d.ts", "export type { Options } from \"./internal/options.js\"\n")
    write("packages/example/dist/esm/internal/options.d.ts", "export interface Options { retries?: number }\n")
    const baseline = apiSurface(root)
    assert.doesNotThrow(() => assertApiBaseline(baseline, apiSurface(root)))
    write("packages/example/dist/esm/internal/options.d.ts", "export interface Options { retries: number }\n")
    assert.throws(() => assertApiBaseline(baseline, apiSurface(root)), /@smthrs\/example/)
    assert.throws(() => assertApiBaseline(baseline, {}), /@smthrs\/example/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("emits the build-cli release declaration surface with its package compiler and copied declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-api-build-cli-"))
  const packageRoot = join(repoRoot, "packages/smithers/build/build-cli")
  const memberDir = "packages/build-cli"
  const releaseRoot = join(root, "release")
  const releaseDir = join(releaseRoot, memberDir, "dist/esm")
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
    mkdirSync(join(root, "packages"))
    symlinkSync(packageRoot, join(root, memberDir), "dir")

    const result = spawnSync(process.execPath, [
      join(packageRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      join(packageRoot, "tsconfig.json"),
      "--outDir",
      releaseDir
    ], { cwd: packageRoot, encoding: "utf8" })
    assert.equal(result.status, 0, `build-cli release compiler failed:\n${result.stdout}${result.stderr}`)

    copyInputDeclarations(join(packageRoot, "src"), releaseDir)
    await buildPrivateEffectAdapters(packageRoot, { distRoot: join(releaseRoot, memberDir, "dist") })

    const releaseSurface = apiSurface(root, releaseRoot)
    assert.deepEqual(Object.keys(releaseSurface), ["@smthrs/build-cli"])
    const releaseDeclarations = releaseSurface["@smthrs/build-cli"].declarations
    assert.ok(releaseDeclarations["effect-resolution.d.ts"])
    assert.ok(releaseDeclarations["internal/js-extension-siblings.d.ts"])
    assert.ok(releaseDeclarations["../vendor/platform-node.d.ts"])
    assert.ok(releaseDeclarations["../vendor/node-shared/NodeFileSystem.d.ts"])

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
    declaration: true,
    emitDeclarationOnly: true,
    strict: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext
  }
  const host = ts.createCompilerHost(options)
  const output = {}
  host.getSourceFile = (name, language) =>
    files[name] === undefined ? undefined : ts.createSourceFile(name, files[name], language)
  host.fileExists = (name) => files[name] !== undefined
  host.readFile = (name) => files[name]
  host.writeFile = (name, text) => {
    output[name] = text
  }
  ts.createProgram(Object.keys(files), options, host).emit()
  return output
}

it("keeps equivalent inferred union order from the real emitter out of the drift gate", () => {
  const api = "export const status = (ok: boolean, n: number) => ok ? \"ready\" : n > 0 ? \"busy\" : \"idle\"\n"
  const alone = emitDeclarations({ "/p/api.ts": api })["/p/api.d.ts"]
  // An unrelated module earlier in the same program creates the literal
  // types first, so the emitter prints the same union in another order.
  const beside = emitDeclarations({
    "/p/other.ts": "export const seen: \"idle\" | \"busy\" = \"idle\"\n",
    "/p/api.ts": api
  })["/p/api.d.ts"]
  assert.notEqual(alone, beside)
  assert.equal(alone.replace(/"\w+" \| "\w+" \| "\w+"/, "U"), beside.replace(/"\w+" \| "\w+" \| "\w+"/, "U"))
  assert.equal(canonicalDeclaration(alone), canonicalDeclaration(beside))
  const changed = emitDeclarations({
    "/p/api.ts": api.replace("\"busy\"", "\"working\"")
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
  // A member's own leading comment moves with it; moving the comment differs.
  same(
    "export declare const make: () => {\n    /** Name. */\n    name: string;\n    /** Maximum calls. */\n    maxCalls?: number;\n};",
    "export declare const make: () => {\n    /** Maximum calls. */\n    maxCalls?: number;\n    /** Name. */\n    name: string;\n};"
  )
  differ(
    "export declare const make: () => {\n    /** Name. */\n    name: string;\n    maxCalls?: number;\n};",
    "export declare const make: () => {\n    name: string;\n    /** Name. */\n    maxCalls?: number;\n};"
  )
  // Text outside inferred unions and type literals is kept verbatim.
  const verbatim =
    "/// <reference types=\"node\" />\n/** Doc. */\nexport interface I {\n    b: 1;\n    a: 2;\n}\n// trailing\n"
  assert.equal(canonicalDeclaration(verbatim), verbatim)
  // Adjacent generic brackets are copied, never rescanned as a shift token.
  const generic = "export declare const make: (jobs: number) => Effect<<A>(body: A) => A, never>;\n"
  assert.equal(canonicalDeclaration(generic), generic)
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

it("binds freshly emitted private adapter declarations and leaves workspace output untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-api-private-adapters-"))
  const member = join(root, "packages/example")
  const current = JSON.parse(readFileSync(join(repoRoot, "packages/smithers/package.json"), "utf8"))
  let emitted
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
    mkdirSync(join(member, "src"), { recursive: true })
    mkdirSync(join(member, "dist/esm"), { recursive: true })
    writeFileSync(
      join(member, "package.json"),
      JSON.stringify({
        name: "@smthrs/private-example",
        type: "module",
        smthrs: current.smthrs,
        dependencies: {
          effect: current.dependencies.effect,
          ...Object.fromEntries(
            ["undici", "redis", "ws", "@types/ws"].map((name) => [name, current.dependencies[name]])
          )
        },
        devDependencies: current.devDependencies,
        publishConfig: {
          exports: { ".": { import: { types: "./dist/esm/index.d.ts", default: "./dist/esm/index.js" } } }
        }
      })
    )
    writeFileSync(
      join(member, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: true,
          declaration: true
        },
        include: ["src"]
      })
    )
    symlinkSync(join(repoRoot, "packages/smithers/node_modules"), join(member, "node_modules"), "dir")
    writeFileSync(
      join(member, "src/index.ts"),
      "export {layer} from \"@effect/platform-node/NodeFileSystem\";export {layer as bunLayer} from \"@effect/platform-bun/BunServices\";"
    )
    const sentinel = "export declare const workspaceWasUntouched: unique symbol;"
    writeFileSync(join(member, "dist/esm/index.d.ts"), sentinel)
    await withDeclarationBuild(root, async (output) => {
      emitted = output
      const baseline = apiSurface(root, output)
      const declarations = baseline["@smthrs/private-example"].declarations
      assert.ok(declarations["index.d.ts"])
      assert.ok(declarations["../vendor/node/NodeFileSystem.d.ts"])
      assert.ok(declarations["../vendor/bun/BunServices.d.ts"])
      assert.match(
        readFileSync(join(output, "packages/example/dist/esm/index.d.ts"), "utf8"),
        /\.\.\/vendor\/node\/NodeFileSystem\.js/
      )
      assert.equal(readFileSync(join(member, "dist/esm/index.d.ts"), "utf8"), sentinel)
      assert.equal(existsSync(join(member, "dist/vendor")), false)
      writeFileSync(
        join(output, "packages/example/dist/vendor/node/NodeFileSystem.d.ts"),
        "export declare const changedPrivateAPI: number;"
      )
      assert.throws(() => assertApiBaseline(baseline, apiSurface(root, output)), /@smthrs\/private-example/)
    })
    assert.equal(existsSync(emitted), false)
    assert.equal(readFileSync(join(member, "dist/esm/index.d.ts"), "utf8"), sentinel)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
