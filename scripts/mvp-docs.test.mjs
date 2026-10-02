/**
 * Checks the proposed Mac install ADR, its supersession links and architecture
 * document links. Temporary files exercise the link checks independently of
 * the repository's current documentation.
 *
 * @since 0.1.0
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const documents = [
  "docs/architecture/0001-shared-product.md",
  "docs/architecture/0002-mac-install.md",
  "docs/architecture/self-host-implementation.md"
]

// Ignore examples and comments rather than interpreting them as rendered links.
const prose = (markdown) => markdown
  .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "")
  .replace(/<!--[\s\S]*?-->/g, "")

const destination = (source) => {
  if (source.startsWith("<")) return source.slice(1, source.indexOf(">"))
  let depth = 0
  let end = 0
  for (; end < source.length; end++) {
    const character = source[end]
    if (character === "\\") { end++; continue }
    if (character === "(") depth++
    if (character === ")") { if (depth === 0) break; depth-- }
    if (/\s/.test(character) && depth === 0) break
  }
  return source.slice(0, end).replace(/\\([\\()])/g, "$1")
}

const labelKey = (label) => label.trim().replace(/\s+/g, " ").toLowerCase()

const links = (markdown) => {
  const text = prose(markdown).replace(/(`+)[^\r\n]*?\1/g, "")
  const definitions = new Map()
  for (const match of text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(.+)$/gm)) {
    const key = labelKey(match[1])
    if (!definitions.has(key)) definitions.set(key, destination(match[2]))
  }
  const found = []
  const body = text.replace(/^ {0,3}\[[^\]]+\]:[^\n]*$/gm, "")
  for (const match of body.matchAll(/\[([^\]\n]*)\](?:\[([^\]\n]*)\])?/g)) {
    const following = body.slice(match.index + match[0].length)
    if (following.startsWith("(")) found.push(destination(following.slice(1)))
    else {
      const target = definitions.get(labelKey(match[2] || match[1]))
      if (target !== undefined) found.push(target)
    }
  }
  return found
}

const anchors = (markdown) => {
  const text = prose(markdown)
  const found = new Set()
  for (const match of text.matchAll(/<(?:a|[^\s>]+)\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/g)) found.add(match[1])
  const headings = [...text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)]
    .map((match) => ({ offset: match.index, title: match[1] }))
  for (const match of text.matchAll(/^([^\n]+)\n {0,3}(?:=+|-+)\s*$/gm)) headings.push({ offset: match.index, title: match[1] })
  headings.sort((left, right) => left.offset - right.offset)
  for (const { title } of headings) {
    const slug = title.replace(/<[^>]*>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-")
    let unique = slug
    let suffix = 0
    while (found.has(unique)) unique = `${slug}-${++suffix}`
    found.add(unique)
  }
  return found
}

const localTarget = (document, href) => {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) return undefined
  const [pathAndQuery, fragment] = href.split("#", 2)
  const pathname = decodeURIComponent(pathAndQuery.split("?", 1)[0])
  return { path: pathname ? resolve(dirname(document), pathname) : document, fragment: fragment === undefined ? undefined : decodeURIComponent(fragment) }
}

const linkErrors = (document) => {
  const errors = []
  for (const href of links(readFileSync(document, "utf8"))) {
    let target
    try { target = localTarget(document, href) }
    catch { errors.push(`${href}: invalid URL encoding`); continue }
    if (!target) continue
    try { statSync(target.path) }
    catch { errors.push(`${href}: missing target`); continue }
    if (target.fragment && /^\.(?:md|markdown|mdown)$/i.test(extname(target.path))) {
      if (!anchors(readFileSync(target.path, "utf8")).has(target.fragment)) errors.push(`${href}: missing fragment`)
    }
  }
  return errors
}

const hasLinkTo = (markdown, document, target) => links(markdown)
  .some((href) => localTarget(document, href)?.path === target)

test("ADR 0002 remains proposed until Will approves the engineering spec", () => {
  const document = readFileSync(join(root, documents[1]), "utf8")
  assert.match(document, /^Status: proposed \(2026-10-02\)\./m)
  assert.match(document, /^This record becomes accepted when Will approves the MVP engineering spec\.$/m)
})

test("ADR 0001 links ADR 0002 from its status line", () => {
  const document = join(root, documents[0])
  const status = readFileSync(document, "utf8").split("\n").find((line) => line.startsWith("Status:"))
  assert.ok(status, "ADR 0001 needs a Status line")
  assert.ok(hasLinkTo(status, document, join(root, documents[1])), "ADR 0001's Status line must link ADR 0002")
})

test("self-host implementation ledger links ADR 0002", () => {
  const document = join(root, documents[2])
  assert.ok(hasLinkTo(readFileSync(document, "utf8"), document, join(root, documents[1])), "The ledger must link ADR 0002")
})

test("self-host implementation matrix has no native-own row", () => {
  const rows = readFileSync(join(root, documents[2]), "utf8").split("\n")
    .filter((line) => /^\s*\|\s*`?native-own`?\s*\|/.test(line))
  assert.deepEqual(rows, [], "The Mac install replaces the native-own matrix row")
})

for (const name of documents) {
  test(`${name}: all relative Markdown links resolve`, () => {
    assert.deepEqual(linkErrors(join(root, name)), [])
  })
}

const fixture = (t, files) => {
  const directory = mkdtempSync(join(tmpdir(), "mvp-docs-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return directory
}

test("link checks report missing files and missing fragments independently", (t) => {
  const directory = fixture(t, {
    "index.md": "[missing](lost.md) [bad heading](target.md#absent) [good](target.md#present)",
    "target.md": "# Present\n"
  })
  assert.deepEqual(linkErrors(join(directory, "index.md")), ["lost.md: missing target", "target.md#absent: missing fragment"])
})

test("link checks resolve relative to each document, including parents and own fragments", (t) => {
  const directory = fixture(t, {
    "index.md": "# Root\n[child](nested/index.md#child)\n",
    "nested/index.md": "# Child\n[parent](../index.md#root) [self](#child) [local](local.md)\n",
    "nested/local.md": "# Local\n"
  })
  assert.deepEqual(linkErrors(join(directory, "index.md")), [])
  assert.deepEqual(linkErrors(join(directory, "nested/index.md")), [])
})

test("external URLs and site-root URLs are not local file links", (t) => {
  const directory = fixture(t, {
    "index.md": "[https](https://example.invalid/absent#no) [http](http://example.invalid/) [mail](mailto:team@example.invalid) [cdn](//example.invalid/file) [site](/docs/page)\n"
  })
  assert.deepEqual(linkErrors(join(directory, "index.md")), [])
})

test("reference links, images, URL escapes, titles and balanced parentheses resolve", (t) => {
  const directory = fixture(t, {
    "index.md": '[inline](folder/part(1).md "Title") [space](<folder/a b.md>) ![image](picture.svg) [full][page] [short][] [shortcut]\n\n[page]: folder/a%20b.md#details\n[short]: folder/part(1).md\n[shortcut]: folder/a%20b.md\n',
    "folder/part(1).md": "# Part\n",
    "folder/a b.md": "# Details\n",
    "picture.svg": "<svg/>\n"
  })
  assert.deepEqual(linkErrors(join(directory, "index.md")), [])
  assert.deepEqual(links(readFileSync(join(directory, "index.md"), "utf8")), ["folder/part(1).md", "folder/a b.md", "picture.svg", "folder/a%20b.md#details", "folder/part(1).md", "folder/a%20b.md"])
})

test("reference links cannot hide a broken relative target", (t) => {
  const directory = fixture(t, { "index.md": "[link][missing]\n\n[missing]: absent.md\n" })
  assert.deepEqual(linkErrors(join(directory, "index.md")), ["absent.md: missing target"])
})

test("query strings, escaped parentheses and duplicate reference definitions use the real target", (t) => {
  const directory = fixture(t, {
    "index.md": '[query](target.md?plain=1#details) [escaped](part\\(1\\).md) [reference][page]\n\n[page]: target.md#details "A title"\n[page]: absent.md\n',
    "target.md": "# Details\n",
    "part(1).md": "# Part\n"
  })
  assert.deepEqual(linkErrors(join(directory, "index.md")), [])
})

test("code examples and comments do not create document links", (t) => {
  const directory = fixture(t, { "index.md": "`[inline](absent.md)`\n\n```md\n[fenced](absent.md)\n```\n\n~~~md\n[tilde](absent.md)\n~~~\n\n<!-- [comment](absent.md) -->\n" })
  assert.deepEqual(linkErrors(join(directory, "index.md")), [])
})

test("unmatched backticks cannot hide broken links on later lines", (t) => {
  const directory = fixture(t, { "index.md": "An unmatched `backtick\n[missing](absent.md)\n`valid code`\n" })
  assert.deepEqual(linkErrors(join(directory, "index.md")), ["absent.md: missing target"])
})

test("unmatched double backticks cannot hide broken reference links across CRLF lines", (t) => {
  const directory = fixture(t, { "index.md": "An unmatched ``backtick\r\n[missing][target]\r\n[target]: absent.md\r\n``valid code``\r\n" })
  assert.deepEqual(linkErrors(join(directory, "index.md")), ["absent.md: missing target"])
})

test("fragments cover duplicate headings, punctuation, inline code, setext and explicit anchors", (t) => {
  const directory = fixture(t, {
    "index.md": "[first](target.md#use-flowmake) [duplicate](target.md#use-flowmake-1) [setext](target.md#other-heading) [html](target.md#custom) [encoded](target.md#caf%C3%A9)\n",
    "target.md": '# Use `Flow.make`!\n## Use `Flow.make`!\n\nOther heading\n---\n\n<a id="custom"></a>\n\n## Café\n'
  })
  assert.deepEqual(linkErrors(join(directory, "index.md")), [])
})

test("invalid URL encoding is a visible link failure", (t) => {
  const directory = fixture(t, { "index.md": "[invalid](broken%file.md)\n" })
  assert.deepEqual(linkErrors(join(directory, "index.md")), ["broken%file.md: invalid URL encoding"])
})
