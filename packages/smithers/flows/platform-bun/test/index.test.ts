/**
 * The barrel, and the one dependency this package must *not* have.
 *
 * Bun used to reach into `@smthrs/platform-browser` purely to borrow a
 * `fetch`-backed transport. Outgoing requests are now Effect's own
 * `HttpClient` — `@effect/platform-bun/BunHttpClient` — so the browser package
 * has no business in a Bun bundle, and the resolved module graph says so.
 */
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { HostServiceIds } from "@smthrs/kernel/HostServices"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { build } from "esbuild"
import * as NativePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as BunFileSystem from "../src/BunFileSystem.ts"
import * as BunHost from "../src/BunHost.ts"
import * as Index from "../src/index.ts"

describe("@smthrs/platform-bun barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual(["BunFileSystem", "BunHost"])
    expect(Index.BunFileSystem.layer).toBe(BunFileSystem.layer)
    expect(Index.BunHost.layer).toBe(BunHost.layer)
    expect(Index.BunHost.layerAt(process.cwd()).pipe).toBeTypeOf("function")
    expect(Index.BunHost.layerContained).toBe(BunHost.layerContained)
    expect(Index.BunHost.layerContained().pipe).toBeTypeOf("function")
    expect(Index.BunHost.layerContainedAt).toBe(BunHost.layerContainedAt)
  })

  it("hands the filesystem escape hatch through, unwrapped", () => {
    // `layerWith` is the code path for naming a helper outside the default
    // search, and a Bun consumer must be able to reach it without
    // adding `@smthrs/platform-node` as a second dependency.
    expect(BunFileSystem.layer).toBe(AtomicFileSystem.layer)
    expect(BunFileSystem.layerWith).toBe(AtomicFileSystem.layerWith)
    expect(BunHost.AtomicFileSystem).toBe(AtomicFileSystem)
  })

  it("uses native path semantics for absolute filesystem paths", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        const root = process.cwd()
        expect(path.sep).toBe(NativePath.sep)
        expect(path.isAbsolute(root)).toBe(true)
        expect(path.resolve(root, "..", "next")).toBe(NativePath.resolve(root, "..", "next"))
        expect(path.join(root, "nested", "file.ts")).toBe(NativePath.join(root, "nested", "file.ts"))
      }).pipe(Effect.provide(BunHost.layerAt(process.cwd())))
    )
  })

  it("records what it spawns and retires the record when the scope closes", async () => {
    const ledger = await Effect.runPromise(
      ProcessLedger.makeMemory({ hostId: "bun-host", ownerPid: process.pid })
    )
    const host = BunHost.layerContainedAt(process.cwd(), { graceMs: 250 }).pipe(
      Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
    )

    const live = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("sleep", ["30"]))
        return yield* ledger.live
      }).pipe(Effect.provide(host), Effect.scoped)
    )

    expect(live).toEqual([expect.objectContaining({ commandDigest: "sleep" })])
    // The scope closed, so the record is retired with the process.
    expect(await Effect.runPromise(ledger.live)).toEqual([])
  })

  it("records the executable a contained child runs, never a credential in its argv", async () => {
    // A journal-backed ledger keeps its records permanently, so an argument is
    // not a safe thing to store: this `--token=` stands for `curl -u`,
    // `mysql -p`, and every other tool that takes a credential on its line.
    const secret = "violetMarble6729"
    const ledger = await Effect.runPromise(
      ProcessLedger.makeMemory({ hostId: "bun-host", ownerPid: process.pid })
    )
    const host = BunHost.layerContained({ graceMs: 250 }).pipe(
      Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
    )

    const live = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        // `sh -c LINE NAME ARGUMENT...` sets `$0` and the positional
        // parameters, so the credential really is in argv while `sleep 30`
        // holds the recorded group open.
        yield* spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 30", "deploy", `--token=${secret}`]))
        return yield* ledger.live
      }).pipe(Effect.provide(host), Effect.scoped)
    )

    expect(live).toEqual([expect.objectContaining({ commandDigest: "sh" })])
    expect(JSON.stringify(live)).not.toContain(secret)
  })

  it("names the module actually behind every closed Host slot", () => {
    // A golden vector rather than a spot check: the record is public surface
    // keyed by the closed list, so a renamed value, a swapped pair, or an extra
    // key all have to be deliberate.
    expect(BunHost.implementationIds).toEqual({
      "effect/FileSystem": "@smthrs/platform-node/AtomicFileSystem",
      "effect/Path": "@effect/platform-bun/BunPath",
      "effect/process/ChildProcessSpawner": "@effect/platform-bun/BunChildProcessSpawner",
      "@smthrs/jj/Jj": "@smthrs/jj/bun/BunJj",
      "effect/HttpClient": "@effect/platform-bun/BunHttpClient"
    })
    // Every slot in the closed list is named, and nothing else is.
    expect(Object.keys(BunHost.implementationIds).sort()).toEqual([...HostServiceIds].sort())
  })

  it("carries the kernel atomic filesystem extension", async () => {
    const fileSystem = await Effect.runPromise(
      Effect.provide(FileSystem.FileSystem, BunFileSystem.layer)
    )
    const atomic = (fileSystem as Partial<KernelFileSystem.AtomicHostFileSystem>)[
      KernelFileSystem.AtomicFileSystemTypeId
    ]
    expect(atomic).toBeDefined()
  })
})

describe("@smthrs/platform-bun module graph", () => {
  it("never resolves @smthrs/platform-browser", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      external: ["effect", "effect/*", "@effect/*", "node:*"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "node",
      write: false
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some((input) => input.includes("platform-browser"))).toBe(false)
  })
})
