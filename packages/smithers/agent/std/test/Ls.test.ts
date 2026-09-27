import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Effect, Exit, FileSystem, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Ls from "../src/Ls.ts"
import { fileInfo, layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Ls", () => {
  it("sorts directories first and appends their suffix", async () => {
    const result = await execute(Effect.provide(
      Ls.run({ path: "/work" }),
      layer({
        files: {
          "/work/z.txt": "z",
          "/work/a.txt": "a",
          "/work/dir/b.txt": "b",
          "/work/another/c.txt": "c"
        }
      })
    ))
    expect(result.entries).toEqual([
      { name: "another/", kind: "directory" },
      { name: "dir/", kind: "directory" },
      { name: "a.txt", kind: "file" },
      { name: "z.txt", kind: "file" }
    ])
  })

  it("sorts names by locale-independent UTF-16 code units", async () => {
    const names = [
      "a.txt",
      "A.txt",
      "_.txt",
      "!.txt",
      "é.txt",
      "é.txt",
      "😀.txt",
      "𐀀.txt",
      "z.txt",
      "Z.txt",
      "Ω.txt"
    ]
    const files = Object.fromEntries(names.map((name) => [`/work/${name}`, ""]))
    const result = await execute(Effect.provide(Ls.run({ path: "/work" }), layer({ files })))
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "!.txt",
      "A.txt",
      "Z.txt",
      "_.txt",
      "a.txt",
      "é.txt",
      "z.txt",
      "é.txt",
      "Ω.txt",
      "𐀀.txt",
      "😀.txt"
    ])
  })

  it("pages a listing and discloses remaining entries", async () => {
    const result = await execute(Effect.provide(
      Ls.run({ path: "/work", offset: 2, limit: 1 }),
      layer({
        files: { "/work/a": "", "/work/b": "", "/work/c": "" }
      })
    ))
    expect(result.entries).toEqual([{ name: "b", kind: "file" }])
    expect(result).toMatchObject({ total: 3, truncated: true })
    expect(result.notice).toBeDefined()
  })

  it("caps a listing at the entry maximum with disclosure", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_001; index++) files[`/work/${index}`] = ""
    const result = await execute(Effect.provide(Ls.run({ path: "/work", limit: 2_000 }), layer({ files })))
    expect(result.entries).toHaveLength(1_000)
    expect(result.truncated).toBe(true)
    expect(result.notice).toBeDefined()
  })

  // The page is cut after every entry is described, not before. A kind is a
  // stat away and the promised order puts directories first, so describing
  // only the page made the order local to it. Statting the whole directory is
  // the price of an order a caller can page through, and it is paid once per
  // entry.
  it("stats every entry exactly once, then cuts the page out of the whole order", async () => {
    const entryStats: Array<string> = []
    const host = FileSystem.makeNoop({
      stat: (path) => {
        if (path === "/work") return Effect.succeed(fileInfo({ type: "Directory" }))
        entryStats.push(path)
        return Effect.succeed(fileInfo({ type: path === "/work/d" ? "Directory" : "File" }))
      },
      readDirectory: () => Effect.succeed(["e", "d", "c", "b", "a"])
    })
    const result = await execute(Effect.provide(
      Effect.provideService(Ls.run({ path: "/work", offset: 2, limit: 2 }), FileSystem.FileSystem, host),
      layer()
    ))

    // Whole order: d/ (the only directory), then a, b, c, e.
    expect(result.entries).toEqual([{ name: "a", kind: "file" }, { name: "b", kind: "file" }])
    expect(result.total).toBe(5)
    expect([...entryStats].sort()).toEqual(["/work/a", "/work/b", "/work/c", "/work/d", "/work/e"])
  })

  it("fails with a typed not_found error for a missing directory", async () => {
    const exit = await execute(Effect.provide(Effect.exit(Ls.run({ path: "/missing" })), layer({ files: {} })))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("not_found")
    }
  })

  it("fails with not_a_directory when the path is a file", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Ls.run({ path: "/work/file.txt" })),
      layer({ files: { "/work/file.txt": "content" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error).toMatchObject({
        code: "not_a_directory",
        path: "/work/file.txt"
      })
    }
  })

  it("fails when the offset is past the last entry", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Ls.run({ path: "/work", offset: 4 })),
      layer({ files: { "/work/a": "", "/work/b": "", "/work/c": "" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error).toMatchObject({
        code: "offset_out_of_range",
        path: "/work"
      })
    }
  })

  it("answers an empty page for an empty directory rather than refusing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flows-ls-empty-"))
    try {
      const result = await execute(Effect.provide(
        Ls.run({ path: directory }),
        Layer.merge(NodeFileSystem.layer, NodePath.layer)
      ))
      expect(result.entries).toEqual([])
      expect(result.total).toBe(0)
      expect(result.truncated).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // The order is a property of the listing, not of the page. Statting only the
  // page and moving directories first inside it meant `[zdir/, a.txt]` unpaged
  // and `[a.txt]` then `[zdir/]` at `limit: 1`, so an agent paging a large
  // directory saw one entry twice and another never.
  it("pages a listing in the same order it returns unpaged", async () => {
    const files = {
      "/work/a.txt": "a",
      "/work/m.txt": "m",
      "/work/zdir/inner.txt": "inner",
      "/work/bdir/inner.txt": "inner"
    }
    const unpaged = await execute(Effect.provide(Ls.run({ path: "/work" }), layer({ files })))

    const paged: Array<{ readonly name: string; readonly kind: string }> = []
    for (let offset = 1; offset <= unpaged.total; offset++) {
      const page = await execute(Effect.provide(Ls.run({ path: "/work", offset, limit: 1 }), layer({ files })))
      expect(page.total).toBe(unpaged.total)
      paged.push(...page.entries)
    }

    expect(unpaged.entries).toEqual([
      { name: "bdir/", kind: "directory" },
      { name: "zdir/", kind: "directory" },
      { name: "a.txt", kind: "file" },
      { name: "m.txt", kind: "file" }
    ])
    expect(paged).toEqual(unpaged.entries)
  })

  it("reports a page as truncated only while entries remain after it", async () => {
    const files = { "/work/a.txt": "a", "/work/zdir/inner.txt": "inner" }
    const first = await execute(Effect.provide(Ls.run({ path: "/work", limit: 1 }), layer({ files })))
    const last = await execute(Effect.provide(Ls.run({ path: "/work", offset: 2, limit: 1 }), layer({ files })))

    expect(first.truncated).toBe(true)
    expect(first.notice).toBe("Showing 1 of 2 entries; output was truncated.")
    expect(last.truncated).toBe(false)
    expect(last.notice).toBeUndefined()
  })

  it("declares sealed hermetic effects and narrows each invocation", () => {
    expect(Ls.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Ls.effectsFor({ path: "/a.txt" }).reads).toEqual(["/a.txt"])
  })
})
