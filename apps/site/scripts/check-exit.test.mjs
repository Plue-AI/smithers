// A `--check` that exits nonzero must say why on stderr. Each case runs the
// real script against a temporary copy of its inputs, puts one output out of
// date, and reads the result through pipes, the way CI and agent harnesses do.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(site, "..", "..")

const withCopy = (fn) => {
  const root = mkdtempSync(join(tmpdir(), "site-check-exit-"))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const copy = (root, rel) => cpSync(join(repo, rel), join(root, rel), { recursive: true })
const check = (root, script) =>
  spawnSync(process.execPath, [join(root, "apps/site/scripts", script), "--check"], { encoding: "utf8", stdio: "pipe" })

test("generate-llms --check names the stale file and the fix command", () => {
  withCopy((root) => {
    for (const rel of ["scripts/generate-llms.mjs", "scripts/docs-text.mjs", "src/content/docs/docs", "src/data", "public/llms.txt", "public/llms-full.txt"]) {
      copy(root, join("apps/site", rel))
    }
    assert.equal(check(root, "generate-llms.mjs").status, 0, "the copied tree starts clean")
    appendFileSync(join(root, "apps/site/public/llms.txt"), "stale\n")
    const result = check(root, "generate-llms.mjs")
    assert.equal(result.status, 1)
    assert.match(result.stderr, /drift: public\/llms\.txt/)
    assert.match(result.stderr, /generate-llms: 1 file\(s\) out of date; run node apps\/site\/scripts\/generate-llms\.mjs/)
  })
})

test("sync-api-docs --check names the stale page and the fix command", () => {
  withCopy((root) => {
    copy(root, "apps/site/scripts/sync-api-docs.mjs")
    copy(root, "apps/docs/shared")
    copy(root, "apps/site/src/content/docs/docs/reference/api")
    // Only each package's manifest and api.md are inputs; copy just those.
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
        walk(join(dir, entry.name))
      }
      for (const rel of ["package.json", "docs/api.md"]) {
        const from = join(dir, rel)
        try {
          readFileSync(from)
        } catch {
          continue
        }
        const to = join(root, relative(repo, from))
        mkdirSync(dirname(to), { recursive: true })
        cpSync(from, to)
      }
    }
    walk(join(repo, "packages"))
    assert.equal(check(root, "sync-api-docs.mjs").status, 0, "the copied tree starts clean")
    appendFileSync(join(root, "apps/site/src/content/docs/docs/reference/api/agent.mdx"), "stale\n")
    const result = check(root, "sync-api-docs.mjs")
    assert.equal(result.status, 1)
    assert.match(result.stderr, /drift: src\/content\/docs\/docs\/reference\/api\/agent\.mdx/)
    assert.match(result.stderr, /sync-api-docs: 1 page\(s\) out of date; run node apps\/site\/scripts\/sync-api-docs\.mjs/)
  })
})

test("ingest-reference --check names the stale page and the fix command", () => {
  withCopy((root) => {
    copy(root, "apps/site/scripts/ingest-reference.mjs")
    copy(root, "apps/docs/shared")
    copy(root, "apps/site/src/content/docs/docs/reference")
    // The docs manifest reads every package's manifest; the ingested sources are three docs trees.
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
        walk(join(dir, entry.name))
      }
      try {
        readFileSync(join(dir, "package.json"))
      } catch {
        return
      }
      copy(root, join(relative(repo, dir), "package.json"))
    }
    walk(join(repo, "packages"))
    for (const source of ["packages/smithers/flows/flow", "packages/smithers/flows/engine", "packages/smithers/build/targets"]) {
      copy(root, `${source}/docs`)
    }
    assert.equal(check(root, "ingest-reference.mjs").status, 0, "the copied tree starts clean")
    appendFileSync(join(root, "apps/site/src/content/docs/docs/reference/api/targets.mdx"), "stale\n")
    const result = check(root, "ingest-reference.mjs")
    assert.equal(result.status, 1)
    assert.match(result.stderr, /drift: apps\/site\/src\/content\/docs\/docs\/reference\/api\/targets\.mdx/)
    assert.match(result.stderr, /run node apps\/site\/scripts\/ingest-reference\.mjs/)
  })
})

// process.exit() ends the process before queued writes to a pipe drain, and
// on macOS pipe writes are asynchronous, so a reason printed just before it
// can reach the reader truncated or not at all. Setting exitCode lets node
// flush stdout and stderr first.
test("no check ends with process.exit()", () => {
  for (const script of [
    "check-docs.mjs",
    "gen-cli-data.mjs",
    "gen-examples.mjs",
    "generate-llms.mjs",
    "generate-project-copy.mjs",
    "ingest-reference.mjs",
    "sync-api-docs.mjs",
    "sync-support-docs.mjs"
  ]) {
    const source = readFileSync(join(site, "scripts", script), "utf8")
    assert.doesNotMatch(source, /process\.exit\(/, `${script} calls process.exit()`)
  }
})
