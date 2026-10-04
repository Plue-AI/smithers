/**
 * Every suite in this workspace is reachable from a command CI runs.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/test-script-wiring-gate`
 * suite. The defect it guards is the quiet one: a package with a `test/`
 * directory and no `scripts.test` never runs, and every config-level assertion
 * about it stays green while it does. The 0.x version drove a standalone
 * `check-smithers-test-script.mjs` against synthetic fixtures; the script is
 * gone, so what survives is the claim itself, checked against the real tree.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { parseWorkflow } from "../release-rehearsal.mjs"
import { repoRoot as root } from "../workspace-packages.mjs"

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"))

const rootManifest = readManifest(join(root, "package.json"))

/** Every workspace member the root manifest's globs name. */
const members = rootManifest.workspaces.flatMap((glob) => {
  if (!glob.endsWith("/*")) return existsSync(join(root, glob, "package.json")) ? [glob] : []
  const parent = glob.slice(0, -2)
  if (!existsSync(join(root, parent))) return []
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
    .map((entry) => `${parent}/${entry.name}`)
})

const hasTests = (directory) => {
  const candidates = ["test", "tests", "src/test"]
  return candidates.some((name) => {
    const path = join(root, directory, name)
    return existsSync(path) && statSync(path).isDirectory()
  })
}

describe("test-script wiring", () => {
  it("finds the workspace members the root manifest declares", () => {
    assert.ok(members.length > 20, `expected a populated workspace, found ${members.length}`)
  })

  it("gives every member with a test directory a test script", () => {
    for (const directory of members) {
      if (!hasTests(directory)) continue
      const manifest = readManifest(join(root, directory, "package.json"))
      assert.ok(
        manifest.scripts?.test,
        `${directory} has tests and no scripts.test, so nothing in CI runs them`
      )
    }
  })

  it("keeps the root aggregators fanning out recursively", () => {
    assert.equal(rootManifest.scripts.test, "pnpm --recursive --if-present run test")
    assert.equal(rootManifest.scripts.check, "pnpm --recursive --if-present run check")
    assert.equal(rootManifest.scripts.lint, "pnpm --recursive --if-present run lint")
  })

  it("keeps the pnpm workspace globs and the root manifest globs identical", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    const block = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    assert.ok(block, "pnpm-workspace.yaml must declare a packages block")
    const globs = block
      .split("\n")
      .slice(1)
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4).replaceAll("\"", ""))
    assert.deepEqual(
      globs,
      rootManifest.workspaces,
      "pnpm installs what pnpm-workspace.yaml names and the recursive scripts fan out over the same set; "
        + "a member in one and not the other is installed but never tested, or tested and never installed"
    )
  })
})

/** Every `*.test.*` file under `directory`, repository-relative. */
const testFiles = (directory, extension) =>
  readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(`.test${extension}`) && !entry.parentPath.includes("node_modules"))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort()

/**
 * Test files deliberately outside every target, with the reason. A suite that
 * no target names never runs, so the default is an owner, not an entry here.
 */
const unownedTests = new Map([])

describe("test-file ownership", () => {
  const declarations = ["PACKAGE.ts", "scripts/PACKAGE.ts", "scripts/repo-contract/PACKAGE.ts"]
    .map((path) => readFileSync(join(root, path), "utf8"))
    .join("\n")
  const suites = [...testFiles("scripts", ".mjs"), ...testFiles("factory", ".ts")]

  it("finds the script and factory suites", () => {
    assert.ok(suites.includes("scripts/pack-release.test.mjs"))
    assert.ok(suites.includes("factory/flows/harness.test.ts"))
  })

  it("names every script and factory suite in a target's test runner", () => {
    const orphans = suites.filter((path) => !unownedTests.has(path) && !declarations.includes(`Smithers.file("//${path}")`))
    assert.deepEqual(orphans, [], "each suite needs a Smithers.testRunner entry or a reasoned unownedTests entry")
  })

  it("keeps the exclusion list free of owned or deleted suites", () => {
    for (const path of unownedTests.keys()) assert.ok(suites.includes(path) && !declarations.includes(`//${path}"`), path)
  })

  it("selects script and factory targets in their required jobs", () => {
    const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))
    assert.notEqual(workflow.jobs.test["continue-on-error"], true)
    const main = workflow.jobs.test.steps.flatMap((step) => step.run ? [step.run] : []).join("\n")
    assert.notEqual(workflow.jobs.scripts["continue-on-error"], true)
    const scripts = workflow.jobs.scripts.steps.flatMap((step) => step.run ? [step.run] : []).join("\n")
    assert.match(scripts, /smthrs test '\/\/scripts\/\.\.\.'/)
    assert.notEqual(workflow.jobs.repository["continue-on-error"], true)
    const repository = workflow.jobs.repository.steps.flatMap((step) => step.run ? [step.run] : []).join("\n")
    assert.doesNotMatch(main, /smthrs test '\/\/:factoryHarness'/)
    assert.match(repository, /smthrs test '\/\/:factoryHarness'/)
  })
})

describe("backend consumer gate", () => {
  const declaration = readFileSync(join(root, "PACKAGE.ts"), "utf8")
  const start = declaration.indexOf("const backendGo = Smithers.Shell.Test({")
  const target = declaration.slice(start, declaration.indexOf("\n})", start))
  const shell = JSON.parse(target.match(/^\s*shell: ("(?:[^"\\]|\\.)*"),$/m)?.[1] ?? "null")

  it("compiles the public backend API from an outside module on every backend run", () => {
    assert.ok(start >= 0, "PACKAGE.ts must declare backendGo")
    assert.equal(typeof shell, "string", "backendGo must run a shell command")
    const commands = shell.split(/;\s*/)
    const gate = commands.indexOf("sh scripts/test-backend-consumer.sh || exit $?")
    assert.ok(gate >= 0, "backendGo must run the consumer script and stop on its failure")
    assert.ok(gate < commands.findIndex((command) => command.startsWith("go test -count=1 ")), "the gate runs before the Go suites")
    assert.ok(target.includes('Smithers.file("//scripts/test-backend-consumer.sh")'), "the script is a declared input")
    assert.match(declaration, /pattern: "\/\/:backendGo"/, "a CI job selects backendGo")
  })

  it("compiles product tests before gates that can hide their compiler errors", () => {
    const compile = shell.indexOf("go test -run '^$' ./packages/backend/db/product || exit $?")
    assert.ok(compile >= 0, "product tests must compile even before the consumer gate")
    assert.ok(compile < shell.indexOf("python3 -B -m unittest"))
    assert.match(shell, /go vet \.\/packages\/backend\/\.\.\./)
    assert.match(shell, /go test -count=1 \.\/packages\/backend\/\.\.\./)
  })

  it("keeps the consumer script failing on a compile error", () => {
    const script = readFileSync(join(root, "scripts/test-backend-consumer.sh"), "utf8")
    assert.match(script, /^set -eu$/m)
    assert.match(script, /^GOWORK=off go build \.\/\.\.\.$/m)
  })
})
