import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { submoduleSourcesVariable } from "../src/GitSubmoduleExec.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
const sourcesBefore = process.env[submoduleSourcesVariable]
afterAll(async () => {
  if (sourcesBefore === undefined) delete process.env[submoduleSourcesVariable]
  else process.env[submoduleSourcesVariable] = sourcesBefore
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

const commit = (root: string, message: string): void => {
  git(root, ["add", "-A"])
  git(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-qm", message])
}

const fixture = async (): Promise<{
  readonly root: string
  readonly first: string
  readonly second: string
}> => {
  const source = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-submodule-source-"))
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-submodule-workspace-"))
  temporaryDirectories.push(source, root)
  // The source repository sits outside the workspace, so the operator admits it.
  process.env[submoduleSourcesVariable] = source
  git(source, ["init", "-q"])
  await write(source, "value.txt", "first")
  commit(source, "first")
  const first = git(source, ["rev-parse", "HEAD"])

  git(root, ["init", "-q"])
  git(root, ["config", "protocol.file.allow", "always"])
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("submodules", {
  repository: "git+https://example.invalid/submodules.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: ["git"] })
})
`
  )
  await write(
    root,
    "contracts/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const libs = S.Git.Submodules({ config: S.file("//.gitmodules"), paths: ["vendor/*"] })
const direct = S.Git.Submodule({ path: "//vendor/one" })
export const Package = S.Package({ targets: { direct, libs } })
`
  )
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "submodule-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  commit(root, "workspace")
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "-C", root, "submodule", "add", "-q", source, "vendor/one"]
  )
  commit(root, "submodule")

  await write(source, "value.txt", "second")
  commit(source, "second")
  const second = git(source, ["rev-parse", "HEAD"])
  return { root, first, second }
}

describe("Git submodule package execution", () => {
  it("roots config paths, expands globs, keys gitlinks, restores checkout, and refuses mismatches", async () => {
    const { first, root, second } = await fixture()
    const checkout = NodePath.join(root, "vendor/one")
    await Fs.rm(checkout, { recursive: true })
    await Fs.mkdir(checkout, { recursive: true })

    const planned = await serve(root, ["//contracts:libs", "--plan", "--format", "json"])
    expect(planned.exitCode, planned.output).toBe(0)
    const firstPlan = JSON.parse(planned.output) as {
      readonly targets: ReadonlyArray<{
        readonly label: string
        readonly key: string
        readonly argv?: ReadonlyArray<string>
        readonly sandbox?: { readonly network?: boolean }
      }>
    }
    const libs = firstPlan.targets.find((row) => row.label === "//contracts:libs")!
    expect(libs.argv?.slice(-2)).toEqual(["--", "vendor/one"])
    expect(libs.argv).not.toContain("--force")
    expect(libs.sandbox).toEqual({ network: true })

    const materialized = await serve(root, ["//contracts:libs"])
    expect(materialized.exitCode, materialized.logs).toBe(0)
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(first)
    expect(await Fs.readFile(NodePath.join(checkout, "value.txt"), "utf8")).toBe("first")
    expect((await serve(root, ["//contracts:libs"])).logs).toContain("//contracts:libs  hit")

    await Fs.rm(checkout, { recursive: true })
    const restored = await serve(root, ["//contracts:libs"])
    expect(restored.exitCode, restored.logs).toBe(0)
    expect(restored.logs).toContain("//contracts:libs  hit")
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(first)

    git(checkout, ["fetch", "-q", "origin"])
    git(checkout, ["checkout", "-q", second])
    git(root, ["add", "vendor/one"])
    const repinned = await serve(root, ["//contracts:libs", "--plan", "--format", "json"])
    const secondPlan = JSON.parse(repinned.output) as typeof firstPlan
    expect(secondPlan.targets.find((row) => row.label === "//contracts:libs")!.key).not.toBe(libs.key)

    git(checkout, ["checkout", "-q", first])
    const mismatch = await serve(root, ["//contracts:libs", "--plan", "--format", "json"])
    expect(mismatch.exitCode).toBe(0)
    expect(mismatch.output).toContain("does not match pinned gitlink")
    expect(mismatch.output).toContain(second)

    git(checkout, ["checkout", "-q", second])
    await write(checkout, "value.txt", "dirty")
    const dirty = await serve(root, ["//contracts:libs", "--plan", "--format", "json"])
    expect(dirty.exitCode).toBe(0)
    expect(dirty.output).toContain("worktree has changes relative to pinned gitlink")
    git(checkout, ["checkout", "--", "value.txt"])

    const direct = await serve(root, ["//contracts:direct", "--plan", "--format", "json"])
    expect(direct.exitCode, direct.output).toBe(0)
    expect(direct.output).toContain("vendor/one")
  })
})
