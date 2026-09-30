/**
 * Constructs the scratch-directory sandbox provider.
 *
 * @since 0.1.0
 */

import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type { Scope } from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { refuseResourceLimits, type ResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * What the scratch-directory provider needs from its host.
 *
 * The services arrive as values, never as ambient imports, so the module
 * stays platform-neutral: a Node composition passes the platform bundle's
 * filesystem and spawner, and the package itself still owns no host access.
 *
 * @category models
 * @since 0.1.0
 */
export interface DirectorySandboxOptions {
  /**
   * Restrictions refused: commands run as host processes with the host's network. `"none"` or an allowlist makes `make` throw rather than hand
   * out a machine with a network it did not ask for; `"open"`, which restricts nothing, is accepted.
   */
  readonly network?: NetworkPolicy | undefined
  /**
   * Refused: commands run as host processes. Setting any ceiling makes `make` throw rather than hand
   * out a machine without it.
   */
  readonly limits?: ResourceLimits | undefined
  /** The host filesystem the scratch directories live on. */
  readonly fs: FileSystem.FileSystem
  /** A host spawner with a platform lifecycle; raw and deadline-only spawners are refused. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The directory session workspaces are created under. */
  readonly root: string
}

const failure = providerFailure

/** Vendor sign-ins, relative to a home, that a fork never copies. */
const vendorLogins = [
  ".claude/.credentials.json",
  ".claude.json",
  ".claude.json.backup",
  ".codex/auth.json",
  ".config/anthropic"
] as const

/**
 * Builds a sandbox provider whose machines are directories on this host.
 *
 * `acquire` creates one scratch directory per session key and serves the
 * session contract from it: `spawn` runs the command line through the host
 * spawner's `sh` shell with the directory as its default working directory — a
 * relative `cwd` is taken under it, the caller's `env` extends a narrow host
 * bootstrap environment, and `stdin` bytes become the command's whole standard
 * input — file transfer is the host filesystem, `kill` delegates to the
 * contained handle, and closing the scope stops its owned process group before
 * removing the directory. Acquisition refuses a spawner without a platform
 * lifecycle before creating a directory or starting a command. `fork` copies
 * the session's directory into a new session's directory, leaving vendor
 * sign-ins behind.
 *
 * This is the trusted local backend — a workspace boundary, **not a security
 * boundary**. Nothing confines a spawned process to the directory; what the
 * provider gives you is the session shape itself, so a composition, a test,
 * or CI can run the placement machinery for real with no container runtime,
 * and the same composition swaps to `ContainerSandbox` or a vendor provider
 * where isolation matters.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: DirectorySandboxOptions): Provider => {
  refuseNetworkPolicy("directory-sandbox", options.network)
  refuseResourceLimits(
    "directory-sandbox",
    options.limits,
    ["cpus", "memoryMib", "timeoutSecs"],
    "commands run as host processes under no provider-owned ceiling"
  )
  // `seed` is the workdir a fork copies; a fresh session starts empty.
  const open = (sessionKey: string, seed?: string): Effect.Effect<Session, ProviderError, Scope> =>
    Effect.gen(function*() {
      if (!ContainedSpawner.isContained(options.spawner)) {
        return yield* Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: "DirectorySandbox requires a contained ChildProcessSpawner with a platform lifecycle"
          })
        )
      }
      const workdir = `${options.root.replace(/\/+$/, "")}/${sessionSlug(sessionKey)}`
      yield* Effect.acquireRelease(
        options.fs.makeDirectory(workdir, { recursive: true }).pipe(
          Effect.mapError(failure("unavailable", `the scratch workspace ${workdir} could not be created`))
        ),
        () => Effect.ignore(options.fs.remove(workdir, { recursive: true, force: true }))
      )
      if (seed !== undefined) {
        // The copy is the tree alone: host credentials live outside it.
        yield* options.fs.copy(seed, workdir, { overwrite: true }).pipe(
          // A workdir used as a home can hold vendor sign-ins; a fork starts
          // signed out of them.
          Effect.andThen(Effect.forEach(
            vendorLogins,
            (login) => options.fs.remove(`${workdir}/${login}`, { recursive: true, force: true }),
            { discard: true }
          )),
          Effect.mapError(failure("unavailable", `the workspace ${seed} could not be forked`))
        )
      }
      // A relative `cwd` is the workspace's, never the engine process's
      // working directory.
      const resolve = rootedAt(workdir)
      const started = new WeakMap<RemoteProcess, ChildProcessHandle>()
      // Only the injected lifecycle owns signal authority. A supervised
      // handle's pid can name its owner, not the command's target process.
      const deliver = (handle: ChildProcessHandle, signal: ChildProcess.Signal): Effect.Effect<void, ProviderError> =>
        handle.kill({ killSignal: signal }).pipe(
          Effect.mapError(failure("unknown", `the signal ${signal} could not be delivered`))
        )
      const session: Session = {
        id: sessionKey,
        remoteId: workdir,
        workdir,
        spawn: Effect.fnUntraced(function*(command, spawnOptions) {
          yield* checkEnvironmentNames(spawnOptions.env)
          const settings: ChildProcess.CommandOptions = {
            // Sessions use POSIX command and probe syntax on every host.
            shell: "sh",
            cwd: resolve(spawnOptions.cwd ?? ""),
            env: ChildProcessEnvironment.make(globalThis.process.env, spawnOptions.env),
            extendEnv: false,
            ...spawnOptions.stdin === undefined ? {} : { stdin: Stream.make(spawnOptions.stdin) }
          }
          const handle = yield* options.spawner.spawn(ChildProcess.make(command, settings)).pipe(
            Effect.mapError(failure("spawn_error", `\`${command}\` could not start`))
          )
          const process = remoteProcessOf(handle, command)
          // A target's exit is not proof that its children ended. Delegate
          // every scope close, including an already observed exit, to the
          // lifecycle's identity-aware, idempotent cleanup. A failed cleanup
          // must fail release rather than be reported as a successful close.
          yield* Effect.addFinalizer(() => deliver(handle, "SIGTERM").pipe(Effect.orDie))
          started.set(process, handle)
          return process
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
        kill: (process, signal) =>
          Effect.suspend(() => {
            const handle = started.get(process)
            /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
            if (handle === undefined) {
              return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
            }
            return deliver(handle, signal)
          }),
        ping: Effect.void,
        // Native overrides for the derived filesystem. They take the path
        // they are handed: `Sandbox.fileSystem` installs an override THROUGH
        // its workdir resolver, so the rooting rule lives in one place rather
        // than being restated by every adapter that supplies overrides.
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
        } satisfies Partial<FileSystem.FileSystem>,
        fork: (childKey) => open(childKey, workdir)
      }
      return session
    })
  return { acquire: (sessionKey) => open(sessionKey) }
}
