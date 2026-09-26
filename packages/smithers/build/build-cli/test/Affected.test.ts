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
  view?: Partial<Target.KindView>
): Target.AnyTarget =>
  ({
    inputs,
    dependencies,
    dependencySelectors: [],
    kinds: view === undefined ? [] : ["build"],
    forKind: () => {
      calls.views++
      return { inputs: [], dependencies: [], dependencySelectors: [], ...view }
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
  "preserves ambient input selection for $_tag",
  (input) => {
    const { add, index } = fixture()
    add("app", "build", target([input]))
    expect(Affected.select(index, ["//..."], ["unknown/file.ts"])).toMatchObject({
      conservative: false,
      targets: [{ label: "//app:build", reasons: ["unknown/file.ts"] }]
    })
  }
)

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
