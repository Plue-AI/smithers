/**
 * Shared contract suite for complete Host bundles.
 *
 * This module is emitted as ESM, CJS, and declarations and exported from
 * `@smthrs/kernel/test/contract`. It intentionally has a Vitest peer because
 * it registers a reusable behavioral contract for third-party Host bundles.
 *
 * @since 1.0.0-rc.0
 */

// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import { describe, expect, it } from "@effect/vitest"
import * as JjService from "@smthrs/jj"
import type { Jj, JjErrorCode } from "@smthrs/jj"
import { Deferred, Effect, Fiber, FileSystem, type Layer, Option, Path, Stream } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as FileSystemBatchContract from "./FileSystemBatchContract.ts"

export { check as checkFileSystemBatch } from "./FileSystemBatchContract.ts"

/**
 * A capability that must fail with a stable typed code.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FailureCapability<Code extends string> {
  readonly expected: "failure"
  readonly code: Code
}

/**
 * Successful filesystem contract options.
 *
 * `scratchPath` is required only for hosts whose filesystem does not accept an
 * OS temp path — an in-memory double, say. Omitting it takes
 * {@link defaultScratchPath}, which is process-scoped and outside the working
 * tree.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FileSystemSuccess {
  readonly expected: "success"
  readonly scratchPath?: string | undefined
  /** Operations this otherwise available host deliberately refuses. */
  readonly unsupported?: Partial<Record<FileSystemOperation, string>> | undefined
}

/**
 * Every method on Effect's closed filesystem service.
 * @category constants
 * @since 1.0.0-rc.0
 */
export const FileSystemOperations = [
  "access",
  "copy",
  "copyFile",
  "chmod",
  "chown",
  "glob",
  "exists",
  "link",
  "makeDirectory",
  "makeTempDirectory",
  "makeTempDirectoryScoped",
  "makeTempFile",
  "makeTempFileScoped",
  "open",
  "readDirectory",
  "readFile",
  "readFileString",
  "readLink",
  "realPath",
  "remove",
  "rename",
  "sink",
  "stat",
  "stream",
  "symlink",
  "truncate",
  "utimes",
  "watch",
  "writeFile",
  "writeFileString"
] as const

/**
 * One method of Effect's closed filesystem service.
 * @category models
 * @since 1.0.0-rc.0
 */
export type FileSystemOperation = typeof FileSystemOperations[number]

/**
 * Successful Path contract expectation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PathSuccess {
  readonly expected: "success"
}

/**
 * Successful `ChildProcessSpawner` contract options.
 *
 * Defaults use the current Node or Bun executable. In-process browser
 * doubles can provide their own scripted commands and expected output.
 *
 * There is no timeout case: a wall-clock budget is `Effect.timeout` around any
 * effect, not a per-spawn option, so there is nothing host-specific left to
 * assert.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ChildProcessSuccess {
  readonly expected: "success"
  readonly execCommand?: ChildProcess.Command | undefined
  readonly expectedStdout?: string | undefined
  readonly streamCommand?: ChildProcess.Command | undefined
  readonly expectedStreamText?: string | undefined
  /** A command carrying `cwd` and `env` options through to the child. */
  readonly optionsCommand?: ChildProcess.Command | undefined
  readonly expectedOptionsStdout?: string | undefined
  /**
   * How the host handles a command fed from a `stdin` stream: the expected
   * stdout when it supports one, or the typed code when it does not.
   */
  readonly stdin?:
    | { readonly command: ChildProcess.Command; readonly expectedStdout: string }
    | FailureCapability<string>
    | undefined
  /** A two-leg pipeline, or the exact typed refusal for hosts without one. */
  readonly pipeline?:
    | { readonly command: ChildProcess.Command; readonly expectedStdout: string }
    | FailureCapability<string>
    | undefined
  readonly interruptCommand?: ChildProcess.Command | undefined
}

/**
 * Successful Jj contract expectation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface JjSuccess {
  readonly expected: "success"
  /** Makes the first and second snapshots observably different. */
  readonly prepareChange?: ((phase: "first" | "second") => Effect.Effect<void, unknown>) | undefined
  /** Nonexistent path at which the contract may add one temporary workspace. */
  readonly workspacePath?: string | undefined
  /** Path whose repository root the host must resolve. */
  readonly rootFrom?: string | undefined
  /** Optional methods this otherwise available backend explicitly refuses. */
  readonly unsupported?: Partial<Record<"root" | "revert", JjErrorCode>> | undefined
}

/**
 * Every method on the closed Jj host service.
 * @category constants
 * @since 1.0.0-rc.0
 */
export const JjOperations = [
  "snapshot",
  "restore",
  "diff",
  "workspaceAdd",
  "workspaceForget",
  "status",
  "root",
  "revert"
] as const

/**
 * One method of the closed Jj host service.
 * @category models
 * @since 1.0.0-rc.0
 */
export type JjOperation = typeof JjOperations[number]

/**
 * Successful HTTP contract probe.
 *
 * A request is explicit so the shared suite never invents a live network call.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HttpClientProbe {
  /** Exact request the host must execute. */
  readonly request: HttpClientRequest.HttpClientRequest
  /** Adapter-specific response proof. */
  readonly assertResponse: (response: HttpClientResponse.HttpClientResponse) => void
}

/**
 * Successful read/write/redirect HTTP contract probes.
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HttpClientSuccess {
  readonly expected: "success"
  /** Safe read method. */
  readonly read: HttpClientProbe
  /** Body-carrying write method. */
  readonly write: HttpClientProbe
  /** Manual redirect response; the host must not follow it below the guard. */
  readonly redirect: HttpClientProbe
}

/**
 * Complete capability expectations for the closed five-tag Host surface.
 * Unsupported capabilities are asserted with their code and are never skipped.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HostContractCapabilities {
  readonly fileSystem: FileSystemSuccess | FailureCapability<string>
  readonly path: PathSuccess | FailureCapability<string>
  readonly childProcess: ChildProcessSuccess | FailureCapability<string>
  readonly jj: JjSuccess | FailureCapability<JjErrorCode>
  readonly httpClient: HttpClientSuccess | FailureCapability<string>
}

/**
 * The full layer output required by the contract.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type HostContractLayer = Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | Jj | HttpClient,
  unknown
>

/**
 * Normalizes the code a Host failure is identified by, across the three shapes
 * the closed surface produces: a `code` field (`JjError`), a nested
 * `reason._tag` (`PlatformError`, `HttpClientError`), and a bare `_tag`.
 * Anything else is uncoded.
 *
 * @category testing
 * @since 1.0.0-rc.0
 */
export const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  if ("code" in error && typeof error.code === "string") return error.code
  if (
    "reason" in error &&
    typeof error.reason === "object" &&
    error.reason !== null &&
    "_tag" in error.reason &&
    typeof error.reason._tag === "string"
  ) {
    return error.reason._tag
  }
  if ("_tag" in error && typeof error._tag === "string") return error._tag
  return undefined
}

/**
 * Asserts that `effect` fails with `code`. Succeeding is itself a contract
 * violation: a capability declared unsupported must never quietly work.
 *
 * @category testing
 * @since 1.0.0-rc.0
 */
export const assertFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  code: string
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => {
        expect(errorCode(error)).toBe(code)
      },
      onSuccess: () => {
        throw new Error(`expected typed failure ${code}`)
      }
    })
  )

let scratchSeq = 0

/**
 * Allocates the scratch file path a contract bundle writes through when the
 * caller declares no `scratchPath` of its own.
 *
 * The path is absolute under the OS temp directory and scoped by both process
 * id and an allocation counter. A repo-relative default would put the file in
 * the working tree, where it is neither ignored by git nor private to one test
 * process: concurrent `vitest run` invocations would then race the same path,
 * and the suite's `ensuring` remove could truncate a sibling's file between its
 * write and its read.
 *
 * @category testing
 * @since 1.0.0-rc.0
 */
export const defaultScratchPath = (suite: string): string => {
  const slug = suite.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "host"
  // Ambient `process.pid` on purpose: this is a Node-only test harness that
  // must name a path unique to THIS operating-system process before any layer
  // exists to ask. Injecting it would only move the same read one frame out.
  return join(tmpdir(), `flows-host-contract-${process.pid}-${++scratchSeq}-${slug}`)
}

const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: HostContractLayer
): Effect.Effect<A, E | unknown> => effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E | unknown>

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: HostContractLayer) => provide(effect, layer)

const unsupported = ChildProcess.make("host-contract-unsupported")

const unsupportedChildProcess = (operation: "string" | "stream", code: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    yield* operation === "stream"
      ? assertFailure(Stream.runDrain(spawner.streamString(unsupported)), code)
      : assertFailure(spawner.string(unsupported), code)
  })

const fileSystemProbe = (
  fs: FileSystem.FileSystem,
  operation: FileSystemOperation,
  root: string
): Effect.Effect<unknown, unknown, unknown> => {
  const at = (name: string): string => `${root}/${operation}-${name}`
  const source = `${root}/source.txt`
  const bytes = new TextEncoder().encode("host-contract")
  switch (operation) {
    case "access":
      return fs.access(source)
    case "copy":
      return fs.copy(source, at("copy.txt"))
    case "copyFile":
      return fs.copyFile(source, at("copy-file.txt"))
    case "chmod":
      return fs.chmod(source, 0o600)
    case "chown":
      return Effect.flatMap(fs.stat(source), (info) =>
        fs.chown(
          source,
          Option.getOrElse(info.uid, () => 0),
          Option.getOrElse(info.gid, () => 0)
        ))
    case "glob":
      return fs.glob("**/*.txt", { root })
    case "exists":
      return Effect.tap(fs.exists(source), (exists) => Effect.sync(() => expect(exists).toBe(true)))
    case "link":
      return fs.link(source, at("hard-link.txt"))
    case "makeDirectory":
      return fs.makeDirectory(at("directory"), { recursive: true })
    case "makeTempDirectory":
      return fs.makeTempDirectory({ directory: root })
    case "makeTempDirectoryScoped":
      return Effect.scoped(fs.makeTempDirectoryScoped({ directory: root }))
    case "makeTempFile":
      return fs.makeTempFile({ directory: root })
    case "makeTempFileScoped":
      return Effect.scoped(fs.makeTempFileScoped({ directory: root }))
    case "open":
      return Effect.scoped(fs.open(source, { flag: "r" }))
    case "readDirectory":
      return Effect.tap(fs.readDirectory(root), (entries) =>
        Effect.sync(() => {
          expect(Array.isArray(entries)).toBe(true)
          expect(entries.every((entry) => typeof entry === "string")).toBe(true)
        }))
    case "readFile":
      return Effect.gen(function*() {
        const first = yield* fs.readFile(source)
        expect(first).toBeInstanceOf(Uint8Array)
        const original = first[0]
        expect(original).toBeDefined()
        first[0] = original! ^ 0xff
        const second = yield* fs.readFile(source)
        expect(second[0]).toBe(original)
      })
    case "readFileString":
      return fs.readFileString(source)
    case "readLink": {
      const link = at("symbolic-link.txt")
      return fs.symlink(source, link).pipe(Effect.andThen(fs.readLink(link)))
    }
    case "realPath":
      return fs.realPath(source)
    case "remove": {
      const path = at("remove.txt")
      return fs.writeFile(path, bytes).pipe(Effect.andThen(fs.remove(path)))
    }
    case "rename": {
      const from = at("rename-from.txt")
      return fs.writeFile(from, bytes).pipe(Effect.andThen(fs.rename(from, at("rename-to.txt"))))
    }
    case "sink":
      return Stream.run(Stream.succeed(bytes), fs.sink(at("sink.txt")))
    case "stat":
      return Effect.tap(fs.stat(source), (info) =>
        Effect.sync(() => {
          expect(typeof info.size).toBe("bigint")
          expect(typeof info.type).toBe("string")
        }))
    case "stream":
      return Stream.runForEach(
        fs.stream(source),
        (chunk) => Effect.sync(() => expect(chunk).toBeInstanceOf(Uint8Array))
      )
    case "symlink":
      return fs.symlink(source, at("symlink.txt"))
    case "truncate": {
      const path = at("truncate.txt")
      return fs.writeFile(path, bytes).pipe(Effect.andThen(fs.truncate(path, 1)))
    }
    case "utimes":
      return fs.utimes(source, new Date(0), new Date(0))
    case "watch":
      return Effect.gen(function*() {
        const watched = yield* Stream.runHead(fs.watch(root)).pipe(
          Effect.timeout("5 seconds"),
          Effect.forkChild({ startImmediately: true })
        )
        // Keep producing events until the watcher observes one: subscribing
        // can take longer than any fixed initial delay. The foreign Promise
        // also works when the supplied host provides a frozen TestClock.
        yield* Effect.raceFirst(
          Fiber.join(watched),
          fs.writeFile(at("watched.txt"), bytes).pipe(
            Effect.andThen(Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))),
            Effect.forever
          )
        )
      })
    case "writeFile":
      return Effect.gen(function*() {
        const input = bytes.slice()
        const expected = input[0]
        expect(expected).toBeDefined()
        yield* fs.writeFile(at("write.txt"), input)
        input[0] = expected! ^ 0xff
        expect((yield* fs.readFile(at("write.txt")))[0]).toBe(expected)
      })
    case "writeFileString":
      return fs.writeFileString(at("write-string.txt"), "host-contract")
  }
}

/** The default stdin probe: echo back one line read from the child's stdin. */
const defaultStdinCommand = ChildProcess.make(
  process.execPath,
  [
    "-e",
    `let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(input.replace(/\\r?\\n$/, "")));`
  ],
  { stdin: Stream.fromArray([new TextEncoder().encode("stdin\n")]) }
)

/** The default two-leg process probe. */
const defaultPipelineCommand = ChildProcess.pipeTo(
  ChildProcess.make(process.execPath, ["-e", `process.stdout.write("host-contract-pipeline")`]),
  ChildProcess.make(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"])
)

/** The default multi-leg cancellation probe. */
const defaultInterruptCommand = ChildProcess.pipeTo(
  ChildProcess.make(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"]),
  ChildProcess.make(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"])
)

/**
 * Registers the shared Host contract with Vitest.
 *
 * Every invocation creates ten cases: complete service presence,
 * FileSystem, Path, five child-process lifecycle cases, Jj, and
 * HttpClient.
 *
 * @category testing
 * @since 1.0.0-rc.0
 */
export const runHostContract = (
  name: string,
  layer: HostContractLayer,
  caps: HostContractCapabilities
): void => {
  const fileSystemCap = caps.fileSystem
  const pathCap = caps.path
  const childProcessCap = caps.childProcess
  const jjCap = caps.jj
  const httpClientCap = caps.httpClient
  const scratchPath = fileSystemCap.expected === "success"
    ? fileSystemCap.scratchPath ?? defaultScratchPath(name)
    : ""

  describe(`${name} Host contract`, () => {
    it.live("provides every tag in the closed Host service list", () =>
      run(
        Effect.gen(function*() {
          yield* FileSystem.FileSystem
          yield* Path.Path
          yield* ChildProcessSpawner
          yield* JjService.Jj
          yield* HttpClient
        }),
        layer
      ))

    it.live("declares every FileSystem operation", () =>
      run(
        fileSystemCap.expected === "failure"
          ? Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* Effect.forEach(
              FileSystemOperations,
              (operation) =>
                assertFailure(
                  fileSystemProbe(fs, operation, "/host-contract/unsupported"),
                  fileSystemCap.code
                ),
              { discard: true }
            )
          })
          : Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const root = scratchPath
            const bytes = new TextEncoder().encode("host-contract")
            yield* Effect.gen(function*() {
              yield* fs.makeDirectory(root, { recursive: true })
              yield* fs.writeFile(`${root}/source.txt`, bytes)
              yield* FileSystemBatchContract.check(fs, root)
              yield* Effect.forEach(
                FileSystemOperations,
                (operation) => {
                  const probe = fileSystemProbe(fs, operation, root)
                  const code = fileSystemCap.unsupported?.[operation]
                  return code === undefined ? probe : assertFailure(probe, code)
                },
                { discard: true }
              )
            }).pipe(
              Effect.ensuring(fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore))
            )
          }),
        layer
      ))

    it.live("declares Path behavior", () =>
      run(
        pathCap.expected === "failure"
          ? Effect.gen(function*() {
            const path = yield* Path.Path
            yield* assertFailure(
              Effect.try({
                try: () => path.fromFileUrl(new URL("file:///host-contract/value")),
                catch: (error) => error
              }),
              pathCap.code
            )
          })
          : Effect.gen(function*() {
            const path = yield* Path.Path
            expect(path.normalize("/host-contract/./nested/../value")).toBe(`${path.sep}host-contract${path.sep}value`)
          }),
        layer
      ))

    it.live("declares buffered child-process behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("string", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const command = childProcessCap.execCommand ??
              ChildProcess.make(process.execPath, ["-e", `process.stdout.write("host-contract")`])
            expect(yield* spawner.string(command)).toBe(childProcessCap.expectedStdout ?? "host-contract")
            expect(yield* spawner.exitCode(command)).toBe(0)
          }),
        layer
      ))

    it.live("declares child-process streaming behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("stream", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const output = yield* Stream.mkString(
              spawner.streamString(
                childProcessCap.streamCommand ??
                  ChildProcess.make(process.execPath, ["-e", `process.stdout.write("host-contract-stream")`])
              )
            )
            expect(output).toContain(childProcessCap.expectedStreamText ?? "host-contract-stream")
          }),
        layer
      ))

    it.live("declares child-process cwd and env option behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("string", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const output = yield* spawner.string(
              childProcessCap.optionsCommand ??
                ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.env.HOST_CONTRACT_ENV)"], {
                  cwd: tmpdir(),
                  env: { HOST_CONTRACT_ENV: "env" },
                  extendEnv: true
                })
            )
            expect(output).toBe(childProcessCap.expectedOptionsStdout ?? "env")
          }),
        layer
      ))

    it.live("declares child-process stdin behavior", () =>
      run(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const stdinCap = childProcessCap.expected === "failure"
            ? childProcessCap
            : childProcessCap.stdin ?? { command: defaultStdinCommand, expectedStdout: "stdin" }
          if ("expected" in stdinCap) {
            yield* assertFailure(spawner.string(defaultStdinCommand), stdinCap.code)
            return
          }
          expect(yield* spawner.string(stdinCap.command)).toBe(stdinCap.expectedStdout)
        }),
        layer
      ))

    it.live("declares child-process pipeline behavior", () =>
      run(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const pipelineCap = childProcessCap.expected === "failure"
            ? childProcessCap
            : childProcessCap.pipeline ?? {
              command: defaultPipelineCommand,
              expectedStdout: "host-contract-pipeline"
            }
          if ("expected" in pipelineCap) {
            yield* assertFailure(spawner.string(defaultPipelineCommand), pipelineCap.code)
            return
          }
          expect(yield* spawner.string(pipelineCap.command)).toBe(pipelineCap.expectedStdout)
        }),
        layer
      ))

    it.live("declares child-process interruption behavior", () =>
      run(
        childProcessCap.expected === "failure"
          ? unsupportedChildProcess("stream", childProcessCap.code)
          : Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const ready = yield* Deferred.make<ChildProcessHandle>()
            const fiber = yield* Effect.scoped(
              Effect.gen(function*() {
                const handle = yield* spawner.spawn(
                  childProcessCap.interruptCommand ?? defaultInterruptCommand
                )
                yield* Deferred.succeed(ready, handle)
                yield* handle.exitCode
              })
            ).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const handle = yield* Deferred.await(ready)
            expect(yield* handle.isRunning).toBe(true)
            yield* Fiber.interrupt(fiber)
            expect(yield* handle.isRunning).toBe(false)
          }),
        layer
      ))

    it.live("declares every Jj operation", () =>
      run(
        jjCap.expected === "failure"
          ? Effect.gen(function*() {
            const jj = yield* JjService.Jj
            const root = jj.root
            const revert = jj.revert
            expect(root).toBeTypeOf("function")
            expect(revert).toBeTypeOf("function")
            yield* Effect.forEach([
              jj.snapshot("host contract"),
              jj.restore("host-contract-change"),
              jj.diff("host-contract-from", "host-contract-to"),
              jj.workspaceAdd("host-contract", "/host-contract/workspace", "host-contract-change"),
              jj.workspaceForget("host-contract"),
              jj.status(),
              root!("/host-contract"),
              revert!("host-contract-change")
            ], (probe) =>
              assertFailure(probe, jjCap.code), { discard: true })
          })
          : Effect.gen(function*() {
            const jj = yield* JjService.Jj
            const root = jj.root
            const revert = jj.revert
            expect(root).toBeTypeOf("function")
            expect(revert).toBeTypeOf("function")
            yield* (jjCap.prepareChange?.("first") ?? Effect.void)
            const first = yield* jj.snapshot("host contract first")
            expect(first.changeId.length).toBeGreaterThan(0)
            yield* (jjCap.prepareChange?.("second") ?? Effect.void)
            const second = yield* jj.snapshot("host contract second")
            expect(second.changeId.length).toBeGreaterThan(0)
            expect(typeof (yield* jj.diff(first.changeId, second.changeId))).toBe("string")
            const revertCode = jjCap.unsupported?.revert
            if (revertCode === undefined) {
              const reverted = yield* revert!(second.changeId)
              expect(Array.isArray(reverted.reverted)).toBe(true)
              expect(reverted.reverted.every((path) =>
                typeof path === "string"
              )).toBe(true)
            } else {
              yield* assertFailure(revert!(second.changeId), revertCode)
            }
            yield* jj.restore(first.changeId)
            const workspaceName = `host-contract-${process.pid}-${++scratchSeq}`
            yield* jj.workspaceAdd(
              workspaceName,
              jjCap.workspacePath ?? defaultScratchPath(`${name}-jj-workspace`),
              first.changeId
            )
            yield* jj.workspaceForget(workspaceName)
            expect(typeof (yield* jj.status())).toBe("string")
            const rootCode = jjCap.unsupported?.root
            const rootFrom = jjCap.rootFrom ?? "."
            if (rootCode === undefined) {
              expect((yield* root!(rootFrom)).length).toBeGreaterThan(0)
            } else {
              yield* assertFailure(root!(rootFrom), rootCode)
            }
          }),
        layer
      ))

    it.live("declares HTTP read, write, and redirect behavior", () =>
      run(
        httpClientCap.expected === "failure"
          ? Effect.gen(function*() {
            const client = yield* HttpClient
            yield* Effect.forEach([
              HttpClientRequest.get("http://127.0.0.1:1/host-contract/read"),
              HttpClientRequest.post("http://127.0.0.1:1/host-contract/write").pipe(
                HttpClientRequest.bodyText("host-contract")
              ),
              HttpClientRequest.get("http://127.0.0.1:1/host-contract/redirect")
            ], (request) =>
              assertFailure(client.execute(request), httpClientCap.code), { discard: true })
          })
          : Effect.gen(function*() {
            const client = yield* HttpClient
            for (const probe of [httpClientCap.read, httpClientCap.write, httpClientCap.redirect]) {
              const response = yield* client.execute(probe.request)
              expect(typeof response.status).toBe("number")
              expect(typeof response.headers).toBe("object")
              probe.assertResponse(response)
            }
          }),
        layer
      ))
  })
}
