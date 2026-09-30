import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import {
  Deferred,
  Effect,
  Encoding,
  Fiber,
  FileSystem as EffectFileSystem,
  Option,
  Path as EffectPath,
  PlatformError,
  Result,
  Stream
} from "effect"
import * as ByteSize from "effect/ByteSize"
import * as FileSystem from "../src/FileSystem.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) => it.effect(name, () => effect())

/**
 * Effect's `FileSystem` tag fixes its error channel to `PlatformError`, so the
 * kernel projects its own failure into one and keeps the structured original
 * on the cause. Every denial assertion reads it back out.
 */
const denial = (error: unknown) => Option.getOrThrow(Permission.fromPlatformError(error as PlatformError.PlatformError))

const scriptedStore = (allowed: ReadonlySet<string>, checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return allowed.has(`${capability.action}:${capability.resource}`)
        ? Effect.void
        : Effect.fail(Permission.permissionDenied(capability, "denied by test"))
    },
    reply: () => Effect.die("not used by filesystem decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const hostFileSystem = (overrides: Partial<EffectFileSystem.FileSystem>) =>
  FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    ...overrides
  }))

const provide = (
  effect: Effect.Effect<void, unknown, EffectFileSystem.FileSystem>,
  host: EffectFileSystem.FileSystem,
  grants: ReturnType<typeof scriptedStore>
) =>
  effect.pipe(
    Effect.provide(FileSystem.layer),
    Effect.provideService(EffectFileSystem.FileSystem, host),
    Effect.provide(EffectPath.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, grants)
  )

type VolumeEntry =
  | { readonly kind: "directory" | "file" | "locked" }
  | { readonly kind: "link" | "mount"; readonly target: string }

/**
 * An in-memory volume behind a descriptor-relative, no-follow executor. Its
 * `resolve` walks from the pinned root, never through a link: it stops at the
 * first link and answers the link's own path and text, and at the first
 * missing component or file, keeping the rest as requested. Every entry it
 * inspects is recorded in `chain`. A `mount` is a reparse point whose text
 * the executor cannot translate, like a Windows volume mount point, and a
 * `locked` entry cannot be inspected at all. `answers` overrides one answer,
 * and `after` runs a swap once, right after the named request returns.
 */
const modelVolume = (entries: Map<string, VolumeEntry>) => {
  const chain: Array<string> = []
  const resolutions: Array<string> = []
  const after = new Map<string, () => void>()
  const answers = new Map<string, FileSystem.Resolution>()
  const refusal = (description: string) =>
    PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "resolve", description })
  const resolve = (value: string): Effect.Effect<FileSystem.Resolution, PlatformError.PlatformError> => {
    resolutions.push(value)
    const answered = answers.get(value)
    if (answered !== undefined) return Effect.succeed(answered)
    if (value !== "/workspace" && !value.startsWith("/workspace/")) {
      return Effect.fail(refusal("path outside pinned root"))
    }
    const parts = value.split("/").filter((part) => part !== "")
    let current = ""
    for (const [index, part] of parts.entries()) {
      current = `${current}/${part}`
      chain.push(current)
      const entry = entries.get(current)
      const whole = { path: value, target: null }
      if (entry === undefined) return Effect.succeed(whole)
      if (entry.kind === "locked") return Effect.fail(refusal("entry cannot be inspected"))
      if (entry.kind === "mount") return Effect.fail(refusal("untranslatable reparse point"))
      if (entry.kind === "link") return Effect.succeed({ path: current, target: entry.target })
      if (entry.kind === "file" && index < parts.length - 1) return Effect.succeed(whole)
    }
    return Effect.succeed({ path: value, target: null })
  }
  const settle = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
    Effect.ensuring(
      effect,
      Effect.sync(() => {
        const swap = after.get(key)
        after.delete(key)
        swap?.()
      })
    )
  const execute: FileSystem.AtomicFileSystem["execute"] = (request) =>
    request.operation === "resolve"
      ? settle(`resolve:${request.path}`, resolve(request.path)) as never
      : Effect.succeed(new Uint8Array([7])) as never
  // The host answers only the composition-time root pin; authorization never
  // asks it anything by pathname.
  const host = EffectFileSystem.makeNoop({
    realPath: (value) =>
      value === "/workspace" ? Effect.succeed(value) : Effect.die(`host realPath asked about ${value}`),
    readLink: (value) => Effect.die(`host readLink asked about ${value}`),
    stat: () => Effect.die("native executor owns hard-link checks")
  })
  return { after, answers, chain, entries, execute, host, resolutions }
}

const modelEntries = (): Map<string, VolumeEntry> =>
  new Map<string, VolumeEntry>([
    ["/workspace", { kind: "directory" }],
    ["/workspace/a", { kind: "file" }],
    ["/workspace/leaf", { kind: "file" }],
    ["/workspace/dir", { kind: "directory" }],
    ["/workspace/dir/file", { kind: "file" }],
    ["/workspace/pipe", { kind: "link", target: "/device/pipe" }],
    ["/workspace/share", { kind: "link", target: "/remote/share" }],
    ["/workspace/inside", { kind: "link", target: "a" }],
    ["/workspace/hop", { kind: "link", target: "dir" }],
    ["/workspace/loop", { kind: "link", target: "loop" }],
    ["/workspace/locked", { kind: "locked" }],
    ["/workspace/mount", { kind: "mount", target: "/volume" }],
    ["/device", { kind: "directory" }],
    ["/device/pipe", { kind: "file" }],
    ["/remote", { kind: "directory" }],
    ["/remote/share", { kind: "directory" }],
    ["/remote/share/file", { kind: "file" }],
    ["/volume", { kind: "directory" }],
    ["/volume/file", { kind: "file" }]
  ])

/** Runs `body` over the model behind a no-follow executor and a store that allows everything. */
const overModel = (
  volume: ReturnType<typeof modelVolume>,
  body: (
    fs: EffectFileSystem.FileSystem,
    observed: { readonly checks: Array<Capability.Capability>; readonly requests: Array<FileSystem.AtomicRequest> }
  ) => Effect.Effect<void, unknown>
) => {
  const checks: Array<Capability.Capability> = []
  const requests: Array<FileSystem.AtomicRequest> = []
  const host = FileSystem.withAtomicFileSystem(volume.host, {
    noFollowAuthorization: true,
    identifyRoot: () => Effect.succeed("7:9"),
    execute: (request) =>
      Effect.suspend(() => {
        if (request.operation !== "resolve") requests.push(request)
        return volume.execute(request)
      })
  })
  const grants = GrantStore.of({
    ...scriptedStore(new Set(), checks),
    check: (capability) => Effect.sync(() => void checks.push(capability))
  })
  return provide(
    Effect.flatMap(EffectFileSystem.FileSystem, (fs) => body(fs, { checks, requests })),
    host,
    grants
  )
}

const outsideWorkspace = (chain: ReadonlyArray<string>) =>
  chain.filter((path) => path !== "/workspace" && !path.startsWith("/workspace/"))

const refusedAs = (failure: unknown, resource: string, reason: string) =>
  expect(denial(failure)).toMatchObject({
    code: "permission_denied",
    capability: { action: "fs:read", resource },
    reason
  })

itEffect("resolves no-follow executor resources through the executor from the pinned canonical root", () => {
  const checks: Array<Capability.Capability> = []
  const requests: Array<FileSystem.AtomicRequest> = []
  const refusal = PlatformError.systemError({ _tag: "BadResource", module: "test", method: "readFile" })
  const host = FileSystem.withAtomicFileSystem(
    EffectFileSystem.makeNoop({
      realPath: (path) =>
        path === "/workspace" ? Effect.succeed("/canonical") : Effect.die(`host realPath asked about ${path}`),
      readLink: () => Effect.die("host readLink was asked"),
      stat: () => Effect.die("descendant metadata was opened")
    }),
    {
      noFollowAuthorization: true,
      identifyRoot: () => Effect.succeed("7:9"),
      execute: (request) =>
        Effect.suspend(() => {
          requests.push(request)
          if (request.operation === "resolve") return Effect.succeed({ path: request.path, target: null }) as never
          return ("path" in request && request.path.endsWith("/link")
            ? Effect.fail(refusal)
            : Effect.succeed(new Uint8Array([7]))) as Effect.Effect<never, PlatformError.PlatformError>
        })
    }
  )
  return provide(
    Effect.gen(function*() {
      const fs = yield* EffectFileSystem.FileSystem
      expect(yield* fs.readFile("a")).toEqual(new Uint8Array([7]))
      expect(yield* fs.readFile("/canonical/a")).toEqual(new Uint8Array([7]))
      expect(yield* Effect.flip(fs.readFile("link"))).toBe(refusal)
      expect((yield* Effect.exit(fs.readFile("/outside/a")))._tag).toBe("Failure")
      // Each guard resolves twice with one executor request, pinned to the
      // canonical root; a path outside the workspace is never inspected.
      expect(requests.map((request) => `${request.operation} ${"path" in request ? request.path : ""}`)).toEqual([
        "resolve /canonical/a",
        "resolve /canonical/a",
        "readFile /workspace/a",
        "resolve /canonical/a",
        "resolve /canonical/a",
        "readFile /canonical/a",
        "resolve /canonical/link",
        "resolve /canonical/link",
        "readFile /workspace/link"
      ])
      expect(requests.every((request) => request.boundaryRoot === "/canonical")).toBe(true)
      expect(checks).toEqual([
        { action: "fs:read", resource: "/workspace/a" },
        { action: "fs:read", resource: "/workspace/a" },
        { action: "fs:read", resource: "/workspace/link" }
      ])
    }),
    host,
    scriptedStore(new Set(["fs:read:/workspace/a", "fs:read:/workspace/link"]), checks)
  )
})

itEffect("resolves no-follow resources by link text and never opens a link's target", () => {
  // Windows `realpath` opens its argument through every link, so one host call
  // on a planted link to a pipe or share connects to it. The model records
  // every entry the executor inspects, so traversal through a link is visible.
  const volume = modelVolume(modelEntries())
  return overModel(volume, (fs, { checks, requests }) =>
    Effect.gen(function*() {
      refusedAs(yield* Effect.flip(fs.readFile("pipe")), "/device/pipe", "path is outside the workspace")
      refusedAs(yield* Effect.flip(fs.readFile("share/file")), "/remote/share/file", "path is outside the workspace")
      refusedAs(yield* Effect.flip(fs.readFile("loop")), "/workspace/loop", "too many levels of symbolic links")
      expect(yield* fs.readFile("inside")).toEqual(new Uint8Array([7]))
      expect(yield* fs.readFile("hop/file")).toEqual(new Uint8Array([7]))
      expect(yield* fs.readFile("dir/file")).toEqual(new Uint8Array([7]))
      expect(yield* fs.readFile("missing/child")).toEqual(new Uint8Array([7]))
      expect(yield* fs.readFile("a/child")).toEqual(new Uint8Array([7]))
      expect(yield* fs.readFile(".")).toEqual(new Uint8Array([7]))
      expect(outsideWorkspace(volume.chain)).toEqual([])
      expect(checks.map((capability) => capability.resource)).toEqual([
        "/workspace/a",
        "/workspace/dir/file",
        "/workspace/dir/file",
        "/workspace/missing/child",
        "/workspace/a/child",
        "/workspace"
      ])
      expect(requests).toHaveLength(6)
    }))
})

itEffect("asks the executor once per resolution, and again only for a link's target", () => {
  const volume = modelVolume(modelEntries())
  return overModel(volume, (fs) =>
    Effect.gen(function*() {
      expect(yield* fs.readFile("dir/file")).toEqual(new Uint8Array([7]))
      yield* fs.writeFile("dir/new", new Uint8Array([1]))
      expect(volume.resolutions).toEqual([
        "/workspace/dir/file",
        "/workspace/dir/file",
        "/workspace/dir/new",
        "/workspace/dir/new"
      ])
      volume.resolutions.length = 0
      expect(yield* fs.readFile("hop/file")).toEqual(new Uint8Array([7]))
      expect(volume.resolutions).toEqual([
        "/workspace/hop/file",
        "/workspace/dir/file",
        "/workspace/hop/file",
        "/workspace/dir/file"
      ])
    }))
})

itEffect("refuses a no-follow path the executor cannot resolve without following it", () => {
  // A Windows volume mount point is a reparse point whose target is a volume
  // GUID: the executor neither traverses it nor translates it, so the mounted
  // volume is never reached.
  const volume = modelVolume(modelEntries())
  return overModel(volume, (fs, { checks, requests }) =>
    Effect.gen(function*() {
      const reason = "path component could not be inspected without following it"
      refusedAs(yield* Effect.flip(fs.readFile("locked")), "/workspace/locked", reason)
      refusedAs(yield* Effect.flip(fs.readFile("mount/file")), "/workspace/mount/file", reason)
      expect(outsideWorkspace(volume.chain)).toEqual([])
      expect(checks).toEqual([])
      expect(requests).toEqual([])
    }))
})

itEffect("refuses a resolution the executor places outside the pinned root", () => {
  const volume = modelVolume(modelEntries())
  volume.answers.set("/workspace/a", { path: "/elsewhere/a", target: null })
  return overModel(volume, (fs, { checks, requests }) =>
    Effect.gen(function*() {
      refusedAs(yield* Effect.flip(fs.readFile("a")), "/workspace/a", "path resolves outside the pinned root")
      expect(checks).toEqual([])
      expect(requests).toEqual([])
    }))
})

itEffect("#2882: a component swapped to a link between checks never reaches its target", () => {
  // Every question is one descriptor-relative, no-follow executor request, so
  // a swap between two of them is seen as a link and resolved by its text.
  const volume = modelVolume(modelEntries())
  volume.after.set("resolve:/workspace/leaf", () => {
    volume.entries.set("/workspace/leaf", { kind: "link", target: "/device/pipe" })
  })
  volume.after.set("resolve:/workspace/dir/file", () => {
    volume.entries.set("/workspace/dir", { kind: "link", target: "/remote/share" })
  })
  // A link replaced by a file during the decision names another resource.
  volume.after.set("resolve:/workspace/inside", () => {
    volume.entries.set("/workspace/inside", { kind: "file" })
  })
  return overModel(volume, (fs, { checks, requests }) =>
    Effect.gen(function*() {
      const reason = "path is outside the workspace"
      refusedAs(yield* Effect.flip(fs.readFile("leaf")), "/device/pipe", reason)
      refusedAs(yield* Effect.flip(fs.readFile("dir/file")), "/remote/share/file", reason)
      refusedAs(
        yield* Effect.flip(fs.readFile("inside")),
        "/workspace/a",
        "path no longer names the resource that was authorized"
      )
      expect(outsideWorkspace(volume.chain)).toEqual([])
      // Each grant was decided for the resource named before the swap.
      expect(checks.map((capability) => capability.resource)).toEqual([
        "/workspace/leaf",
        "/workspace/dir/file",
        "/workspace/a"
      ])
      expect(requests).toEqual([])
    }))
})

itEffect("authorizes a no-follow batch with one batched resolve before and after its grants", () => {
  const volume = modelVolume(modelEntries())
  volume.entries.set("/workspace/defect", { kind: "file" })
  volume.entries.set("/workspace/dropped", { kind: "file" })
  volume.entries.set("/workspace/flaky", { kind: "file" })
  // Uninspectable once its grant is decided: the settling resolution refuses it.
  volume.after.set("resolve:/workspace/flaky", () => volume.entries.set("/workspace/flaky", { kind: "locked" }))
  const info = { type: "File", dev: 7, ino: Option.some(9) } as EffectFileSystem.File.Info
  const frames: Array<string> = []
  type Member = FileSystem.AtomicBatchResponse["entries"][number]
  const answer = (member: FileSystem.AtomicBatchRequest, index: number): Effect.Effect<Array<Member>> => {
    if (member.path === "/workspace/dropped") return Effect.succeed([])
    const value: Effect.Effect<FileSystem.AtomicBatchValue, PlatformError.PlatformError> =
      member.operation === "resolve"
        ? Effect.map(volume.execute(member), (resolution) => ({ operation: "resolve" as const, resolution }))
        : member.path === "/workspace/defect"
        ? Effect.succeed({ operation: "resolve", resolution: { path: member.path, target: null } })
        : Effect.succeed({ operation: "stat", info })
    return Effect.map(Effect.result(value), (result) => [{ index, path: member.path, result }])
  }
  const host = FileSystem.withAtomicFileSystem(volume.host, {
    noFollowAuthorization: true,
    identifyRoot: () => Effect.succeed("7:9"),
    batchLimits: { size: 128, response: 1024 * 1024 },
    execute: (request) =>
      Effect.suspend(() => {
        if (request.operation !== "batch") {
          frames.push(`${request.operation} ${"path" in request ? request.path : ""}`)
          return volume.execute(request)
        }
        frames.push(`batch ${request.requests.map((member) => member.operation).join(",")}`)
        return Effect.map(
          Effect.forEach(request.requests, answer),
          (entries) => ({ rootIdentity: request.rootIdentity!, entries: entries.flat() })
        ) as never
      })
  })
  const checks: Array<Capability.Capability> = []
  const grants = GrantStore.of({
    ...scriptedStore(new Set(), checks),
    check: (capability) => Effect.sync(() => void checks.push(capability))
  })
  return provide(
    Effect.gen(function*() {
      const batch = FileSystem.batch(yield* EffectFileSystem.FileSystem)!
      const stat = (path: string) => ({ operation: "stat" as const, path })
      const why = (failure: PlatformError.PlatformError) =>
        Option.match(Permission.fromPlatformError(failure), {
          onNone: () => failure.reason.description,
          onSome: (error) => "reason" in error ? error.reason : error.code
        })
      const response = yield* batch.execute(
        ["a", "hop/file", "locked", "/outside/x", "pipe", "defect", "dropped", "flaky"].map(stat)
      )
      const outcome = Object.fromEntries(response.entries.map((entry) => [
        entry.path,
        Result.isSuccess(entry.result)
          ? entry.result.success.operation
          : why(entry.result.failure)
      ]))
      expect(outcome).toEqual({
        "/workspace/a": "stat",
        "/workspace/hop/file": "stat",
        "/workspace/locked": "path component could not be inspected without following it",
        "/outside/x": "path is outside the workspace",
        "/workspace/pipe": "path is outside the workspace",
        "/workspace/defect": "executor answered a batch read with a resolution",
        "/workspace/dropped": "path component could not be inspected without following it",
        "/workspace/flaky": "path component could not be inspected without following it"
      })
      // One batched resolve before the grants and one after; only the link's
      // target is asked again, once per resolution, and one measured batch.
      expect(frames).toEqual([
        "batch resolve,resolve,resolve,resolve,resolve,resolve,resolve",
        "resolve /workspace/dir/file",
        "batch resolve,resolve,resolve,resolve",
        "resolve /workspace/dir/file",
        "batch stat,stat,stat"
      ])
      expect(outsideWorkspace(volume.chain)).toEqual([])
      expect(checks.map((capability) => capability.resource)).toEqual([
        "/workspace/a",
        "/workspace/dir/file",
        "/workspace/defect",
        "/workspace/flaky"
      ])
      frames.length = 0
      const outside = yield* batch.execute([stat("/outside/y")])
      expect(outside.entries).toHaveLength(1)
      expect(frames).toEqual([])
    }),
    host,
    grants
  )
})

itEffect("refuses a case-only resource change during a native grant decision", () => {
  let spelling = "Allowed"
  let executed = false
  const checks: Array<Capability.Capability> = []
  const host = FileSystem.withAtomicFileSystem(
    EffectFileSystem.makeNoop({
      realPath: (value) => Effect.succeed(value),
      readLink: () => Effect.die("host readLink was asked"),
      stat: () => Effect.die("native executor owns hard-link checks")
    }),
    {
      noFollowAuthorization: true,
      identifyRoot: () => Effect.succeed("7:9"),
      execute: (request) =>
        request.operation === "resolve"
          ? Effect.sync(() => ({
            path: request.path === "/workspace/ALLOWED" ? `/workspace/${spelling}` : request.path,
            target: null
          })) as never
          : Effect.sync(() => {
            executed = true
            throw new Error("changed resource reached native executor")
          })
    }
  )
  const grants = GrantStore.of({
    ...scriptedStore(new Set(), checks),
    check: (capability) =>
      Effect.sync(() => {
        checks.push(capability)
        spelling = "allowed"
      })
  })
  return provide(
    Effect.gen(function*() {
      const fs = yield* EffectFileSystem.FileSystem
      const failure = yield* Effect.flip(fs.readFileString("ALLOWED"))
      expect(denial(failure)).toMatchObject({
        code: "permission_denied",
        capability: { action: "fs:read", resource: "/workspace/Allowed" },
        reason: "path no longer names the resource that was authorized"
      })
      expect(checks).toEqual([{ action: "fs:read", resource: "/workspace/Allowed" }])
      expect(executed).toBe(false)
    }),
    host,
    grants
  )
})

describe("FileSystem", () => {
  it("attaches one descriptor-relative executor in place", () => {
    const fileSystem = EffectFileSystem.makeNoop({})
    const executor: FileSystem.AtomicFileSystem = { execute: () => Effect.die("not executed") }

    const decorated = FileSystem.withAtomicFileSystem(fileSystem, executor)

    expect(decorated).toBe(fileSystem)
    expect(decorated[FileSystem.AtomicFileSystemTypeId]).toBe(executor)
  })

  it("lets a caller that read the attached executor layer over it", () => {
    const fileSystem = EffectFileSystem.makeNoop({})
    const delegated: Array<string> = []
    const reached = PlatformError.badArgument({
      module: "FileSystem",
      method: "execute",
      description: "reached the original executor"
    })
    const original: FileSystem.AtomicFileSystem = {
      execute: (request) => {
        delegated.push(request.operation)
        return Effect.fail(reached)
      }
    }
    const decorated = FileSystem.withAtomicFileSystem(fileSystem, original)
    // A host attaches once. A caller that deliberately wraps the executor it
    // read, the way `@smthrs/platform-node`'s swap suite does, keeps that
    // decision explicit, so the attachment itself stays permissive. The wrapper
    // has to capture the executor *before* replacing it: reading the property
    // back afterwards resolves to the wrapper itself and recurs without end.
    const previous = decorated[FileSystem.AtomicFileSystemTypeId]
    const wrapper: FileSystem.AtomicFileSystem = {
      execute: (request) => previous.execute(request)
    }
    const relayered = FileSystem.withAtomicFileSystem(decorated, wrapper)

    expect(relayered[FileSystem.AtomicFileSystemTypeId]).toBe(wrapper)
    // Identity alone would pass for a wrapper that cannot run. Invoking it
    // proves the layering actually delegates, and terminates.
    expect(
      Effect.runSync(
        Effect.flip(
          relayered[FileSystem.AtomicFileSystemTypeId].execute({ operation: "exists", path: "/workspace/a" })
        )
      )
    ).toBe(reached)
    expect(delegated).toEqual(["exists"])
  })

  it("refuses to attest whole-filesystem isolation over a descriptor-relative executor", () => {
    const fileSystem = EffectFileSystem.makeNoop({})
    const original: FileSystem.AtomicFileSystem = { execute: () => Effect.die("not executed") }
    const decorated = FileSystem.withAtomicFileSystem(fileSystem, original)

    expect(() => FileSystem.withIsolatedFileSystem(decorated)).toThrowError(
      "filesystem already carries a descriptor-relative executor; attesting whole-filesystem isolation would replace it"
    )
    expect(decorated[FileSystem.AtomicFileSystemTypeId]).toBe(original)
  })

  itEffect("classifies reads and mutations and normalizes workspace-relative paths", () => {
    const checks: Array<Capability.Capability> = []
    const paths: Array<string> = []
    const host = hostFileSystem({
      stat: (path) =>
        Effect.sync(() => {
          paths.push(path)
          return {} as EffectFileSystem.File.Info
        }),
      writeFile: (path) =>
        Effect.sync(() => {
          paths.push(path)
        }),
      makeDirectory: (path) =>
        Effect.sync(() => {
          paths.push(path)
        })
    })
    const allowed = new Set([
      "fs:read:/workspace/src/file.ts",
      "fs:write:/workspace/out/file.ts",
      "fs:write:/workspace/out"
    ])

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        yield* fileSystem.stat("src/dir/../file.ts")
        yield* fileSystem.writeFile("out/file.ts", new Uint8Array())
        yield* fileSystem.makeDirectory("out")
        expect(checks).toEqual([
          { action: "fs:read", resource: "/workspace/src/file.ts" },
          { action: "fs:write", resource: "/workspace/out/file.ts" },
          { action: "fs:write", resource: "/workspace/out" }
        ])
        // Three host calls per operation: the guard stats the path before the
        // grant decision AND after it (the decision can suspend, so the path
        // must still name what was authorized), then the delegate runs.
        expect(paths).toEqual([
          "/workspace/src/file.ts",
          "/workspace/src/file.ts",
          "/workspace/src/file.ts",
          "/workspace/out/file.ts",
          "/workspace/out/file.ts",
          "/workspace/out/file.ts",
          "/workspace/out",
          "/workspace/out",
          "/workspace/out"
        ])
      }),
      host,
      scriptedStore(allowed, checks)
    )
  })

  itEffect("checks both source and target before copy and rename", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const host = hostFileSystem({
      copy: (from, to) =>
        Effect.sync(() => {
          calls.push(`copy:${from}:${to}`)
        }),
      rename: (from, to) =>
        Effect.sync(() => {
          calls.push(`rename:${from}:${to}`)
        })
    })
    const allowed = new Set([
      "fs:read:/workspace/from",
      "fs:write:/workspace/to",
      "fs:write:/workspace/old",
      "fs:write:/workspace/new"
    ])

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        yield* fileSystem.copy("from", "to")
        yield* fileSystem.rename("old", "new")
        expect(checks).toEqual([
          { action: "fs:read", resource: "/workspace/from" },
          { action: "fs:write", resource: "/workspace/to" },
          { action: "fs:write", resource: "/workspace/old" },
          { action: "fs:write", resource: "/workspace/new" }
        ])
        expect(calls).toEqual(["copy:/workspace/from:/workspace/to", "rename:/workspace/old:/workspace/new"])
      }),
      host,
      scriptedStore(allowed, checks)
    )
  })

  itEffect("preserves relative symlink targets and the Effect filesystem runtime marker", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<readonly [string, string]> = []
    const host = hostFileSystem({
      symlink: (target, path) =>
        Effect.sync(() => {
          calls.push([target, path])
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        expect(fileSystem["~effect/FileSystem"]).toBe("~effect/FileSystem")
        yield* fileSystem.symlink("../target", "links/item")
        expect(checks).toEqual([
          { action: "fs:write", resource: "/workspace/links/item" }
        ])
        expect(calls).toEqual([["../target", "/workspace/links/item"]])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/links/item"]), checks)
    )
  })

  itEffect("normalizes glob patterns relative to their explicit root", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<{ readonly pattern: string; readonly root?: string | undefined }> = []
    const host = hostFileSystem({
      glob: (pattern, options) =>
        Effect.sync(() => {
          calls.push({ pattern, root: options?.root })
          return []
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        yield* fileSystem.glob("**/*.ts", { root: "src" })
        expect(checks).toEqual([{ action: "fs:read", resource: "/workspace/src/**/*.ts" }])
        expect(calls).toEqual([{ pattern: "/workspace/src/**/*.ts", root: "/workspace/src" }])
      }),
      host,
      scriptedStore(new Set(["fs:read:/workspace/src/**/*.ts"]), checks)
    )
  })

  itEffect("names the resolved outside-workspace resource when a glob escapes the root", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<{ readonly pattern: string; readonly root?: string | undefined }> = []
    const host = hostFileSystem({
      glob: (pattern, options) =>
        Effect.sync(() => {
          calls.push({ pattern, root: options?.root })
          return []
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        // An explicit `root` outside the workspace and a pattern that climbs
        // out of it both resolve, and the resolved absolute path is what the
        // store is asked about. A grant written against `/workspace/**` must
        // not silently cover either one.
        yield* fileSystem.glob("**/*.ts", { root: "../outside" })
        yield* fileSystem.glob("../outside/**/*.ts")
        expect(checks).toEqual([
          { action: "fs:read", resource: "/outside/**/*.ts" },
          { action: "fs:read", resource: "/outside/**/*.ts" }
        ])
        expect(calls).toEqual([
          { pattern: "/outside/**/*.ts", root: "/outside" },
          { pattern: "/outside/**/*.ts", root: "/workspace" }
        ])
      }),
      host,
      scriptedStore(new Set(["fs:read:/outside/**/*.ts"]), checks)
    )
  })

  itEffect("short-circuits a denied request before its delegate", () => {
    const checks: Array<Capability.Capability> = []
    let called = false
    const host = hostFileSystem({
      writeFile: () =>
        Effect.sync(() => {
          called = true
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        expect(denial(yield* Effect.flip(fileSystem.writeFile("blocked", new Uint8Array())))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/workspace/blocked" },
          reason: "denied by test"
        })
        expect(called).toBe(false)
        expect(checks).toEqual([{ action: "fs:write", resource: "/workspace/blocked" }])
      }),
      host,
      scriptedStore(new Set(), checks)
    )
  })

  itEffect("checks both handle acquisition and later handle reads", () => {
    const checks: Array<Capability.Capability> = []
    let reads = 0
    const handle: EffectFileSystem.File = {
      [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
      // `open` fstats the handle to bind its authorization; an identity-free
      // Info opts this double out of descriptor verification.
      stat: Effect.succeed({} as EffectFileSystem.File.Info),
      seek: () => Effect.succeed(ByteSize.bytes(0)),
      sync: Effect.void,
      read: () => Effect.sync(() => ++reads),
      readAlloc: () => Effect.succeed(Option.none()),
      truncate: () => Effect.void,
      write: () => Effect.succeed(0),
      writeAll: () => Effect.void
    }
    const host = hostFileSystem({ open: () => Effect.succeed(handle) })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        const file = yield* fileSystem.open("input", { flag: "r" })
        yield* file.read(new Uint8Array())
        expect(reads).toBe(1)
        expect(checks).toEqual([
          { action: "fs:read", resource: "/workspace/input" },
          { action: "fs:read", resource: "/workspace/input" }
        ])
      }).pipe(Effect.scoped),
      host,
      scriptedStore(new Set(["fs:read:/workspace/input"]), checks)
    )
  })

  itEffect("opens with the exact options snapshot approved before an attended wait", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const checks: Array<Capability.Capability> = []
        const delegated: Array<unknown> = []
        const grants = GrantStore.of({
          check: (capability) => {
            checks.push(capability)
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          },
          reply: () => Effect.die("not used by option snapshot test"),
          list: Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
        const handle: EffectFileSystem.File = {
          [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
          stat: Effect.succeed({} as EffectFileSystem.File.Info),
          seek: () => Effect.succeed(ByteSize.bytes(0)),
          sync: Effect.void,
          read: () => Effect.succeed(0),
          readAlloc: () => Effect.succeed(Option.none()),
          truncate: () => Effect.void,
          write: () => Effect.succeed(0),
          writeAll: () => Effect.void
        }
        const host = hostFileSystem({
          open: (_path, options) =>
            Effect.sync(() => {
              delegated.push(options)
              return handle
            })
        })
        const options: { flag: EffectFileSystem.OpenFlag; mode: number } = { flag: "r", mode: 0o400 }
        const running = yield* Effect.gen(function*() {
          const fileSystem = yield* EffectFileSystem.FileSystem
          return yield* fileSystem.open("input", options)
        }).pipe(
          Effect.provide(FileSystem.layer),
          Effect.provideService(EffectFileSystem.FileSystem, host),
          Effect.provide(EffectPath.layer),
          Effect.provide(Workspace.layer("/workspace")),
          Effect.provideService(GrantStore, grants),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(entered)
        options.flag = "w"
        options.mode = 0o777
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(running)

        expect(checks).toEqual([{ action: "fs:read", resource: "/workspace/input" }])
        expect(delegated).toEqual([{ flag: "r", mode: 0o400 }])
      })
    ))

  itEffect("snapshots nested glob and remove options before permission checks", () => {
    const globOptions: { root: string; exclude: Array<string> } = { root: "src", exclude: ["safe/**"] }
    class RemoveOptions {
      recursive = false
      force = false
    }
    const removeOptions = new RemoveOptions()
    Object.defineProperty(removeOptions, "hidden", { enumerable: false, value: "ignored" })
    const calls: Array<unknown> = []
    const grants = GrantStore.of({
      check: (capability) =>
        Effect.sync(() => {
          if (capability.action === "fs:read") {
            globOptions.root = "outside"
            globOptions.exclude[0] = "unsafe/**"
          } else {
            removeOptions.recursive = true
            removeOptions.force = true
          }
        }),
      reply: () => Effect.die("not used by option snapshot test"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const host = hostFileSystem({
      glob: (_pattern, options) =>
        Effect.sync(() => {
          calls.push(options)
          return []
        }),
      remove: (_path, options) =>
        Effect.sync(() => {
          calls.push(options)
        })
    })

    return Effect.gen(function*() {
      const fileSystem = yield* EffectFileSystem.FileSystem
      yield* fileSystem.glob("**/*.ts", globOptions)
      yield* fileSystem.remove("output", removeOptions)
      expect(calls).toEqual([
        { root: "/workspace/src", exclude: ["safe/**"] },
        { recursive: false, force: false }
      ])
    }).pipe(
      Effect.provide(FileSystem.layer),
      Effect.provideService(EffectFileSystem.FileSystem, host),
      Effect.provide(EffectPath.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, grants)
    )
  })

  itEffect("rejects accessor-backed filesystem options without invoking them", () => {
    let calls = 0
    const options = Object.defineProperty({}, "recursive", {
      enumerable: true,
      get: () => {
        calls += 1
        return true
      }
    })
    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        const exit = yield* fileSystem.remove("output", options).pipe(Effect.exit)
        if (exit._tag === "Success") throw new Error("accessor-backed options unexpectedly succeeded")
        expect(String(exit.cause)).toContain("data properties")
        expect(calls).toBe(0)
      }),
      hostFileSystem({}),
      scriptedStore(new Set(), [])
    )
  })

  itEffect("rechecks dynamic authority before every read and write on an open handle", () => {
    const checks: Array<Capability.Capability> = []
    let allowed = true
    let reads = 0
    let writes = 0
    const grants = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return allowed
          ? Effect.void
          : Effect.fail(Permission.permissionDenied(capability, "authority changed"))
      },
      reply: () => Effect.die("not used by filesystem decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const handle: EffectFileSystem.File = {
      [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
      // `open` fstats the handle to bind its authorization; an identity-free
      // Info opts this double out of descriptor verification.
      stat: Effect.succeed({} as EffectFileSystem.File.Info),
      seek: () => Effect.succeed(ByteSize.bytes(0)),
      sync: Effect.void,
      read: () => Effect.sync(() => ++reads),
      readAlloc: () => Effect.succeed(Option.none()),
      truncate: () => Effect.void,
      write: () => Effect.sync(() => ++writes),
      writeAll: () => Effect.void
    }
    const host = hostFileSystem({ open: () => Effect.succeed(handle) })

    return provide(
      Effect.scoped(
        Effect.gen(function*() {
          const fileSystem = yield* EffectFileSystem.FileSystem
          const file = yield* fileSystem.open("dynamic", { flag: "w+" })
          allowed = false

          expect(denial(yield* Effect.flip(file.read(new Uint8Array(1))))).toMatchObject({
            capability: { action: "fs:read", resource: "/workspace/dynamic" },
            reason: "authority changed"
          })
          expect(denial(yield* Effect.flip(file.write(new Uint8Array(1))))).toMatchObject({
            capability: { action: "fs:write", resource: "/workspace/dynamic" },
            reason: "authority changed"
          })
          expect(reads).toBe(0)
          expect(writes).toBe(0)
          expect(checks.map((check) => check.action)).toEqual([
            "fs:read",
            "fs:write",
            "fs:read",
            "fs:write"
          ])
        })
      ),
      host,
      grants
    )
  })

  itEffect("checks a stream lazily, before the host stream is acquired", () => {
    const checks: Array<Capability.Capability> = []
    let acquired = false
    const host = hostFileSystem({
      stream: () =>
        Stream.succeed(new Uint8Array([1])).pipe(Stream.tap(() =>
          Effect.sync(() => {
            acquired = true
          })
        ))
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        const stream = fileSystem.stream("lazy")
        expect(checks).toEqual([])
        expect(acquired).toBe(false)
        yield* Stream.runDrain(stream)
        expect(checks).toEqual([{ action: "fs:read", resource: "/workspace/lazy" }])
        expect(acquired).toBe(true)
      }),
      host,
      scriptedStore(new Set(["fs:read:/workspace/lazy"]), checks)
    )
  })

  itEffect("uses the canonical target when an inside-workspace symlink escapes", () => {
    const checks: Array<Capability.Capability> = []
    let invoked = false
    const host = hostFileSystem({
      realPath: (path) => Effect.succeed(path === "/workspace/link" ? "/outside/secret" : path),
      stat: () =>
        Effect.succeed({
          type: "File",
          nlink: Option.none()
        } as unknown as EffectFileSystem.File.Info),
      readFile: () =>
        Effect.sync(() => {
          invoked = true
          return new Uint8Array()
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        expect(denial(yield* Effect.flip(fileSystem.readFile("link")))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:read", resource: "/outside/secret" },
          reason: "denied by test"
        })
        expect(invoked).toBe(false)
        expect(checks).toEqual([{ action: "fs:read", resource: "/outside/secret" }])
      }),
      host,
      scriptedStore(new Set(["fs:read:/workspace/**"]), checks)
    )
  })

  itEffect("does not check symlink's `from`, and denies a later read through the link", () => {
    // `FileSystem.ts:321-323` guards only `to` on `symlink`, so creating a link
    // that points outside the workspace is permitted. The composed argument
    // that makes the unchecked `from` safe was never written down as a test:
    // every later access resolves through `canonicalResource`, which follows
    // existing symlinks BEFORE the capability check, so reading through the
    // link requires authority over the real target. The gap is closed at
    // access time, not at creation time.
    const checks: Array<Capability.Capability> = []
    let linked: { readonly from: string; readonly to: string } | undefined
    let read = false
    const host = hostFileSystem({
      symlink: (from, to) =>
        Effect.sync(() => {
          linked = { from, to }
        }),
      // The link does not exist until `symlink` creates it, so canonical
      // resolution only starts following it afterwards.
      realPath: (path) =>
        Effect.succeed(path === "/workspace/escape" && linked !== undefined ? "/outside/secret" : path),
      stat: () =>
        Effect.succeed({
          type: "File",
          nlink: Option.none()
        } as unknown as EffectFileSystem.File.Info),
      readFile: () =>
        Effect.sync(() => {
          read = true
          return new Uint8Array()
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        // Creating the link succeeds: only `to` is checked, and it is inside.
        yield* fileSystem.symlink("/outside/secret", "escape")
        expect(linked).toEqual({ from: "/outside/secret", to: "/workspace/escape" })
        expect(checks).toEqual([{ action: "fs:write", resource: "/workspace/escape" }])

        // Reading through it is denied against the REAL target, which the
        // workspace grant does not cover.
        expect(denial(yield* Effect.flip(fileSystem.readFile("escape")))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:read", resource: "/outside/secret" }
        })
        expect(read).toBe(false)
        expect(checks[1]).toEqual({ action: "fs:read", resource: "/outside/secret" })
      }),
      host,
      // Authority over the workspace path only. Nothing grants
      // `fs:read:/outside/secret`, which is what the read resolves to.
      scriptedStore(new Set(["fs:write:/workspace/escape", "fs:read:/workspace/escape"]), checks)
    )
  })

  itEffect("resolves a dangling symlink before an outside write creates its target", () => {
    const checks: Array<Capability.Capability> = []
    let invoked = false
    const host = hostFileSystem({
      realPath: (path) =>
        path === "/workspace/link"
          ? Effect.fail(
            new Error("dangling link") as unknown as PlatformError.PlatformError
          )
          : Effect.succeed(path),
      readLink: (path) =>
        path === "/workspace/link"
          ? Effect.succeed("/outside/new-file")
          : Effect.fail(
            new Error("not a link") as unknown as PlatformError.PlatformError
          ),
      writeFile: () =>
        Effect.sync(() => {
          invoked = true
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        expect(denial(yield* Effect.flip(fileSystem.writeFile("link", new Uint8Array())))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/outside/new-file" },
          reason: "denied by test"
        })
        expect(invoked).toBe(false)
        expect(checks).toEqual([{ action: "fs:write", resource: "/outside/new-file" }])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/**"]), checks)
    )
  })

  itEffect("fails closed for a pre-existing hard link", () => {
    const checks: Array<Capability.Capability> = []
    let invoked = false
    const host = hostFileSystem({
      stat: () =>
        Effect.succeed({
          type: "File",
          nlink: Option.some(2)
        } as unknown as EffectFileSystem.File.Info),
      writeFile: () =>
        Effect.sync(() => {
          invoked = true
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        expect(denial(yield* Effect.flip(fileSystem.writeFile("linked", new Uint8Array())))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/workspace/linked" },
          reason: "hard-linked files cannot be confined to the workspace"
        })
        expect(invoked).toBe(false)
        expect(checks).toEqual([])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/linked"]), checks)
    )
  })
})

describe("FileSystem binary writes", () => {
  const bytes = (length: number) => {
    const data = new Uint8Array(length)
    for (let index = 0; index < length; index++) data[index] = index % 251
    return data
  }
  const stat = () =>
    Effect.succeed({
      type: "File",
      nlink: Option.none(),
      ino: Option.none()
    } as unknown as EffectFileSystem.File.Info)

  itEffect("hands an isolated host the detached bytes without a serialized round trip", () => {
    const checks: Array<Capability.Capability> = []
    const requests: Array<FileSystem.AtomicRequest> = []
    let written: { readonly path: string; readonly data: Uint8Array } | undefined
    const inner = EffectFileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      stat,
      writeFile: (path, data) =>
        Effect.sync(() => {
          written = { path, data }
        })
    })
    const attested = FileSystem.withIsolatedFileSystem(inner)[FileSystem.AtomicFileSystemTypeId]
    const host = FileSystem.withAtomicFileSystem(inner, {
      ...attested,
      execute: (request) => {
        requests.push(request)
        return attested.execute(request)
      }
    })
    const source = bytes(256 * 1024)

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        yield* fileSystem.writeFile("artifact.bin", source)
        expect(written?.path).toBe("/workspace/artifact.bin")
        expect(written?.data).toEqual(source)
        // The snapshot is detached: later mutation of the caller's buffer
        // cannot reach what the host received.
        expect(written?.data).not.toBe(source)
        // An isolated host shares this address space, so no base64 request
        // crosses a serialization boundary to reach it.
        expect(requests.map((request) => request.operation)).not.toContain("writeFile")
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/artifact.bin"]), checks)
    )
  })

  itEffect("still honors a serialized writeFile request reaching an isolated executor", () => {
    let written: { readonly path: string; readonly data: Uint8Array } | undefined
    const host = FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      writeFile: (path, data) =>
        Effect.sync(() => {
          written = { path, data }
        })
    }))
    const source = bytes(64)

    // A caller holding the executor directly can still cross the serialized
    // boundary; the kernel fast path does not remove that contract.
    return Effect.gen(function*() {
      yield* host[FileSystem.AtomicFileSystemTypeId].execute({
        operation: "writeFile",
        path: "/workspace/artifact.bin",
        data: Encoding.encodeBase64(source)
      })
      expect(written).toEqual({ path: "/workspace/artifact.bin", data: source })
    })
  })

  itEffect("base64-encodes the detached bytes for an executor without an isolated surface", () => {
    const checks: Array<Capability.Capability> = []
    const requests: Array<FileSystem.AtomicRequest> = []
    const host = FileSystem.withAtomicFileSystem(
      EffectFileSystem.makeNoop({
        realPath: (path) => Effect.succeed(path),
        stat
      }),
      {
        execute: (request) =>
          Effect.sync(() => {
            requests.push(request)
          }) as Effect.Effect<never>
      }
    )
    const source = bytes(1024)

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        yield* fileSystem.writeFile("artifact.bin", source)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          operation: "writeFile",
          path: "/workspace/artifact.bin",
          data: Encoding.encodeBase64(source)
        })
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/artifact.bin"]), checks)
    )
  })

  itEffect("refuses a payload over the advertised content limit before the executor runs", () => {
    const checks: Array<Capability.Capability> = []
    const requests: Array<FileSystem.AtomicRequest> = []
    const host = FileSystem.withAtomicFileSystem(
      EffectFileSystem.makeNoop({
        realPath: (path) => Effect.succeed(path),
        stat
      }),
      {
        contentLimit: 1024,
        execute: (request) =>
          Effect.sync(() => {
            requests.push(request)
          }) as Effect.Effect<never>
      }
    )

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* EffectFileSystem.FileSystem
        // One byte over the advertised limit is a typed BadArgument, not a
        // RangeError defect out of the base64 encoder.
        const error = yield* Effect.flip(fileSystem.writeFile("artifact.bin", bytes(1025)))
        expect(error).toMatchObject({ reason: { _tag: "BadArgument", method: "writeFile" } })
        expect((error as PlatformError.PlatformError).message).toContain("1025")
        expect(requests).toEqual([])
        expect(checks).toEqual([])
        // The limit itself still fits.
        yield* fileSystem.writeFile("artifact.bin", bytes(1024))
        expect(requests.map((request) => request.operation)).toEqual(["writeFile"])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/artifact.bin"]), checks)
    )
  })
})
