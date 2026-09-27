import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { catalogPublicationErrors } from "./catalog-publication.mjs"
import { publishedPackages } from "../../../scripts/pack-release.mjs"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

/** One private and one public manifest: the two states a catalog entry can be in. */
const fixture = {
  manifests: new Map([
    ["@smthrs/public-thing", { private: false }],
    ["@smthrs/private-thing", { private: true }],
    ["@smthrs/left-the-train", { private: false }]
  ]),
  roster: new Set(["@smthrs/public-thing"])
}

const heading = (name) => `### [\`${name}\`](https://example.test)\n\nWhat it does.\n`

test("a published package needs no label", () => {
  assert.deepEqual(catalogPublicationErrors(heading("@smthrs/public-thing"), fixture), [])
})

test("a private package presented as a catalog entry has to say so", () => {
  assert.deepEqual(catalogPublicationErrors(heading("@smthrs/private-thing"), fixture), [
    "@smthrs/private-thing is not in the release roster; the page heads a section with it without labelling it workspace-private"
  ])
})

test("the workspace-private label clears a private package", () => {
  const page = `${heading("@smthrs/private-thing")}\n\`@smthrs/private-thing\` is **workspace-private**: the example below runs inside this repository.\n`
  assert.deepEqual(catalogPublicationErrors(page, fixture), [])
})

test("a package the roster dropped is caught even though its manifest is public", () => {
  assert.deepEqual(catalogPublicationErrors(heading("@smthrs/left-the-train"), fixture), [
    "@smthrs/left-the-train is not in the release roster; the page heads a section with it without labelling it workspace-private"
  ])
})

test("labelling a published package workspace-private hides an install a reader can run", () => {
  const page = `${heading("@smthrs/public-thing")}\n\`@smthrs/public-thing\` is **workspace-private**.\n`
  assert.deepEqual(catalogPublicationErrors(page, fixture), [
    "@smthrs/public-thing is in the release roster; the page marks it workspace-private"
  ])
})

test("an install command for an unpublished package fails even when the entry is labelled", () => {
  const page = [
    heading("@smthrs/private-thing"),
    "`@smthrs/private-thing` is **workspace-private**.",
    "",
    "```bash",
    "npm install @smthrs/private-thing@next",
    "pnpm add @smthrs/public-thing",
    "```"
  ].join("\n")
  assert.deepEqual(catalogPublicationErrors(page, fixture), [
    "teaches installing @smthrs/private-thing, which the release roster does not publish"
  ])
})

test("a heading naming a package this repo does not have is a typo, not a label problem", () => {
  assert.deepEqual(catalogPublicationErrors(heading("@smthrs/gone"), fixture), [
    "heads a section with @smthrs/gone, which is not a package in this repo"
  ])
})

/** Every `@smthrs/*` manifest in the tree, keyed by name, as check-docs.mjs reads them. */
const treeManifests = () => {
  const manifests = new Map()
  const scan = (dir, depth) => {
    if (depth > 4 || dir.includes("node_modules") || dir.includes("/dist")) return
    const manifestPath = join(dir, "package.json")
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
        if (typeof manifest.name === "string" && manifest.name.startsWith("@smthrs/")) {
          manifests.set(manifest.name, { private: manifest.private === true })
        }
      } catch { /* keep walking */ }
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
        scan(join(dir, entry.name), depth + 1)
      }
    }
  }
  scan(join(repoRoot, "packages"), 0)
  return manifests
}

const catalogPath = new URL("../docs/reference/api/index.mdx", import.meta.url)

test("the API index agrees with the release roster", () => {
  const tree = { manifests: treeManifests(), roster: new Set(publishedPackages) }
  assert.deepEqual(catalogPublicationErrors(readFileSync(catalogPath, "utf8"), tree), [])
})

test("a table row names its package like a heading does", () => {
  assert.deepEqual(catalogPublicationErrors("| [`@smthrs/private-thing`](/docs/reference/api/private-thing/) | What it does |\n", fixture), [
    "@smthrs/private-thing is not in the release roster; the page heads a section with it without labelling it workspace-private"
  ])
})

test("dropping the chain label and teaching its install reddens the API index", () => {
  const tree = { manifests: treeManifests(), roster: new Set(publishedPackages) }
  const page = readFileSync(catalogPath, "utf8")
  const label = "[`@smthrs/chain`](/docs/reference/api/chain/) **workspace-private**"
  assert.ok(page.includes(label), "the API index labels the chain row workspace-private")
  const mutated = `${page.replace(label, "[`@smthrs/chain`](/docs/reference/api/chain/)")}\n\`\`\`bash\nnpm install @smthrs/chain@next\n\`\`\`\n`
  assert.deepEqual(catalogPublicationErrors(mutated, tree), [
    "@smthrs/chain is not in the release roster; the page heads a section with it without labelling it workspace-private",
    "teaches installing @smthrs/chain, which the release roster does not publish"
  ])
})
