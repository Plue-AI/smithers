import { describe, expect, it } from "@effect/vitest"
import type * as Capability from "@smthrs/capability/Capability"
import { permissionDenied } from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import { Effect, FileSystem as EffectFileSystem, Path } from "effect"
import { systemError } from "effect/PlatformError"
import { GrantStore, type Service } from "../src/GrantStore.ts"
import * as Jj from "../src/Jj.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * The Jj decorator turns each version-control operation into a capability
 * resource. Those resources are the strings an approver sees and a remembered
 * rule matches against, so an unlabelled snapshot and a workspace-relative
 * lane path must both produce stable, canonical resources.
 */

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

const provideWithStore = <A, E>(
  effect: Effect.Effect<A, E, HostJj.Jj>,
  host: HostJj.Jj,
  grants: Service,
  rawFileSystem: EffectFileSystem.FileSystem = fileSystem
) =>
  effect.pipe(
    Effect.provide(Jj.layer),
    Effect.provideService(HostJj.Jj, host),
    Effect.provideService(EffectFileSystem.FileSystem, rawFileSystem),
    Effect.provide(Path.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, grants)
  )

const provide = <A, E>(
  effect: Effect.Effect<A, E, HostJj.Jj>,
  host: HostJj.Jj,
  checks: Array<Capability.Capability>
) => provideWithStore(effect, host, scriptedStore(checks))

describe("Jj capability resources", () => {
  itEffect("labels an unnamed snapshot with an empty resource", () => {
    const messages: Array<string | undefined> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      snapshot: (message) =>
        Effect.sync(() => {
          messages.push(message)
          return { commitId: "commit", changeId: "change" as HostJj.ChangeId }
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* jj.snapshot()).toEqual({ commitId: "commit", changeId: "change" })
        expect(checks).toEqual([{ action: "jj:snapshot", resource: "" }])
        // The absent message is forwarded as-is; only the resource is defaulted.
        expect(messages).toEqual([undefined])
      }),
      host,
      checks
    )
  })

  itEffect("canonicalizes a workspace-relative workspace-add destination", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        yield* jj.workspaceAdd("lane", "lanes/./one")
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lanes/one" },
          { action: "fs:write", resource: "/workspace/lanes/one" }
        ])
        expect(calls).toEqual([["lane", "/workspace/lanes/one"]])
      }),
      host,
      checks
    )
  })

  itEffect("keeps an absolute workspace-add destination outside the workspace", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        yield* jj.workspaceAdd("lane", "/elsewhere/lane")
        expect(checks.map((check) => check.resource)).toEqual(["/elsewhere/lane", "/elsewhere/lane"])
        expect(calls).toEqual([["lane", "/elsewhere/lane"]])
      }),
      host,
      checks
    )
  })

  itEffect("does not delegate when workspace authority passes but filesystem authority is denied", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })
    const grants = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return capability.action === "jj:workspace-add"
          ? Effect.void
          : Effect.fail(permissionDenied(capability, "filesystem write denied"))
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      rules: () => Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return provideWithStore(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.workspaceAdd("lane", "lanes/one"))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/workspace/lanes/one" },
          reason: "filesystem write denied"
        })
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lanes/one" },
          { action: "fs:write", resource: "/workspace/lanes/one" }
        ])
        expect(calls).toEqual([])
      }),
      host,
      grants
    )
  })

  itEffect("fails before checking or delegating when destination canonicalization fails", () => {
    let delegated = false
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: () =>
        Effect.sync(() => {
          delegated = true
        })
    })
    const brokenFileSystem = EffectFileSystem.makeNoop({
      realPath: () =>
        Effect.fail(systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "realPath",
          pathOrDescriptor: "/workspace"
        })),
      readLink: () =>
        Effect.fail(systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readLink",
          pathOrDescriptor: "/workspace"
        }))
    })

    return provideWithStore(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.workspaceAdd("lane", "lanes/one"))).toMatchObject({
          _tag: "PlatformError",
          reason: { _tag: "NotFound", module: "FileSystem", method: "realPath" }
        })
        expect(checks).toEqual([])
        expect(delegated).toBe(false)
      }),
      host,
      scriptedStore(checks),
      brokenFileSystem
    )
  })
})

describe("Jj stub layer", () => {
  itEffect("provides an unavailable Jj service", () =>
    Effect.gen(function*() {
      const jj = yield* HostJj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({ code: "not_installed", method: "status" })
    }).pipe(Effect.provide(Jj.layerNoop({}))))

  itEffect("provides overridden operations while the rest stay unavailable", () =>
    Effect.gen(function*() {
      const jj = yield* HostJj.Jj
      expect(yield* jj.status()).toBe("clean")
      expect(yield* Effect.flip(jj.snapshot("m"))).toMatchObject({ code: "not_installed" })
    }).pipe(Effect.provide(Jj.layerNoop({ status: () => Effect.succeed("clean") }))))
})
