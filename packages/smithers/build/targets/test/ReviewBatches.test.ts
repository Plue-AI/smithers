import { describe, expect, it } from "vitest"
import * as ReviewBatches from "../src/internal/ReviewBatches.ts"

const bytesCost = (segment: ReviewBatches.Segment): number =>
  ReviewBatches.estimateTokens(JSON.stringify(segment.contents)) + 10

describe("ReviewBatches import graph", () => {
  it("reads relative static, dynamic, re-export and require specifiers once each", () => {
    const source = [
      "import { a } from \"./a.ts\"",
      "import './side-effect'",
      "export * from \"../shared/index.js\"",
      "const lazy = await import(\"./lazy\")",
      "const legacy = require('./legacy.cjs')",
      "import { again } from \"./a.ts\"",
      "import { external } from \"effect\"",
      "import { absolute } from \"/etc/passwd\""
    ].join("\n")
    expect(ReviewBatches.importSpecifiers(source)).toEqual([
      "./a.ts",
      "./side-effect",
      "../shared/index.js",
      "./lazy",
      "./legacy.cjs"
    ])
  })

  it("resolves TypeScript sources behind JavaScript specifiers, extensionless and index imports", () => {
    expect(ReviewBatches.importCandidates("src/app.ts", "./util.js").slice(0, 2)).toEqual([
      "src/util.js",
      "src/util.ts"
    ])
    expect(ReviewBatches.importCandidates("src/app.ts", "./view.jsx")[1]).toBe("src/view.tsx")
    expect(ReviewBatches.importCandidates("src/app.ts", "./esm.mjs")[1]).toBe("src/esm.mts")
    expect(ReviewBatches.importCandidates("src/app.ts", "./cjs.cjs")[1]).toBe("src/cjs.cts")
    expect(ReviewBatches.importCandidates("src/app.ts", "./dir/")).toContain("src/dir/index.ts")
    const exists = new Set(["src/lib/index.ts", "src/util.ts"])
    expect(ReviewBatches.resolveImport("src/app.ts", "./lib", (path) => exists.has(path))).toBe("src/lib/index.ts")
    expect(ReviewBatches.resolveImport("src/app.ts", "./util.js", (path) => exists.has(path))).toBe("src/util.ts")
    expect(ReviewBatches.resolveImport("src/app.ts", "./missing", (path) => exists.has(path))).toBeUndefined()
  })

  it("never resolves a specifier outside the workspace or to the workspace root", () => {
    expect(ReviewBatches.importCandidates("src/app.ts", "../../outside.ts")).toEqual([])
    expect(ReviewBatches.importCandidates("app.ts", "../outside")).toEqual([])
    expect(ReviewBatches.importCandidates("src/app.ts", "../")).toEqual([])
  })

  it("derives caller patterns from module and index directory stems, escaping regex syntax", () => {
    expect(ReviewBatches.importStems("src/auth/index.ts")).toEqual(["index", "auth"])
    expect(ReviewBatches.importStems("index.ts")).toEqual(["index"])
    expect(ReviewBatches.callerPatterns(["src/a+b.ts", "README.md", "src/a+b.ts"])).toEqual([
      "/a\\+b(\\.[A-Za-z]+)?[\"']"
    ])
    const pattern = new RegExp(ReviewBatches.callerPatterns(["src/a+b.ts"])[0]!)
    expect(pattern.test("import x from \"./a+b.js\"")).toBe(true)
    expect(pattern.test("import x from \"./aab.js\"")).toBe(false)
  })

  it("groups Go files by directory", () => {
    expect(ReviewBatches.goDirectories(["svc/a.go", "svc/b.go", "main.go", "web/app.ts"])).toEqual([".", "svc"])
    expect(ReviewBatches.goPackage("web/app.ts")).toBeUndefined()
  })

  it("relates changed files to each other and orders dependencies, siblings, then callers", () => {
    const changed = [
      {
        path: "src/handler.ts",
        contents: "import { guard } from \"./guard.ts\"\nimport { store } from \"./store.ts\"\n"
      },
      { path: "src/store.ts", contents: "export const store = 1\n" },
      { path: "svc/a.go", contents: "package svc\n" },
      { path: "svc/b.go", contents: "package svc\n" }
    ]
    const unchanged = [
      { path: "src/route.ts", contents: "import { handler } from \"./handler.js\"\n" },
      { path: "src/guard.ts", contents: "export const guard = 1\n" },
      { path: "src/unrelated.ts", contents: "import { x } from \"./other.ts\"\n" },
      { path: "svc/c.go", contents: "package svc\n" },
      { path: "README.md", contents: "import x from \"./src/handler.ts\"\n" }
    ]
    const names = new Set([...changed, ...unchanged].map((file) => file.path))
    const { edges, related } = ReviewBatches.relate(changed, unchanged, (path) => names.has(path))
    expect([...edges.get("src/handler.ts")!]).toEqual(["src/store.ts"])
    expect([...edges.get("src/store.ts")!]).toEqual(["src/handler.ts"])
    expect([...edges.get("svc/a.go")!]).toEqual(["svc/b.go"])
    expect(related.get("src/handler.ts")).toEqual(["src/guard.ts", "src/route.ts"])
    expect(related.get("svc/a.go")).toEqual(["svc/c.go"])
    expect(related.has("src/store.ts")).toBe(false)
    expect(ReviewBatches.calleePaths(changed, (path) => names.has(path))).toEqual(["src/guard.ts"])
  })

  it("ignores unresolved imports and resolved files outside the related set, listing each relation once", () => {
    const changed = [{
      path: "src/a.ts",
      contents: "import \"./missing\"\nimport \"./context.ts\"\nimport \"./dep.ts\"\nimport \"./dep.js\"\n"
    }]
    const unchanged = [{ path: "src/dep.ts", contents: "export {}\n" }]
    const names = new Set(["src/a.ts", "src/dep.ts", "src/context.ts"])
    const { edges, related } = ReviewBatches.relate(changed, unchanged, (path) => names.has(path))
    expect(edges.size).toBe(0)
    expect(related.get("src/a.ts")).toEqual(["src/dep.ts"])
  })
})

describe("ReviewBatches splitting", () => {
  it("keeps a file whole when it fits", () => {
    const segments = ReviewBatches.splitFile({ path: "a.ts", contents: "export const a = 1\n" }, 1_000, bytesCost)
    expect(segments).toEqual([{
      path: "a.ts",
      contents: "export const a = 1\n",
      firstLine: 1,
      lastLine: 2,
      totalLines: 2
    }])
  })

  it("cuts at top-level symbol boundaries and reassembles the exact source", () => {
    const body = (name: string) => `export function ${name}() {\n${"  work()\n".repeat(40)}}\n`
    const contents = `${body("first")}${body("second")}${body("third")}`
    const segments = ReviewBatches.splitFile({ path: "big.ts", contents, deleted: true }, 250, bytesCost)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map((segment) => segment.contents).join("")).toBe(contents)
    for (const segment of segments) {
      expect(bytesCost(segment)).toBeLessThanOrEqual(250)
      expect(segment.contents.split("\n")[0]).toMatch(/^export function/)
      expect(segment.deleted).toBe(true)
      expect(segment.totalLines).toBe(contents.split("\n").length)
    }
    expect(segments[0]!.firstLine).toBe(1)
    for (let index = 1; index < segments.length; index++) {
      expect(segments[index]!.firstLine).toBe(segments[index - 1]!.lastLine + 1)
    }
  })

  it("falls back to line boundaries inside an oversized declaration", () => {
    const contents = `export const table = [\n${"  \"entry\",\n".repeat(200)}]\n`
    const segments = ReviewBatches.splitFile({ path: "table.ts", contents }, 120, bytesCost)
    expect(segments.length).toBeGreaterThan(2)
    expect(segments.map((segment) => segment.contents).join("")).toBe(contents)
    expect(segments.every((segment) => bytesCost(segment) <= 120)).toBe(true)
  })

  it("slices one overlong line by characters without splitting a surrogate pair", () => {
    const contents = `${"😀".repeat(600)}\nexport const tail = 1`
    const segments = ReviewBatches.splitFile({ path: "min.js", contents }, 200, bytesCost)
    expect(segments.map((segment) => segment.contents).join("")).toBe(contents)
    const firstLine = segments.filter((segment) => segment.firstLine === 1)
    expect(firstLine.length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.contents.isWellFormed()).toBe(true)
      expect(segment.lastLine).toBe(segment.firstLine)
    }
  })

  it("refuses a slice that cannot fit even one character", () => {
    expect(() => ReviewBatches.splitFile({ path: "x.ts", contents: "abc\ndef" }, 5, () => 6)).toThrow(
      /cannot be split under the review token budget/
    )
  })
})

describe("ReviewBatches planning", () => {
  const file = (path: string, size = 10) => ({ path, contents: "x".repeat(size) })
  const graph = (pairs: ReadonlyArray<readonly [string, string]>) => {
    const edges = new Map<string, Set<string>>()
    for (const [left, right] of pairs) {
      edges.set(left, new Set([...(edges.get(left) ?? []), right]))
      edges.set(right, new Set([...(edges.get(right) ?? []), left]))
    }
    return edges
  }
  const plan = (
    files: ReadonlyArray<{ path: string; contents: string }>,
    options: Partial<ReviewBatches.PlanInput> = {}
  ) =>
    ReviewBatches.planBatches({
      files,
      edges: new Map(),
      related: new Map(),
      relatedCost: () => 5,
      segmentCost: (segment) => segment.contents.length,
      budget: 100,
      maximumFiles: 8,
      ...options
    })
  const paths = (batches: ReadonlyArray<ReviewBatches.PlannedBatch>) =>
    batches.map((batch) => batch.changed.map((segment) => segment.path))

  it("plans nothing for no files", () => {
    expect(plan([])).toEqual([])
  })

  it("keeps related files together instead of slicing the alphabetic order", () => {
    const files = [file("a.ts"), file("m.ts"), file("z.ts")]
    expect(paths(plan(files, { maximumFiles: 2 }))).toEqual([["a.ts", "m.ts"], ["z.ts"]])
    expect(paths(plan(files, { maximumFiles: 2, edges: graph([["a.ts", "z.ts"]]) }))).toEqual([
      ["a.ts", "z.ts"],
      ["m.ts"]
    ])
  })

  it("packs whole components by token budget and starts a new request for one that does not fit", () => {
    const files = [file("a.ts", 40), file("b.ts", 40), file("c.ts", 40), file("d.ts", 40)]
    expect(paths(plan(files, { edges: graph([["c.ts", "d.ts"]]) }))).toEqual([["a.ts", "b.ts"], ["c.ts", "d.ts"]])
    expect(paths(plan(files, { edges: graph([["b.ts", "c.ts"]]) }))).toEqual([["a.ts"], ["b.ts", "c.ts"], ["d.ts"]])
  })

  it("splits a component larger than one request breadth-first and keeps its slices adjacent", () => {
    const files = [file("a.ts", 60), file("b.ts", 60), file("c.ts", 60)]
    const batches = plan(files, { edges: graph([["a.ts", "c.ts"], ["c.ts", "b.ts"]]) })
    expect(paths(batches)).toEqual([["a.ts"], ["c.ts"], ["b.ts"]])
    const large = plan([file("big.ts", 900), file("next.ts", 30)], { segmentCost: bytesCost, budget: 150 })
    const order = paths(large).flat()
    expect(order.filter((path) => path === "big.ts").length).toBeGreaterThan(2)
    expect(order.at(-1)).toBe("next.ts")
    expect(order.indexOf("next.ts")).toBe(order.length - 1)
    for (const batch of large) {
      expect(batch.changed.reduce((sum, segment) => sum + bytesCost(segment), 0)).toBeLessThanOrEqual(150)
    }
  })

  it("adds related files round-robin until the budget is spent and names the omitted ones", () => {
    const related = new Map([
      ["a.ts", ["dep-a1.ts", "dep-a2.ts", "b.ts"]],
      ["b.ts", ["dep-b1.ts"]]
    ])
    const [batch] = plan([file("a.ts", 30), file("b.ts", 30)], {
      related,
      relatedCost: (path) => path === "dep-a2.ts" ? Number.POSITIVE_INFINITY : 15
    })
    expect(batch!.related).toEqual(["dep-a1.ts", "dep-b1.ts"])
    expect(batch!.omittedRelated).toEqual(["dep-a2.ts"])
  })
})
