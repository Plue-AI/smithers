/**
 * The native sandbox around a real approved process: the kernel spawner over
 * Effect's Node spawner, a real grant store, and this host's mechanism.
 *
 * Every case asserts on the operating system's answer, never on a rendered
 * profile: a marker file that exists or does not, a listener that was reached
 * or was not. The suite runs where a mechanism exists, seatbelt on macOS and
 * bubblewrap on a Linux host with `bwrap` installed, and reports itself
 * skipped elsewhere rather than passing vacuously.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, Layer } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner as EffectChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeFs from "node:fs"
import * as NodeHttp from "node:http"
import * as NodeOs from "node:os"
import { join } from "node:path"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const hostFacts: ProcessSandbox.Host = {
  ...ProcessSandbox.host(),
  // The probe below runs this very Node binary, which need not be the `node` on PATH.
  executable: (name) => name === "node" ? process.execPath : ProcessSandbox.host().executable(name)
}

const mechanism = ProcessSandbox.select({ network: "none" }, hostFacts)
const available = !ProcessSandbox.isUnenforceable(mechanism)

const directories = new Set<string>()

const fixture = () => {
  const base = NodeFs.realpathSync(NodeFs.mkdtempSync(join(NodeOs.tmpdir(), "flows-confined-process-")))
  directories.add(base)
  const workspace = join(base, "workspace")
  NodeFs.mkdirSync(join(workspace, "src"), { recursive: true })
  NodeFs.writeFileSync(join(workspace, "src", "note.txt"), "readable")
  return { base, workspace, outside: join(base, "outside") }
}

afterEach(() => {
  for (const directory of directories) NodeFs.rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

const rule = (action: CapabilityPattern["action"], resource: string) =>
  new Permission.Rule({ effect: "allow", pattern: new CapabilityPattern({ action, resource }) })

const spawnAny = rule("proc:spawn", "**")

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

/** The kernel spawner, confined natively, over a real store with `rules` in force. */
const confined = <A, E>(
  workspace: string,
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, EffectChildProcessSpawner>,
  confinement: ProcessConfinement.Options = {}
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make(options)
      return yield* use(store).pipe(
        Effect.provide(ChildProcessSpawner.layer.pipe(
          Layer.provide(ProcessConfinement.layer({ host: hostFacts, ...confinement }))
        )),
        Effect.provide(NodeChildProcessSpawner.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer(workspace)))

const shell = (line: string, cwd?: string) =>
  ChildProcess.make("/bin/sh", ["-c", line], cwd === undefined ? {} : { cwd })

describe.skipIf(!available)("a confined approved process", () => {
  it.effect("cannot write outside the workspace, or inside it, without a write grant", () =>
    Effect.gen(function*() {
      const { outside, workspace } = fixture()
      const exits = yield* confined(workspace, { attended: false, rules: [spawnAny] }, () =>
        Effect.gen(function*() {
          const spawner = yield* EffectChildProcessSpawner
          return [
            yield* spawner.exitCode(shell(`printf x > ${outside}`)),
            yield* spawner.exitCode(shell("printf x > ../outside-relative")),
            yield* spawner.exitCode(shell("printf x > inside"))
          ]
        }))
      expect(exits.every((code) => code !== 0)).toBe(true)
      expect(NodeFs.existsSync(outside)).toBe(false)
      expect(NodeFs.existsSync(join(workspace, "..", "outside-relative"))).toBe(false)
      expect(NodeFs.existsSync(join(workspace, "inside"))).toBe(false)
    }))

  it.effect("writes where an fs:write grant opens, and nowhere else", () =>
    Effect.gen(function*() {
      const { outside, workspace } = fixture()
      const exits = yield* confined(
        workspace,
        { attended: false, rules: [spawnAny, rule("fs:write", `${workspace}/out/**`)] },
        () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            return [
              yield* spawner.exitCode(shell("printf granted > out/file")),
              yield* spawner.exitCode(shell("printf x > src/other")),
              yield* spawner.exitCode(shell(`printf x > ${outside}`))
            ]
          })
      )
      expect(exits[0]).toBe(0)
      expect(NodeFs.readFileSync(join(workspace, "out", "file"), "utf8")).toBe("granted")
      expect(exits[1]).not.toBe(0)
      expect(NodeFs.existsSync(join(workspace, "src", "other"))).toBe(false)
      expect(exits[2]).not.toBe(0)
      expect(NodeFs.existsSync(outside)).toBe(false)
    }))

  it.effect("reads what an fs:read grant opens", () =>
    Effect.gen(function*() {
      const { workspace } = fixture()
      const [denied, allowed] = yield* confined(workspace, { attended: false, rules: [spawnAny] }, () =>
        Effect.gen(function*() {
          const spawner = yield* EffectChildProcessSpawner
          return [yield* spawner.exitCode(shell("cat src/note.txt"))]
        })).pipe(
          Effect.zip(
            confined(workspace, { attended: false, rules: [spawnAny, rule("fs:read", `${workspace}/**`)] }, () =>
              Effect.gen(function*() {
                const spawner = yield* EffectChildProcessSpawner
                return yield* spawner.string(shell("cat src/note.txt"))
              }))
          ),
          Effect.map(([denied, allowed]) =>
            [denied[0], allowed] as const
          )
        )
      expect(denied).not.toBe(0)
      expect(allowed).toBe("readable")
    }))

  it.effect("reaches a listener only under a network grant", () =>
    Effect.gen(function*() {
      const { workspace } = fixture()
      const server = NodeHttp.createServer((_request, response) => response.end("ok"))
      yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)))
      const port = (server.address() as { readonly port: number }).port
      const probe = ChildProcess.make(process.execPath, [
        "-e",
        `fetch("http://127.0.0.1:${port}/").then(() => process.exit(0), () => process.exit(3))`
      ])
      try {
        const closed = yield* confined(workspace, { attended: false, rules: [spawnAny] }, () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            return yield* spawner.exitCode(probe)
          }))
        const open = yield* confined(workspace, { attended: false, rules: [spawnAny, rule("net:get", "**")] }, () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            return yield* spawner.exitCode(probe)
          }))
        expect(closed).toBe(3)
        expect(open).toBe(0)
      } finally {
        server.close()
      }
    }))

  it.effect("confines a once-approved shell under the grants in force at approval", () =>
    Effect.gen(function*() {
      const { base, workspace } = fixture()
      const marker = join(base, "outside-grant")
      const exitCode = yield* confined(workspace, { runId: "attended-confined" }, (store) =>
        Effect.gen(function*() {
          const spawner = yield* EffectChildProcessSpawner
          const execution = yield* spawner.exitCode(shell(`printf escaped > ${marker}`)).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          const pending = yield* awaitPending(store)
          expect(pending.capability.action).toBe("proc:spawn")
          yield* store.reply(pending.requestId, "once")
          return yield* Fiber.join(execution)
        }))
      expect(exitCode).not.toBe(0)
      expect(NodeFs.existsSync(marker)).toBe(false)
    }))
})

describe("a host without a mechanism", () => {
  it.effect("refuses to spawn when told to fail closed, before anything runs", () =>
    Effect.gen(function*() {
      const { base, workspace } = fixture()
      const marker = join(base, "unconfined")
      const failure = yield* confined(
        workspace,
        { attended: false, rules: [spawnAny] },
        () =>
          Effect.gen(function*() {
            const spawner = yield* EffectChildProcessSpawner
            return yield* Effect.flip(spawner.exitCode(shell(`printf x > ${marker}`)))
          }),
        { unavailable: "refuse", host: { ...hostFacts, platform: "win32", executable: () => undefined } }
      )
      expect(failure).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "NotFound", module: "ProcessConfinement", method: "confine" }
      })
      expect(NodeFs.existsSync(marker)).toBe(false)
    }))
})
