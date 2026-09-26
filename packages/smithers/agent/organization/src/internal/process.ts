/**
 * Bounded command execution on the host (git plumbing) and in a sandbox
 * session (guest commands).
 *
 * Output is collected up to a byte bound; what is kept is the head of the
 * stream and the receipt says how many bytes there were in total, so a
 * truncated receipt never passes for a complete one.
 *
 * @since 1.0.0
 */
import type { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * The head of a byte stream and its full length.
 *
 * @private
 * @since 1.0.0
 */
export interface Collected {
  readonly bytes: Uint8Array
  readonly total: number
  readonly truncated: boolean
}

/**
 * Collects at most `limit` bytes of a stream, counting the rest.
 *
 * @private
 * @since 1.0.0
 */
export const collect = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, limit: number): Effect.Effect<Collected, E, R> =>
  Effect.map(
    Stream.runFold(
      stream,
      () => ({ chunks: [] as Array<Uint8Array>, kept: 0, total: 0 }),
      (state, chunk) => {
        const room = limit - state.kept
        if (room > 0) {
          const part = chunk.byteLength <= room ? chunk : chunk.subarray(0, room)
          state.chunks.push(part)
          state.kept += part.byteLength
        }
        state.total += chunk.byteLength
        return state
      }
    ),
    (state) => {
      const bytes = new Uint8Array(state.kept)
      let offset = 0
      for (const chunk of state.chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { bytes, total: state.total, truncated: state.total > state.kept }
    }
  )

const decoder = new TextDecoder()

/**
 * UTF-8 text of collected bytes. A multi-byte character cut by the bound is
 * replaced, never thrown on.
 *
 * @private
 * @since 1.0.0
 */
export const text = (collected: Collected): string => decoder.decode(collected.bytes)

/**
 * Quotes one argument for a POSIX shell.
 *
 * @private
 * @since 1.0.0
 */
export const quote = (argument: string): string => `'${argument.replaceAll("'", `'"'"'`)}'`

/**
 * A POSIX command line running `argv` exactly.
 *
 * @private
 * @since 1.0.0
 */
export const commandLine = (argv: ReadonlyArray<string>): string => argv.map(quote).join(" ")

/**
 * What one host command did.
 *
 * @private
 * @since 1.0.0
 */
export interface HostResult {
  readonly exitCode: number
  readonly stdout: Collected
  readonly stderr: Collected
}

/**
 * Runs `git` with `args` on the host, with the ambient environment minus
 * every variable that could redirect it to another repository, index, or
 * object store, plus `env`.
 *
 * `core.autocrlf` is off whatever the host configures: a workspace holds the
 * commit's bytes, and a Windows host's default would rewrite line endings on
 * every checkout and restore.
 *
 * @private
 * @since 1.0.0
 */
export const git = (
  repo: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: Readonly<Record<string, string>> | undefined; readonly limit: number }
): Effect.Effect<HostResult, PlatformError.PlatformError, ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("git", ["-c", "core.autocrlf=false", "-C", repo, ...args], {
      extendEnv: true,
      env: {
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_NAMESPACE: undefined,
        GIT_CEILING_DIRECTORIES: undefined,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        ...options.env
      }
    }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      collect(handle.stdout, options.limit),
      collect(handle.stderr, options.limit),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { exitCode: Number(exitCode), stdout, stderr }
  }))

/**
 * What one guest command did. `exitCode` is `null` when the command was
 * stopped at its deadline.
 *
 * @private
 * @since 1.0.0
 */
export interface GuestResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: Collected
  readonly stderr: Collected
  readonly durationMs: number
}

/**
 * Runs one command line in a session and waits for it inside the spawn's
 * scope, so a deadline or an interrupt kills the command's whole process
 * tree before this returns.
 *
 * @private
 * @since 1.0.0
 */
export const guest = (
  session: Session,
  command: string,
  options: { readonly limit: number; readonly timeoutMs?: number | undefined }
): Effect.Effect<GuestResult, ProviderError> =>
  Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    const run = Effect.scoped(Effect.gen(function*() {
      const process = yield* session.spawn(command, {})
      const [stdout, stderr, exitCode] = yield* Effect.all([
        collect(process.stdout, options.limit),
        collect(process.stderr, options.limit),
        process.exitCode
      ], { concurrency: "unbounded" })
      return { exitCode, stdout, stderr }
    }))
    const empty: Collected = { bytes: new Uint8Array(0), total: 0, truncated: false }
    const settled = options.timeoutMs === undefined
      ? yield* run
      : yield* Effect.timeoutOption(run, options.timeoutMs).pipe(
        Effect.map((result) => result._tag === "Some" ? result.value : undefined)
      )
    const durationMs = (yield* Clock.currentTimeMillis) - started
    return settled === undefined
      ? { exitCode: null, timedOut: true, stdout: empty, stderr: empty, durationMs }
      : { ...settled, timedOut: false, durationMs }
  })
