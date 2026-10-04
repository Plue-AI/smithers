import * as Input from "@smthrs/targets/Input"
import type * as Target from "@smthrs/targets/Target"
import { Minimatch } from "minimatch"
import { afterEach, expect, it, vi } from "vitest"
import * as Affected from "../src/Affected.ts"
import type { IndexedTarget, PackageIndex } from "../src/PackageIndex.ts"

// Isolate selection from graph loading, as in the review's performance probe.
const calls = vi.hoisted(() => ({ metadata: 0, views: 0 }))
vi.mock("@smthrs/targets/Target", async (importOriginal) => ({
  ...await importOriginal<typeof Target>(),
  metadata: (target: unknown) => {
    calls.metadata++
    return target
  }
}))
vi.mock("../src/Planner.ts", () => ({ productionSourceRoots: () => [] }))
afterEach(() => vi.restoreAllMocks())

const target = (
  inputs: ReadonlyArray<Input.Declared> = [],
  dependencies: ReadonlyArray<Target.AnyTarget> = [],
  view?: Partial<Target.KindView>,
  cacheable = true
): Target.AnyTarget =>
  ({
    target: "Fixture",
    inputs,
    dependencies,
    dependencySelectors: [],
    cacheable,
    kinds: view === undefined ? [] : ["build"],
    forKind: () => {
      calls.views++
      return { inputs: [], dependencies: [], dependencySelectors: [], cacheable: true, ...view }
    }
  }) as unknown as Target.AnyTarget

const fixture = () => {
  const rows: Array<IndexedTarget> = []
  const owners = new Map<Target.AnyTarget, string>()
  const resolve = vi.fn((pattern: string) =>
    pattern === "//..." ? rows : rows.filter((row) => row.label === pattern.replace("/...", ""))
  )
  return {
    rows,
    owners,
    resolve,
    add: (packagePath: string, key: string, value: Target.AnyTarget) => {
      rows.push({ label: `//${packagePath}:${key}`, packagePath, key, target: value })
      owners.set(value, packagePath)
      return value
    },
    index: {
      root: "/probe/root",
      targets: () => rows,
      resolve,
      ownerOf: (value: Target.AnyTarget) => owners.get(value)
    } as unknown as PackageIndex
  }
}

it("explains shared ambient selection through private dependencies without claiming input ownership", () => {
  const { add, index, owners } = fixture()
  const workspace = add("", "workspace", target([Input.pnpmWorkspace("//pnpm-workspace.yaml")], [], undefined, false))
  const privateTarget = {
    ...target([Input.file("local.txt")], [workspace]),
    target: "Filegroup",
    attrs: { cwd: "." }
  } as Target.AnyTarget
  owners.set(privateTarget, "other")
  add("other", "test", target([Input.file("local.txt")], [privateTarget]))
  add("lib", "src", target([Input.glob("src/**/*.ts")]))
  const selected = Affected.select(index, ["//other:test"], ["lib/src/a.ts"], { explain: true })
  expect(selected).toMatchObject({
    conservative: false,
    globalInputs: [],
    targets: [{
      label: "//other:test",
      reasons: ["lib/src/a.ts"],
      reasonDetails: [{
        file: "lib/src/a.ts",
        kind: "ambient-input",
        label: "//:workspace",
        rule: "Fixture",
        input: Input.pnpmWorkspace("//pnpm-workspace.yaml"),
        dependencyPath: ["//other:test", "//other:__private_Filegroup_1", "//:workspace"]
      }, {
        file: "lib/src/a.ts",
        kind: "uncacheable",
        label: "//:workspace",
        rule: "Fixture",
        dependencyPath: ["//other:test", "//other:__private_Filegroup_1", "//:workspace"]
      }]
    }]
  })
  expect(Affected.select(index, ["//other:test"], ["lib/src/a.ts"]).targets).toEqual([
    { label: "//other:test", reasons: ["lib/src/a.ts"] }
  ])
})

it("preserves owned, declared unowned, and multi-root reasons including excludes and dotfiles", () => {
  const { add, index } = fixture()
  const lib = add("lib", "src", target([Input.glob("src/**/*.ts")]))
  const shared = Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
  add("app", "build", target([shared, Input.file("//assets/schema.txt")], [lib]))
  add("tools", "check", target([Input.file("local.txt")], [], { dependencies: [lib] }))
  const paths = ["shared/.hidden.ts", "./lib/new.txt", "assets/schema.txt", "lib\\new.txt"]
  expect(Affected.select(index, ["//..."], paths)).toEqual({
    pattern: "//...",
    files: ["assets/schema.txt", "lib/new.txt", "shared/.hidden.ts"],
    conservative: false,
    globalInputs: [],
    targets: [
      { label: "//lib:src", reasons: ["lib/new.txt"] },
      { label: "//app:build", reasons: ["assets/schema.txt", "lib/new.txt", "shared/.hidden.ts"] },
      { label: "//tools:check", reasons: ["lib/new.txt"] }
    ]
  })
  for (const path of ["scripts/unknown.ts", "shared/generated/code.ts", "pnpm-lock.yaml"]) {
    expect(Affected.select(index, ["//..."], ["lib/new.txt", path])).toEqual({
      pattern: "//...",
      files: ["lib/new.txt", path].sort(),
      conservative: true,
      globalInputs: [path],
      targets: ["//lib:src", "//app:build", "//tools:check"].map((label) => ({ label, reasons: [path] }))
    })
  }
  expect(Affected.select(index, ["//..."], []).targets).toEqual([])
})

it("does not select a glob consumer for an excluded path owned by another package", () => {
  const { add, index } = fixture()
  add("app", "build", target([Input.glob("//shared/**", { exclude: ["//shared/generated/**"] })]))
  add("shared", "src", target([Input.glob("**/*")]))
  expect(Affected.select(index, ["//..."], ["shared/generated/a.ts"])).toMatchObject({
    conservative: false,
    targets: [{ label: "//shared:src", reasons: ["shared/generated/a.ts"] }]
  })
})

it("keeps verb-only inputs unowned and empty base declarations conservative", () => {
  const { add, index } = fixture()
  add("app", "build", target([Input.file("local.txt")], [], { inputs: [Input.glob("//shared/**")] }))
  add("empty", "build", target([], [], { inputs: [Input.file("local.txt")] }))
  expect(Affected.select(index, ["//..."], ["shared/file.ts"]).conservative).toBe(true)
  expect(Affected.select(index, ["//..."], ["app/source.ts"]).targets).toEqual([
    { label: "//app:build", reasons: ["app/source.ts"] },
    { label: "//empty:build", reasons: ["app/source.ts"] }
  ])
})

it.each([Input.gitDiff(), Input.pnpmWorkspace("//pnpm-workspace.yaml")])(
  "preserves ambient $_tag selection for owned files without selecting unrelated targets",
  (input) => {
    const { add, index } = fixture()
    add("", "workspace", target([input]))
    add("app", "build", target([Input.glob("src/**/*.ts", { exclude: ["src/generated/**"] })]))
    add(
      "tools",
      "check",
      target([
        Input.file("//assets/schema.txt"),
        Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
      ])
    )
    add("other", "build", target([Input.file("local.txt")]))
    const paths = ["app/src/generated/code.ts", "assets/schema.txt", "shared/.hidden.ts"]
    expect(Affected.select(index, ["//..."], paths)).toEqual({
      pattern: "//...",
      files: paths,
      conservative: false,
      globalInputs: [],
      targets: [
        { label: "//:workspace", reasons: paths },
        { label: "//app:build", reasons: [paths[0]] },
        { label: "//tools:check", reasons: paths.slice(1) }
      ]
    })
    expect(Affected.select(index, ["//..."], []).targets).toEqual([])
  }
)

it.each([Input.gitDiff(), Input.pnpmWorkspace("//pnpm-workspace.yaml")])(
  "does not let ambient $_tag inputs claim unknown paths or excluded and adjacent inputs",
  (input) => {
    const { add, index } = fixture()
    add("", "workspace", target([input]))
    add("app", "build", target([Input.file("//assets/schema.txt")]))
    add(
      "tools",
      "check",
      target([
        Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
      ])
    )
    for (
      const path of [
        ".github/ci-known-red.json",
        "application/src/file.ts",
        "assets/schema.txt.bak",
        "shared/generated/code.ts"
      ]
    ) {
      expect(Affected.select(index, ["//..."], ["app/source.ts", path])).toEqual({
        pattern: "//...",
        files: ["app/source.ts", path].sort(),
        conservative: true,
        globalInputs: [path],
        targets: ["//:workspace", "//app:build", "//tools:check"].map((label) => ({ label, reasons: [path] }))
      })
      expect(Affected.select(index, ["//tools:check"], [path])).toMatchObject({
        conservative: true,
        targets: [{ label: "//tools:check", reasons: [path] }]
      })
    }
  }
)

it.each([Input.gitDiff(), Input.pnpmWorkspace("//pnpm-workspace.yaml")])(
  "selects verb-only ambient $_tag consumers for known paths without assigning ownership",
  (input) => {
    const { add, index } = fixture()
    add("app", "build", target([Input.file("local.txt")], [], { inputs: [input] }))
    add("lib", "src", target([Input.glob("src/**/*.ts")]))
    add("other", "build", target([Input.file("local.txt")]))
    expect(Affected.select(index, ["//..."], ["lib/new.txt"])).toMatchObject({
      conservative: false,
      targets: [
        { label: "//app:build", reasons: ["lib/new.txt"] },
        { label: "//lib:src", reasons: ["lib/new.txt"] }
      ]
    })
    expect(Affected.select(index, ["//..."], [".github/ci-known-red.json"])).toMatchObject({
      conservative: true,
      globalInputs: [".github/ci-known-red.json"],
      targets: ["//app:build", "//lib:src", "//other:build"].map((label) => ({
        label,
        reasons: [".github/ci-known-red.json"]
      }))
    })
  }
)

it("selects uncacheable targets and their dependents for every change, since their inputs are incomplete", () => {
  const { add, index } = fixture()
  add("lib", "src", target([Input.glob("src/**/*.ts")]))
  const check = add("app", "check", target([Input.file("local.txt")], [], undefined, false))
  add("app", "bundle", target([Input.file("entry.ts")], [check]))
  add("tools", "test", target([Input.file("local.txt")], [], { cacheable: false }))
  add("other", "build", target([Input.file("local.txt")]))
  // A native rule that adds its own cache key keeps declared-input narrowing.
  add(
    "go",
    "test",
    { ...target([Input.file("local.txt")], [], undefined, false), target: "Go.Test" } as Target.AnyTarget
  )
  const paths = ["lib/src/a.ts"]
  expect(Affected.select(index, ["//..."], paths)).toEqual({
    pattern: "//...",
    files: paths,
    conservative: false,
    globalInputs: [],
    targets: ["//lib:src", "//app:check", "//app:bundle", "//tools:test"].map((label) => ({ label, reasons: paths }))
  })
  expect(Affected.select(index, ["//other:build"], paths).targets).toEqual([])
  expect(Affected.select(index, ["//..."], []).targets).toEqual([])
})

it("propagates through shared private, verb, selector and cyclic dependencies", () => {
  const { add, index, owners, resolve } = fixture()
  const edges: Array<Target.AnyTarget> = []
  const privateTarget = target([Input.file("//lib/data.txt")], edges)
  owners.set(privateTarget, "lib")
  const first = add("first", "build", target([Input.file("local.txt")], [privateTarget]))
  add("second", "build", target([Input.file("local.txt")], [], { dependencies: [privateTarget] }))
  add(
    "selector",
    "build",
    target([Input.file("local.txt")], [], {
      dependencySelectors: [{ _tag: "TargetDependencySelector", pattern: "//first/...", target: "build" }]
    })
  )
  add("lib", "src", target([Input.file("data.txt")]))
  edges.push(first)
  const paths = ["lib/data.txt", "lib/new.txt"]
  expect(Affected.select(index, ["//..."], paths).targets).toEqual([
    { label: "//first:build", reasons: paths },
    { label: "//second:build", reasons: paths },
    { label: "//selector:build", reasons: paths },
    { label: "//lib:src", reasons: paths }
  ])
  expect(Affected.select(index, ["//second:build"], paths).targets).toEqual([
    { label: "//second:build", reasons: paths }
  ])
  expect(resolve).toHaveBeenCalledWith("//first/...:build")
  const explained = Affected.select(index, ["//selector:build"], ["lib/data.txt"], { explain: true })
  expect(explained.targets[0]!.reasonDetails).toEqual([
    {
      file: "lib/data.txt",
      kind: "declared-input",
      label: "//lib:__private_Fixture_1",
      rule: "Fixture",
      input: Input.file("//lib/data.txt"),
      dependencyPath: ["//selector:build", "//first:build", "//lib:__private_Fixture_1"]
    },
    {
      file: "lib/data.txt",
      kind: "package",
      label: "//lib:__private_Fixture_1",
      rule: "Fixture",
      dependencyPath: ["//selector:build", "//first:build", "//lib:__private_Fixture_1"]
    }
  ])
})

it("explains global and unknown fallbacks without inventing a dependency route", () => {
  const { add, index } = fixture()
  add("app", "test", target([Input.file("local.txt")]))
  for (const [file, kind] of [["pnpm-lock.yaml", "global-input"], ["unowned/a.txt", "unknown-input"]]) {
    expect(Affected.select(index, ["//..."], [file!], { explain: true }).targets[0]!.reasonDetails).toEqual([
      { file, kind }
    ])
  }
  expect(Affected.select(index, ["//..."], [], { explain: true }).targets).toEqual([])
})

it.each(
  [
    [Input.gitDiff(), false],
    [Input.gitDiff(), true],
    [Input.pnpmWorkspace("//pnpm-workspace.yaml"), false],
    [Input.pnpmWorkspace("//pnpm-workspace.yaml"), true]
  ] as const
)("explains ambient $_tag declarations in base and verb views (%s)", (input, verbOnly) => {
  const { add, index } = fixture()
  add("lib", "src", target([Input.glob("src/**")]))
  add(
    "app",
    "test",
    target(
      verbOnly ? [Input.file("local.txt")] : [input],
      [],
      verbOnly ? { inputs: [input] } : undefined
    )
  )
  expect(Affected.select(index, ["//app:test"], ["lib/src/a.ts"], { explain: true }).targets[0]!.reasonDetails).toEqual(
    [
      {
        file: "lib/src/a.ts",
        kind: "ambient-input",
        label: "//app:test",
        rule: "Fixture",
        input,
        dependencyPath: ["//app:test"]
      }
    ]
  )
})

it("distinguishes declared inputs, package membership, empty contracts and verb-only uncacheability", () => {
  const { add, index } = fixture()
  add("app", "test", target([Input.file("//assets/schema.txt")]))
  add("empty", "test", target())
  add("verb", "test", target([Input.file("local.txt")], [], { cacheable: false }))
  add(
    "go",
    "test",
    { ...target([Input.file("local.txt")], [], undefined, false), target: "Go.Test" } as Target.AnyTarget
  )
  const paths = ["app/src/a.ts", "assets/schema.txt"]
  const selected = Affected.select(index, ["//..."], paths, { explain: true })
  expect(selected.targets.map((row) => row.label)).toEqual(["//app:test", "//empty:test", "//verb:test"])
  expect(selected.targets[0]!.reasonDetails).toEqual([
    { file: paths[0], kind: "package", label: "//app:test", rule: "Fixture", dependencyPath: ["//app:test"] },
    {
      file: paths[1],
      kind: "declared-input",
      label: "//app:test",
      rule: "Fixture",
      input: Input.file("//assets/schema.txt"),
      dependencyPath: ["//app:test"]
    }
  ])
  expect(selected.targets[1]!.reasonDetails).toEqual(paths.map((file) => ({
    file,
    kind: "empty",
    label: "//empty:test",
    rule: "Fixture",
    dependencyPath: ["//empty:test"]
  })))
  expect(selected.targets[2]!.reasonDetails).toEqual(paths.map((file) => ({
    file,
    kind: "uncacheable",
    label: "//verb:test",
    rule: "Fixture",
    dependencyPath: ["//verb:test"]
  })))
})

it("uses one shortest route when an ambient source has shared and cyclic dependency paths", () => {
  const { add, index } = fixture()
  const dependencies: Array<Target.AnyTarget> = []
  const source = add("ambient", "diff", target([Input.gitDiff()], dependencies))
  const intermediate = add("middle", "build", target([Input.file("local.txt")], [source]))
  const root = add("app", "test", target([Input.file("local.txt")], [intermediate, source]))
  dependencies.push(root)
  add("lib", "src", target([Input.glob("src/**")]))
  const paths = ["lib/src/a.ts", "lib/src/b.ts"]
  expect(Affected.select(index, ["//app:test"], paths, { explain: true }).targets[0]!.reasonDetails).toEqual(
    paths.map((file) => ({
      file,
      kind: "ambient-input",
      label: "//ambient:diff",
      rule: "Fixture",
      input: Input.gitDiff(),
      dependencyPath: ["//app:test", "//ambient:diff"]
    }))
  )
})

it("compiles each resolved include and exclude once across ownership and selection", () => {
  const { add, index } = fixture()
  const input = Input.glob("//shared/**/*.ts", { exclude: ["//shared/generated/**"] })
  add("app", "build", target([input], [], { inputs: [input] }))
  add("tools", "build", target([input]))
  const compile = vi.spyOn(Minimatch.prototype, "make")
  expect(Affected.select(index, ["//..."], ["shared/a.ts", "shared/.b.ts"]).targets).toHaveLength(2)
  expect(compile).toHaveBeenCalledTimes(2)
  compile.mockClear()
  Affected.select(index, ["//..."], ["shared/c.ts"])
  expect(compile).toHaveBeenCalledTimes(2)
})

it("indexes 1000 targets once and selects 200 owned paths within a one-second CPU budget", () => {
  const { add, index } = fixture()
  for (let p = 0; p < 250; p++) {
    const owner = `packages/pkg${p}`
    const src = add(
      owner,
      "srcs",
      target([
        Input.glob("src/**/*.ts", { exclude: ["src/generated/**"] }),
        Input.glob("test/**/*.ts"),
        Input.file("package.json")
      ])
    )
    add(owner, "lint", target([Input.file("//eslint.config.js")], [src], { dependencies: [src] }))
    add(owner, "test", target([], [src]))
    add(owner, "build", target([], [src]))
  }
  const paths = Array.from({ length: 200 }, (_, i) => `packages/pkg${i}/src/file${i}.ts`)
  calls.metadata = 0
  calls.views = 0
  // CPU time excludes scheduling delays on shared review/CI machines.
  const start = process.cpuUsage()
  const selection = Affected.select(index, ["//..."], paths)
  const elapsed = process.cpuUsage(start)
  expect(selection.conservative).toBe(false)
  expect(selection.targets).toHaveLength(800)
  expect(selection.targets.every((row) => row.reasons.length === 1)).toBe(true)
  expect(calls.metadata).toBeLessThanOrEqual(1000)
  expect(calls.views).toBeLessThanOrEqual(250)
  expect((elapsed.user + elapsed.system) / 1000).toBeLessThan(1000)
})

it("calls changed files silent when any pattern names no target", () => {
  expect(Affected.silent(["a.ts"], [0])).toBe(true)
  expect(Affected.silent(["a.ts"], [3, 0])).toBe(true)
  expect(Affected.silent([], [0])).toBe(false)
  expect(Affected.silent(["a.ts"], [1, 2])).toBe(false)
})

it("never selects nothing for a real diff over a graph with targets, owned or not", () => {
  const graph = fixture()
  graph.add("pkg", "lint", target([Input.glob("src/**/*.ts")]))
  const owned = Affected.select(graph.index, ["//..."], ["pkg/src/a.ts"])
  expect(owned).toMatchObject({ conservative: false, targets: [{ label: "//pkg:lint" }] })
  expect(Affected.select(graph.index, ["//..."], ["elsewhere/b.ts"])).toMatchObject({
    conservative: true,
    targets: [{ label: "//pkg:lint" }]
  })
})

it("names every label the summary holds no record of", () => {
  const summary = { results: [{ label: "//a:test" }, { label: "//b:test" }] }
  expect(Affected.unrecorded(["//a:test", "//b:test"], summary)).toEqual([])
  expect(Affected.unrecorded(["//a:test", "//c:test", "//d:test"], summary)).toEqual(["//c:test", "//d:test"])
  expect(Affected.unrecorded([], { results: [] })).toEqual([])
})

it("turns a selected gate skipped without a failure at the end of its chain red, keeping its reason and results", () => {
  const rows = [
    { label: "//a:review", status: "skipped", error: "the codex CLI is not installed" },
    { label: "//b:test", status: "skipped", blockedBy: "//a:review" },
    { label: "//d:test", status: "ran" },
    { label: "//e:dep", status: "skipped" }
  ]
  const green = { ok: true, counts: { hit: 0, ran: 1, failed: 0, skipped: 3 }, results: rows }
  const red = Affected.unskipped(["//a:review", "//b:test", "//d:test"], green)
  expect(red.ok).toBe(false)
  expect(red.counts).toEqual({ hit: 0, ran: 1, failed: 2, skipped: 1 })
  expect(red.results.map((row) => [row.label, row.status])).toEqual([
    ["//a:review", "failed"],
    ["//b:test", "failed"],
    ["//d:test", "ran"],
    ["//e:dep", "skipped"]
  ])
  expect(red.results[0]!.error).toBe("skipped without running: the codex CLI is not installed")
  // Something else failed (a known red, say). A skip whose chain ends at that failure is its shadow;
  // an unblocked skip, or one behind an unselected dependency's own skip, is still red.
  const failing = {
    ok: false,
    counts: { hit: 0, ran: 0, failed: 1, skipped: 4 },
    results: [
      { label: "//k:test", status: "failed", error: "known" },
      { label: "//a:review", status: "skipped", error: "the codex CLI is not installed" },
      { label: "//c:test", status: "skipped", blockedBy: "//k:test" },
      { label: "//d:review", status: "skipped", error: "the codex CLI is not installed" },
      { label: "//x:alias", status: "skipped", blockedBy: "//d:review" }
    ]
  }
  const still = Affected.unskipped(["//k:test", "//a:review", "//c:test", "//x:alias"], failing)
  expect(still.results.map((row) => [row.label, row.status])).toEqual([
    ["//k:test", "failed"],
    ["//a:review", "failed"],
    ["//c:test", "skipped"],
    ["//d:review", "skipped"],
    ["//x:alias", "failed"]
  ])
  expect(still.counts).toEqual({ hit: 0, ran: 0, failed: 3, skipped: 2 })
  // A chain that loops never counts as a failure's shadow.
  const loop = {
    ok: true,
    counts: { hit: 0, ran: 0, failed: 0, skipped: 2 },
    results: [
      { label: "//p:test", status: "skipped", blockedBy: "//q:test" },
      { label: "//q:test", status: "skipped", blockedBy: "//p:test" }
    ]
  }
  expect(Affected.unskipped(["//p:test"], loop).results[0]!.status).toBe("failed")
  // A summary with no such skip is returned as it was.
  expect(Affected.unskipped(["//d:test"], green)).toBe(green)
})

 it("requires a successful base receipt for an empty affected verdict and never accepts an empty diff", () => {
   expect(Affected.needsFullGate(undefined, ["pkg/a.ts"], 0, false)).toBe(true)
   expect(Affected.needsFullGate("a".repeat(40), [], 12, true)).toBe(true)
   expect(Affected.needsFullGate("a".repeat(40), ["pkg/a.ts"], 0, false)).toBe(true)
   expect(Affected.needsFullGate("a".repeat(40), ["pkg/a.ts"], 0, true)).toBe(false)
   expect(Affected.needsFullGate("a".repeat(40), ["pkg/a.ts"], 2, false)).toBe(false)
 })
