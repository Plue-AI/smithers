import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import {
  Effect,
  Fiber,
  FileSystem as EffectFileSystem,
  Layer,
  Option,
  Path as EffectPath,
  type PlatformError,
  Sink,
  Stream
} from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner as EffectChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as FileSystem from "../src/FileSystem.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as HostServices from "../src/HostServices.ts"
import * as KernelHttpClient from "../src/HttpClient.ts"
import * as Workspace from "../src/Workspace.ts"

const allowAll = GrantStore.GrantStore.of({
  check: () => Effect.void,
  reply: () => Effect.die("not used by aggregate-layer tests"),
  list: Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

const denial = (error: unknown) => Option.getOrThrow(Permission.fromPlatformError(error as PlatformError.PlatformError))

const fileSystem = FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({
  realPath: (path) => Effect.succeed(path),
  stat: (path) =>
    Effect.succeed({
      type: path === "/workspace" ? "Directory" : "File",
      nlink: Option.none()
    } as EffectFileSystem.File.Info),
  readFile: () => Effect.succeed(new Uint8Array())
}))

const encoder = new TextEncoder()

const testHost = Layer.mergeAll(
  EffectPath.layer,
  BrowserJj.layerUnsupported,
  Layer.succeed(EffectChildProcessSpawner)(
    makeSpawner(() => {
      const stdout = Stream.succeed(encoder.encode("protected\n"))
      return Effect.succeed(makeHandle({
        pid: ProcessId(1),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      }))
    })
  )
)

describe("HostServices", () => {
  it.each(["workspace", "workspace/"] as const)(
    "constructs guarded filesystem with relative workspace root %s through direct and aggregate layers",
    async (suffix) => {
      const directory = await mkdtemp(join(tmpdir(), "flows-relative-root-"))
      try {
        const absoluteRoot = join(directory, "workspace")
        await mkdir(absoluteRoot)
        await writeFile(join(absoluteRoot, "inside.txt"), "inside")
        const relativeRoot = relative(process.cwd(), directory) + "/" + suffix
        const consumer = Effect.gen(function*() {
          const fs = yield* EffectFileSystem.FileSystem
          return new TextDecoder().decode(yield* fs.readFile("inside.txt"))
        })
        const isolatedHost = Layer.effect(
          EffectFileSystem.FileSystem,
          Effect.map(EffectFileSystem.FileSystem, FileSystem.withIsolatedFileSystem)
        ).pipe(Layer.provide(NodeFileSystem.layer))
        const host = Layer.mergeAll(
          isolatedHost,
          NodePath.layer,
          testHost,
          Layer.succeed(EffectHttpClient.HttpClient)(
            EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
          )
        )
        for (const guarded of [FileSystem.layer, HostServices.layer]) {
          const result = await Effect.runPromise(
            consumer.pipe(
              Effect.provide(guarded),
              Effect.provide(host),
              Effect.provide(Workspace.layer(relativeRoot)),
              Effect.provideService(GrantStore.GrantStore, allowAll)
            )
          )
          expect(result).toBe("inside")
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it("shares one closed platform-port list with one tag per slot", () => {
    expect(HostServices.HostServiceTags).toEqual([
      EffectFileSystem.FileSystem,
      EffectPath.Path,
      EffectChildProcessSpawner,
      HostJj.Jj,
      EffectHttpClient.HttpClient
    ])
    expect(HostServices.HostServiceIds).toEqual([
      "effect/FileSystem",
      "effect/Path",
      "effect/process/ChildProcessSpawner",
      "@smthrs/jj/Jj",
      "effect/HttpClient"
    ])
    expect(HostServices.HostServiceTags).toHaveLength(HostServices.HostServiceIds.length)
    // There is no second, "protected" tag list to keep in slot order with this
    // one: the kernel decorates each tag above in place.
    expect(HostServices).not.toHaveProperty("ProtectedHostServiceTags")
  })

  it.effect("replaces each platform tag with its guarded implementation and preserves host behavior", () =>
    Effect.gen(function*() {
      const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
      const program = Effect.gen(function*() {
        const guardedFileSystem = yield* EffectFileSystem.FileSystem
        expect(Array.from(yield* guardedFileSystem.readFile("/workspace/.keep"))).toEqual([])

        const path = yield* EffectPath.Path
        expect(path.normalize("/workspace/src/../src")).toBe("/workspace/src")

        const spawner = yield* EffectChildProcessSpawner
        expect(yield* spawner.string(ChildProcess.make("fixture"))).toBe("protected\n")

        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.status())).toMatchObject({
          code: "not_installed",
          command: "jj status",
          message: "jj is not available in the browser"
        })

        const client = yield* EffectHttpClient.HttpClient
        expect((yield* client.get("https://example.test/health")).status).toBe(200)
      }).pipe(
        Effect.provide(HostServices.layer),
        Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
        Effect.provideService(EffectHttpClient.HttpClient, http),
        Effect.provide(testHost),
        Effect.provide(Workspace.layer("/workspace")),
        Effect.provideService(GrantStore.GrantStore, allowAll)
      )
      yield* program
    }))

  it.effect("intercepts the underlying platform tags, so a kernel-unaware consumer is guarded too", () =>
    Effect.gen(function*() {
      const checks: Array<Capability.Capability> = []
      const deny = GrantStore.GrantStore.of({
        check: (capability) => {
          checks.push(capability)
          return Effect.fail(Permission.permissionDenied(capability, "denied by integration test"))
        },
        reply: () => Effect.die("not used by aggregate-layer tests"),
        list: Effect.succeed([]),
        grantEnvelope: () => Effect.void
      })
      const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
      const program = Effect.gen(function*() {
        const spawner = yield* EffectChildProcessSpawner
        const spawnFailure = yield* Effect.flip(spawner.string(ChildProcess.make("blocked")))
        expect(spawnFailure).toMatchObject({
          _tag: "PlatformError",
          reason: { _tag: "PermissionDenied", module: "ChildProcessSpawner", method: "spawn" }
        })
        expect(denial(spawnFailure)).toMatchObject({
          code: "permission_denied",
          capability: { action: "proc:spawn", resource: "blocked" },
          reason: "denied by integration test"
        })

        // Smithers owns `Jj`, so its interface names the kernel failure directly
        // instead of projecting it into a `PlatformError`.
        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.status())).toMatchObject({
          code: "permission_denied",
          capability: { action: "jj:status", resource: "." },
          reason: "denied by integration test"
        })

        const guardedFileSystem = yield* EffectFileSystem.FileSystem
        const readFailure = yield* Effect.flip(guardedFileSystem.readFile("/workspace/.keep"))
        expect(readFailure).toMatchObject({
          _tag: "PlatformError",
          reason: { _tag: "PermissionDenied", module: "FileSystem", method: "read" }
        })
        expect(denial(readFailure)).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:read", resource: "/workspace/.keep" },
          reason: "denied by integration test"
        })
      }).pipe(
        Effect.provide(HostServices.layer),
        Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
        Effect.provideService(EffectHttpClient.HttpClient, http),
        Effect.provide(testHost),
        Effect.provide(Workspace.layer("/workspace")),
        Effect.provideService(GrantStore.GrantStore, deny),
        Effect.scoped
      )

      yield* program
      expect(checks.map((capability) => capability.action)).toEqual([
        "proc:spawn",
        "jj:status",
        "fs:read"
      ])
    }))

  it.effect("denies and resumes attended HTTP through aggregate slot 4", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const http = EffectHttpClient.make((request) =>
        Effect.sync(() => {
          calls.push(request.url)
          return { status: 200, headers: {}, request } as never
        })
      )
      const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
        Effect.suspend(() =>
          Effect.flatMap(store.list, (pending) =>
            pending[0] === undefined
              ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
              : Effect.succeed(pending[0]))
        )

      const program = Effect.scoped(
        Effect.gen(function*() {
          const store = yield* GrantStore.make({ runId: "aggregate-http" })
          yield* Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            const deniedRequest = yield* Effect.flip(client.get("https://example.test/deny")).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const deniedPending = yield* awaitPending(store)
            expect(deniedPending.capability).toMatchObject({ action: "net:get", resource: "example.test" })
            yield* store.reply(deniedPending.requestId, "deny")

            const failure = yield* Fiber.join(deniedRequest)
            expect(Option.getOrThrow(KernelHttpClient.fromHttpClientError(failure))).toMatchObject({
              code: "permission_denied",
              capability: { action: "net:get", resource: "example.test" },
              reason: "permission request denied"
            })
            expect(calls).toEqual([])

            const allowedRequest = yield* client.get("https://example.test/allow").pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const allowedPending = yield* awaitPending(store)
            yield* store.reply(allowedPending.requestId, "once")
            expect((yield* Fiber.join(allowedRequest)).status).toBe(200)
            expect(calls).toEqual(["https://example.test/allow"])
          }).pipe(
            Effect.provide(HostServices.layer),
            Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
            Effect.provideService(EffectHttpClient.HttpClient, http),
            Effect.provide(testHost),
            Effect.provideService(GrantStore.GrantStore, store)
          )
        })
      ).pipe(Effect.provide(Workspace.layer("/workspace")))

      yield* program
    }))
})
