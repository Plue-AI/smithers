import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { apiSurface, assertApiBaseline, withDeclarationBuild } from "./check-api-baseline.mjs"
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
