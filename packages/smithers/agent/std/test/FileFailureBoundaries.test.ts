import { Effect, FileSystem, PlatformError } from "effect"
import { expect, it } from "vitest"
import * as Read from "../src/Read.ts"
import * as Write from "../src/Write.ts"
import * as Edit from "../src/Edit.ts"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import { fileInfo, layer } from "./TestLayers.ts"

// Fault injection belongs at the filesystem boundary: publication and cleanup
// counters prove that reporting a failed write does not publish its staging file.
it.each([
  ["write", "parent", "Unknown"],
  ["write", "inspect", "Unknown"],
  ["write", "stage", "Unknown"],
  ["write", "mode", "Unknown"],
  ["edit", "stage", "Unknown"],
  ["edit", "stage", "PermissionDenied"],
  ["edit", "mode", "Unknown"],
  ["patch", "stage", "Unknown"],
  ["patch", "stage", "PermissionDenied"] as const
])("%s preserves original bytes after %s fails with %s", async (tool, point, reason) => {
  let publications = 0
  let cleanups = 0
  let staged = false
  let inspections = 0
  const fail = (method: string) => Effect.fail(PlatformError.systemError({
    _tag: reason, module: "FileSystem", method
  }))
  const host = FileSystem.makeNoop({
    exists: () => Effect.succeed(true),
    realPath: (path) => Effect.succeed(path),
    makeDirectory: () => point === "parent" ? fail("makeDirectory") : Effect.void,
    stat: (path) => {
      inspections++
      return point === "inspect" ? fail("stat") :
        Effect.succeed(fileInfo({ mode: point === "mode" && path !== "/a" ? 0o755 : 0o644 }))
    },
    readFile: () => Effect.succeed(new TextEncoder().encode("original\n")),
    writeFile: () => point === "stage" ? fail("writeFile") : Effect.sync(() => { staged = true }),
    writeFileString: () => point === "stage" ? fail("writeFileString") : Effect.sync(() => { staged = true }),
    chmod: () => fail("chmod"),
    rename: () => Effect.sync(() => { publications++ }),
    remove: () => Effect.sync(() => { cleanups++ })
  })
  const action = tool === "write" ? Write.run({ path: "/a", content: "new" }) :
    tool === "edit" ? Edit.run({ path: "/a", oldString: "original", newString: "new" }) :
    ApplyPatch.run({ input: "*** Begin Patch\n*** Update File: /a\n@@\n-original\n+new\n*** End Patch" })
  const failure = await Effect.runPromise(action.pipe(
    Effect.provideService(FileSystem.FileSystem, host), Effect.flip, Effect.provide(layer())
  ))
  expect(failure).toMatchObject({ code: reason === "PermissionDenied" ? "permission_denied" : "command_failed", path: "/a" })
  expect(publications).toBe(0)
  if (point === "mode") {
    expect(failure.message).toContain("preserve the mode")
    expect(staged).toBe(true)
    expect(cleanups).toBeGreaterThan(0)
  }
  if (point === "inspect") expect(inspections).toBe(1)
})

it.each(["oversized", "invalid UTF-8"])("read refuses %s without recording a read base", async (kind) => {
  let reads = 0
  let recorded = 0
  const host: Read.VersionedFileSystem = {
    ...FileSystem.makeNoop({
      stat: () => Effect.succeed(fileInfo({ size: kind === "oversized" ? Read.MAX_READ_FILE_BYTES + 1 : 2 })),
      readFile: () => Effect.sync(() => { reads++; return new Uint8Array([0xc3, 0x28]) })
    }),
    [Read.Preconditions]: {
      record: () => Effect.sync(() => { recorded++ }), validate: () => Effect.void
    }
  }
  const failure = await Effect.runPromise(Read.run({ path: "/a" }).pipe(
    Effect.provideService(FileSystem.FileSystem, host), Effect.flip
  ))
  expect(failure).toMatchObject({ path: "/a", code: kind === "oversized" ? "response_too_large" : "binary_file" })
  expect(reads).toBe(kind === "oversized" ? 0 : 1)
  expect(recorded).toBe(0)
})

it("write tolerates an unavailable existence hint while preserving content publication", async () => {
  let published = ""
  let staged = ""
  const host = FileSystem.makeNoop({
    exists: () => Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "exists" })),
    stat: () => Effect.succeed(fileInfo()),
    realPath: (path) => Effect.succeed(path),
    makeDirectory: () => Effect.void,
    writeFileString: (_path, text) => Effect.sync(() => { staged = text }),
    rename: () => Effect.sync(() => { published = staged }),
    remove: () => Effect.void
  })
  const result = await Effect.runPromise(Write.run({ path: "/a", content: "new" }).pipe(
    Effect.provideService(FileSystem.FileSystem, host), Effect.provide(layer())
  ))
  expect(published).toBe("new")
  expect(result).toEqual({ path: "/a", bytesWritten: 3, created: true })
})

it("patch permission declarations retain all affected paths in the static envelope", () => {
  const effects = ApplyPatch.effectsFor({ input: "*** Begin Patch\n*** Move to: /another\n*** End Patch" })
  expect(effects).toMatchObject({ tier: "compensable", mode: "hermetic", reads: ["/**"], writes: ["/**"] })
})
