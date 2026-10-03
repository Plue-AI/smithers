import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Exit, Fiber, FileSystem, Option, Path, PlatformError } from "effect"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as Preserve from "../src/internal/Preserve.ts"
import type * as StdError from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

const original = "original content that must survive a failed replacement\n"
const replacement = "replacement content\n"
const handlers: ReadonlyArray<
  { name: string; run: (path: string) => Effect.Effect<unknown, StdError.StdError, FileSystem.FileSystem | Path.Path> }
> = [
  { name: "write", run: (path: string) => Write.run({ path, content: replacement }) },
  { name: "edit", run: (path: string) => Edit.run({ path, oldString: original, newString: replacement }) },
  {
    name: "apply_patch",
    run: (path: string) =>
      ApplyPatch.run({
        input:
          `*** Begin Patch\n*** Update File: ${path}\n@@\n-${original.trimEnd()}\n+${replacement.trimEnd()}\n*** End Patch`
      })
  }
]

const failure = (method: string, path: string) =>
  Effect.fail(PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "injected failure after persisting a prefix"
  }))

describe("atomic replacement", () => {
  it("propagates an initial metadata failure without writing", async () => {
    const error = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "stat",
      pathOrDescriptor: "/denied",
      description: "metadata denied"
    })
    await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      let writes = 0
      const result = yield* Preserve.writeFileString({
        ...fs,
        stat: () => Effect.fail(error),
        writeFileString: () =>
          Effect.sync(() => {
            writes++
          })
      }, "/denied", replacement).pipe(Effect.flip)
      expect(result).toBe(error)
      expect(writes).toBe(0)
    }).pipe(Effect.provide(NodeFileSystem.layer)))
  })

  it.each(["text", "bytes"] as const)("creates an absent file from %s and removes its staged sibling", async (kind) => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const path = `${dir}/new.txt`
        expect(yield* fs.exists(path)).toBe(false)
        if (kind === "text") yield* Preserve.writeFileString(fs, path, replacement)
        else yield* Preserve.writeFile(fs, path, new TextEncoder().encode(replacement))
        expect(new Uint8Array(yield* fs.readFile(path))).toEqual(new TextEncoder().encode(replacement))
        expect(yield* fs.readDirectory(dir)).toEqual(["new.txt"])
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })

  for (const handler of handlers) {
    it(`${handler.name} publishes exact bytes and preserves metadata`, async () => {
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const path = `${dir}/target.txt`
          yield* fs.writeFileString(path, original)
          yield* fs.chmod(path, 0o4750)
          const before = yield* fs.stat(path)
          yield* handler.run(path)
          const after = yield* fs.stat(path)
          expect(new Uint8Array(yield* fs.readFile(path))).toEqual(new TextEncoder().encode(replacement))
          expect(after.mode & 0o7777).toBe(before.mode & 0o7777)
          expect(after.uid).toEqual(before.uid)
          expect(after.gid).toEqual(before.gid)
          expect(yield* fs.readDirectory(dir)).toEqual(["target.txt"])
        })).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Path.layer))
      )
    })

    it(`${handler.name} removes the staged file when interrupted before rename`, async () => {
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const path = `${dir}/target.txt`
          yield* fs.writeFileString(path, original)
          const staged = yield* Deferred.make<void>()
          const faulty = {
            ...fs,
            stat: (target: string) =>
              target === path ?
                fs.stat(target) :
                Deferred.succeed(staged, undefined).pipe(Effect.andThen(Effect.never))
          }
          const fiber = yield* handler.run(path).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty),
            Effect.forkChild
          )
          yield* Deferred.await(staged)
          yield* Fiber.interrupt(fiber)
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
          expect(yield* fs.readFileString(path)).toBe(original)
          expect(yield* fs.readDirectory(dir)).toEqual(["target.txt"])
        })).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Path.layer))
      )
    })

    it.each(["write", "rename"])(`${handler.name} preserves original bytes on %s failure`, async (boundary) => {
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* fs.makeTempDirectoryScoped()
          const path = `${dir}/target.txt`
          yield* fs.writeFileString(path, original)
          yield* fs.chmod(path, 0o640)
          const before = yield* fs.stat(path)
          const faulty = {
            ...fs,
            writeFileString: (target: string, value: string, options?: Parameters<typeof fs.writeFileString>[2]) =>
              boundary === "write"
                ? fs.writeFileString(target, value.slice(0, 3), options).pipe(
                  Effect.andThen(failure("writeFileString", target))
                )
                : fs.writeFileString(target, value, options),
            writeFile: (target: string, value: Uint8Array, options?: Parameters<typeof fs.writeFile>[2]) =>
              boundary === "write"
                ? fs.writeFile(target, value.slice(0, 3), options).pipe(Effect.andThen(failure("writeFile", target)))
                : fs.writeFile(target, value, options),
            rename: (from: string, to: string) => boundary === "rename" ? failure("rename", to) : fs.rename(from, to)
          }
          const exit = yield* Effect.exit(handler.run(path).pipe(Effect.provideService(FileSystem.FileSystem, faulty)))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* fs.readFileString(path)).toBe(original)
          expect((yield* fs.stat(path)).mode & 0o7777).toBe(before.mode & 0o7777)
          expect(yield* fs.readDirectory(dir)).toEqual(["target.txt"])
        })).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Path.layer))
      )
    })
  }
  it("preserves an existing symlink and replaces its target in the target directory", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.makeDirectory(`${dir}/nested`)
        const target = `${dir}/nested/target.txt`
        const link = `${dir}/link.txt`
        yield* fs.writeFileString(target, original)
        yield* fs.symlink(target, link)
        const before = yield* fs.readLink(link)
        yield* Preserve.writeFileString(fs, link, replacement)
        expect(yield* fs.readLink(link)).toBe(before)
        expect(yield* fs.readFileString(target)).toBe(replacement)
        expect(yield* fs.readDirectory(`${dir}/nested`)).toEqual(["target.txt"])
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })

  it("does not remove or overwrite a colliding temporary file", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const path = `${dir}/target.txt`
        yield* fs.writeFileString(path, original)
        let collision = ""
        const faulty = {
          ...fs,
          writeFileString: (target: string, content: string, options?: Parameters<typeof fs.writeFileString>[2]) =>
            Effect.gen(function*() {
              collision = target
              yield* fs.writeFileString(target, "someone else's bytes")
              yield* fs.writeFileString(target, content, options)
            })
        }
        expect(Exit.isFailure(yield* Effect.exit(Preserve.writeFileString(faulty, path, replacement)))).toBe(true)
        expect(yield* fs.readFileString(path)).toBe(original)
        expect(yield* fs.readFileString(collision)).toBe("someone else's bytes")
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })

  it.each(["write", "rename"])("leaves a new destination absent on %s failure", async (boundary) => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const faulty = {
          ...fs,
          writeFileString: (target: string, content: string, options?: Parameters<typeof fs.writeFileString>[2]) =>
            boundary === "write"
              ? fs.writeFileString(target, content.slice(0, 3), options).pipe(
                Effect.andThen(failure("writeFileString", target))
              )
              : fs.writeFileString(target, content, options),
          rename: (from: string, to: string) => boundary === "rename" ? failure("rename", to) : fs.rename(from, to)
        }
        expect(Exit.isFailure(yield* Effect.exit(Preserve.writeFileString(faulty, `${dir}/new.txt`, replacement))))
          .toBe(true)
        expect(yield* fs.readDirectory(dir)).toEqual([])
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })

  it("rewrites a file it cannot give its owner in place", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const path = `${dir}/target.txt`
        yield* fs.writeFileString(path, original)
        yield* fs.chmod(path, 0o664)
        const before = yield* fs.stat(path)
        const foreign = Option.map(before.uid, (uid) => uid + 1)
        const chowns: Array<string> = []
        // A group-writable file owned by another user: this process may write
        // it but may not give a sibling that owner.
        const faulty = {
          ...fs,
          stat: (target: string) =>
            target === path ? fs.stat(target).pipe(Effect.map((info) => ({ ...info, uid: foreign }))) : fs.stat(target),
          chown: (target: string) =>
            Effect.suspend(() => {
              chowns.push(target)
              return Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "chown",
                pathOrDescriptor: target
              }))
            })
        }
        yield* Preserve.writeFileString(faulty, path, replacement)
        const after = yield* fs.stat(path)
        expect(chowns).toHaveLength(1)
        expect(yield* fs.readFileString(path)).toBe(replacement)
        expect(after.ino).toEqual(before.ino)
        expect(after.mode & 0o7777).toBe(before.mode & 0o7777)
        expect(yield* fs.readDirectory(dir)).toEqual(["target.txt"])
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })

  it.each(["uid", "gid"] as const)("keeps an unspecified %s when assigning the other owner field", async (missing) => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const path = `${dir}/target.txt`
        yield* fs.writeFileString(path, original)
        yield* fs.chmod(path, 0o4750)
        const before = yield* fs.stat(path)
        const uid = missing === "uid" ? Option.none<number>() : Option.map(before.uid, (value) => value + 1)
        const gid = missing === "gid" ? Option.none<number>() : Option.map(before.gid, (value) => value + 1)
        const assignments: Array<ReadonlyArray<number>> = []
        const modes: Array<number> = []
        // The host's optional ownership metadata is a boundary condition;
        // files and their staged bytes still use the real filesystem.
        const boundary = {
          ...fs,
          stat: (target: string) =>
            target === path
              ? fs.stat(target).pipe(Effect.map((info) => ({ ...info, uid, gid })))
              : fs.stat(target),
          chown: (_target: string, owner: number, group: number) =>
            Effect.sync(() => {
              assignments.push([owner, group])
            }),
          chmod: (target: string, mode: number) => {
            modes.push(mode)
            return fs.chmod(target, mode)
          }
        }
        yield* Preserve.writeFile(boundary, path, new TextEncoder().encode(replacement))
        expect(assignments).toEqual([[Option.getOrElse(uid, () => -1), Option.getOrElse(gid, () => -1)]])
        expect(modes).toEqual([before.mode & 0o7777])
        expect(yield* fs.readFileString(path)).toBe(replacement)
        expect((yield* fs.stat(path)).mode & 0o7777).toBe(before.mode & 0o7777)
        expect(yield* fs.readDirectory(dir)).toEqual(["target.txt"])
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })

  it("propagates an unexpected ownership failure and cleans the staged bytes", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        const path = `${dir}/target.txt`
        yield* fs.writeFileString(path, original)
        const faulty = {
          ...fs,
          stat: (target: string) =>
            target === path
              ? fs.stat(target).pipe(Effect.map((info) => ({
                ...info,
                uid: Option.map(info.uid, (uid) => uid + 1)
              })))
              : fs.stat(target),
          chown: (target: string) => failure("chown", target)
        }
        const error = yield* Effect.flip(Preserve.writeFileString(faulty, path, replacement))
        expect(error.reason._tag).toBe("Unknown")
        expect(yield* fs.readFileString(path)).toBe(original)
        expect(yield* fs.readDirectory(dir)).toEqual(["target.txt"])
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
  })
})
