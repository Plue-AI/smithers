import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"

const readDoc = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ")

const pages = [
  "README.md",
  ...readdirSync(new URL("../docs", import.meta.url), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => `docs/${path}`)
]

/** A page's blank-line-separated blocks, without frontmatter or fenced code. */
const blocksOf = (path: string): Array<string> =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("#"))

/** Every page a block appears on, keyed by the block's normalized text. */
const homes = (key: (block: string) => string | undefined): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>()
  for (const path of pages) {
    for (const block of blocksOf(path)) {
      const k = key(block)
      if (k !== undefined) found.set(k, (found.get(k) ?? new Set()).add(path))
    }
  }
  return found
}

const shared = (found: Map<string, Set<string>>): Array<string> =>
  [...found].filter(([, paths]) => paths.size > 1).map(([k, paths]) => `${[...paths].join(" and ")}: ${k}`)

describe("each documented fact has one home", () => {
  it("no prose paragraph appears verbatim on two pages", () => {
    expect(shared(homes((block) => block.startsWith("|") ? undefined : block.replace(/\s+/g, " ")))).toEqual([])
  })

  it("no behaviour table is kept on two pages", () => {
    const rowKeys = (block: string): string | undefined => {
      if (!block.startsWith("|")) return undefined
      const keys = block.split("\n").slice(2).map((row) => row.split("|")[1]?.trim()).sort()
      return keys.join(", ")
    }
    expect(shared(homes(rowKeys))).toEqual([])
  })
})

describe("documented filesystem refusal contract", () => {
  it.each(["README.md", "docs/contract.md"])("%s distinguishes refusal from absence", (path) => {
    const doc = readDoc(path)
    expect(doc).not.toContain("fail with a `NotFound`")
    expect(doc).toContain("fail with a `PermissionDenied` `PlatformError` naming the method")
    expect(doc).toContain("`NotFound` is reserved for a path the backend reports absent")
  })

  it.each(["README.md", "docs/contract.md"])("%s documents optional backend operations", (path) => {
    expect(readDoc(path)).toContain("`rename` and `utimes` are served when the backend supplies them")
  })

  it.each(["README.md", "docs/contract.md", "docs/testing.md", "CHANGELOG.md"])(
    "%s refuses realPath without backend canonicalization",
    (path) => {
      const doc = readDoc(path)
      // Lexical handling of recursive directory identities and symlink/.. is distinct from a realPath fallback.
      expect(doc).not.toMatch(
        /`realPath` answers lexically|lexical canonicalization in `realPath`|without that member the answer is lexical/
      )
      expect(doc).toContain("Without `realpath`, `realPath` fails with a `PermissionDenied` `PlatformError`")
    }
  )
})

describe("documented isolation and environment boundaries", () => {
  it("states that BrowserHost attests the whole mount and jj.root never narrows it", () => {
    const doc = readDoc("docs/concepts/isolation-attestation.md")
    expect(doc).not.toContain("checks `jj.root`")
    expect(doc).toContain("`BrowserHost.layer` always attests the whole mount `/`")
    expect(doc).toContain("never narrows the isolation boundary")
  })

  it("warns that the interpreter environment is ambient to every command", () => {
    expect(readDoc("docs/guides/run-a-command.md")).toContain(
      "Never seed credentials into the interpreter's environment"
    )
  })
})
