import { NodeServices } from "@effect/platform-node"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Plan from "@smthrs/plan/Plan"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import { type JournalEntry, layerMemory } from "./MemoryFlowRuntime.ts"

const platform = { os: "linux", arch: "x64", libc: null }

/** A runtime that reports a fixed version and satisfies its own declaration. */
const runtimeService = (
  options: { readonly requirement?: string; readonly version?: string } = {}
): Runtime.Service =>
  Runtime.makeNoop("node", {
    requirement: options.requirement ?? ">=22.19.0",
    version: options.version ?? "24.9.0",
    platform
  })

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-install-")))
  try {
    await Fs.writeFile(NodePath.join(root, "package.json"), "{}\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const installContent = async (root: string): Promise<Install.Content> => ({
  lockfile: {
    path: "pnpm-lock.yaml",
    digest: await Effect.runPromise(
      PackageManager.lockfileDigest(root, "pnpm-lock.yaml").pipe(Effect.provide(NodeServices.layer))
    )
  },
  npmrc: null,
  pnpmfile: null,
  workspace: null
})

interface ManagerOptions {
  readonly root: string
  readonly evidence: PackageManager.Digest
  readonly requirement?: string
  readonly version?: string
  readonly storeDirectory?: string
  readonly lockfileName?: string
  readonly name?: PackageManager.Name
  readonly platformSensitive?: boolean
  readonly onFetch?: () => void
  readonly onLink?: () => void
  readonly onVersionRead?: () => void
}

const managerService = (options: ManagerOptions): PackageManager.Service => {
  const requirement = options.requirement ?? "11.21.0"
  const version = Effect.sync(() => {
    options.onVersionRead?.()
    return options.version ?? "11.21.0"
  })
  const name = options.name ?? "pnpm"
  return {
    name,
    projectRoot: options.root,
    storeDirectory: options.storeDirectory ?? `.flows/store/${name}`,
    lockfileName: options.lockfileName ?? (name === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"),
    platformSensitive: options.platformSensitive ?? true,
    requirement,
    version,
    verify: Effect.flatMap(version, (measured) =>
      Runtime.satisfies(requirement, measured) === true
        ? Effect.succeed(measured)
        : Effect.fail(
          new PackageManager.PackageManagerError({
            code: "environment_mismatch",
            message: `this host runs pnpm ${measured}, and the workspace declares ${requirement}`
          })
        )),
    fetch: Effect.sync(() => {
      options.onFetch?.()
    }),
    link: Effect.sync(() => {
      options.onLink?.()
    }),
    linkManifest: Effect.succeed(options.evidence)
  }
}

const packageJsonDigest = (root: string) =>
  Effect.runPromise(PackageManager.packageJsonDigest(root).pipe(Effect.provide(NodeServices.layer)))

describe("Install", () => {
  it("refuses an optional input it cannot inspect while measuring", async () => {
    await withFixture(async (root) => {
      const real = await Effect.runPromise(
        Effect.gen(function*() {
          return yield* FileSystem.FileSystem
        }).pipe(Effect.provide(NodeServices.layer))
      )
      const evidence = await packageJsonDigest(root)
      for (const name of [".pnpmfile.cjs", "pnpm-workspace.yaml"]) {
        const fileSystem: FileSystem.FileSystem = {
          ...real,
          exists: (path) =>
            path.endsWith(`/${name}`)
              ? Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "exists",
                pathOrDescriptor: path
              }))
              : real.exists(path)
        }
        const error = await Effect.runPromise(
          Install.executeMeasure().pipe(
            Effect.flip,
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provide(NodeServices.layer),
            Effect.provideService(PackageManager.PackageManager, managerService({ root, evidence }))
          )
        )
        expect(error.code, name).toBe("manifest_unreadable")
        expect(error.message, name).toBe(`cannot inspect ${name}`)
      }
    })
  })

  it("treats an unreadable measured input as drift before fetching", async () => {
    await withFixture(async (root) => {
      const content = await installContent(root)
      await Fs.rm(NodePath.join(root, "pnpm-lock.yaml"))
      let fetches = 0
      const error = await Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            PackageManager.PackageManager,
            managerService({
              root,
              evidence: await packageJsonDigest(root),
              onFetch: () => {
                fetches += 1
              }
            })
          ),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )
      expect(error.code).toBe("input_drift")
      expect(error.message).toContain("pnpm-lock.yaml")
      expect(fetches).toBe(0)
    })
  })

  for (const path of ["pnpm-lock.yaml", ".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"]) {
    for (const phase of ["fetch", "link"] as const) {
      for (const timing of ["before", "during"] as const) {
        it(`refuses ${path} drift ${timing} ${phase}`, async () => {
          await withFixture(async (root) => {
            const evidence = await packageJsonDigest(root)
            const initial = managerService({ root, evidence })
            const provide = <A, E>(
              effect: Effect.Effect<
                A,
                E,
                | PackageManager.PackageManager
                | Runtime.Runtime
                | FileSystem.FileSystem
                | Crypto.Crypto
              >,
              service = initial
            ) =>
              effect.pipe(
                Effect.provide(NodeServices.layer),
                Effect.provideService(PackageManager.PackageManager, service),
                Effect.provideService(Runtime.Runtime, runtimeService())
              )
            const content = await Effect.runPromise(provide(Install.executeMeasure()))
            const store = await Effect.runPromise(provide(Install.executeFetch({ content })))
            const mutate = () =>
              Fs.writeFile(
                NodePath.join(root, path),
                path === ".npmrc" ? "registry=https://changed.example/\n" : "changed\n"
              )
            let calls = 0
            const operation = Effect.promise(async () => {
              calls++
              if (timing === "during") await mutate()
            })
            const service = { ...initial, [phase]: operation }
            if (timing === "before") await mutate()
            const error = await Effect.runPromise(provide(
              (phase === "fetch"
                ? Install.executeFetch({ content }).pipe(Effect.asVoid)
                : Install.executeLink({ content, store }).pipe(Effect.asVoid)).pipe(Effect.flip),
              service
            ))
            expect(error).toMatchObject({ _tag: "smithers-build/PackageManagerError", code: "input_drift" })
            expect(error.message).toContain(path)
            expect(calls).toBe(timing === "before" ? 0 : 1)
          })
        })
      }
    }
  }

  it("withholds the link manifest when package.json changes during linking", async () => {
    await withFixture(async (root) => {
      const content = await installContent(root)
      const service = managerService({ root, evidence: await packageJsonDigest(root) })
      const store = await Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )
      const error = await Effect.runPromise(
        Install.executeLink({ content, store }).pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, {
            ...service,
            link: Effect.promise(() => Fs.writeFile(NodePath.join(root, "package.json"), "{\"name\":\"changed\"}"))
          }),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )
      expect(error.code).toBe("input_drift")
      expect(error.message).toContain("package.json")
    })
  })

  it("withholds the link manifest when package.json disappears during linking", async () => {
    await withFixture(async (root) => {
      const content = await installContent(root)
      const evidence = await packageJsonDigest(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "11.21.0",
          platform,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )
      let links = 0
      const service = {
        ...managerService({ root, evidence }),
        link: Effect.promise(async () => {
          links += 1
          await Fs.rm(NodePath.join(root, "package.json"))
        })
      }
      const error = await Effect.runPromise(
        Install.executeLink({ content, store }).pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )
      expect(error.code).toBe("input_drift")
      expect(error.message).toBe("install input package.json changed since measurement or could not be reverified")
      expect(links).toBe(1)
    })
  })

  it("measures pnpm hook and workspace files and binds each to the store identity", async () => {
    await withFixture(async (root) => {
      const service = managerService({ root, evidence: await packageJsonDigest(root) })
      const measure = () =>
        Effect.runPromise(
          Install.executeMeasure().pipe(
            Effect.provide(NodeServices.layer),
            Effect.provideService(PackageManager.PackageManager, service)
          )
        )
      const fetch = (content: Install.Content) =>
        Effect.runPromise(
          Install.executeFetch({ content }).pipe(
            Effect.provide(NodeServices.layer),
            Effect.provideService(PackageManager.PackageManager, service),
            Effect.provideService(Runtime.Runtime, runtimeService())
          )
        )
      const empty = await measure()
      const baseline = await fetch(empty)
      for (const [field, path] of [["pnpmfile", ".pnpmfile.cjs"], ["workspace", "pnpm-workspace.yaml"]] as const) {
        await Fs.writeFile(NodePath.join(root, path), "first\n")
        const first = await measure()
        expect(first[field]).toEqual({
          path,
          digest: await Effect.runPromise(
            PackageManager.lockfileDigest(root, path).pipe(Effect.provide(NodeServices.layer))
          )
        })
        const firstStore = await fetch(first)
        expect(firstStore.digest).not.toBe(baseline.digest)
        await Fs.writeFile(NodePath.join(root, path), "second\n")
        expect((await fetch(await measure())).digest).not.toBe(firstStore.digest)
        await Fs.unlink(NodePath.join(root, path))
      }
    })
  })

  it("plans the non-restorable link honestly instead of declaring it cacheable or compensable", async () => {
    expect(Install.Link.tier).toBe("irreversible")
    for (const manager of ["pnpm"] as const) {
      const nodes = Graph.drafts(Graph.build(Install.Install, { manager }))
      const plan = await Effect.runPromise(
        Plan.compile({ planId: `install-${manager}`, flow: Install.Install._tag, nodes })
          .pipe(Effect.provide(NodeServices.layer))
      )
      const links = plan.nodes.filter((node) => node.material.kind === "irreversible")
      expect(links).toHaveLength(1)
      for (const path of ["node_modules", "node_modules/dep/index.js", "packages/child/node_modules/dep/index.js"]) {
        expect(
          links[0]!.effects.writes.some((entry) =>
            FileSet.expand([entry]).some((write) => FileSet.overlaps(write, path))
          )
        ).toBe(true)
      }
      expect(
        await Effect.runPromise(Plan.verify(JSON.parse(JSON.stringify(plan))).pipe(Effect.provide(NodeServices.layer)))
      ).toEqual(plan)
    }
  })

  it("keeps every absolute-root package-manager action out of the shared cache", () => {
    for (const action of [Install.FetchPnpm]) {
      expect(Context.getUnsafe(action.annotations, Flow.EffectsDeclaration).boundaryMode).toBe("expected")
    }
  })

  it("refuses a Bun install in the payload, before any action is planned", () => {
    const payload = Schema.Struct(Install.payloadFields)
    expect(Schema.decodeUnknownSync(payload)({ manager: "pnpm" })).toEqual({ manager: "pnpm" })
    expect(() => Schema.decodeUnknownSync(payload)({ manager: "bun" })).toThrow()
    expect("FetchBun" in Install).toBe(false)
  })

  it("runs one round: the declared manager selects the fetch without a handoff", () => {
    expect(Install.Install.maxRounds).toBe(1)
  })

  it("always reconciles node_modules instead of trusting a freshness marker", async () => {
    await withFixture(async (root) => {
      await Fs.mkdir(NodePath.join(root, "node_modules"))
      await Fs.writeFile(
        NodePath.join(root, "node_modules/.flows-link.json"),
        JSON.stringify({ store: "0".repeat(64), manifest: "1".repeat(64), linked: false }),
        "utf8"
      )
      let fetches = 0
      let links = 0
      const evidence = "a".repeat(64) as PackageManager.Digest
      const service = managerService({
        root,
        evidence,
        onFetch: () => {
          fetches += 1
        },
        onLink: () => {
          links += 1
        }
      })
      const content = await installContent(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "11.21.0",
          platform,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )

      const link = () =>
        Install.executeLink({ content, store }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      const manifest = await Effect.runPromise(
        PackageManager.linkedTreeManifest({
          storeDigest: store.digest,
          packageJsonDigest: await packageJsonDigest(root),
          managerEvidence: evidence
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(evidence).not.toBe(await packageJsonDigest(root))
      const expected = { store: store.digest, manifest, linked: true }
      expect(await Effect.runPromise(link())).toEqual(expected)
      expect(await Effect.runPromise(link())).toEqual(expected)
      expect(fetches).toBe(0)
      expect(links).toBe(2)
    })
  })

  it("refuses a host manager that does not satisfy the declared version", async () => {
    await withFixture(async (root) => {
      let fetched = false
      const evidence = await packageJsonDigest(root)
      const service = managerService({
        root,
        evidence,
        requirement: "11.21.0",
        version: "10.11.0",
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/this host runs pnpm 10\.11\.0, and the workspace declares 11\.21\.0/)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a host runtime that does not satisfy the declared version", async () => {
    await withFixture(async (root) => {
      let fetched = false
      const evidence = await packageJsonDigest(root)
      const service = managerService({
        root,
        evidence,
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService({ requirement: ">=24.0.0", version: "22.19.0" }))
        )
      )).rejects.toThrow(/this host runs node 22\.19\.0, and the workspace declares >=24\.0\.0/)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a manager pointed at a shared host store outside the declared boundary", async () => {
    await withFixture(async (root) => {
      let fetched = false
      const service = managerService({
        root,
        evidence: "0".repeat(64) as PackageManager.Digest,
        storeDirectory: "/var/cache/smthrs/pnpm",
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/install Flow boundary requires pnpm-lock\.yaml and \.flows\/store\/pnpm/)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a manager whose paths disagree with the declared Flow boundary", async () => {
    await withFixture(async (root) => {
      let versionRead = false
      let fetched = false
      const service = managerService({
        root,
        evidence: "0".repeat(64) as PackageManager.Digest,
        storeDirectory: ".flows/store/elsewhere",
        lockfileName: "nested/pnpm-lock.yaml",
        onVersionRead: () => {
          versionRead = true
        },
        onFetch: () => {
          fetched = true
        }
      })
      const content = await installContent(root)

      await expect(Effect.runPromise(
        Install.executeFetch({ content }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/install Flow boundary requires/)
      expect(versionRead).toBe(false)
      expect(fetched).toBe(false)
    })
  })

  it("refuses a store fetched by a different manager version", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = managerService({ root, evidence })
      const content = await installContent(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "10.0.0",
          platform,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )

      await expect(Effect.runPromise(
        Install.executeLink({ content, store }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )).rejects.toThrow(/fetched store does not match this host/)
    })
  })

  it("checks fetched manager and every platform component before linking", async () => {
    await withFixture(async (root) => {
      const content = await installContent(root)
      let links = 0
      const evidence = await packageJsonDigest(root)
      for (
        const tc of [
          { manager: "bun", platform },
          { manager: "pnpm", platform: { ...platform, os: "darwin" } },
          { manager: "pnpm", platform: { ...platform, arch: "arm64" } },
          { manager: "pnpm", platform: { ...platform, libc: "musl" } },
          { manager: "pnpm", platform: null },
          { manager: "pnpm", platform, platformSensitive: false }
        ] as const
      ) {
        const store = await Effect.runPromise(
          PackageManager.storeManifest({
            manager: tc.manager,
            managerVersion: "11.21.0",
            platform: tc.platform,
            lockfileDigest: content.lockfile.digest,
            npmrcDigest: null
          }).pipe(Effect.provide(NodeServices.layer))
        )
        const error = await Effect.runPromise(
          Install.executeLink({ content, store }).pipe(
            Effect.flip,
            Effect.provide(NodeServices.layer),
            Effect.provideService(
              PackageManager.PackageManager,
              managerService({
                root,
                evidence,
                platformSensitive: "platformSensitive" in tc ? tc.platformSensitive : true,
                onLink: () => {
                  links += 1
                }
              })
            ),
            Effect.provideService(Runtime.Runtime, runtimeService())
          )
        )
        expect(error.code, JSON.stringify(tc)).toBe("environment_mismatch")
        expect(error.message).toBe("the fetched store does not match this host")
      }
      expect(links).toBe(0)
    })
  })

  it("links a platform-independent store without inventing a host platform", async () => {
    await withFixture(async (root) => {
      const content = await installContent(root)
      const evidence = await packageJsonDigest(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "11.21.0",
          platform: null,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )
      let links = 0
      const result = await Effect.runPromise(
        Install.executeLink({ content, store }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            PackageManager.PackageManager,
            managerService({
              root,
              evidence,
              platformSensitive: false,
              onLink: () => {
                links += 1
              }
            })
          ),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )
      )
      expect(result.store).toBe(store.digest)
      expect(result.linked).toBe(true)
      expect(links).toBe(1)
    })
  })

  it("preserves manager operation failures and does not read link evidence after a failed link", async () => {
    await withFixture(async (root) => {
      const content = await installContent(root)
      const evidence = await packageJsonDigest(root)
      const store = await Effect.runPromise(
        PackageManager.storeManifest({
          manager: "pnpm",
          managerVersion: "11.21.0",
          platform,
          lockfileDigest: content.lockfile.digest,
          npmrcDigest: null
        }).pipe(Effect.provide(NodeServices.layer))
      )
      const failure = new PackageManager.PackageManagerError({
        code: "command_failed",
        message: "package manager stopped"
      })
      let evidenceReads = 0
      const service = {
        ...managerService({ root, evidence }),
        fetch: Effect.fail(failure),
        link: Effect.fail(failure),
        linkManifest: Effect.sync(() => {
          evidenceReads += 1
          return evidence
        })
      }
      const provide = <A>(
        operation: Effect.Effect<
          A,
          PackageManager.PackageManagerError,
          PackageManager.PackageManager | Runtime.Runtime | FileSystem.FileSystem | Crypto.Crypto
        >
      ) =>
        operation.pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service),
          Effect.provideService(Runtime.Runtime, runtimeService())
        )

      expect(await Effect.runPromise(provide(Install.executeFetch({ content })))).toBe(failure)
      expect(await Effect.runPromise(provide(Install.executeLink({ content, store })))).toBe(failure)
      expect(evidenceReads).toBe(0)
    })
  })

  it("measures content only, no manager version and no platform", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = managerService({ root, evidence })
      const measured = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      )
      expect(Object.keys(measured).sort()).toEqual(["lockfile", "npmrc", "pnpmfile", "workspace"])
      expect(measured.lockfile.path).toBe("pnpm-lock.yaml")
      expect(measured.lockfile.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(measured.npmrc).toBe(null)
    })
  })

  it("reports the .npmrc alongside the lockfile when a project has one", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/\n", "utf8")
      const evidence = await packageJsonDigest(root)
      const measured = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, managerService({ root, evidence }))
        )
      )
      expect(measured.npmrc?.path).toBe(".npmrc")
      expect(measured.npmrc?.digest).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  it("refuses to measure through a layer whose paths disagree with the Flow boundary", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const error = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            PackageManager.PackageManager,
            managerService({ root, evidence, lockfileName: "nested/pnpm-lock.yaml" })
          )
        )
      )
      expect(error.code).toBe("environment_mismatch")
      expect(error.message).toMatch(/install Flow boundary requires/)
    })
  })

  /**
   * `content` is in Link's payload because it is key material the
   * implementation is supposed to honour, and the implementation destructured
   * only `store`. A manifest fetched from another lockfile on the same host
   * passed every check and produced a LinkManifest attesting to content the
   * tree was never built from.
   */
  it("refuses a store fetched for a different lockfile or a different .npmrc", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = managerService({ root, evidence })
      const content = await installContent(root)
      const foreign = async (overrides: {
        readonly lockfileDigest?: string
        readonly npmrcDigest?: string | null
      }) =>
        Effect.runPromise(
          PackageManager.storeManifest({
            manager: "pnpm",
            managerVersion: "11.21.0",
            platform,
            lockfileDigest: overrides.lockfileDigest ?? content.lockfile.digest,
            npmrcDigest: overrides.npmrcDigest ?? null
          }).pipe(Effect.provide(NodeServices.layer))
        )

      for (
        const store of [
          await foreign({ lockfileDigest: "f".repeat(64) }),
          await foreign({ npmrcDigest: "e".repeat(64) })
        ]
      ) {
        const error = await Effect.runPromise(
          Install.executeLink({ content, store }).pipe(
            Effect.flip,
            Effect.provide(NodeServices.layer),
            Effect.provideService(PackageManager.PackageManager, service),
            Effect.provideService(Runtime.Runtime, runtimeService())
          )
        )
        expect(error.code).toBe("environment_mismatch")
        expect(error.message).toMatch(/this project's measured content is/)
      }
    })
  })

  /**
   * A manager whose fetch does not vary by platform drops the platform out of
   * its key material, so the store manifest it reports carries `null` there and
   * the digest differs from the platform-sensitive one for the same content.
   */
  it("keeps the platform out of a platform-independent manager's store manifest", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/\n", "utf8")
      const evidence = await packageJsonDigest(root)
      const content = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, managerService({ root, evidence }))
        )
      )
      expect(content.npmrc).not.toBe(null)

      const events: Array<string> = []
      const fetched = (platformSensitive: boolean) =>
        Effect.runPromise(
          Install.executeFetch({ content }).pipe(
            Effect.provide(NodeServices.layer),
            Effect.provideService(
              PackageManager.PackageManager,
              managerService({
                root,
                evidence,
                platformSensitive,
                requirement: ">=11.0.0",
                version: "11.21.3",
                onVersionRead: () => {
                  events.push("version")
                },
                onFetch: () => {
                  events.push("fetch")
                }
              })
            ),
            Effect.provideService(Runtime.Runtime, runtimeService())
          )
        )
      const independent = await fetched(false)
      expect(events).toEqual(["version", "fetch"])
      expect(independent.managerVersion).toBe("11.21.3")
      events.length = 0
      const sensitive = await fetched(true)
      expect(events).toEqual(["version", "fetch"])
      expect(sensitive.managerVersion).toBe("11.21.3")
      expect(independent.platform).toBe(null)
      expect(sensitive.platform).toEqual(platform)
      expect(independent.digest).not.toBe(sensitive.digest)
    })
  })

  it("refuses a layer whose manager name is outside the declared union", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const service = {
        ...managerService({ root, evidence }),
        name: "npm" as PackageManager.Name
      }
      const error = await Effect.runPromise(
        Install.executeMeasure().pipe(
          Effect.flip,
          Effect.provide(NodeServices.layer),
          Effect.provideService(PackageManager.PackageManager, service)
        )
      )
      expect(error.code).toBe("environment_mismatch")
      expect(error.message).toMatch(/declares an unknown manager/)
    })
  })

  /**
   * The manager is a plan-time declaration, so one round records measure,
   * exactly one fetch, and link. This is the assertion that the declared
   * manager reaches the recorded boundary: the fetch node names that manager's
   * lockfile and that manager's store directory, and nothing else changes.
   */
  it("records measure, one manager-specific fetch, and link in one round", () => {
    for (
      const [manager, lockfile] of [["pnpm", "pnpm-lock.yaml"]] as const
    ) {
      const graph = Graph.build(Install.Install, { manager })
      const actions = graph.nodes.filter((node) => node.kind === "ActionCall")
      expect(actions).toHaveLength(3)
      const [measure, fetch, link] = actions
      expect(measure!.draft.effects.reads).toEqual([
        ".npmrc",
        "bun.lock",
        "pnpm-lock.yaml",
        ".pnpmfile.cjs",
        "pnpm-workspace.yaml"
      ])
      expect(fetch!.draft.effects.reads).toEqual(
        manager === "pnpm"
          ? [lockfile, ".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"]
          : [lockfile, ".npmrc"]
      )
      // `pnpm fetch` also lays down the virtual store it hardlinks into (observed with pnpm 11.25.0:
      // node_modules/.pnpm/ and node_modules/.modules.yaml), so the declaration names those paths too.
      expect(fetch!.draft.effects.writes).toEqual([
        { _tag: "TreeArtifact", path: `.flows/store/${manager}` },
        ...(manager === "pnpm"
          ? [{ _tag: "Glob", include: ["**/node_modules/.pnpm/**", "**/node_modules/.modules.yaml"] }]
          : [])
      ])
      expect(link!.draft.effects.reads).toEqual([
        ".npmrc",
        "bun.lock",
        "pnpm-lock.yaml",
        ".pnpmfile.cjs",
        "pnpm-workspace.yaml",
        "package.json",
        { _tag: "Glob", include: ["**/package.json"], exclude: ["**/node_modules/**", ".flows/**"] }
      ])
      for (const action of actions) expect(action.draft.effects.boundaryMode).toBe("expected")
    }
  })

  /**
   * Measure's payload was empty, so a pnpm install and a Bun install of one
   * workspace recorded the same measure key: `Graph.build` folds a call's
   * literal payload into the node's key material, and an empty payload folds
   * nothing. The `expected` boundary keeps that inert today and a `hard` one
   * would turn it into a hit on the other manager's measurement.
   */
  it("keys measure on the declared manager so two managers cannot share one measurement", () => {
    // The flow admits only pnpm now; the measure action still takes any
    // manager name, so it is built directly to keep the key distinction pinned.
    const measureOf = (manager: PackageManager.Name) => {
      const graph = Graph.build(Install.Measure.call({ manager }))
      const node = graph.nodes.filter((node) => node.kind === "ActionCall")[0]!
      expect(node.draft.material.body).toMatchObject({ action: "smithers-build/install/measure" })
      return node.draft.material.inputs
    }
    expect(measureOf("pnpm")).toEqual([{ _tag: "Literal", value: { manager: "pnpm" } }])
    expect(measureOf("bun")).toEqual([{ _tag: "Literal", value: { manager: "bun" } }])
    expect(measureOf("pnpm")).not.toEqual(measureOf("bun"))
  })

  /**
   * Every other case drives `executeMeasure`, `executeFetch`, and
   * `executeLink` directly, so `MeasureLive`, the two fetch layers, `LinkLive`,
   * and `layer` were exported and composed by nothing under test. A layer
   * dropped from `Layer.mergeAll`, or wired to the wrong body, surfaced only
   * in build-cli. This runs the flow the way an executor does: through
   * `Install.layer`, an interpreter registration, and a `FlowRuntime` that
   * journals each action's encoded exit.
   */
  it("runs the flow through Install.layer and journals JSON-encodable outcomes", async () => {
    await withFixture(async (root) => {
      const evidence = await packageJsonDigest(root)
      const run = async (service: PackageManager.Service) => {
        const journal: Array<JournalEntry> = []
        const runtime = Layer.mergeAll(Install.layer, Interpreter.layer(Install.Install)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(layerMemory(journal)),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(PackageManager.PackageManager)(service),
              Layer.succeed(Runtime.Runtime)(runtimeService()),
              NodeServices.layer
            )
          )
        )
        const exit = await Effect.runPromise(
          Install.Install.execute({ manager: "pnpm" }, { executionId: `install-layer-${journal.length}` }).pipe(
            Effect.exit,
            Effect.provide(runtime)
          )
        )
        for (const entry of journal) {
          const payload = Exit.isSuccess(entry.exit)
            ? entry.exit.value
            : Result.getOrThrow(Cause.findFail(entry.exit.cause)).error
          expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
        }
        return { exit, journal }
      }

      const linked = await run(managerService({ root, evidence }))
      expect(linked.journal.map((entry) => entry.action)).toEqual([
        "smithers-build/install/measure",
        "smithers-build/install/fetch/pnpm",
        "smithers-build/install/link"
      ])
      expect(Exit.isSuccess(linked.exit)).toBe(true)
      const manifest = Exit.isSuccess(linked.exit) ? linked.exit.value : undefined
      expect(manifest).toMatchObject({ linked: true, store: expect.stringMatching(/^[0-9a-f]{64}$/) })
      expect(manifest).toMatchObject({ manifest: expect.stringMatching(/^[0-9a-f]{64}$/) })
      const journaledLink = linked.journal[2]!.exit
      expect(Exit.isSuccess(journaledLink)).toBe(true)
      expect(
        Schema.decodeUnknownSync(Install.LinkManifest)(Exit.isSuccess(journaledLink) ? journaledLink.value : undefined)
      )
        .toEqual(manifest)

      await Fs.rm(NodePath.join(root, "pnpm-lock.yaml"))
      const refused = await run(managerService({ root, evidence }))
      expect(refused.journal.map((entry) => entry.action)).toEqual(["smithers-build/install/measure"])
      const journaledFailure = refused.journal[0]!.exit
      if (!Exit.isFailure(journaledFailure)) throw new Error("expected measure to fail without a lockfile")
      const encoded = Cause.findFail(journaledFailure.cause)
      if (!Result.isSuccess(encoded)) {
        throw new Error(`expected a typed failure: ${Cause.pretty(journaledFailure.cause)}`)
      }
      const decoded = Schema.decodeUnknownSync(PackageManager.PackageManagerError)(encoded.success.error)
      expect(decoded).toBeInstanceOf(PackageManager.PackageManagerError)
      expect(decoded.message).toContain("pnpm-lock.yaml")
      expect(Exit.isFailure(refused.exit)).toBe(true)
      const surfaced = Exit.isFailure(refused.exit) ? Cause.findFail(refused.exit.cause) : undefined
      expect(surfaced !== undefined && Result.isSuccess(surfaced) ? surfaced.success.error : undefined)
        .toMatchObject({ _tag: "smithers-build/PackageManagerError", code: decoded.code, message: decoded.message })
    })
  })
})
