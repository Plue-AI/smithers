import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem, Option, Path, PlatformError } from "effect"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import { rootFailure } from "../src/internal/SearchContract.ts"
import * as Ls from "../src/Ls.ts"
import * as Read from "../src/Read.ts"
import type * as StdError from "../src/StdError.ts"
import * as Write from "../src/Write.ts"
import { fileInfo, layer } from "./TestLayers.ts"

const refusal = (tag: PlatformError.SystemErrorTag) => (method: string) =>
  Effect.fail(PlatformError.systemError({ _tag: tag, module: "FileSystem", method, pathOrDescriptor: "/f" }))

/** A host that refuses every operation with one reason. */
const refusing = (tag: PlatformError.SystemErrorTag) => {
  const fail = refusal(tag)
  return FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    stat: () => fail("stat"),
    realPath: () => fail("realPath"),
    readFile: () => fail("readFile"),
    readDirectory: () => fail("readDirectory"),
    makeDirectory: () => fail("makeDirectory"),
    writeFile: () => fail("writeFile"),
    writeFileString: () => fail("writeFileString")
  })
}

const failure = async (
  effect: Effect.Effect<unknown, StdError.StdError, FileSystem.FileSystem | Path.Path>,
  host: FileSystem.FileSystem
) => {
  const exit = await Effect.runPromise(
    Effect.provide(Effect.exit(Effect.provideService(effect, FileSystem.FileSystem, host)), layer())
  )
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
}

const flows = [
  { name: "read", run: Read.run({ path: "/f" }) },
  { name: "write", run: Write.run({ path: "/f", content: "x" }) },
  { name: "edit", run: Edit.run({ path: "/f", oldString: "a", newString: "b" }) },
  { name: "ls", run: Ls.run({ path: "/f" }) },
  {
    name: "apply_patch",
    run: ApplyPatch.run({ input: "*** Begin Patch\n*** Update File: /f\n@@\n-a\n+b\n*** End Patch" })
  }
] as const

describe("filesystem failure reasons", () => {
  for (const flow of flows) {
    it(`${flow.name} reports a denial as permission_denied, never as a missing file`, async () => {
      expect(await failure(flow.run, refusing("PermissionDenied"))).toMatchObject({ code: "permission_denied" })
    })
  }

  it("keeps not_found for a missing file and names any other reason", async () => {
    expect(await failure(Read.run({ path: "/f" }), refusing("NotFound"))).toMatchObject({ code: "not_found" })
    expect(await failure(Read.run({ path: "/f" }), refusing("Busy"))).toMatchObject({
      code: "command_failed",
      message: expect.stringContaining("Busy")
    })
  })

  it("maps a denied search root to permission_denied", () => {
    const error = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "stat" })
    expect(rootFailure("/root", error)).toMatchObject({ code: "permission_denied", path: "/root" })
  })
})

describe("read size bound", () => {
  it("refuses a file over the bound before loading it", async () => {
    let reads = 0
    const host = FileSystem.makeNoop({
      stat: () => Effect.succeed(fileInfo({ size: Read.MAX_READ_FILE_BYTES + 1 })),
      readFile: () =>
        Effect.sync(() => {
          reads++
          return new Uint8Array()
        })
    })
    expect(await failure(Read.run({ path: "/big.log", limit: 5 }), host)).toMatchObject({
      code: "response_too_large",
      path: "/big.log",
      message: expect.stringContaining(String(Read.MAX_READ_FILE_BYTES + 1))
    })
    expect(reads).toBe(0)
  })

  it("refuses a sparse file over 2 GiB with its size, not as a missing file", async () => {
    const size = 3 * 1024 * 1024 * 1024
    const error = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const path = `${dir}/big.log`
        yield* fs.writeFileString(path, "")
        yield* fs.truncate(path, size)
        return yield* Effect.flip(Read.run({ path, limit: 5 }))
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
    expect(error).toMatchObject({ code: "response_too_large", message: expect.stringContaining(String(size)) })
  })
})
