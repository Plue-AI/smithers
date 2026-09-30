import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber, Option, type PlatformError } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner as EffectChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as CommandLine from "../src/CommandLine.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as Workspace from "../src/Workspace.ts"

const directories = new Set<string>()

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "flows-kernel-process-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

const withGuardedSpawner = <A, E>(
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, EffectChildProcessSpawner>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make(options)
      return yield* use(store).pipe(
        Effect.provide(ChildProcessSpawner.layer),
        Effect.provide(ProcessConfinement.layerNoop),
        Effect.provide(NodeChildProcessSpawner.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer(process.cwd())))

const waitForEsrch = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
        return
      }
      throw error
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`process ${pid} was not reaped`)
}

describe("ChildProcessSpawner real Node lifecycle", () => {
  it.effect("passes own __proto__ and ordinary environment values to a real child", () =>
    Effect.gen(function*() {
      const env = Object.create(null) as Record<string, string>
      env.__proto__ = "kept-env"
      env.ORDINARY = "kept"
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "console.log(JSON.stringify({ordinary:process.env.ORDINARY,special:process.env['__proto__']}))"
      ], { env, extendEnv: false })
      const pattern = new CapabilityPattern({ action: "proc:spawn", resource: "**" })
      const output = yield* withGuardedSpawner({
        attended: false,
        rules: [new Permission.Rule({ effect: "allow", pattern })]
      }, () =>
        Effect.gen(function*() {
          const spawner = yield* EffectChildProcessSpawner
          return yield* spawner.string(command)
        }))
      expect(JSON.parse(output)).toEqual({ ordinary: "kept", special: "kept-env" })
    }))

  it.effect("leaves no process side effect when the real store denies before spawn", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const token = join(directory, "denied-token")
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
        token
      ])

      const failure = yield* (
        withGuardedSpawner({ attended: false, runId: "denied-process" }, () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            return yield* Effect.flip(spawner.exitCode(command))
          }))
      )
      const permission = Option.getOrThrow(
        Permission.fromPlatformError(failure as PlatformError.PlatformError)
      )

      expect(permission).toBeInstanceOf(Permission.PermissionRequired)
      expect(permission).toMatchObject({
        code: "permission_required",
        capability: { action: "proc:spawn", resource: CommandLine.render(command) }
      })
      expect(yield* Effect.promise(() => exists(token))).toBe(false)
    }))

  it.effect("executes exactly once after replying to the attended pending request", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const token = join(directory, "attended-token")
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        token
      ])

      const exitCode = yield* (
        withGuardedSpawner({ runId: "attended-process" }, (store) =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            const execution = yield* spawner.exitCode(command).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const pending = yield* awaitPending(store)
            expect(pending.capability).toMatchObject({
              action: "proc:spawn",
              resource: CommandLine.render(command)
            })
            expect(yield* Effect.promise(() => exists(token))).toBe(false)

            yield* store.reply(pending.requestId, "once")
            return yield* Fiber.join(execution)
          }))
      )

      expect(exitCode).toBe(0)
      expect(yield* Effect.promise(() => readFile(token, "utf8"))).toBe("x")
    }))

  it.effect("reaps a real child when its owning fiber is interrupted", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make(process.execPath, [
        "-e",
        "setInterval(() => {}, 1_000)"
      ])
      const pattern = new CapabilityPattern({
        action: "proc:spawn",
        resource: CommandLine.render(command)
      })

      const pid = yield* (
        withGuardedSpawner({
          attended: false,
          rules: [new Permission.Rule({ effect: "allow", pattern })]
        }, () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            const started = yield* Deferred.make<number>()
            const owner = yield* Effect.scoped(
              Effect.gen(function*() {
                const handle = yield* spawner.spawn(command)
                yield* Deferred.succeed(started, Number(handle.pid))
                return yield* Effect.never
              })
            ).pipe(Effect.forkChild({ startImmediately: true }))
            const pid = yield* Deferred.await(started)
            expect(() => process.kill(pid, 0)).not.toThrow()
            yield* Fiber.interrupt(owner)
            return pid
          }))
      )

      yield* Effect.promise(() => waitForEsrch(pid))
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }))
})
