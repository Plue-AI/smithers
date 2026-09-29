/**
 * `SandboxedFlow` against `DirectorySandbox`: a real bundle, a real guest
 * process, real files, and every failure the host can name.
 *
 * The integration provider is the scratch-directory one
 * over the Node filesystem and spawner, the guest is a real `node` (or `bun`)
 * process running the bundle, and the faults below are injected one layer
 * OUTSIDE the module: a wrapping provider that refuses one operation, a
 * runtime command that exits the way a broken image would, an entry the
 * bundler cannot find, and a host-side declaration that drifted from the one
 * the guest ran. Limit regressions additionally use a controlled guest with
 * a real filesystem and observable streaming transport.
 */
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as Redaction from "@smthrs/journal/Redaction"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Node from "@smthrs/plan/Node"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox, RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import * as ByteSize from "effect/ByteSize"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { inspect } from "node:util"
import { vi } from "vitest"
import { Action, Engine, Flow, FlowRuntime, Interpreter, RetryPolicy } from "../src/index.ts"
import * as Guest from "../src/internal/SandboxedFlowGuest.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import * as childEntry from "./fixtures/sandboxed-child.ts"
import * as pureEntry from "./fixtures/sandboxed-pure.ts"

vi.mock("effect/Stream", { spy: true })

const { ProviderError } = RemoteChildProcessSpawner
const { Editor, Failing, Filler, Inspector, Sleeper, Sum, Writer } = childEntry

const root = mkdtempSync(join(tmpdir(), "flows-sandboxed-flow-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = new URL("./fixtures/sandboxed-child.ts", import.meta.url)
const pure = new URL("./fixtures/sandboxed-pure.ts", import.meta.url)
const runtimeDirectory = mkdtempSync(join(tmpdir(), "flows-guest-runtimes-"))
afterAll(() => rmSync(runtimeDirectory, { recursive: true, force: true }))
const guestRuntime = (name: string, body: string): string => {
  const path = join(runtimeDirectory, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}

const platform = NodeHost.layerContained({ graceMs: 80 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "sandboxed-flow-tests", ownerPid: process.pid }))
)

const provider = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return DirectorySandbox.make({ fs, spawner, root })
}).pipe(Effect.provide(platform))

/** Which session operations a wrapping provider refuses. */
interface Faults {
  readonly writeFile?: (path: string) => boolean
  readonly readFile?: (path: string) => boolean
  readonly spawn?: boolean
  readonly readDirectory?: boolean
}

/**
 * A real provider with one operation refused. The session underneath is the
 * scratch directory's own; only the named call answers with a failure, the
 * way a transport that lost its machine mid-run would.
 */
const faulty = (base: Sandbox.Provider, faults: Faults): Sandbox.Provider => ({
  acquire: (key) =>
    Effect.map(base.acquire(key), (session): Sandbox.Session => ({
      ...session,
      writeFile: (path, content) =>
        faults.writeFile?.(path) === true
          ? Effect.fail(new ProviderError({ code: "unknown", message: `write refused for ${path}` }))
          : session.writeFile(path, content),
      readFile: (path) =>
        faults.readFile?.(path) === true
          ? Effect.fail(new ProviderError({ code: "unknown", message: `read refused for ${path}` }))
          : session.readFile(path),
      spawn: (command, options) =>
        faults.spawn === true
          ? Effect.fail(new ProviderError({ code: "spawn_error", message: "spawn refused" }))
          : session.spawn(command, options),
      files: faults.readDirectory === true
        ? {
          ...session.files,
          readDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readDirectory",
                description: "listing refused"
              })
            )
        }
        : faults.readFile === undefined ?
        session.files :
        {
          ...session.files,
          stream: (path) =>
            Stream.unwrap(
              (faults.readFile?.(path) === true
                ? Effect.fail(PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "stream",
                  description: `read refused for ${path}`
                }))
                : session.readFile(path).pipe(Effect.mapError(() =>
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "stream",
                    description: `read failed for ${path}`
                  })
                ))).pipe(Effect.map(Stream.succeed))
            )
        }
    }))
})

/** A provider that remembers every session key it was asked for. */
const recording = (base: Sandbox.Provider, keys: Array<string>): Sandbox.Provider => ({
  acquire: (key) => {
    keys.push(key)
    return base.acquire(key)
  }
})

const failureOf = <A>(
  effect: Effect.Effect<A, SandboxedFlow.SandboxedFlowError>
): Effect.Effect<SandboxedFlow.SandboxedFlowError, A> => Effect.flip(effect)

const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("SandboxedFlow.execute on a scratch machine", () => {
  it.live("treats a runtime path containing shell syntax as one executable", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const runtimeDirectory = mkdtempSync(join(tmpdir(), "flows-runtime-"))
      const runtime = join(runtimeDirectory, "node guest'; echo injected; #")
      try {
        symlinkSync(process.execPath, runtime)
        const result = yield* SandboxedFlow.execute(Sum, { n: 31 }, {
          provider: directory,
          session: "quoted-runtime",
          entry,
          runtime
        })
        expect(result.output).toBe(42)
      } finally {
        rmSync(runtimeDirectory, { recursive: true, force: true })
      }
    }), 60_000)

  it.live("runs the child flow's own code in the guest and validates its result", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Sum, { n: 31 }, {
        provider: directory,
        session: "sum",
        entry
      })
      expect(result).toEqual({ output: 42, diff: [], deleted: [] })
      // A normal completion releases the session, which removes the workspace.
      expect(readdirSync(root)).toEqual([])
    }), 60_000)

  it.live("takes a path entry and returns the files the guest wrote as data", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Writer, { count: 3, bytes: 16, directory: "out" }, {
        provider: directory,
        session: "writer",
        entry: realpathSync(new URL(entry)),
        collectDiff: true
      })
      expect(result.output).toBe(3)
      expect(result.diff.map((file) => file.path)).toEqual(["out/file-0.bin", "out/file-1.bin", "out/file-2.bin"])
      expect(result.diff[1]!.bytes).toEqual(new Uint8Array(16).fill(1))
      // The protocol's own files never count as the guest's changes.
      expect(result.diff.some((file) => file.path.startsWith(".smithers-sandbox"))).toBe(false)
    }), 60_000)

  it.live("runs an entry that exports no layer", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "as it was" }, {
        provider: directory,
        session: "pure",
        entry: pure
      })
      expect(result.output).toBe("as it was")
    }), 60_000)

  it.live("reattaches the machine a previous holder of the session key seeded", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      // The outer holder stands in for a crashed earlier execution: it
      // acquired the key, wrote into the workspace, and never released it.
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const earlier = yield* directory.acquire("seeded")
          yield* earlier.writeFile(`${earlier.workdir}/seed.txt`, new TextEncoder().encode("from the host"))
          // Read before the execution: its completion releases the key, which
          // removes the workspace under this holder, as the contract says.
          const workdir = realpathSync(earlier.workdir)
          const result = yield* SandboxedFlow.execute(Inspector, { marker: "left by the guest" }, {
            provider: directory,
            session: "seeded",
            entry,
            collectDiff: true,
            limits: { files: 10 },
            timeout: Duration.seconds(30)
          })
          expect(result.output.cwd).toBe(workdir)
          return result
        })
      )
      expect(result.output.seed).toBe("from the host")
      expect(result.output.runtime).toMatch(/^node v/)
      // The seed kept its size, so only the guest's own file is a change.
      expect(result.diff).toEqual([{ path: "marker.txt", bytes: new TextEncoder().encode("left by the guest") }])
    }), 60_000)

  it.live("reports a same-size rewrite and a deletion on a reattached workspace", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const earlier = yield* directory.acquire("edited")
          yield* earlier.writeFile(`${earlier.workdir}/version.txt`, new TextEncoder().encode("1.2.3"))
          yield* earlier.writeFile(`${earlier.workdir}/gone.txt`, new TextEncoder().encode("delete me"))
          return yield* SandboxedFlow.execute(Editor, { path: "version.txt", text: "1.2.4", remove: "gone.txt" }, {
            provider: directory,
            session: "edited",
            entry,
            collectDiff: true,
            timeout: Duration.seconds(30)
          })
        })
      )
      expect(result.diff).toEqual([{ path: "version.txt", bytes: new TextEncoder().encode("1.2.4") }])
      expect(result.deleted).toEqual(["gone.txt"])
    }), 60_000)

  it.live("refuses a stale result when a reattached guest exits zero without writing", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      yield* Effect.scoped(
        Effect.gen(function*() {
          const earlier = yield* directory.acquire("stale-result")
          yield* earlier.writeFile(
            `${earlier.workdir}/.smithers-sandbox/result.json`,
            new TextEncoder().encode(JSON.stringify({ attempt: "earlier-attempt", status: "succeeded", output: 17 }))
          )
          const failure = yield* failureOf(SandboxedFlow.execute(Sum, { n: 99 }, {
            provider: directory,
            session: "stale-result",
            entry,
            runtime: guestRuntime("stale-no-result", "exit 0")
          }))
          expect(failure.code).toBe("result_unreadable")
          expect(failure.message).toContain("without writing a result")
        })
      )
    }), 60_000)

  it.live("creates a fresh attempt when the same execution effect runs again", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const attempts: Array<string> = []
      const execution = SandboxedFlow.execute(Sum, { n: 31 }, {
        provider: {
          acquire: (key) =>
            Effect.map(directory.acquire(key), (session) => ({
              ...session,
              writeFile: (path, bytes) => {
                if (path.endsWith("/request.json")) {
                  attempts.push(
                    Schema.decodeUnknownSync(Guest.Request)(JSON.parse(new TextDecoder().decode(bytes))).attempt
                  )
                }
                return session.writeFile(path, bytes)
              }
            }))
        },
        session: "fresh-attempt",
        entry
      })
      expect((yield* execution).output).toBe(42)
      expect((yield* execution).output).toBe(42)
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).not.toBe(attempts[1])
    }), 60_000)

  it.live(
    "leaves a link the guest planted out of the diff instead of reading its target",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const outside = mkdtempSync(join(tmpdir(), "flows-outside-"))
        try {
          const secret = join(outside, "secret.txt")
          writeFileSync(secret, "host secret")
          const runtime = guestRuntime(
            "plant-link",
            `ln -s ${JSON.stringify(secret)} leak.txt && mkdir sub && ln -s ${JSON.stringify(outside)} sub/dir && ` +
              `printf kept > kept.txt && exec ${JSON.stringify(process.execPath)} "$@"`
          )
          const result = yield* SandboxedFlow.execute(Sum, { n: 31 }, {
            provider: directory,
            session: "planted-link",
            entry,
            runtime,
            collectDiff: true
          })
          expect(result.diff.map(({ path, bytes }) => ({ path, text: new TextDecoder().decode(bytes) }))).toEqual([
            { path: "kept.txt", text: "kept" }
          ])
        } finally {
          rmSync(outside, { recursive: true, force: true })
        }
      }),
    60_000
  )

  it.live("refuses a diff path a Windows applier would read as a traversal", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const runtime = guestRuntime(
        "backslash-name",
        `printf x > '..\\..\\x' && exec ${JSON.stringify(process.execPath)} "$@"`
      )
      const failure = yield* failureOf(SandboxedFlow.execute(Sum, { n: 31 }, {
        provider: directory,
        session: "backslash-name",
        entry,
        runtime,
        collectDiff: true
      }))
      expect(failure.code).toBe("diff_unsafe")
      expect(failure.message).toContain("..\\\\..\\\\x")
    }), 60_000)

  it.live("lists a directory the guest created without reading it as a file", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Writer, { count: 1, bytes: 1, directory: "nested/deep" }, {
        provider: directory,
        session: "nested",
        entry,
        collectDiff: true
      })
      expect(result.diff.map((file) => file.path)).toEqual(["nested/deep/file-0.bin"])
    }), 60_000)
})

describe.skipIf(!bunInstalled)("SandboxedFlow.execute under bun", () => {
  it.live("starts the bundle with the runtime it was told to", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Inspector, { marker: "bun" }, {
        provider: directory,
        session: "bun",
        entry,
        runtime: "bun"
      })
      expect(result.output.runtime).toBe("bun")
    }), 60_000)
})

/** A real filesystem with a controlled guest and observable readback transport. */
const limitedGuest = (options: {
  readonly output?: string
  readonly files?: ReadonlyArray<string>
  readonly staleSize?: number
  readonly noise?: Stream.Stream<Uint8Array, RemoteChildProcessSpawner.ProviderError>
  readonly resultSize?: number
  readonly failure?: string
  readonly native?: boolean
  readonly resultStatFailure?: boolean
  readonly readbackFailure?: boolean
  readonly omitMtime?: boolean
} = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer))
    const fileError = (cause: unknown) => new ProviderError({ code: "unknown", message: String(cause) })
    const directory: Sandbox.Provider = {
      acquire: (key) =>
        Effect.gen(function*() {
          const workdir = yield* fs.makeTempDirectoryScoped({ directory: root }).pipe(Effect.mapError(fileError))
          return {
            id: key,
            remoteId: key,
            workdir,
            files: { stat: fs.stat, readDirectory: fs.readDirectory, remove: fs.remove },
            readFile: (path) => fs.readFile(path).pipe(Effect.mapError(fileError)),
            writeFile: (path, bytes) =>
              fs.makeDirectory(dirname(path), { recursive: true }).pipe(
                Effect.andThen(fs.writeFile(path, bytes)),
                Effect.mapError(fileError)
              ),
            spawn: (command) =>
              Effect.sync(() => {
                const child = spawnSync("sh", ["-c", command], { cwd: workdir })
                return {
                  stdout: Stream.succeed(child.stdout),
                  stderr: Stream.succeed(child.stderr),
                  exitCode: Effect.succeed(child.status ?? 1)
                }
              })
          } satisfies Sandbox.Session
        })
    }
    const reads: Array<string> = []
    const streamed: Array<{ path: string; bytesToRead: unknown }> = []
    /** Every path a workspace walk statted, and how many stats overlapped. */
    const walk = { paths: [] as Array<string>, live: 0, peak: 0 }
    let attempt = ""
    const nativeStream: FileSystem.FileSystem["stream"] = (path, settings) => {
      streamed.push({ path, bytesToRead: settings?.bytesToRead })
      return fs.stream(path, settings)
    }
    const wrapped: Sandbox.Provider = {
      acquire: (key) =>
        Effect.map(directory.acquire(key), (session) => ({
          ...session,
          writeFile: (path, bytes) => {
            if (path.endsWith("request.json")) attempt = JSON.parse(new TextDecoder().decode(bytes)).attempt
            return session.writeFile(path, bytes)
          },
          readFile: (path) => {
            reads.push(path)
            return session.readFile(path)
          },
          files: {
            ...session.files,
            stat: (path) =>
              Effect.gen(function*() {
                walk.paths.push(path)
                walk.live++
                walk.peak = Math.max(walk.peak, walk.live)
                // A scheduling point: without one, a stat that resolves in the
                // same tick makes a concurrent walk indistinguishable from a
                // serial one, which is the regression this observes.
                yield* Effect.sleep("2 millis")
                if (options.resultStatFailure === true && path.endsWith("result.json")) {
                  return yield* Effect.fail(PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "stat",
                    description: "result transport unavailable"
                  }))
                }
                return yield* fs.stat(path)
              }).pipe(
                Effect.ensuring(Effect.sync(() => {
                  walk.live--
                })),
                Effect.map((info) => ({
                  ...info,
                  mtime: options.omitMtime === true ? Option.none() : info.mtime,
                  size: ByteSize.bytes(
                    path.endsWith("result.json")
                      ? options.resultSize ?? Number(info.size)
                      : options.staleSize ?? Number(info.size)
                  )
                }))
              ),
            ...(options.native === false ? {} : { stream: nativeStream })
          },
          spawn: (command, settings) =>
            Effect.gen(function*() {
              if (settings.env === undefined) {
                if (options.readbackFailure === true) {
                  return {
                    stdout: Stream.empty,
                    stderr: Stream.succeed(new TextEncoder().encode("readback transport refused")),
                    exitCode: Effect.succeed(1)
                  }
                }
                return yield* session.spawn(command, settings)
              }
              yield* session.writeFile(
                settings.env!.SMITHERS_SANDBOX_RESULT_PATH!,
                new TextEncoder().encode(
                  JSON.stringify(
                    options.failure === undefined ?
                      { attempt, status: "succeeded", output: options.output ?? "ok" }
                      : { attempt, status: "failed", error: options.failure }
                  )
                )
              )
              for (const [i, content] of (options.files ?? []).entries()) {
                yield* session.writeFile(`${session.workdir}/file-${i}`, new TextEncoder().encode(content))
              }
              return {
                stdout: options.noise ?? Stream.empty,
                stderr: options.noise ?? Stream.empty,
                exitCode: Effect.as(Effect.sleep("20 millis"), 0)
              }
            })
        }))
    }
    return { provider: wrapped, reads, streamed, walk }
  })

describe("native Windows sandbox diff paths", () => {
  for (const workdir of ["C:/workspace", "\\\\server\\share\\workspace"]) {
    it.live(`excludes protocol files and returns portable diffs for ${workdir}`, () =>
      Effect.gen(function*() {
        const guest = yield* limitedGuest({ files: ["ok"] })
        const windows: Sandbox.Provider = {
          acquire: (key) =>
            Effect.map(guest.provider.acquire(key), (session): Sandbox.Session => {
              const prefix = workdir.replace(/\\/g, "/")
              const local = (path: string): string => {
                const normalized = path.replace(/\\/g, "/")
                return normalized.startsWith(prefix) ? `${session.workdir}${normalized.slice(prefix.length)}` : path
              }
              return {
                ...session,
                workdir,
                writeFile: (path, bytes) => session.writeFile(local(path), bytes),
                readFile: (path) => session.readFile(local(path)),
                files: {
                  ...session.files,
                  stat: (path) => session.files!.stat!(local(path)),
                  realPath: (path) =>
                    Effect.sync(() => {
                      const real = realpathSync(local(path))
                      const localRoot = realpathSync(session.workdir)
                      return real.startsWith(localRoot) ? `${prefix}${real.slice(localRoot.length)}` : real
                    }),
                  remove: (path, options) => session.files!.remove!(local(path), options),
                  stream: (path, options) => session.files!.stream!(local(path), options),
                  readDirectory: (path, options) =>
                    session.files!.readDirectory!(local(path), options).pipe(
                      Effect.map((entries) => entries.map((entry) => entry.replace(/[\\/]/g, "\\")))
                    )
                },
                spawn: (command, options) =>
                  session.spawn(command, {
                    ...options,
                    ...(options.env === undefined ? {} : {
                      env: {
                        ...options.env,
                        SMITHERS_SANDBOX_RESULT_PATH: local(options.env.SMITHERS_SANDBOX_RESULT_PATH!)
                      }
                    })
                  }).pipe(Effect.tap(() =>
                    session.writeFile(
                      `${session.workdir}/nested/result.txt`,
                      new TextEncoder().encode("hi")
                    )
                  ))
              }
            })
        }
        const result = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: windows,
          session: "windows-diff",
          entry: pure,
          collectDiff: true,
          limits: { files: 2, diffBytes: 4 }
        })
        expect(result.diff.map(({ path, bytes }) => ({ path, text: new TextDecoder().decode(bytes) }))).toEqual([
          { path: "file-0", text: "ok" },
          { path: "nested/result.txt", text: "hi" }
        ])
        expect(result.deleted).toEqual([])
      }), 60_000)
  }
})

describe("sandbox limit boundaries", () => {
  const resultSize = (output: string) =>
    new TextEncoder().encode(JSON.stringify({
      attempt: "x".repeat(36),
      status: "succeeded",
      output
    })).length

  for (const output of ["", "é🌍"]) {
    for (const extra of [0, 1]) {
      it.live(
        `result bytes accept N and reject N+1: ${JSON.stringify(output)}, extra ${extra}`,
        () =>
          Effect.gen(function*() {
            const guest = yield* limitedGuest({ output })
            const limit = resultSize(output) - extra
            const exit = yield* SandboxedFlow.execute(pureEntry.Constant, { value: output }, {
              provider: guest.provider,
              session: "result-boundary",
              entry: pure,
              limits: { resultBytes: limit }
            }).pipe(Effect.exit)
            if (extra === 0) expect(Exit.isSuccess(exit) && exit.value.output).toBe(output)
            else {expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
                error: { code: "result_overflow" }
              })}
          }),
        60_000
      )
    }
  }

  for (const bound of ["diffBytes", "files"] as const) {
    for (const limit of [0, 2]) {
      for (const extra of [0, 1]) {
        it.live(`${bound} accepts N and rejects N+1: N=${limit}, extra ${extra}`, () =>
          Effect.gen(function*() {
            const contents = bound === "files" ?
              Array<string>(limit + extra).fill("")
              : limit === 0
              ? ["x".repeat(extra)]
              : ["é", "x".repeat(extra)]
            const guest = yield* limitedGuest({ files: contents })
            const exit = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
              provider: guest.provider,
              session: "diff-boundary",
              entry: pure,
              collectDiff: true,
              limits: { [bound]: limit }
            }).pipe(Effect.exit)
            if (extra === 0) {
              expect(Exit.isSuccess(exit)).toBe(true)
              if (Exit.isSuccess(exit)) {
                expect(
                  bound === "files" ?
                    exit.value.diff.length
                    : exit.value.diff.reduce((sum, file) => sum + file.bytes.length, 0)
                ).toBe(limit)
              }
            } else {expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
                error: { code: "diff_overflow" }
              })}
          }), 60_000)
      }
    }
  }

  it.live("collects changed file bytes from a provider without timestamps", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest({ files: ["changed"], omitMtime: true })
      const result = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "snapshot-without-mtime",
        entry: pure,
        collectDiff: true
      })
      expect(result.diff.map((file) => ({ path: file.path, text: new TextDecoder().decode(file.bytes) }))).toEqual([
        { path: "file-0", text: "changed" }
      ])
    }), 60_000)

  it.live("walks the workspace with bounded stat concurrency, not one file at a time", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest({ files: Array<string>(40).fill("x") })
      const result = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "snapshot-concurrency",
        entry: pure,
        collectDiff: true
      })
      expect(result.diff.length).toBe(40)
      // Overlapping, and overlapping by a bounded amount: a serial walk peaks
      // at one and an unbounded one peaks at the workspace's file count.
      expect(guest.walk.peak).toBeGreaterThan(1)
      expect(guest.walk.peak).toBeLessThanOrEqual(16)
    }), 60_000)

  it.live("stops the after walk once the changed-file limit is exceeded", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest({ files: Array<string>(64).fill("x") })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "changed-limit-short-circuit",
        entry: pure,
        collectDiff: true,
        limits: { files: 2 }
      }))
      expect(failure.code).toBe("diff_overflow")
      expect(failure.message).toContain("more than 2 files")
      const walked = guest.walk.paths.filter((path) => /\/file-\d+$/.test(path))
      expect(walked.length).toBeGreaterThan(2)
      expect(walked.length).toBeLessThan(64)
      expect(guest.reads).toEqual([])
    }), 60_000)

  it.live("rejects a zero-byte result budget before downloading", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest()
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "zero-result",
        entry: pure,
        limits: { resultBytes: 0 }
      }))
      expect(failure.code).toBe("result_overflow")
      expect(guest.reads).toEqual([])
      expect(guest.streamed).toEqual([])
    }), 60_000)

  it.live("stops a growing result at the byte budget plus one", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest({ output: "x".repeat(100_000), resultSize: 1 })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "growing-result",
        entry: pure,
        limits: { resultBytes: 100 }
      }))
      expect(failure.code).toBe("result_overflow")
      expect(guest.reads).toEqual([])
      expect(guest.streamed.map((read) => Number(read.bytesToRead))).toEqual([101])
    }), 60_000)

  it.live("rejects actual aggregate diff bytes when files grow after stat", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest({ files: ["é", "abcd"], staleSize: 1 })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "growing-diff",
        entry: pure,
        collectDiff: true,
        limits: { diffBytes: 5 }
      }))
      expect(failure.code).toBe("diff_overflow")
      expect(guest.reads).toEqual([])
      expect(
        guest.streamed.filter((read) => !read.path.endsWith("result.json"))
          .map((read) => Number(read.bytesToRead))
      ).toEqual([6, 4])
    }), 60_000)

  for (const native of [true, false]) {
    it.live(`bounds a growing diff using ${native ? "native streams" : "guest head"}`, () =>
      Effect.gen(function*() {
        const guest = yield* limitedGuest({ files: ["x".repeat(100_000)], staleSize: 1, native })
        const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: guest.provider,
          session: "bounded-transport",
          entry: pure,
          collectDiff: true,
          limits: { diffBytes: 2 }
        }))
        expect(failure.code).toBe("diff_overflow")
        expect(guest.reads).toEqual([])
      }), 60_000)
  }

  for (const timeout of [Duration.zero, Duration.millis(5)]) {
    it.live(`expires a ${Duration.toMillis(timeout)} millisecond budget`, () =>
      Effect.gen(function*() {
        const guest = yield* limitedGuest()
        const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: guest.provider,
          session: "short-timeout",
          entry: pure,
          timeout
        }))
        expect(failure.code).toBe("deadline_exceeded")
      }), 60_000)
  }

  for (const timeout of [Duration.infinity, Duration.days(30)]) {
    it.live(`does not immediately expire ${Duration.toMillis(timeout)} milliseconds`, () =>
      Effect.gen(function*() {
        const guest = yield* limitedGuest()
        const result = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: guest.provider,
          session: "long-timeout",
          entry: pure,
          timeout
        })
        expect(result.output).toBe("ok")
      }), 60_000)
  }

  it.live("redacts credentials across chunks and preserves subsequent UTF-8 diagnostics", () =>
    Effect.gen(function*() {
      const credential = "synthetic-output-secret".repeat(400)
      const bytes = new TextEncoder().encode(`Bearer ${credential}\n${"é".repeat(2100)}🌍 tail`)
      const noise = Stream.fromIterable(
        Array.from({ length: Math.ceil(bytes.length / 31) }, (_, i) => bytes.subarray(i * 31, (i + 1) * 31))
      )
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "chunked-diagnostics",
        entry: pure
      }))
      expect(failure.code).toBe("flow_failed")
      expect(failure.message).not.toContain("synthetic-output-secret")
      expect(failure.message).toContain("🌍 tail")
      expect(failure.message.length).toBeLessThan(8400)
    }), 60_000)

  it.live("redacts multiline private keys while retaining a UTF-8 tail", () =>
    Effect.gen(function*() {
      const bytes = new TextEncoder().encode(
        `-----BEGIN PRIVATE KEY-----\n${"private-material".repeat(800)}\n-----END PRIVATE KEY-----\n${
          "🌍".repeat(2100)
        } tail`
      )
      const noise = Stream.fromIterable(
        Array.from({ length: Math.ceil(bytes.length / 31) }, (_, i) => bytes.subarray(i * 31, (i + 1) * 31))
      )
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "private-key-diagnostics",
        entry: pure
      }))
      expect(failure.message).not.toContain("private-material")
      expect(failure.message).not.toContain("�")
      expect(failure.message).toContain("🌍 tail")
    }), 60_000)

  it.live("redacts a JSON credential whose key and value span lines", () =>
    Effect.gen(function*() {
      const noise = Stream.fromIterable([
        new TextEncoder().encode("{\n  \"password\":\n"),
        new TextEncoder().encode("  \"synthetic-multiline-credential\"\n}\nreadable tail")
      ])
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "json-diagnostics",
        entry: pure
      }))
      expect(failure.message).not.toContain("synthetic-multiline-credential")
      expect(failure.message).toContain("[REDACTED]")
      expect(failure.message).toContain("readable tail")
    }), 60_000)

  it.live("redacts a private key and an inspected string split over lines and chunks", () =>
    Effect.gen(function*() {
      const secret = "ZqSynthetic7Secret4Value9"
      const bytes = new TextEncoder().encode(
        `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n${
          inspect({ privateKey: `${secret}\n`.repeat(8) })
        }\nreadable tail`
      )
      const noise = Stream.fromIterable(
        Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, (i + 1) * 7))
      )
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "inspect-diagnostics",
        entry: pure
      }))
      expect(failure.message).not.toContain(secret)
      expect(failure.message).toContain("[REDACTED]")
      expect(failure.message).toContain("readable tail")
    }), 60_000)

  it.live("keeps a value opened by an overlong line held until it closes", () =>
    Effect.gen(function*() {
      const secret = "ZqSynthetic7Secret4Value9"
      // No quote, so nothing withholds the rest of the stream: only the line
      // redactor, seeing the opener at the end of the overlong line, holds the key.
      const bytes = new TextEncoder().encode(
        `${"a".repeat(33_000)} -----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\nreadable tail`
      )
      const noise = Stream.fromIterable(
        Array.from({ length: Math.ceil(bytes.length / 31) }, (_, i) => bytes.subarray(i * 31, (i + 1) * 31))
      )
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "overlong-opener-diagnostics",
        entry: pure
      }))
      expect(failure.message).not.toContain(secret)
      expect(failure.message).toContain("readable tail")
    }), 60_000)

  it.live("withholds what an opener in the dropped middle of an overlong line swallows", () =>
    Effect.gen(function*() {
      const secret = "ZqSynthetic7Secret4Value9"
      const bytes = new TextEncoder().encode(
        `${"x".repeat(20_000)} password: { value: "${"a".repeat(20_000)}\n${secret}\n" }\nreadable tail`
      )
      const noise = Stream.fromIterable(
        Array.from({ length: Math.ceil(bytes.length / 4096) }, (_, i) => bytes.subarray(i * 4096, (i + 1) * 4096))
      )
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "overlong-middle-diagnostics",
        entry: pure
      }))
      expect(failure.message).not.toContain(secret)
    }), 60_000)

  it.live("redacts diagnostic credential spellings in guest output", () =>
    Effect.gen(function*() {
      const secret = "ZqSynthetic7Secret4Value9"
      const noise = Stream.succeed(
        new TextEncoder().encode(`Authorization: Token ${secret}\nreadable tail`)
      )
      // The guest's own failure sentence reaches the message without the line redactor.
      const guest = yield* limitedGuest({ noise, failure: `sshpass -p ${secret} ssh host` })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "diagnostic-spellings",
        entry: pure
      }))
      expect(failure.message).not.toContain(secret)
      expect(failure.message).toContain("sshpass -p [REDACTED] ssh host")
      expect(failure.message).toContain("Authorization: [REDACTED]")
      expect(failure.message).toContain("readable tail")
    }), 60_000)

  it.live("does not expose the suffix of an overlong quoted credential", () =>
    Effect.gen(function*() {
      const bytes = new TextEncoder().encode(`{\n"password":\n"${"synthetic-quoted-credential".repeat(400)}"\n}`)
      const noise = Stream.fromIterable(
        Array.from({ length: Math.ceil(bytes.length / 31) }, (_, i) => bytes.subarray(i * 31, (i + 1) * 31))
      )
      const guest = yield* limitedGuest({ noise, failure: "refused" })
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: guest.provider,
        session: "quoted-diagnostics",
        entry: pure
      }))
      expect(failure.message).not.toContain("synthetic-quoted-credential")
      expect(failure.message).toContain("[REDACTED]")
    }), 60_000)

  for (
    const diagnostic of [
      {
        name: "unterminated private key",
        text: `-----BEGIN PRIVATE KEY-----\n${"private-material".repeat(800)}`,
        secret: "private-material",
        tail: "[REDACTED]"
      },
      {
        name: "long ordinary quoted message",
        text: `message: '${"ordinary text ".repeat(800)}' readable tail`,
        secret: "[REDACTED]",
        tail: "readable tail"
      }
    ]
  ) {
    it.live(`retains safe diagnostics for ${diagnostic.name}`, () =>
      Effect.gen(function*() {
        const guest = yield* limitedGuest({
          noise: Stream.succeed(new TextEncoder().encode(diagnostic.text)),
          failure: "refused"
        })
        const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: guest.provider,
          session: "bounded-diagnostics",
          entry: pure
        }))
        expect(failure.code).toBe("flow_failed")
        expect(failure.message).not.toContain(diagnostic.secret)
        expect(failure.message).toContain(diagnostic.tail)
      }), 60_000)
  }

  for (const fault of ["resultStatFailure", "readbackFailure"] as const) {
    it.live(`reports ${fault} as a session failure`, () =>
      Effect.gen(function*() {
        const guest = yield* limitedGuest({ native: false, [fault]: true })
        const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: guest.provider,
          session: "refused-result-transport",
          entry: pure
        }))
        expect(failure.code).toBe("session_failed")
        expect(failure.message).toContain("the result could not be read back")
        expect(failure.message).toContain(
          fault === "readbackFailure" ? "readback transport refused" : "result transport unavailable"
        )
      }), 60_000)
  }

  it.live("drains noisy streams without a whole-output string collector", () =>
    Effect.gen(function*() {
      const collector = vi.spyOn(Stream, "mkString").mockClear()
      let drained = 0
      const bytes = new TextEncoder().encode("x".repeat(16_384))
      const noise = Stream.fromIterable(Array.from({ length: 256 }, () => bytes)).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            drained++
          })
        )
      )
      try {
        const guest = yield* limitedGuest({ noise, failure: "noisy failure" })
        const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
          provider: guest.provider,
          session: "noisy",
          entry: pure
        }))
        expect(failure.code).toBe("flow_failed")
        // The shared line redactor never shows a line past its bound, only its marker.
        expect(failure.message).toContain(
          `stdout: ${Redaction.omittedLine}; stderr: ${Redaction.omittedLine}`
        )
        expect(failure.message.length).toBeLessThan(8400)
        expect(drained).toBe(512)
        expect(collector).not.toHaveBeenCalled()
      } finally {
        collector.mockRestore()
      }
    }), 60_000)
})

describe("SandboxedFlow.execute failures", () => {
  const run = <
    Tag extends string,
    Payload extends Flow.AnyStructSchema,
    Success extends Schema.Top,
    Error extends Schema.Top,
    Requires
  >(
    flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
    payload: Payload["Type"],
    options: Partial<SandboxedFlow.ExecuteOptions>
  ) =>
    Effect.gen(function*() {
      const directory = yield* provider
      return yield* failureOf(
        SandboxedFlow.execute(flow, payload, {
          provider: directory,
          session: `failure-${Date.now()}-${Math.random()}`,
          entry,
          ...options
        })
      )
    })

  it.live("refuses an entry the bundler cannot find", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { entry: join(root, "missing-entry.ts") })
      expect(failure.code).toBe("bundle_failed")
      expect(failure.message).toContain("could not be bundled")
      expect(failure.message).toContain("missing-entry.ts")
    }), 60_000)

  it.live("refuses an entry that is not a file", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { entry: new URL("https://example.invalid/child.ts") })
      expect(failure.code).toBe("bundle_failed")
      expect(failure.message).toContain("https://example.invalid/child.ts")
    }), 60_000)

  it.live("reports a provider that cannot supply the machine", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, {
        provider: {
          acquire: () => Effect.fail(new ProviderError({ code: "unavailable", message: "no machines left" }))
        }
      })
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("no machines left")
    }), 60_000)

  it.live("redacts provider messages and nested causes in the returned error", () =>
    Effect.gen(function*() {
      const secret = "synthetic-provider-credential-NOT-A-REAL-SECRET"
      const cause = Object.assign(new Error(`request failed: password=${secret}`), {
        password: secret,
        headers: { Authorization: `Bearer ${secret}` }
      })
      const failure = yield* run(Sum, { n: 1 }, {
        provider: {
          acquire: () =>
            Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `provider refused: Bearer ${secret}`,
                cause
              })
            )
        }
      })
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("provider refused: Bearer [REDACTED_TOKEN]")
      expect(JSON.stringify(failure)).not.toContain(secret)
      expect(String(failure.cause)).not.toContain(secret)
      expect(failure.cause).toMatchObject({
        cause: {
          message: "request failed: password=[REDACTED]",
          password: "[REDACTED]",
          headers: { Authorization: "[REDACTED]" }
        }
      })
    }), 60_000)

  for (const mode of ["failed", "missing", "invalid", "nonzero"] as const) {
    it.live(`redacts guest diagnostics before truncating output for ${mode} results`, () =>
      Effect.gen(function*() {
        const secret = "synthetic-output-credential-NOT-A-REAL-SECRET"
        // The credential prefix falls outside the raw tail bound.
        const chatter = `Bearer ${secret.repeat(150)}`
        const result = JSON.stringify({ status: "failed", error: `password=${secret}` })
        const body = [
          `printf '%s' '${chatter}'`,
          `printf '%s' '${chatter}' >&2`,
          mode === "failed"
            ? `node -e 'const fs = require("node:fs"); const { attempt } = JSON.parse(fs.readFileSync(process.env.SMITHERS_SANDBOX_REQUEST_PATH, "utf8")); fs.writeFileSync(process.env.SMITHERS_SANDBOX_RESULT_PATH, JSON.stringify({ ...${result}, attempt }));'`
            : "",
          mode === "invalid" ? `printf garbage > "$SMITHERS_SANDBOX_RESULT_PATH"` : "",
          mode === "nonzero" ? "exit 1" : ""
        ].join("\n")
        const failure = yield* run(Sum, { n: 1 }, { runtime: guestRuntime(`redacted-${mode}`, body) })
        expect(failure.code).toBe(
          mode === "failed" ? "flow_failed" : mode === "nonzero" ? "guest_failed" : "result_unreadable"
        )
        expect(failure.message).toContain("stderr: Bearer [REDACTED_TOKEN]")
        if (mode !== "nonzero") expect(failure.message).toContain("stdout: Bearer [REDACTED_TOKEN]")
        expect(JSON.stringify(failure)).not.toContain(secret)
      }), 60_000)
  }

  it.live("names the runtime the image does not contain", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { runtime: "definitely-not-a-runtime-xyz" })
      expect(failure.code).toBe("guest_failed")
      expect(failure.message).toContain("no runnable `definitely-not-a-runtime-xyz`")
      expect(failure.message).toContain("installs none")
    }), 60_000)

  it.live("reports a guest that exits non-zero without fabricating a result", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { runtime: "false" })
      expect(failure.code).toBe("guest_failed")
      expect(failure.message).toContain("exited 1")
      expect(failure.message).toContain("stderr: (empty)")
    }), 60_000)

  it.live("reports a guest that exits 0 without writing a result, quoting its stderr", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { runtime: guestRuntime("no-result", "echo nothing to report >&2") })
      expect(failure.code).toBe("result_unreadable")
      expect(failure.message).toContain("without writing a result")
      expect(failure.message).toContain("stderr: nothing to report")
    }), 60_000)

  for (const status of ["succeeded", "failed", "missing-attempt"] as const) {
    it.live(`refuses a ${status} result not bound to the current attempt`, () =>
      Effect.gen(function*() {
        const result = status === "missing-attempt"
          ? { status: "succeeded", output: 17 }
          : { attempt: "earlier-attempt", status, output: 17, error: "earlier failure" }
        const failure = yield* run(Sum, { n: 99 }, {
          runtime: guestRuntime(
            `replayed-${status}`,
            `printf '%s' '${JSON.stringify(result)}' > "$SMITHERS_SANDBOX_RESULT_PATH"`
          )
        })
        expect(failure.code).toBe("result_unreadable")
        expect(failure.message).toContain(
          status === "missing-attempt" ? "not the protocol's JSON" : "different attempt"
        )
      }), 60_000)
  }

  it.live("reports a workspace that refuses removal of the previous result", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* run(Sum, { n: 1 }, {
        provider: {
          acquire: (key) =>
            Effect.map(directory.acquire(key), (session) => ({
              ...session,
              files: {
                ...session.files,
                remove: () =>
                  Effect.fail(PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    description: "removal refused"
                  }))
              }
            }))
        }
      })
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the previous result could not be removed")
      expect(failure.message).toContain("removal refused")
    }), 60_000)

  it.live("reports a result that is not the protocol's JSON, quoting the guest's stdout", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, {
        runtime: guestRuntime("bad-result", `echo wrote garbage; printf garbage > "$SMITHERS_SANDBOX_RESULT_PATH"`)
      })
      expect(failure.code).toBe("result_unreadable")
      expect(failure.message).toContain("not the protocol's JSON")
      expect(failure.message).toContain("stdout: wrote garbage")
    }), 60_000)

  it.live("surfaces a failed child flow with its error and the guest's output", () =>
    Effect.gen(function*() {
      const failure = yield* run(Failing, { reason: "the guest said no", chatter: 5000 }, {})
      expect(failure.code).toBe("flow_failed")
      expect(failure.message).toContain("flows/SandboxedFlow/fixtures/Failing failed in the guest")
      // The typed error arrives as its tag and fields, not as a stack trace.
      expect(failure.message).toContain("flows/SandboxedFlow/fixtures/Refused {\"reason\":\"the guest said no\"}")
      expect(failure.message).not.toContain("    at ")
      // Long output is quoted from its tail, marked as cut.
      expect(failure.message).toContain("stdout: …ccc")
      expect(failure.message).not.toContain("c".repeat(5000))
    }), 60_000)

  it.live("surfaces an entry that exports no flow of the requested tag", () =>
    Effect.gen(function*() {
      const Unknown = Flow.make("flows/SandboxedFlow/fixtures/Unknown", {
        payload: { n: Schema.Number },
        success: Schema.Number,
        body: (payload) => Node.succeed(payload.n)
      })
      const failure = yield* run(Unknown, { n: 1 }, {})
      expect(failure.code).toBe("flow_failed")
      expect(failure.message).toContain("exports no flow tagged \"flows/SandboxedFlow/fixtures/Unknown\"")
      expect(failure.message).toContain("stdout: (empty); stderr: (empty)")
    }), 60_000)

  it.live("refuses an output the host's success schema does not decode", () =>
    Effect.gen(function*() {
      // The host's declaration drifted from the one the guest bundles: same
      // tag, a different success schema.
      const Drifted = Flow.make("flows/SandboxedFlow/fixtures/Sum", {
        payload: { n: Schema.Number },
        success: Schema.String,
        body: () => Node.succeed("")
      })
      const failure = yield* run(Drifted, { n: 1 }, {})
      expect(failure.code).toBe("result_invalid")
      expect(failure.message).toContain("does not decode through the success schema")
    }), 60_000)

  it.live("refuses a result larger than the limit", () =>
    Effect.gen(function*() {
      const failure = yield* run(Filler, { bytes: 20_000 }, { limits: { resultBytes: 1024 } })
      expect(failure.code).toBe("result_overflow")
      expect(failure.message).toContain("the limit is 1024")
    }), 60_000)

  it.live("refuses a diff with more files than the limit", () =>
    Effect.gen(function*() {
      const failure = yield* run(Writer, { count: 5, bytes: 1, directory: "many" }, {
        collectDiff: true,
        limits: { files: 2 }
      })
      expect(failure.code).toBe("diff_overflow")
      expect(failure.message).toContain("changed more than 2 files; the limit is 2")
    }), 60_000)

  it.live("refuses a diff with more bytes than the limit", () =>
    Effect.gen(function*() {
      const failure = yield* run(Writer, { count: 2, bytes: 4096, directory: "large" }, {
        collectDiff: true,
        limits: { diffBytes: 4096 }
      })
      expect(failure.code).toBe("diff_overflow")
      expect(failure.message).toContain("hold 8192 bytes; the limit is 4096")
    }), 60_000)

  it.live(
    "convicts a guest that outlives the wall-clock deadline and releases the machine",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const started = Date.now()
        const failure = yield* failureOf(
          SandboxedFlow.execute(Sleeper, { ms: 60_000 }, {
            provider: directory,
            session: "sleeper",
            entry,
            timeout: Duration.millis(1500)
          })
        )
        expect(failure.code).toBe("deadline_exceeded")
        expect(failure.message).toContain("1500 milliseconds")
        expect(Date.now() - started).toBeLessThan(30_000)
        expect(readdirSync(root)).toEqual([])
      }),
    60_000
  )

  it.live("reports a workspace that refuses the bundle", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { writeFile: (path) => path.endsWith("bundle.mjs") }),
          session: "refuses-bundle",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the bundle could not be written")
    }), 60_000)

  it.live("reports a workspace that refuses the request", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { writeFile: (path) => path.endsWith("request.json") }),
          session: "refuses-request",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the request could not be written")
    }), 60_000)

  it.live("reports a session that cannot start the runtime", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { spawn: true }),
          session: "refuses-spawn",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("could not be run in the session")
      expect(failure.message).toContain("spawn refused")
    }), 60_000)

  it.live("reports a result the session cannot read back", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { readFile: (path) => path.endsWith("result.json") }),
          session: "refuses-result",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the result could not be read back")
    }), 60_000)

  it.live("reports a changed file the session cannot read back", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Writer, { count: 1, bytes: 1, directory: "unreadable" }, {
          provider: faulty(directory, { readFile: (path) => path.endsWith("file-0.bin") }),
          session: "refuses-diff",
          entry,
          collectDiff: true
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the changed file unreadable/file-0.bin could not be read back")
    }), 60_000)

  it.live("reports a changed path that cannot be resolved", () =>
    Effect.gen(function*() {
      const guest = yield* limitedGuest({ files: ["changed"] })
      const unresolvable: Sandbox.Provider = {
        acquire: (key) =>
          Effect.map(guest.provider.acquire(key), (session) => ({
            ...session,
            files: {
              ...session.files,
              realPath: () =>
                Effect.fail(PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "realPath",
                  description: "resolution refused"
                }))
            }
          }))
      }
      const failure = yield* failureOf(SandboxedFlow.execute(pureEntry.Constant, { value: "ok" }, {
        provider: unresolvable,
        session: "refuses-resolution",
        entry: pure,
        collectDiff: true
      }))
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("could not be resolved")
      expect(failure.message).toContain("resolution refused")
    }), 60_000)

  it.live("reports a workspace that cannot be listed", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { readDirectory: true }),
          session: "refuses-listing",
          entry,
          collectDiff: true
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the workspace could not be listed")
      expect(failure.message).toContain("listing refused")
    }), 60_000)
})

describe("SandboxedFlow.action on an engine", () => {
  const RunSum = SandboxedFlow.action(Sum)
  const Parent = Flow.make("flows/SandboxedFlow/test/Parent", {
    payload: { n: Schema.Number },
    success: SandboxedFlow.resultSchema(Schema.Number),
    error: SandboxedFlow.SandboxedFlowError,
    body: (payload) => RunSum.call(payload)
  })

  const engine = <R>(implementation: Layer.Layer<Action.Requirement<typeof RunSum.name>, never, R>) =>
    Layer.mergeAll(implementation, Interpreter.layer(Parent)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Engine.FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )

  it("declares the action over the child's schemas under a derived tag", () => {
    expect(RunSum.name).toBe("flows/SandboxedFlow/fixtures/Sum/sandboxed")
    expect(SandboxedFlow.action(Sum, { name: "custom/RunSum" }).name).toBe("custom/RunSum")
    expect(RunSum.payloadSchema).toBe(Sum.payloadSchema)
    expect(RunSum.errorSchema).toBe(SandboxedFlow.SandboxedFlowError)
  })

  it("keeps distinct implementation requirements for default and custom names", () => {
    const Other = SandboxedFlow.action(Sum, { name: "custom/OtherSum" })
    const Both = Flow.make("flows/SandboxedFlow/test/Both", {
      payload: { n: Schema.Number },
      success: Schema.Struct({ first: RunSum.successSchema, second: Other.successSchema }),
      error: SandboxedFlow.SandboxedFlowError,
      body: (payload) => Node.all({ first: RunSum.call(payload), second: Other.call(payload) })
    })
    const first = RunSum.toLayer(() => Effect.succeed({ output: 1, diff: [], deleted: [] }))
    const second = Other.toLayer(() => Effect.succeed({ output: 2, diff: [], deleted: [] }))
    const partial = Layer.mergeAll(first, Interpreter.layer(Both)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Engine.FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const complete = Layer.mergeAll(first, second, Interpreter.layer(Both)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Engine.FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const requiresNoServices = <A, E>(_effect: Effect.Effect<A, E>) => {}
    // @ts-expect-error implementing RunSum must not discharge Other's requirement
    requiresNoServices(Both.execute({ n: 1 }).pipe(Effect.provide(partial)))
    requiresNoServices(Both.execute({ n: 1 }).pipe(Effect.provide(complete)))
    const defaultName: "flows/SandboxedFlow/fixtures/Sum/sandboxed" = RunSum.name
    const customName: "custom/OtherSum" = Other.name
    expect(defaultName).toBe("flows/SandboxedFlow/fixtures/Sum/sandboxed")
    expect(customName).toBe("custom/OtherSum")
  })

  it.live(
    "gives identical parallel calls distinct session keys without overlapping a key",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const bothAcquired = yield* Deferred.make<void>()
        const keys: Array<string> = []
        const active = new Map<string, number>()
        let peakPerKey = 0
        let peakTotal = 0
        const exclusive: Sandbox.Provider = {
          acquire: (key) =>
            Effect.gen(function*() {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  keys.push(key)
                  active.set(key, (active.get(key) ?? 0) + 1)
                  peakPerKey = Math.max(peakPerKey, active.get(key)!)
                  peakTotal = Math.max(peakTotal, [...active.values()].reduce((a, b) => a + b, 0))
                }),
                () =>
                  Effect.sync(() => {
                    active.set(key, active.get(key)! - 1)
                  })
              )
              if (keys.length === 2) yield* Deferred.succeed(bothAcquired, undefined)
              yield* Deferred.await(bothAcquired)
              if (peakPerKey > 1) {
                return yield* Effect.fail(new ProviderError({ code: "unknown", message: "overlapping session key" }))
              }
              return yield* directory.acquire(key)
            })
        }
        const Parallel = Flow.make("flows/SandboxedFlow/test/Parallel", {
          payload: { n: Schema.Number },
          success: Schema.Struct({ first: RunSum.successSchema, second: RunSum.successSchema }),
          error: SandboxedFlow.SandboxedFlowError,
          body: (payload) => Node.all({ first: RunSum.call(payload), second: RunSum.call(payload) })
        })
        const implementation = SandboxedFlow.toLayer(RunSum, Sum, ({ executionId, callId }) => ({
          provider: exclusive,
          session: `child:${executionId}:${callId}`,
          entry
        }))
        const layers = Layer.mergeAll(implementation, Interpreter.layer(Parallel)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Engine.FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
        const exit = yield* Parallel.execute({ n: 5 }, { executionId: "parent-parallel" }).pipe(
          Effect.provide(layers),
          Effect.exit
        )
        expect(keys).toHaveLength(2)
        expect(new Set(keys).size).toBe(2)
        expect(keys.every((key) => key.startsWith("child:parent-parallel:"))).toBe(true)
        expect(peakTotal).toBe(2)
        expect(peakPerKey).toBe(1)
        expect([...active.values()]).toEqual([0, 0])
        expect(Exit.isSuccess(exit) && exit.value).toEqual({
          first: { output: 16, diff: [], deleted: [] },
          second: { output: 16, diff: [], deleted: [] }
        })
      }),
    60_000
  )

  for (const recovery of ["retry", "resume"] as const) {
    it.live(`preserves the call identity across ${recovery}`, () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const keys: Array<string> = []
        const callIds: Array<string> = []
        const Recover = Action.make(`flows/SandboxedFlow/test/${recovery}/action`, {
          payload: Sum.payloadSchema,
          success: RunSum.successSchema,
          error: SandboxedFlow.SandboxedFlowError,
          retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 })
        })
        const Recovering = Flow.make(`flows/SandboxedFlow/test/${recovery}`, {
          payload: Sum.payloadSchema,
          success: RunSum.successSchema,
          error: SandboxedFlow.SandboxedFlowError,
          body: (payload) => Recover.call(payload)
        })
        const interrupted: Sandbox.Provider = {
          acquire: (key) =>
            Effect.gen(function*() {
              keys.push(key)
              if (keys.length === 1) {
                if (recovery === "retry") {
                  return yield* Effect.fail(new ProviderError({ code: "unknown", message: "retry acquisition" }))
                }
                const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
                return yield* Flow.suspend(Option.getOrThrow(instance))
              }
              return yield* directory.acquire(key)
            })
        }
        const implementation = SandboxedFlow.toLayer(Recover, Sum, ({ executionId, callId }) => {
          callIds.push(callId)
          return { provider: interrupted, session: `child:${executionId}:${callId}`, entry }
        })
        const layers = Layer.mergeAll(implementation, Interpreter.layer(Recovering)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Engine.FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
        const executionId = `parent-${recovery}`
        const result = yield* Effect.gen(function*() {
          if (recovery === "resume") {
            yield* Recovering.execute({ n: 5 }, { executionId, discard: true })
            let parked = yield* Recovering.poll(executionId)
            for (let i = 0; i < 1000 && Option.isNone(parked); i++) {
              yield* Effect.sleep("1 milli")
              parked = yield* Recovering.poll(executionId)
            }
            expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
            yield* Recovering.resume(executionId)
          }
          return yield* Recovering.execute({ n: 5 }, { executionId })
        }).pipe(Effect.provide(layers))
        expect(result).toEqual({ output: 16, diff: [], deleted: [] })
        expect(callIds).toHaveLength(2)
        expect(callIds[0]).toEqual(expect.any(String))
        expect(callIds[0]!.length).toBeGreaterThan(0)
        expect(callIds[1]).toBe(callIds[0])
        expect(keys).toEqual([`child:${executionId}:${callIds[0]}`, `child:${executionId}:${callIds[0]}`])
      }), 60_000)
  }

  it.live("refuses a runtime without a stable invocation key before acquiring a session", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const keys: Array<string> = []
      const instance = Engine.FlowEngine.makeInstance(Parent, "parent-unidentified")
      const exit = yield* Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const unidentified = FlowRuntime.FlowRuntime.of({
          ...runtime,
          actionExecute: (action) =>
            Effect.map(Effect.exit(action.executeEncoded), (exit) => new Flow.Complete({ exit }))
        })
        return yield* Interpreter.interpret(RunSum.call({ n: 1 })).pipe(
          Effect.provideService(FlowRuntime.FlowRuntime, unidentified),
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.exit
        )
      }).pipe(Effect.provide(engine(SandboxedFlow.toLayer(RunSum, Sum, {
        provider: recording(directory, keys),
        session: "unidentified",
        entry
      }))))
      expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
        _tag: "Die",
        defect: expect.stringContaining("Action.CurrentInvocationKey")
      })
      expect(keys).toEqual([])
    }))

  it.live("runs the child as one action of the parent's plan", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* Parent.execute({ n: 31 }, { executionId: "parent-static" }).pipe(
        Effect.provide(
          engine(SandboxedFlow.toLayer(RunSum, Sum, { provider: directory, session: "action-static", entry }))
        )
      )
      expect(result).toEqual({ output: 42, diff: [], deleted: [] })
    }), 60_000)

  it.live("derives the placement from the call and the parent execution", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const keys: Array<string> = []
      const result = yield* Parent.execute({ n: 5 }, { executionId: "parent-derived" }).pipe(
        Effect.provide(
          engine(
            SandboxedFlow.toLayer(RunSum, Sum, ({ executionId, payload }) => ({
              provider: recording(directory, keys),
              session: `child:${executionId}:${payload.n}`,
              entry
            }))
          )
        )
      )
      expect(result.output).toBe(16)
      expect(keys).toEqual(["child:parent-derived:5"])
    }), 60_000)

  it.live("fails the parent with the typed error the sandbox reported", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* Effect.flip(
        Parent.execute({ n: 1 }, { executionId: "parent-failing" }).pipe(
          Effect.provide(
            engine(SandboxedFlow.toLayer(RunSum, Sum, {
              provider: directory,
              session: "action-failing",
              entry: join(root, "no-such-entry.ts")
            }))
          )
        )
      )
      expect(failure).toBeInstanceOf(SandboxedFlow.SandboxedFlowError)
      expect((failure as SandboxedFlow.SandboxedFlowError).code).toBe("bundle_failed")
    }), 60_000)
})

describe("the result schema", () => {
  it("encodes a result with its bytes as base64 for the journal", () => {
    const encoded = Schema.encodeSync(Schema.toCodecJson(SandboxedFlow.resultSchema(Schema.Number)))({
      output: 42,
      diff: [{ path: "a.bin", bytes: new Uint8Array([1, 2, 3]) }],
      deleted: ["gone.txt"]
    })
    expect(encoded).toEqual({ output: 42, diff: [{ path: "a.bin", bytes: "AQID" }], deleted: ["gone.txt"] })
  })

  it("decodes a result journaled before deleted existed with no deletions", () => {
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(SandboxedFlow.resultSchema(Schema.Number)))({
      output: 42,
      diff: []
    })
    expect(decoded).toEqual({ output: 42, diff: [], deleted: [] })
  })

  it("carries the 0.x bundle limits as its defaults", () => {
    expect(SandboxedFlow.defaultLimits).toEqual({
      resultBytes: 5 * 1024 * 1024,
      diffBytes: 100 * 1024 * 1024,
      files: 1000
    })
  })
})

describe("the guest crypto", () => {
  it.live("digests exactly as the host's NodeCrypto does", () =>
    Effect.gen(function*() {
      const material = new TextEncoder().encode("the same key material on both sides of the machine boundary")
      const host = yield* Crypto.Crypto
      const inGuest = yield* Guest.guestCrypto.digest("SHA-256", material)
      const onHost = yield* host.digest("SHA-256", material)
      expect(inGuest).toEqual(onHost)
      expect(yield* Guest.guestCrypto.randomBytes(16)).toHaveLength(16)
    }).pipe(Effect.provide(NodeCrypto.layer)))
})

describe("the guest runner in process", () => {
  const scratch = mkdtempSync(join(tmpdir(), "flows-sandboxed-guest-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  const request = (name: string, body: Omit<typeof Guest.Request.Type, "attempt">): Guest.Environment => {
    const requestPath = join(scratch, `${name}.request.json`)
    writeFileSync(requestPath, JSON.stringify({ ...body, attempt: name }))
    return {
      SMITHERS_SANDBOX_REQUEST_PATH: requestPath,
      SMITHERS_SANDBOX_RESULT_PATH: join(scratch, `${name}.result.json`)
    }
  }

  const resultOf = (environment: Guest.Environment): typeof Guest.Result.Type =>
    Schema.decodeUnknownSync(Guest.Result)(
      JSON.parse(readFileSync(environment.SMITHERS_SANDBOX_RESULT_PATH!, "utf8"))
    )

  it("refuses to start without the request path", async () => {
    await expect(Guest.run(childEntry, {})).rejects.toThrow("SMITHERS_SANDBOX_REQUEST_PATH is not set")
  })

  it("refuses to start without the result path", async () => {
    await expect(Guest.run(childEntry, { SMITHERS_SANDBOX_REQUEST_PATH: join(scratch, "unused.json") }))
      .rejects.toThrow("SMITHERS_SANDBOX_RESULT_PATH is not set")
  })

  it("writes the encoded success of the flow the request names", async () => {
    const environment = request("sum", { flow: Sum._tag, executionId: "in-process", payload: { n: 1 } })
    await Guest.run(childEntry, environment)
    expect(resultOf(environment)).toEqual({ attempt: "sum", status: "succeeded", output: 12 })
  })

  it("writes the failure of a flow that failed", async () => {
    const environment = request("failing", {
      flow: Failing._tag,
      executionId: "in-process",
      payload: { reason: "refused in process", chatter: 0 }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status).toBe("failed")
    expect(result.attempt).toBe("failing")
    expect(result.status === "failed" && result.error).toContain("refused in process")
  })

  it("redacts SDK error fields in persisted guest bytes and the returned host error", async () => {
    const secret = "synthetic-review-credential-NOT-A-REAL-SECRET"
    const Crash = Action.make("review/credential-failure", { payload: {}, success: Schema.Void })
    const Child = Flow.make("review/credential-child", {
      payload: {},
      success: Schema.Void,
      body: () => Crash.call({})
    })
    const layer = Crash.toLayer(() =>
      Effect.die(Object.assign(new Error(`SDK request refused: password=${secret}`), {
        password: secret,
        request: { headers: { Authorization: `Bearer ${secret}` }, password: secret },
        statusCode: 401
      }))
    )
    const environment = request("credential", { flow: Child._tag, executionId: "credential", payload: {} })
    await Guest.run({ Child, layer }, environment)
    const bytes = readFileSync(environment.SMITHERS_SANDBOX_RESULT_PATH!)
    const result = resultOf(environment)
    expect(result.status).toBe("failed")
    expect(bytes.toString()).not.toContain(secret)
    expect(result.status === "failed" && result.error).toContain("\"password\":\"[REDACTED]\"")
    expect(result.status === "failed" && result.error).toContain("\"Authorization\":\"[REDACTED]\"")
    expect(result.status === "failed" && result.error).toContain("\"statusCode\":401")

    const directory = await Effect.runPromise(provider)
    const failure = await Effect.runPromise(failureOf(SandboxedFlow.execute(Sum, { n: 1 }, {
      entry,
      session: "credential-readback",
      provider: {
        acquire: (key) =>
          Effect.map(directory.acquire(key), (session) => ({
            ...session,
            files: {
              ...session.files,
              stream: (path) =>
                Stream.unwrap(
                  session.readFile(path).pipe(
                    Effect.orDie,
                    Effect.map((current) => {
                      if (!path.endsWith("/result.json")) return Stream.succeed(current)
                      const { attempt } = JSON.parse(new TextDecoder().decode(current))
                      return Stream.succeed(new TextEncoder().encode(JSON.stringify({ ...result, attempt })))
                    })
                  )
                )
            }
          }))
      }
    })))
    expect(failure.code).toBe("flow_failed")
    expect(failure.message).toContain("SDK request refused")
    expect(JSON.stringify(failure)).not.toContain(secret)
  }, 60_000)

  for (const shape of ["error", "string"] as const) {
    it(`redacts ${shape} failure text before persisting the guest result`, async () => {
      const secret = "synthetic-message-credential-NOT-A-REAL-SECRET"
      const flow = shape === "error" ? childEntry.Dying : childEntry.Plain
      const payload = shape === "error"
        ? { message: `Bearer ${secret}`, shape: "error" }
        : { text: `password=${secret}` }
      const environment = request(`credential-${shape}`, { flow: flow._tag, executionId: "credential", payload })
      await Guest.run(childEntry, environment)
      expect(resultOf(environment).status).toBe("failed")
      const bytes = readFileSync(environment.SMITHERS_SANDBOX_RESULT_PATH!, "utf8")
      expect(bytes).not.toContain(secret)
      expect(bytes).toContain("[REDACTED")
    })
  }

  it("writes a failure for a payload the flow's schema refuses", async () => {
    const environment = request("bad-payload", { flow: Sum._tag, executionId: "in-process", payload: { n: "one" } })
    await Guest.run(childEntry, environment)
    expect(resultOf(environment).status).toBe("failed")
  })

  it("writes a failure for a tag the entry does not export", async () => {
    const environment = request("unknown", { flow: "nowhere/Flow", executionId: "in-process", payload: {} })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toContain("exports no flow tagged \"nowhere/Flow\"")
  })

  it("runs an entry without a layer", async () => {
    const environment = request("pure", {
      flow: pureEntry.Constant._tag,
      executionId: "in-process",
      payload: { value: "still here" }
    })
    await Guest.run(pureEntry, environment)
    expect(resultOf(environment)).toEqual({ attempt: "pure", status: "succeeded", output: "still here" })
  })

  it("drives a child boundary the entry registered beside its flow", async () => {
    const environment = request("nested", {
      flow: childEntry.Nested._tag,
      executionId: "in-process",
      payload: { n: 4 }
    })
    await Guest.run(childEntry, environment)
    expect(resultOf(environment)).toEqual({ attempt: "nested", status: "succeeded", output: 15 })
  })

  it("describes a defect by its name and message", async () => {
    const environment = request("dying", {
      flow: childEntry.Dying._tag,
      executionId: "in-process",
      payload: { message: "boom", shape: "error" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toBe("defect Error: boom")
  })

  it("describes a cyclic defect with the shared redaction marker", async () => {
    const environment = request("dying-cyclic", {
      flow: childEntry.Dying._tag,
      executionId: "in-process",
      payload: { message: "", shape: "cyclic" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toBe(
      "defect failure {\"kind\":\"cyclic\",\"loop\":\"[Circular]\"}"
    )
  })

  it("omits redacted fields that JSON cannot serialize", async () => {
    const Crash = Action.make("review/bigint-failure", { payload: {}, success: Schema.Void })
    const Child = Flow.make("review/bigint-child", {
      payload: {},
      success: Schema.Void,
      body: () => Crash.call({})
    })
    const layer = Crash.toLayer(() => Effect.die({ count: 1n, password: "synthetic-bigint-credential" }))
    const environment = request("bigint", { flow: Child._tag, executionId: "bigint", payload: {} })
    await Guest.run({ Child, layer }, environment)
    expect(resultOf(environment)).toEqual({ attempt: "bigint", status: "failed", error: "defect failure" })
  })

  it("describes a bare failure value as itself", async () => {
    const environment = request("plain", {
      flow: childEntry.Plain._tag,
      executionId: "in-process",
      payload: { text: "plainly refused" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toBe("plainly refused")
  })

  it("describes the engine's refusal of a typed error it cannot encode", async () => {
    const environment = request("cyclic", { flow: childEntry.Cyclic._tag, executionId: "in-process", payload: {} })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    // The engine encodes a typed error for its journal before the runner sees
    // it, so a cyclic one arrives as the engine's own defect.
    expect(result.status === "failed" && result.error).toMatch(/^defect SchemaError: Expected JSON value \{/)
  })

  it("quotes a failure's fields within a bound", async () => {
    const environment = request("dying-large", {
      flow: childEntry.Dying._tag,
      executionId: "in-process",
      payload: { message: "d".repeat(5000), shape: "large" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    const error = result.status === "failed" ? result.error : ""
    expect(error.startsWith("defect failure {\"detail\":\"ddd")).toBe(true)
    expect(error.endsWith("…")).toBe(true)
    expect(error.length).toBeLessThan(1100)
  })

  it("describes an interruption", async () => {
    const environment = request("interrupting", {
      flow: childEntry.Interrupting._tag,
      executionId: "in-process",
      payload: {}
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toContain("interrupted")
  })
})
