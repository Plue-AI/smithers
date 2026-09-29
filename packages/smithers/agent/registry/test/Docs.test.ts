import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Digest from "@smthrs/core/Digest"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"

// The package owns its own prose. Nothing generates these files, so this is
// the gate that keeps the scan's cost model honest: discovery reads and
// SHA-256 hashes an admitted entry whole, and 64 KiB bounds parsing rather
// than I/O. docs/api.md and docs/concepts/sources.md already say so; these
// five said the scan reads only a metadata prefix.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const flatten = (...parts: ReadonlyArray<string>): string =>
  readFileSync(join(packageRoot, ...parts), "utf8")
    .replace(/^\s*\*[ \t]?/gm, "")
    .replace(/\s+/g, " ")

const documents: ReadonlyArray<ReadonlyArray<string>> = [
  ["README.md"],
  ["docs", "README.md"],
  ["docs", "quickstart.md"],
  ["docs", "concepts", "descriptors.md"],
  ["src", "index.ts"]
]

describe("the API quick start", () => {
  it("imports its public modules and lists an empty project", async () => {
    const api = readFileSync(join(packageRoot, "docs", "api.md"), "utf8")
    const example = api.match(/## Example\s+```ts\n([\s\S]*?)\n```/)?.[1]
    expect(example).toBeDefined()

    const bindings: Record<string, unknown> = {}
    const importLine = /^import (?:\* as (\w+)|\{ ([^}]+) \}) from "([^"]+)"$/gm
    const imports = Array.from(example!.matchAll(importLine))
    expect(imports.length).toBeGreaterThan(0)
    for (const [, namespace, named, specifier] of imports) {
      const module = await import(specifier!)
      if (namespace !== undefined) {
        bindings[namespace] = module
      } else {
        for (const name of named!.split(",").map((part) => part.trim())) {
          expect(module).toHaveProperty(name)
          bindings[name] = module[name]
        }
      }
    }

    const root = mkdtempSync(join(tmpdir(), "smithers-registry-quick-start-"))
    const output: Array<unknown> = []
    try {
      await runInNewContext(
        `(async () => { ${example!.replace(importLine, "")} })()`,
        { ...bindings, process: { cwd: () => root }, console: { log: (value: unknown) => output.push(value) } }
      )
      expect(output).toEqual([[]])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

describe("the documented scan cost model", () => {
  it.each(documents)("describes a whole-file read and hash in %s", (...parts) => {
    const document = flatten(...parts)
    expect(document).toMatch(/reads? and hash(?:es|ed) each entry file whole/)
    expect(document).toContain("64 KiB")
  })

  it.each(documents)("claims no prefix-only read in %s", (...parts) => {
    expect(flatten(...parts)).not.toContain("only far enough")
  })

  it("hashes the bytes past an entry's metadata, which is what the prose promises", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-registry-docs-"))
    try {
      const location = join(root, "review", "SKILL.md")
      const metadata = "---\ndescription: Reviews a change.\ncapabilities: []\n---\n"
      mkdirSync(dirname(location), { recursive: true })
      writeFileSync(location, `${metadata}Body past the closing fence.`)

      const scanned = await Effect.runPromise(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan({ source: "project", root, naming: "path" })
        }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))))
      )

      const digest = scanned.entries[0]?.body.contentDigest
      expect(digest).toBe(Digest.digest(readFileSync(location)))
      expect(digest).not.toBe(Digest.digest(Buffer.from(metadata)))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

/**
 * A changelog entry that names a file sends a reader to it. The rc.0 entry
 * named `packages/registry/PACKAGE.ts`, `docs/Manifest.ts`, and
 * `scripts/docs.mjs`, none of which existed, so every repo-relative path the
 * changelog quotes must resolve from the workspace root.
 */
describe("the changelog's file references", () => {
  const workspaceRoot = join(packageRoot, "..", "..", "..", "..")
  const changelog = readFileSync(join(packageRoot, "CHANGELOG.md"), "utf8")
  const paths = Array.from(
    changelog.matchAll(/`((?:[\w.-]+\/)+[\w.-]+\.[a-z]{2,4})`/g),
    (match) => match[1]!
  )

  it("quotes at least one path", () => {
    expect(paths.length).toBeGreaterThan(0)
  })

  it.each(paths)("names %s, which exists", (path) => {
    expect(existsSync(join(workspaceRoot, path))).toBe(true)
  })
})

/**
 * The reference lists the warning codes by hand, and the diagnostic guide
 * explains them one at a time. A code added to the schema and left out of
 * either one is a code a reader cannot look up, which is how the count in
 * api.md came to say 30 for a schema holding 31.
 */
describe("the documented warning vocabulary", () => {
  const api = readFileSync(join(packageRoot, "docs", "api.md"), "utf8")
  const guide = readFileSync(join(packageRoot, "docs", "guides", "diagnose-a-missing-flow.md"), "utf8")

  it("counts the codes the schema declares", () => {
    expect(api).toContain(`The ${Descriptor.DiscoveryWarningCode.literals.length} codes are grouped`)
  })

  it.each(Descriptor.DiscoveryWarningCode.literals)("explains %s in both documents", (code) => {
    expect(api).toContain(`\`${code}\``)
    expect(guide).toContain(`| \`${code}\``)
  })
})
