/**
 * The guarded, descriptor-relative filesystem, executed on this runtime.
 *
 * `BunFileSystem.layer` is `@smthrs/platform-node`'s `AtomicFileSystem.layer`,
 * and its no-follow extension does not run in-process: every guarded operation
 * is executed by the `smithers-jj-export` helper the adapter spawns. The extension being
 * *present* is all the barrel suite asserts, and nothing in this package had
 * ever run it, so this suite executes it once against the adapter the Bun
 * bundle actually installs: a guarded read, write, and rename, plus the
 * symlink refusals.
 *
 * The Node coverage lane and the Bun compatibility lane both run this file,
 * so each runtime must start the helper and complete the guarded operations.
 *
 * The byte ceilings, the Unicode matrix, and the full refusal matrix already
 * run against the byte-identical module in
 * `packages/smithers/flows/platform-node/test/AtomicFileSystem*`, and are deliberately not
 * restaged here.
 *
 * `it.live` throughout: the helper is a real subprocess on real elapsed time.
 */
import * as BunPath from "@effect/platform-bun/BunPath"
import { describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, FileSystem, Layer } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import * as BunFileSystem from "../src/BunFileSystem.ts"

/** The kernel's guarded filesystem over the Bun host adapter, bounded at `root`. */
const guarded = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunPath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

const temporaryDirectory = () => mkdtempSync(join(tmpdir(), "flows-bun-guarded-fs-"))

describe("BunFileSystem under the kernel guard", () => {
  it.live("runs read, write, and rename through the helper on this runtime", () =>
    Effect.gen(function*() {
      const root = temporaryDirectory()
      try {
        const nested = join(root, "nested")
        const written = join(nested, "written.txt")
        const renamed = join(nested, "renamed.txt")

        const outcome = yield* Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(nested, { recursive: true })
          yield* fs.writeFileString(written, "bun guarded")
          const readBack = yield* fs.readFileString(written)
          yield* fs.rename(written, renamed)
          return {
            readBack,
            renamedText: yield* fs.readFileString(renamed),
            sourceGone: yield* fs.exists(written)
          }
        }).pipe(Effect.provide(guarded(root)))

        expect(outcome).toEqual({ readBack: "bun guarded", renamedText: "bun guarded", sourceGone: false })
        // The helper wrote to the real filesystem, not to a private view of it.
        expect(readFileSync(renamed, "utf8")).toBe("bun guarded")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }), 30_000)

  it.live("selects repeated globstar anchors and preserves them under exclusions", () =>
    Effect.gen(function*() {
      const root = temporaryDirectory()
      try {
        mkdirSync(join(root, "deep", "nested"), { recursive: true })
        mkdirSync(join(root, ".hidden", "nested"), { recursive: true })
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
          writeFileSync(join(root, name), "")
        }
        const select = (pattern: string, exclude: ReadonlyArray<string> = []) =>
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            Effect.map(
              fs.glob(join(root, pattern), { root, exclude }),
              (rows) => rows.map((row) => relative(root, row).replaceAll("\\", "/") || ".").sort()
            )).pipe(Effect.provide(guarded(root)))

        expect(yield* select("deep/**/**")).toEqual(["deep", "deep/leaf.txt", "deep/nested", "deep/nested/child.txt"])
        expect(yield* select("deep/**/**", ["deep/**/**"])).toEqual(["deep"])
        expect(yield* select("keep.txt/**/**")).toEqual(["keep.txt"])
        expect(yield* select("keep.txt/**/**", ["keep.txt/**/**"])).toEqual(["keep.txt"])
        expect(yield* select(".hidden/**/**")).toEqual([
          ".hidden",
          ".hidden/leaf.txt",
          ".hidden/nested",
          ".hidden/nested/child.txt"
        ])
        expect(yield* select(".hidden/**/**", [".hidden/**/**"])).toEqual([".hidden"])
        expect(yield* select("**/**/**")).toEqual([
          ".",
          "deep",
          "deep/leaf.txt",
          "deep/nested",
          "deep/nested/child.txt",
          "keep.txt"
        ])
        expect(yield* select("**/**/**", ["**/**/**"])).toEqual(["."])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }), 30_000)

  it.live("refuses to traverse a symlink, whether or not it leaves the boundary root", () =>
    Effect.gen(function*() {
      const enclosing = temporaryDirectory()
      try {
        const root = join(enclosing, "workspace")
        const outside = join(enclosing, "outside")
        mkdirSync(join(root, "real"), { recursive: true })
        mkdirSync(outside)
        writeFileSync(join(outside, "victim.txt"), "outside")
        writeFileSync(join(root, "real", "kept.txt"), "inside")
        symlinkSync(outside, join(root, "escape"))
        symlinkSync(join(root, "real"), join(root, "alias"))

        const read = (path: string) =>
          Effect.flip(
            Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.provide(guarded(root)))
          )

        // A path-based filesystem would have followed either link and returned
        // the bytes. Authorization resolves the outside target and denies it
        // before the helper runs, as the kernel's confinement contract states.
        expect(yield* read(join(root, "escape", "victim.txt"))).toMatchObject({
          reason: { _tag: "PermissionDenied" }
        })
        // A link to a directory inside the root passes authorization; the
        // descriptor-relative helper then refuses the component instead of
        // following it.
        expect(yield* read(join(root, "alias", "kept.txt"))).toMatchObject({ reason: { _tag: "BadResource" } })
        expect(readFileSync(join(root, "escape", "victim.txt"), "utf8")).toBe("outside")
        expect(readFileSync(join(root, "alias", "kept.txt"), "utf8")).toBe("inside")
      } finally {
        rmSync(enclosing, { recursive: true, force: true })
      }
    }), 30_000)
})
