import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..")

test("API and LLM generators preserve inline HTML-comment code", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-inline-comment-"))
  const put = (path, content) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const run = (script, check = false) => {
    const result = spawnSync(process.execPath, [join(root, `apps/site/scripts/${script}`), ...(check ? ["--check"] : [])], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  try {
    for (const script of ["sync-api-docs.mjs", "generate-llms.mjs", "docs-text.mjs"]) {
      const path = `apps/site/scripts/${script}`
      put(path, readFileSync(join(repo, path), "utf8"))
    }
    put("apps/docs/shared/manifest.mjs", 'export const sites = [{ name: "@smthrs/integrations", slug: "integrations", domain: "integrations.smithers.sh" }]\n')
    put("apps/docs/shared/sync-content.mjs", 'export const outputRelFor = (value) => value; export const routeFor = (value) => value\n')
    put("packages/integrations/package.json", JSON.stringify({ name: "@smthrs/integrations", description: "Integrations", publishConfig: { access: "public" } }))
    put("packages/integrations/docs/api.md", '# API\n\n| Export | Value |\n| --- | --- |\n| `stickyMarker` | `<!-- smithers:key=KEY -->` |\n\n<!-- prose-only comment -->\n')
    put("apps/site/src/data/project.json", JSON.stringify({ description: "Smithers" }))
    put("apps/site/src/data/versions.json", "{}")
    put("apps/site/public/llms.txt", "")
    put("apps/site/public/llms-full.txt", "")

    run("sync-api-docs.mjs")
    const page = readFileSync(join(root, "apps/site/src/content/docs/docs/reference/api/integrations.mdx"), "utf8")
    assert.match(page, /`<!-- smithers:key=KEY -->`/)
    assert.match(page, /\{\/\* prose-only comment \*\/\}/)
    run("sync-api-docs.mjs", true)

    run("generate-llms.mjs")
    const full = readFileSync(join(root, "apps/site/public/llms-full.txt"), "utf8")
    assert.match(full, /`<!-- smithers:key=KEY -->`/)
    assert.doesNotMatch(full, /prose-only comment/)
    run("generate-llms.mjs", true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
