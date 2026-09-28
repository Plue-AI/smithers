import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Run the actual sync CLI against an isolated source package and site. */
const fixture = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-sync-content-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  copyFileSync(new URL("./sync-content.mjs", import.meta.url), join(root, "sync-content.mjs"))
  // The gate renders pages with the kit's own Starlight/Astro Markdown stack.
  symlinkSync(realpathSync(new URL("./node_modules", import.meta.url)), join(root, "node_modules"))
  writeFileSync(join(root, "manifest.mjs"), `
    export const repoRoot = ${JSON.stringify(root)}
    export const docsRoot = repoRoot + "/sites"
    export const sites = [{ slug: "fixture", name: "fixture", description: "Fixture docs",
      dir: "package", siteDir: docsRoot + "/fixture" }]
    export const bySlug = new Map(sites.map((site) => [site.slug, site]))
  `)
  const source = join(root, "package/docs")
  const output = join(root, "sites/fixture/src/content/docs")
  mkdirSync(join(source, "guides/nested"), { recursive: true })
  writeFileSync(join(source, "README.md"), "# Fixture\n\nOverview.\n")
  writeFileSync(join(source, "guides/nested/page.md"), "# Page\n\nNested page.\n")
  const run = (nodeArgs, args) => execFileSync(process.execPath, [...nodeArgs, join(root, "sync-content.mjs"), "fixture", ...args], {
    cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000
  })
  const sync = (...args) => run([], args)
  const syncWithHook = (code) => {
    const hook = join(root, "hook.mjs")
    writeFileSync(hook, code)
    return run(["--import", hook], [])
  }
  return { root, source, output, sync, syncWithHook }
}

test("deleting the last nested page prunes empty parents and the next sync is a no-op", (t) => {
  const { source, output, sync } = fixture(t)
  sync()
  assert.ok(existsSync(join(output, "guides/nested/page.md")))
  const index = join(output, "index.md")
  const content = readFileSync(index, "utf8")
  const mtime = statSync(index).mtimeMs

  rmSync(join(source, "guides/nested/page.md"))
  assert.match(sync(), /synced fixture: 1 drifted/)
  assert.equal(existsSync(join(output, "guides")), false)
  assert.deepEqual(readdirSync(output), ["index.md"])

  assert.match(sync(), /synced fixture: clean/)
  assert.deepEqual(readdirSync(output), ["index.md"])
  assert.equal(readFileSync(index, "utf8"), content)
  assert.equal(statSync(index).mtimeMs, mtime)
  assert.match(sync("--check"), /checked fixture: clean/)
})

test("pruning keeps nonempty parents and unprojected assets", (t) => {
  const { source, output, sync } = fixture(t)
  sync()
  const asset = join(output, "guides/asset.svg")
  writeFileSync(asset, "<svg />\n")
  rmSync(join(source, "guides/nested/page.md"))

  assert.match(sync(), /synced fixture: 1 drifted/)
  assert.equal(existsSync(join(output, "guides/nested")), false)
  assert.equal(readFileSync(asset, "utf8"), "<svg />\n")
  assert.match(sync(), /synced fixture: clean/)
})

for (const race of ["removed", "refilled"]) {
  test(`pruning tolerates a directory ${race} between the empty check and removal`, (t) => {
    const { source, output, sync, syncWithHook } = fixture(t)
    sync()
    rmSync(join(source, "guides/nested/page.md"))
    const nested = join(output, "guides/nested")
    const result = syncWithHook(`
      import fs from "node:fs"
      import { syncBuiltinESMExports } from "node:module"
      const rmdir = fs.rmdirSync
      fs.rmdirSync = (path, options) => {
        if (path === ${JSON.stringify(nested)}) {
          ${race === "removed" ? "rmdir(path)" : 'fs.writeFileSync(path + "/asset.svg", "<svg />\\n")'}
        }
        return rmdir(path, options)
      }
      syncBuiltinESMExports()
    `)
    assert.match(result, /synced fixture: 1 drifted/)
    if (race === "removed") {
      assert.equal(existsSync(join(output, "guides")), false)
    } else {
      assert.equal(readFileSync(join(nested, "asset.svg"), "utf8"), "<svg />\n")
    }
    assert.match(sync(), /synced fixture: clean/)
  })
}

/** Runs the sync expecting a refusal; returns its stderr. */
const refused = (sync, ...args) => {
  try {
    sync(...args)
  } catch (error) {
    assert.equal(error.status, 1)
    return error.stderr
  }
  assert.fail("sync was expected to refuse the site")
}

test("a symlinked source page is refused, never published", (t) => {
  const { root, source, output, sync } = fixture(t)
  writeFileSync(join(root, "secret.txt"), "SECRET-OUTSIDE-DOCS\n")
  symlinkSync(join(root, "secret.txt"), join(source, "leak.md"))
  for (const args of [[], ["--check"]]) {
    assert.match(refused(sync, ...args), /refused: fixture: symlink in docs tree: leak\.md/)
  }
  assert.equal(existsSync(output), false)
})

for (const [label, target] of [["a symlinked docs directory", "package/docs"], ["a symlinked package directory", "package"]]) {
  test(`${label} is refused, never published`, (t) => {
    const { root, output, sync } = fixture(t)
    const outside = join(root, "outside")
    mkdirSync(join(outside, "docs"), { recursive: true })
    writeFileSync(join(outside, "MEMORY.md"), "SECRET-OUTSIDE-DOCS\n")
    writeFileSync(join(outside, "docs/MEMORY.md"), "SECRET-OUTSIDE-DOCS\n")
    rmSync(join(root, target), { recursive: true })
    symlinkSync(outside, join(root, target))
    for (const args of [[], ["--check"]]) {
      assert.match(refused(sync, ...args), new RegExp(`refused: fixture: symlink on the docs source path: ${target}$`, "m"))
    }
    assert.equal(existsSync(output), false)
  })
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Links the rewriter would send to GitHub carry a leading space so they
// reach the renderer as written.
// Each page is refused by the rendered tree, not by pattern: the bypasses a
// regex scanner missed (comment, backtick, fence-info, quoted-> and
// entity tricks, and frontmatter) are all here.
for (const [problem, page] of [
  ["HTML element not allowed: <script>", "<script>alert(1)</script>"],
  ["HTML attribute not allowed: <img onError>", "<img src=x onerror=alert(1)>"],
  ["URL scheme not allowed: <a href> javascript:", "[docs]( javascript:alert(1))"],
  ["URL scheme not allowed: <a href> javascript:", "[docs]( javascript&#58;alert(1))"],
  ["URL scheme not allowed: <a href> javascript:", "<a href=\"java&#x09;script:alert(1)\">x</a>"],
  ["URL scheme not allowed: <a href> vbscript:", "[docs][x]\n\n[x]: vbscript:msgbox(1)"],
  ["URL scheme not allowed: <a href> data:", "<a href=\"data:text/html,<b>x</b>\">x</a>"],
  ["URL scheme not allowed: <img src> javascript:", "![x]( javascript:alert(1))"],
  ["HTML attribute not allowed: <img onError>", "<!--> <img src=x onerror=alert(1)> -->"],
  ["HTML element not allowed: <iframe>", "<iframe srcdoc=\"&lt;script&gt;alert(1)&lt;/script&gt;\"></iframe>"],
  ["HTML attribute not allowed: <img onError>", "`<img src=x onerror=alert(1)>``"],
  ["HTML element not allowed: <script>", "``` x ` y\n<script>alert(1)</script>\n```"],
  ["HTML attribute not allowed: <img onError>", "<img alt=\">\" onerror=alert(1) src=x>"],
  ["URL scheme not allowed: <a href> javascript:", "<div>\n<a/href=\"javascript:alert(1)\">x</a>\n</div>"],
  ["HTML element not allowed: <svg>", "<svg><a><animate attributeName=href values=javascript:alert(1)/>"],
  ["HTML element not allowed: <style>", "<style>body{display:none}</style>"],
  ["HTML attribute not allowed: <p style>", "<p style=\"position:fixed\">x</p>"],
  ["HTML attribute not allowed: <input type=text>", "<input type=text>"],
  ["frontmatter key not allowed: head", "---\ntitle: x\nhead:\n  - tag: script\n    content: alert(1)\n---\n\nBody."],
  ["frontmatter key not allowed: banner", "---\nbanner:\n  content: <img src=x onerror=alert(1)>\n---\n\nBody."],
  ["frontmatter value not allowed: sidebar", "---\nsidebar:\n  attrs:\n    onclick: alert(1)\n---\n\nBody."],
  ["frontmatter value not allowed: editUrl", "---\neditUrl: javascript:alert(1)\n---\n\nBody."]
]) {
  test(`a page that renders ${problem} is refused: ${page.replace(/\n/g, "\\n")}`, (t) => {
    const { source, output, sync } = fixture(t)
    writeFileSync(join(source, "attack.md"), page.startsWith("---") ? `${page}\n` : `## Attack\n\n${page}\n`)
    assert.match(refused(sync), new RegExp(`refused: fixture: ${escapeRegExp(problem)}: attack\\.md`))
    assert.equal(existsSync(join(output, "attack.md")), false)
  })
}

test("safe raw HTML, GFM, asides, and escaped placeholders are published", (t) => {
  const { source, output, sync } = fixture(t)
  const page = [
    "---", "title: Safe", "sidebar:", "  order: 2", "---", "",
    "<details><summary>More</summary>", "", "See <a href=\"https://smithers.sh/\">the site</a>.", "", "</details>", "",
    "| a | b |", "| :- | -: |", "| 1 | 2 |", "", "- [x] done", "", ":::note", "Aside.", ":::", "",
    "### jj \\<method>: failed", "", "<!-- a comment -->", "[mail](mailto:a@b.c) [rel](./x.md)", ""
  ].join("\n")
  writeFileSync(join(source, "safe.md"), page)
  assert.match(sync(), /synced fixture/)
  assert.match(readFileSync(join(output, "safe.md"), "utf8"), /<details><summary>More<\/summary>/)
})

test("script-shaped text inside code is published unchanged", (t) => {
  const { source, output, sync } = fixture(t)
  const page = "## Code\n\nUse `javascript:` or `<script>` as text.\n\n```html\n<script>run()</script>\n<img onerror=x>\n```\n"
  writeFileSync(join(source, "code.md"), page)
  assert.match(sync(), /synced fixture/)
  assert.match(readFileSync(join(output, "code.md"), "utf8"), /<script>run\(\)<\/script>/)
})

test("a symlink in the output tree is refused and its target is not overwritten", (t) => {
  const { root, output, sync } = fixture(t)
  const victim = join(root, "victim.txt")
  writeFileSync(victim, "untouched\n")
  mkdirSync(output, { recursive: true })
  symlinkSync(victim, join(output, "index.md"))
  assert.match(refused(sync), /refused: fixture: symlink in site content tree: fixture\/src\/content\/docs\/index\.md/)
  assert.equal(readFileSync(victim, "utf8"), "untouched\n")
  assert.ok(lstatSync(join(output, "index.md")).isSymbolicLink())
})

test("a symlinked output directory is refused and nothing is written through it", (t) => {
  const { root, output, sync } = fixture(t)
  const elsewhere = join(root, "elsewhere")
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, "keep.md"), "keep\n")
  mkdirSync(join(output, ".."), { recursive: true })
  symlinkSync(elsewhere, output)
  assert.match(refused(sync), /refused: fixture: symlink in site content tree: fixture\/src\/content\/docs$/m)
  assert.deepEqual(readdirSync(elsewhere), ["keep.md"])
})
