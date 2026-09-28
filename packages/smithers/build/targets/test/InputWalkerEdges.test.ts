import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
const write = async (relative: string, text = "owned"): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, text)
}
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-walker-edge-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("Input walker boundaries", () => {
  it("rejects accessor-based scan limits without invoking caller code or listing files", async () => {
    await write("dist/owned.txt")
    let reads = 0
    let listings = 0
    const limits = Object.defineProperty({}, "files", {
      get: () => {
        reads++
        return 1
      }
    })
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        listings++
        return SafeFs.defaultIo.readdir(path, limit)
      }
    }
    await expect(Input.listOutputFiles(root, "dist", { limits, io }))
      .rejects.toThrow("input scan limit files must be a non-negative safe integer")
    expect(reads).toBe(0)
    expect(listings).toBe(0)
  })

  it.skipIf(process.platform === "win32")(
    "a dangling package-marker link does not hide ordinary source files",
    async () => {
      await write("pkg/owned.txt")
      await Fs.symlink(Path.join(root, "missing.ts"), Path.join(root, "pkg/PACKAGE.ts"))
      expect(await Input.expandGlob(root, "", "**/*.txt")).toEqual(["pkg/owned.txt"])
      expect((await Fs.lstat(Path.join(root, "pkg/PACKAGE.ts"))).isSymbolicLink()).toBe(true)
    }
  )

  it("ignores non-path gitmodules lines but confines the declared submodule directory", async () => {
    await write(
      ".gitmodules",
      "[submodule \"vendor\"]\n url = https://example.invalid/vendor\n path = vendor\n # comment\n"
    )
    await write("vendor/hidden.txt")
    await write("ordinary/owned.txt")
    expect((await Input.discoverFiles(root)).filter((path) => path.endsWith(".txt")))
      .toEqual(["ordinary/owned.txt"])
    expect(await Fs.readFile(Path.join(root, "vendor/hidden.txt"), "utf8")).toBe("owned")
  })

  it.skipIf(process.platform === "win32")(
    "propagates a file-link IO failure rather than returning an incomplete successful inventory",
    async () => {
      await write("dist/owned.txt")
      const link = Path.join(root, "dist/alias.txt")
      await Fs.symlink(Path.join(root, "dist/owned.txt"), link)
      const failure = Object.assign(new Error("file link lookup denied"), { code: "EACCES" })
      let failedLookups = 0
      const io: SafeFs.Io = {
        ...SafeFs.defaultIo,
        realpath: async (path) => {
          if (path === link) {
            failedLookups++
            throw failure
          }
          return SafeFs.defaultIo.realpath(path)
        }
      }
      await expect(Input.listOutputFiles(root, "dist", { io })).rejects.toBe(failure)
      expect(failedLookups).toBe(1)
      expect(await Input.listOutputFiles(root, "dist")).toEqual(["dist/alias.txt", "dist/owned.txt"])
    }
  )

  it.skipIf(process.platform === "win32")("skips a real FIFO while retaining regular files", async () => {
    await write("dist/owned.txt")
    const fifo = Path.join(root, "dist/pipe")
    execFileSync("mkfifo", [fifo])
    expect((await Fs.lstat(fifo)).isFIFO()).toBe(true)
    expect(await Input.listOutputFiles(root, "dist")).toEqual(["dist/owned.txt"])
  })

  it("skips a directory removed after listing and preserves its surviving sibling", async () => {
    await write("dist/gone/obsolete.txt")
    await write("dist/owned.txt")
    let removals = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      readdir: async (path, limit) => {
        const entries = await SafeFs.defaultIo.readdir(path, limit)
        if (path === Path.join(root, "dist")) {
          await Fs.rm(Path.join(root, "dist/gone"), { recursive: true })
          removals++
        }
        return entries
      }
    }
    expect(await Input.listOutputFiles(root, "dist", { io })).toEqual(["dist/owned.txt"])
    expect(removals).toBe(1)
    await expect(Fs.stat(Path.join(root, "dist/gone"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
