import * as NodePath from "@effect/platform-node/NodePath"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Edit from "@smthrs/std/Edit"
import * as Write from "@smthrs/std/Write"
import { Effect, FileSystem, Layer } from "effect"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const fixture = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "smithers-root-alias-")))
  const canonical = join(directory, "workspace")
  const logical = join(directory, "alias")
  await mkdir(canonical)
  await symlink(canonical, logical, "dir")
  return { directory, canonical, logical }
}

const guarded = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

describe("standard edits through an aliased workspace root", () => {
  it("round-trips realPath and replaces existing files through Write and Edit", async () => {
    const { directory, canonical, logical } = await fixture()
    try {
      const target = join(logical, "target.txt")
      await writeFile(target, "before\n")
      await chmod(target, 0o750)
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const resolved = yield* fs.realPath(target)
          expect(resolved).toBe(join(canonical, "target.txt"))
          expect(yield* fs.realPath(resolved)).toBe(resolved)
          expect(yield* fs.realPath(canonical)).toBe(canonical)
          const written = yield* Write.run({ path: target, content: "written\n" })
          expect(written.created).toBe(false)
          expect(yield* fs.readFileString(resolved)).toBe("written\n")
          yield* Edit.run({ path: target, oldString: "written", newString: "edited" })
          expect(yield* fs.readFileString(target)).toBe("edited\n")
          // Canonical paths returned by the service are equally valid inputs for
          // another existing-file replacement and a previously absent sibling.
          yield* Write.run({ path: resolved, content: "canonical\n" })
          yield* Write.run({ path: join(canonical, "new.txt"), content: "new\n" })
        })).pipe(Effect.provide(guarded(logical)), Effect.provide(NodePath.layer))
      )
      expect(await readFile(target, "utf8")).toBe("canonical\n")
      // Windows keeps only the write bit, so the mode round-trip is POSIX-only.
      if (process.platform !== "win32") expect((await stat(target)).mode & 0o7777).toBe(0o750)
      expect((await readdir(canonical)).sort()).toEqual(["new.txt", "target.txt"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("refuses sibling-prefix escapes and child symlinks through either root spelling", async () => {
    const { directory, canonical, logical } = await fixture()
    try {
      const outside = join(directory, "workspace-neighbor")
      const aliasOutside = join(directory, "alias-neighbor")
      await mkdir(outside)
      await mkdir(aliasOutside)
      await writeFile(join(outside, "kept"), "outside")
      await writeFile(join(aliasOutside, "kept"), "alias outside")
      await symlink(outside, join(canonical, "escape"), "dir")
      await symlink(join(outside, "kept"), join(canonical, "file-link"))
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          for (
            const candidate of [
              join(outside, "kept"),
              join(aliasOutside, "kept"),
              join(logical, "escape", "kept"),
              join(canonical, "escape", "kept"),
              join(logical, "file-link"),
              join(canonical, "file-link")
            ]
          ) {
            const failure = yield* Effect.flip(fs.writeFileString(candidate, "must not write"))
            // POSIX maps a refused child symlink to ELOOP/ENOTDIR depending on
            // the host. Both must remain a typed failure with untouched bytes.
            expect(failure._tag).toBe("PlatformError")
          }
        })).pipe(Effect.provide(guarded(logical)))
      )
      expect(await readFile(join(outside, "kept"), "utf8")).toBe("outside")
      expect(await readFile(join(aliasOutside, "kept"), "utf8")).toBe("alias outside")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("still refuses both spellings after the pinned root is replaced", async () => {
    const { directory, canonical, logical } = await fixture()
    const saved = join(directory, "saved")
    try {
      await writeFile(join(canonical, "kept"), "original")
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* Effect.promise(async () => {
            await rename(canonical, saved)
            await mkdir(canonical)
            await writeFile(join(canonical, "kept"), "replacement")
          })
          for (const root of [logical, canonical]) {
            const failure = yield* Effect.flip(fs.writeFileString(join(root, "kept"), "must not write"))
            expect(failure.reason._tag).toBe("PermissionDenied")
          }
        })).pipe(Effect.provide(guarded(logical)))
      )
      expect(await readFile(join(saved, "kept"), "utf8")).toBe("original")
      expect(await readFile(join(canonical, "kept"), "utf8")).toBe("replacement")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
