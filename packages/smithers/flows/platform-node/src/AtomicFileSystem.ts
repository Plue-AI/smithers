/**
 * Descriptor-relative filesystem operations through the packaged Rust helper.
 * The helper pins the workspace root and walks each component with O_NOFOLLOW.
 * Requests and responses are length-framed, size-limited, and cancellable.
 * @since 0.1.0
 */

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Layer, PlatformError, Semaphore, Stream } from "effect"
import { realpath, stat } from "node:fs/promises"
import { availableParallelism } from "node:os"
import {
  packageRoot,
  resolveConfiguredExecutable,
  resolveDefaultExecutable,
  stagePackaged
} from "./internal/AtomicFileSystemExecutable.ts"
import * as Protocol from "./internal/AtomicFileSystemProtocol.ts"
import * as Transport from "./internal/AtomicFileSystemTransport.ts"

/**
 * The legacy system installation path, used after package and checkout paths.
 * Helper selection never consults `PATH` or the process working directory.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultExecutable = "/usr/local/bin/smithers-jj-export"

/**
 * Byte ceilings for the helper protocol. Every one of them is a contract, not
 * a tuning knob: without them a large file, a large directory tree, or a
 * malfunctioning helper makes the host allocate until it dies.
 *
 * - `content` bounds the bytes a single `readFile`/`writeFile` may carry.
 * - `request` bounds the framed request; an over-limit request is refused
 *   before an helper is even started.
 * - `response` bounds the framed response, and is what a directory listing is
 *   charged against as it is built. It bounds the REJECTION envelope too, so a
 *   ceiling small enough to cut one off degrades that operation's typed reason
 *   to the fail-closed one.
 * - `stderr` bounds the diagnostic text retained from a failing helper.
 * - `batchEntry` bounds one batch member's encoded success or failure envelope.
 * - `batchSize` bounds the number of operations in one batch, at most 128.
 *
 * All except `batchSize` count bytes. The two ceilings that decide whether the host
 * survives a wide fan-out are {@link Options.concurrency}, which bounds how
 * many helpers run at once, and {@link Options.timeoutMs}, which bounds
 * how long any one of them may take.
 *
 * @since 0.1.0
 * @category models
 */
export interface Limits {
  readonly content: number
  readonly request: number
  readonly response: number
  readonly stderr: number
  /** Maximum operations in one helper invocation, at most 128. */
  readonly batchSize: number
  /** Maximum encoded result bytes for one batch member. */
  readonly batchEntry: number
}

/**
 * 16 MiB of file content, 24 MiB of framed request and response (base64
 * expands 16 MiB to 22369624 bytes, which has to fit), and 64 KiB of retained
 * helper diagnostics.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultLimits: Limits = {
  content: 16 * 1024 * 1024,
  request: 24 * 1024 * 1024,
  response: 24 * 1024 * 1024,
  stderr: 64 * 1024,
  batchSize: KernelFileSystem.maxBatchSize,
  batchEntry: 24 * 1024 * 1024
}

/**
 * The default number of helper processes that may run at once:
 * `os.availableParallelism()`.
 *
 * @since 1.0.0-rc.0
 * @category constants
 */
export const defaultConcurrency: number = availableParallelism()

/**
 * How long one helper may run before it is killed and the operation fails
 * closed: five minutes.
 *
 * It is a backstop, not a latency budget. A read at the content ceiling over a
 * slow disk has to fit under it, so it is generous; what it bounds is a helper
 * that will never answer at all.
 *
 * @since 1.0.0-rc.0
 * @category constants
 */
export const defaultTimeoutMs = 300_000

/**
 * The deliberate seam for a POSIX host that installs the native helper somewhere other
 * than {@link defaultExecutable}, or that needs different ceilings. It is
 * configuration, never discovery: the executable is validated as an absolute,
 * executable regular file outside the confined workspace on every request, and
 * every other field is read ONCE, when the layer is built.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly executable?: string | undefined
  readonly limits?: Partial<Limits> | undefined
  /**
   * How many helper processes may run at once. Default
   * {@link defaultConcurrency}.
   *
   * Each ordinary operation or batch starts one helper, so an unbounded
   * `Effect.forEach` over a directory would start
   * one helper per entry. This ceiling is what keeps a wide fan-out from
   * pinning every core; it is a contract, not a tuning knob.
   */
  readonly concurrency?: number | undefined
  /**
   * How long one helper may run before it is killed and the operation fails
   * closed, in milliseconds. Default {@link defaultTimeoutMs}.
   */
  readonly timeoutMs?: number | undefined
}

/**
 * Everything read out of {@link Options} once, when the layer is built.
 *
 * Snapshotted rather than re-read per request: `Options` is a plain object the
 * caller still holds, and a byte ceiling that changes under a running host is
 * not a ceiling. The executable is deliberately NOT here — it is re-validated
 * per request, because the file it names can be replaced while the host runs.
 */
interface Settings {
  readonly limits: Limits
  readonly timeoutMs: number
  readonly semaphore: Semaphore.Semaphore
}

/**
 * Process-local helper starts, for cost counters and local measurements.
 * Includes helpers later cancelled or refused; rejected preflight starts none.
 *
 * @since 1.0.0
 * @category metrics
 */
export const helperSpawns = (): number => Transport.started()

/** The helper enforces the same ceiling before it trusts a declared limit. */
const hardLimitBytes = 256 * 1024 * 1024
/** `setTimeout` clamps a longer delay to 1 ms, so a bigger backstop is none. */
const maxTimeoutMs = 2_147_483_647

/** Resolves every optional byte ceiling and refuses values that could disable a bound. */
const resolveLimits = (overrides: Partial<Limits> | undefined): Limits => {
  const limits: Limits = {
    content: overrides?.content ?? defaultLimits.content,
    request: overrides?.request ?? defaultLimits.request,
    response: overrides?.response ?? defaultLimits.response,
    stderr: overrides?.stderr ?? defaultLimits.stderr,
    batchSize: overrides?.batchSize ?? defaultLimits.batchSize,
    batchEntry: overrides?.batchEntry ?? defaultLimits.batchEntry
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimitBytes) {
      throw new Error(
        `atomic helper ${name} limit must be a positive integer no greater than ${hardLimitBytes}`
      )
    }
  }
  if (limits.batchSize > KernelFileSystem.maxBatchSize) {
    throw new Error(`atomic helper batchSize limit must be no greater than ${KernelFileSystem.maxBatchSize}`)
  }
  return limits
}

/**
 * Reads the whole of {@link Options} once, at layer construction.
 *
 * A rejected value is carried rather than thrown, because the failure a caller
 * sees for it is a typed `BadArgument` on the first operation and not an
 * exception escaping a layer.
 */
const resolveSettings = (options: Options): Settings | { readonly invalid: unknown } => {
  try {
    const limits = resolveLimits(options.limits)
    const concurrency = options.concurrency ?? defaultConcurrency
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new Error("atomic helper concurrency must be a positive integer")
    }
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimeoutMs) {
      throw new Error("atomic helper timeoutMs must be a positive integer no greater than 2147483647")
    }
    return { limits, timeoutMs, semaphore: Semaphore.makeUnsafe(concurrency) }
  } catch (invalid) {
    return { invalid }
  }
}

/**
 * The framed half, one concrete result type. Nothing on this side of the pipe
 * can prove what the helper answered: the protocol pairs an operation with its
 * result, and {@link execute} restates that pairing for the kernel's typed
 * request. Keeping the decode `unknown` here confines that promise to one
 * assertion instead of one per caller.
 */
const executeFramed = (options: Options, resolved: Settings | { readonly invalid: unknown }) =>
(
  request: KernelFileSystem.AtomicRequest
): Effect.Effect<unknown, PlatformError.PlatformError> =>
  Effect.suspend(() => {
    if ("invalid" in resolved) {
      const cause = resolved.invalid
      return Effect.fail(PlatformError.badArgument({
        module: Protocol.moduleName,
        method: request.operation,
        description: cause instanceof Error ? cause.message : "atomic helper limits are invalid",
        cause
      }))
    }
    const limits = resolved.limits
    if (
      request.operation === "batch" &&
      (!Array.isArray(request.requests) || request.requests.length === 0 || request.requests.length > limits.batchSize)
    ) {
      return Effect.fail(PlatformError.badArgument({
        module: Protocol.moduleName,
        method: "batch",
        description: `atomic batch must contain 1 to ${limits.batchSize} operations`
      }))
    }
    // Admission bounds request serialization and framing as well as children.
    // Queued callers retain their input, without another full payload copy.
    return resolved.semaphore.withPermits(1)(Effect.suspend(() => {
      let body: Buffer
      try {
        const serialized = JSON.stringify(
          request.operation === "batch"
            ? { ...request, batchSize: limits.batchSize, batchEntry: limits.batchEntry }
            : request
        )
        if (serialized === undefined) {
          throw new Error("atomic request is not serializable")
        }
        body = Buffer.from(serialized, "utf8")
      } catch (cause) {
        return Effect.fail(PlatformError.badArgument({
          module: Protocol.moduleName,
          method: request.operation,
          description: "atomic request is not serializable",
          cause
        }))
      }
      if (body.byteLength > limits.request) {
        // Refused before an helper exists: an over-limit request is caller
        // input, and nothing about it improves by being sent.
        return Effect.fail(PlatformError.badArgument({
          module: Protocol.moduleName,
          method: request.operation,
          description: `atomic request of ${body.byteLength} bytes exceeds the ${limits.request} byte limit`
        }))
      }
      let executable: string
      try {
        executable = resolveExecutable(options, request.boundaryRoot)
      } catch (cause) {
        return Effect.fail(Protocol.failure(request, cause))
      }
      return Transport.spawnHelper<unknown>(request, executable, Protocol.encode(body, limits), resolved)
    }))
  })

const resolveExecutable = (options: Pick<Options, "executable">, boundaryRoot: string | undefined): string => {
  const configured = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  return options.executable !== undefined
    ? Transport.usableExecutable(options.executable, boundaryRoot)
    : configured === undefined
    ? resolveDefaultExecutable(packageRoot, boundaryRoot, defaultExecutable)
    : resolveConfiguredExecutable(configured, boundaryRoot)
}

/**
 * The helper this process would start for an atomic operation, resolved exactly
 * as an operation resolves it: `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`, then the
 * packaged and checkout locations. Nothing is spawned. Throws an `Error` whose
 * message names what was searched and how to install the helper when none is
 * usable, so a diagnostic can report it before any operation needs it.
 *
 * @since 1.0.0
 * @category constructors
 */
export const resolveHelper = (): string => resolveExecutable({}, undefined)

const execute = (
  options: Options,
  resolved: Settings | { readonly invalid: unknown }
): KernelFileSystem.AtomicFileSystem["execute"] => {
  const framed = executeFramed(options, resolved)
  return <R extends KernelFileSystem.AtomicRequest>(request: R) =>
    framed(request) as Effect.Effect<KernelFileSystem.AtomicResult<R>, PlatformError.PlatformError>
}

const nativeRealPath = (path: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: (cause) =>
      Protocol.failure({ operation: "realPath", path }, cause, {
        ok: false,
        code: (cause as NodeJS.ErrnoException).code ?? null,
        message: (cause as NodeJS.ErrnoException).message,
        syscall: "realpath"
      })
  })

/**
 * A Node filesystem layer carrying the kernel's atomic host extension, built
 * against an explicitly configured helper, byte limits, process ceiling,
 * and helper timeout.
 *
 * Every field of {@link Options} except `executable` is read once, here. The
 * concurrency ceiling is one semaphore for the whole layer rather than one per
 * request, which is the only arrangement that bounds anything.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (options: Options): Layer.Layer<FileSystem.FileSystem> => {
  // Outside the layer body on purpose. Inside it the settings would be read
  // again on every BUILD, so two compositions of the same layer value could
  // enforce two different ceilings out of one mutated object, and each would
  // get a process ceiling of its own instead of sharing one.
  const settings = resolveSettings(options)
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(
      // The packaged helper is pinned while the host is built, before any flow
      // can rewrite a workspace-local install of this package.
      Effect.andThen(
        Effect.sync(() => {
          if (options.executable === undefined && process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY === undefined) {
            stagePackaged(packageRoot)
          }
        }),
        FileSystem.FileSystem
      ),
      (fileSystem) =>
        KernelFileSystem.withAtomicFileSystem({
          ...fileSystem,
          // Expand DOS names before pinning roots or opening native watchers.
          realPath: nativeRealPath,
          watch: (path, options) =>
            process.platform !== "win32"
              ? fileSystem.watch(path, options)
              : Stream.unwrap(
                nativeRealPath(path).pipe(Effect.map((canonical) => fileSystem.watch(canonical, options)))
              )
        }, {
          noFollowAuthorization: true,
          execute: execute(options, settings),
          identifyRoot: (path) =>
            Effect.tryPromise({
              try: async () => {
                const info = await stat(path, { bigint: true })
                return `${info.dev}:${info.ino}`
              },
              catch: (cause) =>
                Protocol.failure({ operation: "stat", path }, cause, {
                  ok: false,
                  code: (cause as NodeJS.ErrnoException).code ?? null,
                  message: (cause as NodeJS.ErrnoException).message,
                  syscall: "stat"
                })
            }),
          batchLimits: {
            size: "invalid" in settings ? defaultLimits.batchSize : settings.limits.batchSize,
            response: "invalid" in settings ? defaultLimits.response : settings.limits.response
          },
          contentLimit: "invalid" in settings ? defaultLimits.content : settings.limits.content
        })
    )
  ).pipe(Layer.provide(NodeFileSystem.layer))
}

/** A Node filesystem layer carrying the kernel's atomic host extension.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<FileSystem.FileSystem> = layerWith({})
