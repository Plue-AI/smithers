/**
 * The `TargetIndex` rule: what it keys on, which file action it plans in each
 * mode, how the `lint` verb views a writing declaration, and the bytes
 * `render` produces for the planner-filled rows.
 */
import { describe, expect, it } from "vitest"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as TargetIndex from "../src/TargetIndex.ts"
import { plannedCalls } from "./plan.ts"

const describeInput = (input: { readonly _tag: string; readonly path?: string; readonly pattern?: string }): string =>
  input.pattern ?? input.path ?? input._tag

const rows: ReadonlyArray<TargetIndex.Row> = [
  {
    label: "//:ci",
    package: "",
    name: "ci",
    rule: "GithubCiGen",
    kinds: ["build", "lint"],
    summary: "Regenerate ci.yml.",
    featured: true,
    mode: "check",
    cacheable: true,
    inputs: [{ kind: "file", path: "PACKAGE.ts" }],
    outputs: [".github/workflows/ci.yml"],
    dependencies: [],
    source: { file: "PACKAGE.ts" }
  },
  {
    label: "//apps/api:test",
    package: "apps/api",
    name: "test",
    rule: "Vitest",
    kinds: ["test"],
    cacheable: false,
    inputs: [{ kind: "glob", pattern: "apps/api/test/**/*.test.ts", exclude: [] }],
    outputs: [],
    dependencies: ["//apps/api:lib"],
    source: { file: "apps/api/PACKAGE.ts" }
  }
]

describe("TargetIndex target", () => {
  it("checks by default, keys on the checked-in file, and refuses to plan without the planner's rows", () => {
    const checking = TargetIndex.TargetIndex({})
    const metadata = Target.metadata(checking)
    expect(metadata.attrs).toEqual({ pattern: "//...", output: ".smithers/target-index.json", mode: "check" })
    expect(metadata.kinds).toEqual(["build", "lint"])
    expect(metadata.cacheable).toBe(true)
    expect(metadata.outputs).toEqual({ cwd: ".", paths: [] })
    expect(metadata.inputs.map(describeInput)).toEqual(["//.smithers/target-index.json"])
    expect(plannedCalls(checking).map((call) => call.action)).toEqual(["smithers-build/not-implemented"])
  })

  it("plans a check of the rendered rows once the planner fills them", () => {
    const filled = TargetIndex.TargetIndex({ targets: rows })
    expect(plannedCalls(filled)).toEqual([{
      action: "smithers-build/check-file",
      payload: { path: ".smithers/target-index.json", contents: TargetIndex.render(rows) }
    }])
  })

  it("writes the declared output when asked, uncached, and names the file it owns", () => {
    const writing = TargetIndex.TargetIndex({ mode: "write", output: "//meta/targets.json", targets: rows })
    const metadata = Target.metadata(writing)
    expect(metadata.cacheable).toBe(false)
    // The rows' own inputs stay row data: a tagged `Input.Declared` inside
    // attrs would become an input of this target, keying the index on every
    // file every listed target reads.
    expect(metadata.inputs).toEqual([])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["meta/targets.json"] })
    expect(plannedCalls(writing)).toEqual([{
      action: "smithers-build/write-file",
      payload: { path: "meta/targets.json", contents: TargetIndex.render(rows) }
    }])
  })

  it("forces the non-writing view under the lint verb and keeps build as declared", () => {
    const metadata = Target.metadata(TargetIndex.TargetIndex({ mode: "write" }))
    expect((metadata.forKind("lint").attrs as TargetIndex.Attrs).mode).toBe("check")
    expect((metadata.forKind("build").attrs as TargetIndex.Attrs).mode).toBe("write")
  })

  it("renders two-space JSON with one trailing newline and the rows in the order given", () => {
    const text = TargetIndex.render(rows)
    expect(text.endsWith("]\n")).toBe(true)
    expect(text.endsWith("\n\n")).toBe(false)
    expect(JSON.parse(text)).toEqual(rows)
    expect(text.indexOf("\"//:ci\"")).toBeLessThan(text.indexOf("\"//apps/api:test\""))
    expect(TargetIndex.render(rows)).toBe(text)
  })

  it("keeps the rows' inputs out of the check target's own inputs", () => {
    const checking = TargetIndex.TargetIndex({ targets: rows })
    expect(Target.metadata(checking).inputs.map(describeInput)).toEqual(["//.smithers/target-index.json"])
  })

  it("records a validation gate as a target dependency", () => {
    const gate = Shell.Test({ shell: "true" })
    const indexed = TargetIndex.TargetIndex({ gates: [gate] })
    expect(Target.metadata(indexed).dependencies).toContain(gate)
    expect((Target.metadata(indexed).attrs as TargetIndex.Attrs).gates).toEqual([gate])
  })

  it("refuses rows that are not the index's row shape", () => {
    expect(() => TargetIndex.TargetIndex({ targets: [{ label: "//:x" }] as never })).toThrow()
    expect(() =>
      TargetIndex.TargetIndex({
        targets: [{ ...rows[0]!, inputs: [{ _tag: "File", path: "PACKAGE.ts" }] }] as never
      })
    ).toThrow()
    expect(() => TargetIndex.TargetIndex({ mode: "sometimes" as never })).toThrow()
  })
})
