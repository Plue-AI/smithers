/**
 * `affected` never passes green on a gate that did not run: a diff no target
 * gates is red, and a target the planner leaves out of a wildcard by policy is
 * named rather than passed off as run.
 */
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const workspace = async (targets: string) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-affected-fired-")))
  await write(root, "package.json", JSON.stringify({ name: "fired", private: true, packageManager: "pnpm@11.25.0" }))
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\n${targets}\n`)
  return root
}

const elsewhere = process.platform === "win32" ? "linux" : "win32"

it("affected list explains an unrelated catalog test's incomplete input contract", async () => {
  const root = await workspace("export const Package = S.Package({ targets: {} })")
  try {
    await write(
      root,
      "packages/changed/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { sources: S.Filegroup({ srcs: [S.glob("src/**")] }) } })`
    )
    await write(
      root,
      "packages/other/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { test: S.Vitest({
  tests: [S.glob("test/**/*.test.ts")], sources: [S.glob("src/**")], deps: [],
  config: null, environment: "node", passWithNoTests: false, cwd: "packages/other"
}) } })`
    )
    const listed = await serve(root, [
      "affected",
      "test",
      "//...",
      "--files",
      "packages/changed/src/a.ts",
      "--list",
      "--json"
    ])
    expect(listed.exitCode, listed.output + listed.logs).toBe(0)
    expect(JSON.parse(listed.output)).toMatchObject({
      conservative: false,
      globalInputs: [],
      targets: [{
        label: "//packages/other:test",
        reasons: ["packages/changed/src/a.ts"],
        reasonDetails: [{
          file: "packages/changed/src/a.ts",
          kind: "uncacheable",
          label: "//packages/other:test",
          rule: "Vitest",
          dependencyPath: ["//packages/other:test"]
        }]
      }]
    })
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("affected list retains shared workspace causes alongside an uncacheable catalog cause", async () => {
  const root = await workspace(`export const Package = S.Package({ targets: {
  workspace: S.Lockfile({ manifests: [S.pnpmWorkspace("//pnpm-workspace.yaml")], lockfilePath: "pnpm-lock.yaml" })
} })`)
  try {
    await write(
      root,
      "packages/changed/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { sources: S.Filegroup({ srcs: [S.glob("src/**")] }) } })`
    )
    await write(
      root,
      "packages/other/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../../PACKAGE.ts"
export const Package = S.Package({ targets: { test: S.Vitest({
  tests: [S.glob("test/**/*.test.ts")], sources: [S.glob("src/**")], deps: [root.workspace],
  config: null, environment: "node", passWithNoTests: false, cwd: "packages/other"
}) } })`
    )
    const listed = await serve(root, [
      "affected",
      "test",
      "//...",
      "--files",
      "packages/changed/src/a.ts",
      "--list",
      "--json"
    ])
    expect(listed.exitCode, listed.output + listed.logs).toBe(0)
    const output = JSON.parse(listed.output)
    expect(output).toMatchObject({ conservative: false, globalInputs: [] })
    expect(output.targets).toHaveLength(1)
    expect(output.targets[0].reasonDetails).toEqual(expect.arrayContaining([
      {
        file: "packages/changed/src/a.ts",
        kind: "uncacheable",
        label: "//packages/other:test",
        rule: "Vitest",
        dependencyPath: ["//packages/other:test"]
      },
      {
        file: "packages/changed/src/a.ts",
        kind: "ambient-input",
        label: "//:workspace",
        rule: "Lockfile",
        input: { _tag: "PnpmWorkspace", path: "//pnpm-workspace.yaml" },
        dependencyPath: ["//packages/other:test", "//:workspace"]
      }
    ]))
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

/** A known-path diff selects part of a wildcard and reaches an exclusive test. */
const partialExclusiveWorkspace = async () => {
  const root = await workspace("export const Package = S.Package({ targets: {} })")
  await write(root, ".gitignore", "node_modules/\n.flows/\n")
  await write(root, "pnpm-workspace.yaml", "packages:\n  - packages/dependency\nverifyDepsBeforeRun: false\n")
  await write(root, "packages/dependency/package.json", JSON.stringify({ name: "exclusive-fixture", private: true }))
  await write(
    root,
    "packages/dependency/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const exclusive = S.Vitest({
  tests: [S.file("exclusive.test.ts")],
  sources: [S.file("//packages/affected/src/a.txt"), S.file("//pnpm-workspace.yaml")],
  deps: [], config: S.file("vitest.config.ts"), environment: "node", passWithNoTests: false,
  coverage: false, exclusive: true, cwd: "packages/dependency"
})
export const Package = S.Package({ targets: { exclusive } })
`
  )
  await write(root, "packages/dependency/vitest.config.ts", "export default { test: { maxWorkers: 1 } }\n")
  await write(
    root,
    "packages/dependency/exclusive.test.ts",
    "import { expect, it } from \"vitest\"\nit(\"runs the exclusive dependency\", () => expect(1).toBe(1))\n"
  )
  await write(
    root,
    "packages/affected/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
import { Package as dependency } from "../dependency/PACKAGE.ts"
export const Package = S.Package({ targets: {
  ordinary: S.Suite({ tests: [dependency.exclusive] }),
  safe: S.Shell.Test({ shell: "true", sandbox: "none", data: [S.file("src/a.txt")] })
} })
`
  )
  await write(
    root,
    "packages/unaffected/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  safe: S.Shell.Test({ shell: "true", sandbox: "none", data: [S.file("src/a.txt")] })
} })
`
  )
  await write(root, "packages/affected/src/a.txt", "before\n")
  await write(root, "packages/unaffected/src/a.txt", "unchanged\n")
  const git = (...args: ReadonlyArray<string>) => ChildProcess.execFileSync("git", ["-C", root, ...args])
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  await write(root, "packages/affected/src/a.txt", "after\n")
  return root
}

const linkTestModules = async (root: string) => {
  // The runner lives in the package tree; its pnpm dependency links reach the root store.
  await Fs.symlink(
    Path.resolve(import.meta.dirname, "../../../../../node_modules"),
    Path.join(root, "node_modules"),
    "dir"
  )
  await Fs.symlink(
    Path.resolve(import.meta.dirname, "../node_modules"),
    Path.join(root, "packages/dependency/node_modules"),
    "dir"
  )
}

it.each(["test", "ci"])("affected %s preserves a partial wildcard's exclusive dependency refusal", async (verb) => {
  const root = await partialExclusiveWorkspace()
  try {
    const listed = await serve(root, ["affected", verb, "//...", "--list", "--json"])
    expect(listed.exitCode, listed.output + listed.logs).toBe(0)
    expect(JSON.parse(listed.output)).toMatchObject({
      files: ["packages/affected/src/a.txt"],
      conservative: false,
      targets: [{ label: "//packages/affected:ordinary" }, { label: "//packages/affected:safe" }],
      omitted: ["//packages/dependency:exclusive"]
    })
    for (const flags of [["--plan"], ["--no-cache"]]) {
      const result = await serve(root, ["affected", verb, "//...", ...flags, "--json"])
      expect(result.exitCode, result.output + result.logs).toBe(1)
      expect(result.output).toContain("wildcard selection reaches exclusive dependency //packages/dependency:exclusive")
      expect(result.output).toContain("--include-exclusive")
      expect(result.output).not.toContain("\"counts\"")
      expect(result.logs).toContain("Selected, not run: //packages/dependency:exclusive")
    }
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it.each(["test", "ci"])(
  "affected %s opts a partial wildcard into exclusive roots without unrelated work",
  async (verb) => {
    const root = await partialExclusiveWorkspace()
    try {
      const result = await serve(root, ["affected", verb, "//...", "--include-exclusive", "--plan", "--json"])
      expect(result.exitCode, result.output + result.logs).toBe(0)
      const plan = JSON.parse(result.output) as {
        roots: ReadonlyArray<string>
        targets: ReadonlyArray<{ label: string }>
      }
      expect([...plan.roots].sort()).toEqual([
        "//packages/affected:ordinary",
        "//packages/affected:safe",
        "//packages/dependency:exclusive"
      ])
      expect(plan.targets.map((target) => target.label).sort()).toEqual([...plan.roots].sort())
      expect(result.logs).not.toContain("Selected, not run")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }
)

it("affected keeps named-root authorization scoped to the patterns that selected each root", async () => {
  const root = await partialExclusiveWorkspace()
  try {
    for (
      const patterns of [
        ["//packages/affected:ordinary", "//packages/unaffected/..."],
        ["//packages/...:ordinary"],
        ["//...", "//packages/dependency:exclusive"]
      ]
    ) {
      const result = await serve(root, ["affected", "test", ...patterns, "--plan", "--json"])
      expect(result.exitCode, result.output + result.logs).toBe(0)
      expect(result.output).toContain("//packages/dependency:exclusive")
      expect(result.output).not.toContain("//packages/unaffected:safe")
    }
    const overlapping = await serve(root, [
      "affected",
      "test",
      "//...",
      "//packages/affected:ordinary",
      "--plan",
      "--json"
    ])
    expect(overlapping.exitCode, overlapping.output + overlapping.logs).toBe(1)
    expect(overlapping.output).toContain("wildcard selection reaches exclusive dependency")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("affected does not report an exclusive dependency that ran through a named root as omitted", async () => {
  const root = await partialExclusiveWorkspace()
  try {
    await linkTestModules(root)
    const result = await serve(root, [
      "affected",
      "test",
      "//packages/affected:ordinary",
      "//packages/dependency/...",
      "--no-cache",
      "--json"
    ])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    const summary = JSON.parse(result.output) as { results: ReadonlyArray<{ label: string; status: string }> }
    expect(summary.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "//packages/dependency:exclusive", status: "ran" }),
      expect.objectContaining({ label: "//packages/affected:ordinary", status: "ran" })
    ]))
    expect(result.logs).not.toContain("Selected, not run")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it.each(["failed", "skipped"])("affected reports an exclusive dependency's %s execution accurately", async (status) => {
  const root = await partialExclusiveWorkspace()
  try {
    await linkTestModules(root)
    if (status === "failed") {
      await write(
        root,
        "packages/dependency/exclusive.test.ts",
        "import { expect, it } from \"vitest\"\nit(\"fails the exclusive dependency\", () => expect(1).toBe(2))\n"
      )
    } else {
      const declaration = await Fs.readFile(Path.join(root, "packages/dependency/PACKAGE.ts"), "utf8")
      await write(
        root,
        "packages/dependency/PACKAGE.ts",
        declaration.replace("deps: []", "deps: [S.Shell.Test({ shell: \"false\", sandbox: \"none\" })]")
      )
    }
    const result = await serve(root, [
      "affected",
      "test",
      "//packages/affected:ordinary",
      "//packages/dependency/...",
      "--files",
      "packages/affected/src/a.txt",
      "--no-cache",
      "--json"
    ])
    expect(result.exitCode, result.output + result.logs).toBe(1)
    expect(result.logs).toContain(`//packages/dependency:exclusive  ${status}`)
    if (status === "failed") expect(result.logs).toContain("expected 1 to be 2")
    expect(result.logs.includes("Selected, not run: //packages/dependency:exclusive")).toBe(
      status === "skipped"
    )
    expect(result.output).toContain("targets_failed")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("runs what it can on a conservative diff and names the target the wildcard leaves out, green", async () => {
  const root = await workspace(`export const Package = S.Package({ targets: {
  here: S.Shell.Test({ shell: "true", sandbox: "none" }),
  there: S.Shell.Test({ shell: "true", sandbox: "none", hosts: [${JSON.stringify(elsewhere)}] })
} })`)
  try {
    const result = await serve(root, [
      "affected",
      "test",
      "//...",
      "--files",
      "package.json",
      "--no-cache",
      "--jobs",
      "1"
    ])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(result.logs).toContain("//:here  ran")
    expect(result.logs).toContain("Selected, not run: //:there")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("leaves out another host's target on a precise diff too, instead of failing the plan", async () => {
  const root = await workspace(`export const Package = S.Package({ targets: {
  here: S.Shell.Test({ shell: "true", sandbox: "none", data: [S.glob("src/**")] }),
  there: S.Shell.Test({ shell: "true", sandbox: "none", data: [S.glob("src/**")], hosts: [${
    JSON.stringify(elsewhere)
  }] })
} })`)
  try {
    await write(root, "src/a.txt", "a\n")
    const listed = await serve(root, ["affected", "test", "//...", "--files", "src/a.txt", "--list", "--json"])
    expect(JSON.parse(listed.output)).toMatchObject({
      conservative: false,
      targets: [{ label: "//:here" }],
      omitted: ["//:there"]
    })
    const result = await serve(root, ["affected", "test", "//...", "--files", "src/a.txt", "--no-cache", "--jobs", "1"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(result.logs).toContain("//:here  ran")
    expect(result.logs).toContain("Selected, not run: //:there")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("is red when changed files meet patterns that name no target, and still lists and plans", async () => {
  const root = await workspace("export const Package = S.Package({ targets: {} })")
  try {
    const listed = await serve(root, ["affected", "test", "//...", "--files", "notes.md", "--list"])
    expect(listed.exitCode, listed.output + listed.logs).toBe(0)
    const planned = await serve(root, ["affected", "test", "//...", "--files", "notes.md", "--plan"])
    expect(planned.exitCode, planned.output + planned.logs).toBe(0)
    const result = await serve(root, ["affected", "test", "//...", "--files", "notes.md", "--no-cache"])
    expect(result.exitCode).not.toBe(0)
    expect(result.output + result.logs).toContain("1 changed files met patterns that name no target, so no gate ran")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("is red for a real diff when the patterns name no target in a graph that has some", async () => {
  const root = await workspace(`export const Package = S.Package({ targets: {
  here: S.Shell.Test({ shell: "true", sandbox: "none" })
} })`)
  try {
    const result = await serve(root, ["affected", "test", "//gone/...", "--files", "notes.md", "--no-cache"])
    expect(result.exitCode).not.toBe(0)
    expect(result.output + result.logs).toContain("met patterns that name no target")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("keeps a target a named pattern also selects, even where a bare wildcard would leave it out", async () => {
  const root = await workspace(`export const Package = S.Package({ targets: {
  here: S.Shell.Test({ shell: "true", sandbox: "none", data: [S.glob("src/**")] }),
  there: S.Shell.Test({ shell: "true", sandbox: "none", data: [S.glob("src/**")], hosts: [${
    JSON.stringify(elsewhere)
  }] })
} })`)
  try {
    await write(root, "src/a.txt", "a\n")
    const listed = await serve(root, [
      "affected",
      "test",
      "//...",
      "//:there",
      "--files",
      "src/a.txt",
      "--list",
      "--json"
    ])
    expect(JSON.parse(listed.output)).toMatchObject({ omitted: [] })
    const mixed = await serve(root, [
      "affected",
      "test",
      "//...",
      "//:here",
      "--files",
      "src/a.txt",
      "--list",
      "--json"
    ])
    expect(JSON.parse(mixed.output)).toMatchObject({ omitted: ["//:there"] })
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("is red when one of several patterns names no target, though another still resolves", async () => {
  const root = await workspace(`export const Package = S.Package({ targets: {
  here: S.Shell.Test({ shell: "true", sandbox: "none" })
} })`)
  try {
    const result = await serve(root, ["affected", "test", "//...", "//gone/...", "--files", "notes.md", "--no-cache"])
    expect(result.exitCode).not.toBe(0)
    expect(result.output + result.logs).toContain("met patterns that name no target")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
