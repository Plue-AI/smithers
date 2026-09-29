import { readFile } from "node:fs/promises"
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeStateSnapshot } from "./remote-state.ts"

let directory: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(NodePath.join(tmpdir(), "smithers-state-topology-")))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const put = async (relative: string, body: string): Promise<void> => {
  const target = NodePath.join(directory, ...relative.split("/"))
  await mkdir(NodePath.dirname(target), { recursive: true })
  await writeFile(target, body, "utf8")
}

const read = (relative: string): Promise<string> =>
  readFile(NodePath.join(directory, ...relative.split("/")), "utf8")

const snapshot = (files: Record<string, string>): string => JSON.stringify({ format: "smithers-alchemy-state/1", files })

/** Includes kept files and empty directories, not just the state snapshot. */
const tree = async (relative = ""): Promise<Array<[string, string]>> => {
  const entries = await readdir(NodePath.join(directory, relative), { withFileTypes: true })
  const result: Array<[string, string]> = []
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      result.push([path, "directory"])
      result.push(...(await tree(path)))
    } else if (entry.isFile()) {
      result.push([path, Buffer.from(await readFile(NodePath.join(directory, ...path.split("/")))).toString("hex")])
    } else {
      result.push([path, "other"])
    }
  }
  return result.sort(([left], [right]) => left.localeCompare(right))
}

const expectRefusalBeforeChange = async (files: Record<string, string>): Promise<void> => {
  const before = await tree()
  const error = await writeStateSnapshot(directory, snapshot(files)).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(TypeError)
  expect(await tree()).toEqual(before)
}

describe("remote state snapshot topology", () => {
  it("replaces a local state directory with a remote state file", async () => {
    await put("prod/dir.json/Child.json", "old child")
    await put("prod/Stale.json", "stale")
    await put(".smithers-state-owner.lock", "owner")

    await writeStateSnapshot(directory, snapshot({ "prod/dir.json": "new parent" }))

    expect(await read("prod/dir.json")).toBe("new parent")
    expect(await tree()).toEqual([
      [".smithers-state-owner.lock", Buffer.from("owner").toString("hex")],
      ["prod", "directory"],
      ["prod/dir.json", Buffer.from("new parent").toString("hex")]
    ])
  })

  it("replaces a local state file with a remote state directory", async () => {
    await put("prod/dir.json", "old parent")
    await put(".smithers-state-owner.lock", "owner")

    await writeStateSnapshot(directory, snapshot({ "prod/dir.json/Child.json": "new child" }))

    expect(await read("prod/dir.json/Child.json")).toBe("new child")
    expect(await read(".smithers-state-owner.lock")).toBe("owner")
  })

  it("replaces a nested empty state directory with a remote file", async () => {
    await mkdir(NodePath.join(directory, "prod", "dir.json", "deep"), { recursive: true })
    await put(".smithers-state-owner.lock", "owner")

    await writeStateSnapshot(directory, snapshot({ "prod/dir.json": "new parent" }))

    expect(await read("prod/dir.json")).toBe("new parent")
    expect(await read(".smithers-state-owner.lock")).toBe("owner")
  })

  it("creates a missing state directory", async () => {
    const missing = NodePath.join(directory, "absent")
    await writeStateSnapshot(missing, snapshot({ "prod/Child.json": "new" }))
    expect(await readFile(NodePath.join(missing, "prod", "Child.json"), "utf8")).toBe("new")
  })

  it.each([
    ["plain", "prod/notes.txt", "prod/notes.txt/Child.json"],
    ["case equivalent", "prod/NOTES.txt", "prod/notes.txt/Child.json"],
    ["Unicode equivalent", "prod/Cafe\u0301.txt", "prod/Café.txt/Child.json"],
    ["sharp-s equivalent", "prod/ẞ.txt", "prod/ß.txt/Child.json"]
  ])("refuses a remote path through a kept %s local file before removing state", async (_kind, kept, remote) => {
    await put("prod/Stale.json", "state to preserve")
    await put(kept, "kept bytes")
    await put(".smithers-state-owner.lock", "owner")
    await expectRefusalBeforeChange({ [remote]: "remote" })
  })

  it("refuses to replace a state directory that also contains a kept file", async () => {
    await put("prod/dir.json/Child.json", "old child")
    await put("prod/dir.json/deep/notes.txt", "kept bytes")
    await put("prod/Stale.json", "state to preserve")
    await expectRefusalBeforeChange({ "prod/dir.json": "remote" })
  })

  it("refuses to overwrite a case equivalent kept file", async () => {
    await put("prod/Keep.JSON", "kept bytes")
    await put("prod/Stale.json", "state to preserve")
    await expectRefusalBeforeChange({ "prod/keep.json": "remote" })
  })

  it.each([
    ["case", "prod/Cache/notes.txt", "prod/cache/New.json"],
    ["canonical Unicode", "prod/Café/notes.txt", "prod/Cafe\u0301/New.json"]
  ])("refuses %s alias of a directory containing kept files", async (_kind, kept, remote) => {
    await put(kept, "kept bytes")
    await put("prod/Stale.json", "state to preserve")
    await put(".smithers-state-owner.lock", "owner")
    await expectRefusalBeforeChange({ [remote]: "remote" })
  })

  it.each([
    ["case", "prod/Cache/Old.json", "prod/cache/New.json"],
    ["canonical Unicode", "prod/Café/Old.json", "prod/Cafe\u0301/New.json"]
  ])("refuses %s alias of a directory containing only state", async (_kind, local, remote) => {
    await put(local, "old state")
    await put(".smithers-state-owner.lock", "owner")
    await expectRefusalBeforeChange({ [remote]: "new state" })
  })

  it("uses a shared directory with exact spelling while retaining unrelated bytes", async () => {
    await put("prod/Cache/notes.txt", "kept bytes")
    await put("prod/Stale.json", "old state")
    await put(".smithers-state-owner.lock", "owner")

    await writeStateSnapshot(directory, snapshot({ "prod/Cache/New.json": "new state" }))

    expect(await read("prod/Cache/New.json")).toBe("new state")
    expect(await read("prod/Cache/notes.txt")).toBe("kept bytes")
    expect(await read(".smithers-state-owner.lock")).toBe("owner")
    expect((await tree()).some(([path]) => path === "prod/Stale.json")).toBe(false)
  })

  it.each([
    ["case equivalent files", "prod/Cache.json", "prod/cache.json"],
    ["Unicode equivalent files", "prod/Café.json", "prod/Cafe\u0301.json"],
    ["non-ASCII case equivalent files", "prod/Straße.json", "prod/STRASSE.json"],
    ["sharp-s aliases, capital first", "prod/ẞ.json", "prod/ß.json"],
    ["sharp-s aliases, lowercase first", "prod/ß.json", "prod/ẞ.json"],
    ["case equivalent directories", "prod/Cache/One.json", "prod/cache/Two.json"],
    ["Unicode equivalent directories", "prod/Café/One.json", "prod/Cafe\u0301/Two.json"],
    ["case equivalent ancestor first", "prod/Dir.json", "prod/dir.json/Child.json"],
    ["case equivalent descendant first", "prod/dir.json/Child.json", "prod/Dir.json"],
    ["Unicode equivalent ancestor first", "prod/Café.json", "prod/Cafe\u0301.json/Child.json"],
    ["Unicode equivalent descendant first", "prod/Cafe\u0301.json/Child.json", "prod/Café.json"]
  ])("refuses remote %s before changing any local bytes", async (_kind, first, second) => {
    await put("prod/Stale.json", "state to preserve")
    await put("prod/nested/notes.txt", "kept bytes")
    await put(".smithers-state-owner.lock", "owner")
    await expectRefusalBeforeChange({ [first]: "first", [second]: "second" })
  })

  it.each([
    ["high", "\uD800"],
    ["low", "\uDC00"]
  ])("refuses a lone %s surrogate in a remote filename before changing local state", async (_kind, surrogate) => {
    await put("prod/Stale.json", "state to preserve")
    await put(".smithers-state-owner.lock", "owner")
    await expectRefusalBeforeChange({ [`prod/${surrogate}.json`]: "remote" })
  })

  it("refuses two remote names that encode as the same replacement character", async () => {
    await put("prod/Stale.json", "state to preserve")
    await put(".smithers-state-owner.lock", "owner")
    await expectRefusalBeforeChange({ "prod/\uD800.json": "high", "prod/\uDC00.json": "low" })
  })

  it("accepts a well-formed non-BMP Unicode filename", async () => {
    await put("prod/Stale.json", "old")
    await put(".smithers-state-owner.lock", "owner")

    await writeStateSnapshot(directory, snapshot({ "prod/🚀.json": "new" }))

    expect(await read("prod/🚀.json")).toBe("new")
    expect(await read(".smithers-state-owner.lock")).toBe("owner")
  })

  it.each([
    ["case", "prod/Cache.json", "prod/cache.json"],
    ["Unicode", "prod/Café.json", "prod/Cafe\u0301.json"]
  ])("allows one %s equivalent remote file to replace local state", async (_kind, local, remote) => {
    await put(local, "old")
    await put(".smithers-state-owner.lock", "owner")

    await writeStateSnapshot(directory, snapshot({ [remote]: "new" }))

    expect(await read(remote)).toBe("new")
    expect(await read(".smithers-state-owner.lock")).toBe("owner")
  })
})
