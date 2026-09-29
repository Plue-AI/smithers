import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { permissionDenied } from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import { Deferred, Effect, Fiber, FileSystem as EffectFileSystem, Path } from "effect"
import { GrantStore } from "../src/GrantStore.ts"
import * as Jj from "../src/Jj.ts"
import * as Workspace from "../src/Workspace.ts"

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) => it.effect(name, () => effect())

const scriptedStore = (checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return Effect.void
    },
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    rules: () => Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const fileSystem = EffectFileSystem.makeNoop({
  realPath: (path) => Effect.succeed(path)
})

describe("Jj", () => {
  for (const length of [4096, 4097]) {
    itEffect(`keeps a ${length}-unit snapshot resource in the typed channel`, () => {
      const checks: Array<Capability.Capability> = []
      let invoked = false
      return Effect.gen(function*() {
        const jj = yield* Jj.Jj
        const error = yield* Effect.flip(jj.snapshot("x".repeat(length)))
        expect(error).toMatchObject({ code: length === 4096 ? "permission_denied" : "invalid_resolution" })
        if (length === 4097) expect(error).toMatchObject({ message: expect.stringContaining("4096") })
        expect(checks).toHaveLength(length === 4096 ? 1 : 0)
        expect(invoked).toBe(false)
      }).pipe(
        Effect.provide(Jj.layer),
        Effect.provideService(
          HostJj.Jj,
          HostJj.makeNoop({
            snapshot: () =>
              Effect.sync(() => {
                invoked = true
                return { commitId: "commit", changeId: "change" }
              })
          })
        ),
        Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
        Effect.provide(Path.layer),
        Effect.provide(Workspace.layer("/workspace")),
        Effect.provideService(GrantStore, {
          ...scriptedStore(checks),
          check: (capability) => {
            checks.push(capability)
            return Effect.fail(permissionDenied(capability, "denied by test"))
          }
        })
      )
    })
  }

  itEffect("checks every host operation before delegating it", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      status: () =>
        Effect.sync(() => {
          calls.push("status")
          return "status"
        }),
      diff: () =>
        Effect.sync(() => {
          calls.push("diff")
          return "diff"
        }),
      snapshot: () =>
        Effect.sync(() => {
          calls.push("snapshot")
          return { commitId: "commit", changeId: "change" }
        }),
      restore: () =>
        Effect.sync(() => {
          calls.push("restore")
        }),
      workspaceAdd: () =>
        Effect.sync(() => {
          calls.push("workspaceAdd")
        }),
      workspaceForget: () =>
        Effect.sync(() => {
          calls.push("workspaceForget")
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.status()).toBe("status")
      expect(yield* jj.diff("from", "to")).toBe("diff")
      expect(yield* jj.snapshot("message")).toEqual({ commitId: "commit", changeId: "change" })
      yield* jj.restore("change")
      yield* jj.workspaceAdd("lane", "/work/lane")
      yield* jj.workspaceForget("lane")
      expect(calls).toEqual(["status", "diff", "snapshot", "restore", "workspaceAdd", "workspaceForget"])
      expect(checks).toEqual([
        { action: "jj:status", resource: "." },
        { action: "jj:diff", resource: "from:to" },
        { action: "jj:snapshot", resource: "message" },
        { action: "jj:restore", resource: "change" },
        { action: "jj:workspace-add", resource: "/work/lane" },
        { action: "fs:write", resource: "/work/lane" },
        { action: "jj:workspace-forget", resource: "lane" }
      ])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore(checks))
    )
  })

  itEffect("checks the optional operations a backend does implement", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      root: (from) =>
        Effect.sync(() => {
          calls.push(`root:${from}`)
          return "/repository"
        }),
      revert: (changeId) =>
        Effect.sync(() => {
          calls.push(`revert:${changeId}`)
          return { reverted: ["src/a.ts"] }
        }),
      opRestore: (operationId) =>
        Effect.sync(() => {
          calls.push(`opRestore:${operationId}`)
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.root!("/repository/lane")).toBe("/repository")
      expect(yield* jj.revert!("change")).toEqual({ reverted: ["src/a.ts"] })
      yield* jj.opRestore!("abc123")
      expect(calls).toEqual(["root:/repository/lane", "revert:change", "opRestore:abc123"])
      expect(checks).toEqual([
        { action: "jj:root", resource: "/repository/lane" },
        { action: "jj:revert", resource: "change" },
        { action: "jj:op-restore", resource: "abc123" }
      ])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore(checks))
    )
  })

  itEffect("runs `root` in the canonical directory it was authorized for", () => {
    // A symlink is the whole attack: check `jj:root` on the name the caller
    // spelled and then run jj somewhere else, and an authorized path decides
    // the answer for a repository the grant never mentioned.
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const aliasing = EffectFileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path === "/workspace/alias" ? "/elsewhere/repository" : path)
    })
    const host = HostJj.makeNoop({
      root: (from) =>
        Effect.sync(() => {
          calls.push(`root:${from}`)
          return "/elsewhere/repository"
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.root!("alias")).toBe("/elsewhere/repository")
      // One path, resolved once: the capability and the subprocess cwd cannot
      // disagree because they are the same value.
      expect(calls).toEqual(["root:/elsewhere/repository"])
      expect(checks).toEqual([{ action: "jj:root", resource: "/elsewhere/repository" }])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, aliasing),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore(checks))
    )
  })

  itEffect("refuses a workspace destination that changes after both grants", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let canonical = "/workspace/lane"
        let delegated = false
        const resolutions: Array<readonly [string, string]> = []
        const checks: Array<Capability.Capability> = []
        const changing = EffectFileSystem.makeNoop({
          realPath: (value) =>
            Effect.sync(() => {
              const resolved = value === "/workspace" ? value : canonical
              resolutions.push([value, resolved])
              return resolved
            })
        })
        const store = GrantStore.of({
          check: (capability) => {
            checks.push(capability)
            return checks.length === 2
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
          },
          reply: () => Effect.die("not used by workspace mutation test"),
          list: Effect.succeed([]),
          rules: () => Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
        const host = HostJj.makeNoop({
          workspaceAdd: () =>
            Effect.sync(() => {
              delegated = true
            })
        })
        const running = yield* Effect.gen(function*() {
          const jj = yield* Jj.Jj
          return yield* jj.workspaceAdd("lane", "lane")
        }).pipe(
          Effect.provide(Jj.layer),
          Effect.provideService(HostJj.Jj, host),
          Effect.provideService(EffectFileSystem.FileSystem, changing),
          Effect.provide(Path.layer),
          Effect.provide(Workspace.layer("/workspace")),
          Effect.provideService(GrantStore, store),
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(entered)
        canonical = "/outside/lane"
        yield* Deferred.succeed(release, undefined)
        const outcome = yield* Fiber.join(running)
        if (outcome._tag === "Success") throw new Error(`unexpected delegation: ${JSON.stringify(resolutions)}`)
        expect(outcome).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [{
              error: {
                code: "permission_denied",
                capability: { action: "jj:workspace-add", resource: "/workspace/lane" },
                reason: "workspace destination no longer names the resource that was authorized"
              }
            }]
          }
        })
        expect(delegated).toBe(false)
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lane" },
          { action: "fs:write", resource: "/workspace/lane" }
        ])
      })
    ))

  itEffect("forwards the absence of an operation a backend does not implement", () => {
    // A backend that cannot revert must keep reading as one. Wrapping the
    // absence in a guarded method that fails on call would answer "your revert
    // was refused" to a caller asking "can this host revert at all".
    const host = HostJj.make({
      status: () => Effect.succeed("status"),
      diff: () => Effect.succeed("diff"),
      snapshot: () => Effect.succeed({ commitId: "change", changeId: "change" }),
      restore: () => Effect.void,
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(jj.root).toBeUndefined()
      expect(jj.revert).toBeUndefined()
      expect(jj.opRestore).toBeUndefined()
      expect(yield* jj.status()).toBe("status")
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore([]))
    )
  })

  itEffect("does not delegate when a Jj capability is denied", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const store = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.fail(permissionDenied(capability, "denied by test"))
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      rules: () => Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const host = HostJj.makeNoop({
      status: () =>
        Effect.sync(() => {
          invoked = true
          return "status"
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({
        code: "permission_denied",
        capability: { action: "jj:status", resource: "." },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "jj:status", resource: "." }])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, store)
    )
  })
})
