import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { isRepositoryPath, RESERVED_SITE_SEGMENTS } from "./appDocument"

// Astro pages and Starlight's content collection both contribute site routes.
const sourceSegments = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(astro|md|mdx|html|[cm]?[jt]s)$/.test(entry.name))
  .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).split(sep)[0]!.replace(/\.[^.]+$/, ""))
  .filter((segment) => segment !== "index" && !segment.startsWith("["))

describe("repository path ownership", () => {
  test("the reserved constant covers every first segment in Astro pages and Starlight content", () => {
    const pages = sourceSegments(resolve(import.meta.dir, "../../site/src/pages"))
    const docs = sourceSegments(resolve(import.meta.dir, "../../site/src/content/docs"))
    expect(pages).toContain("privacy")
    expect(docs).toContain("docs")
    expect([...new Set([...pages, ...docs])].filter((segment) => !RESERVED_SITE_SEGMENTS.includes(segment))).toEqual([])
  })

  test("site and infrastructure segments cannot be GitHub owners, in any case", () => {
    for (const segment of ["docs", "pricing", "changelogs", "demo", "blog", "download", "api", "w", "_astro", ...RESERVED_SITE_SEGMENTS]) {
      expect(isRepositoryPath(`/${segment}/nope/`)).toBe(false)
      expect(isRepositoryPath(`/${segment.toUpperCase()}/nope`)).toBe(false)
    }
  })

  test("GitHub slug boundaries and exactly two segments are required", () => {
    for (const path of ["/a/b/", "/nope/nope", "/Some-Owner/repo_name.git", `/${"a".repeat(39)}/${"r".repeat(100)}`]) {
      expect(isRepositoryPath(path)).toBe(true)
    }
    for (const path of ["/", "/a/", "/a/b/c/", "/-a/b", "/a-/b", "/a--b/c", "/a_b/c", "/a/.", "/a/..", "/a/b%20c", "/a/b?x", `/${"a".repeat(40)}/b`, `/a/${"r".repeat(101)}`]) {
      expect(isRepositoryPath(path)).toBe(false)
    }
  })
})
