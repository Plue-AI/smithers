import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { bundle, layout, readSources, rootFile, tagFile } from "./openapi-bundle.mjs"

const committed = () => readFileSync(layout.output, "utf8")

const root = [
  "openapi: 3.1.0",
  "info:",
  "  title: T",
  "paths:",
  "components:",
  "  schemas:",
  "    Error:",
  "      type: object",
  "  responses:",
  "    NotFound:",
  "      description: Not found",
  ""
].join("\n")

const operation = (method, path, tag) =>
  [`  ${path}:`, `    ${method}:`, `      operationId: ${method}_${path.replace(/\W+/g, "_")}`, "      tags:", `        - ${tag}`, "      responses: {}"]

const source = (...lines) => `${lines.flat().join("\n")}\n`

const sources = (entries) => new Map([[rootFile, root], ...Object.entries(entries)])

test("the committed bundle is exactly what the per-tag sources produce", () => {
  assert.equal(bundle(readSources(layout.sources)), committed(), "run `smthrs run //:openapiBundle` to re-bundle docs/api/openapi.yaml")
})

test("the bundle is the parsed merge of its sources", () => {
  const files = readSources(layout.sources)
  const merged = YAML.parse(files.get(rootFile))
  assert.equal(merged.paths, null)
  merged.paths = {}
  for (const [name, text] of files) {
    if (name === rootFile) continue
    const part = YAML.parse(text)
    assert.deepEqual(Object.keys(part), part.components === undefined ? ["paths"] : ["paths", "components"], `${name} holds authored paths and optional component entries`)
    for (const [path, item] of Object.entries(part.paths)) {
      assert.equal(merged.paths[path], undefined, `${path} is declared once`)
      for (const op of Object.values(item)) assert.equal(tagFile(op.tags[0]), name, `${path} lives in its tag's file`)
      merged.paths[path] = item
    }
    for (const [kind, items] of Object.entries(part.components ?? {})) {
      assert.ok(Object.hasOwn(merged.components, kind), `${kind} is declared by the root`)
      for (const [key, value] of Object.entries(items)) {
        assert.equal(merged.components[kind][key], undefined, `${kind}.${key} is declared once`)
        merged.components[kind][key] = value
      }
    }
  }
  assert.deepEqual(YAML.parse(committed()), merged)
})

test("tag files are named by a lower-case slug of the tag", () => {
  assert.equal(tagFile("Pair Sessions"), "pair-sessions.yaml")
  assert.equal(tagFile("OAuth2"), "oauth2.yaml")
  assert.equal(tagFile(" Repository  Setup! "), "repository-setup.yaml")
  assert.throws(() => tagFile("!!!"), /has no file name/)
})

test("tag files append their paths and components in file-name order", () => {
  const out = bundle(sources({
    "user.yaml": source("paths:", operation("get", "/api/user", "User")),
    "admin.yaml": source(
      "paths:",
      operation("post", "/api/admin", "Admin"),
      "components:",
      "  schemas:",
      "    AdminThing:",
      "      type: string"
    )
  }))
  assert.equal(out, source(
    "openapi: 3.1.0",
    "info:",
    "  title: T",
    "paths:",
    operation("post", "/api/admin", "Admin"),
    operation("get", "/api/user", "User"),
    "components:",
    "  schemas:",
    "    Error:",
    "      type: object",
    "    AdminThing:",
    "      type: string",
    "  responses:",
    "    NotFound:",
    "      description: Not found"
  ))
  assert.deepEqual(Object.keys(YAML.parse(out).components.schemas), ["Error", "AdminThing"])
})

test("a quoted tag names the same file", () => {
  const item = operation("get", "/api/x", "'Pair Sessions'")
  assert.match(bundle(sources({ "pair-sessions.yaml": source("paths:", item) })), /- 'Pair Sessions'/)
})

test("malformed or misfiled sources are refused", () => {
  const cases = [
    [new Map(), /_root\.yaml: is missing/],
    [new Map([[rootFile, root.replace("paths:\n", "paths:\n  /x:\n    get: {}\n")]]), /must declare an empty `paths:`/],
    [new Map([[rootFile, root.replace("paths:\n", "")]]), /must declare an empty `paths:`/],
    [new Map([[rootFile, root.replace("paths:", "paths: {}")]]), /must declare an empty `paths:`/],
    [new Map([[rootFile, root.replace("  responses:", "  responses: {}")]]), /components\.responses must be a block mapping/],
    [new Map([[rootFile, `${root}info: again\n`]]), /duplicate top-level key info/],
    [new Map([[rootFile, root.slice(0, -1)]]), /must end with a newline/],
    [sources({ "a.yaml": "paths:\n\n" }), /a\.yaml:2: blank lines are not allowed/],
    [sources({ "a.yaml": "  paths:\n" }), /a\.yaml:1: expected a key at indentation 0/],
    [sources({ "a.yaml": "- paths\n" }), /a\.yaml:1: expected a block mapping key/],
    [sources({ "a.yaml": "paths: {}\n" }), /paths must be a block mapping/],
    [sources({ "a.yaml": source("paths:", "    /api/a:") }), /a\.yaml:2: expected a key at indentation 2/],
    [sources({ "a.yaml": "info:\n  title: X\n" }), /only paths and components belong in a tag file, not info/],
    [sources({ "a.yaml": source("paths:", operation("get", "/api/b", "B")) }), /get \/api\/b is tagged B; move it to b\.yaml/],
    [sources({ "a.yaml": source("paths:", "  /api/a:", "    get:", "      responses: {}") }), /get \/api\/a has no tags/],
    [sources({ "a.yaml": source("paths:", "  /api/a:", "    get:", "      tags:") }), /get \/api\/a has no tags/],
    [new Map([[rootFile, "paths:\n"], ["a.yaml", source("components:", "  schemas:", "    A:", "      type: string")]]), /components\.schemas is not declared/],
    [
      sources({
        "a.yaml": source("paths:", operation("get", "/api/a", "A")),
        "b.yaml": source("paths:", operation("get", "/api/a", "B"))
      }),
      /b\.yaml:2: path \/api\/a is already declared in a\.yaml/
    ],
    [sources({ "a.yaml": source("components:", "  schemas:", "    Error:", "      type: string") }), /components\.schemas\.Error is already declared in _root\.yaml/],
    [sources({ "a.yaml": source("components:", "  headers:", "    X:", "      schema: {}") }), /components\.headers is not declared in _root\.yaml/]
  ]
  for (const [input, message] of cases) assert.throws(() => bundle(input), message)
})

test("path-item keys other than methods are not ownership-checked", () => {
  const item = ["  /api/a/{id}:", "    parameters:", "      - name: id", ...operation("get", "/api/a/{id}", "A").slice(1)]
  assert.match(bundle(sources({ "a.yaml": source("paths:", item) })), /parameters:/)
})

test("operations added under different tags merge into the bundle without a conflict", () => {
  const base = readSources(layout.sources)
  const withOperation = (file, path, tag) => {
    const next = new Map(base)
    const text = next.get(file)
    const components = text.indexOf("\ncomponents:")
    const at = components === -1 ? text.length : components + 1
    next.set(file, text.slice(0, at) + source(operation("get", path, tag)) + text.slice(at))
    return next
  }
  const ours = withOperation("admin.yaml", "/api/admin/merge-probe", "Admin")
  const theirs = withOperation("user.yaml", "/api/user/merge-probe", "User")
  const both = new Map(ours)
  both.set("user.yaml", theirs.get("user.yaml"))
  const directory = mkdtempSync(join(tmpdir(), "openapi-merge-"))
  try {
    for (const [name, files] of [["base", base], ["ours", ours], ["theirs", theirs]]) {
      writeFileSync(join(directory, name), bundle(files))
    }
    const merge = spawnSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: directory, encoding: "utf8" })
    assert.equal(merge.status, 0, merge.stdout)
    assert.equal(merge.stdout, bundle(both))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the script rewrites a stale bundle from the sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "openapi-bundle-"))
  try {
    const script = fileURLToPath(new URL("./openapi-bundle.mjs", import.meta.url))
    cpSync(script, join(directory, "scripts/openapi-bundle.mjs"))
    cpSync(layout.sources, join(directory, "docs/api/openapi"), { recursive: true })
    const output = join(directory, "docs/api/openapi.yaml")
    writeFileSync(output, "stale\n")
    const tag = join(directory, "docs/api/openapi/health.yaml")
    writeFileSync(tag, `${readFileSync(tag, "utf8")}${source(operation("get", "/api/health-probe", "Health"))}`)
    const stdout = execFileSync(process.execPath, [join(directory, "scripts/openapi-bundle.mjs")], { encoding: "utf8" })
    assert.equal(stdout, "wrote openapi.yaml\n")
    const rewritten = readFileSync(output, "utf8")
    assert.notEqual(rewritten, committed(), "a tag-file change without re-bundling leaves the committed bundle stale")
    assert.ok(YAML.parse(rewritten).paths["/api/health-probe"].get)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
