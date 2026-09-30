import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { hostPath } from "./HostPath.ts"
import { sha256, withCrypto } from "./Sha256.ts"
import { win32Host } from "./Win32Host.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const descriptor = (input: Partial<FileBoundary> = {}): FileBoundary => ({
  readSet: input.readSet ?? [],
  writeSet: input.writeSet ?? [],
  ...(input.removes === undefined ? {} : { removes: input.removes }),
  boundaryMode: input.boundaryMode ?? "hard"
})

const read = (path: string, content: string) => ({ path, digest: sha256(content) })

const text = (files: ReadonlyArray<WorkspaceSandbox.HostFile>, path: string): string | undefined => {
  const file = files.find((candidate) => candidate.path === path)
  return file === undefined ? undefined : decoder.decode(file.content)
}

/**
 * In-memory hosts cannot represent a symlink, so they attest whole-volume
 * isolation, which is what copy-back requires of a host.
 */
const isolated = KernelFileSystem.withIsolatedFileSystem

const lockChild = new URL("./fixtures/workspace-lock-child.ts", import.meta.url)

/**
 * The lease operations the commit lock makes (`@smthrs/artifacts/FileLease`),
 * over a fake host's file map: an exclusive `wx` create, an owner read, and
 * the release.
 */
const leaseOps = (files: Map<string, Uint8Array>) => ({
  writeFileString:
    ((path: string, data: string, options?: { readonly flag?: string }) =>
      Effect.suspend(() =>
        options?.flag === "wx" && files.has(path)
          ? Effect.fail(PlatformError.systemError({ _tag: "AlreadyExists", module: "test", method: "writeFileString" }))
          : Effect.sync(() => void files.set(path, encoder.encode(data)))
      )) as never,
  readFileString: ((path: string) =>
    Effect.suspend(() => {
      const bytes = files.get(path)
      return bytes === undefined
        ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "readFileString" }))
        : Effect.succeed(decoder.decode(bytes))
    })) as never,
  remove: ((path: string) => Effect.sync(() => void files.delete(path))) as never
})

/**
 * A descriptor-relative host whose every request runs through `around`, so a
 * test can hold, observe, or fail the exact call copy-back issues.
 */
const intercept = (
  fs: FileSystem.FileSystem,
  around: (
    request: KernelFileSystem.AtomicRequest,
    proceed: Effect.Effect<unknown, PlatformError.PlatformError>
  ) => Effect.Effect<unknown, PlatformError.PlatformError>
): FileSystem.FileSystem => {
  const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
  return KernelFileSystem.withAtomicFileSystem({ ...fs }, {
    ...atomic,
    execute: (request) => around(request, atomic.execute(request)) as never
  })
}

const injected = (path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "writeFile",
    pathOrDescriptor: path,
    description: "injected device failure"
  })

/**
 * The eight behaviors the `agent` proof of concept documented, ported
 * onto this side's declaration vocabulary (`FileBoundary` rather than
 * `Effects.Declaration`) and its identity surfaces (`@smthrs/crypto` rather
 * than the deleted `@smthrs/keys` digest module).
 */
describe("WorkspaceSandbox conformance", () => {
  it.effect("uses an immutable declaration even when the workflow mutates every nested field", () =>
    Effect.gen(function*() {
      const test = yield* withCrypto(WorkspaceSandbox.makeMemory({
        "src/input.txt": "input",
        "secret/value.txt": "secret",
        "protected.txt": "keep"
      }))
      const readGlob = {
        _tag: "Glob" as const,
        include: ["src/**"] as [string, ...Array<string>],
        exclude: ["src/ignored/**"]
      }
      const declaration = descriptor({
        readSet: [readGlob],
        writeSet: ["out/declared.txt"],
        removes: [],
        boundaryMode: "hard"
      })
      const result = yield* withCrypto(test.service.execute({
        descriptor: declaration,
        workflow: Effect.gen(function*() {
          ;(readGlob.include as Array<string>).push("secret/**")
          ;(readGlob.exclude as Array<string>).splice(0)
          ;(declaration.readSet as Array<never>).push(read("secret/value.txt", "secret") as never)
          ;(declaration.writeSet as Array<string>).push("out/surprise.txt")
          ;(declaration.removes as Array<string>).push("protected.txt")
          ;(declaration as { boundaryMode: string }).boundaryMode = "expected"
          const fs = yield* FileSystem.FileSystem
          yield* fs.readFileString("secret/value.txt")
          yield* fs.writeFileString("out/surprise.txt", "surprise")
          yield* fs.remove("protected.txt")
          return null
        })
      }))

      expect(result._tag).toBe("Invalidated")
      if (result._tag !== "Invalidated") return
      expect(result.violations.map((violation) => [violation.kind, violation.resource.id])).toEqual([
        ["undeclared-read", "secret/value.txt"],
        ["undeclared-write", "out/surprise.txt"],
        ["undeclared-write", "protected.txt"]
      ])
      expect(text(yield* test.files, "protected.txt")).toBe("keep")
      expect(text(yield* test.files, "out/surprise.txt")).toBeUndefined()
    }))

  it.effect("copies host snapshot buffers before an asynchronous workflow can observe mutation", () =>
    withCrypto(Effect.scoped(Effect.gen(function*() {
      const shared = encoder.encode("original")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const service = WorkspaceSandbox.makeHosted({
        root: "",
        snapshot: () => Effect.succeed(new Map([["input.txt", shared]])),
        baseline: () => Effect.succeed(undefined),
        retain: (bytes) => Effect.succeed(bytes.slice()),
        commit: () => Effect.void
      })
      const running = yield* service.execute({
        descriptor: descriptor({ readSet: [read("input.txt", "original")] }),
        workflow: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("input.txt")))
        )
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      shared.set(encoder.encode("mutated!"))
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(running)

      expect(result._tag).toBe("Accepted")
      if (result._tag !== "Accepted") return
      expect(result.result.output).toBe("original")
      expect(result.result.provenance.inputs).toEqual([
        { resource: { kind: "file", id: "input.txt" }, digest: sha256("original") }
      ])
    }))))

  it.effect("returns functional files and queued effects without changing the host before materialization", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/input.txt": "hello" })
        const accepted = yield* test.service.execute({
          descriptor: descriptor({ readSet: [read("src/input.txt", "hello")], writeSet: ["out/result.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            const input = decoder.decode(yield* workspace.readFile("src/input.txt"))
            yield* workspace.writeFile("out/result.txt", encoder.encode(`${input} world`))
            yield* workspace.queueEffect({
              protocol: "chat/v1",
              idempotencyKey: "reply-1",
              payload: { message: "finished" }
            })
            return { rendered: true, count: 1 }
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        const before = yield* test.files
        yield* test.service.materialize(accepted)
        return { accepted, before, after: yield* test.files }
      })

      const { accepted, after, before } = yield* withCrypto(program)
      expect(text(before, "out/result.txt")).toBeUndefined()
      expect(accepted.result.output).toEqual({ rendered: true, count: 1 })
      expect(accepted.result.provenance.inputs).toHaveLength(1)
      expect(accepted.result.provenance.outputs).toEqual([
        { resource: { kind: "file", id: "out/result.txt" }, operation: "write", digest: sha256("hello world") }
      ])
      expect(accepted.result.effects).toEqual([{
        protocol: "chat/v1",
        idempotencyKey: "reply-1",
        payload: { message: "finished" }
      }])
      expect(decoder.decode(accepted.result.files[0]?.after)).toBe("hello world")
      expect(text(after, "out/result.txt")).toBe("hello world")
    }))

  it.effect("accepts writes covered by tree-artifact and glob declarations", () =>
    Effect.gen(function*() {
      const test = yield* withCrypto(WorkspaceSandbox.makeMemory())
      const accepted = yield* withCrypto(test.service.execute({
        descriptor: descriptor({
          writeSet: [
            { _tag: "TreeArtifact", path: "tree" },
            { _tag: "Glob", include: ["generated/**/*.js"], exclude: ["generated/skip/**"] },
            { _tag: "Glob", include: ["assets/**"] }
          ]
        }),
        workflow: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("tree/a.txt", "a")
          yield* fs.writeFileString("generated/nested/a.js", "a")
        })
      }))
      expect(accepted._tag).toBe("Accepted")
    }))

  it.effect("invalidates and discards undeclared reads and writes", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({
          "src/declared.txt": "declared",
          "src/secret.txt": "secret"
        })
        const invalidated = yield* test.service.execute({
          descriptor: descriptor({ readSet: [read("src/declared.txt", "declared")], writeSet: ["out/declared.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            const secret = yield* workspace.readFile("src/secret.txt")
            yield* workspace.writeFile("out/surprise.txt", secret)
            yield* workspace.queueEffect({
              protocol: "chat/v1",
              idempotencyKey: "must-not-dispatch",
              payload: { leaked: true }
            })
            return { leaked: true }
          })
        })
        return { invalidated, files: yield* test.files }
      })

      const { files, invalidated } = yield* withCrypto(program)
      expect(invalidated).toMatchObject({
        _tag: "Invalidated",
        violations: [
          { kind: "undeclared-read", resource: { kind: "file", id: "src/secret.txt" } },
          { kind: "undeclared-write", resource: { kind: "file", id: "out/surprise.txt" } }
        ]
      })
      // The candidate output, files, and queued effects have no accessor at all
      // on the `Invalidated` shape: nothing leaks, by construction.
      expect(Object.keys(invalidated).sort()).toEqual(["_tag", "provenance", "violations"])
      expect(text(files, "out/surprise.txt")).toBeUndefined()
    }))

  it.effect("replays memoized results by content identity without rerunning the body", () =>
    Effect.gen(function*() {
      let runs = 0
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/input.txt": "same input" })
        const execution = {
          descriptor: descriptor({ readSet: [read("src/input.txt", "same input")], writeSet: ["out/result.txt"] }),
          cacheKey: "step-key",
          workflow: Effect.gen(function*() {
            runs = runs + 1
            const workspace = yield* WorkspaceSandbox.Workspace
            const input = yield* workspace.readFile("src/input.txt")
            yield* workspace.writeFile("out/result.txt", input)
            return { value: decoder.decode(input) }
          })
        }
        return [yield* test.service.execute(execution), yield* test.service.execute(execution)]
      })

      const [first, replay] = yield* withCrypto(program)
      expect(first).toMatchObject({ _tag: "Accepted", cache: { status: "miss", key: "step-key" } })
      expect(replay).toMatchObject({ _tag: "Accepted", cache: { status: "hit", key: "step-key" } })
      expect(runs).toBe(1)
    }))

  it.effect("refuses to materialize over a changed output base", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "out/result.txt": "base" })
        const execute = (value: string) =>
          test.service.execute({
            descriptor: descriptor({ writeSet: ["out/result.txt"] }),
            workflow: Effect.gen(function*() {
              const workspace = yield* WorkspaceSandbox.Workspace
              yield* workspace.writeFile("out/result.txt", encoder.encode(value))
              return { value }
            })
          })
        const stale = yield* execute("stale")
        const current = yield* execute("current")
        if (stale._tag !== "Accepted" || current._tag !== "Accepted") throw new Error("expected accepted executions")
        yield* test.service.materialize(current)
        const conflict = yield* Effect.flip(test.service.materialize(stale))
        return { conflict, files: yield* test.files }
      })

      const { conflict, files } = yield* withCrypto(program)
      expect(conflict).toMatchObject({
        _tag: "@smthrs/engine-store/MaterializationConflict",
        paths: ["out/result.txt"]
      })
      expect(text(files, "out/result.txt")).toBe("current")
    }))

  it.effect("supports removals and replays their functional result", () =>
    Effect.gen(function*() {
      let runs = 0
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "out/old.txt": "old" })
        const execution = {
          descriptor: descriptor({ removes: ["out/old.txt"] }),
          cacheKey: "removal",
          workflow: Effect.gen(function*() {
            runs = runs + 1
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.removeFile("out/old.txt")
            return ["removed"]
          })
        }
        const first = yield* test.service.execute(execution)
        const replay = yield* test.service.execute(execution)
        if (first._tag !== "Accepted" || replay._tag !== "Accepted") throw new Error("expected accepted executions")
        yield* test.service.materialize(replay)
        return { first, replay, files: yield* test.files }
      })

      const { files, first, replay } = yield* withCrypto(program)
      expect(first.result.files).toMatchObject([{
        path: "out/old.txt",
        beforeDigest: sha256("old"),
        afterDigest: undefined
      }])
      expect(first.result.provenance.outputs[0]?.operation).toBe("remove")
      expect(replay.cache.status).toBe("hit")
      expect(runs).toBe(1)
      expect(text(files, "out/old.txt")).toBeUndefined()
    }))

  it.effect("disables memoization when the caller supplies no cache key", () =>
    Effect.gen(function*() {
      let runs = 0
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        const execution = {
          descriptor: descriptor(),
          workflow: Effect.sync(() => {
            runs = runs + 1
            return { run: runs }
          })
        }
        return [yield* test.service.execute(execution), yield* test.service.execute(execution)]
      })

      const [first, second] = yield* withCrypto(program)
      expect(first).toMatchObject({ _tag: "Accepted", cache: { status: "disabled" } })
      expect(second).toMatchObject({ _tag: "Accepted", cache: { status: "disabled" } })
      expect(runs).toBe(2)
    }))

  it.effect("rejects invalid paths and missing files", () =>
    Effect.gen(function*() {
      for (const path of ["", "/absolute.txt", "nested/../escape.txt", "."]) {
        const invalid = yield* withCrypto(Effect.flip(WorkspaceSandbox.makeMemory({ [path]: "invalid" })))
        expect(invalid).toMatchObject({ _tag: "@smthrs/engine-store/WorkspaceError", code: "invalid_path" })
      }

      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "bytes.bin": encoder.encode("bytes") })
        const missing = yield* Effect.flip(test.service.execute({
          descriptor: descriptor({ readSet: [read("missing.txt", "")] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.readFile("missing.txt")
            return null
          })
        }))
        const escaping = yield* Effect.flip(test.service.execute({
          descriptor: descriptor({ writeSet: [{ _tag: "Glob", include: ["out/**"] }] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("../escape.txt", encoder.encode("no"))
            return null
          })
        }))
        const removing = yield* Effect.flip(test.service.execute({
          descriptor: descriptor(),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.removeFile("/absolute.txt")
            return null
          })
        }))
        return { escaping, files: yield* test.files, missing, removing }
      })

      const { escaping, files, missing, removing } = yield* withCrypto(program)
      expect(missing).toMatchObject({ code: "not_found" })
      expect(escaping).toMatchObject({ code: "invalid_path" })
      expect(removing).toMatchObject({ code: "invalid_path" })
      expect(text(files, "bytes.bin")).toBe("bytes")
    }))

  it.effect("normalizes relative paths and omits unchanged writes from the file diff", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/b.txt": "b", "src/a.txt": "a" })
        return yield* test.service.execute({
          descriptor: descriptor({
            readSet: [read("src/a.txt", "a")],
            writeSet: [{ _tag: "Glob", include: ["src/*.txt"] }]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            const input = yield* workspace.readFile("./src//a.txt")
            yield* workspace.writeFile("src\\a.txt", input)
            return { unchanged: true }
          })
        })
      })

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.files).toEqual([])
      expect(accepted.result.provenance.inputs[0]?.resource.id).toBe("src/a.txt")
      // A read of a declared file never counts against the declaration, and an
      // unchanged rewrite produces no output observation at all.
      expect(accepted.result.provenance.outputs).toEqual([])
    }))

  it.effect("derives workspace revisions canonically across object insertion order", () =>
    Effect.gen(function*() {
      const revision = (initialFiles: Readonly<Record<string, string>>) =>
        Effect.gen(function*() {
          const test = yield* WorkspaceSandbox.makeMemory(initialFiles)
          const accepted = yield* test.service.execute({
            descriptor: descriptor(),
            workflow: Effect.succeed(null)
          })
          if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
          return accepted.result.provenance.baseRevision
        })
      const forward = { "a.txt": "a", "b.txt": "b" }
      const reverse: Record<string, string> = {}
      reverse["b.txt"] = "b"
      reverse["a.txt"] = "a"

      const first = yield* withCrypto(revision(forward))
      const reordered = yield* withCrypto(revision(reverse))
      const changed = yield* withCrypto(revision({ "a.txt": "a", "b.txt": "changed" }))

      expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(reordered).toBe(first)
      expect(changed).not.toBe(first)
    }))

  it.effect("honors glob declarations without rewriting the characters inside them", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        return yield* test.service.execute({
          descriptor: descriptor({
            // `**` crosses directories, `*` does not, and a pattern containing a
            // literal space must survive translation intact — the placeholder the
            // translation uses is NUL precisely because a path cannot hold one.
            writeSet: [{ _tag: "Glob", include: ["deep/**", "flat/*.txt", "with space/*.txt"] }]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            for (
              const path of [
                "deep/a/b/c.txt",
                "flat/ok.txt",
                "with space/ok.txt",
                "flat/nested/too-deep.txt"
              ]
            ) {
              yield* workspace.writeFile(path, encoder.encode("x"))
            }
            return null
          })
        })
      })

      // Only the `*`-under-`flat/` write escapes coverage: `*` stops at a
      // separator, while `deep/**` and the space-bearing pattern both match.
      expect(yield* withCrypto(program)).toMatchObject({
        _tag: "Invalidated",
        violations: [{ kind: "undeclared-write", resource: { id: "flat/nested/too-deep.txt" } }]
      })
    }))

  it.effect("lets a declaration that names a path outside the workspace cover nothing", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        return yield* test.service.execute({
          // Neither entry can be named inside the workspace, so neither covers
          // the write the body actually performs.
          descriptor: descriptor({ writeSet: ["/outside.txt", "../escape.txt"] }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("inside.txt", encoder.encode("x"))
            return null
          })
        })
      })

      expect(yield* withCrypto(program)).toMatchObject({
        _tag: "Invalidated",
        violations: [{ kind: "undeclared-write", resource: { id: "inside.txt" } }]
      })
    }))

  it.effect("provides the implementation as an Effect layer", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory()
        const resolved = yield* WorkspaceSandbox.WorkspaceSandbox.pipe(
          Effect.provide(WorkspaceSandbox.layer(test.service))
        )
        return resolved === test.service
      })
      expect(yield* withCrypto(program)).toBe(true)
    }))
})

describe("WorkspaceSandbox expected mode", () => {
  it.effect("admits a deviating execution and leaves the deviation for the engine to journal", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/a.txt": "a" })
        const accepted = yield* test.service.execute({
          descriptor: descriptor({
            readSet: [read("src/a.txt", "a")],
            writeSet: ["out/declared.txt"],
            boundaryMode: "expected"
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("out/surprise.txt", encoder.encode("deviation"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return accepted
      })

      const accepted = yield* withCrypto(program)
      expect(
        WorkspaceSandbox.violations(
          descriptor({ writeSet: ["out/declared.txt"], boundaryMode: "expected" }),
          new Map(),
          accepted.result.provenance
        )
      ).toEqual([{ kind: "undeclared-write", resource: { kind: "file", id: "out/surprise.txt" } }])
    }))
})

/**
 * The transaction also seeds Effect's own `FileSystem` tag, which is how an
 * ordinary action body — one that never heard of `WorkspaceSandbox` — runs
 * isolated.
 */
describe("WorkspaceSandbox transaction filesystem", () => {
  for (const host of ["memory", "filesystem"] as const) {
    for (const probe of ["root listing", "directory presence", "empty root", "invalid paths"] as const) {
      it.effect(`${host}: supports ${probe}`, () =>
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const hostFs = yield* FileSystem.FileSystem
            const root = yield* hostFs.makeTempDirectoryScoped({ prefix: "wsx-directories-" })
            yield* hostFs.makeDirectory(`${root}/dir/nested`, { recursive: true })
            const initial = { "a.txt": "A", "dir/b.txt": "B", "dir/nested/c.txt": "C" }
            for (const [path, content] of Object.entries(initial)) {
              yield* hostFs.writeFileString(`${root}/${path}`, content)
            }
            const sandbox = host === "memory"
              ? (yield* WorkspaceSandbox.makeMemory(probe === "empty root" ? {} : initial)).service
              : WorkspaceSandbox.makeFileSystem(hostFs, hostPath, yield* ArtifactStore.ArtifactStore, root)
            const roots = host === "memory" ? [".", ""] : [".", "", root, `${root}/`]
            const result = yield* sandbox.execute({
              descriptor: descriptor({
                readSet: probe === "empty root"
                  ? []
                  : Object.entries(initial).map(([path, content]) => read(path, content)),
                writeSet: [{ _tag: "Glob", include: ["new/**"] }]
              }),
              workflow: Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                if (probe === "root listing" || probe === "empty root") {
                  for (const path of roots) {
                    expect(yield* fs.readDirectory(path)).toEqual(probe === "empty root" ? [] : ["a.txt", "dir"])
                    expect(yield* fs.exists(path)).toBe(true)
                  }
                } else if (probe === "directory presence") {
                  for (
                    const path of [
                      "dir",
                      "dir/nested",
                      "dir/",
                      "./dir",
                      ...(host === "filesystem" ? [`${root}/dir`] : [])
                    ]
                  ) {
                    expect(yield* fs.exists(path)).toBe(true)
                  }
                  expect(yield* fs.readDirectory("dir")).toEqual(["b.txt", "nested"])
                  expect(yield* fs.exists("a.txt")).toBe(true)
                  expect(yield* fs.exists("di")).toBe(false)
                  expect(yield* fs.exists("missing")).toBe(false)
                  yield* fs.writeFileString("new/file.txt", "new")
                  expect(yield* fs.exists("new")).toBe(true)
                  yield* fs.remove("new/file.txt")
                  expect(yield* fs.exists("new")).toBe(false)
                } else {
                  for (const path of [...roots, "..", "dir/../a.txt", `${root}/../escape.txt`]) {
                    expect((yield* Effect.flip(fs.writeFileString(path, "bad")))._tag).toBe("PlatformError")
                    expect((yield* Effect.flip(fs.remove(path)))._tag).toBe("PlatformError")
                    expect((yield* Effect.flip(fs.readFile(path)))._tag).toBe("PlatformError")
                  }
                  expect(yield* fs.exists("..")).toBe(false)
                  expect((yield* Effect.flip(fs.readDirectory("..")))._tag).toBe("PlatformError")
                }
              })
            })
            expect(result._tag).toBe("Accepted")
            expect(result.violations).toEqual([])
          })).pipe(Effect.provide(ArtifactStore.layerMemory.pipe(Layer.provideMerge(NodeFileSystem.layer))))
        ))
    }
  }

  it.effect("traces the files whose presence establishes an implicit directory", () =>
    withCrypto(Effect.gen(function*() {
      const test = yield* WorkspaceSandbox.makeMemory({ "secret/value.txt": "secret" })
      const result = yield* test.service.execute({
        descriptor: descriptor(),
        workflow: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          expect(yield* fs.exists("secret")).toBe(true)
        })
      })
      expect(result._tag).toBe("Invalidated")
      expect(result.violations).toMatchObject([
        { kind: "undeclared-read", resource: { kind: "file", id: "secret/value.txt" } }
      ])
    })))

  it.effect("serves an ordinary FileSystem body over the transaction", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const test = yield* WorkspaceSandbox.makeMemory({ "src/in.txt": "seed", "src/nested/deep.txt": "deep" })
        const accepted = yield* test.service.execute({
          descriptor: descriptor({
            readSet: [
              read("src/in.txt", "seed"),
              read("src/nested/deep.txt", "deep"),
              read("out/nope.txt", "absent")
            ],
            writeSet: [{ _tag: "Glob", include: ["out/**"] }, "src/in.txt"]
          }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const present = yield* fs.exists("src/in.txt")
            const absent = yield* fs.exists("/escape.txt")
            const bytes = yield* fs.readFile("src/in.txt")
            const string = yield* fs.readFileString("src/nested/deep.txt")
            yield* fs.makeDirectory("out", { recursive: true })
            yield* fs.writeFile("out/bytes.bin", bytes)
            yield* fs.writeFileString("out/text.txt", `${string}!`)
            const entries = yield* fs.readDirectory("src")
            yield* fs.remove("src/in.txt")
            const missing = yield* Effect.flip(fs.readFile("out/nope.txt"))
            const bad = yield* Effect.flip(fs.writeFileString("../escape.txt", "no"))
            const badDirectory = yield* Effect.flip(fs.readDirectory("/nope"))
            const badRemove = yield* Effect.flip(fs.remove("/nope"))
            const badRead = yield* Effect.flip(fs.readFileString("/nope"))
            return { absent, bad, badDirectory, badRead, badRemove, entries, missing, present }
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        yield* test.service.materialize(accepted)
        return { accepted, files: yield* test.files }
      })

      const { accepted, files } = yield* withCrypto(program)
      const observed = accepted.result.output
      expect(observed.present).toBe(true)
      expect(observed.absent).toBe(false)
      expect(observed.entries).toEqual(["in.txt", "nested"])
      expect(observed.missing._tag).toBe("PlatformError")
      expect(observed.bad._tag).toBe("PlatformError")
      expect(observed.badDirectory._tag).toBe("PlatformError")
      expect(observed.badRead._tag).toBe("PlatformError")
      expect(observed.badRemove._tag).toBe("PlatformError")
      expect(text(files, "out/text.txt")).toBe("deep!")
      expect(text(files, "out/bytes.bin")).toBe("seed")
      expect(text(files, "src/in.txt")).toBeUndefined()
    }))
})

/**
 * The filesystem host is the one that makes this real: copy-in of the declared
 * read set, whole-tree diff of the transaction, artifact-store retention of
 * oversized products, and a compare-and-set copy-back onto the host tree.
 */
describe("WorkspaceSandbox filesystem host", () => {
  const hostLayer = (files: Map<string, Uint8Array>) => {
    const fs = FileSystem.makeNoop({
      ...leaseOps(files),
      exists: (path) =>
        Effect.succeed(
          files.has(String(path)) || [...files.keys()].some((candidate) => candidate.startsWith(`${String(path)}/`))
        ),
      readFile: (path) => Effect.succeed(files.get(String(path))!),
      writeFile: (path, data) => Effect.sync(() => void files.set(String(path), data)),
      remove: (path) => Effect.sync(() => void files.delete(String(path))),
      makeDirectory: () => Effect.void,
      readDirectory: ((directory: string, options?: { readonly recursive?: boolean }) => {
        const prefix = directory === "." ? "" : `${directory}/`
        const names = new Set<string>()
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue
          const rest = path.slice(prefix.length)
          names.add(options?.recursive === true ? rest : rest.split("/")[0]!)
        }
        return Effect.succeed([...names].sort())
      }) as never,
      stat: ((path: string) =>
        files.has(path)
          ? Effect.succeed({ type: "File" })
          : Effect.succeed({ type: "Directory" })) as never
    })
    return ArtifactStore.layerMemory.pipe(
      Layer.provideMerge(Layer.merge(Layer.succeed(FileSystem.FileSystem)(isolated(fs)), NodePath.layer))
    )
  }

  for (const root of ["C:\\work\\repo", "\\\\server\\share\\repo"]) {
    it.effect(`accepts absolute transaction paths under the native root ${root}`, () =>
      withCrypto(Effect.gen(function*() {
        const files = new Map([[`${root}/dir/in.txt`, encoder.encode("seed")]])
        const accepted = yield* Effect.gen(function*() {
          const sandbox = WorkspaceSandbox.makeFileSystem(
            yield* FileSystem.FileSystem,
            hostPath,
            yield* ArtifactStore.ArtifactStore,
            root
          )
          return yield* sandbox.execute({
            descriptor: descriptor({ readSet: [read("dir/in.txt", "seed")], writeSet: [`${root}\\out.txt`] }),
            workflow: Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              for (const spelling of [root, root.replaceAll("\\", "/")]) {
                expect(yield* fs.exists(spelling)).toBe(true)
                expect(yield* fs.readDirectory(`${spelling}/`)).toEqual(["dir"])
                expect(yield* fs.readFileString(`${spelling}/dir/in.txt`)).toBe("seed")
              }
              yield* fs.writeFileString(`${root}\\out.txt`, "new")
            })
          })
        }).pipe(Effect.provide(hostLayer(files)))
        expect(accepted._tag).toBe("Accepted")
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        expect(accepted.result.files.map((change) => change.path)).toEqual(["out.txt"])
        expect([...files.keys()]).toEqual([`${root}/dir/in.txt`])
      })))
  }

  it.effect("seeds only the declared read set, so an undeclared file is simply not there", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/src/in.txt", encoder.encode("seed")],
        ["/w/src/secret.txt", encoder.encode("secret")]
      ])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* sandbox.execute({
          descriptor: descriptor({ readSet: [read("src/in.txt", "seed")], writeSet: ["out/copy.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return {
              declared: yield* fs.exists("src/in.txt"),
              undeclared: yield* fs.exists("src/secret.txt")
            }
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.output).toEqual({ declared: true, undeclared: false })
    }))

  it.effect("expands declared read globs once and seeds declared removals", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/src/a.ts", encoder.encode("a")],
        ["/w/src/nested/b.ts", encoder.encode("b")],
        ["/w/src/skip.js", encoder.encode("skip")],
        ["/w/notes.md", encoder.encode("root-level")],
        ["/w/stale.txt", encoder.encode("stale")]
      ])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* sandbox.execute({
          descriptor: descriptor({
            readSet: [
              { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/skip.ts"] },
              { _tag: "Glob", include: ["src/a.ts"] },
              // A root-level pattern walks the workspace root itself.
              { _tag: "Glob", include: ["*.md"] }
            ],
            removes: ["stale.txt", "absent.txt"]
          }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const visible: Array<string> = []
            for (const path of ["src/a.ts", "src/nested/b.ts", "notes.md", "src/skip.js"]) {
              if (yield* fs.exists(path)) visible.push(path)
            }
            yield* fs.readFileString("src/a.ts")
            yield* fs.remove("stale.txt")
            return visible
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))
      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.output).toEqual(["src/a.ts", "src/nested/b.ts", "notes.md"])
      expect(accepted.result.files.map((change) => change.path)).toEqual(["stale.txt"])
    }))

  it.effect("expands a root-level read glob on a host rooted at the current directory", () =>
    Effect.gen(function*() {
      // `root === ""` is the current-directory host: the workspace root's own
      // spelling is `"."`, the other arm of the enumeration's resolve.
      const files = new Map<string, Uint8Array>([
        ["top.ts", encoder.encode("top")],
        ["src/deep.ts", encoder.encode("deep")]
      ])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          ""
        )
        return yield* sandbox.execute({
          descriptor: descriptor({ readSet: [{ _tag: "Glob", include: ["*.ts"] }] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return {
              top: yield* fs.exists("top.ts"),
              deep: yield* fs.exists("src/deep.ts")
            }
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))
      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.output).toEqual({ top: true, deep: false })
    }))

  it.effect("copies back through a beforeDigest compare-and-set, retaining oversized products by digest", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([["/w/src/in.txt", encoder.encode("seed")]])
      const large = "x".repeat(64)
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w/",
          { maxInlineBytes: 8 }
        )
        const execution = {
          descriptor: descriptor({
            readSet: [read("src/in.txt", "seed"), read("src/absent.txt", "nothing")],
            writeSet: [{ _tag: "Glob", include: ["out/**"] }, "src/in.txt"]
          }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/large.txt", large)
            yield* fs.writeFileString("out/small.txt", "ok")
            yield* fs.remove("src/in.txt")
            return { done: true }
          })
        }
        const accepted = yield* sandbox.execute(execution)
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        const untouched = new Map(files)
        yield* sandbox.materialize(accepted)
        // A second copy-back of the same bundle now conflicts: the host moved.
        const conflict = yield* Effect.flip(sandbox.materialize(accepted))
        return { accepted, conflict, untouched }
      }).pipe(Effect.provide(hostLayer(files)))

      const { accepted, conflict, untouched } = yield* withCrypto(program)
      expect([...untouched.keys()]).toEqual(["/w/src/in.txt"])
      const large_ = accepted.result.files.find((change) => change.path === "out/large.txt")
      const small = accepted.result.files.find((change) => change.path === "out/small.txt")
      expect(large_?.after).toBeUndefined()
      expect(large_?.afterDigest).toBe(sha256(large))
      expect(small?.after).toBeDefined()
      expect(decoder.decode(files.get("/w/out/large.txt"))).toBe(large)
      expect(decoder.decode(files.get("/w/out/small.txt"))).toBe("ok")
      expect(files.has("/w/src/in.txt")).toBe(false)
      expect(conflict._tag).toBe("@smthrs/engine-store/MaterializationConflict")
    }))

  it.effect("refuses a declared read path that escapes the workspace", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.execute({
          descriptor: descriptor({ readSet: [read("../outside.txt", "x")] }),
          workflow: Effect.succeed(null)
        }))
      }).pipe(Effect.provide(hostLayer(new Map())))

      expect(yield* withCrypto(program)).toMatchObject({ code: "invalid_path" })
    }))

  it.effect("reports a refusing host honestly rather than as an empty read set", () =>
    Effect.gen(function*() {
      const fs = FileSystem.makeNoop({
        // The refusal rides on the call the sandbox actually makes. A
        // declared read is measured with one `readFile`, never an `exists`
        // probe and then a read, and the refusal has to be one the sandbox
        // cannot read as an answer: `NotFound` IS the answer "not there".
        readFile: ((path: string) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: path,
              description: "EIO"
            })
          )) as never
      })
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.execute({
          descriptor: descriptor({ readSet: [read("src/in.txt", "seed")] }),
          workflow: Effect.succeed(null)
        }))
      }).pipe(
        Effect.provide(
          ArtifactStore.layerMemory.pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(isolated(fs))))
        )
      )

      expect(yield* withCrypto(program)).toMatchObject({ code: "host_unavailable" })
    }))

  it.effect("reports an artifact store that refuses retention or resolution as a host failure", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>()
      const fs = FileSystem.makeNoop({
        ...leaseOps(files),
        exists: (path) => Effect.succeed(files.has(String(path))),
        readFile: (path) => Effect.succeed(files.get(String(path))!),
        writeFile: (path, data) => Effect.sync(() => void files.set(String(path), data)),
        makeDirectory: () => Effect.void
      })
      const program = Effect.gen(function*() {
        // An unrooted host: a workspace root of "" leaves boundary paths as the
        // host paths they already are.
        const sandbox = WorkspaceSandbox.makeFileSystem(isolated(fs), hostPath, ArtifactStore.makeNoop(), "", {
          maxInlineBytes: 0
        })
        const refused = yield* Effect.flip(sandbox.execute({
          descriptor: descriptor({ writeSet: ["root.txt"] }),
          workflow: Effect.gen(function*() {
            const inner = yield* FileSystem.FileSystem
            yield* inner.writeFileString("root.txt", "spilled")
            return null
          })
        }))
        const unresolvable = yield* Effect.flip(sandbox.materialize({
          _tag: "Accepted",
          cache: { status: "disabled" },
          violations: [],
          result: {
            output: null,
            effects: [],
            provenance: { baseRevision: "r", inputs: [], outputs: [] },
            files: [{ path: "root.txt", beforeDigest: undefined, afterDigest: sha256("spilled") }]
          }
        }))
        return { refused, unresolvable }
      })

      const { refused, unresolvable } = yield* withCrypto(program)
      expect(refused.message).toContain("artifact store")
      expect(unresolvable.message).toContain("artifact store")
    }))

  it.effect("copies a workspace-root file back without inventing a parent directory", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>()
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          ""
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({ writeSet: ["root.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("root.txt", "top level")
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        yield* sandbox.materialize(accepted)
      }).pipe(Effect.provide(hostLayer(files)))

      yield* withCrypto(program)
      expect(decoder.decode(files.get("root.txt"))).toBe("top level")
    }))

  it.effect("overwrites a declared output that already exists but was never declared as a read", () =>
    Effect.gen(function*() {
      // The seed is the declared READ set, so a write-only output is absent from
      // it while being very much present on the host — the ordinary shape of a
      // second run. Reading "absent from the seed" as "absent from the host"
      // made every such copy-back a conflict the engine could only rebase into
      // the same refusal.
      const files = new Map<string, Uint8Array>([["/w/out/result.txt", encoder.encode("previous")]])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({ writeSet: ["out/result.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/result.txt", "next")
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        yield* sandbox.materialize(accepted)
        return accepted
      }).pipe(Effect.provide(hostLayer(files)))

      const accepted = yield* withCrypto(program)
      expect(accepted.result.files).toMatchObject([
        { path: "out/result.txt", beforeDigest: sha256("previous"), afterDigest: sha256("next") }
      ])
      expect(decoder.decode(files.get("/w/out/result.txt"))).toBe("next")
    }))

  it.effect("omits an unobserved output the body rewrote with the bytes already there", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([["/w/out/result.txt", encoder.encode("same")]])
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* sandbox.execute({
          descriptor: descriptor({ writeSet: ["out/result.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("out/result.txt", "same")
            return null
          })
        })
      }).pipe(Effect.provide(hostLayer(files)))

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.files).toEqual([])
      expect(accepted.result.provenance.outputs).toEqual([])
    }))

  it.effect("refuses copy-back of a bundle whose retained bytes the artifact store cannot serve", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.materialize({
          _tag: "Accepted",
          cache: { status: "disabled" },
          violations: [],
          result: {
            output: null,
            effects: [],
            provenance: { baseRevision: "r", inputs: [], outputs: [] },
            files: [{ path: "out/gone.txt", beforeDigest: undefined, afterDigest: sha256("gone") }]
          }
        }))
      }).pipe(Effect.provide(hostLayer(new Map())))

      expect(yield* withCrypto(program)).toMatchObject({ code: "not_found" })
    }))

  it.effect("resolves the workspace root through the kernel Workspace service", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([["/w/src/in.txt", encoder.encode("seed")]])
      const program = Effect.gen(function*() {
        const sandbox = yield* WorkspaceSandbox.WorkspaceSandbox
        return yield* sandbox.execute({
          descriptor: descriptor({ readSet: [read("src/in.txt", "seed")], writeSet: ["out/copy.txt"] }),
          workflow: Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            // An absolute path a body resolved against the real workspace root
            // still lands inside the transaction.
            yield* fs.writeFile("/w/out/copy.txt", yield* fs.readFile("/w/src/in.txt"))
            return null
          })
        })
      }).pipe(
        Effect.provide(
          WorkspaceSandbox.layerFileSystem().pipe(
            Layer.provide(KernelWorkspace.layer("/w")),
            Layer.provide(hostLayer(files))
          )
        )
      )

      const accepted = yield* withCrypto(program)
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      expect(accepted.result.files.map((change) => change.path)).toEqual(["out/copy.txt"])
    }))
})

/**
 * Copy-back checks preconditions before file changes and journals pre-images
 * for in-process rollback. Competing commits wait through rollback, including
 * failures that leave partial changes for the caller to reconcile.
 */
describe("WorkspaceSandbox empty materialization", () => {
  it.effect("materializes a body that changed nothing without touching the host", () =>
    Effect.gen(function*() {
      const touched: Array<string> = []
      const refuse = (operation: string) => () =>
        Effect.sync(() => void touched.push(operation)).pipe(
          Effect.andThen(Effect.fail(PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: operation,
            description: "outside capability ceiling"
          })))
        )
      const fs = FileSystem.makeNoop({
        makeDirectory: refuse("makeDirectory"),
        writeFile: refuse("writeFile"),
        open: refuse("open")
      })
      const sandbox = WorkspaceSandbox.makeFileSystem(isolated(fs), hostPath, ArtifactStore.makeNoop(), "")
      const accepted = yield* withCrypto(sandbox.execute({
        descriptor: descriptor(),
        workflow: Effect.succeed("read")
      }))
      if (accepted._tag !== "Accepted") throw new Error("expected an accepted execution")
      expect(accepted.result.files).toEqual([])
      yield* withCrypto(sandbox.materialize(accepted))
      expect(touched).toEqual([])
    }))
})

describe("WorkspaceSandbox filesystem host atomicity", () => {
  for (const failRollback of [false, true]) {
    it.effect(`serializes separate sandboxes through ${failRollback ? "a failed rollback" : "apply"}`, () =>
      withCrypto(Effect.gen(function*() {
        let content = encoder.encode("base")
        let writes = 0
        let preflightReads = 0
        let committing = false
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const fs = FileSystem.makeNoop({
          ...leaseOps(new Map()),
          readFile: () =>
            Effect.sync(() => {
              if (committing) preflightReads++
              return content.slice()
            }),
          exists: () => Effect.die("copy-back must not probe directories"),
          makeDirectory: () => Effect.void,
          writeFile: (path, value) =>
            Effect.gen(function*() {
              writes++
              if (writes === 1) {
                if (failRollback) {
                  content = value.slice()
                  return yield* Effect.fail(injected(path))
                }
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              } else if (writes === 2 && failRollback) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* Effect.fail(injected(path))
              }
              content = value.slice()
            })
        })
        const host = isolated(fs)
        const a = WorkspaceSandbox.makeFileSystem(host, hostPath, ArtifactStore.makeNoop(), "")
        const b = WorkspaceSandbox.makeFileSystem(host, hostPath, ArtifactStore.makeNoop(), "")
        const execute = (sandbox: WorkspaceSandbox.Service, value: string) =>
          sandbox.execute({
            descriptor: descriptor({ readSet: [read("nested/file", "base")], writeSet: ["nested/file"] }),
            workflow: Effect.flatMap(WorkspaceSandbox.Workspace, (ws) =>
              ws.writeFile("nested/file", encoder.encode(value)))
          })
        const first = yield* execute(a, "A")
        const second = yield* execute(b, "B")
        if (first._tag !== "Accepted" || second._tag !== "Accepted") throw new Error("expected accepted executions")
        committing = true
        const running = yield* Effect.forkChild(Effect.exit(a.materialize(first)))
        yield* Deferred.await(entered)
        const competing = yield* Effect.forkChild(Effect.exit(b.materialize(second)))
        // Give the competing fiber a turn while the first host call is held.
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        const readsWhileHeld = preflightReads
        yield* Deferred.succeed(release, undefined)
        const results = [yield* Fiber.join(running), yield* Fiber.join(competing)] as const
        expect(readsWhileHeld).toBe(1)
        expect(results[0]._tag).toBe(failRollback ? "Failure" : "Success")
        if (failRollback && results[0]._tag === "Failure") {
          expect(results[0].cause.reasons.filter(Cause.isFailReason)).toHaveLength(2)
        }
        expect(results[1]._tag).toBe("Failure")
        if (results[1]._tag === "Failure") {
          expect(results[1].cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
            .toMatchObject([{ _tag: "@smthrs/engine-store/MaterializationConflict", paths: ["nested/file"] }])
        }
        expect(decoder.decode(content)).toBe("A")
        expect(writes).toBe(failRollback ? 2 : 1)
      })))
  }

  const faultLayer = (files: Map<string, Uint8Array>, failOn: (call: number) => boolean) => {
    let calls = 0
    const fs = FileSystem.makeNoop({
      ...leaseOps(files),
      exists: (path) => Effect.succeed(files.has(String(path))),
      readFile: (path) => Effect.succeed(files.get(String(path))!),
      writeFile: (path, data) => {
        calls = calls + 1
        return failOn(calls)
          ? Effect.fail(injected(String(path)))
          : Effect.sync(() => void files.set(String(path), data))
      },
      remove: (path) => Effect.sync(() => void files.delete(String(path))),
      makeDirectory: () => Effect.void
    })
    return ArtifactStore.layerMemory.pipe(
      Layer.provideMerge(Layer.merge(Layer.succeed(FileSystem.FileSystem)(isolated(fs)), NodePath.layer))
    )
  }

  it.effect("restores every applied change when the host refuses the Nth write", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/0del.txt", encoder.encode("DEL-OLD")],
        ["/w/a.txt", encoder.encode("A-OLD")]
      ])
      // Apply order is path-sorted: remove 0del.txt, overwrite a.txt (write 1),
      // create b.txt (write 2, refused). Rollback then re-creates b.txt's
      // absence, restores a.txt's pre-image, and re-writes the removed file.
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({
            readSet: [read("a.txt", "A-OLD"), read("0del.txt", "DEL-OLD")],
            writeSet: ["a.txt", "b.txt", "0del.txt"]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.removeFile("0del.txt")
            yield* workspace.writeFile("a.txt", encoder.encode("A-NEW"))
            yield* workspace.writeFile("b.txt", encoder.encode("B-NEW"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return yield* Effect.flip(sandbox.materialize(accepted))
      }).pipe(Effect.provide(faultLayer(files, (call) => call === 2)))

      const refused = yield* withCrypto(program)
      expect(refused).toMatchObject({ _tag: "@smthrs/engine-store/WorkspaceError", code: "host_unavailable" })
      // The refusing host failure travels whole in `cause`, never flattened
      // into the message.
      expect(String((refused.cause as PlatformError.PlatformError).message)).toContain("injected")
      expect([...files.keys()].sort()).toEqual(["/w/0del.txt", "/w/a.txt"])
      expect(decoder.decode(files.get("/w/0del.txt"))).toBe("DEL-OLD")
      expect(decoder.decode(files.get("/w/a.txt"))).toBe("A-OLD")
    }))

  it.effect("keeps the host untouched when a later change's retained bytes cannot be resolved", () =>
    Effect.gen(function*() {
      // The first change carries its bytes inline and would have landed under a
      // fetch-as-you-apply loop; resolution happens before any byte does.
      const files = new Map<string, Uint8Array>()
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        return yield* Effect.flip(sandbox.materialize({
          _tag: "Accepted",
          cache: { status: "disabled" },
          violations: [],
          result: {
            output: null,
            effects: [],
            provenance: { baseRevision: "r", inputs: [], outputs: [] },
            files: [
              {
                path: "aa.txt",
                beforeDigest: undefined,
                afterDigest: sha256("landed"),
                after: encoder.encode("landed")
              },
              { path: "bb.txt", beforeDigest: undefined, afterDigest: sha256("gone") }
            ]
          }
        }))
      }).pipe(Effect.provide(faultLayer(files, () => false)))

      expect(yield* withCrypto(program)).toMatchObject({ code: "not_found" })
      expect(files.size).toBe(0)
    }))

  it.effect("reports both refusals when rollback itself fails", () =>
    Effect.gen(function*() {
      const files = new Map<string, Uint8Array>([
        ["/w/a.txt", encoder.encode("A-OLD")],
        ["/w/b.txt", encoder.encode("B-OLD")]
      ])
      // Write 2 (b.txt) is refused, and so is write 3 — the rollback's attempt
      // to restore b.txt's pre-image.
      const program = Effect.gen(function*() {
        const sandbox = WorkspaceSandbox.makeFileSystem(
          yield* FileSystem.FileSystem,
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          "/w"
        )
        const accepted = yield* sandbox.execute({
          descriptor: descriptor({
            readSet: [read("a.txt", "A-OLD"), read("b.txt", "B-OLD")],
            writeSet: ["a.txt", "b.txt"]
          }),
          workflow: Effect.gen(function*() {
            const workspace = yield* WorkspaceSandbox.Workspace
            yield* workspace.writeFile("a.txt", encoder.encode("A-NEW"))
            yield* workspace.writeFile("b.txt", encoder.encode("B-NEW"))
            return null
          })
        })
        if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
        return yield* Effect.exit(sandbox.materialize(accepted))
      }).pipe(Effect.provide(faultLayer(files, (call) => call === 2 || call === 3)))

      const exit = yield* withCrypto(program)
      if (exit._tag !== "Failure") throw new Error("expected the materialize to fail")
      const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
      // Both failures travel: the refused apply write that opened the window,
      // then the rollback that could not close it.
      expect(errors).toHaveLength(2)
      expect(errors[0]).toMatchObject({ code: "host_unavailable" })
      const compound = errors[1]
      expect(compound).toMatchObject({ code: "host_unavailable" })
      expect(compound!.message).toContain("rollback could not restore")
      // The compound rollback cause carries each refusal whole; the injected
      // device failure is reachable through the nested causes rather than
      // stringified away.
      const rollback = compound!.cause as Cause.Cause<WorkspaceSandbox.WorkspaceError>
      const inner = rollback.reasons.filter(Cause.isFailReason).map((reason) => reason.error.cause)
      expect(
        inner.some((cause) => String((cause as PlatformError.PlatformError).message).includes("injected"))
      ).toBe(true)
    }))
})

/**
 * Confinement and the rollback journal against a real filesystem: symlinks
 * only exist here, and so does the directory tree the journal must restore.
 */
describe("WorkspaceSandbox filesystem host confinement", () => {
  const nodeLayer = ArtifactStore.layerMemory.pipe(Layer.provideMerge(AtomicFileSystem.layer))

  const temp = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "wsx-root-" })
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "wsx-out-" })
    return { fs, root, outside }
  })

  const write = (
    sandbox: WorkspaceSandbox.Service,
    writes: ReadonlyArray<readonly [path: string, content: string]>,
    writeSet: FileBoundary["writeSet"]
  ) =>
    Effect.gen(function*() {
      const accepted = yield* sandbox.execute({
        descriptor: descriptor({ writeSet: [...writeSet] }),
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          for (const [path, content] of writes) {
            yield* workspace.writeFile(path, encoder.encode(content))
          }
          return null
        })
      })
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      return accepted
    })

  // A lock create refused because the path exists: another owner holds it.
  const contending = (fs: FileSystem.FileSystem, attempted: Deferred.Deferred<void>) =>
    intercept(
      fs,
      (request, proceed) =>
        request.operation === "writeFileString" && request.path.endsWith("/.smithers-workspace-lock")
          ? proceed.pipe(Effect.tapError(() => Deferred.succeed(attempted, undefined)))
          : proceed
    )

  const backdate = (fs: FileSystem.FileSystem, path: string, ms: number) =>
    Effect.suspend(() => {
      const then = new Date(Date.now() - ms)
      return fs.utimes(path, then, then)
    })

  it.effect("interrupts a lock wait without removing another owner's lock or leaking a permit", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        const lock = `${root}/.smithers-workspace-lock`
        yield* fs.writeFileString(lock, "foreign-owner")
        const attempted = yield* Deferred.make<void>()
        const sandbox = WorkspaceSandbox.makeFileSystem(
          contending(fs, attempted),
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          root
        )
        const accepted = yield* write(sandbox, [["file", "new"]], ["file"])
        const waiting = yield* Effect.forkChild(sandbox.materialize(accepted))
        yield* Deferred.await(attempted)
        yield* Fiber.interrupt(waiting)
        expect(yield* fs.readFileString(lock)).toBe("foreign-owner")
        expect(yield* fs.exists(`${root}/file`)).toBe(false)
        yield* fs.remove(lock)
        yield* sandbox.materialize(accepted)
        expect(yield* fs.readFileString(`${root}/file`)).toBe("new")
        expect(yield* fs.exists(lock)).toBe(false)
      })).pipe(Effect.provide(nodeLayer))
    ))

  for (const shape of ["file", "legacy directory"] as const) {
    it.effect(`reclaims a stale ${shape} lock left by a killed owner`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          // Real file mtimes are read against the test clock.
          yield* Effect.suspend(() => TestClock.setTime(Date.now()))
          const { fs, root } = yield* temp
          const lock = `${root}/.smithers-workspace-lock`
          if (shape === "file") yield* fs.writeFileString(lock, "killed-owner")
          else yield* fs.makeDirectory(lock)
          yield* backdate(fs, lock, 61_000)
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
          yield* sandbox.materialize(yield* write(sandbox, [["file", "new"]], ["file"]))
          expect(yield* fs.readFileString(`${root}/file`)).toBe("new")
          // The lock, its reclaim claim, and the tombstone are all gone.
          expect(yield* fs.readDirectory(root)).toEqual(["file"])
        })).pipe(Effect.provide(nodeLayer))
      ))

    it.effect(`fails with commit_lock_timeout while a live ${shape} lock is held`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          // The test clock stays at zero, so the lock's real mtime never ages
          // past the stale bound: it reads as a live owner's heartbeat.
          const { fs, root } = yield* temp
          const lock = `${root}/.smithers-workspace-lock`
          if (shape === "file") yield* fs.writeFileString(lock, "live-owner")
          else yield* fs.makeDirectory(lock)
          const attempted = yield* Deferred.make<void>()
          const sandbox = WorkspaceSandbox.makeFileSystem(
            contending(fs, attempted),
            hostPath,
            yield* ArtifactStore.ArtifactStore,
            root
          )
          const accepted = yield* write(sandbox, [["file", "new"]], ["file"])
          const waiting = yield* Effect.forkChild(Effect.flip(sandbox.materialize(accepted)))
          yield* Deferred.await(attempted)
          yield* TestClock.adjust("2 minutes")
          expect(yield* Fiber.join(waiting)).toMatchObject({ code: "commit_lock_timeout" })
          expect(yield* fs.exists(`${root}/file`)).toBe(false)
          expect((yield* fs.stat(lock)).type).toBe(shape === "file" ? "File" : "Directory")
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.live("recovers the commit lock after its owner process is hard-killed", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        const lock = `${root}/.smithers-workspace-lock`
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(lockChild), root], {
              cwd: new URL("..", import.meta.url),
              stdio: ["pipe", "pipe", "pipe"]
            })
          ),
          (child) =>
            Effect.sync(() => {
              if (child.exitCode === null) child.kill("SIGKILL")
            })
        )
        let stderr = ""
        child.stderr.on("data", (data) => {
          stderr += String(data)
        })
        const killed = new Promise<NodeJS.Signals | null>((resolve) =>
          child.once("exit", (_, signal) => resolve(signal))
        )
        yield* Effect.promise(() =>
          new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve())
            child.once("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)))
          })
        )
        child.kill("SIGKILL")
        expect(yield* Effect.promise(() => killed)).toBe("SIGKILL")
        expect(yield* fs.exists(lock)).toBe(true)
        // The killed owner's heartbeat stopped; age its lock past the bound
        // instead of waiting a minute of wall time.
        yield* backdate(fs, lock, 120_000)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        yield* sandbox.materialize(yield* write(sandbox, [["file", "new"]], ["file"]))
        expect(yield* fs.readFileString(`${root}/file`)).toBe("new")
        expect(yield* fs.exists(lock)).toBe(false)
      })).pipe(Effect.provide(nodeLayer))
    ))

  for (const path of [".smithers-workspace-lock", "alias", "alias/nested"]) {
    it.effect(`reserves the coordination directory through ${path}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          const lock = `${root}/.smithers-workspace-lock`
          yield* fs.symlink(lock, `${root}/alias`)
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
          const accepted = yield* write(sandbox, [[path, "new"]], [path])
          // The literal name is reserved; an alias is a symlink on the path,
          // which the confined host refuses before it could reach the lock.
          expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({
            code: path === ".smithers-workspace-lock" ? "host_unavailable" : "path_escapes_workspace"
          })
          expect(yield* fs.exists(lock)).toBe(false)
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  const engineState = (
    sandbox: WorkspaceSandbox.Service,
    path: string,
    boundary: Partial<FileBoundary>
  ) =>
    sandbox.execute({
      descriptor: descriptor(boundary),
      workflow: Effect.gen(function*() {
        const workspace = yield* WorkspaceSandbox.Workspace
        yield* workspace.writeFile("src/app.ts", encoder.encode("export const x = 2\n"))
        yield* workspace.writeFile(path, encoder.encode("REPLACED BY A SEALED STEP BODY"))
        return null
      })
    })

  for (
    const [label, boundary] of [
      ["a broad ** hard write set", { writeSet: [{ _tag: "Glob", include: ["**"] }] }],
      ["an undeclared expected-mode write", { writeSet: ["src/app.ts"], boundaryMode: "expected" }]
    ] as const
  ) {
    it.effect(`reserves the .flows engine state directory under ${label}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          yield* fs.makeDirectory(`${root}/.flows/objects`, { recursive: true })
          yield* fs.makeDirectory(`${root}/src`)
          yield* fs.writeFileString(`${root}/.flows/state.sqlite`, "LIVE ENGINE DATABASE")
          yield* fs.writeFileString(`${root}/src/app.ts`, "export const x = 1\n")
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
          const result = yield* engineState(sandbox, ".flows/state.sqlite", boundary as Partial<FileBoundary>)
          expect(result._tag).toBe("Accepted")
          if (result._tag !== "Accepted") return
          expect(yield* Effect.flip(sandbox.materialize(result))).toMatchObject({
            code: "host_unavailable",
            cause: "the workspace path .flows is reserved"
          })
          expect(yield* fs.readFileString(`${root}/.flows/state.sqlite`)).toBe("LIVE ENGINE DATABASE")
          expect(yield* fs.readFileString(`${root}/src/app.ts`)).toBe("export const x = 1\n")
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.effect("invalidates an undeclared hard-mode engine state write before copy-back", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.makeDirectory(`${root}/.flows`)
        yield* fs.writeFileString(`${root}/.flows/state.sqlite`, "LIVE ENGINE DATABASE")
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const result = yield* engineState(sandbox, ".flows/state.sqlite", { writeSet: ["src/app.ts"] })
        expect(result._tag).toBe("Invalidated")
        expect(yield* fs.readFileString(`${root}/.flows/state.sqlite`)).toBe("LIVE ENGINE DATABASE")
      })).pipe(Effect.provide(nodeLayer))
    ))

  for (const path of ["engine.db", "engine.db-wal", "objects/blob", "alias/blob"]) {
    it.effect(`reserves configured engine state paths through ${path}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          yield* fs.makeDirectory(`${root}/objects`)
          yield* fs.writeFileString(`${root}/engine.db`, "LIVE")
          yield* fs.symlink(`${root}/objects`, `${root}/alias`)
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root, {
            reservedPaths: ["./engine.db", "engine.db-wal", "engine.db-shm", "objects/"]
          })
          const accepted = yield* write(sandbox, [[path, "new"]], [path])
          expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({
            code: path.startsWith("alias/") ? "path_escapes_workspace" : "host_unavailable"
          })
          expect(yield* fs.readFileString(`${root}/engine.db`)).toBe("LIVE")
          expect(yield* fs.exists(`${root}/objects/blob`)).toBe(false)
          expect(yield* fs.exists(`${root}/engine.db-wal`)).toBe(false)
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.effect("keeps an unreserved sibling of a reserved name writable", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [[".flowsheet", "ok"]], [".flowsheet"])
        yield* sandbox.materialize(accepted)
        expect(yield* fs.readFileString(`${root}/.flowsheet`)).toBe("ok")
      })).pipe(Effect.provide(nodeLayer))
    ))

  // APFS and NTFS resolve case, compatibility, and normalization variants to
  // the same entry, so each of these spellings names the live `.flows`
  // directory or the lock on the default macOS and Windows volumes.
  for (
    const [path, name] of [
      [".FLOWS/state.sqlite", ".flows"],
      [".Flows/objects/blob", ".flows"],
      [".flowſ/state.sqlite", ".flows"],
      [".ﬂows/state.sqlite", ".flows"],
      [".Smithers-Workspace-Lock", ".smithers-workspace-lock"],
      ["ENGINE.DB", "engine.db"],
      ["Café/x", "café"]
    ] as const
  ) {
    it.effect(`reserves the ${name} spelling ${JSON.stringify(path)} on case-insensitive volumes`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          yield* fs.makeDirectory(`${root}/.flows`)
          yield* fs.writeFileString(`${root}/.flows/state.sqlite`, "LIVE ENGINE DATABASE")
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root, {
            reservedPaths: ["engine.db", "café"]
          })
          const accepted = yield* write(sandbox, [[path, "REPLACED"]], [path])
          expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({
            code: "host_unavailable",
            cause: `the workspace path ${name} is reserved`
          })
          expect(yield* fs.readFileString(`${root}/.flows/state.sqlite`)).toBe("LIVE ENGINE DATABASE")
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  // NTFS with 8.3 names on opens a long name through its generated short
  // name, and WSL and SMB carry that onto Linux and macOS hosts.
  for (
    const [path, spelling] of [
      ["FLOWS~1/state.sqlite", "FLOWS~1"],
      ["flows~12/objects/blob", "flows~12"],
      ["SMITHE~1.LOC", "SMITHE~1.LOC"],
      ["FL3A2B~1/state.sqlite", "FL3A2B~1"],
      ["OBJECT~1/blob", "OBJECT~1"]
    ] as const
  ) {
    it.effect(`reserves the NTFS short-name spelling ${JSON.stringify(path)}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root, {
            reservedPaths: ["objects/"]
          })
          const accepted = yield* write(sandbox, [[path, "REPLACED"]], [path])
          expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({
            code: "host_unavailable",
            cause: `the workspace path ${spelling} may be a short-name alias of a reserved path`
          })
          expect(yield* fs.exists(`${root}/${path}`)).toBe(false)
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.effect("reserves a short-name spelling of a nested reserved segment", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root, {
          reservedPaths: ["state/engine.sqlite"]
        })
        const path = "state/ENGINE~1.SQL"
        const accepted = yield* write(sandbox, [[path, "REPLACED"]], [path])
        expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({
          code: "host_unavailable",
          cause: `the workspace path ${path} may be a short-name alias of a reserved path`
        })
      })).pipe(Effect.provide(nodeLayer))
    ))

  for (const path of ["state/a~b", "longername~1/x", "docs/FLOWS~1", "state~/x"]) {
    it.effect(`keeps the non-alias or unreserved position ${JSON.stringify(path)} writable`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const { fs, root } = yield* temp
          const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root, {
            reservedPaths: ["state/engine.sqlite"]
          })
          const accepted = yield* write(sandbox, [[path, "ok"]], [path])
          yield* sandbox.materialize(accepted)
          expect(yield* fs.readFileString(`${root}/${path}`)).toBe("ok")
        })).pipe(Effect.provide(nodeLayer))
      ))
  }

  it.live("serializes copy-back with a separate process and a root alias", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.writeFileString(`${root}/file`, "base")
        const alias = `${outside}/alias`
        yield* fs.symlink(root, alias)
        const contended = yield* Deferred.make<void>()
        const sandbox = WorkspaceSandbox.makeFileSystem(
          contending(fs, contended),
          hostPath,
          yield* ArtifactStore.ArtifactStore,
          alias
        )
        const accepted = yield* write(sandbox, [["file", "B"]], ["file"])
        // The child holds its first data write after acquiring the advisory lock.
        const script = `
        import * as Effect from "effect/Effect";
        import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem";
        import * as KernelFileSystem from "@smthrs/kernel/FileSystem";
        import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
        import * as FileSystem from "effect/FileSystem";
        import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore";
        import * as Sandbox from "./src/WorkspaceSandbox.ts";
        import { hostPath } from "./test/HostPath.ts";
        import { createHash } from "node:crypto";
        const root = process.argv[1];
        const bytes = new TextEncoder().encode("A");
        await Effect.runPromise(Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const atomic = fs[KernelFileSystem.AtomicFileSystemTypeId];
          const held = KernelFileSystem.withAtomicFileSystem({ ...fs }, { ...atomic, execute: (request) =>
            request.operation !== "writeFile" ? atomic.execute(request) :
            Effect.promise(() => new Promise(resolve => {
              process.stdin.once("data", resolve);
              process.stdout.write("applying\\n");
            })).pipe(Effect.andThen(atomic.execute(request)))
          });
          const sandbox = Sandbox.makeFileSystem(held, hostPath, ArtifactStore.makeNoop(), root);
          yield* sandbox.materialize({ _tag: "Accepted", cache: { status: "disabled" }, violations: [], result: {
            output: null, effects: [], provenance: { baseRevision: "base", inputs: [], outputs: [] },
            files: [{ path: "file", beforeDigest: createHash("sha256").update("base").digest("hex"),
              afterDigest: createHash("sha256").update(bytes).digest("hex"), after: bytes }]
          }});
        }).pipe(Effect.provide(AtomicFileSystem.layer), Effect.provide(NodeCrypto.layer)));
        process.stdin.destroy();
      `
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script, root], {
              cwd: new URL("..", import.meta.url),
              stdio: ["pipe", "pipe", "pipe"]
            })
          ),
          (child) =>
            Effect.sync(() => {
              child.kill()
            })
        )
        let stderr = ""
        child.stderr.on("data", (data) => {
          stderr += String(data)
        })
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
        yield* Effect.promise(() =>
          new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve())
            child.once("error", reject)
            child.once("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)))
          })
        )
        const running = yield* Effect.forkChild(Effect.exit(sandbox.materialize(accepted)))
        yield* Deferred.await(contended)
        expect(yield* fs.readFileString(`${root}/file`)).toBe("base")
        child.stdin.write("release")
        expect(yield* Effect.promise(() => exited)).toBe(0)
        const result = yield* Fiber.join(running)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
            .toMatchObject([{ _tag: "@smthrs/engine-store/MaterializationConflict", paths: ["file"] }])
        }
        expect(yield* fs.readFileString(`${root}/file`)).toBe("A")
        expect(yield* fs.exists(`${root}/.smithers-workspace-lock`)).toBe(false)
      })).pipe(Effect.provide(nodeLayer))
    ))

  it.effect("refuses to write through a file symlink whose target escapes the root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.writeFileString(`${outside}/notes.txt`, "OUTSIDE-ORIGINAL")
        yield* fs.symlink(`${outside}/notes.txt`, `${root}/notes.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["notes.txt", "PWNED"]], ["notes.txt"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return {
          refused,
          outsideContent: yield* fs.readFileString(`${outside}/notes.txt`),
          stillLink: (yield* fs.readLink(`${root}/notes.txt`)) === `${outside}/notes.txt`
        }
      })).pipe(Effect.provide(nodeLayer))

      const { outsideContent, refused, stillLink } = yield* withCrypto(program)
      expect(refused).toMatchObject({
        _tag: "@smthrs/engine-store/WorkspaceError",
        code: "path_escapes_workspace"
      })
      expect(outsideContent).toBe("OUTSIDE-ORIGINAL")
      expect(stillLink).toBe(true)
    }))

  it.effect("refuses a write redirected by a directory symlink and creates nothing outside", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.makeDirectory(`${outside}/dir`)
        yield* fs.symlink(`${outside}/dir`, `${root}/out`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["out/planted.txt", "PWNED"]], [{ _tag: "Glob", include: ["out/**"] }])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return { refused, outsideEntries: yield* fs.readDirectory(`${outside}/dir`) }
      })).pipe(Effect.provide(nodeLayer))

      const { outsideEntries, refused } = yield* withCrypto(program)
      expect(refused).toMatchObject({ code: "path_escapes_workspace" })
      expect(outsideEntries).toEqual([])
    }))

  it.effect("refuses a dangling symlink whose referent would land outside the root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.symlink(`${outside}/newfile.txt`, `${root}/dangle.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["dangle.txt", "PWNED"]], ["dangle.txt"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return { refused, created: yield* fs.exists(`${outside}/newfile.txt`) }
      })).pipe(Effect.provide(nodeLayer))

      const { created, refused } = yield* withCrypto(program)
      expect(refused).toMatchObject({ code: "path_escapes_workspace" })
      expect(created).toBe(false)
    }))

  it.effect("refuses a dangling symlink that climbs above the filesystem root", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.symlink(`${"../".repeat(40)}escape.txt`, `${root}/up.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["up.txt", "PWNED"]], ["up.txt"])
        return yield* Effect.flip(sandbox.materialize(accepted))
      })).pipe(Effect.provide(nodeLayer))

      expect(yield* withCrypto(program)).toMatchObject({ code: "path_escapes_workspace" })
    }))

  it.effect("refuses an unresolvable chain of dangling symlinks", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        for (let index = 1; index <= 10; index++) {
          yield* fs.symlink(`link${index + 1}.txt`, `${root}/link${index}.txt`)
        }
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(sandbox, [["link1.txt", "PWNED"]], ["link1.txt"])
        return yield* Effect.flip(sandbox.materialize(accepted))
      })).pipe(Effect.provide(nodeLayer))

      expect(yield* withCrypto(program)).toMatchObject({ code: "path_escapes_workspace" })
    }))

  it.effect("rolls back files without recursively deleting directories a concurrent writer may own", () =>
    Effect.gen(function*() {
      const program = Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.writeFileString(`${root}/a.txt`, "old-a")
        yield* fs.makeDirectory(`${root}/sub`)
        yield* fs.writeFileString(`${root}/sub/keep.txt`, "keep")
        const failing = intercept(
          fs,
          (request, proceed) =>
            request.operation === "writeFile" && request.path.endsWith("poison.txt")
              ? fs.writeFileString(`${root}/q/concurrent.txt`, "concurrent").pipe(
                Effect.andThen(Effect.fail(injected(request.path)))
              )
              : proceed
        )
        const sandbox = WorkspaceSandbox.makeFileSystem(failing, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* write(
          sandbox,
          [
            ["a.txt", "new-a"],
            ["b.txt", "new-b"],
            ["q/deep/poison.txt", "never"],
            ["sub/inside.txt", "never"]
          ],
          ["a.txt", "b.txt", { _tag: "Glob", include: ["q/**", "sub/**"] }]
        )
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        return {
          refused,
          a: yield* fs.readFileString(`${root}/a.txt`),
          bExists: yield* fs.exists(`${root}/b.txt`),
          qExists: yield* fs.exists(`${root}/q`),
          concurrent: yield* fs.readFileString(`${root}/q/concurrent.txt`),
          keep: yield* fs.readFileString(`${root}/sub/keep.txt`),
          insideExists: yield* fs.exists(`${root}/sub/inside.txt`)
        }
      })).pipe(Effect.provide(nodeLayer))

      const { a, bExists, concurrent, insideExists, keep, qExists, refused } = yield* withCrypto(program)
      expect(refused).toMatchObject({ code: "host_unavailable" })
      expect(String((refused.cause as PlatformError.PlatformError).message)).toContain("injected")
      expect(a).toBe("old-a")
      expect(bExists).toBe(false)
      expect(qExists).toBe(true)
      expect(concurrent).toBe("concurrent")
      expect(keep).toBe("keep")
      expect(insideExists).toBe(false)
    }))
})

describe("WorkspaceSandbox copy-back symlink swaps", () => {
  const atomicLayer = ArtifactStore.layerMemory.pipe(Layer.provideMerge(AtomicFileSystem.layer))

  /**
   * A host that runs `plant` once, right before the first host call matching
   * `when` reaches the filesystem: after every earlier check passed and before
   * the call resolves its path. It intercepts both the path-based method and
   * the descriptor-relative request, so it opens the window whichever one the
   * sandbox issues.
   */
  const swapping = (
    fs: FileSystem.FileSystem,
    when: (operation: string, path: string, recursive: boolean) => boolean,
    plant: Effect.Effect<void, PlatformError.PlatformError>
  ): FileSystem.FileSystem => {
    let planted = false
    const once = (operation: string, path: string, recursive = false) =>
      Effect.suspend(() => {
        if (planted || !when(operation, path, recursive)) return Effect.void
        planted = true
        return plant
      })
    const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
    return KernelFileSystem.withAtomicFileSystem({
      ...fs,
      writeFile: (path, data, options) =>
        once("writeFile", path).pipe(Effect.andThen(fs.writeFile(path, data, options))),
      makeDirectory: (path, options) =>
        once("makeDirectory", path, options?.recursive === true).pipe(
          Effect.andThen(fs.makeDirectory(path, options))
        )
    }, {
      ...atomic,
      execute: (request) =>
        once(
          request.operation,
          "path" in request ? request.path : "",
          request.operation === "makeDirectory" && request.options?.recursive === true
        ).pipe(Effect.andThen(atomic.execute(request))) as never
    })
  }

  const temp = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "wsx-swap-root-" }))
    const outside = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "wsx-swap-out-" }))
    return { fs, root, outside }
  })

  const accept = (
    sandbox: WorkspaceSandbox.Service,
    writes: ReadonlyArray<readonly [path: string, content: string]>,
    writeSet: FileBoundary["writeSet"]
  ) =>
    Effect.gen(function*() {
      const accepted = yield* sandbox.execute({
        descriptor: descriptor({ writeSet: [...writeSet] }),
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          for (const [path, content] of writes) yield* workspace.writeFile(path, encoder.encode(content))
          return null
        })
      })
      if (accepted._tag !== "Accepted") throw new Error("expected accepted execution")
      return accepted
    })

  it.effect("refuses a file swapped for an outside symlink after confinement checks passed", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.writeFileString(`${outside}/victim.txt`, "OUTSIDE-ORIGINAL")
        yield* fs.writeFileString(`${root}/target.txt`, "base")
        const host = swapping(
          fs,
          (operation, path) => operation === "writeFile" && path.endsWith("target.txt"),
          fs.remove(`${root}/target.txt`).pipe(
            Effect.andThen(fs.symlink(`${outside}/victim.txt`, `${root}/target.txt`))
          )
        )
        const sandbox = WorkspaceSandbox.makeFileSystem(host, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* accept(sandbox, [["target.txt", "PWNED"]], ["target.txt"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        expect(refused).toMatchObject({ code: "path_escapes_workspace" })
        expect(yield* fs.readFileString(`${outside}/victim.txt`)).toBe("OUTSIDE-ORIGINAL")
      })).pipe(Effect.provide(atomicLayer))
    ))

  it.effect("refuses a parent directory swapped for an outside symlink before it is created", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.makeDirectory(`${outside}/dir`)
        const host = swapping(
          fs,
          (operation, path, recursive) => operation === "makeDirectory" && recursive && path.endsWith("/out/deep"),
          fs.symlink(`${outside}/dir`, `${root}/out`)
        )
        const sandbox = WorkspaceSandbox.makeFileSystem(host, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* accept(sandbox, [["out/deep/planted.txt", "PWNED"]], [{
          _tag: "Glob",
          include: ["out/**"]
        }])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        expect(refused).toMatchObject({ code: "path_escapes_workspace" })
        expect(yield* fs.readDirectory(`${outside}/dir`)).toEqual([])
      })).pipe(Effect.provide(atomicLayer))
    ))

  it.effect("refuses a rollback target swapped for an outside symlink", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        yield* fs.writeFileString(`${outside}/victim.txt`, "OUTSIDE-ORIGINAL")
        yield* fs.writeFileString(`${root}/a.txt`, "old-a")
        // The second write fails, so rollback restores a.txt; the swap lands
        // between the failed apply and the restoring write.
        const failing = swapping(
          fs,
          (operation, path) => operation === "writeFile" && path.endsWith("poison.txt"),
          fs.remove(`${root}/a.txt`).pipe(
            Effect.andThen(fs.symlink(`${outside}/victim.txt`, `${root}/a.txt`)),
            Effect.andThen(Effect.fail(injected("poison.txt")))
          )
        )
        const sandbox = WorkspaceSandbox.makeFileSystem(failing, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* accept(sandbox, [["a.txt", "new-a"], ["poison.txt", "never"]], ["a.txt", "poison.txt"])
        const exit = yield* Effect.exit(sandbox.materialize(accepted))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const codes = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
          expect(codes).toMatchObject([{ code: "host_unavailable" }, { code: "host_unavailable" }])
          expect(String((codes[1] as WorkspaceSandbox.WorkspaceError).message)).toContain("rollback")
        }
        expect(yield* fs.readFileString(`${outside}/victim.txt`)).toBe("OUTSIDE-ORIGINAL")
      })).pipe(Effect.provide(atomicLayer))
    ))

  it.effect("refuses a workspace root replaced between execution and copy-back", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, outside, root } = yield* temp
        const host = swapping(
          fs,
          (operation, path) => operation === "writeFile" && path.endsWith("file.txt"),
          fs.rename(root, `${outside}/moved`).pipe(Effect.andThen(fs.makeDirectory(root)))
        )
        const sandbox = WorkspaceSandbox.makeFileSystem(host, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* accept(sandbox, [["file.txt", "new"]], ["file.txt"])
        expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({ code: "path_escapes_workspace" })
        expect(yield* fs.exists(`${root}/file.txt`)).toBe(false)
      })).pipe(Effect.provide(atomicLayer))
    ))

  it.effect("refuses copy-back through a symlink even when it stays inside the root", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        yield* fs.writeFileString(`${root}/real.txt`, "old")
        yield* fs.symlink("real.txt", `${root}/link.txt`)
        const sandbox = WorkspaceSandbox.makeFileSystem(fs, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* accept(sandbox, [["link.txt", "via-link"]], ["link.txt"])
        expect(yield* Effect.flip(sandbox.materialize(accepted))).toMatchObject({ code: "path_escapes_workspace" })
        expect(yield* fs.readFileString(`${root}/real.txt`)).toBe("old")
      })).pipe(Effect.provide(atomicLayer))
    ))

  it.effect("refuses a path-based host with no descriptor-relative isolation", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const { fs, root } = yield* temp
        // The same Node methods without the descriptor-relative executor.
        const { [KernelFileSystem.AtomicFileSystemTypeId]: _executor, ...pathBased } =
          fs as KernelFileSystem.AtomicHostFileSystem
        const sandbox = WorkspaceSandbox.makeFileSystem(pathBased, hostPath, yield* ArtifactStore.ArtifactStore, root)
        const accepted = yield* accept(sandbox, [["file.txt", "new"]], ["file.txt"])
        const refused = yield* Effect.flip(sandbox.materialize(accepted))
        expect(refused).toMatchObject({ code: "host_unavailable" })
        expect(String(refused.cause)).toContain("descriptor-relative")
        expect(yield* fs.exists(`${root}/file.txt`)).toBe(false)
        const built = yield* Effect.flip(
          Effect.gen(function*() {
            return yield* WorkspaceSandbox.WorkspaceSandbox
          }).pipe(
            Effect.provide(WorkspaceSandbox.layerFileSystem()),
            Effect.provide(KernelWorkspace.layer(root)),
            Effect.provide(ArtifactStore.layerMemory),
            Effect.provide(NodePath.layer),
            Effect.provideService(FileSystem.FileSystem, pathBased)
          )
        )
        expect(built).toMatchObject({ code: "host_unavailable" })
      })).pipe(Effect.provide(atomicLayer))
    ))
})

describe("WorkspaceSandbox on a Windows host", () => {
  it.effect("pins copy-back to the drive root through the host Path", () =>
    Effect.gen(function*() {
      const root = "D:\\a\\kernel"
      const host = win32Host(root)
      const sandbox = yield* WorkspaceSandbox.WorkspaceSandbox.pipe(
        Effect.provide(WorkspaceSandbox.layerFileSystem()),
        Effect.provide(Layer.mergeAll(
          ArtifactStore.layerMemory,
          KernelWorkspace.layer(root),
          NodePath.layerWin32,
          Layer.succeed(FileSystem.FileSystem)(host.fs)
        ))
      )
      yield* withCrypto(Effect.exit(sandbox.materialize({
        _tag: "Accepted",
        cache: { status: "disabled" },
        violations: [],
        result: {
          output: null,
          effects: [],
          provenance: { baseRevision: "base", inputs: [], outputs: [] },
          files: [{
            path: "file.txt",
            beforeDigest: sha256("base"),
            afterDigest: sha256("new"),
            after: encoder.encode("new")
          }]
        }
      })))
      expect(new Set(host.realPaths)).toEqual(new Set([root]))
      expect(host.requests.length).toBeGreaterThan(0)
      for (const request of host.requests) {
        expect(request).toMatchObject({ logicalRoot: root, boundaryRoot: root })
        if ("path" in request) expect(request.path.startsWith(`${root}\\`)).toBe(true)
      }
    }))
})
