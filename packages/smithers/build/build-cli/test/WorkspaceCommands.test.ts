import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as Cache from "../src/Cache.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import { makeCli, openPackageIndex } from "../src/Cli.ts"
import * as Watch from "../src/Watch.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const write = async (root: string, file: string, value: string) => {
  await Fs.mkdir(Path.dirname(Path.join(root, file)), { recursive: true })
  await Fs.writeFile(Path.join(root, file), value)
}
const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-commands-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", { repository: "git+https://example.invalid/fixture.git", cache: S.Cache({directory: ".flows"}),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }) })`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { clean: S.Clean({ paths: ["scratch"] }) } })`
  )
  await write(
    root,
    "lib/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { srcs: S.Filegroup({ srcs: S.glob(["*.txt"]), summary: "Library sources" }) } })`
  )
  await write(
    root,
    "app/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
import { Package as lib } from "../lib/PACKAGE.ts"
export const Package = S.Package({ targets: { srcs: S.Filegroup({ srcs: [lib.srcs] }), test: S.Shell.Test({ shell: "echo done", data: [lib.srcs] }) } })`
  )
  await write(
    root,
    "other/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["*.txt"]) })
export const Package = S.Package({ targets: { srcs, clean: S.Clean({ paths: ["scratch"] }), test: S.Shell.Test({ shell: "echo done", data: [srcs] }) } })`
  )
  await write(root, "lib/input.txt", "source")
  await write(root, "other/input.txt", "other")
  return root
}
const serve = async (root: string, args: ReadonlyArray<string>) => {
  let output = ""
  let code = 0
  await makeCli({ cliName: "smthrs", cliVersion: "1.0.0-test" }).serve([...args, "--workspace", root, "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, output, data: JSON.parse(output) }
}

describe("workspace command surface", () => {
  it("lists targets, resolves relative labels against workspace, and explains real keys", async () => {
    const root = await fixture()
    const targets = await serve(root, ["targets"])
    expect(targets.code, targets.output).toBe(0)
    expect(targets.output).toContain("Library sources")
    const info = await serve(root, ["show", "workspace"])
    expect(info.code).toBe(0)
    expect(info.output).toContain("1.0.0-test")
    const result = await serve(Path.join(root, "lib"), ["explain", ":srcs"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("//lib:srcs")
    expect(result.output).toContain("\"local\": \"miss\"")
    expect(result.output).toContain("input.txt")
    await expect(Fs.stat(Path.join(root, ".flows", "cache"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("includes added/deleted inputs and reverse dependencies without selecting unrelated packages", async () => {
    const root = await fixture()
    const index = await openPackageIndex({ workspace: root })
    const selection = Affected.select(index, ["//..."], ["lib/deleted.txt", "lib/new.txt"])
    const labels = selection.targets.map((target) => target.label)
    expect(labels).toContain("//lib:srcs")
    expect(labels).toContain("//app:srcs")
    expect(labels).not.toContain("//other:srcs")
    expect(selection.conservative).toBe(false)
    expect(Affected.select(index, ["//..."], ["pnpm-lock.yaml"]).targets).toHaveLength(index.targets().length)
    expect(Affected.select(index, ["//..."], ["scripts/unknown.ts"]).conservative).toBe(true)
    expect(Affected.select(index, ["//..."], []).targets).toHaveLength(0)
    const cli = await serve(root, ["affected", "test", "//...", "--files", "lib/new.txt", "--plan"])
    expect(cli.code).toBe(0)
    expect(cli.output).toContain("//app:test")
    expect(cli.output).not.toContain("//other:srcs")
  })

  it("clean plans only declared cleanup targets", async () => {
    const root = await fixture()
    const result = await serve(root, ["clean", "//...", "--plan"])
    expect(result.code).toBe(0)
    expect(result.output).toContain("//:clean")
    expect(result.output).not.toContain("//lib:srcs")
    const refused = await serve(root, ["clean", "//lib:srcs", "--plan"])
    expect(refused.code).not.toBe(0)
  })

  it("clean and affected select the union of every pattern", async () => {
    const root = await fixture()
    const clean = await serve(root, ["clean", "//:clean", "//other/...", "--plan"])
    expect(clean.code, clean.output).toBe(0)
    expect([...clean.data.roots].sort()).toEqual(["//:clean", "//other:clean"])
    const affected = await serve(root, [
      "affected",
      "test",
      "//app/...",
      "//other/...",
      "--files",
      "lib/new.txt",
      "--files",
      "other/input.txt",
      "--list"
    ])
    expect(affected.code, affected.output).toBe(0)
    expect(affected.data.targets.map((target: { readonly label: string }) => target.label).sort()).toEqual([
      "//app:test",
      "//other:test"
    ])
  })
})

describe("cache administration", () => {
  it("requires explicit deletion, supports retention, and preserves durable run state", async () => {
    const root = await fixture()
    const cache = await Cache.openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
    await cache.put("abcdef", {
      key: "abcdef",
      label: "//lib:srcs",
      target: "Filegroup",
      exitOk: true,
      output: {},
      storedAt: new Date().toISOString()
    })
    await cache.close()
    await write(root, ".flows/runs.db", "run state")
    expect(await CacheAdmin.inspect(root, ".flows", "abcdef")).toMatchObject({ label: "//lib:srcs" })
    const args = { root, cacheDirectory: ".flows", dryRun: false, yes: false }
    await expect(CacheAdmin.remove(args)).rejects.toThrow("--yes")
    expect((await CacheAdmin.remove({ ...args, dryRun: true })).candidates).toBe(1)
    expect((await CacheAdmin.remove({ ...args, yes: true, olderThanDays: 30 })).removed).toBe(0)
    expect((await CacheAdmin.remove({ ...args, yes: true })).removed).toBe(1)
    expect(await Fs.readFile(Path.join(root, ".flows/runs.db"), "utf8")).toBe("run state")
  })

  it("refuses symlink cache roots and leaves symlink entries untouched", async () => {
    const root = await fixture()
    await write(root, "outside/keep.json", "important")
    await Fs.mkdir(Path.join(root, ".flows"))
    await Fs.symlink(Path.join(root, "outside"), Path.join(root, ".flows/cache"))
    await expect(CacheAdmin.entries(root, ".flows")).rejects.toThrow("plain directory")
    await Fs.unlink(Path.join(root, ".flows/cache"))
    await Fs.mkdir(Path.join(root, ".flows/cache/ab"), { recursive: true })
    await Fs.symlink(Path.join(root, "outside/keep.json"), Path.join(root, ".flows/cache/ab/abcdef.json"))
    expect(await CacheAdmin.entries(root, ".flows")).toEqual([])
    expect(await Fs.readFile(Path.join(root, "outside/keep.json"), "utf8")).toBe("important")
  })
})

describe("watch", () => {
  it("runs a fresh CLI process once and returns its exit code", async () => {
    const root = await fixture()
    let output = ""
    const result = await Watch.run({
      root,
      args: ["target", "//lib:srcs", "--plan"],
      ignored: [".flows"],
      debounceMs: 20,
      once: true,
      stdout: (text) => {
        output += text
      },
      stderr: () => {}
    })
    expect(result, output).toEqual({ cycles: 1, exitCode: 0, stopped: false })
    expect(output).toContain("//lib:srcs")
  })

  it("cancels an idle watcher without leaving its event loop alive", async () => {
    const root = await fixture()
    const controller = new AbortController()
    let seen = false
    const result = await Watch.run({
      root,
      args: ["target", "//lib:srcs", "--plan"],
      ignored: [".flows"],
      debounceMs: 20,
      once: false,
      signal: controller.signal,
      stdout: () => {
        if (!seen) {
          seen = true
          setTimeout(() => controller.abort(), 100)
        }
      },
      stderr: () => {}
    })
    expect(result.stopped).toBe(true)
  })

  it("restarts with a fresh declaration graph after an edit", async () => {
    const root = await fixture()
    const controller = new AbortController()
    let frames = 0
    let output = ""
    let pending = ""
    let errors = ""
    const deadline = setTimeout(() => controller.abort(), 120_000)
    try {
      const result = await Watch.run({
        root,
        args: ["target", "//lib:srcs", "--plan", "--json"],
        ignored: [".flows"],
        debounceMs: 30,
        once: false,
        signal: controller.signal,
        stdout: (text) => {
          pending += text
          try {
            JSON.parse(pending)
          } catch {
            return
          }
          output += pending
          pending = ""
          frames += 1
          if (frames === 1) {
            setTimeout(() => {
              void write(
                root,
                "lib/PACKAGE.ts",
                `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { srcs: S.Filegroup({ srcs: [S.file("new-source.txt")] }) } })`
              )
                .catch(() => controller.abort())
            }, 100)
          } else controller.abort()
        },
        stderr: (text) => {
          errors += text
        }
      })
      expect(result.cycles).toBeGreaterThanOrEqual(2)
      expect(frames, errors).toBe(2)
      expect(output.match(/"key": "[^"]+"/g)?.[0]).not.toEqual(output.match(/"key": "[^"]+"/g)?.[1])
    } finally {
      clearTimeout(deadline)
    }
  }, 130_000)
})
