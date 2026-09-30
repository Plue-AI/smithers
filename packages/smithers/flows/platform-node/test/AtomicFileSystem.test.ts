// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, FileSystem, Layer, Option } from "effect"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmod,
  glob,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const directories = new Set<string>()

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "flows-node-atomic-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

/** Whether nothing is at `path` any more. */
const gone = (path: string) => lstat(path).then(() => false, () => true)

const guarded = (root: string, host: Layer.Layer<FileSystem.FileSystem> = AtomicFileSystem.layer) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(host),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

const swappingHost = (swap: () => Promise<void>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const atomic = (fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
      let swapped = false
      return KernelFileSystem.withAtomicFileSystem(fileSystem, {
        ...atomic,
        execute: (request) =>
          Effect.promise(async () => {
            if (!swapped) {
              swapped = true
              await swap()
            }
          }).pipe(Effect.andThen(atomic.execute(request)))
      })
    })
  ).pipe(Layer.provide(AtomicFileSystem.layer))

const run = <A, E>(root: string, effect: Effect.Effect<A, E, FileSystem.FileSystem>, host = AtomicFileSystem.layer) =>
  effect.pipe(Effect.provide(guarded(root, host)))

describe("Node atomic filesystem", () => {
  it.live("accepts its own realPath result under a workspace alias", () =>
    Effect.gen(function*() {
      const parent = yield* Effect.promise(() => temporaryDirectory())
      const root = join(parent, "actual")
      const alias = join(parent, "alias")
      yield* Effect.promise(() => mkdir(root))
      yield* Effect.promise(() => symlink(root, alias))
      yield* run(
        alias,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(join(alias, "original"), "before")
          const canonical = yield* fs.realPath(join(alias, "original"))
          expect(yield* fs.realPath(canonical)).toBe(canonical)
          const temporary = `${canonical}.tmp`
          yield* fs.writeFileString(temporary, "after", { flag: "wx", mode: 0o600 })
          yield* fs.chmod(temporary, 0o640)
          yield* fs.rename(temporary, canonical)
          expect(yield* fs.readFileString(join(alias, "original"))).toBe("after")
          expect((yield* fs.stat(canonical)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o640)
        })
      )
    }))

  it.live("preserves file modes through descriptor-relative chmod and refuses linked targets", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const file = join(root, "mode.txt")
      yield* Effect.promise(() => writeFile(file, "keep", { mode: 0o600 }))
      yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.chmod(file, 0o640)
          expect((yield* fs.stat(file)).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o640)
          yield* fs.chown(file, -1, -1)
          expect(yield* fs.readFileString(file)).toBe("keep")
          expect((yield* Effect.flip(fs.chmod(file, -1))).reason._tag).toBe("Unknown")
          expect((yield* Effect.flip(fs.chown(file, -2, -1))).reason._tag).toBe("Unknown")
          yield* Effect.promise(() => symlink(file, join(root, "symbolic")))
          yield* Effect.promise(() => link(file, join(root, "hard")))
          for (const path of [file, join(root, "symbolic"), join(root, "hard"), root]) {
            expect((yield* Effect.exit(fs.chmod(path, 0o777)))._tag).toBe("Failure")
            expect((yield* Effect.exit(fs.chown(path, -1, -1)))._tag).toBe("Failure")
          }
        })
      )
      expect((yield* Effect.promise(() => lstat(file))).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o640)
    }))

  it.live("executes every descriptor-relative operation without path re-resolution", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const nested = join(root, "nested")
          const text = join(nested, "text.txt")
          const bytes = join(nested, "bytes.bin")
          const link = join(root, "text-link")
          const renamed = join(nested, "renamed.txt")
          yield* fs.makeDirectory(nested, { recursive: true })
          yield* fs.writeFileString(text, "hello")
          yield* fs.writeFile(bytes, new Uint8Array([1, 2, 3]))
          const textValue = yield* fs.readFileString(text)
          const bytesValue = yield* fs.readFile(bytes)
          const present = yield* fs.exists(text)
          const absent = yield* fs.exists(join(root, "missing.txt"))
          yield* Effect.promise(() => symlink("nested/text.txt", link))
          const linkTarget = yield* fs.readLink(link)
          yield* Effect.promise(() => rm(link))
          const real = yield* fs.realPath(text)
          const info = yield* fs.stat(text)
          const entries = yield* fs.readDirectory(root, { recursive: true })
          const matches = yield* fs.glob("**/*.txt", { root })
          yield* fs.rename(text, renamed)
          yield* fs.remove(nested, { recursive: true })
          return { absent, bytesValue: [...bytesValue], entries, info, linkTarget, matches, present, real, textValue }
        })
      )

      expect(outcome).toMatchObject({
        absent: false,
        bytesValue: [1, 2, 3],
        linkTarget: join("nested", "text.txt"),
        present: true,
        textValue: "hello"
      })
      expect(outcome.real).toMatch(/nested[\\/]text\.txt$/)
      expect(outcome.info.type).toBe("File")
      expect(outcome.entries).toContain("nested/text.txt")
      expect(outcome.matches).toEqual([join(root, "nested/text.txt")])
    }), 30_000)

  it.live(
    "rejects every operation when an intermediate component is swapped after authorization",
    () =>
      Effect.gen(function*() {
        const operations = [
          (fs: FileSystem.FileSystem, path: string, root: string) => fs.readFile(path),
          (fs: FileSystem.FileSystem, path: string) => fs.writeFile(path, new Uint8Array([9])),
          (fs: FileSystem.FileSystem, path: string) => fs.writeFileString(path, "escaped"),
          (fs: FileSystem.FileSystem, path: string) => fs.makeDirectory(join(path, "child")),
          (fs: FileSystem.FileSystem, path: string) => fs.remove(path),
          (fs: FileSystem.FileSystem, path: string, root: string) => fs.rename(path, join(root, "renamed.txt")),
          (fs: FileSystem.FileSystem, _path: string, _root: string, gate: string) => fs.readDirectory(gate),
          (fs: FileSystem.FileSystem, path: string) => fs.stat(path)
        ] as const

        for (const operation of operations) {
          const directory = yield* Effect.promise(() => temporaryDirectory())
          const root = join(directory, "workspace")
          const outside = join(directory, "outside")
          const gate = join(root, "gate")
          const parked = join(root, "parked")
          const target = join(gate, "victim.txt")
          const outsideVictim = join(outside, "victim.txt")
          yield* Effect.promise(() => mkdir(gate, { recursive: true }))
          yield* Effect.promise(() => mkdir(outside))
          yield* Effect.promise(() => writeFile(target, "inside"))
          yield* Effect.promise(() => writeFile(outsideVictim, "outside"))
          const result = yield* run(
            root,
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              return yield* Effect.result(operation(fs, target, root, gate))
            }),
            swappingHost(async () => {
              await rename(gate, parked)
              await symlink(outside, gate)
            })
          )
          expect(result._tag).toBe("Failure")
          expect(yield* Effect.promise(() => readFile(outsideVictim, "utf8"))).toBe("outside")
        }
      }),
    30_000
  )

  for (const swap of ["ancestor symlink", "real root directory"] as const) {
    for (const operation of ["readFileString", "writeFileString", "remove"] as const) {
      it.live(`refuses ${operation} after the ${swap} swap following authorization`, () =>
        Effect.gen(function*() {
          const directory = yield* Effect.promise(() => temporaryDirectory())
          const parent = join(directory, "parent")
          const root = join(parent, "workspace")
          const outside = join(directory, "outside")
          const replacement = join(outside, "workspace")
          const parked = join(directory, "parked")
          const target = join(root, "victim.txt")
          yield* Effect.promise(async () => {
            await mkdir(root, { recursive: true })
            await mkdir(replacement, { recursive: true })
            await writeFile(target, "inside")
            await writeFile(join(replacement, "victim.txt"), "outside-secret")
          })
          const result = yield* run(
            root,
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              return yield* Effect.result(
                operation === "writeFileString" ? fs.writeFileString(target, "escaped") : fs[operation](target)
              )
            }),
            swappingHost(async () => {
              if (swap === "ancestor symlink") {
                await rename(parent, parked)
                await symlink(outside, parent)
              } else {
                await rename(root, parked)
                await rename(replacement, root)
              }
            })
          )
          expect(result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "PermissionDenied" } } })
          const outsideVictim = join(swap === "ancestor symlink" ? replacement : root, "victim.txt")
          const insideVictim = join(parked, ...(swap === "ancestor symlink" ? ["workspace"] : []), "victim.txt")
          expect(yield* Effect.promise(() => readFile(outsideVictim, "utf8"))).toBe("outside-secret")
          expect(yield* Effect.promise(() => readFile(insideVictim, "utf8"))).toBe("inside")
        }))
    }
  }

  /**
   * Listings rooted above the planted link never report paths behind it.
   * A glob anchored at the link is refused by canonical authorization.
   */
  it.live("reports nothing behind an intermediate component swapped to an outside directory", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      const gate = join(root, "gate")
      const parked = join(root, "parked")
      yield* Effect.promise(() => mkdir(gate, { recursive: true }))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(join(gate, "victim.txt"), "inside"))
      yield* Effect.promise(() => writeFile(join(outside, "victim.txt"), "outside"))

      const result = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            listing: yield* Effect.result(fs.readDirectory(gate)),
            rootedGlob: yield* Effect.result(fs.glob("**", { root: gate })),
            matched: yield* Effect.result(fs.glob("gate/**", { root })),
            everything: yield* fs.readDirectory(root, { recursive: true })
          }
        }),
        swappingHost(async () => {
          await rename(gate, parked)
          await symlink(outside, gate)
        })
      )

      // Opening the swapped directory itself still fails closed, whether it is
      // named as the listing target or as a glob root.
      expect(result.listing._tag).toBe("Failure")
      expect(result.rootedGlob._tag).toBe("Failure")
      expect(result.matched).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "PermissionDenied" } }
      })
      expect(result.everything).toContain("gate")
      expect(result.everything.some((entry) => entry.startsWith("gate/"))).toBe(false)
      expect(yield* Effect.promise(() => readFile(join(outside, "victim.txt"), "utf8"))).toBe("outside")
    }))

  it.live("rejects final-component swaps for file, directory, and rename sources", () =>
    Effect.gen(function*() {
      const operations = [
        (fs: FileSystem.FileSystem, path: string, root: string) => fs.readFile(path),
        (fs: FileSystem.FileSystem, path: string) => fs.writeFile(path, new Uint8Array([9])),
        (fs: FileSystem.FileSystem, path: string) => fs.writeFileString(path, "escaped"),
        (fs: FileSystem.FileSystem, path: string) => fs.remove(path),
        (fs: FileSystem.FileSystem, path: string, root: string) => fs.rename(path, join(root, "renamed.txt")),
        (fs: FileSystem.FileSystem, path: string) => fs.stat(path)
      ] as const

      for (const operation of operations) {
        const directory = yield* Effect.promise(() => temporaryDirectory())
        const root = join(directory, "workspace")
        const outside = join(directory, "outside")
        const target = join(root, "target.txt")
        const parked = join(root, "parked.txt")
        const outsideVictim = join(outside, "victim.txt")
        yield* Effect.promise(() => mkdir(root))
        yield* Effect.promise(() => mkdir(outside))
        yield* Effect.promise(() => writeFile(target, "inside"))
        yield* Effect.promise(() => writeFile(outsideVictim, "outside"))
        const result = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* Effect.result(operation(fs, target, root))
          }),
          swappingHost(async () => {
            await rename(target, parked)
            await symlink(outsideVictim, target)
          })
        )
        expect(result._tag).toBe("Failure")
        expect(yield* Effect.promise(() => readFile(outsideVictim, "utf8"))).toBe("outside")
      }

      const directory = yield* Effect.promise(() => temporaryDirectory())
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(root, "new-directory")
      yield* Effect.promise(() => mkdir(root))
      yield* Effect.promise(() => mkdir(outside))
      const result = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.makeDirectory(target))),
        swappingHost(() => symlink(outside, target))
      )
      expect(result._tag).toBe("Failure")

      const container = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(container, "workspace")
      const outsideDirectory = join(container, "outside")
      const directoryTarget = join(workspace, "target")
      const parked = join(workspace, "parked")
      yield* Effect.promise(() => mkdir(directoryTarget, { recursive: true }))
      yield* Effect.promise(() => mkdir(outsideDirectory))
      yield* Effect.promise(() => writeFile(join(outsideDirectory, "victim.txt"), "outside"))
      const directoryResult = yield* run(
        workspace,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.readDirectory(directoryTarget))),
        swappingHost(async () => {
          await rename(directoryTarget, parked)
          await symlink(outsideDirectory, directoryTarget)
        })
      )
      expect(directoryResult._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(join(outsideDirectory, "victim.txt"), "utf8"))).toBe("outside")

      const renameContainer = yield* Effect.promise(() => temporaryDirectory())
      const renameWorkspace = join(renameContainer, "workspace")
      const renameOutside = join(renameContainer, "outside")
      const source = join(renameWorkspace, "source.txt")
      const destination = join(renameWorkspace, "destination.txt")
      const renameVictim = join(renameOutside, "victim.txt")
      yield* Effect.promise(() => mkdir(renameWorkspace))
      yield* Effect.promise(() => mkdir(renameOutside))
      yield* Effect.promise(() => writeFile(source, "inside"))
      yield* Effect.promise(() => writeFile(renameVictim, "outside"))
      const renameResult = yield* run(
        renameWorkspace,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.rename(source, destination))),
        swappingHost(() => symlink(renameVictim, destination))
      )
      expect(renameResult._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(renameVictim, "utf8"))).toBe("outside")

      const hardLinkContainer = yield* Effect.promise(() => temporaryDirectory())
      const hardLinkWorkspace = join(hardLinkContainer, "workspace")
      const hardLinkOutside = join(hardLinkContainer, "outside")
      const hardLinkTarget = join(hardLinkWorkspace, "target.txt")
      const hardLinkParked = join(hardLinkWorkspace, "parked.txt")
      const hardLinkVictim = join(hardLinkOutside, "victim.txt")
      yield* Effect.promise(() => mkdir(hardLinkWorkspace))
      yield* Effect.promise(() => mkdir(hardLinkOutside))
      yield* Effect.promise(() => writeFile(hardLinkTarget, "inside"))
      yield* Effect.promise(() => writeFile(hardLinkVictim, "outside"))
      const hardLinkResult = yield* run(
        hardLinkWorkspace,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.writeFileString(hardLinkTarget, "escaped"))),
        swappingHost(async () => {
          await rename(hardLinkTarget, hardLinkParked)
          await link(hardLinkVictim, hardLinkTarget)
        })
      )
      expect(hardLinkResult._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(hardLinkVictim, "utf8"))).toBe("outside")
    }))

  it.live("names symlink entries when listing without ever descending through one", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      yield* Effect.promise(() => mkdir(join(root, "real"), { recursive: true }))
      yield* Effect.promise(() => mkdir(join(outside, "hidden"), { recursive: true }))
      yield* Effect.promise(() => writeFile(join(root, "real", "kept.txt"), "inside"))
      yield* Effect.promise(() => writeFile(join(outside, "hidden", "secret.txt"), "outside"))
      // A link to a directory outside the root, and a link to a file inside it.
      yield* Effect.promise(() => symlink(outside, join(root, "escape")))
      yield* Effect.promise(() => symlink(join(root, "real", "kept.txt"), join(root, "alias.txt")))

      const listed = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            entries: yield* fs.readDirectory(root, { recursive: true }),
            shallow: yield* fs.readDirectory(root),
            matches: yield* fs.glob("**/*.txt", { root })
          }
        })
      )

      // The links are reported by name — a listing resolves nothing.
      expect(listed.shallow).toEqual(["alias.txt", "escape", "real"])
      expect(listed.entries).toContain("escape")
      expect(listed.entries).toContain("real/kept.txt")
      // ...and nothing behind either link is ever reached.
      expect(listed.entries.some((entry) => entry.startsWith("escape/"))).toBe(false)
      expect(listed.matches).toEqual([join(root, "alias.txt"), join(root, "real/kept.txt")])
    }))

  it.live("surfaces helper rejection as a typed platform failure", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt"))))
      )
      expect(failure).toMatchObject({ reason: { _tag: "NotFound" } })
    }))

  /**
   * The helper is configuration, not discovery, so every unusable helper
   * is reached through the layer seam rather than by editing `PATH`.
   * The Rust helper tests pin the identity and framing cases; this
   * one only pins that an unusable helper never degrades into a path-based
   * call.
   */
  it.live("fails closed when the configured helper is absent or exits unsuccessfully", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const bin = join(yield* Effect.promise(() => temporaryDirectory()), "bin")
      yield* Effect.promise(() => mkdir(bin))
      const executable = join(bin, "helper")
      const trailing = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt")))),
        AtomicFileSystem.layerWith({ executable: `${executable}/` })
      )
      expect(trailing).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      const attempt = run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt")))),
        AtomicFileSystem.layerWith({ executable })
      )

      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })

      yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\necho helper-failed >&2\nexit 7\n"))
      yield* Effect.promise(() => chmod(executable, 0o755))
      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })

      yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\nexit 7\n"))
      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })

      yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\nprintf '{\"ok\":false}\\n'\n"))
      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("addresses the workspace root itself instead of rejecting an empty component list", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(root, "kept")))
      yield* Effect.promise(() => writeFile(join(root, "kept", "file.txt"), "inside"))
      const canonical = yield* Effect.promise(() => realpath(root))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            // `join(root, ".")` normalizes to the root, so the same request
            // reaches the helper however the caller spelled it.
            dotted: yield* fs.exists(join(root, ".")),
            entries: yield* fs.readDirectory(root),
            existing: yield* fs.exists(root),
            info: yield* fs.stat(root),
            matches: yield* fs.glob("**/*.txt", { root }),
            real: yield* fs.realPath(root),
            recursiveDirectory: yield* Effect.result(fs.makeDirectory(root, { recursive: true })),
            // Everything below has to stay refused: it would either destroy or
            // move the pinned root, or read it as something it is not.
            directory: yield* Effect.flip(fs.makeDirectory(root)),
            link: yield* Effect.flip(fs.readLink(root)),
            read: yield* Effect.flip(fs.readFile(root)),
            removal: yield* Effect.flip(fs.remove(root, { recursive: true })),
            renamedAway: yield* Effect.flip(fs.rename(root, join(root, "moved"))),
            renamedOnto: yield* Effect.flip(fs.rename(join(root, "kept"), root)),
            write: yield* Effect.flip(fs.writeFileString(root, "clobbered"))
          }
        })
      )

      expect(outcome.existing).toBe(true)
      expect(outcome.dotted).toBe(true)
      expect(outcome.info.type).toBe("Directory")
      expect(outcome.entries).toEqual(["kept"])
      expect(outcome.matches).toEqual([join(root, "kept/file.txt")])
      expect(outcome.real).toBe(canonical)
      expect(outcome.recursiveDirectory._tag).toBe("Success")
      expect(outcome.directory).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      expect(outcome.read).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.write).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.removal).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.renamedAway).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.renamedOnto).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.link.reason._tag).toBe("Unknown")
      expect(outcome.link.cause).toMatchObject({ code: "EINVAL", syscall: "readlink" })
      // The refused operations left the root and its contents untouched.
      expect(yield* Effect.promise(() => readFile(join(root, "kept", "file.txt"), "utf8"))).toBe("inside")
    }))

  it.live("creates recursive directories concurrently under a shared missing ancestor", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* Effect.forEach(
            Array.from({ length: 8 }, (_, index) => index),
            (index) => fs.makeDirectory(join(root, "shared", "nested", String(index)), { recursive: true }),
            { concurrency: "unbounded" }
          )
          expect((yield* fs.readDirectory(join(root, "shared", "nested"))).sort()).toEqual(
            Array.from({ length: 8 }, (_, index) => String(index))
          )
        }),
        AtomicFileSystem.layerWith({ concurrency: 2 })
      )
    }))

  it.live("only lets a recursive makeDirectory succeed over a real directory", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const outside = join(yield* Effect.promise(() => temporaryDirectory()), "outside")
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(join(outside, "victim.txt"), "outside"))
      yield* Effect.promise(() => mkdir(join(root, "directory")))
      yield* Effect.promise(() => writeFile(join(root, "file.txt"), "regular"))
      yield* Effect.promise(() => symlink(outside, join(root, "escape")))
      yield* Effect.promise(() => symlink(join(root, "directory"), join(root, "alias")))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            alias: yield* Effect.flip(fs.makeDirectory(join(root, "alias"), { recursive: true })),
            directory: yield* Effect.result(fs.makeDirectory(join(root, "directory"), { recursive: true })),
            escape: yield* Effect.flip(fs.makeDirectory(join(root, "escape"), { recursive: true })),
            file: yield* Effect.flip(fs.makeDirectory(join(root, "file.txt"), { recursive: true })),
            nestedUnderFile: yield* Effect.flip(
              fs.makeDirectory(join(root, "file.txt", "child"), { recursive: true })
            )
          }
        })
      )

      expect(outcome.directory._tag).toBe("Success")
      // An existing regular file is not a directory, so `recursive` cannot
      // absorb its EEXIST.
      expect(outcome.file).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      // A symlink is refused even when it points at a directory, inside or out.
      expect(outcome.escape).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.alias).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.nestedUnderFile).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(yield* Effect.promise(() => readFile(join(root, "file.txt"), "utf8"))).toBe("regular")
      expect(yield* Effect.promise(() => readFile(join(outside, "victim.txt"), "utf8"))).toBe("outside")
      expect(yield* Effect.promise(() => readFile(join(root, "escape", "victim.txt"), "utf8"))).toBe("outside")
    }))

  it.live("implements every OpenFlag exactly as the native Node filesystem does", () =>
    Effect.gen(function*() {
      const flags: ReadonlyArray<FileSystem.OpenFlag> = [
        "r",
        "r+",
        "w",
        "wx",
        "w+",
        "wx+",
        "a",
        "ax",
        "a+",
        "ax+"
      ]
      const outcome = (
        execute: (
          root: string,
          effect: Effect.Effect<boolean, never, FileSystem.FileSystem>
        ) => Effect.Effect<boolean, unknown>,
        flag: FileSystem.OpenFlag,
        seeded: boolean
      ) =>
        Effect.gen(function*() {
          const root = yield* Effect.promise(() => temporaryDirectory())
          const target = join(root, "target.txt")
          if (seeded) yield* Effect.promise(() => writeFile(target, "seed"))
          const failed = yield* execute(
            root,
            Effect.flatMap(FileSystem.FileSystem, (fs) =>
              Effect.match(fs.writeFileString(target, "ab", { flag }), {
                onFailure: () => true,
                onSuccess: () => false
              }))
          )
          const content = yield* Effect.promise(() => readFile(target, "utf8").catch(() => null))
          return { content, failed, flag, seeded }
        })
      const table = (
        execute: (
          root: string,
          effect: Effect.Effect<boolean, never, FileSystem.FileSystem>
        ) => Effect.Effect<boolean, unknown>
      ) =>
        Effect.forEach(
          flags.flatMap((flag) => [true, false].map((seeded) => ({ flag, seeded }))),
          ({ flag, seeded }) => outcome(execute, flag, seeded)
        )

      const atomic = yield* table((root, effect) => run(root, effect))
      const native = yield* table((_root, effect) => effect.pipe(Effect.provide(NodeFileSystem.layer)))
      expect(atomic).toEqual(native)

      const entry = (flag: FileSystem.OpenFlag, seeded: boolean) =>
        atomic.find((row) => row.flag === flag && row.seeded === seeded)
      // A read-only flag never writes, and never creates the file either.
      expect(entry("r", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("r", false)).toMatchObject({ content: null, failed: true })
      // `r+` requires the file and overwrites in place without truncating.
      expect(entry("r+", true)).toMatchObject({ content: "abed", failed: false })
      expect(entry("r+", false)).toMatchObject({ content: null, failed: true })
      // `w`/`w+` create and truncate; `wx`/`wx+` are exclusive.
      expect(entry("w", true)).toMatchObject({ content: "ab", failed: false })
      expect(entry("w+", true)).toMatchObject({ content: "ab", failed: false })
      expect(entry("wx", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("wx+", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("wx", false)).toMatchObject({ content: "ab", failed: false })
      // The append family never truncates, and the exclusive variants still
      // refuse an existing file.
      expect(entry("a", true)).toMatchObject({ content: "seedab", failed: false })
      expect(entry("a+", true)).toMatchObject({ content: "seedab", failed: false })
      expect(entry("a", false)).toMatchObject({ content: "ab", failed: false })
      expect(entry("ax", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("ax+", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("ax+", false)).toMatchObject({ content: "ab", failed: false })
    }), 30_000)

  /**
   * The helper cannot call Node's globber, so it implements the grammar itself.
   * That grammar is only correct if it agrees with the globber it replaces,
   * exclusions included, so it is compared against it rather than against a
   * hand-written expectation.
   */
  it.live("selects and excludes the same paths the native globber does", () =>
    Effect.gen(function*() {
      const patterns = (root: string): ReadonlyArray<readonly [string, ReadonlyArray<string> | undefined]> => [
        ["*.txt", undefined],
        ["**/*.txt", undefined],
        ["nested/*", undefined],
        ["**/*.txt", ["nested/**"]],
        ["**/*.txt", ["**/deep/**"]],
        ["nested/*", ["*.log"]],
        ["nested/*", ["nested/*.log"]],
        // The root is not an entry in its own walk, so deciding its exclusion
        // only while filtering results leaks every child the caller forbade.
        ["**/*.txt", ["."]],
        ["**/*.txt", [""]],
        ["**/*.txt", [root]],
        ["**/*.txt", [`${root}/`]],
        ["**", [root]],
        ["nested/?id.txt", undefined],
        ["**/*.[tl]??", undefined],
        ["**/*.[!l]??", undefined],
        ["**/*.txt", ["**"]],
        // An exclude the caller passed as an ABSOLUTE path, which the kernel
        // forwards verbatim while it normalizes the pattern. It used to match
        // nothing at all, so the caller received the paths it had forbidden.
        ["**/*.txt", [join(root, "nested", "**")]],
        ["**/*.txt", [join(root, "nested")]],
        // Excluding a directory excludes its subtree, not just its own entry.
        ["**/*.txt", ["nested"]],
        ["**/*.txt", ["nested/"]],
        ["**/*.txt", ["**/deep"]],
        ["**/*.txt", ["*"]],
        // Matched against the whole relative name, so a bare basename does not.
        ["**/*.txt", ["mid.txt"]],
        ["**/*.txt", ["**/mid.txt"]],
        // Brace alternation, which used to compile to literal braces and match
        // nothing.
        ["{top,a-b}.txt", undefined],
        ["**/{mid,low}.txt", undefined],
        ["**/*.{txt,log}", undefined],
        ["{nested,.}/*.txt", undefined],
        ["nested/{deep,}/*", undefined],
        // A group with no top-level comma is literal text, but a group inside
        // it is still an alternation: "{{a,b}}" is "{a}" and "{b}".
        ["{{top,a-b}}.txt", undefined],
        ["{{top,a-b}}", undefined],
        ["{top,{a-b,nested}}", undefined],
        // An unbalanced brace is literal text, not a failure.
        ["{a,b", undefined],
        ["*.tx[t", undefined],
        // A trailing slash selects directories only, and "**" spans zero
        // segments, so both of these name the glob root itself.
        ["**/", undefined],
        ["nested/", undefined],
        ["nested/**", undefined],
        ["nested/**/", undefined],
        // A trailing `**` names a non-directory anchor only when every segment
        // before it is literal.
        ["*/**", undefined],
        ["*/**/", undefined],
        ["t*.txt/**", undefined],
        ["nested/*/**", undefined],
        ["**/mid.txt/**", undefined],
        ["**/top.txt/**", undefined],
        ["{nested,x}/mid.txt/**", undefined],
        ["{nested,*}/mid.txt/**", undefined],
        ["nested/mid.txt/**", undefined],
        // Parentheses inside a character class are members, not extglob
        // delimiters.
        ["[!(]*", undefined],
        ["**/[!(]*.txt", undefined],
        ["[0?(].txt", undefined],
        // Node drops backslashes from an absolute selector and from excludes,
        // leaving the following wildcard active.
        ["\\*.txt", undefined],
        ["**/*.txt", ["\\a-b.txt"]],
        ["**/*.txt", [join(root, "\\top.txt")]],
        ["**", undefined],
        ["**/**", undefined],
        ["*", undefined],
        ["[tn]*", undefined],
        ["**/*", undefined],
        ["nested/../*.txt", undefined],
        ["./*.txt", undefined],
        // The dotfile rule: a wildcard never reaches into a name that starts
        // with a dot, but a segment that SPELLS the dot does, including inside
        // a character class.
        [".*", undefined],
        [".hidden/*", undefined],
        ["**/.hidden/**/.wanted", undefined],
        ["[.]hidden/**/.wanted", undefined],
        ["[.]dot.txt", undefined],
        ["[.]*", undefined],
        // A one-member positive class is literal text to the globber, so `[.]`
        // is a `.` segment and not a name no directory holds. It survives the
        // cleanup a SPELLED `.` does not, and a LAST one names whatever the
        // segments before it addressed.
        ["[.]", undefined],
        ["nested/[.]", undefined],
        [".hidden/[.]", undefined],
        ["{top.txt,nested}/mid.txt/[.]", undefined],
        ["nested/deep/[.]", undefined],
        // Only a directory, unless every segment before it is literal, which is
        // the same rule a trailing `**` follows. A `**` immediately before it
        // is the exception: nothing addresses the path for it.
        ["*/[.]", undefined],
        ["t*.txt/[.]", undefined],
        ["**/[.]", undefined],
        ["**/deep/[.]", undefined],
        // Anywhere but last it names an entry called `.`, and finds none.
        ["[.]/*", undefined],
        ["nested/[.]/mid.txt", undefined],
        ["nested/[.]/", undefined],
        // An exclusion never addresses a path, so it never reaches the anchor.
        ["**/*.txt", ["nested/[.]"]],
        ["[t]op.txt", undefined],
        ["[]]*", undefined],
        ["**/[m]id.txt", undefined],
        // A NEGATED class happens to match a dot, and still must not reach one:
        // asking whether the class matches the dot is the wrong question.
        ["[!a]*", undefined],
        ["[^t]*", undefined],
        ["[!.]*", undefined],
        ["**/[!.]*", undefined],
        // A trailing globstar exclusion retains its own directory anchor.
        // This adapter pins the same answer for every selector.
        ["**/*", ["nested/**"]],
        ["**/*", ["nested"]]
      ]
      const seed = async () => {
        const root = await temporaryDirectory()
        await mkdir(join(root, "nested", "deep"), { recursive: true })
        await mkdir(join(root, ".hidden"), { recursive: true })
        await mkdir(join(root, ".hidden", "nested"), { recursive: true })
        await mkdir(join(root, ".hidden", ".nested"), { recursive: true })
        await mkdir(join(root, "visible", ".hidden", "nested"), { recursive: true })
        await mkdir(join(root, "visible", ".hidden", ".nested"), { recursive: true })
        await writeFile(join(root, "top.txt"), "")
        await writeFile(join(root, "a-b.txt"), "")
        await writeFile(join(root, "(.txt"), "")
        await writeFile(join(root, "0.txt"), "")
        await writeFile(join(root, ".dot.txt"), "")
        await writeFile(join(root, ".hidden", "in.txt"), "")
        await writeFile(join(root, ".hidden", "nested", ".wanted"), "")
        await writeFile(join(root, ".hidden", ".nested", ".wanted"), "")
        await writeFile(join(root, "visible", ".hidden", "nested", ".wanted"), "")
        await writeFile(join(root, "visible", ".hidden", ".nested", ".wanted"), "")
        await writeFile(join(root, "nested", "mid.txt"), "")
        await writeFile(join(root, "nested", ".deep.txt"), "")
        await writeFile(join(root, "nested", "deep", "low.txt"), "")
        await writeFile(join(root, "nested", "skip.log"), "")
        return root
      }
      const matches = (
        execute: (
          root: string,
          effect: Effect.Effect<Array<string>, never, FileSystem.FileSystem>
        ) => Effect.Effect<Array<string>, unknown>
      ) =>
        Effect.gen(function*() {
          const root = yield* Effect.promise(() => seed())
          const rows: Array<string> = []
          for (const [index, [pattern, exclude]] of patterns(root).entries()) {
            const found = yield* execute(
              root,
              Effect.flatMap(
                FileSystem.FileSystem,
                (fs) => Effect.orDie(fs.glob(join(root, pattern), exclude === undefined ? { root } : { exclude, root }))
              )
            )
            // Labelled by row index rather than by the exclude list: the two
            // runs seed two different roots, and an absolute exclude would put
            // one of them into the label and make every row differ.
            rows.push(
              `${index} ${pattern} -> ${
                found.map((v) => relative(root, v).replaceAll("\\", "/") || ".").sort().join(" ")
              }`
            )
          }
          return rows
        })

      // A `[.]` segment anywhere but last names an entry called `.`, which no
      // directory holds. That is this helper's contract, asserted directly:
      // Node 26.10's `fs.glob` began matching these rows as if the segment
      // were absent, so they are not compared with whatever the running Node
      // ships.
      const pinned = new Set(["[.]/*", "nested/[.]/mid.txt", "nested/[.]/"])
      const patternOf = (row: string) => row.split(" ")[1]!
      const guarded = yield* matches((root, effect) => run(root, effect))
      const native = yield* matches((_root, effect) => effect.pipe(Effect.provide(NodeFileSystem.layer)))
      expect(guarded.filter((row) => !pinned.has(patternOf(row)))).toEqual(
        native.filter((row) => !pinned.has(patternOf(row)))
      )
      expect(guarded.filter((row) => pinned.has(patternOf(row))).map((row) => row.split(" -> ")[1])).toEqual([
        "",
        "",
        ""
      ])
    }), 120_000)

  it.live("requires each hidden path component to be named by its own glob segment", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (
        const directory of [
          ".hidden/nested",
          ".hidden/.nested",
          "visible/.hidden/nested",
          "visible/.hidden/.nested"
        ]
      ) {
        yield* Effect.promise(() => mkdir(join(root, directory), { recursive: true }))
      }
      for (
        const path of [
          ".hidden/.wanted",
          ".hidden/nested/.wanted",
          ".hidden/.nested/.wanted",
          "visible/.hidden/nested/.wanted",
          "visible/.hidden/.nested/.wanted",
          ".hidden/.secret"
        ]
      ) {
        yield* Effect.promise(() => writeFile(join(root, path), ""))
      }

      const found = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const select = (pattern: string, exclude?: ReadonlyArray<string>) =>
            Effect.map(
              fs.glob(join(root, pattern), exclude === undefined ? { root } : { exclude, root }),
              (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
            )
          return {
            aligned: yield* select("**/.hidden/**/.wanted"),
            explicitClass: yield* select("[.]hidden/**/.wanted"),
            excludedWildcard: yield* select(".hidden/.*", [".hidden/*"]),
            excludedExplicit: yield* select(".hidden/.*", [".hidden/.*"])
          }
        })
      )
      expect(found.aligned).toEqual([
        ".hidden/.wanted",
        ".hidden/nested/.wanted",
        "visible/.hidden/nested/.wanted"
      ])
      expect(found.explicitClass).toEqual([".hidden/.wanted", ".hidden/nested/.wanted"])
      expect(found.excludedWildcard).toEqual([".hidden/.nested", ".hidden/.secret", ".hidden/.wanted"])
      expect(found.excludedExplicit).toEqual([])
    }), 30_000)

  it.live("does not traverse a hidden directory for a dotted segment after a globstar", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(root, ".hidden", ".nested"), { recursive: true }))
      yield* Effect.promise(() => writeFile(join(root, ".hidden", ".secret"), ""))
      yield* Effect.promise(() => writeFile(join(root, ".hidden", ".nested", ".wanted"), ""))

      const found = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const select = (pattern: string) =>
            Effect.map(
              fs.glob(join(root, pattern), { root }),
              (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
            )
          return {
            dotted: yield* select("**/.*"),
            sized: yield* select("**/.??????"),
            spanned: yield* select("**/.*/**"),
            named: yield* select(".hidden/.*")
          }
        })
      )
      expect(found.dotted).toEqual([".hidden"])
      expect(found.sized).toEqual([".hidden"])
      expect(found.spanned).toEqual([".hidden"])
      expect(found.named).toEqual([".hidden/.nested", ".hidden/.secret"])
    }), 30_000)

  it.live("does not enumerate a hidden directory for a wildcard selector", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const hidden = join(root, ".hidden")
      yield* Effect.promise(() => mkdir(hidden))
      yield* Effect.promise(() => writeFile(join(root, "selected.txt"), ""))
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 40 }, (_, index) => writeFile(join(hidden, `entry-${index}-${"x".repeat(32)}.txt`), ""))
        )
      )

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            wildcard: yield* fs.glob(join(root, "**/*.txt"), { root }),
            explicit: yield* Effect.flip(fs.glob(join(root, ".hidden/*.txt"), { root }))
          }
        }),
        AtomicFileSystem.layerWith({ limits: { response: 1024 } })
      )

      expect(outcome.wildcard).toEqual([join(root, "selected.txt")])
      expect(outcome.explicit).toMatchObject({ reason: { _tag: "BadResource" } })
    }), 30_000)

  /**
   * An exclusion is a traversal boundary, so names below it must consume none
   * of the listing budget. Filtering only after the walk made a tiny selected
   * result fail because an ignored subtree exhausted the bound first. The root
   * never enters that walk, so excluding it must stop before listing begins.
   */
  it.live("prunes an excluded subtree before charging the glob walk", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const ignored = join(root, "ignored")
      yield* Effect.promise(() => mkdir(ignored))
      yield* Effect.promise(() => writeFile(join(root, "selected.txt"), ""))
      // Measured against the helper: twelve names with 32-byte suffixes exhaust
      // a 512-byte listing, while the selected result and rejection both fit.
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 12 }, (_, index) => writeFile(join(ignored, `entry-${index}-${"x".repeat(32)}.txt`), ""))
        )
      )

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            rootPruned: yield* fs.glob(join(root, "**/*.txt"), { exclude: ["."], root }),
            pruned: yield* fs.glob(join(root, "**/*.txt"), { exclude: ["ignored"], root }),
            unpruned: yield* Effect.flip(fs.glob(join(root, "**/*.txt"), { root }))
          }
        }),
        AtomicFileSystem.layerWith({ limits: { response: 512 } })
      )

      expect(outcome.rootPruned).toEqual([])
      expect(outcome.pruned).toEqual([join(root, "selected.txt")])
      expect(outcome.unpruned).toMatchObject({ reason: { _tag: "BadResource" } })
    }))

  /**
   * The selector is a traversal boundary too. Applying it only after a full
   * recursive listing made a literal or shallow selector enumerate every
   * unrelated subtree beside its match and charge those names against the
   * listing bounds, so a one-path answer that fit was refused. The decoy is a
   * directory the helper cannot read: entering it is an error, so a silent
   * success proves the walk never went below "unrelated".
   */
  it.live("descends only where the selector can still match", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const unrelated = join(root, "unrelated")
      const decoy = join(unrelated, "zz-decoy")
      yield* Effect.promise(() => mkdir(join(unrelated, "nested", "deep"), { recursive: true }))
      yield* Effect.promise(() => mkdir(decoy))
      yield* Effect.promise(() => writeFile(join(root, "wanted.ts"), ""))
      yield* Effect.promise(() => writeFile(join(root, "other.txt"), ""))
      yield* Effect.promise(() => writeFile(join(unrelated, "nested", "wanted.ts"), ""))
      // Forty names with 32-byte suffixes exhaust a 1024-byte listing many
      // times over, while every selected answer below fits with room to spare.
      yield* Effect.promise(() =>
        Promise.all(
          Array.from(
            { length: 40 },
            (_, index) => writeFile(join(unrelated, "nested", "deep", `entry-${index}-${"x".repeat(32)}.txt`), "")
          )
        )
      )
      yield* Effect.promise(() => chmod(decoy, 0o000))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const glob = (pattern: string) =>
            Effect.map(fs.glob(join(root, pattern), { root }), (rows) => rows.map((v) => relative(root, v)).sort())
          return {
            literal: yield* glob("wanted.ts"),
            shallow: yield* glob("*.ts"),
            literalPrefix: yield* glob("unrelated/nested/*.ts"),
            wildcardDirectory: yield* glob("*/nested/wanted.ts"),
            missing: yield* glob("absent/**/*.ts"),
            everywhere: yield* Effect.flip(fs.glob(join(root, "**/*.txt"), { root }))
          }
        }),
        AtomicFileSystem.layerWith({ limits: { response: 1024 } })
      ).pipe(Effect.ensuring(Effect.promise(() => chmod(decoy, 0o700))))

      expect(outcome.literal).toEqual(["wanted.ts"])
      expect(outcome.shallow).toEqual(["wanted.ts"])
      expect(outcome.literalPrefix).toEqual([join("unrelated", "nested", "wanted.ts")])
      expect(outcome.wildcardDirectory).toEqual([join("unrelated", "nested", "wanted.ts")])
      expect(outcome.missing).toEqual([])
      expect(outcome.everywhere).toMatchObject({ reason: { _tag: "BadResource" } })
    }))

  /**
   * Native answers vary with the host, the selecting pattern's shape, and the
   * supported Node release. Those are not a stable oracle, so these rows pin
   * the adapter's host-independent case rule, one exclusion answer for every
   * selector, and the newer dotted-segment reading.
   */
  it.live("pins the glob answers the native globber cannot be compared on", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(root, "nested", "deep"), { recursive: true }))
      yield* Effect.promise(() => mkdir(join(root, ".hidden")))
      yield* Effect.promise(() => writeFile(join(root, "top.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "a-b.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "(.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "0.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, ".dot.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, ".hidden", "in.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "nested", "mid.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "nested", ".deep.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "nested", "deep", "low.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "nested", "skip.log"), ""))

      const found = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const glob = (pattern: string, exclude?: ReadonlyArray<string>) =>
            Effect.map(
              fs.glob(join(root, pattern), exclude === undefined ? { root } : { exclude, root }),
              (rows) => rows.map((v) => relative(root, v).replaceAll("\\", "/") || ".").sort()
            )
          return {
            caseSelector: yield* glob("**/*.TXT"),
            caseExclude: yield* glob("**/*.txt", ["**/*.TXT"]),
            trailingGlobstarWildcardSelector: yield* glob("**/*", ["nested/**"]),
            trailingGlobstarBareSelector: yield* glob("**", ["nested/**"]),
            trailingGlobstarRoot: yield* glob("**", ["**"]),
            directoryOnlyExclusion: yield* glob("**", ["**/"]),
            directoryOnlyTextExclusion: yield* glob("**/*.txt", ["**/"]),
            dottedAfterGlobstar: yield* glob("**/.*"),
            dottedLeafAfterGlobstar: yield* glob("**/.deep.txt")
          }
        })
      )

      expect(found.caseSelector).toEqual([])
      expect(found.caseExclude).toEqual([
        "(.txt",
        "0.txt",
        "a-b.txt",
        "nested/deep/low.txt",
        "nested/mid.txt",
        "top.txt"
      ])
      expect(found.trailingGlobstarWildcardSelector).toEqual([
        "(.txt",
        "0.txt",
        "a-b.txt",
        "nested",
        "top.txt"
      ])
      expect(found.trailingGlobstarBareSelector).toEqual([
        "(.txt",
        ".",
        "0.txt",
        "a-b.txt",
        "nested",
        "top.txt"
      ])
      expect(found.trailingGlobstarRoot).toEqual(["."])
      expect(found.directoryOnlyExclusion).toEqual(["(.txt", ".", "0.txt", "a-b.txt", "top.txt"])
      expect(found.directoryOnlyTextExclusion).toEqual(["(.txt", "0.txt", "a-b.txt", "top.txt"])
      expect(found.dottedAfterGlobstar).toEqual([".dot.txt", ".hidden", "nested/.deep.txt"])
      expect(found.dottedLeafAfterGlobstar).toEqual(["nested/.deep.txt"])
    }))

  /**
   * Three constructs mean something to `node:fs.glob` that this grammar does
   * not implement. Reading them as ordinary characters would not fail, it
   * would answer a DIFFERENT question: `+(private|secret)/**` passed as an
   * exclusion excluded nothing at all, and the caller received every file
   * under the directories it had just forbidden. That is the same failure an
   * unrelativized absolute exclude used to cause, so it gets the same answer:
   * a typed refusal, in the selector and in the exclusion alike.
   */
  it.live("refuses the glob syntax it does not implement, in a pattern and in an exclude", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(root, "private")))
      yield* Effect.promise(() => writeFile(join(root, "a.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "1.txt"), ""))
      yield* Effect.promise(() => writeFile(join(root, "private", "secret.txt"), ""))

      const unsupported = ["+(a|b).txt", "[[:digit:]].txt", "{1..3}.txt", "[a/@(private)/**", "[]]?(x)"]
      const refusals = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const asPattern: Array<unknown> = []
          const asExclude: Array<unknown> = []
          for (const pattern of unsupported) {
            asPattern.push((yield* Effect.flip(fs.glob(join(root, pattern), { root }))).reason._tag)
            asExclude.push(
              (yield* Effect.flip(fs.glob(join(root, "**/*.txt"), { exclude: [pattern], root }))).reason._tag
            )
          }
          return { asExclude, asPattern }
        })
      )

      expect(refusals.asPattern).toEqual(unsupported.map(() => "BadArgument"))
      expect(refusals.asExclude).toEqual(unsupported.map(() => "BadArgument"))
    }))

  it.live("refuses unsupported syntax in each expanded brace alternative", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (const name of ["[a", "private", "keep.txt"]) {
        yield* Effect.promise(() => writeFile(join(root, name), ""))
      }
      const patterns = ["{[a,@(private)}", "{[a,{keep.txt,@(private)}}", "{[a,+(private)}", "{@,+}(a|b)"]
      const nodeRemaining = yield* Effect.promise(async () => {
        const rows: Array<string> = []
        for await (const row of glob("*", { cwd: root, exclude: [patterns[0]!] })) rows.push(row)
        return rows.sort()
      })
      expect(nodeRemaining).toEqual(["keep.txt"])
      yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          for (const pattern of patterns) {
            const selected = yield* Effect.result(fs.glob(join(root, pattern), { root }))
            expect(selected, pattern).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "BadArgument" } } })
            for (const excluded of [pattern, join(root, pattern)]) {
              const result = yield* Effect.result(fs.glob(join(root, "*"), { root, exclude: [excluded] }))
              expect(result, excluded).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "BadArgument" } } })
            }
          }
          const supported = yield* fs.glob(join(root, "{[a,keep.txt}"), { root })
          expect(supported.map((row) => relative(root, row)).sort()).toEqual(["[a", "keep.txt"])
        })
      )
    }))

  it.live("preserves dot-class text inside an already open character class", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const names = ["[]", "[b]", "ab]", "bb]", "]b]", "a", "b", "keep.txt"]
      yield* Effect.promise(() => mkdir(join(root, "x]")))
      for (const directory of ["", "x]"]) {
        for (const name of names) {
          yield* Effect.promise(() => writeFile(join(root, directory, name), ""))
        }
      }
      const all = [...names, "x]", ...names.map((name) => `x]/${name}`)].sort()
      for (
        const [pattern, selected] of [
          ["[[.]]", ["[]"]],
          ["[a[.]b]", ["[b]", "ab]"]],
          ["[][.]b]", ["[b]", "]b]"]],
          ["[!a[.]b]", ["]b]", "bb]"]],
          ["[^a[.]b]", ["]b]", "bb]"]],
          ["{[[.]],keep.txt}", ["[]", "keep.txt"]],
          ["x]/[[.]]", ["x]/[]"]],
          ["x]/[a[.]b]", ["x]/[b]", "x]/ab]"]]
        ] as ReadonlyArray<readonly [string, ReadonlyArray<string>]>
      ) {
        const remaining = all.filter((name) => !selected.includes(name))
        const native = yield* Effect.promise(async () => {
          const selectedRows: Array<string> = []
          const remainingRows: Array<string> = []
          for await (const row of glob(pattern, { cwd: root })) selectedRows.push(row.replaceAll("\\", "/"))
          for await (const row of glob("**/*", { cwd: root, exclude: [pattern] })) {
            remainingRows.push(row.replaceAll("\\", "/"))
          }
          return { selected: selectedRows.sort(), remaining: remainingRows.sort() }
        })
        expect(native, pattern).toEqual({ selected, remaining })
        const atomic = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const relativePaths = (rows: ReadonlyArray<string>) =>
              rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
            return {
              selected: relativePaths(yield* fs.glob(join(root, pattern), { root })),
              remaining: relativePaths(yield* fs.glob(join(root, "**/*"), { root, exclude: [pattern] })),
              absoluteRemaining: relativePaths(
                yield* fs.glob(join(root, "**/*"), { root, exclude: [join(root, pattern)] })
              )
            }
          })
        )
        expect(atomic, pattern).toEqual({ selected, remaining, absoluteRemaining: remaining })
      }
    }))

  // Windows normalizes trailing dots in directory names. The portable nested
  // class cases above also run there; this fixture exercises a literal `a.`.
  it.live.skipIf(process.platform === "win32")(
    "keeps a dot class within a directory name separate from a standalone dot segment",
    () =>
      Effect.gen(function*() {
        const root = yield* Effect.promise(() => temporaryDirectory())
        for (const name of ["a", "a.", "["]) {
          yield* Effect.promise(() => mkdir(join(root, name)))
          yield* Effect.promise(() => writeFile(join(root, name, "x"), ""))
        }
        const all = ["[", "[/x", "a", "a.", "a./x", "a/x"]
        for (
          const [pattern, selected] of [
            ["a[.]/x", ["a./x"]],
            ["[a[.]/x", ["[/x", "a/x"]],
            ["{a[.],[a[.]}/x", ["[/x", "a./x", "a/x"]]
          ] as ReadonlyArray<readonly [string, ReadonlyArray<string>]>
        ) {
          const remaining = all.filter((name) => !selected.includes(name))
          const native = yield* Effect.promise(async () => {
            const rows: Array<string> = []
            for await (const row of glob(pattern, { cwd: root })) rows.push(row.replaceAll("\\", "/"))
            return rows.sort()
          })
          expect(native, pattern).toEqual(selected)
          yield* run(
            root,
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              const relativePaths = (rows: ReadonlyArray<string>) =>
                rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
              expect(relativePaths(yield* fs.glob(join(root, pattern), { root })), pattern).toEqual(selected)
              for (const exclude of [pattern, join(root, pattern)]) {
                expect(relativePaths(yield* fs.glob(join(root, "**/*"), { root, exclude: [exclude] })), exclude)
                  .toEqual(remaining)
              }
            })
          )
        }
      })
  )

  it.live("refuses POSIX classes after ordinary class members without rejecting literal colon or bracket classes", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (const name of ["1", "a", "g]", "[", "[g", "keep.txt", "x"]) {
        yield* Effect.promise(() => writeFile(join(root, name), ""))
      }
      yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          for (const pattern of ["[a[:digit:]]", "[!a[:digit:]]", "{keep.txt,[a[:digit:]]}"]) {
            const selected = yield* Effect.result(fs.glob(join(root, pattern), { root }))
            expect(selected, pattern).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "BadArgument" } } })
            for (const excluded of [pattern, join(root, pattern)]) {
              const result = yield* Effect.result(fs.glob(join(root, "*"), { root, exclude: [excluded] }))
              expect(result, excluded).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "BadArgument" } } })
            }
          }
          for (
            const [pattern, expected] of [
              ["[a:]", ["a"]],
              ["[[]", ["["]],
              ["[[][:digit:]", ["[g"]]
            ] as const
          ) {
            const node = yield* Effect.promise(async () => {
              const rows: Array<string> = []
              for await (const row of glob(pattern, { cwd: root })) rows.push(row)
              return rows.sort()
            })
            expect(node, pattern).toEqual(expected)
            const atomic = yield* fs.glob(join(root, pattern), { root })
            expect(atomic.map((row) => relative(root, row)).sort(), pattern).toEqual(expected)
          }
        })
      )
    }))

  it.live("preserves the native empty answer for a relative selector containing a backslash", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(async () => realpath(await temporaryDirectory()))
      const info = yield* Effect.promise(() => lstat(root, { bigint: true }))
      yield* Effect.promise(() => writeFile(join(root, "a.txt"), ""))
      const native = yield* Effect.promise(async () => {
        const rows: Array<string> = []
        for await (const row of glob("\\*.txt", { cwd: root })) rows.push(row)
        return rows
      })
      const atomic = yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const extension = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
        return yield* extension.execute({
          operation: "glob",
          boundaryRoot: root,
          rootIdentity: `${info.dev}:${info.ino}`,
          logicalRoot: root,
          options: { exclude: [] },
          pattern: "\\*.txt",
          root
        })
      }).pipe(Effect.provide(AtomicFileSystem.layer))

      expect(atomic).toEqual(native)
      expect(atomic).toEqual([])
    }))

  it.live("does not rewrite outside sibling selectors or exclusions into in-root matches", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(async () => realpath(await temporaryDirectory()))
      const sibling = `${root}-sibling`
      directories.add(sibling)
      yield* Effect.promise(() => mkdir(sibling))
      yield* Effect.promise(() => mkdir(join(root, "-sibling")))
      yield* Effect.promise(() => writeFile(join(sibling, "outside.txt"), "outside"))
      const inside = join(root, "-sibling", "outside.txt")
      yield* Effect.promise(() => writeFile(inside, "inside sentinel"))
      const info = yield* Effect.promise(() => lstat(root, { bigint: true }))

      const publicError = yield* Effect.flip(run(
        root,
        Effect.flatMap(
          FileSystem.FileSystem,
          (fs) => fs.glob(join(sibling, "outside.txt"), { root })
        )
      ))
      expect(publicError.reason._tag).toBe("PermissionDenied")

      const found = yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const extension = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
        const request = (pattern: string, exclude: ReadonlyArray<string>) =>
          extension.execute({
            operation: "glob",
            boundaryRoot: root,
            rootIdentity: `${info.dev}:${info.ino}`,
            logicalRoot: root,
            options: { exclude },
            pattern,
            root
          })
        return {
          selected: yield* request(join(sibling, "outside.txt"), []),
          excluded: yield* request(join(root, "**/*.txt"), [join(sibling, "outside.txt")])
        }
      }).pipe(Effect.provide(AtomicFileSystem.layer))

      expect(found.selected).toEqual([])
      expect(found.excluded).toEqual([inside])
    }))

  it.live("keeps a character class active after a literal closing bracket in another segment", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(root, "x]")))
      for (const name of ["a", "b", "[ab]"]) {
        yield* Effect.promise(() => writeFile(join(root, "x]", name), ""))
      }
      const pattern = "x]/[ab]"
      const native = yield* Effect.promise(async () => {
        const rows: Array<string> = []
        for await (const row of glob(pattern, { cwd: root })) rows.push(row.replaceAll("\\", "/"))
        return rows.sort()
      })
      const atomic = yield* run(
        root,
        Effect.flatMap(
          FileSystem.FileSystem,
          (fs) =>
            Effect.map(
              fs.glob(join(root, pattern), { root }),
              (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
            )
        )
      )
      expect(native).toEqual(["x]/a", "x]/b"])
      expect(atomic).toEqual(["x]/a", "x]/b"])
      const excludedNative = yield* Effect.promise(async () => {
        const rows: Array<string> = []
        for await (const row of glob("x]/*", { cwd: root, exclude: [pattern] })) rows.push(row.replaceAll("\\", "/"))
        return rows.sort()
      })
      const excludedAtomic = yield* run(
        root,
        Effect.flatMap(
          FileSystem.FileSystem,
          (fs) =>
            Effect.map(
              fs.glob(join(root, "x]/*"), { root, exclude: [pattern] }),
              (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
            )
        )
      )
      expect(excludedNative).toEqual(["x]/[ab]"])
      expect(excludedAtomic).toEqual(["x]/[ab]"])
    }))

  it.live("admits a literal closing bracket as the first character class member", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      // Keep the filesystem fixture valid on Windows; Rust units also check
      // the '?' class member without creating an illegal Windows filename.
      for (const name of ["(", "]", "keep.txt", "x"]) {
        yield* Effect.promise(() => writeFile(join(root, name), ""))
      }
      for (
        const [pattern, selected, remaining] of [
          ["[]?(]", ["(", "]"], ["keep.txt", "x"]],
          ["[!]?(]", ["x"], ["(", "]", "keep.txt"]],
          ["[^]?(]", ["x"], ["(", "]", "keep.txt"]]
        ] as const
      ) {
        const native = yield* Effect.promise(async () => {
          const selectedRows: Array<string> = []
          const remainingRows: Array<string> = []
          for await (const row of glob(pattern, { cwd: root })) selectedRows.push(row)
          for await (const row of glob("*", { cwd: root, exclude: [pattern] })) remainingRows.push(row)
          return { selected: selectedRows.sort(), remaining: remainingRows.sort() }
        })
        expect(native, pattern).toEqual({ selected, remaining })
        const atomic = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const relativePaths = (rows: ReadonlyArray<string>) => rows.map((row) => relative(root, row)).sort()
            return {
              selected: relativePaths(yield* fs.glob(join(root, pattern), { root })),
              remaining: relativePaths(yield* fs.glob(join(root, "*"), { root, exclude: [pattern] })),
              absoluteRemaining: relativePaths(
                yield* fs.glob(join(root, "*"), {
                  root,
                  exclude: [join(root, pattern)]
                })
              )
            }
          })
        )
        expect(atomic, pattern).toEqual({ selected, remaining, absoluteRemaining: remaining })
      }
    }))

  // The published glob contract deliberately retains a trailing-globstar
  // exclusion's own anchor for every selector. Node differs by selector shape,
  // so use the contract's literal answers rather than Node for these rows.
  it.live("retains globstar exclusion anchors while removing descendants for every selector", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (const name of ["deep/root.txt", "nested/deep/x/deep/leaf.txt", "keep.txt"]) {
        yield* Effect.promise(() => mkdir(dirname(join(root, name)), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(root, name), ""))
      }
      for (
        const [excluded, expected] of [
          ["**/deep/**", [".", "deep", "keep.txt", "nested", "nested/deep"]],
          ["nested/deep/**", [".", "deep", "deep/root.txt", "keep.txt", "nested", "nested/deep"]],
          ["deep/**", [
            ".",
            "deep",
            "keep.txt",
            "nested",
            "nested/deep",
            "nested/deep/x",
            "nested/deep/x/deep",
            "nested/deep/x/deep/leaf.txt"
          ]],
          ["**/**", ["."]]
        ] as const
      ) {
        for (const selector of ["**", "**/*"]) {
          for (const exclude of [excluded, join(root, excluded)]) {
            const atomic = yield* run(
              root,
              Effect.flatMap(
                FileSystem.FileSystem,
                (fs) =>
                  Effect.map(
                    fs.glob(join(root, selector), { root, exclude: [exclude] }),
                    (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/") || ".").sort()
                  )
              )
            )
            expect(atomic, `${selector} excluding ${exclude}`).toEqual(
              selector === "**" ? expected : expected.filter((row) => row !== ".")
            )
          }
        }
      }
    }))

  it.live("retains file and directory anchors and protects explicitly selected hidden paths", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (const name of ["file/deep", "directory/deep/leaf.txt", ".hidden/leaf.txt"]) {
        yield* Effect.promise(() => mkdir(dirname(join(root, name)), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(root, name), ""))
      }
      for (
        const [pattern, excluded, expected] of [
          ["file/deep/**", "file/deep/**", ["file/deep"]],
          ["directory/deep/**", "directory/deep/**", ["directory/deep"]],
          ["directory/deep", "directory/deep/**", ["directory/deep"]],
          [".hidden/**", "**/**", [".hidden", ".hidden/leaf.txt"]],
          [".hidden/**", ".hidden/**", [".hidden"]]
        ] as const
      ) {
        const atomic = yield* run(
          root,
          Effect.flatMap(
            FileSystem.FileSystem,
            (fs) =>
              Effect.map(
                fs.glob(join(root, pattern), { root, exclude: [excluded] }),
                (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
              )
          )
        )
        expect(atomic, `${pattern} excluding ${excluded}`).toEqual(expected)
      }
    }))

  it.live("selects repeated globstar anchors and retains them under matching exclusions", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (
        const name of [
          "keep.txt",
          "deep/leaf.txt",
          "deep/nested/child.txt",
          "deep/.secret",
          ".hidden/leaf.txt",
          ".hidden/nested/child.txt",
          ".hidden/.secret"
        ]
      ) {
        yield* Effect.promise(() => mkdir(dirname(join(root, name)), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(root, name), ""))
      }
      const select = (pattern: string, exclude: ReadonlyArray<string> = []) =>
        run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            Effect.map(
              fs.glob(join(root, pattern), { root, exclude }),
              (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/") || ".").sort()
            ))
        )

      for (const pattern of ["deep/**/**", "deep/**/**/**"]) {
        expect(yield* select(pattern), pattern).toEqual([
          "deep",
          "deep/leaf.txt",
          "deep/nested",
          "deep/nested/child.txt"
        ])
        expect(yield* select(pattern, [pattern]), `${pattern} excluded`).toEqual(["deep"])
      }
      expect(yield* select("keep.txt/**/**")).toEqual(["keep.txt"])
      expect(yield* select("keep.txt/**/**", ["keep.txt/**/**"])).toEqual(["keep.txt"])
      for (const pattern of [".hidden/**/**", ".hidden/**/**/**"]) {
        expect(yield* select(pattern), pattern).toEqual([
          ".hidden",
          ".hidden/leaf.txt",
          ".hidden/nested",
          ".hidden/nested/child.txt"
        ])
        expect(yield* select(pattern, [pattern]), `${pattern} excluded`).toEqual([".hidden"])
      }
      for (const pattern of ["**/**/**", "**/**/**/**"]) {
        expect(yield* select(pattern), pattern).toEqual([
          ".",
          "deep",
          "deep/leaf.txt",
          "deep/nested",
          "deep/nested/child.txt",
          "keep.txt"
        ])
        expect(yield* select(pattern, [pattern]), `${pattern} excluded`).toEqual(["."])
      }
      const braced = "{deep,.hidden}/**/**"
      expect(yield* select(braced)).toEqual([
        ".hidden",
        ".hidden/leaf.txt",
        ".hidden/nested",
        ".hidden/nested/child.txt",
        "deep",
        "deep/leaf.txt",
        "deep/nested",
        "deep/nested/child.txt"
      ])
      expect(yield* select(braced, [braced])).toEqual([".hidden", "deep"])
    }))

  it.live("treats a slash inside a bracket expression as a path separator", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      for (const name of ["a", "[a/]", "[a/]foo", "[a]foo"]) {
        yield* Effect.promise(() => mkdir(join(root, name), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(root, name, "selected.txt"), ""))
      }
      const pattern = "[a/]*/**"
      const expected = ["[a/]", "[a/]/selected.txt", "[a/]foo", "[a/]foo/selected.txt"]
      const native = yield* Effect.promise(async () => {
        const rows: Array<string> = []
        for await (const row of glob(pattern, { cwd: root })) rows.push(row.replaceAll("\\", "/"))
        return rows.sort()
      })
      const atomic = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.map(
            fs.glob(join(root, pattern), { root }),
            (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/")).sort()
          ))
      )
      expect(native).toEqual(expected)
      expect(atomic).toEqual(expected)
    }), 30_000)

  /**
   * The pending brace work is bounded before it can consume one Python frame
   * per group. This pattern is exactly at the documented 4096-character cap,
   * so it must be rejected as caller input rather than as a boundary failure.
   */
  it.live("refuses brace expansion before pending work reaches Python's recursion limit", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(async () => realpath(await temporaryDirectory()))
      const info = yield* Effect.promise(() => lstat(root, { bigint: true }))
      const pattern = "{,a}".repeat(1024)
      // Drive the atomic extension directly because the kernel turns a
      // relative pattern into an absolute capability resource first, which
      // puts this exact-cap helper case over the kernel's separate bound.
      const failures = yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
        const request = (selected: string, exclude: ReadonlyArray<string>) =>
          atomic.execute({
            operation: "glob",
            boundaryRoot: root,
            rootIdentity: `${info.dev}:${info.ino}`,
            logicalRoot: root,
            options: { exclude },
            pattern: selected,
            root
          })
        return {
          asPattern: yield* Effect.flip(request(pattern, [])),
          asExclude: yield* Effect.flip(request("**", [pattern]))
        }
      }).pipe(Effect.provide(AtomicFileSystem.layer))

      expect(failures).toMatchObject({
        asPattern: {
          reason: {
            _tag: "BadArgument",
            description: expect.stringContaining("expands past 64 alternatives")
          }
        },
        asExclude: {
          reason: {
            _tag: "BadArgument",
            description: expect.stringContaining("expands past 64 alternatives")
          }
        }
      })
    }))

  it.live("classifies flag, encoding, and errno failures the way the native filesystem does", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "seed"))
      yield* Effect.promise(() => mkdir(join(root, "occupied")))
      yield* Effect.promise(() => writeFile(join(root, "occupied", "child.txt"), "child"))
      yield* Effect.promise(() => writeFile(join(root, "empty.txt"), ""))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            bytes: yield* fs.readFile(join(root, "empty.txt")),
            empty: yield* fs.readFileString(join(root, "empty.txt")),
            encoding: yield* Effect.flip(fs.readFileString(target, "not-an-encoding")),
            exclusive: yield* Effect.flip(fs.writeFileString(target, "ab", { flag: "wx" })),
            flag: yield* Effect.flip(
              fs.writeFileString(target, "ab", { flag: "nonsense" as FileSystem.OpenFlag })
            ),
            listedFile: yield* Effect.flip(fs.readDirectory(target)),
            missing: yield* Effect.flip(fs.writeFileString(join(root, "missing.txt"), "ab", { flag: "r+" })),
            notEmpty: yield* Effect.flip(fs.remove(join(root, "occupied")))
          }
        })
      )

      // An empty file decodes to an empty string, not to the helper's envelope.
      expect(outcome.empty).toBe("")
      expect([...outcome.bytes]).toEqual([])
      expect(outcome.encoding.reason).toMatchObject({
        _tag: "BadArgument",
        description: "invalid encoding",
        method: "readFileString",
        module: "FileSystem"
      })
      expect(outcome.flag.reason._tag).toBe("BadArgument")
      expect(outcome.exclusive).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      expect(outcome.missing).toMatchObject({ reason: { _tag: "NotFound" } })
      expect(outcome.listedFile).toMatchObject({ reason: { _tag: "BadResource" } })
      // ENOTEMPTY has no normalized reason in Effect's own Node adapter either.
      expect(outcome.notEmpty.reason._tag).toBe("Unknown")
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("seed")
    }))

  /**
   * Effect's own Node adapter puts the failing syscall on every system error it
   * reports, so a consumer that switches on `syscall` has to read the same
   * field from the atomic adapter. It used to be absent, which made the two
   * adapters interchangeable everywhere except in error handling.
   */
  it.live("names the failing syscall on a system error, the way the native adapter does", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const missing = join(root, "absent", "file.txt")
      const syscall = (failure: { readonly reason: unknown }) =>
        (failure.reason as { readonly syscall?: string }).syscall

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            read: yield* Effect.flip(fs.readFile(missing)),
            makeDirectory: yield* Effect.flip(fs.makeDirectory(missing)),
            rename: yield* Effect.flip(fs.rename(missing, join(root, "moved.txt"))),
            stat: yield* Effect.flip(fs.stat(missing)),
            remove: yield* Effect.flip(fs.remove(join(root, "absent-leaf.txt")))
          }
        })
      )

      expect(syscall(outcome.read)).toBe("open")
      expect(syscall(outcome.makeDirectory)).toBe("mkdir")
      expect(syscall(outcome.rename)).toBe("rename")
      expect(syscall(outcome.stat)).toBe("stat")
      expect(syscall(outcome.remove)).toBe("unlink")
      // The native adapter names one too, for the same operation.
      const native = yield* Effect.flatMap(
        FileSystem.FileSystem,
        (fs) => Effect.flip(fs.readFile(missing))
      ).pipe(Effect.provide(NodeFileSystem.layer))
      expect(syscall(native)).toBe("open")
    }))

  /**
   * `force: true` means "the end state is that this path does not exist", and
   * `fs.rm` reaches that state for a path whose ANCESTORS do not exist either.
   * The atomic helper resolved the parent before it entered the force-aware
   * branch, so it reported ENOENT for exactly the shape force exists to cover.
   */
  it.live(
    "removes the same shapes with and without force that the native filesystem does",
    () =>
      Effect.gen(function*() {
        const shapes = ["missing-leaf.txt", "absent/child.txt", "absent/deeper/child.txt"] as const
        const outcome = (force: boolean, recursive: boolean) =>
          Effect.gen(function*() {
            const rows: Array<string> = []
            for (const shape of shapes) {
              const root = yield* Effect.promise(() => temporaryDirectory())
              const attempt = Effect.flatMap(
                FileSystem.FileSystem,
                (fs) => Effect.result(fs.remove(join(root, shape), { force, recursive }))
              )
              const atomic = yield* run(root, attempt)
              const native = yield* attempt.pipe(Effect.provide(NodeFileSystem.layer))
              rows.push(`${shape} force=${force} recursive=${recursive} ${atomic._tag} ${native._tag}`)
              expect(atomic._tag, `${shape} force=${force} recursive=${recursive}`).toBe(native._tag)
            }
            return rows
          })

        expect(yield* outcome(true, true)).toEqual([
          "missing-leaf.txt force=true recursive=true Success Success",
          "absent/child.txt force=true recursive=true Success Success",
          "absent/deeper/child.txt force=true recursive=true Success Success"
        ])
        expect(yield* outcome(true, false)).toEqual([
          "missing-leaf.txt force=true recursive=false Success Success",
          "absent/child.txt force=true recursive=false Success Success",
          "absent/deeper/child.txt force=true recursive=false Success Success"
        ])
        // Without force every one of them still fails, on both adapters.
        expect(yield* outcome(false, true)).toEqual([
          "missing-leaf.txt force=false recursive=true Failure Failure",
          "absent/child.txt force=false recursive=true Failure Failure",
          "absent/deeper/child.txt force=false recursive=true Failure Failure"
        ])
      }),
    60_000
  )

  /**
   * `stat` used to mask st_mode down to its permission bits, so the same
   * `FileSystem.stat` call answered 420 through the atomic path and 33188
   * through the raw one. A caller testing `mode & S_IFMT` got a correct answer
   * from one adapter and zero from the other.
   */
  it.live("reports every stat field the native adapter reports, mode bits included", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => writeFile(join(root, "plain.txt"), "seed"))
      yield* Effect.promise(() => writeFile(join(root, "runnable.sh"), "#!/bin/sh\n"))
      yield* Effect.promise(() => chmod(join(root, "runnable.sh"), 0o755))
      yield* Effect.promise(() => mkdir(join(root, "directory")))

      const targets = ["plain.txt", "runnable.sh", "directory"] as const
      const read = Effect.forEach(
        targets,
        (name) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(join(root, name)))
      )
      const atomic = yield* run(root, read)
      const native = yield* read.pipe(Effect.provide(NodeFileSystem.layer))

      for (const [index, name] of targets.entries()) {
        const mine = atomic[index] as FileSystem.File.Info
        const theirs = native[index] as FileSystem.File.Info
        expect(mine.mode, name).toBe(theirs.mode)
        expect(mine.type, name).toBe(theirs.type)
        expect(mine.dev, name).toBe(theirs.dev)
        expect(mine.ino, name).toEqual(theirs.ino)
        expect(mine.nlink, name).toEqual(theirs.nlink)
        expect(mine.uid, name).toEqual(theirs.uid)
        expect(mine.gid, name).toEqual(theirs.gid)
        expect(mine.rdev, name).toEqual(theirs.rdev)
        expect(mine.size, name).toEqual(theirs.size)
      }
      // The file-type bits survive, which is what the mask used to discard.
      expect((atomic[0] as FileSystem.File.Info).mode & 0o170000).toBe(0o100000)
      expect((atomic[2] as FileSystem.File.Info).mode & 0o170000).toBe(0o040000)
      expect((atomic[1] as FileSystem.File.Info).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o755)
    }))

  /**
   * The helper crosses the seconds-to-milliseconds boundary in Python before
   * the adapter builds a `Date`; the mode parity above says nothing about
   * whether it landed on the right instant, or in the right field. Distinct
   * whole-second atime and mtime set through `utimes` make a swap or a
   * mis-scaled value visible against the native adapter's answer.
   */
  it.live("reports the same atime, mtime and birthtime as the native adapter", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "stamped.txt")
      yield* Effect.promise(() => writeFile(target, "seed"))
      const accessed = new Date("2021-03-04T05:06:07Z")
      const modified = new Date("2020-01-02T03:04:05Z")
      yield* Effect.promise(() => utimes(target, accessed, modified))

      const read = Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(target))
      const mine = yield* run(root, read)
      const theirs = yield* read.pipe(Effect.provide(NodeFileSystem.layer))

      const millis = (value: Option.Option<Date>) => Option.map(value, (date) => date.getTime())
      expect(millis(mine.atime)).toEqual(Option.some(accessed.getTime()))
      expect(millis(mine.mtime)).toEqual(Option.some(modified.getTime()))
      expect(millis(mine.atime)).toEqual(millis(theirs.atime))
      expect(millis(mine.mtime)).toEqual(millis(theirs.mtime))
      // Birth time is host-optional; where the native adapter has one the
      // helper must have the same instant, give or take float rounding of
      // the nanosecond field on either side of the boundary.
      expect(mine.birthtime._tag).toBe(theirs.birthtime._tag)
      if (Option.isSome(mine.birthtime) && Option.isSome(theirs.birthtime)) {
        expect(Math.abs(mine.birthtime.value.getTime() - theirs.birthtime.value.getTime())).toBeLessThanOrEqual(1)
      }
    }))

  /**
   * A named pipe used to read as a successful, EMPTY regular file, and a
   * write-only open of one parked the helper inside `open()` until a reader
   * arrived. The Rust helper tests pin the whole special-file
   * family; this case stays here because it is the one an ordinary workspace
   * writer can plant, and it must terminate.
   */
  it.live(
    "refuses a named pipe planted inside the workspace instead of waiting or reporting empty",
    () =>
      Effect.gen(function*() {
        const flags: ReadonlyArray<FileSystem.OpenFlag> = ["w", "a", "r+", "w+", "a+"]
        const root = yield* Effect.promise(() => temporaryDirectory())
        const pipe = join(root, "pipe")
        if (process.platform === "win32") {
          // Windows pipes live in the device namespace. Plant a workspace
          // symlink to a real listening pipe and prove no operation connects.
          const address = `\\\\.\\pipe\\smithers-atomic-${randomUUID()}`
          let connections = 0
          const server = createServer((socket) => {
            connections++
            socket.destroy()
          })
          yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              new Promise<void>((resolve, reject) => {
                server.once("error", reject)
                server.listen(address, resolve)
              })
            ),
            () =>
              Effect.gen(function*() {
                yield* Effect.promise(() => symlink(address, pipe, "file"))
                yield* run(
                  root,
                  Effect.gen(function*() {
                    const fs = yield* FileSystem.FileSystem
                    const probes: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
                      fs.exists(pipe),
                      fs.stat(pipe),
                      fs.readFile(pipe)
                    ]
                    for (const operation of probes) {
                      expect((yield* Effect.exit(operation))._tag).toBe("Failure")
                    }
                    for (const flag of [...flags, "wx"] as const) {
                      expect((yield* Effect.exit(fs.writeFileString(pipe, "escaped", { flag })))._tag).toBe("Failure")
                    }
                  })
                )
                expect(connections).toBe(0)
                expect((yield* Effect.promise(() => lstat(pipe))).isSymbolicLink()).toBe(true)
              }),
            () =>
              Effect.promise(() =>
                new Promise<void>((resolve, reject) => {
                  server.close((error) => error === undefined ? resolve() : reject(error))
                })
              )
          )
          return
        }
        yield* Effect.promise(() => promisify(execFile)("mkfifo", [pipe]))

        const outcome = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return {
              existing: yield* fs.exists(pipe),
              info: yield* fs.stat(pipe),
              read: yield* Effect.flip(fs.readFile(pipe)),
              writes: yield* Effect.forEach(flags, (flag) =>
                Effect.map(
                  Effect.result(fs.writeFileString(pipe, "escaped", { flag })),
                  (result) => `${flag}:${result._tag}`
                )),
              // The exclusive flags refuse the existing entry before opening it.
              exclusive: yield* Effect.flip(fs.writeFileString(pipe, "escaped", { flag: "wx" }))
            }
          })
        )

        expect(outcome.existing).toBe(true)
        expect(outcome.info.type).toBe("FIFO")
        // An empty read would be indistinguishable from an empty file.
        expect(outcome.read).toMatchObject({ reason: { _tag: "PermissionDenied" } })
        expect(outcome.writes).toEqual(["w:Failure", "a:Failure", "r+:Failure", "w+:Failure", "a+:Failure"])
        expect(outcome.exclusive).toMatchObject({ reason: { _tag: "AlreadyExists" } })
        // Nothing replaced or truncated the pipe on the way through.
        const info = yield* Effect.promise(() => lstat(pipe))
        expect(info.isFIFO()).toBe(true)
      }),
    30_000
  )

  /**
   * The request, the response, and the bytes the syscalls receive are all
   * UTF-8, whatever locale the host was started under. Decoding the request
   * with the ambient locale used to address a DIFFERENT file for any
   * non-ASCII path and to write mojibake for any non-ASCII payload — and to
   * report success for both.
   */
  it.live("addresses non-ASCII paths and payloads identically under a legacy locale", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const name = "ラン.txt"
      const target = join(root, name)
      const content = "héllo — ✓"
      const overrides = { LANG: "en_US.ISO8859-1", LC_ALL: "en_US.ISO8859-1" }
      const original = Object.fromEntries(
        Object.keys(overrides).map((key) => [key, process.env[key]])
      )

      let outcome: { readonly entries: Array<string>; readonly text: string }
      try {
        Object.assign(process.env, overrides)
        outcome = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString(target, content)
            return {
              entries: yield* fs.readDirectory(root),
              text: yield* fs.readFileString(target)
            }
          })
        )
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }

      expect(outcome.text).toBe(content)
      expect(outcome.entries).toEqual([name])
      // The bytes on disk are the ones the caller asked for, at the name the
      // caller asked for — read back outside the adapter entirely.
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(content)
    }))

  it.live("kills an in-flight helper when the Effect is interrupted", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const bin = join(yield* Effect.promise(() => temporaryDirectory()), "bin")
      yield* Effect.promise(() => mkdir(bin))
      const executable = join(bin, "helper")
      yield* Effect.promise(() =>
        writeFile(
          executable,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 10000)'\n`
        )
      )
      yield* Effect.promise(() => chmod(executable, 0o755))
      yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const fiber = yield* fs.readFile(target).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep("20 millis")
          yield* Fiber.interrupt(fiber)
        }),
        AtomicFileSystem.layerWith({ executable })
      )
    }))
})
