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
    "apps/site/src/content/docs/docs/developers.mdx",
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

/** The generated slice of the developers page, markers included. */
const region = (name) => {
  const text = readFileSync(join(site, "src/content/docs/docs/developers.mdx"), "utf8")
  const start = text.indexOf(`{/* generated:${name} start`)
  const end = text.indexOf(`{/* generated:${name} end */}`)
  assert.ok(start !== -1 && end > start, `developers.mdx has no generated:${name} region`)
  return text.slice(start, end)
}

test("the committed pages are the generator's own output", () => {
  execFileSync(process.execPath, [join(site, "scripts/generate-project-copy.mjs"), "--check"], { stdio: "pipe" })
})

test("the overview animation offers the browser one image to download", () => {
  const animation = region("project-animation")
  assert.equal(animation.match(/<img\b/g)?.length, 1)
  assert.equal(animation.match(/<source\b/g)?.length, 1)
  assert.match(animation, /<source[^>]*\bmedia="\(prefers-color-scheme: light\)"/)
  assert.ok(!animation.includes("theme-only-"), "a hidden second candidate still downloads")
})

test("the overview animation defers its own download", () => {
  const animation = region("project-animation")
  assert.match(animation, /<img[^>]*\bloading="lazy"/)
  assert.match(animation, /<img[^>]*\bdecoding="async"/)
})

test("project copy retires the docs homepage without recreating it", (t) => {
  const { root, run } = fixture(t)
  const clean = run()
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  const path = join(root, "apps/site/src/content/docs/docs/index.mdx")
  assert.equal(existsSync(path), false)
  writeFileSync(path, "Retired docs homepage.\n")
  const drift = run("--check")
  assert.equal(drift.status, 1, drift.stdout + drift.stderr)
  assert.match(drift.stderr, /src\/content\/docs\/docs\/index\.mdx/)
  assert.equal(readFileSync(path, "utf8"), "Retired docs homepage.\n", "checking leaves retired output untouched")
  const repaired = run()
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr)
  assert.equal(existsSync(path), false)
  assert.equal(run("--check").status, 0)
})
