import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Rooted from "@smthrs/kernel/Rooted"
import * as Grep from "@smthrs/std/Grep"
import * as PortableSearch from "@smthrs/std/PortableSearch"
import * as Search from "@smthrs/std/Search"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, FileSystem, Layer, Result } from "effect"
import * as ServiceContext from "effect/Context"
import type * as Path from "effect/Path"
import * as fs from "node:fs"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Reads from "../src/reads.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** `<base>/repo` holding `src/math.js`, beside `<base>/secret.txt` outside it. */
const workspace = () => {
  const base = mkdtempSync(join(tmpdir(), "tui-reads-"))
  roots.push(base)
  const cwd = join(base, "repo")
  mkdirSync(join(cwd, "src"), { recursive: true })
  writeFileSync(join(base, "secret.txt"), "secret outside\n")
  writeFileSync(join(cwd, "src", "math.js"), "export const formatPrice = 1\n")
  return { base, cwd }
}

/** The host's services: relative paths resolve against `cwd`. */
const rooted = (cwd: string) =>
  Effect.runSync(
    Effect.context<FileSystem.FileSystem | Path.Path>().pipe(
      Effect.provide(Rooted.layer(cwd).pipe(Layer.provideMerge(NodeServices.layer)))
    )
  )
const confined = (cwd: string) => ServiceContext.get(Reads.confine(rooted(cwd), cwd), FileSystem.FileSystem)
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))
/** The failure's system reason and description. */
const reason = <A>(result: Result.Result<A, unknown>) => {
  expect(Result.isFailure(result)).toBe(true)
  const error = (result as Result.Failure<A, { readonly reason: { _tag: string; description?: string } }>).failure
  return { tag: error.reason._tag, description: error.reason.description }
}

describe("Reads.refusal", () => {
  test("allows the workspace, refuses outside it and a symlink loop", async () => {
    const { base, cwd } = workspace()
    symlinkSync("loop", join(cwd, "loop"))
    expect(Reads.refusal(cwd, "src/math.js")).toBeUndefined()
    expect(Reads.refusal(cwd, ".")).toBeUndefined()
    expect(Reads.refusal(cwd, join(base, "secret.txt"))).toBe("outside this repository")
    expect(Reads.refusal(cwd, "../secret.txt")).toBe("outside this repository")
    expect(Reads.refusal(cwd, "loop")).toBe("too many symlinks")
    expect(Reads.refusal(cwd, "loop/deeper")).toBe("too many symlinks")
  })
})

describe("Reads.confine", () => {
  test("reads a file inside, directly or through a symlink that stays inside", async () => {
    const { cwd } = workspace()
    symlinkSync("math.js", join(cwd, "src", "alias.js"))
    const files = confined(cwd)
    const text = async (path: string) => new TextDecoder().decode(await Effect.runPromise(files.readFile(path)))
    expect(await text("src/math.js")).toBe("export const formatPrice = 1\n")
    expect(await text(join(cwd, "src", "alias.js"))).toBe("export const formatPrice = 1\n")
    expect(await Effect.runPromise(files.readFileString("src/alias.js"))).toBe("export const formatPrice = 1\n")
  })

  test("refuses where it opens a file or directory that lands outside", async () => {
    const { base, cwd } = workspace()
    symlinkSync(join(base, "secret.txt"), join(cwd, "src", "link.txt"))
    symlinkSync(base, join(cwd, "out"), "dir")
    const files = confined(cwd)
    expect(reason(await run(files.readFile("src/link.txt")))).toEqual({
      tag: "PermissionDenied",
      description: "outside this repository"
    })
    expect(reason(await run(files.readFile("../secret.txt"))).tag).toBe("PermissionDenied")
    expect(reason(await run(files.readDirectory("out")))).toEqual({
      tag: "PermissionDenied",
      description: "outside this repository"
    })
    expect((await Effect.runPromise(files.readDirectory("src"))).sort()).toEqual(["link.txt", "math.js"])
  })

  test("refuses a file whose symlink is swapped back inside after it was opened outside", async () => {
    const { base, cwd } = workspace()
    const link = join(cwd, "src", "link.txt")
    symlinkSync(join(base, "secret.txt"), link)
    const open = fs.openSync
    const spy = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const descriptor = open(...args)
      unlinkSync(link)
      symlinkSync("math.js", link)
      return descriptor
    })
    try {
      expect(reason(await run(confined(cwd).readFile("src/link.txt")))).toEqual({
        tag: "PermissionDenied",
        description: "changed while it was read"
      })
    } finally {
      spy.mockRestore()
    }
  })

  test("says a missing file is not found and an unreadable one is denied", async () => {
    const { cwd } = workspace()
    writeFileSync(join(cwd, "locked.txt"), "x")
    chmodSync(join(cwd, "locked.txt"), 0o000)
    const files = confined(cwd)
    expect(reason(await run(files.readFile("src/none.js"))).tag).toBe("NotFound")
    expect(reason(await run(files.readFile("src/none.js/deeper"))).tag).toBe("NotFound")
    expect(reason(await run(files.readFile("locked.txt"))).tag).toBe("PermissionDenied")
    expect(reason(await run(files.readFile("src"))).tag).toBe("Unknown")
  })

  test("refuses an open handle, so a search streams nothing and reads whole files", async () => {
    const { cwd } = workspace()
    const confinedServices = Reads.confine(rooted(cwd), cwd)
    const files = ServiceContext.get(confinedServices, FileSystem.FileSystem)
    expect(reason(await run(Effect.scoped(files.open("src/math.js"))))).toEqual({
      tag: "PermissionDenied",
      description: "read whole files only"
    })
    const found = await Effect.runPromise(
      Grep.run({ pattern: "formatPrice" }).pipe(
        Effect.provideService(Search.Search, PortableSearch.make(confinedServices))
      )
    )
    expect(found.matches.map((match) => match.line)).toEqual([1])
  })
})

describe("Reads.rechecked", () => {
  const answering = (files: ReadonlyArray<string>): Search.Search => ({
    grep: () => Effect.succeed({ matches: [], files, filesSearched: files.length, skippedBinary: 0, truncated: false }),
    glob: () => Effect.succeed({ paths: files, total: files.length, truncated: false })
  })

  test("passes a search whose files are still inside and not symlinks", async () => {
    const { cwd } = workspace()
    const output = await Effect.runPromise(
      Reads.rechecked(answering(["src/math.js"]), cwd).grep({} as Search.GrepInput)
    )
    expect(output.files).toEqual(["src/math.js"])
  })

  test("passes a matched file deleted since: there is nothing left to read", async () => {
    const { cwd } = workspace()
    const output = await Effect.runPromise(
      Reads.rechecked(answering(["src/gone.js"]), cwd).grep({} as Search.GrepInput)
    )
    expect(output.files).toEqual(["src/gone.js"])
  })

  test("refuses a search that matched a file now outside or now a symlink", async () => {
    const { base, cwd } = workspace()
    symlinkSync("math.js", join(cwd, "src", "alias.js"))
    const refused = async (files: ReadonlyArray<string>) => {
      const result = await run(Reads.rechecked(answering(files), cwd).grep({} as Search.GrepInput))
      expect(Result.isFailure(result)).toBe(true)
      const error = (result as Result.Failure<unknown, { code: string; message: string }>).failure
      return { code: error.code, message: error.message }
    }
    expect(await refused(["src/math.js", join(base, "secret.txt")])).toEqual({
      code: "permission_denied",
      message: `${join(base, "secret.txt")}: outside this repository`
    })
    expect(await refused(["src/alias.js"])).toEqual({
      code: "permission_denied",
      message: "src/alias.js: changed while it was read"
    })
  })

  test("leaves glob as it is", async () => {
    const { cwd } = workspace()
    const search = answering(["x"])
    expect(Reads.rechecked(search, cwd).glob).toBe(search.glob)
  })
})
