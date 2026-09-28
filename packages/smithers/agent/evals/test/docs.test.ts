import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

// The JSDoc scanner must not run past the end of a comment block, so the body
// pattern excludes a closing delimiter rather than matching lazily.
const documented =
  /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+(?:const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/g

const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)]
    .map(([, namespace, file]) => [namespace!, file!] as const)

const exported = (): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const [namespace, file] of namespaces()) {
    for (const [, block, name] of read(`../src/${file}.ts`).matchAll(documented)) {
      if (block!.includes("@category")) names.add(`${namespace}.${name!}`)
    }
  }
  return [...names]
}

const tabled = (): ReadonlyArray<string> =>
  [...read("../docs/api.md").matchAll(/^\| `([A-Za-z]+\.[A-Za-z0-9_$]+)` *\| /gmu)].map(([, name]) => name!)

// A hand-written export table drifts the moment a module gains or loses a
// documented export, and nothing else in this private package would notice.
describe("documentation", () => {
  it("tables every documented export exactly once", () => {
    const rows = tabled()
    expect(rows.length).toBeGreaterThan(0)
    expect([...new Set(rows)]).toEqual(rows)
    expect([...rows].sort()).toEqual([...exported()].sort())
  })

  // The README is what npm renders, and the package's "files" list does not
  // ship docs/, so the reference it points a reader at has to be the published
  // site rather than a path that is absent from the tarball.
  it("keeps the package README pointing at the published reference", () => {
    const readme = read("../README.md")
    expect(readme).toContain("https://evals.smithers.sh/reference/api/")
    expect(readme).not.toContain("npm install")
  })

  // The README says the package is not on the npm registry, so an install page
  // that tells a reader to `pnpm add` it sends them to a registry 404.
  it("installs the package the way the README does", () => {
    expect(read("../README.md")).toContain("not on the npm registry")
    const installation = read("../docs/installation.md")
    expect(installation).not.toMatch(/(?:pnpm add|npm install|yarn add) @smthrs\/evals/)
    expect(installation).toContain(`"@smthrs/evals": "workspace:*"`)
  })

  // A formatter spaces `yield*` into `yield *` in a fragment it cannot parse
  // as a generator body, so every `yield*` fence has to sit inside one.
  it("shows every yield* inside a generator", () => {
    const pages = [
      "../README.md",
      ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".md"))
        .map((path) => `../docs/${path}`)
    ]
    for (const page of pages) {
      for (const [, fence] of read(page).matchAll(/```ts\n([\s\S]*?)```/g)) {
        expect(fence, page).not.toContain("yield *")
        if (fence!.includes("yield*")) expect(fence, page).toContain("function*")
      }
    }
  })

  // A reader copies a recording snippet verbatim, and a baseline recorded over
  // a failed case ratifies the missing measurement, so a later gate passes a
  // regressed flow. Every fence that writes a baseline refuses a failed case.
  it("guards every baseline recording against failed cases", () => {
    const pages = [
      "../README.md",
      ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".md"))
        .map((path) => `../docs/${path}`)
    ]
    let recordings = 0
    for (const page of pages) {
      for (const [, fence] of read(page).matchAll(/```ts\n([\s\S]*?)```/g)) {
        if (!fence!.includes("Baseline.write(")) continue
        recordings += 1
        const guard = fence!.indexOf("result.error !== undefined")
        expect(guard, page).toBeGreaterThanOrEqual(0)
        expect(fence!.indexOf("Refusing to record a baseline"), page).toBeGreaterThan(guard)
        expect(fence!.indexOf("Baseline.write("), page).toBeGreaterThan(guard)
      }
    }
    expect(recordings).toBeGreaterThan(0)
  })

  // Runner re-invokes executor and scorer effects on every run, so identical
  // options guarantee stable output only when those callbacks are stable, and
  // an Observation carries `at` but not `runId`.
  it("states determinism as conditional on caller-owned callbacks", () => {
    for (const page of ["../docs/api.md", "../docs/guides/run-a-suite.md", "../docs/concepts/determinism.md"]) {
      const text = read(page).replace(/\s+/g, " ")
      expect(text, page).not.toMatch(/stamps every observation with them/)
      expect(text, page).not.toMatch(
        /two runs (?:of the same suite )?over the same inputs produce (?:byte-)?identical/i
      )
    }
    const determinism = read("../docs/concepts/determinism.md").replace(/\s+/g, " ")
    expect(determinism).not.toContain("controls every input that could vary")
    for (const input of ["clock", "model", "random", "external state", "mutat"]) {
      expect(determinism).toContain(input)
    }
  })

  it("states that a declared case expected wins over binding groundTruth", () => {
    for (const page of ["../src/Suite.ts", "../docs/api.md", "../docs/guides/author-a-suite.md"]) {
      expect(read(page).replace(/\s*\*?\s+/g, " "), page).toMatch(
        /only an absent (?:one|`expected`) defers to the binding/
      )
    }
  })

  it("files the release notes under the released version", () => {
    expect(read("../CHANGELOG.md")).toContain("## [1.0.0-rc.0]")
  })
})
