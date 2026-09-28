import * as SafeFs from "@smthrs/targets/SafeFs"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporaryWorkspace = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-discovery-"))
  temporaryDirectories.push(directory)
  await write(directory, "WORKSPACE.ts", "export const Workspace = 1\n")
  await write(directory, "PACKAGE.ts", "export const Package = 1\n")
  return directory
}

const workspaceModule = (options: string): string =>
  `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("discovery", {
  repository: "git+https://example.invalid/discovery.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  ${options}
})
`

describe("PackageDiscovery.discover boundaries", () => {
  it("finds the nearest workspace from a descendant and prefers its .smithers declaration", async () => {
    const root = await temporaryWorkspace()
    await write(root, ".smithers/WORKSPACE.ts", "export const Workspace = 2\n")
    await write(root, "nested/WORKSPACE.ts", "export const Workspace = 3\n")
    await Fs.mkdir(NodePath.join(root, "nested", "deep"), { recursive: true })
    expect(await PackageDiscovery.findWorkspaceRoot(NodePath.join(root, "nested", "deep")))
      .toBe(NodePath.join(root, "nested"))
    expect(await PackageDiscovery.findWorkspaceRoot(root)).toBe(root)
    expect(await PackageDiscovery.workspaceFileOf(root)).toBe(".smithers/WORKSPACE.ts")
    expect(await PackageDiscovery.workspaceFileOf(NodePath.join(root, "nested"))).toBe("WORKSPACE.ts")
    expect(await PackageDiscovery.workspaceFileOf(NodePath.join(root, "missing"))).toBeUndefined()
  })

  it("admits the preferred workspace and only its adjacent factory", async () => {
    const root = await temporaryWorkspace()
    await write(root, ".smithers/WORKSPACE.ts", "export const Workspace = 2\n")
    await write(root, ".smithers/FACTORY.ts", "export const Factory = 2\n")
    await write(root, "FACTORY.ts", "export const Factory = 1\n")
    await write(root, "z/PACKAGE.ts", "export const Package = 2\n")
    await write(root, "a/PACKAGE.ts", "export const Package = 3\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.workspaceFile).toBe(".smithers/WORKSPACE.ts")
    expect(discovery.factoryFile).toBe(".smithers/FACTORY.ts")
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts", "a/PACKAGE.ts", "z/PACKAGE.ts"])
  })

  it.each(["WORKSPACE.ts", "FACTORY.ts"])("rejects a symlinked %s declaration", async (file) => {
    const root = await temporaryWorkspace()
    await write(root, "source.ts", "export const value = 1\n")
    if (file === "WORKSPACE.ts") await Fs.rm(NodePath.join(root, file))
    await Fs.symlink(NodePath.join(root, "source.ts"), NodePath.join(root, file))
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "module_not_regular",
      path: file
    })
  })

  it("rejects a missing workspace declaration and a root BUILD.ts with distinct diagnostics", async () => {
    const root = await temporaryWorkspace()
    await Fs.rm(NodePath.join(root, "WORKSPACE.ts"))
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({ code: "workspace_root_invalid" })
    await write(root, "WORKSPACE.ts", "export const Workspace = 1\n")
    await write(root, "BUILD.ts", "export const stale = 1\n")
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "duplicate_package_path",
      path: "BUILD.ts"
    })
  })

  it("rejects an obsolete nested BUILD.ts with its workspace-relative path", async () => {
    const root = await temporaryWorkspace()
    await write(root, "nested/BUILD.ts", "export const stale = 1\n")
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "duplicate_package_path",
      path: "nested/BUILD.ts"
    })
  })

  it("treats a directory named WORKSPACE.ts as absent during presence probing", async () => {
    const root = await temporaryWorkspace()
    await Fs.mkdir(NodePath.join(root, ".smithers", "WORKSPACE.ts"), { recursive: true })
    expect(await PackageDiscovery.workspaceFileOf(root)).toBe("WORKSPACE.ts")
    await Fs.rm(NodePath.join(root, "WORKSPACE.ts"))
    expect(await PackageDiscovery.workspaceFileOf(root)).toBeUndefined()
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "module_not_regular",
      path: ".smithers/WORKSPACE.ts"
    })
  })

  it("rejects a symlinked PACKAGE.ts without admitting the linked module", async () => {
    const root = await temporaryWorkspace()
    await write(root, "source.ts", "export const Package = 2\n")
    await Fs.mkdir(NodePath.join(root, "nested"))
    await Fs.symlink(NodePath.join(root, "source.ts"), NodePath.join(root, "nested", "PACKAGE.ts"))
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "module_not_regular",
      path: "nested/PACKAGE.ts"
    })
  })

  it.skipIf(process.platform === "win32")("rejects a named pipe in place of PACKAGE.ts", async () => {
    const root = await temporaryWorkspace()
    const file = NodePath.join(root, "pipe", "PACKAGE.ts")
    await Fs.mkdir(NodePath.dirname(file))
    execFileSync("mkfifo", [file])
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "module_not_regular",
      path: "pipe/PACKAGE.ts"
    })
  })

  it("prunes fixed and selected cache directories while retaining neighboring packages", async () => {
    const root = await temporaryWorkspace()
    await write(root, ".flows/store/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "custom-cache/PACKAGE.ts", "export const Package = 2\n")
    await write(root, "custom-cache-extra/PACKAGE.ts", "export const Package = 3\n")
    await write(root, "node_modules/dependency/PACKAGE.ts", "export const Package = 4\n")
    await write(root, "dist/PACKAGE.ts", "export const Package = 5\n")
    const discovery = await PackageDiscovery.discover(root, { cacheDirectory: "custom-cache" })
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts", "custom-cache-extra/PACKAGE.ts"])
    expect(discovery.cacheDirectory).toBe("custom-cache")
    expect(discovery.pruned).toEqual([])
  })

  it("validates declared repository boundaries and excludes valid child workspaces", async () => {
    const root = await temporaryWorkspace()
    await write(root, "repos/child/PACKAGE.ts", "export const Package = 2\n")
    const repositories = { zed: { path: "repos/child" }, alpha: { path: "repos/other" } }
    await expect(PackageDiscovery.discover(root, { repositories }))
      .rejects.toMatchObject({ code: "local_repository_invalid", path: "repos/other" })
    await write(root, "repos/other/WORKSPACE.ts", "export const Workspace = 2\n")
    await expect(PackageDiscovery.discover(root, { repositories }))
      .rejects.toMatchObject({ code: "local_repository_invalid", path: "repos/child" })
    await write(root, "repos/child/WORKSPACE.ts", "export const Workspace = 3\n")
    const discovery = await PackageDiscovery.discover(root, { repositories })
    expect(discovery.repositories).toEqual([
      { name: "alpha", path: "repos/other" },
      { name: "zed", path: "repos/child" }
    ])
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.pruned).toEqual([])
  })

  it("honors an already cancelled discovery request", async () => {
    const root = await temporaryWorkspace()
    const controller = new AbortController()
    controller.abort("stop discovery")
    await expect(PackageDiscovery.discover(root, { signal: controller.signal }))
      .rejects.toBe("stop discovery")
  })

  it("refuses a PACKAGE.ts that disappears after its directory was listed", async () => {
    const root = await temporaryWorkspace()
    const canonical = await Fs.realpath(root)
    const packageFile = NodePath.join(root, "PACKAGE.ts")
    let removed = false
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        const entries = await SafeFs.defaultIo.readdir(path, limit)
        if (path === canonical) {
          await Fs.rm(packageFile)
          removed = true
        }
        return entries
      }
    }
    await expect(PackageDiscovery.discover(root, { io })).rejects.toMatchObject({
      code: "module_missing",
      path: "PACKAGE.ts"
    })
    expect(removed).toBe(true)
  })

  it("refuses a tree deeper than 256 directories with the offending relative path", async () => {
    const root = await temporaryWorkspace()
    const deep = Array.from({ length: 257 }, () => "d").join("/")
    await Fs.mkdir(NodePath.join(root, deep), { recursive: true })
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "inventory_limit_exceeded",
      path: deep
    })
  })

  it("never enters a cache tagged with CACHEDIR.TAG", async () => {
    const root = await temporaryWorkspace()
    await write(root, "target/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n")
    await write(root, "target/debug/build/PACKAGE.ts", "export const Package = 1\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.pruned).toEqual(["target"])
  })

  it("never enters a nested checkout: a clone, a linked worktree, or a jj workspace", async () => {
    const root = await temporaryWorkspace()
    await write(root, "vendor/clone/.git/HEAD", "ref: refs/heads/main\n")
    await write(root, "vendor/clone/WORKSPACE.ts", "export const Workspace = 1\n")
    await write(root, "scratch/worktree/.git", "gitdir: /elsewhere/.git/worktrees/worktree\n")
    await write(root, "scratch/worktree/BUILD.ts", "export const stale = 1\n")
    await write(root, "lanes/jj/.jj/repo", "/elsewhere\n")
    await write(root, "lanes/jj/pkg/PACKAGE.ts", "export const Package = 1\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.pruned).toEqual(["lanes/jj", "scratch/worktree", "vendor/clone"])
  })

  it("never enters a declared discovery.prune path and reports it", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`discovery: { prune: ["./scratch", "deep/store/"] },`))
    await write(root, "scratch/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "deep/store/pkg/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "deep/kept/PACKAGE.ts", "export const Package = 1\n")
    const declaration = await PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts")
    expect(declaration.discovery?.prune).toEqual(["scratch", "deep/store"])
    const discovery = await PackageDiscovery.discover(root, { prune: declaration.discovery?.prune })
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts", "deep/kept/PACKAGE.ts"])
    expect(discovery.pruned).toEqual(["deep/store", "scratch"])
  })

  it.each(["../outside", "/absolute", ""])("refuses the discovery.prune path %j", async (path) => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`discovery: { prune: [${JSON.stringify(path)}] },`))
    await expect(PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts"))
      .rejects.toThrow(/discovery prune path must (be relative|remain inside the workspace)/)
  })

  it.each([
    ["nested/WORKSPACE.ts", "nested/WORKSPACE.ts"],
    ["nested/.smithers/WORKSPACE.ts", "nested/.smithers/WORKSPACE.ts"]
  ])("still refuses an undeclared nested workspace marked by %s", async (file, marker) => {
    const root = await temporaryWorkspace()
    await write(root, file, "export const Workspace = 1\n")
    await write(root, "nested/BUILD.ts", "export const stale = 1\n")
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "nested_workspace_undeclared",
      path: marker
    })
  })

  /**
   * The falsifiable statement of the walk's cost: one confined resolve and
   * one confined listing per directory (lstat + realpath, then lstat +
   * readdir + lstat), and no per-child probes. The walk used to spend ten
   * calls per directory, which on a checkout with 17,599 directories was
   * 177,000 calls and 88 to 127 seconds of `smthrs targets`.
   */
  it("spends at most five filesystem calls per directory", async () => {
    const root = await temporaryWorkspace()
    const width = 12
    for (let outer = 0; outer < width; outer += 1) {
      for (let inner = 0; inner < width; inner += 1) {
        await write(root, `tree/d${outer}/d${inner}/file.txt`, "x\n")
      }
    }
    let calls = 0
    const counted = <A extends Array<unknown>, R>(call: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
      calls += 1
      return call(...args)
    }
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      lstat: counted(SafeFs.defaultIo.lstat),
      realpath: counted(SafeFs.defaultIo.realpath),
      readdir: counted(SafeFs.defaultIo.readdir)
    }
    const discovery = await PackageDiscovery.discover(root, { io })
    // root, tree, 12 outer, 144 inner.
    expect(discovery.directories).toBe(1 + 1 + width + width * width)
    // The lower bound proves the seam saw the walk; the upper bound is the budget.
    expect(calls).toBeGreaterThanOrEqual(3 * discovery.directories)
    expect(calls).toBeLessThanOrEqual(5 * discovery.directories)
  })
})
