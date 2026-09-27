/**
 * Checks the published support reference against release manifests and links.
 *
 * @since 1.0.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { readWorkspaceManifests } from "../../../scripts/pack-release.mjs"
import { parseWorkflow } from "../../../scripts/release-rehearsal.mjs"

const root = resolve(import.meta.dirname, "../../..")
const read = (path) => readFileSync(resolve(root, path), "utf8")
const route = "/docs/reference/support-matrix/"

test("the support reference states every released Node engine range and current CI pins", () => {
  const page = read("apps/site/src/content/docs/docs/reference/support-matrix.mdx")
  const manifests = readWorkspaceManifests(root)
  const inventory = page.slice(page.indexOf("## Published Node engine ranges"))
  const rows = new Map([...inventory.matchAll(/^\| `([^`]+)`\s+\| `([^`]+)`\s+\| (.+) \|$/gm)]
    .map(([, name, engine, source]) => [name, { engine: engine.replaceAll("\\|", "|"), source }]))
  assert.equal(rows.size, manifests.size, "the published table has exactly one row per release package")
  for (const [directory, manifest] of manifests) {
    const row = rows.get(manifest.name)
    assert.ok(row, `${manifest.name}: manifest row`)
    assert.equal(row.engine, manifest.engines.node, `${manifest.name}: exact engines.node`)
    assert.ok(row.source.includes(`${directory}/package.json`), `${manifest.name}: manifest citation`)
  }
  const ci = read(".github/workflows/ci.yml")
  const steps = Object.values(parseWorkflow(ci).jobs).flatMap((job) => job.steps ?? [])
  for (const step of steps) {
    const inputs = step.with ?? {}
    const versionFile = inputs["node-version-file"]
    const pins = [
      inputs["node-version"],
      inputs["bun-version"],
      typeof versionFile === "string" ? read(versionFile).trim() : undefined
    ]
    for (const pin of pins) {
      if (pin !== undefined) assert.ok(page.includes(`\`${pin}\``), `CI pin ${pin}`)
    }
  }
  for (
    const term of [
      "unsupported_runtime",
      "bundle only",
      "advisory, not release-gating",
      "TLS termination",
      "ControlClient.credential",
      "unauthenticated",
      "before paging",
      "Best effort"
    ]
  ) {
    assert.ok(page.includes(term), `support boundary: ${term}`)
  }
})

test("the release smoke row names the exact runtimes that certify the candidate tarballs", () => {
  const workflow = parseWorkflow(read(".github/workflows/release.yml"))
  const smokeSteps = workflow.jobs.publish.steps.filter((step) => step.run?.includes("node scripts/smoke-release.mjs "))
  assert.equal(smokeSteps.length, 1, "the release requires one smoke receipt on the supported Node floor")
  const pins = smokeSteps.map((step) => {
    const assertion = step.run.match(/test "\$\(node --version\)" = 'v([\d.]+)'/)
    assert.ok(assertion, `${step.name}: exact runtime assertion`)
    return assertion[1]
  })
  const page = read("apps/site/src/content/docs/docs/reference/support-matrix.mdx")
  const row = page.match(/^\| Node\.js release smoke\s+\| (.+) \|$/m)
  assert.ok(row, "the support matrix has a release smoke row")
  const documentedPins = [...row[1].matchAll(/`(\d+\.\d+\.\d+)`/g)].map(([, pin]) => pin)
  assert.deepEqual(documentedPins, pins, "release smoke versions must match the actual workflow checks")
})

test("installation, changelog, API overview, and navigation lead to the one support reference", () => {
  for (const path of ["docs/installation.mdx", "changelogs/1.0.0-rc.0.mdx", "docs/reference/api/index.mdx"]) {
    const page = read(`apps/site/src/content/docs/${path}`)
    assert.ok(page.includes(route), `${path}: support link`)
    assert.doesNotMatch(page, /1\.3\.14|ci\/BUILD\.ts|whichever runtime you provide/)
  }
  assert.ok(read("apps/site/astro.config.mjs").includes("slug: \"docs/reference/support-matrix\""))
})

test("Bun installation claims match its declared engine floor", () => {
  const directory = "packages/smithers/flows/platform-bun"
  const floor = JSON.parse(read(`${directory}/package.json`)).engines.bun.slice(2)
  for (const path of ["README.md", "docs/api.md", "docs/installation.md", "docs/quickstart.md"]) {
    const page = read(`${directory}/${path}`)
    assert.ok(page.includes(floor), `${path}: Bun ${floor}`)
    assert.doesNotMatch(page, /1\.3\.0/)
  }
})

test("the aggregate does not promise edge runtime execution", () => {
  const page = read("packages/smithers/flows/README.md")
  assert.doesNotMatch(page, /browser and edge runtimes may author/)
  assert.ok(page.includes("/docs/reference/support-matrix/"))
})

test("the reference is a current projection of its colocated sources", () => {
  const child = spawnSync(process.execPath, ["apps/site/scripts/sync-support-docs.mjs", "--check"], {
    cwd: root,
    encoding: "utf8"
  })
  assert.equal(child.status, 0, child.stdout + child.stderr)
})

test("generation repairs output drift and check mode refuses it", () => {
  mkdirSync(join(root, "review-evidence"), { recursive: true })
  const directory = mkdtempSync(join(root, "review-evidence/support-docs-"))
  try {
    mkdirSync(join(directory, "scripts"))
    cpSync(resolve(root, "apps/site/scripts/sync-support-docs.mjs"), join(directory, "scripts/sync-support-docs.mjs"))
    cpSync(resolve(root, "apps/site/docs"), join(directory, "docs"), { recursive: true })
    const run = (...args) =>
      spawnSync(process.execPath, [join(directory, "scripts/sync-support-docs.mjs"), ...args], {
        cwd: directory,
        encoding: "utf8"
      })
    assert.equal(run().status, 0)
    const page = join(directory, "src/content/docs/docs/reference/support-matrix.mdx")
    const generated = readFileSync(page, "utf8")
    writeFileSync(page, "stale support claim\n")
    const drift = run("--check")
    assert.equal(drift.status, 1)
    assert.match(drift.stderr, /support docs drift: docs\/reference\/support-matrix.mdx/)
    assert.equal(readFileSync(page, "utf8"), "stale support claim\n", "checking must not rewrite output")
    assert.equal(run().status, 0)
    assert.equal(readFileSync(page, "utf8"), generated)
    assert.equal(run("--check").status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const section of ["guides", "reference"]) {
  test(`${section} trigger docs distinguish durable CLI approvals from the library retry limit`, () => {
    const page = read(`apps/site/src/content/docs/docs/${section}/triggers.mdx`)
    const libraryNote = page.match(/:::note\[Library embedders only\]\n([\s\S]*?)\n:::/)
    assert.ok(libraryNote, "label the optional library runner policy")
    assert.match(libraryNote[1], /Scheduler\.layerControlRunner/)
    const cliPolicy = page.replace(libraryNote[0], "")
    assert.match(cliPolicy, /no attempt counter or expiry/)
    assert.match(cliPolicy, /across (?:scheduler )?restarts/)
    assert.doesNotMatch(cliPolicy, /eight|two minutes|exhausted.*attempts/)
    if (section === "guides") {
      assert.match(page, /smthrs triggers list/)
      assert.match(page, /smthrs triggers show nightly-lint/)
      assert.match(page, /smthrs approvals deny '<activePlan\.plan\.approval>'/)
      assert.match(page, /\/docs\/reference\/triggers\/#scheduler/)
      assert.match(libraryNote[1], /eight attempts/)
      assert.match(libraryNote[1], /two minutes/)
    } else {
      assert.match(page, /\/docs\/guides\/triggers\/#resolve-a-parked-approval/)
      assert.doesNotMatch(libraryNote[1], /eight|two minutes/, "link to the guide's policy instead of duplicating it")
    }
  })
}

test("operator docs describe the PR evidence upload and factory operator", () => {
  const ci = parseWorkflow(read(".github/workflows/ci.yml"))
  const steps = Object.values(ci.jobs).flatMap((job) => job.steps ?? [])
  for (const name of ["Collect ci-test-tier-evidence", "Upload ci-test-tier-evidence"]) {
    const matching = steps.filter((step) => step.name === name)
    assert.equal(matching.length, 1, `one ${name} step`)
    assert.equal(matching[0].if, "always()")
  }
  const bench = read("scripts/bench/README.md")
  assert.doesNotMatch(bench, /collects\s+evidence only after successful steps/, "stale success-only claim")
  assert.match(bench, /`if: always\(\)`/, "the bench guide states the always() upload")
  assert.match(bench, /if-no-files-found: ignore/, "the bench guide keeps the missing-files caveat")

  const removed = JSON.parse(read("apps/site/src/data/removed-commands.json"))
  const removedVerbs = new Set(JSON.stringify(removed).match(/"workflows?"/g)?.map((verb) => JSON.parse(verb)) ?? [])
  assert.ok(removedVerbs.has("workflow"), "the workflow verb is recorded as removed")
  for (const readme of ["factory/README.md", "factory/queue/README.md"]) {
    const text = read(readme)
    assert.doesNotMatch(text, /smithers workflow run/, `${readme}: retired verb`)
    assert.doesNotMatch(text, /\.smithers\/workflows\/queue-driver/, `${readme}: untracked workflow path`)
  }
})
