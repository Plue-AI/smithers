import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { parsePattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, FileSystem, Layer, Option } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

// Check the actual volume used by the fixtures, rather than assuming a platform default.
const probe = mkdtempSync(join(tmpdir(), "flows-node-case-probe-"))
let caseInsensitive: boolean
try {
  writeFileSync(join(probe, "probe"), "same file")
  caseInsensitive = existsSync(join(probe, "PROBE")) && readFileSync(join(probe, "PROBE"), "utf8") === "same file"
} finally {
  rmSync(probe, { recursive: true, force: true })
}

const pattern = (value: string) => Option.getOrThrow(parsePattern(value))
// Capability resources are native paths and patterns match them as text, so
// the rules join with the platform separator: `C:\w/**` never selects `C:\w\a`.
const rules = (root: string) => [
  new Rule({ effect: "allow", pattern: pattern(`fs:read:${join(root, "**")}`) }),
  new Rule({ effect: "allow", pattern: pattern(`fs:write:${join(root, "**")}`) }),
  new Rule({ effect: "deny", pattern: pattern(`fs:read:${join(root, ".env")}`) }),
  new Rule({ effect: "deny", pattern: pattern(`fs:write:${join(root, "ReportDir", "**")}`) })
]
// A policy denial, not an unanswered request: both surface as PermissionDenied.
const deniedByPolicy = { _tag: "@smthrs/capability/PermissionDenied", reason: "denied by permission policy" }

const guarded = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(
      GrantStore.layer({ attended: false, rules: rules(resolve(root)) }).pipe(Layer.provide(Workspace.layer(root)))
    )
  )

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

describe("filesystem grants on a case-insensitive volume", () => {
  it.live.skipIf(!caseInsensitive)(
    "denies a differently cased .env read while allowing ordinary files",
    () =>
      Effect.gen(function*() {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-case-")))
        try {
          yield* Effect.promise(() => writeFile(join(root, ".env"), "secret"))
          yield* Effect.promise(() => writeFile(join(root, "ordinary.txt"), "before"))

          yield* Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            expect(yield* fs.readFileString(join(root, "ordinary.txt"))).toBe("before")
            yield* fs.writeFileString(join(root, "ordinary.txt"), "after")
            expect(yield* fs.readFileString(join(root, "ordinary.txt"))).toBe("after")
            const secret = yield* Effect.result(fs.readFileString(join(root, ".ENV")))
            expect(secret).toMatchObject({
              _tag: "Failure",
              failure: {
                reason: { _tag: "PermissionDenied", pathOrDescriptor: join(root, ".env"), cause: deniedByPolicy }
              }
            })
          }).pipe(Effect.provide(guarded(root)))

          expect(yield* Effect.promise(() => readFile(join(root, ".env"), "utf8"))).toBe("secret")
        } finally {
          yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
        }
      })
  )

  it.live.skipIf(!caseInsensitive)(
    "denies a missing child under a differently cased report directory",
    () =>
      Effect.gen(function*() {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-case-")))
        try {
          yield* Effect.promise(() => mkdir(join(root, "ReportDir")))
          const result = yield* Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* Effect.result(fs.writeFileString(join(root, "REPORTDIR", "missing.txt"), "blocked"))
          }).pipe(Effect.provide(guarded(root)))
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              reason: {
                _tag: "PermissionDenied",
                pathOrDescriptor: join(root, "ReportDir", "missing.txt"),
                cause: deniedByPolicy
              }
            }
          })
          expect(existsSync(join(root, "ReportDir", "missing.txt"))).toBe(false)
        } finally {
          yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
        }
      })
  )

  it.live.skipIf(!caseInsensitive)(
    "rechecks on-disk spelling after a pending grant and case-only rename",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-case-")))
        try {
          const lower = join(root, "safe.txt")
          const upper = join(root, "SAFE.txt")
          yield* Effect.promise(() => writeFile(lower, "same file"))
          const store = yield* GrantStore.make({ runId: "case-recheck" }).pipe(Effect.provide(Workspace.layer(root)))
          const layer = KernelFileSystem.layer.pipe(
            Layer.provide(AtomicFileSystem.layer),
            Layer.provide(NodePath.layer),
            Layer.provide(Workspace.layer(root)),
            Layer.provide(Layer.succeed(GrantStore.GrantStore, store))
          )
          const pending = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(lower)).pipe(
            Effect.result,
            Effect.provide(layer),
            Effect.forkChild({ startImmediately: true })
          )
          const request = yield* awaitPending(store)
          expect(request.capability).toMatchObject({ action: "fs:read", resource: lower })
          yield* Effect.promise(() => rename(lower, upper))
          yield* store.reply(request.requestId, "once")
          const result = yield* Fiber.join(pending)
          expect(result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "PermissionDenied" } } })
          expect(yield* Effect.promise(() => readFile(upper, "utf8"))).toBe("same file")
        } finally {
          yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
        }
      }))
  )
})

describe("native canonical authorization", () => {
  it.live("resolves a relative workspace root once for both reads and writes", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-relative-")))
      try {
        yield* Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("ordinary.txt", "relative root")
          expect(yield* fs.readFileString("ordinary.txt")).toBe("relative root")
        }).pipe(Effect.provide(guarded(relative(process.cwd(), root))))
        expect(yield* Effect.promise(() => readFile(join(root, "ordinary.txt"), "utf8"))).toBe("relative root")
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
      }
    }))

  it.live("denies inspection and removal of outside-pointing links", () =>
    Effect.gen(function*() {
      const parent = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-outside-link-")))
      const root = join(parent, "workspace")
      const outside = join(parent, "outside.txt")
      const link = join(root, "link")
      try {
        yield* Effect.promise(() => mkdir(root))
        yield* Effect.promise(() => writeFile(outside, "outside"))
        yield* Effect.promise(() => symlink(outside, link))
        yield* Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          for (const operation of [fs.readLink(link), fs.stat(link), fs.exists(link), fs.remove(link)]) {
            const result = yield* Effect.result(operation)
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { reason: { _tag: "PermissionDenied" } }
            })
          }
        }).pipe(Effect.provide(guarded(root)))
        expect((yield* Effect.promise(() => lstat(link))).isSymbolicLink()).toBe(true)
        expect(yield* Effect.promise(() => readFile(outside, "utf8"))).toBe("outside")
      } finally {
        yield* Effect.promise(() => rm(parent, { recursive: true, force: true }))
      }
    }))
})
