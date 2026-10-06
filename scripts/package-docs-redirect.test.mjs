import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { repoRoot } from "./workspace-packages.mjs"
import { redirectLocation, redirectMap } from "./package-docs.mjs"
test("legacy links including deep pages map to package docs; unknown slugs map to README", () => {
  for (const [url, dir] of [
    ["https://flow.smithers.sh/", "packages/smithers/flows/flow"],
    ["https://engine.smithers.sh/concepts/retries/", "packages/smithers/flows/engine"],
    ["https://smithers-patterns.smithers.sh/", "packages/smithers/flows/patterns"],
    ["https://smithers-sync.smithers.sh/", "packages/smithers/flows/sync"]
  ]) assert.equal(redirectLocation(url), `https://github.com/smithersai/smithers/tree/main/${dir}/docs`)
  assert.equal(redirectLocation("https://unknown.smithers.sh/deep"), "https://github.com/smithersai/smithers/blob/main/README.md")
  assert.equal(redirectLocation("https://constructor.smithers.sh/deep"), "https://github.com/smithersai/smithers/blob/main/README.md")
  assert.ok(Object.keys(redirectMap).length >= 48)
})

test("the generated library site workspace is deleted", () => {
  assert.equal(existsSync(join(repoRoot, "apps", "docs")), false)
})
