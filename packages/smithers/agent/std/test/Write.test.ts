import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, FileSystem, Layer, Option, PlatformError } from "effect"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Write from "../src/Write.ts"
import { fileInfo, layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const systemError = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  path: string
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor: path
  })

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

describe("Write", () => {
  it("creates parent directories and reports a new file", async () => {
    const result = await execute(Effect.provide(
      Effect.gen(function*() {
        const output = yield* Write.run({ path: "/nested/parent/file.txt", content: "hello" })
        const fileSystem = yield* FileSystem.FileSystem
        const content = yield* fileSystem.readFileString("/nested/parent/file.txt")
        return { output, content }
      }),
      layer()
    ))
    expect(result.output).toEqual({ path: "/nested/parent/file.txt", bytesWritten: 5, created: true })
    expect(result.content).toBe("hello")
  })

  it("reports an overwrite without marking it created", async () => {
    const result = await execute(Effect.provide(
      Effect.gen(function*() {
        const output = yield* Write.run({ path: "/file.txt", content: "new" })
        const fileSystem = yield* FileSystem.FileSystem
        const content = yield* fileSystem.readFileString("/file.txt")
        return { output, content }
      }),
      layer({ files: { "/file.txt": "old" } })
    ))
    expect(result.output.created).toBe(false)
    expect(result.content).toBe("new")
  })

  it("reports the UTF-8 byte count for multibyte content", async () => {
    const result = await execute(Effect.provide(
      Write.run({ path: "/unicode.txt", content: "café 😀" }),
      layer()
    ))
    expect(result.bytesWritten).toBe(10)
  })

  it("restores permission bits when the host write moves them", async () => {
    let mode = 0o100644
    let content = "old"
    const chmods: Array<number> = []
    const host = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      makeDirectory: () => Effect.void,
      realPath: (path) => Effect.succeed(path),
      rename: () => Effect.void,
      remove: () => Effect.void,
      stat: () => Effect.succeed(fileInfo({ mode })),
      writeFileString: (_path, value) =>
        Effect.sync(() => {
          content = value
          mode = 0o100755
        }),
      chmod: (_path, value) =>
        Effect.sync(() => {
          chmods.push(value)
          mode = 0o100000 | value
        })
    })
    const result = await execute(Effect.provide(
      Effect.provideService(Write.run({ path: "/file.txt", content: "new" }), FileSystem.FileSystem, host),
      layer()
    ))
    expect(result.created).toBe(false)
    expect(content).toBe("new")
    expect(mode).toBe(0o100644)
    expect(chmods).toEqual([0o644])
  })

  it("fails before writing when the initial stat is denied", async () => {
    let writes = 0
    let stats = 0
    const host = FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      remove: () => Effect.void,
      exists: () => Effect.succeed(true),
      makeDirectory: () => Effect.void,
      stat: () => {
        stats++
        return stats === 1
          ? Effect.succeed(fileInfo({ mode: 0o100644 }))
          : Effect.fail(systemError("PermissionDenied", "stat", "/file.txt"))
      },
      writeFileString: () =>
        Effect.sync(() => {
          writes++
        })
    })
    const exit = await execute(Effect.provide(
      Effect.exit(Effect.provideService(
        Write.run({ path: "/file.txt", content: "new" }),
        FileSystem.FileSystem,
        host
      )),
      layer()
    ))
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied", path: "/file.txt" })
    expect(writes).toBe(0)
  })

  it("preserves the original when chmod cannot prepare the replacement mode", async () => {
    let staged = ""
    let content = "old"
    const host = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      makeDirectory: () => Effect.void,
      realPath: (path) => Effect.succeed(path),
      remove: () => Effect.void,
      stat: (path) => Effect.succeed(fileInfo({ mode: path === "/file.txt" ? 0o100644 : 0o100755 })),
      writeFileString: (_path, value) =>
        Effect.sync(() => {
          staged = value
        }),
      rename: () =>
        Effect.sync(() => {
          content = staged
        }),
      chmod: () => Effect.fail(systemError("PermissionDenied", "chmod", "/file.txt"))
    })
    const exit = await execute(Effect.provide(
      Effect.exit(Effect.provideService(
        Write.run({ path: "/file.txt", content: "new" }),
        FileSystem.FileSystem,
        host
      )),
      layer()
    ))
    const failure = failureOf(exit)
    expect(failure).toMatchObject({ code: "command_failed", path: "/file.txt" })
    expect(failure?.message).toContain("Could not preserve the mode")
    expect(failure?.message).toContain("before replacement")
    expect(staged).toBe("new")
    expect(content).toBe("old")
    expect((await execute(host.stat("/file.txt"))).mode).toBe(0o100644)
  })

  it("does not call chmod when the mode is unchanged", async () => {
    let chmods = 0
    let writes = 0
    const host = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      makeDirectory: () => Effect.void,
      realPath: (path) => Effect.succeed(path),
      rename: () => Effect.void,
      remove: () => Effect.void,
      stat: () => Effect.succeed(fileInfo({ mode: 0o100644 })),
      writeFileString: () =>
        Effect.sync(() => {
          writes++
        }),
      chmod: () =>
        Effect.sync(() => {
          chmods++
        })
    })
    await execute(Effect.provide(
      Effect.provideService(Write.run({ path: "/file.txt", content: "new" }), FileSystem.FileSystem, host),
      layer()
    ))
    expect(writes).toBe(1)
    expect(chmods).toBe(0)
  })

  it("fails with command_failed when the target is an existing directory", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Write.run({ path: "/directory", content: "new" })),
      layer({ files: { "/directory/child.txt": "child" } })
    ))
    expect(failureOf(exit)).toMatchObject({ code: "command_failed", path: "/directory" })
  })

  it("fails with permission_denied and the path when the filesystem refuses the write", async () => {
    const host = FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      remove: () => Effect.void,
      exists: () => Effect.succeed(false),
      makeDirectory: () => Effect.void,
      stat: () => Effect.fail(systemError("NotFound", "stat", "/file.txt")),
      writeFileString: () => Effect.fail(systemError("PermissionDenied", "writeFileString", "/file.txt"))
    })
    const exit = await execute(Effect.provide(
      Effect.exit(Effect.provideService(
        Write.run({ path: "/file.txt", content: "new" }),
        FileSystem.FileSystem,
        host
      )),
      layer()
    ))
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied", path: "/file.txt" })
  })

  it("honors declared grants for creation and replacement under the guarded host", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "std-write-grants-")))
    const target = join(workspace, "file.txt")
    const guarded = (actions: ReadonlyArray<"fs:read" | "fs:write">) =>
      KernelFileSystem.layer.pipe(
        Layer.provide(
          Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, KernelFileSystem.withIsolatedFileSystem)
          )
            .pipe(Layer.provide(NodeFileSystem.layer))
        ),
        Layer.provide(GrantStore.layer({
          attended: false,
          rules: actions.flatMap((action) => [
            new Rule({ effect: "allow", pattern: new CapabilityPattern({ action, resource: workspace }) }),
            new Rule({ effect: "allow", pattern: new CapabilityPattern({ action, resource: join(workspace, "**") }) })
          ])
        })),
        Layer.provide(Workspace.layer(workspace)),
        Layer.provideMerge(NodePath.layer)
      )
    const run = (actions: ReadonlyArray<"fs:read" | "fs:write">, content: string) =>
      Effect.runPromiseExit(Effect.scoped(
        Write.run({ path: target, content }).pipe(Effect.provide(guarded(actions)))
      ))
    try {
      writeFileSync(target, "original")
      const denied = await run(["fs:write"], "refused")
      expect(failureOf(denied)).toMatchObject({ code: "permission_denied", path: target })
      expect(readFileSync(target, "utf8")).toBe("original")

      const declared: ReadonlyArray<"fs:read" | "fs:write"> = Write.capabilities.includes("fs:read:/**")
        ? ["fs:read", "fs:write"]
        : ["fs:write"]
      const replaced = await run(declared, "replacement")
      expect(Exit.isSuccess(replaced)).toBe(true)
      if (Exit.isSuccess(replaced)) expect(replaced.value.created).toBe(false)
      expect(readFileSync(target, "utf8")).toBe("replacement")

      rmSync(target)
      const created = await run(declared, "created")
      expect(Exit.isSuccess(created)).toBe(true)
      if (Exit.isSuccess(created)) expect(created.value.created).toBe(true)
      expect(readFileSync(target, "utf8")).toBe("created")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("declares compensable hermetic effects and narrows each invocation", () => {
    expect(Write.effects).toMatchObject({ tier: "compensable", mode: "hermetic" })
    expect(Write.effects.reads).toEqual(["/**"])
    expect(Write.effectsFor({ path: "/file.txt", content: "new" }).reads).toEqual(["/file.txt"])
    expect(Write.effectsFor({ path: "/file.txt", content: "new" }).writes).toEqual(["/file.txt"])
  })
})
