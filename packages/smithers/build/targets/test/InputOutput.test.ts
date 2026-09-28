import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
let outside: string
const write = async (relative: string, content = "hi"): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, content)
}
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-output-")))
  outside = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-output-outside-")))
})
afterEach(async () => {
  await Promise.all([root, outside].map((path) => Fs.rm(path, { recursive: true, force: true })))
})

describe("Input.listOutputFiles", () => {
  it("treats brackets in the declared directory as literal path bytes", async () => {
    await write("dist[1]/z.txt")
    await write("dist[1]/a.txt")
    await write("dist1/decoy.txt")
    expect(await Input.listOutputFiles(root, "dist[1]"))
      .toEqual(["dist[1]/a.txt", "dist[1]/z.txt"])
  })

  it("includes generated hidden and host-state names while source scans retain their filters", async () => {
    const paths = [
      "generated/.flows/cache.txt",
      "generated/.git/config.txt",
      "generated/.hidden.txt",
      "generated/nested/PACKAGE.ts",
      "generated/nested/owned.txt",
      "generated/node_modules/dependency.txt",
      "generated/visible.txt"
    ]
    for (const path of paths) await write(path)
    expect(await Input.expandGlob(root, "", "generated/**/*.txt"))
      .toEqual(["generated/.flows/cache.txt", "generated/.hidden.txt", "generated/visible.txt"])
    expect(await Input.listOutputFiles(root, "generated")).toEqual(paths)
  })

  it("lists declared workspace cache outputs while source inventory omits them", async () => {
    await write(".flows/cache.txt")
    expect(await Input.expandGlob(root, "", ".flows/**/*.txt")).toEqual([])
    expect(await Input.listOutputFiles(root, ".flows")).toEqual([".flows/cache.txt"])
  })

  it("includes gitignored generated files without changing source admission", async () => {
    await write(".gitignore", "dist/\n")
    await write("dist/owned.txt")
    expect(await Input.expandGlob(root, "", "dist/**/*.txt")).toEqual([])
    expect(await Input.listOutputFiles(root, "dist")).toEqual(["dist/owned.txt"])
  })

  it("inventories a directory below a distinct package boundary", async () => {
    await write("pkg/PACKAGE.ts", "export default {}")
    await write("pkg/dist/owned.txt")
    expect(await Input.expandGlob(root, "", "pkg/dist/**/*.txt")).toEqual([])
    expect(await Input.listOutputFiles(root, "pkg/dist")).toEqual(["pkg/dist/owned.txt"])
  })

  it("returns an empty inventory only for an existing empty directory", async () => {
    await Fs.mkdir(Path.join(root, "empty"))
    expect(await Input.listOutputFiles(root, "empty")).toEqual([])
    await expect(Input.listOutputFiles(root, "missing"))
      .rejects.toThrow("declared output directory is unavailable: missing")
    await write("file.txt")
    await expect(Input.listOutputFiles(root, "file.txt"))
      .rejects.toThrow("declared output directory is unavailable: file.txt")
  })

  it.each(["../outside", "C:/outside", "dist\\child", "dist/\0child", "dist/\uD800"])(
    "refuses the nonconfined or nonportable directory %j",
    async (directory) => {
      await expect(Input.listOutputFiles(root, directory)).rejects.toThrow(/workspace|portable/)
      expect(await Fs.readdir(outside)).toEqual([])
    }
  )

  it.skipIf(process.platform === "win32")("admits contained file links and skips other link kinds", async () => {
    await write("dist/actual.txt", "actual")
    await write("target.txt", "target")
    await Fs.writeFile(Path.join(outside, "secret.txt"), "secret")
    await Fs.mkdir(Path.join(root, "elsewhere"))
    for (
      const [name, target] of [
        ["alias.txt", Path.join(root, "target.txt")],
        ["external.txt", Path.join(outside, "secret.txt")],
        ["dangling.txt", Path.join(root, "absent.txt")],
        ["directory", Path.join(root, "elsewhere")],
        ["loop.txt", Path.join(root, "dist/loop.txt")]
      ]
    ) await Fs.symlink(target!, Path.join(root, "dist", name!))
    expect(await Input.listOutputFiles(root, "dist")).toEqual(["dist/actual.txt", "dist/alias.txt"])
    expect(await Fs.readFile(Path.join(root, "dist/alias.txt"), "utf8")).toBe("target")
    expect(await Fs.readFile(Path.join(outside, "secret.txt"), "utf8")).toBe("secret")
    await Fs.symlink(outside, Path.join(root, "escape"))
    await expect(Input.listOutputFiles(root, "escape"))
      .rejects.toThrow("declared output directory is unavailable: escape")
  })

  it("refuses a pre-aborted request before listing any directories", async () => {
    await write("dist/owned.txt")
    const controller = new AbortController()
    const reason = new Error("cancelled before output inventory")
    controller.abort(reason)
    const listed: Array<string> = []
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        listed.push(path)
        return SafeFs.defaultIo.readdir(path, limit)
      }
    }
    await expect(Input.listOutputFiles(root, "dist", { io, signal: controller.signal })).rejects.toBe(reason)
    expect(listed).toEqual([])
  })

  it("propagates cancellation during listing without descending into children", async () => {
    await write("dist/nested/owned.txt")
    const controller = new AbortController()
    const reason = new Error("cancelled while listing output")
    const listed: Array<string> = []
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        listed.push(path)
        const entries = await SafeFs.defaultIo.readdir(path, limit)
        if (path === Path.join(root, "dist")) controller.abort(reason)
        return entries
      }
    }
    await expect(Input.listOutputFiles(root, "dist", { io, signal: controller.signal })).rejects.toBe(reason)
    expect(listed).toEqual([root, Path.join(root, "dist")])
  })

  it.each(
    [
      ["files", 1, 0],
      ["directories", 3, 2],
      ["entries", 3, 2],
      ["depth", 2, 1]
    ] as const
  )("enforces the exact %s boundary without returning a partial inventory", async (key, accepted, refused) => {
    await write("dist/nested/owned.txt")
    expect(await Input.listOutputFiles(root, "dist", { limits: { [key]: accepted } }))
      .toEqual(["dist/nested/owned.txt"])
    await expect(Input.listOutputFiles(root, "dist", { limits: { [key]: refused } }))
      .rejects.toThrow(
        key === "entries" ? /more than 0 entries/ : `declared input scan exceeds its ${key} limit of ${refused}`
      )
  })
})
