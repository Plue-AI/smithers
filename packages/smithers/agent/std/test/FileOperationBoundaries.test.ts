import { NodeServices } from "@effect/platform-node"
import { Effect, PlatformError } from "effect"
import * as FileSystem from "effect/FileSystem"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Ls from "../src/Ls.ts"
import * as Read from "../src/Read.ts"
import * as Write from "../src/Write.ts"

describe("file tools preserve source data across host failures", () => {
  it("a failed existence probe cannot bypass a later inspection refusal or mutate existing bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-write-exists-"))
    const target = join(root, "file.txt")
    const probes: Array<string> = []
    try {
      writeFileSync(target, "original guarded bytes")
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const refuse = (method: string) =>
            Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method,
              pathOrDescriptor: target
            }))
          return yield* Effect.flip(
            Write.run({ path: target, content: "unauthorized replacement" }).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                exists: () => {
                  probes.push("exists")
                  return refuse("exists")
                },
                stat: (path) => {
                  probes.push("stat")
                  return path === target ? refuse("stat") : fs.stat(path)
                }
              })
            )
          )
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(error).toMatchObject({ code: "permission_denied", path: target, message: `Permission denied: ${target}` })
      expect(probes).toEqual(["exists", "stat"])
      expect(readFileSync(target, "utf8")).toBe("original guarded bytes")
      expect(readdirSync(root)).toEqual(["file.txt"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  const writeFailures = (["stat", "makeDirectory", "writeFileString", "rename"] as const).flatMap((method) =>
    (["PermissionDenied", "Unknown"] as const).map((tag) => ({ method, tag }))
  )
  it.each(writeFailures)(
    "Write $method $tag preserves the original, cleans staging, and supports retry",
    async ({ method, tag }) => {
      const root = mkdtempSync(join(tmpdir(), "std-write-error-"))
      const target = join(root, "file.txt")
      const attempts: Array<string> = []
      try {
        writeFileSync(target, "original bytes")
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            let broken = true
            const refuse = () => {
              attempts.push(method)
              return Effect.fail(PlatformError.systemError({
                _tag: tag,
                module: "FileSystem",
                method,
                description: "private provider detail"
              }))
            }
            // Inject one genuine filesystem operation failure; all other operations
            // execute against the real temporary directory.
            const host: FileSystem.FileSystem = {
              ...fs,
              stat: (path) => broken && method === "stat" ? refuse() : fs.stat(path),
              makeDirectory: (path, options) =>
                broken && method === "makeDirectory" ? refuse() : fs.makeDirectory(path, options),
              writeFileString: (path, content, options) =>
                broken && method === "writeFileString" ? refuse() : fs.writeFileString(path, content, options),
              rename: (from, to) => broken && method === "rename" ? refuse() : fs.rename(from, to)
            }
            const error = yield* Effect.flip(
              Write.run({ path: target, content: "failed replacement" }).pipe(
                Effect.provideService(FileSystem.FileSystem, host)
              )
            )
            const unchanged = readFileSync(target, "utf8")
            const afterFailure = readdirSync(root)
            broken = false
            const retry = yield* Write.run({ path: target, content: "repaired é" }).pipe(
              Effect.provideService(FileSystem.FileSystem, host)
            )
            return {
              error,
              unchanged,
              afterFailure,
              retry,
              contents: readFileSync(target, "utf8"),
              afterRetry: readdirSync(root)
            }
          }).pipe(Effect.provide(NodeServices.layer))
        )
        const message = tag === "PermissionDenied" ? `Permission denied: ${target}` : method === "stat"
          ? `Could not inspect ${target} before writing` :
          method === "makeDirectory"
          ? `Could not create the parent directory of ${target}` :
          `Could not write ${target}`
        expect(result.error).toMatchObject({
          code: tag === "PermissionDenied" ? "permission_denied" : "command_failed",
          path: target,
          message
        })
        expect(result.error.message).not.toContain("private provider detail")
        expect(result.unchanged).toBe("original bytes")
        expect(result.afterFailure).toEqual(["file.txt"])
        expect(result.retry).toEqual({ path: target, bytesWritten: 11, created: false })
        expect(result.contents).toBe("repaired é")
        expect(result.afterRetry).toEqual(["file.txt"])
        expect(attempts).toEqual([method])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each(
    [
      ["truncated multibyte", [0xc3]],
      ["stray continuation", [0x80]],
      ["overlong", [0xc0, 0xaf]],
      ["encoded surrogate", [0xed, 0xa0, 0x80]],
      ["above Unicode maximum", [0xf4, 0x90, 0x80, 0x80]]
    ] as const
  )("Read refuses %s UTF-8 without replacement characters and recovers after repair", async (_, bytes) => {
    const root = mkdtempSync(join(tmpdir(), "std-read-utf8-"))
    const target = join(root, "source.txt")
    try {
      writeFileSync(target, new Uint8Array(bytes))
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const error = yield* Effect.flip(Read.run({ path: target }))
          writeFileSync(target, "valid é\nsecond")
          return { error, retry: yield* Read.run({ path: target }) }
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result.error).toMatchObject({
        code: "binary_file",
        path: target,
        message: `File is not valid UTF-8: ${target}`
      })
      expect(result.retry).toEqual({
        content: "valid é\nsecond",
        startLine: 1,
        endLine: 2,
        totalLines: 2,
        truncated: false
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(["dangling link", "guard refusal"] as const)(
    "Ls retains a real %s entry in the same directory-first order across pages",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "std-ls-entry-"))
      const problematic = join(root, "broken")
      try {
        mkdirSync(join(root, "zdir"))
        writeFileSync(join(root, "afile"), "source")
        if (kind === "dangling link") symlinkSync(join(root, "missing-target"), problematic)
        else writeFileSync(problematic, "guarded bytes")
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const host: FileSystem.FileSystem = {
              ...fs,
              stat: (path) =>
                kind === "guard refusal" && path === problematic ?
                  Effect.fail(PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "stat",
                    pathOrDescriptor: path
                  })) :
                  fs.stat(path)
            }
            const full = yield* Ls.run({ path: root }).pipe(Effect.provideService(FileSystem.FileSystem, host))
            const pages = yield* Effect.forEach([1, 2, 3], (offset) =>
              Ls.run({ path: root, offset, limit: 1 }).pipe(
                Effect.provideService(FileSystem.FileSystem, host)
              ))
            return { full, pages }
          }).pipe(Effect.provide(NodeServices.layer))
        )
        expect(result.full).toEqual({
          entries: [{ name: "zdir/", kind: "directory" }, { name: "afile", kind: "file" }, {
            name: "broken",
            kind: "file"
          }],
          total: 3,
          truncated: false
        })
        expect(result.pages).toEqual([
          {
            entries: [{ name: "zdir/", kind: "directory" }],
            total: 3,
            truncated: true,
            notice: "Showing 1 of 3 entries; output was truncated."
          },
          {
            entries: [{ name: "afile", kind: "file" }],
            total: 3,
            truncated: true,
            notice: "Showing 1 of 3 entries; output was truncated."
          },
          { entries: [{ name: "broken", kind: "file" }], total: 3, truncated: false }
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
