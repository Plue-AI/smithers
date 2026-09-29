import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkGeneratedSymlink, writeGeneratedSymlink } from "../src/GeneratedFile.ts"

let sandbox: string
let root: string
let external: string

beforeEach(async () => {
  sandbox = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-generated-symlink-")))
  root = Path.join(sandbox, "workspace")
  external = Path.join(sandbox, "external")
  await Fs.mkdir(root)
  await Fs.mkdir(external)
})

afterEach(async () => {
  await Fs.rm(sandbox, { recursive: true, force: true })
})

const write = (path: string, target: string): Promise<void> =>
  Effect.runPromise(writeGeneratedSymlink(root, { path, target }))

const check = (path: string, target: string): Promise<void> =>
  Effect.runPromise(checkGeneratedSymlink(root, { path, target }))

const writeFailure = (path: string, target: string) =>
  Effect.runPromise(Effect.result(writeGeneratedSymlink(root, { path, target })))

const checkFailure = (path: string, target: string) =>
  Effect.runPromise(Effect.result(checkGeneratedSymlink(root, { path, target })))

describe("generated symlink writes", () => {
  it("creates nested parents and replaces an old link", async () => {
    const destination = Path.join(root, "generated/nested/CLAUDE.md")
    await write("generated/nested/CLAUDE.md", "AGENTS.md")
    expect((await Fs.lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await Fs.readlink(destination)).toBe("AGENTS.md")

    await write("generated/nested/CLAUDE.md", "RULES.md")
    expect((await Fs.lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await Fs.readlink(destination)).toBe("RULES.md")
    expect(await Fs.readdir(Path.dirname(destination))).toEqual(["CLAUDE.md"])
  })

  it("replaces an ordinary file with a link", async () => {
    const destination = Path.join(root, "CLAUDE.md")
    await Fs.writeFile(destination, "old contents\n")

    await write("CLAUDE.md", "AGENTS.md")

    expect((await Fs.lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await Fs.readlink(destination)).toBe("AGENTS.md")
  })

  it("refuses to replace a directory and preserves its contents", async () => {
    const destination = Path.join(root, "CLAUDE.md")
    await Fs.mkdir(destination)
    await Fs.writeFile(Path.join(destination, "keep.txt"), "keep\n")

    const result = await writeFailure("CLAUDE.md", "AGENTS.md")

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/WriteFileError" } })
    expect((await Fs.lstat(destination)).isDirectory()).toBe(true)
    expect(await Fs.readFile(Path.join(destination, "keep.txt"), "utf8")).toBe("keep\n")
    expect(await Fs.readdir(root)).toEqual(["CLAUDE.md"])
  })
})

describe("generated symlink checks", () => {
  it("accepts the exact link without changing it", async () => {
    const destination = Path.join(root, "CLAUDE.md")
    await Fs.symlink("AGENTS.md", destination, "file")

    await expect(check("CLAUDE.md", "AGENTS.md")).resolves.toBeUndefined()
    expect(await Fs.readlink(destination)).toBe("AGENTS.md")
  })

  it.each(["missing", "wrong link", "regular file"])("reports %s as drift", async (state) => {
    const destination = Path.join(root, "CLAUDE.md")
    if (state === "wrong link") await Fs.symlink("RULES.md", destination, "file")
    if (state === "regular file") await Fs.writeFile(destination, "AGENTS.md")

    const result = await checkFailure("CLAUDE.md", "AGENTS.md")

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "smithers-build/DriftError",
        reason: state === "missing" ? "missing" : "drifted"
      }
    })
    if (state === "missing") await expect(Fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
    else if (state === "wrong link") expect(await Fs.readlink(destination)).toBe("RULES.md")
    else expect(await Fs.readFile(destination, "utf8")).toBe("AGENTS.md")
  })
})

describe("generated symlink parent containment", () => {
  it("rejects an external parent before write or check touches its destination", async () => {
    const destination = Path.join(external, "CLAUDE.md")
    await Fs.writeFile(destination, "external bytes\n")
    await Fs.symlink(external, Path.join(root, "linked"), "dir")

    expect(await writeFailure("linked/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/WriteFileError" } })
    expect(await checkFailure("linked/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/DriftError", reason: "unreadable" } })
    expect(await Fs.readFile(destination, "utf8")).toBe("external bytes\n")
    expect(await Fs.readdir(external)).toEqual(["CLAUDE.md"])
  })

  it("rejects a dangling parent without creating its target or children", async () => {
    const missing = Path.join(external, "missing")
    await Fs.symlink(missing, Path.join(root, "linked"), "dir")

    expect(await writeFailure("linked/nested/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/WriteFileError" } })
    expect(await checkFailure("linked/nested/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/DriftError", reason: "unreadable" } })
    expect(await Fs.readdir(external)).toEqual([])
    expect((await Fs.lstat(Path.join(root, "linked"))).isSymbolicLink()).toBe(true)
  })

  it("refuses an in-workspace symlinked parent", async () => {
    const actual = Path.join(root, "actual")
    await Fs.mkdir(actual)
    await Fs.symlink(actual, Path.join(root, "linked"), "dir")

    expect(await writeFailure("linked/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/WriteFileError" } })
    expect(await checkFailure("linked/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/DriftError", reason: "unreadable" } })
    expect(await Fs.readdir(actual)).toEqual([])
  })

  it("leaves an ordinary missing parent absent during check", async () => {
    expect(await checkFailure("missing/nested/CLAUDE.md", "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/DriftError", reason: "missing" } })
    expect(await Fs.readdir(root)).toEqual([])
  })

  it("rejects traversal before reading or writing outside the workspace", async () => {
    const destination = Path.join(external, "CLAUDE.md")
    const escaped = Path.relative(root, destination)
    await Fs.writeFile(destination, "external bytes\n")

    expect(await writeFailure(escaped, "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/WriteFileError" } })
    expect(await checkFailure(escaped, "AGENTS.md"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "smithers-build/DriftError", reason: "unreadable" } })
    expect(await Fs.readFile(destination, "utf8")).toBe("external bytes\n")
    expect(await Fs.readdir(external)).toEqual(["CLAUDE.md"])
  })
})
