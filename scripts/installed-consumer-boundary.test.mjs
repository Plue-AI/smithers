import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { assertInstalledConsumer } from "./fixtures/installed-consumer/consumer-boundary.mjs"
import { repoRoot } from "./workspace-packages.mjs"

const sourceRoot = join(repoRoot, "scripts/fixtures/installed-consumer")
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

test("copied consumer programs execute with local modules and reject workspace resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-consumer-boundary-"))
  try {
    copyFileSync(join(sourceRoot, "consumer-boundary.mjs"), join(root, "consumer-boundary.mjs"))
    write(join(root, "package.json"), JSON.stringify({ private: true, type: "module", smthrsReleaseConsumer: true,
      dependencies: { "@smthrs/example": "1.0.0" } }))
    const packageRoot = join(root, "node_modules/@smthrs/example")
    write(join(packageRoot, "package.json"), JSON.stringify({ name: "@smthrs/example", version: "1.0.0", type: "module",
      exports: { ".": "./index.mjs", "./package.json": "./package.json" } }))
    write(join(packageRoot, "index.mjs"), 'export const origin = "installed consumer"')
    write(join(root, "probe.mjs"), [
      'import { assertInstalledConsumer } from "./consumer-boundary.mjs"',
      'assertInstalledConsumer(import.meta.url)',
      'console.log((await import("@smthrs/example")).origin)'
    ].join("\n"))
    const run = () => spawnSync(process.execPath, [join(root, "probe.mjs")], { encoding: "utf8", timeout: 30_000 })
    const local = run()
    assert.equal(local.status, 0, local.stderr)
    assert.equal(local.stdout.trim(), "installed consumer")
    const outside = join(root, "workspace-copy")
    write(join(outside, "package.json"), readFileSync(join(packageRoot, "package.json")))
    write(join(outside, "index.mjs"), 'export const origin = "workspace"')
    rmSync(packageRoot, { recursive: true })
    symlinkSync(outside, packageRoot, "dir")
    const escaped = run()
    assert.equal(escaped.status, 1)
    assert.match(escaped.stderr, /resolved outside the installed consumer/)
    assert.throws(() => assertInstalledConsumer(pathToFileURL(join(sourceRoot, "dependency-adapters.mjs"))),
      /fixture must execute in a prepared installed consumer/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the boundary gate checks a standalone consumer manifest without exempting its source", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-consumer-source-contract-")))
  try {
    write(join(root, "package.json"), JSON.stringify({ name: "fixture-root", private: true, devDependencies: { typescript: "7.0.2" } }))
    write(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
    for (const file of ["check-dependency-boundaries.mjs", "workspace-packages.mjs"]) {
      let source = readFileSync(join(repoRoot, "scripts", file), "utf8")
      if (file === "check-dependency-boundaries.mjs") {
        // This synthetic repository has none of the real repository's legacy
        // reach-throughs. Retain the gate, with an empty fixture-specific list.
        const entries = /const knownReachThroughs = new Set\(\[[\s\S]*?\]\)/
        assert.match(source, entries)
        source = source.replace(entries, "const knownReachThroughs = new Set([])")
      }
      write(join(root, "scripts", file), source)
    }
    // The gate validates private Effect adapters with the build's own module.
    const adapters = "packages/repo-targets/scripts/private-effect-adapters.mjs"
    write(join(root, adapters), readFileSync(join(repoRoot, adapters), "utf8"))
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir")
    write(join(root, "scripts/consumer/package.json"), JSON.stringify({ name: "consumer-fixture", private: true,
      dependencies: { "@smthrs/example": "*" } }))
    write(join(root, "scripts/consumer/probe.mjs"), 'import "@smthrs/example"')
    const run = () => spawnSync(process.execPath, [join(root, "scripts/check-dependency-boundaries.mjs")],
      { encoding: "utf8", timeout: 30_000 })
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr)
    write(join(root, "scripts/consumer/probe.mjs"), 'import "@smthrs/undeclared"')
    const undeclared = run()
    assert.equal(undeclared.status, 1)
    assert.match(undeclared.stderr, /consumer\/probe\.mjs imports @smthrs\/undeclared/)
    write(join(root, "scripts/consumer/probe.mjs"), 'import "@smthrs/example"')
    write(join(root, "scripts/ordinary.mjs"), 'import "@smthrs/example"')
    const ordinary = run()
    assert.equal(ordinary.status, 1)
    assert.match(ordinary.stderr, /ordinary\.mjs imports @smthrs\/example/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
