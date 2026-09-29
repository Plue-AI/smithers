/**
 * Serves the session contract over a CLI's `exec` verb.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../Sandbox/Session.ts"
import { decodeBase64Bytes, encodeBase64Bytes } from "./base64.ts"
import { environmentInput } from "./environmentInput.ts"
import { checkEnvironmentNames } from "./environmentNames.ts"
import { envPrefix } from "./envPrefix.ts"
import { finalizeWithin } from "./finalizeWithin.ts"
import { parentOf } from "./guestPath.ts"
import { cancelGuard, killScript } from "./killScript.ts"
import { gather, type GatheredRun, providerFailure, remoteProcessOf } from "./localProcess.ts"
import { pidDirectory } from "./pidDirectory.ts"
import { rootedAt } from "./rootedPath.ts"

/**
 * One spawned command, ready for the provider to shape into its CLI's argv.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecSpawn {
  /** The working directory, already rooted at the session workdir. */
  readonly cwd: string
  /** Records the shell's pid, then refuses to start a cancelled command. */
  readonly record: ReadonlyArray<string>
  /** The guest file `record` writes the pid to. */
  readonly pidfile: string
  /** Applies the environment and execs the command under `/bin/sh -c`. */
  readonly command: string
  /** The exec's input channel, present only when there is input to carry. */
  readonly stdin: Stream.Stream<Uint8Array> | undefined
}

/**
 * What a CLI-exec provider contributes: how its CLI runs and how its `exec`
 * verb is spelled. Everything else is the shared session.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecSessionOptions {
  readonly id: string
  /** The machine's name, which is also the session's `remoteId`. */
  readonly name: string
  /** What messages call the machine, such as `container` or `pod`. */
  readonly noun: string
  /** The CLI, as messages name it. */
  readonly program: string
  readonly workdir: string
  /** How file bytes cross the CLI: verbatim, or as base64 text. */
  readonly encode: "raw" | "base64"
  /** Runs the CLI to completion. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<GatheredRun, ProviderError>
  /** Starts the CLI, leaving the handle to the caller's scope. */
  readonly launch: (
    args: ReadonlyArray<string>,
    stdin: Stream.Stream<Uint8Array> | undefined
  ) => Effect.Effect<ChildProcessHandle, unknown, Scope.Scope>
  /**
   * The argv running `/bin/sh -c script` in the machine. The shell is
   * absolute so a machine-wide PATH override cannot disable the provider's
   * own plumbing.
   */
  readonly shell: (script: string, interactive: boolean) => ReadonlyArray<string>
  /** The argv running one spawned command. */
  readonly spawn: (spawn: ExecSpawn) => ReadonlyArray<string>
  /** The argv of a liveness probe. */
  readonly ping: ReadonlyArray<string>
  /** The guest pidfile directory. Default {@link pidDirectory}; a machine shared by several sessions needs one each. */
  readonly pids?: string | undefined
}

/**
 * Prepares the workspace and the pidfile directory, then serves the session
 * contract over the provider's `exec`.
 *
 * Signalling the local CLI client does not reach the guest process, so every
 * spawned command records its own pid in a session-private guest directory
 * first, and `kill` execs a second command that signals that pid and every
 * descendant. Closing a spawn's scope is the process's lifetime ending:
 * unless the command was already observed to end, the guest process is
 * signalled through the same pid walk, so a scope cannot close on a
 * still-running guest. The directory is wiped here, so a reattached machine
 * cannot mis-target a previous incarnation's pids, and the per-acquire
 * pidfile counter cannot collide with its files.
 *
 * The caller's variables travel through stdin to an `env(1)` prefix on the
 * inner shell rather than as CLI flags: they belong to the command, not to
 * the plumbing that starts it, and a caller's `PATH` override must not keep
 * the wrapper's own shell from starting. `env(1)`, not `export`: `export` is
 * a special builtin, so a name it refuses would abort the whole script.
 * `checkEnvironmentNames` refuses non-identifier names up front, because the
 * inner shell rebuilds its environment from shell identifiers as it starts.
 *
 * @category constructors
 * @since 0.1.0
 */
export const execSession = (options: ExecSessionOptions): Effect.Effect<Session, ProviderError> =>
  Effect.gen(function*() {
    const { encode, name, noun, program, workdir } = options
    const pids = options.pids ?? pidDirectory
    const prepare = options.shell(
      `mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${CommandLine.quote(pids)} && mkdir -p ${
        CommandLine.quote(pids)
      }`,
      false
    )
    const prepared = yield* options.run(prepare)
    if (prepared.code !== 0) {
      return yield* Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `the workspace ${workdir} could not be prepared in ${name}: \`${program} ${
            prepare[0]
          }\` exited ${prepared.code}: ${prepared.stderr.trim()}`
        })
      )
    }
    let nextPidfile = 0
    const pidfiles = new WeakMap<RemoteProcess, string>()
    const resolveCwd = rootedAt(workdir)
    const deliver = (pidfile: string, signal: string): Effect.Effect<void, ProviderError> =>
      Effect.flatMap(
        options.run(options.shell(killScript(pidfile, signal.replace(/^SIG/, "")), false)),
        (result) =>
          result.code === 0 ? Effect.void : Effect.fail(
            new ProviderError({
              code: "unknown",
              message: `the signal ${signal} could not be delivered in ${name}: ${result.stderr.trim()}`
            })
          )
      )
    const session: Session = {
      id: options.id,
      remoteId: name,
      workdir,
      spawn: Effect.fnUntraced(function*(command, spawnOptions) {
        yield* checkEnvironmentNames(spawnOptions.env)
        const pidfile = `${pids}/${nextPidfile++}.pid`
        const input = environmentInput(envPrefix(spawnOptions.env), spawnOptions.stdin)
        // The pid survives the whole chain: `exec` replaces the recorded
        // shell with env, env replaces itself with `/bin/sh`, and `sh -c`
        // execs a lone simple command. The shell after the prefix is absolute
        // because `env` resolves its program through the environment it just
        // built.
        const handle = yield* options.launch(
          options.spawn({
            cwd: resolveCwd(spawnOptions.cwd ?? ""),
            record: [`echo $$ > ${pidfile}`, cancelGuard(pidfile)],
            pidfile,
            command: `${input.script}exec ${input.prefix}/bin/sh -c ${CommandLine.quote(command)}`,
            stdin: input.stdin
          }),
          input.stdin
        ).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${name}`))
        )
        const raw = remoteProcessOf(handle, command)
        let ended = false
        const process: RemoteProcess = {
          ...raw,
          exitCode: Effect.tap(raw.exitCode, () =>
            Effect.sync(() => {
              ended = true
            }))
        }
        // Closing the process scope ends the local CLI client, which the
        // guest does not notice. The contract says the scope IS the
        // process's lifetime, so the finalizer signals the guest side too,
        // unless the command has already been seen to end.
        yield* Effect.addFinalizer(() =>
          ended
            ? Effect.void
            : finalizeWithin(
              Effect.ignore(deliver(pidfile, "SIGTERM"), { log: "Warn" }),
              `${noun} ${name} process ${pidfile}`
            )
        )
        pidfiles.set(process, pidfile)
        return process
      }),
      kill: (process, signal) =>
        Effect.suspend(() => {
          const pidfile = pidfiles.get(process)
          /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
          if (pidfile === undefined) {
            return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
          }
          return deliver(pidfile, signal)
        }),
      readFile: (path) =>
        Effect.flatMap(
          options.run(options.shell(
            // Redirected, not positional: BSD `base64` takes no file operand,
            // and the redirect reads the same on every guest.
            `test -e ${CommandLine.quote(path)} || exit 9; ${encode === "raw" ? "cat" : "base64 <"} ${
              CommandLine.quote(path)
            }`,
            false
          )),
          (result) =>
            result.code === 0
              ? encode === "raw" ? Effect.succeed(result.stdout) : decodeBase64Bytes(result.stdout, `for ${path}`)
              : result.code === 9
              ? Effect.fail(new ProviderError({ code: "not_found", message: `the ${noun} holds nothing at ${path}` }))
              : Effect.fail(
                new ProviderError({
                  code: "unknown",
                  message: `the ${noun} could not read ${path}: ${result.stderr.trim()}`
                })
              )
        ),
      writeFile: (path, content) =>
        Effect.scoped(
          Effect.gen(function*() {
            const parent = parentOf(path)
            const write = `${encode === "raw" ? "cat" : "base64 -d"} > ${CommandLine.quote(path)}`
            const script = parent === undefined ? write : `mkdir -p ${CommandLine.quote(parent)} && ${write}`
            const handle = yield* options.launch(
              options.shell(script, true),
              Stream.make(encode === "raw" ? content : encodeBase64Bytes(content))
            ).pipe(Effect.mapError(providerFailure("spawn_error", `the write to ${path} could not start`)))
            const result = yield* gather(handle, script)
            if (result.code !== 0) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unknown",
                  message: `the ${noun} could not write ${path}: ${result.stderr.trim()}`
                })
              )
            }
          })
        ),
      ping: Effect.flatMap(options.run(options.ping), (result) =>
        result.code === 0 ? Effect.void : Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: `the ${noun} ${name} did not answer: ${result.stderr.trim()}`
          })
        ))
    }
    return session
  })
