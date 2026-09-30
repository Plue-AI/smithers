import { describe, expect, it } from "@effect/vitest"
import {
  Effect,
  Encoding,
  FileSystem as EffectFileSystem,
  Option,
  Path as EffectPath,
  PlatformError,
  Stream
} from "effect"
import * as FileSystem from "../src/FileSystem.ts"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const allowAll = GrantStore.of({
  policy: closedPolicy,
  check: () => Effect.void,
  reply: () => Effect.die("not used"),
  list: Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

const neverGrants = GrantStore.of({
  policy: closedPolicy,
  check: () => Effect.die("confined views never consult a grant store"),
  reply: () => Effect.die("not used"),
  list: Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

/** A descriptor-relative host that records every request and answers it. */
const recordingHost = (ino: Option.Option<number> = Option.some(42)) => {
  const requests: Array<FileSystem.AtomicRequest> = []
  const inner = EffectFileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path === "/alias" ? "/canonical" : path),
    stat: () =>
      Effect.succeed({
        type: "Directory",
        dev: 7,
        ino,
        nlink: Option.some(1)
      } as unknown as EffectFileSystem.File.Info)
  })
  const host = FileSystem.withAtomicFileSystem(inner, {
    execute: (request) => {
      requests.push(request)
      const answers: Partial<Record<FileSystem.AtomicRequest["operation"], unknown>> = {
        exists: true,
        readFile: new Uint8Array([1]),
        readFileString: "text",
        readDirectory: [],
        stat: { type: "File" },
        realPath: "/canonical/x",
        readLink: "x",
        glob: []
      }
      return Effect.succeed(answers[request.operation]) as never
    },
    contentLimit: 4
  })
  return { host, requests }
}

/** Every operation a confined view shares with the guarded layer. */
const exercise = (fs: EffectFileSystem.FileSystem) =>
  Effect.gen(function*() {
    yield* fs.exists("a.txt")
    yield* fs.readFile("dir/a.txt")
    yield* fs.readFileString("dir/a.txt")
    yield* fs.writeFile("dir/a.txt", new Uint8Array([1, 2]))
    yield* fs.writeFileString("dir/b.txt", "hi")
    yield* fs.makeDirectory("dir/sub", { recursive: true })
    yield* fs.remove("dir/a.txt", { force: true })
    yield* fs.rename("dir/b.txt", "dir/c.txt")
    yield* fs.readDirectory("dir")
    yield* fs.stat("dir/c.txt")
    yield* fs.chmod("dir/c.txt", 0o600)
    yield* fs.chown("dir/c.txt", 1, 2)
    yield* fs.readLink("dir/link")
    yield* fs.realPath("dir")
    yield* fs.glob("*.txt")
    yield* fs.glob("**/*.ts", { root: "dir", exclude: ["x/**"] })
    yield* fs.glob("*.md", { root: "dir" })
  })

describe("FileSystem.confined", () => {
  it.effect("keeps the host's exact identity when public stat has no numeric inode", () =>
    Effect.gen(function*() {
      const { host, requests } = recordingHost(Option.none())
      const observed: Array<string> = []
      FileSystem.withAtomicFileSystem(host, {
        ...host[FileSystem.AtomicFileSystemTypeId],
        identifyRoot: (path) =>
          Effect.sync(() => {
            observed.push(path)
            return "7:9007199254740993"
          })
      })
      const view = yield* FileSystem.confined(host, "/alias")
      yield* view.readFile("a")
      yield* view.readFile("b")
      expect(observed).toEqual(["/canonical"])
      expect(requests.map((request) => request.rootIdentity)).toEqual(["7:9007199254740993", "7:9007199254740993"])
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("sends exactly the requests the guarded layer sends, without consulting grants", () =>
    Effect.gen(function*() {
      const viaLayer = recordingHost()
      yield* Effect.gen(function*() {
        yield* exercise(yield* EffectFileSystem.FileSystem)
      }).pipe(
        Effect.provide(FileSystem.layer),
        Effect.provideService(EffectFileSystem.FileSystem, viaLayer.host),
        Effect.provide(Workspace.layer("/alias")),
        Effect.provideService(GrantStore, allowAll)
      )
      const viaConfined = recordingHost()
      yield* Effect.gen(function*() {
        const view = yield* FileSystem.confined(viaConfined.host, "/alias")
        yield* exercise(view)
      }).pipe(Effect.provideService(GrantStore, neverGrants))
      expect(viaConfined.requests).toEqual(viaLayer.requests)
      expect(viaConfined.requests[0]).toMatchObject({
        boundaryRoot: "/canonical",
        logicalRoot: "/alias",
        rootIdentity: "7:42",
        path: "/alias/a.txt"
      })
      expect(viaConfined.requests.find((request) => request.operation === "writeFile")).toMatchObject({
        data: Encoding.encodeBase64(new Uint8Array([1, 2]))
      })
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("refuses a path-based host at construction", () =>
    Effect.gen(function*() {
      const plain = EffectFileSystem.makeNoop({ realPath: (path) => Effect.succeed(path) })
      expect(FileSystem.isConfinable(plain)).toBe(false)
      const refused = yield* Effect.flip(FileSystem.confined(plain, "/w"))
      expect(refused.reason._tag).toBe("PermissionDenied")
      expect(refused.message).toContain("descriptor-relative, no-follow")
      expect((yield* Effect.flip(FileSystem.requireConfinable(plain, "/w"))).reason._tag).toBe("PermissionDenied")
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("refuses a root whose host reports no inode identity to pin", () =>
    Effect.gen(function*() {
      const { host } = recordingHost(Option.none())
      expect((yield* Effect.flip(FileSystem.confined(host, "/alias"))).reason._tag).toBe("PermissionDenied")
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("returns an isolated volume as it is, since its attestation is the boundary", () =>
    Effect.gen(function*() {
      const volume = FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({}))
      expect(FileSystem.isConfinable(volume)).toBe(true)
      expect(yield* FileSystem.confined(volume, "")).toBe(volume)
      yield* FileSystem.requireConfinable(volume, "")
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("accepts the guarded layer's service as the confined view of its own workspace root", () =>
    Effect.gen(function*() {
      const { host } = recordingHost()
      const guarded = yield* EffectFileSystem.FileSystem.pipe(
        Effect.provide(FileSystem.layer),
        Effect.provideService(EffectFileSystem.FileSystem, host),
        Effect.provide(Workspace.layer("/alias")),
        Effect.provideService(GrantStore, allowAll)
      )
      expect(FileSystem.isConfinable(guarded)).toBe(true)
      expect(FileSystem.confinedRoot(guarded)).toBe("/alias")
      expect(FileSystem.confinedRoot(host)).toBeUndefined()
      expect(yield* FileSystem.confined(guarded, "/alias")).toBe(guarded)
      expect((yield* Effect.flip(FileSystem.confined(guarded, "/elsewhere"))).reason._tag).toBe("PermissionDenied")
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("returns a view already pinned to the same root rather than pinning it twice", () =>
    Effect.gen(function*() {
      const { host } = recordingHost()
      const view = yield* FileSystem.confined(host, "/alias")
      expect(FileSystem.isConfinable(view)).toBe(true)
      expect(FileSystem.confinedRoot(view)).toBe("/alias")
      expect(yield* FileSystem.confined(view, "/alias/")).toBe(view)
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("refuses every operation it cannot express as one descriptor-relative request", () =>
    Effect.gen(function*() {
      const { host, requests } = recordingHost()
      const view = yield* FileSystem.confined(host, "/alias")
      const refusals = [
        yield* Effect.flip(view.open("a")),
        yield* Effect.flip(view.copy("a", "b")),
        yield* Effect.flip(view.symlink("a", "b")),
        yield* Effect.flip(view.link("a", "b")),
        yield* Effect.flip(view.truncate("a")),
        yield* Effect.flip(view.copyFile("a", "b")),
        yield* Effect.flip(view.access("a")),
        yield* Effect.flip(view.utimes("a", 0, 0)),
        yield* Effect.flip(view.makeTempDirectory()),
        yield* Effect.flip(view.makeTempDirectoryScoped({ directory: "tmp" }).pipe(Effect.scoped)),
        yield* Effect.flip(view.makeTempFile()),
        yield* Effect.flip(view.makeTempFileScoped().pipe(Effect.scoped)),
        yield* Effect.flip(Stream.runDrain(view.watch("a")))
      ]
      for (const refused of refusals) expect(refused.reason._tag).toBe("PermissionDenied")
      expect(requests).toEqual([])
    }).pipe(Effect.provide(EffectPath.layer)))

  it.effect("refuses a payload over the host's content limit before encoding it", () =>
    Effect.gen(function*() {
      const { host, requests } = recordingHost()
      const view = yield* FileSystem.confined(host, "/alias")
      const refused = yield* Effect.flip(view.writeFile("big", new Uint8Array(5)))
      expect(refused).toBeInstanceOf(PlatformError.PlatformError)
      expect(refused.reason._tag).toBe("BadArgument")
      expect(requests).toEqual([])
    }).pipe(Effect.provide(EffectPath.layer)))
})
