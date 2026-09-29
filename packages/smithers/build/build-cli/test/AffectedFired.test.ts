/**
 * `affected` never passes green on a gate that did not run: a diff no target
 * gates is red, and a target the planner leaves out of a wildcard by policy is
 * named rather than passed off as run.
 */
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
    expect(result.logs).toContain("Affected but not run here: //:there")
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
    expect(result.logs).toContain("Affected but not run here: //:there")
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
