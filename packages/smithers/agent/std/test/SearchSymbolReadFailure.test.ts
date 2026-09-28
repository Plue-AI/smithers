import { NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import { Context, Effect, PlatformError } from "effect"
import * as FileSystem from "effect/FileSystem"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Grep from "../src/Grep.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as PortableSearch from "../src/PortableSearch.ts"
import * as Search from "../src/Search.ts"

describe("optional search symbol source read", () => {
  it.each(["portable", "native"] as const)(
    "%s preserves actual matches when optional source inspection fails and attaches symbols after recovery",
    async (implementation) => {
      const root = mkdtempSync(join(tmpdir(), "std-symbol-read-"))
      const target = join(root, "source.ts")
      const reads: Array<string> = []
      try {
        writeFileSync(target, "function example() {\n  return 'needle'\n}\n")
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const services = yield* Effect.context<
              FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
            >()
            const fs = yield* FileSystem.FileSystem
            let broken = true
            const refuse = () =>
              Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFile",
                pathOrDescriptor: target
              }))
            const host: FileSystem.FileSystem = {
              ...fs,
              readFile: (path) => {
                reads.push(path)
                return broken ? refuse() : fs.readFile(path)
              },
              readFileString: (path, options) => {
                reads.push(path)
                return broken ? refuse() : fs.readFileString(path, options)
              }
            }
            const context = Context.add(services, FileSystem.FileSystem, host)
            const search = implementation === "native" ? NativeSearch.make(context) : PortableSearch.make(context)
            const input = { root, pattern: "needle", symbols: true }
            const failedRead = yield* Grep.run(input).pipe(Effect.provideService(Search.Search, search))
            broken = false
            return { failedRead, recovered: yield* Grep.run(input).pipe(Effect.provideService(Search.Search, search)) }
          }).pipe(Effect.provide(NodeServices.layer))
        )
        expect(result.failedRead).toEqual({
          matches: [{ file: target, line: 2, text: "  return 'needle'", before: [], after: [] }],
          files: [],
          filesSearched: 1,
          skippedBinary: 0,
          truncated: false
        })
        expect(result.recovered).toEqual({
          matches: [{
            file: target,
            line: 2,
            text: "  return 'needle'",
            before: [],
            after: [],
            symbol: { kind: "function", name: "example", startLine: 1, endLine: 3 }
          }],
          files: [],
          filesSearched: 1,
          skippedBinary: 0,
          truncated: false
        })
        expect(reads).toEqual([target, target])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
