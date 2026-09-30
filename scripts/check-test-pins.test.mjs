import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"

import { findPins, guardedGroups, guardedPackages, notesPath, suppliedEnv, undocumentedPins } from "./check-test-pins.mjs"
import { repoRoot } from "./workspace-packages.mjs"

test("finds every outright pin form, whatever the runner prefix", () => {
  const source = [
    `it.fails("a", () => {})`,
    `test.skip("b", () => {})`,
    `it.effect.skip("c", () => {})`,
    `it.live.todo("d")`,
    `describe.skip("e", () => {})`
  ].join("\n")

  assert.deepEqual(findPins(source).map((pin) => [pin.form, pin.title, pin.line]), [
    ["fails", "a", 1],
    ["skip", "b", 2],
    ["skip", "c", 3],
    ["todo", "d", 4],
    ["skip", "e", 5]
  ])
})

test("a capability gate is not a pin", () => {
  const source = [
    `describe.skipIf(process.platform === "win32")("windows", () => {})`,
    `describe.skipIf(!jjInstalled)("needs jj", () => {})`,
    `describe.skipIf(wasmBytes === undefined)("needs wasm", () => {})`,
    `describe.runIf(Boolean(process.env.CI))("ci only", () => {})`,
    `describe.runIf(Boolean(process.env["CI"]))("ci only, bracketed", () => {})`
  ].join("\n")

  assert.deepEqual(findPins(source), [])

  // A same-file const that reads no environment variable stays a capability
  // gate even when the condition compares it: the binding decides, not the
  // fact that the condition holds an identifier.
  const bound = [
    `const wasmBytes = existsSync(artifact) ? readFileSync(artifact) : undefined`,
    `describe.skipIf(wasmBytes === undefined)("needs wasm", () => {})`
  ].join("\n")
  assert.deepEqual(findPins(bound), [])
})

test("an environment-variable gate is a pin, inline or through a const", () => {
  const inline = `it.live.runIf(process.env.FLOWS_SLOW_TESTS === "1")("slow one", () => {})`
  assert.deepEqual(findPins(inline).map((pin) => pin.title), ["slow one"])

  const nested = `it.runIf(Boolean(process.env.FLOWS_SLOW_TESTS))("slow nested", () => {})`
  assert.deepEqual(findPins(nested).map((pin) => pin.title), ["slow nested"])

  const aliased = [
    `const slowTests = process.env.FLOWS_SLOW_TESTS === "1"`,
    `it.live.runIf(slowTests)("slow two", () => {})`,
    `it.effect.skipIf(!slowTests)("slow three", () => {})`
  ].join("\n")
  assert.deepEqual(findPins(aliased).map((pin) => pin.title), ["slow two", "slow three"])

  // An alias gates the suite wherever it appears, not only as the whole
  // condition: `skipIf(seat === undefined)` is the shape the live suites use.
  const compared = [
    `const seat = process.env.SMITHERS_MIGRATE_SEAT`,
    `describe.skipIf(seat === undefined)("live seat", () => {})`
  ].join("\n")
  assert.deepEqual(findPins(compared).map((pin) => pin.title), ["live seat"])

  // The bracket spelling reads the same variable, and it is the one the
  // integrations live suites and the build-cli codex smoke use.
  const bracketed = `describe.skipIf(process.env["GITHUB_TOKEN"] === undefined)("live", () => {})`
  assert.deepEqual(findPins(bracketed).map((pin) => pin.title), ["live"])

  const bracketedAlias = [
    `const token = process.env['GITHUB_TOKEN']`,
    `describe.skipIf(token === undefined)("live aliased", () => {})`
  ].join("\n")
  assert.deepEqual(findPins(bracketedAlias).map((pin) => pin.title), ["live aliased"])
})

test("a variable the package's own test program sets is not a pin", () => {
  const gated = `describe.skipIf(!process.env.SMITHERS_TEST_PG_URL)("real database", () => {})`
  assert.deepEqual(findPins(gated, new Set(["SMITHERS_TEST_PG_URL"])), [])
  assert.deepEqual(findPins(gated, new Set(["OTHER"])).map((pin) => pin.title), ["real database"])

  const fixtureRoot = mkdtempSync(join(repoRoot, "scripts", ".check-test-pins-"))
  try {
    const program = join(fixtureRoot, "matrix.mjs")
    writeFileSync(
      program,
      [
        `const { DROPPED: ignored, ...environment } = process.env`,
        `run({ ...environment, ...(lane ? { SUPPLIED_URL: url } : {}) })`
      ].join("\n")
    )
    writeFileSync(
      join(fixtureRoot, "PACKAGE.ts"),
      `const x = Build({ testProgram: Smithers.file("//${relative(repoRoot, program)}") })\n`
    )
    assert.deepEqual([...suppliedEnv(fixtureRoot)], ["SUPPLIED_URL"])
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
  const smithers = suppliedEnv(join(repoRoot, "packages", "smithers"))
  assert.ok(smithers.has("SMITHERS_HISTORY_TEST_PG_URL"), "the smithers test target's env supplies the history URL")
  assert.ok(!smithers.has("POSTGRES_PASSWORD"), "a service container's env supplies nothing to a test")
  assert.ok(suppliedEnv(join(repoRoot, "packages", "smithers", "flows", "database")).has("SMITHERS_TEST_PG_URL"))
})

test("a variable the package's own test target sets in its env is not a pin", () => {
  const fixtureRoot = mkdtempSync(join(repoRoot, "scripts", ".check-test-pins-"))
  const declare = (source) => {
    writeFileSync(join(fixtureRoot, "PACKAGE.ts"), source)
    return [...suppliedEnv(fixtureRoot)]
  }
  try {
    const service = [
      `const database = Smithers.Docker.Service({`,
      `  image: "postgres",`,
      `  // the container's own settings, never the test's`,
      `  env: { POSTGRES_PASSWORD: "secret", POSTGRES_DB: "db" },`,
      `  readiness: { exec: ["pg_isready", "-d", "db"] }`,
      `})`
    ].join("\n")
    const target = [
      `const test = Smithers.Shell.Test({`,
      `  shell: "vitest run",`,
      `  // it's the URL the suite reads; a quote in a comment pairs nothing`,
      `  env: {`,
      `    SUPPLIED_URL:`,
      `      "postgres://postgres:secret@127.0.0.1:5432/db",`,
      `    "QUOTED_NAME": "HOST: not a key",`,
      `    lowercase: "ignored"`,
      `  },`,
      `  services: [database]`,
      `})`
    ].join("\n")
    assert.deepEqual(declare(`${service}\n${target}\n`), ["SUPPLIED_URL", "QUOTED_NAME"])

    const gated = `describe.skipIf(!process.env.SUPPLIED_URL)("real database", () => {})`
    assert.deepEqual(findPins(gated, suppliedEnv(fixtureRoot)), [])
    const serviceOnly = `describe.skipIf(!process.env.POSTGRES_PASSWORD)("service secret", () => {})`
    assert.deepEqual(findPins(serviceOnly, suppliedEnv(fixtureRoot)).map((pin) => pin.title), ["service secret"])

    // An unpaired service call hides every later env, so an unreadable
    // declaration supplies less, never more.
    assert.deepEqual(declare(`const database = Smithers.Docker.Service({ image: "postgres"\n${target}\n`), [])
    // An unpaired env object supplies nothing.
    assert.deepEqual(declare(`const test = Smithers.Shell.Test({ env: { OPEN_URL: "x"\n`), [])
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

/**
 * Builds a throwaway package holding one pinned test, and names it the way the
 * register does.
 *
 * Re-pinned 2026-09-01: the two cases below used to read the live register and
 * the live `packages/smithers/flows/database` pin. `ef7ee4d0c0` unpinned that test once the
 * open path's read-only probe brought it inside the package's per-test budget,
 * so the register row they quoted stopped naming a pin and both cases went
 * vacuous: the wrong-package variant found nothing to report and asserted
 * nothing. The rule under test is unchanged. Only the pin it reads moved, from
 * whatever the tree happens to pin today to a fixture this file owns, which is
 * why `findPins` and `undocumentedPins` are exported at all.
 */
const withPinnedPackage = (title, run) => {
  const fixtureRoot = mkdtempSync(join(repoRoot, "scripts", ".check-test-pins-"))
  const packageDirectory = join(fixtureRoot, "ledger")
  const testFile = join(packageDirectory, "test", "Ledger.test.mjs")
  try {
    mkdirSync(dirname(testFile), { recursive: true })
    writeFileSync(testFile, `it.skip(${JSON.stringify(title)}, () => {})\n`)
    // The register names a package by its path under `packages/`, which is the
    // half of the pair `undocumentedPins` builds from the directory it walks.
    run({ packageDirectory, packageName: relative(join(repoRoot, "packages"), packageDirectory), testFile })
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

test("a pin counts as documented only when Surviving pins pairs its package and title", () => {
  const title = "refuses a ledger row the journal never wrote"
  withPinnedPackage(title, ({ packageDirectory, packageName, testFile }) => {
    const packages = [packageDirectory]
    const row = (name, pinned) => `| \`${name}\` | \`${pinned}\` | \`it.skip\` |`
    const notes = [
      "# Alpha notes",
      "",
      "### Surviving pins",
      "",
      "| Package | Test | Form |",
      "| --- | --- | --- |",
      row(packageName, title)
    ].join("\n")
    assert.deepEqual(undocumentedPins(notes, packages), [])

    const wrongPackage = notes.replace(row(packageName, title), row("other", title))
    assert.equal(undocumentedPins(wrongPackage, packages).length, 1)

    const wrongTitle = notes.replace(row(packageName, title), row(packageName, `${title} once`))
    assert.equal(undocumentedPins(wrongTitle, packages).length, 1)

    const unexplained = undocumentedPins("# Alpha notes\n\nNothing here.\n", packages)
    assert.equal(unexplained.length, 1)
    assert.equal(unexplained[0].title, title)
    assert.equal(unexplained[0].file, relative(repoRoot, testFile))
  })
})

test("reads Surviving pins through ordinary z text and through end of input", () => {
  const title = "waits for a lock the peer never releases"
  withPinnedPackage(title, ({ packageDirectory, packageName }) => {
    const notes = [
      "# Alpha notes",
      "",
      "### Surviving pins",
      "",
      "A z before this row must not end the section.",
      `| \`${packageName}\` | \`${title}\` | rationale |`
    ].join("\n")

    assert.deepEqual(undocumentedPins(notes, [packageDirectory]), [])
  })
})

test("a resolved title does not authorize re-pinning a test", () => {
  const fixtureRoot = mkdtempSync(join(repoRoot, "scripts", ".check-test-pins-"))
  const packageDirectory = join(fixtureRoot, "capability")
  const title = "bounds wall time for adversarial repeated-star patterns against long non-matching resources"
  try {
    mkdirSync(join(packageDirectory, "test"), { recursive: true })
    writeFileSync(join(packageDirectory, "test", "Capability.test.mjs"), `it.fails(${JSON.stringify(title)}, () => {})\n`)

    const unexplained = undocumentedPins(readFileSync(notesPath, "utf8"), [packageDirectory])
    assert.equal(unexplained.length, 1)
    assert.equal(unexplained[0].title, title)
    assert.equal(unexplained[0].file, relative(repoRoot, join(packageDirectory, "test", "Capability.test.mjs")))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test("every package group is guarded, read from the manifests", () => {
  // The 1.0 release train packs engine and agent together, so an undocumented
  // pin in an agent package would ship inside a published tarball. Tooling
  // stays guarded because its packages gate the build.
  assert.deepEqual([...guardedGroups].sort(), ["agent", "engine", "tooling"])

  const guarded = new Set(guardedPackages().map((directory) => directory.split("/").pop()))
  assert.ok(guarded.has("database"), "database is an engine package")
  assert.ok(guarded.has("build-cli"), "build-cli is a tooling package")
  assert.ok(guarded.has("harness"), "harness is an agent package and now in scope")
})

test("the register exists and every pin in the tree appears in it", () => {
  assert.ok(existsSync(notesPath), "scripts/test-pins.md is the register the guard reads")
  assert.match(readFileSync(notesPath, "utf8"), /## Known test pins/)
  assert.deepEqual(undocumentedPins(), [])
})

/**
 * Every local link in the register resolves to a file in this checkout, and a
 * link carrying a fragment resolves to a heading in that file.
 *
 * The register moved its supporting links to `pages/` before that tree was
 * deleted, so every one of them pointed at a missing file while still reading
 * as the authority on the release posture. A link inventory is the only thing
 * that notices, because prose cannot go stale loudly.
 */
test("every local link in the register resolves", () => {
  const notes = readFileSync(notesPath, "utf8")
  const slug = (heading) =>
    heading.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-")
  const dead = []
  for (const link of notes.matchAll(/\]\(([^)]+)\)/g)) {
    const [target, fragment] = link[1].split("#")
    if (target === "" || /^https?:/.test(target)) continue
    const path = resolve(dirname(notesPath), target)
    if (!existsSync(path)) {
      dead.push(`${link[1]}: no such file`)
      continue
    }
    if (fragment === undefined) continue
    const headings = readFileSync(path, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)
    if (![...headings].some((heading) => slug(heading[1]) === fragment)) {
      dead.push(`${link[1]}: no such heading`)
    }
  }
  assert.deepEqual(dead, [])
})
