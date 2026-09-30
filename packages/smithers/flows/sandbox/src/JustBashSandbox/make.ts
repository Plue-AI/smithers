/**
 * Constructs the in-process just-bash sandbox provider.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as FileSystem from "effect/FileSystem"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { providerFailure } from "../internal/localProcess.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { refuseResourceLimits, type ResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { JustBashExecOptions, JustBashLike } from "./JustBashLike.ts"

/**
 * How the provider reaches its interpreter and the tree it shares with it.
 *
 * @category models
 * @since 0.1.0
 */
export interface JustBashSandboxOptions {
  /**
   * Restrictions refused: the injected interpreter's network configuration is not visible to this provider. `"none"` or an allowlist makes `make` throw rather than hand
   * out a machine with a network it did not ask for; `"open"`, which restricts nothing, is accepted.
   */
  readonly network?: NetworkPolicy | undefined
  /**
   * Refused: the injected interpreter's execution limits are not visible to this provider. Setting any ceiling makes `make` throw rather than hand
   * out a machine without it.
   */
  readonly limits?: ResourceLimits | undefined
  /** The interpreter that runs every session command. */
  readonly bash: JustBashLike
  /** The filesystem mounted under the interpreter's own filesystem view. */
  readonly fs: FileSystem.FileSystem
  /** The absolute guest directory containing session workspaces. Default `/workspace`. */
  readonly root?: string | undefined
}

const encoder = new TextEncoder()
const failure = providerFailure

const captured = (text: string): Stream.Stream<Uint8Array, ProviderError> =>
  text === "" ? Stream.empty : Stream.make(encoder.encode(text))

/**
 * Renders bytes as the latin1 byte string just-bash's `stdinKind: "bytes"`
 * expects: one character per byte, so a 0xFF stays one byte instead of the
 * two UTF-8 would spell it with. Built in slices so a large input does not
 * become one call with tens of thousands of arguments.
 */
const latin1 = (bytes: Uint8Array): string => {
  let text = ""
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return text
}

/**
 * Builds a provider whose machines are just-bash workspaces in one virtual
 * filesystem.
 *
 * Each session key gets a subdirectory below `root`. Commands run through the
 * interpreter's `exec`, while reads, writes, and native file operations use
 * the injected `FileSystem`. The caller must mount the interpreter and that
 * service on the same tree. In a browser this normally means just-bash and
 * `BrowserFileSystem` both view the same ZenFS volume.
 *
 * `spawn` hands `exec` the session workdir as `cwd`, rooting a relative `cwd`
 * there first; the defined entries of the spawn environment as `env`, which
 * just-bash merges into the interpreter's environment for that one call; and
 * `options.stdin` as `stdin` with `stdinKind: "bytes"`, the latin1 byte-string
 * form just-bash forwards verbatim, so binary input reaches the command
 * unchanged. Environment deletion is refused with `spawn_error` before exec,
 * because the injected interpreter interface can only merge string values.
 * The cross-surface checks a session must pass, a process reading
 * a file `writeFile` put there and `readFile` returning what a process wrote,
 * rely on nothing beyond the `<` and `>` redirections just-bash documents.
 *
 * This provider is a workspace boundary, not a security boundary. An
 * interpreted command can address anything its shared virtual filesystem
 * permits. Runs are serialized because just-bash has one mutable filesystem
 * view. Cancelling a spawn stops waiting; an exec already started continues
 * holding the permit until it settles. A cancelled queued command never runs.
 * A hung interpreter keeps later commands queued, but their callers can still
 * cancel. Closing the session scope removes its workspace even if exec is
 * still running. A successful spawn completes before it returns, stdout and
 * stderr each replay at most one UTF-8 encoded chunk, and `isRunning` is already
 * false by the time a caller can observe the adapted handle. There is no signal
 * delivery, separately spawned process pipeline, or incremental output. Consequently sessions omit `kill`,
 * and `SandboxConformance` skips its kill-and-survivor check for this provider
 * instead of reporting a violation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: JustBashSandboxOptions): Provider => {
  refuseNetworkPolicy("just-bash-sandbox", options.network)
  refuseResourceLimits(
    "just-bash-sandbox",
    options.limits,
    ["cpus", "memoryMib", "timeoutSecs"],
    "the injected interpreter's execution limits are not visible to this provider"
  )
  const root = (options.root ?? "/workspace").replace(/\/+$/, "")
  const gate = Semaphore.makeUnsafe(1)
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const workdir = `${root}/${sessionSlug(sessionKey)}`
        yield* Effect.acquireRelease(
          options.fs.makeDirectory(workdir, { recursive: true }).pipe(
            Effect.mapError(failure("unavailable", `the just-bash workspace ${workdir} could not be created`))
          ),
          () => Effect.ignore(options.fs.remove(workdir, { recursive: true, force: true }))
        )
        const resolve = rootedAt(workdir)
        const session: Session = {
          id: sessionKey,
          remoteId: workdir,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            yield* checkEnvironmentNames(spawnOptions.env)
            const env: Record<string, string> = {}
            for (const [name, value] of Object.entries(spawnOptions.env ?? {})) {
              if (value === undefined) {
                return yield* Effect.fail(
                  new ProviderError({
                    code: "spawn_error",
                    message: `just-bash: environment deletion is unsupported (${name}); the interpreter only merges env`
                  })
                )
              }
              env[name] = value
            }
            const stdin = spawnOptions.stdin
            const execOptions: JustBashExecOptions = {
              cwd: resolve(spawnOptions.cwd ?? workdir),
              ...(spawnOptions.env === undefined ? {} : { env }),
              ...(stdin === undefined ? {} : { stdin: latin1(stdin), stdinKind: "bytes" as const })
            }
            const result = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function*() {
                // The interpreter cannot be aborted. Its own fiber must keep
                // the permit until exec settles, even after its caller leaves.
                const execution = yield* gate.withPermit(
                  Effect.uninterruptible(
                    Effect.tryPromise({
                      try: () => options.bash.exec(command, execOptions),
                      catch: failure("spawn_error", `\`${command}\` could not run through just-bash`)
                    })
                  )
                ).pipe(Effect.forkDetach)
                return yield* restore(Fiber.join(execution)).pipe(
                  // Cancel a queued acquisition without waiting on an exec
                  // that has already entered its uninterruptible region.
                  Effect.onInterrupt(() =>
                    Fiber.interrupt(execution).pipe(Effect.forkDetach({ startImmediately: true }), Effect.asVoid)
                  )
                )
              })
            )
            return {
              stdout: captured(result.stdout),
              stderr: captured(result.stderr),
              exitCode: Effect.succeed(result.exitCode)
            }
          }),
          readFile: (path) =>
            options.fs.readFile(path).pipe(
              Effect.mapError((error) =>
                error.reason._tag === "NotFound"
                  ? new ProviderError({ code: "not_found", message: `the sandbox holds nothing at ${path}` })
                  : failure("unknown", `the sandbox could not read ${path}`)(error)
              )
            ),
          writeFile: (path, content) =>
            Effect.gen(function*() {
              const separator = path.lastIndexOf("/")
              /* v8 ignore next 3 -- session paths are absolute under an absolute root, so only a write to the filesystem root itself could skip parent creation */
              if (separator > 0) {
                yield* options.fs.makeDirectory(path.slice(0, separator), { recursive: true })
              }
              yield* options.fs.writeFile(path, content)
            }).pipe(Effect.mapError(failure("unknown", `the sandbox could not write ${path}`))),
          ping: Effect.void,
          // Handed the already-rooted path: `Sandbox.fileSystem` installs an
          // override through its own workdir resolver.
          files: {
            // Preserve write flags, modes and ownership through the native host.
            writeFile: options.fs.writeFile,
            writeFileString: options.fs.writeFileString,
            chmod: options.fs.chmod,
            chown: options.fs.chown,
            exists: options.fs.exists,
            stat: options.fs.stat,
            readDirectory: options.fs.readDirectory,
            makeDirectory: options.fs.makeDirectory,
            remove: options.fs.remove,
            rename: options.fs.rename,
            realPath: options.fs.realPath,
            readLink: options.fs.readLink
          } satisfies Partial<FileSystem.FileSystem>
        }
        return session
      })
  }
}
