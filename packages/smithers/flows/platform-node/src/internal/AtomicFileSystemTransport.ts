/**
 * The process transport beneath the atomic filesystem: resolving the
 * configured helper to a file the confined workspace cannot have
 * supplied, and running one isolated, bounded helper process per framed
 * request.
 * @since 1.0.0
 */

import type * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, type PlatformError } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path"
import type { Limits } from "../AtomicFileSystem.ts"
import { convert, decode, failure, frameHeaderBytes, type HelperResult } from "./AtomicFileSystemProtocol.ts"

let startedHelpers = 0

/**
 * Process-local helper starts, including helpers later cancelled or refused.
 * @private
 * @since 1.0.0
 */
export const started = (): number => startedHelpers

/** An inert working directory: nothing the helper could import lives there. */
const inertDirectory = parse(process.execPath).root

/**
 * True when `target` is at or below `root`. Both are absolute and already
 * canonical. A different Windows drive produces an absolute relative result.
 * @private
 * @since 1.0.0
 */
export const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Resolve symlinks without replacing a hard-linked executable's entry name. */
const executablePath = (configured: string): string => {
  let current = configured
  for (let links = 0; links < 40; links++) {
    if (current.endsWith("/") || current.endsWith(sep)) {
      throw new Error("atomic helper executable cannot end with a directory separator")
    }
    // Bun's macOS realpath can return another hard link to the final inode:
    // A hard-linked executable can change its entry name during guarded reads.
    // Directories cannot have those file aliases. Resolve the parent, preserve
    // the leaf name, and explicitly follow only actual leaf symlinks.
    const parent = realpathSync.native(dirname(current))
    const candidate = join(parent, basename(current))
    if (!lstatSync(candidate).isSymbolicLink()) return candidate
    const target = readlinkSync(candidate)
    // Do not normalize `link/..` lexically; realpath must traverse it first.
    current = isAbsolute(target) ? target : `${parent}/${target}`
  }
  throw new Error("atomic helper executable has too many symbolic links")
}

/**
 * Resolves the configured helper to an absolute, executable regular file
 * that the confined workspace cannot have supplied. Every failure throws, and
 * every throw becomes a fail-closed `PermissionDenied`, so a host without a
 * usable helper performs no filesystem operation at all.
 * @private
 * @since 1.0.0
 */
export const usableExecutable = (configured: string, boundaryRoot: string | undefined): string => {
  if (!isAbsolute(configured)) {
    throw new Error(`atomic helper executable must be an absolute path, got ${JSON.stringify(configured)}`)
  }
  // Resolved first: the checks below have to describe the file that will
  // actually run, not the name that leads to it.
  const resolved = executablePath(configured)
  if (!statSync(resolved).isFile()) {
    throw new Error(`atomic helper executable is not a regular file: ${resolved}`)
  }
  accessSync(resolved, constants.X_OK)
  if (boundaryRoot !== undefined && inside(boundaryRoot, resolved)) {
    throw new Error(`atomic helper executable must live outside the confined workspace: ${resolved}`)
  }
  return resolved
}

/**
 * Runs one helper over one framed request and settles with its converted
 * answer. Every exit path kills the child, releases its pipes, and waits for
 * the operating system to report that the process has closed.
 * @private
 * @since 1.0.0
 */
export const spawnHelper = <A>(
  request: KernelFileSystem.AtomicRequest,
  executable: string,
  payload: Buffer,
  settings: { readonly limits: Limits; readonly timeoutMs: number }
): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.callback<A, PlatformError.PlatformError>((resume) => {
    const limits = settings.limits
    let settled = false
    const stdout: Array<Buffer> = []
    let stdoutBytes = 0
    const stderr: Array<Buffer> = []
    let stderrBytes = 0
    let truncated = false
    let writeFailure: unknown

    // The packaged helper runs with an inert cwd and empty environment. The
    // configured executable is validated outside the confined root first.
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, ["--atomic-fs"], {
        cwd: inertDirectory,
        env: {},
        stdio: ["pipe", "pipe", "pipe"]
      })
      startedHelpers++
    } catch (cause) {
      // libuv reports some exec failures — `ENOEXEC` for a file that is
      // neither a script nor a binary — by throwing rather than by emitting an
      // `error` event, so both arrivals have to end in the same refusal.
      resume(Effect.fail(failure(request, cause)))
      return Effect.void
    }
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
    // `deadline` is armed below, after the completion it resumes through
    // exists. Reading it here is safe because nothing calls `cleanup` before
    // then: the one earlier exit, a spawn that threw, resumes and returns.
    const cleanup = () => {
      clearTimeout(deadline)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill("SIGKILL")
    }
    const complete = (effect: Effect.Effect<A, PlatformError.PlatformError>) => {
      if (settled) return
      settled = true
      // Every exit path drains and kills, so an overflowing, hung, or already
      // finished helper leaves no descriptor and no child behind.
      cleanup()
      resume(Effect.andThen(Effect.promise(() => closed), effect))
    }
    // A wall-clock backstop, independent of every byte ceiling. Those bound
    // what a helper may SAY; nothing bounds how long it may take to say it, and
    // a helper that never answers would otherwise hold the fiber until the run
    // itself is interrupted.
    const deadline = setTimeout(() => {
      complete(Effect.fail(failure(
        request,
        new Error(`atomic helper did not answer within ${settings.timeoutMs} ms`)
      )))
    }, settings.timeoutMs)
    deadline.unref()
    // Raw buffers, never decoded strings: a chunk boundary in the middle of a
    // multi-byte character would otherwise be decoded as two replacement
    // characters before the JSON parse ever saw it. Concatenating once at the
    // end also keeps accumulation linear instead of quadratic.
    // Retained bytes are bounded by the ceiling plus at most one pipe chunk:
    // an overflowing chunk is sliced before it is retained, so the host never
    // relies on the stream implementation's chunk-size convention.
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = limits.response + frameHeaderBytes - stdoutBytes
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          stdout.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
        }
        complete(Effect.fail(failure(
          request,
          new Error(`atomic helper wrote more than ${limits.response} response bytes`)
        )))
        return
      }
      stdoutBytes += chunk.byteLength
      stdout.push(chunk)
    })
    // stderr is bounded on its own budget: a helper that says nothing useful
    // on stdout must not be able to exhaust the host through diagnostics.
    // Destroying the pipe stops the helper at its next write rather than
    // letting it produce output nobody will read.
    child.stderr.on("data", (chunk: Buffer) => {
      // Sliced to the remaining room rather than kept whole, so the retained
      // text is exactly the budget and not the budget plus a pipe buffer.
      const slice = chunk.subarray(0, limits.stderr - stderrBytes)
      stderrBytes += slice.byteLength
      stderr.push(slice)
      if (stderrBytes >= limits.stderr) {
        truncated = true
        child.stderr.destroy()
      }
    })
    child.on("error", (cause) => complete(Effect.fail(failure(request, cause))))
    // A helper that exits before draining stdin — an unavailable helper,
    // a rejected request, an interrupt that killed it mid-write — makes the
    // request write fail with EPIPE. Without a listener that is an unhandled
    // `error` event on the pipe, which terminates the host process instead of
    // failing one filesystem call. It is recorded rather than resumed on, so
    // that a helper which did manage to report a real errno keeps precedence
    // over the broken pipe its own exit caused.
    child.stdin.on("error", (cause) => {
      writeFailure = cause
    })
    child.on("close", (code) => {
      let envelope: HelperResult | undefined
      let malformed: unknown
      try {
        envelope = decode(Buffer.concat(stdout), limits)
      } catch (cause) {
        malformed = cause
      }
      if (envelope !== undefined && !envelope.ok) {
        // The helper's own typed rejection outranks the exit status and any
        // transport noise: it is the only thing that knows which errno the
        // syscall produced.
        complete(Effect.fail(failure(
          request,
          new Error(envelope.message ?? "atomic helper rejected the operation"),
          envelope
        )))
        return
      }
      if (envelope !== undefined && code === 0) {
        try {
          complete(convert<A>(request, envelope.value, limits))
        } catch (cause) {
          complete(Effect.fail(failure(request, cause)))
        }
        return
      }
      const text = Buffer.concat(stderr).toString("utf8")
      complete(Effect.fail(failure(
        request,
        text !== ""
          ? new Error(`atomic helper exited ${code}: ${text}${truncated ? " (truncated)" : ""}`)
          : writeFailure !== undefined
          ? writeFailure
          : malformed !== undefined
          ? malformed
          : new Error(`atomic helper exited ${code}`)
      )))
    })
    child.stdin.end(payload)
    return Effect.promise(async () => {
      cleanup()
      await closed
    })
  })
