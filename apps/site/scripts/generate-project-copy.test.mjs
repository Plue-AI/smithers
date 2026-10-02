import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(site, "../..")

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-project-copy-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of [
    "apps/site/scripts/generate-project-copy.mjs",
    "apps/site/src/data/project.json",
    "apps/site/docs/installation.mdx",
    "README.md",
    "package.json"
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(repo, path), join(root, path))
  }
  return {
    root,
    run: (...args) => spawnSync(process.execPath, [join(root, "apps/site/scripts/generate-project-copy.mjs"), ...args], {
      encoding: "utf8"
    })
  }
}

test("the committed pages are the generator's own output", () => {
  execFileSync(process.execPath, [join(site, "scripts/generate-project-copy.mjs"), "--check"], { stdio: "pipe" })
})

test("installation opens with the unchanged project description", () => {
  const project = JSON.parse(readFileSync(join(site, "src/data/project.json"), "utf8"))
  const text = readFileSync(join(site, "docs/installation.mdx"), "utf8")
  const body = text.split(/^---\s*$/m).slice(2).join("---").trimStart()
  assert.match(body, /^\{\/\* generated:project-description start/)
  const region = body.split("{/* generated:project-description end */}")[0]
  assert.equal(region.slice(region.indexOf("*/}") + 3).trim(), project.description)
})

test("project description updates only its installation region", (t) => {
  const { root, run } = fixture(t)
  const path = join(root, "apps/site/docs/installation.mdx")
  const before = readFileSync(path, "utf8")
  const projectPath = join(root, "apps/site/src/data/project.json")
  const project = JSON.parse(readFileSync(projectPath, "utf8"))
  project.description = "A changed description for this fixture."
  writeFileSync(projectPath, JSON.stringify(project))
  assert.equal(run("--check").status, 1)
  assert.equal(readFileSync(path, "utf8"), before, "check is read-only")
  const written = run()
  assert.equal(written.status, 0, written.stdout + written.stderr)
  assert.equal(readFileSync(path, "utf8"), before.replace(JSON.parse(readFileSync(join(site, "src/data/project.json"), "utf8")).description, project.description))
  assert.equal(run("--check").status, 0)
})

for (const retired of ["index", "developers"]) test(`project copy retires ${retired} without recreating it`, (t) => {
  const { root, run } = fixture(t)
  const clean = run()
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  const path = join(root, `apps/site/src/content/docs/docs/${retired}.mdx`)
  assert.equal(existsSync(path), false)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "Retired docs homepage.\n")
  const drift = run("--check")
  assert.equal(drift.status, 1, drift.stdout + drift.stderr)
  assert.ok(drift.stderr.includes(`src/content/docs/docs/${retired}.mdx`), drift.stderr)
  assert.equal(readFileSync(path, "utf8"), "Retired docs homepage.\n", "checking leaves retired output untouched")
  const repaired = run()
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr)
  assert.equal(existsSync(path), false)
  assert.equal(run("--check").status, 0)
})
