/**
 * The seven rules the package executor always refuses are a recorded release
 * decision, not an accident (#2492): each is deferred past 1.0 under one
 * issue, every doc that labels a rule unsupported links that issue, and the
 * catalog table names every declared rule with a route, so a rule can neither
 * quietly become unsupported nor be left without an owner.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (relative: string) => readFileSync(join(root, relative), "utf8")

const deferred: Readonly<Record<string, number>> = {
  "Npm.Publish": 3163,
  "Changesets.Publish": 3163,
  "Github.Pr": 3164,
  "Git.Pr": 3164,
  "Github.Release": 3165,
  "Github.Pages": 3165,
  "Npm.Downstream": 3166
}

const catalogRows = (): ReadonlyArray<{ readonly rule: string; readonly route: string }> =>
  [...read("docs/rules.md").matchAll(/^\| `([^`]+)`\s*\|.*\|\s*([a-z ]+?)\s*\|$/gm)].map((match) => ({
    rule: match[1]!,
    route: match[2]!
  }))

describe("unsupported catalog rules", () => {
  it("marks exactly the deferred rules unsupported in the catalog table", () => {
    const unsupported = catalogRows().filter((row) => row.route === "unsupported").map((row) => row.rule).sort()
    expect(unsupported).toEqual(Object.keys(deferred).sort())
    for (const row of catalogRows()) {
      expect(["flow body", "package executor", "unsupported"]).toContain(row.route)
    }
  })

  it("lists every rule the sources declare in the catalog table", () => {
    const documented = new Set(catalogRows().map((row) => row.rule))
    const declared = readdirSync(join(root, "src"))
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => [...read(`src/${file}`).matchAll(/Target\.make\(\s*"([^"]+)"/g)].map((match) => match[1]!))
    expect(declared).toContain("Npm.Publish")
    for (const rule of declared) expect(documented, rule).toContain(rule)
  })

  it("links the deferral issue from every doc line that labels a rule unsupported", () => {
    const issues = [...new Set(Object.values(deferred))]
    for (const file of ["README.md", "docs/rules.md", "docs/reference/targets.md", "docs/reference/cheat-sheet.md"]) {
      const text = read(file)
      for (const issue of issues) expect(text, `${file} #${issue}`).toContain(`/issues/${issue}`)
    }
    const cheat = read("docs/reference/cheat-sheet.md").split("\n")
    cheat.forEach((line, index) => {
      if (!line.includes("Unsupported in this RC")) return
      const rule = /S\.([A-Za-z.]+)\(/.exec(cheat[index + 1]!)?.[1]
      expect(rule && deferred[rule], `cheat-sheet line ${index + 1}`).toBeDefined()
      expect(line).toContain(`/issues/${deferred[rule!]}`)
    })
  })
})
