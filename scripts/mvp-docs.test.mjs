/**
 * Checks the proposed Mac install ADR, its supersession links and architecture
 * document links. Temporary files exercise the link checks independently of
 * the repository's current documentation.
 *
 * @since 0.1.0
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
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

// Literal contracts replace the untested daemon and cross-machine-home claims.
for (const [name, requirements] of [
  ["machine-only execution", ["Repository code runs only inside machines:", "The Mac host runs only code shipped in the install package", "never loads repository flows into its process", "refuses to start without working microVM isolation", "never falls back to host processes or `trusted_process`", "Members and agents have no `sudo`"]],
  ["person-session approval", ["Only a signed-in person's browser `session` credential can approve or merge", "receive `delegated` credentials with `via` attribution", "The coding agent's `run` credential and a machine's credential cannot approve or merge"]],
  ["per-machine homes and logins", ["a private home on each machine", "Tool logins persist in that machine’s home across sleep and wake", "Tokens, tool history, caches and databases never copy between machines", "a recreated machine starts with empty homes", "The synced per-member credential store is deferred"]],
  ["logged-in S1 LaunchAgent", ["per-user LaunchAgent under `gui/<uid>`", "who must be logged in", "Startup uses no privilege escalation", "T-INS-02 owns the S1 host launcher; T-INS-08 owns the per-user LaunchAgent", "T-INS-03 supplies measured release evidence, not an S1 prerequisite", "Before-login daemon support is unproven"]],
  ["shared multi-member branch", ["one machine shared by members and the coding agent", "Branch locks are removed", "Owner, Maintainer and Member roles", "live GitHub write access", "replaces issue 1667's single-owner model"]],
  ["origin-agnostic core app", ["HTTP and SSH always listen on loopback", "The owner can add a bind address and public origins", "PostgreSQL stays on loopback", "one-time setup URL", "The app works on plain HTTP", "Optional browser notifications require a secure origin", "The install creates no certificate authority", "No code depends on either", "Tailscale-only serving would tie the product to one vendor"]],
  ["host-derived limits", ["Capacity, machine memory, vCPUs and the layer budget derive from the host profile detected at startup", "memory, performance cores, free disk, macOS version and Hypervisor.framework availability", "Fixed defaults per Mac model cannot account"]],
  ["retained shared-product authority", ["Plue composes the public backend", "PostgreSQL remains the authority", "`@smthrs/flow` remains the sole Flow model"]]
]) {
  test(`ADR 0002 records ${name}`, () => {
    const document = prose(readFileSync(join(root, documents[1]), "utf8"))
    for (const requirement of requirements) assert.ok(document.includes(requirement), requirement)
  })
}

test("ADR 0001 marks both replaced Mac assemblies superseded", () => {
  const document = readFileSync(join(root, documents[0]), "utf8")
  const paragraphs = document.split("\n\n").filter((paragraph) => paragraph.startsWith("**Superseded for the Mac install"))
  assert.equal(paragraphs.length, 2)
  assert.ok(paragraphs[0].includes("`trusted_process`"))
  assert.ok(paragraphs[1].includes("native app"))
  for (const paragraph of paragraphs) assert.ok(hasLinkTo(paragraph, join(root, documents[0]), join(root, documents[1])))
})

test("implementation ledger requires the logged-in LaunchAgent without certifying support", () => {
  const document = readFileSync(join(root, documents[2]), "utf8")
  for (const requirement of ["tracks implementation and required proof, not completion", "per-user LaunchAgent under `gui/<uid>`", "logged-in installing user", "no privilege escalation", "before-login daemon support is unproven", "| mac-install |", "| web-plue |"])
    assert.ok(document.includes(requirement), requirement)
  assert.doesNotMatch(document, /\|\s*`?native-(?:own|plue)`?\s*\|/)
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

// Replace ad hoc deletion decisions with the same reference checks in fixtures
// and the repository. Historical evidence is retained pending owner inventory.
const scanFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .filter((entry) => !["node_modules", ".git", "dist", ".astro", ".smithers"].includes(entry.name))
  .flatMap((entry) => entry.isDirectory() ? scanFiles(join(directory, entry.name))
    : /\.(?:md|mdx|ts|tsx|js|mjs|html|json|go|rs)$/.test(entry.name) ? [join(directory, entry.name)] : [])

const inboundReferences = (directory, target, files) => {
  const absolute = join(directory, target)
  return files.filter((file) => file !== absolute && (
    readFileSync(file, "utf8").includes(target)
    || [...links(readFileSync(file, "utf8")),
      ...[...readFileSync(file, "utf8").matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])]
      .some((href) => localTarget(file, href)?.path === absolute)
  )).map((file) => file.slice(directory.length + 1)).sort()
}

const retirementErrors = (directory, target, files, { approved, cutLanded, replacement, ids = [] }) => {
  const file = join(directory, target)
  let content
  try { content = readFileSync(file, "utf8") } catch {
    const references = inboundReferences(directory, target, files)
    return references.map((source) => `${target}: referenced by ${source}`)
  }
  if (!approved || !cutLanded) return content.includes("> Superseded") && content.includes("## ")
    ? [] : [`${target}: preserve superseded banner and contents until approval and cut landing`]
  const errors = []
  if (/five (?:jobs|setups)|Implementation status/.test(content)) errors.push(`${target}: legacy requirements remain`)
  if (!hasLinkTo(content, file, join(directory, replacement))) errors.push(`${target}: missing approved replacement`)
  if (!links(content).some((href) => href.startsWith("https://github.com/smithersai/smithers/blob/")))
    errors.push(`${target}: missing history link`)
  for (const id of ids) if (!content.includes(`| ${id} |`)) errors.push(`${target}: missing decision ${id}`)
  return errors
}

for (const blocker of [{ approved: false, cutLanded: true }, { approved: true, cutLanded: false }]) {
  test(`retirement preserves legacy contents with blocker ${JSON.stringify(blocker)}`, (t) => {
    const directory = fixture(t, { "docs/mvp/DESIGN.md": "> Superseded\n\n## Historical design\nOld content\n" })
    const target = "docs/mvp/DESIGN.md"
    assert.deepEqual(retirementErrors(directory, target, scanFiles(directory), blocker), [])
    writeFileSync(join(directory, target), "[Design](../../.specs/design/README.md)\n")
    assert.deepEqual(retirementErrors(directory, target, scanFiles(directory), blocker), [
      "docs/mvp/DESIGN.md: preserve superseded banner and contents until approval and cut landing"
    ])
  })
}

for (const [source, content] of [
  ["flows/example.ts", "// docs/mvp/REGISTRATION.md"],
  ["docs/index.md", "[Register](mvp/REGISTRATION.md)"],
  ["apps/example.tsx", 'const image = "docs/mvp/mockups/start.html"'],
  ["docs/mvp/example.html", '<img src="mockups/start.html">']
]) {
  test(`surviving reference in ${source} blocks deletion`, (t) => {
    const target = (source.startsWith("apps/") || source.endsWith(".html")) ? "docs/mvp/mockups/start.html" : "docs/mvp/REGISTRATION.md"
    const directory = fixture(t, { [source]: content })
    assert.deepEqual(retirementErrors(directory, target, scanFiles(directory), {}), [`${target}: referenced by ${source}`])
  })
}

test("approved pointer retains replacement, cited IDs and history", (t) => {
  const target = "docs/mvp/ENGINEERING.md"
  const directory = fixture(t, {
    [target]: "[Engineering](../../.specs/engineering/README.md)\n[History](https://github.com/smithersai/smithers/blob/abc/docs/mvp/ENGINEERING.md)\n| E-01 | Retained |\n",
    ".specs/engineering/README.md": "# Engineering\n"
  })
  const options = { approved: true, cutLanded: true, replacement: ".specs/engineering/README.md", ids: ["E-01"] }
  assert.deepEqual(retirementErrors(directory, target, scanFiles(directory), options), [])
  assert.deepEqual(linkErrors(join(directory, target)), [])
  writeFileSync(join(directory, target), "# Pointer\n")
  assert.deepEqual(retirementErrors(directory, target, scanFiles(directory), options), [
    "docs/mvp/ENGINEERING.md: missing approved replacement", "docs/mvp/ENGINEERING.md: missing history link",
    "docs/mvp/ENGINEERING.md: missing decision E-01"
  ])
})

test("unapproved repository records retain superseded banners and contents", () => {
  for (const target of ["docs/mvp/ENGINEERING.md", "docs/mvp/DESIGN.md"])
    assert.deepEqual(retirementErrors(root, target, [], { approved: false, cutLanded: false }), [])
  for (const [target, replacement] of [
    ["docs/mvp/ENGINEERING.md", ".specs/engineering/README.md"],
    ["docs/mvp/DESIGN.md", ".specs/design/README.md"]
  ]) assert.ok(hasLinkTo(readFileSync(join(root, target), "utf8"), join(root, target), join(root, replacement)))
  assert.ok(statSync(join(root, "docs/mvp/implementation/release-20260916.md")).isFile())
  assert.ok(readFileSync(join(root, "scripts/check-release-evidence-tags.mjs"), "utf8").includes("release-20260916.md"))
})

test("product index preserves every decision cited by source", () => {
  const index = readFileSync(join(root, "docs/mvp/PRODUCT.md"), "utf8")
  const rows = new Set([...index.matchAll(/^\| (D-\d+[a-z]?)(?: |\()/gm)].map((match) => match[1]))
  for (const id of ["D-09a", "D-16", "D-25"]) assert.ok(rows.has(id), id)
  const missing = new Set()
  for (const tree of ["apps", "packages", "flows"]) for (const file of scanFiles(join(root, tree))) {
    for (const [id] of readFileSync(file, "utf8").matchAll(/\bD-\d{2}[a-z]?\b/g)) if (!rows.has(id)) missing.add(id)
  }
  assert.deepEqual([...missing].sort(), [])
})

test("repository documentation relative links resolve", () => {
  const files = [join(root, "AGENTS.md"), ...scanFiles(join(root, "docs")), ...scanFiles(join(root, "apps/site/docs"))]
    .filter((file) => /\.mdx?$/.test(file))
  const errors = files.flatMap((file) => linkErrors(file).map((error) => `${file.slice(root.length)}: ${error}`))
  assert.deepEqual(errors, [])
})

test("reference-free cut document may be removed", (t) => {
  const directory = fixture(t, { "docs/index.md": "# Index\n" })
  assert.deepEqual(retirementErrors(directory, "docs/mvp/REGISTRATION.md", scanFiles(directory), {}), [])
})
