/**
 * Constructs the argv-prefix sandbox provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { encodeBase64 } from "../internal/base64.ts"
import { elapsed } from "../internal/deadline.ts"
import { execSession } from "../internal/execSession.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { linuxFileSystem } from "../internal/linuxFileSystem.ts"
import { gather, type GatheredRun } from "../internal/localProcess.ts"
import { pidDirectory } from "../internal/pidDirectory.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"

/**
 * How the provider reaches its machine.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSandboxOptions {
  /** The spawner the prefix runs through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /**
   * The argv that reaches the machine; the guest argv follows it. `[]` is this
   * machine. An effect is asked again for every command, so a transport whose
   * credential expires, such as a workspace SSH grant, stays fresh.
   */
  readonly prefix: ReadonlyArray<string> | Effect.Effect<ReadonlyArray<string>, ProviderError>
  /**
   * Whether the prefix joins the guest argv into one command line that a
   * remote shell parses again, as `ssh` does. Each guest argument is then
   * quoted. Default: true when the prefix's program is `ssh`.
   */
  readonly joinsArguments?: boolean | undefined
  /** The guest workspace path. */
  readonly workdir: string
  /** The machine's name in messages and `remoteId`. Default: the prefix's program, or `machine` for an effect. */
  readonly name?: string | undefined
  /**
   * How often a running command checks that the machine still answers as the
   * boot it started on. A probe that answers another boot ends the command
   * with `unavailable` at once; two probes in a row that fail or take twice
   * this long end it the same way. Default 15 seconds.
   */
  readonly heartbeat?: Duration.Input | undefined
}

const bootProbe = "cat /proc/sys/kernel/random/boot_id 2>/dev/null || true"
// One shell-quoted script frame, then the original environment/command input.
// The temporary variable stays in the substitution's subshell, preserving an
// inherited variable with that name. Quoting preserves trailing newlines; the
// exec chain keeps the same stdin and pid.
const scriptBootstrap =
  `eval "$(IFS= read -r smthrs_script && smthrs_script=$(printf %s "$smthrs_script" | base64 -d) && ` +
  `printf 'set -- %s' "$smthrs_script" || printf 'exit 125')" || exit 125; [ "$#" -eq 1 ] || exit 125; exec /bin/sh -c "$1"`

/**
 * Builds a sandbox provider whose machine is whatever the prefix reaches.
 *
 * The provider owns no machine lifecycle: `acquire` prepares the workdir and a
 * session-private pidfile directory, and closing the scope ends the
 * session's commands, removes that directory, and leaves the machine running.
 * Several sessions may share one machine.
 *
 * A transport can outlive its machine: a Smithers Cloud gateway keeps an SSH
 * channel open after the workspace behind it stopped, so the command's exit
 * never arrives. Every command therefore runs beside a heartbeat that asks the
 * machine for its boot id, and a machine that stopped answering or restarted
 * ends the command with `unavailable` instead of leaving it waiting forever.
 *
 * Bytes cross the transport as base64 text, so a prefix that is a text
 * channel, such as `ssh`, carries binary files intact. Failures never carry the
 * prefix's argv, which may hold a credential.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: CommandSandboxOptions): Provider => {
  const current = Effect.isEffect(options.prefix) ? options.prefix : Effect.succeed(options.prefix)
  const name = options.name ?? (Effect.isEffect(options.prefix) ? "machine" : options.prefix[0] ?? "sh")
  const heartbeat = Duration.fromInputUnsafe(options.heartbeat ?? Duration.seconds(15))
  const unreachable = (message: string) => new ProviderError({ code: "unavailable", message })
  const start = (
    args: ReadonlyArray<string>,
    stdin: Stream.Stream<Uint8Array> | undefined
  ): Effect.Effect<ChildProcessHandle, ProviderError, Scope.Scope> =>
    Effect.flatMap(current, (prefix) => {
      const joins = options.joinsArguments ?? /(^|\/)ssh(\.exe)?$/.test(prefix[0] ?? "")
      let guest = args
      let input = stdin
      if (args.length === 3 && args[0] === "/bin/sh" && args[1] === "-c") {
        const script = args[2]!
        if (script.includes("\0")) {
          return Effect.fail(new ProviderError({ code: "spawn_error", message: "shell script must not contain NUL" }))
        }
        const frame = Stream.make(
          new TextEncoder().encode(`${encodeBase64(new TextEncoder().encode(CommandLine.quote(script)))}\n`)
        )
        input = stdin === undefined ? frame : Stream.concat(frame, stdin)
        guest = ["/bin/sh", "-c", scriptBootstrap]
      }
      const [program, ...rest] = [...prefix, ...(joins ? [guest.map(CommandLine.quote).join(" ")] : guest)]
      return options.spawner.spawn(ChildProcess.make(program!, rest, input === undefined ? {} : { stdin: input })).pipe(
        // The platform error names the whole argv; only its kind is kept.
        Effect.mapError((error) => unreachable(`${name} could not be reached: ${error.reason._tag}`))
      )
    })
  const runWith = (launch: typeof start) => (args: ReadonlyArray<string>): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(Effect.flatMap(launch(args, undefined), (handle) => gather(handle, args.join(" "))))
  const run = runWith(start)
  const shell = (script: string) => ["/bin/sh", "-c", script]
  return {
    acquire: (id) =>
      Effect.gen(function*() {
        const probed = yield* run(shell(`uname -s; ${bootProbe}`))
        const [kernel, ...rest] = new TextDecoder().decode(probed.stdout).split("\n")
        let boot = rest.join("").trim()
        const pids = `${pidDirectory}/${sessionSlug(id)}`
        const silent = unreachable(`${name} stopped answering; the command may still be running there`)
        const restarted = unreachable(`${name} restarted; the command it was running is gone`)
        /** The pidfile of each spawned command's argv, whose boot id sits beside it. */
        const pidfiles = new WeakMap<ReadonlyArray<string>, string>()
        // Every beat prints the machine's boot id, which later commands adopt.
        // A spawned command compares it against the boot it recorded as it
        // started; a restart wipes /tmp, so a missing record is a restart too.
        // Any other command compares it against the session's boot as it
        // launched, so each command a restart took fails and none started
        // after it does.
        const beat = (
          pidfile: string | undefined,
          baseline: string
        ): Effect.Effect<"alive" | "restarted" | "silent"> =>
          Effect.map(
            Effect.flatMap(
              start(
                shell(
                  pidfile === undefined
                    ? bootProbe
                    : `b=$(${bootProbe}); printf '%s' "$b"; test -e ${pidfile}.boot && [ "$b" = "$(cat ${pidfile}.boot)" ] || exit 3`
                ),
                undefined
              ),
              (handle) => gather(handle, "heartbeat")
            ),
            (answer) => {
              const now = new TextDecoder().decode(answer.stdout).trim()
              if (answer.code !== 0 && answer.code !== 3) return "silent" as const
              boot = now
              return answer.code === 3 || (pidfile === undefined && now !== baseline)
                ? "restarted" as const
                : "alive" as const
            }
          ).pipe(
            Effect.catch(() => Effect.succeed("silent" as const)),
            Effect.raceFirst(Effect.as(elapsed(Duration.times(heartbeat, 2)), "silent" as const)),
            // Bound the response, then close its process scope. Cleanup is not
            // evidence that a machine which already answered stopped answering.
            Effect.scoped
          )
        // One silent beat is a blip, such as a failed grant fetch; two in a
        // row, or a restart, end the command.
        const watch = (pidfile: string | undefined, baseline: string): Effect.Effect<never, ProviderError> => {
          const loop = (strikes: number): Effect.Effect<never, ProviderError> =>
            Effect.flatMap(Effect.andThen(elapsed(heartbeat), beat(pidfile, baseline)), (answer) =>
              answer === "alive"
                ? loop(0)
                : answer === "restarted"
                ? Effect.fail(restarted)
                : strikes + 1 >= 2
                ? Effect.fail(silent)
                : loop(strikes + 1))
          return loop(0)
        }
        // The command's exit races the heartbeat; a lost machine kills the
        // local client, whose streams then end, and fails the exit.
        const watched: typeof start = (args, stdin) =>
          Effect.gen(function*() {
            const handle = yield* start(args, stdin)
            const lost = yield* Deferred.make<never, ProviderError>()
            yield* Effect.forkScoped(
              watch(pidfiles.get(args), boot).pipe(
                Effect.catch((error) => Effect.andThen(Deferred.fail(lost, error), Effect.ignore(handle.kill())))
              )
            )
            // The handle keeps its prototype; only its exit races the heartbeat.
            return Object.defineProperty(Object.create(handle), "exitCode", {
              value: Effect.raceFirst(handle.exitCode, Deferred.await(lost))
            })
          }) as Effect.Effect<ChildProcessHandle, ProviderError, Scope.Scope>
        const session = yield* execSession({
          id,
          name,
          noun: "machine",
          program: name,
          workdir: options.workdir,
          encode: "base64",
          pids,
          run: runWith(watched),
          launch: watched,
          shell,
          // Every step must succeed before the command runs: a missing cwd
          // runs nothing. The pid directory is made again per command, since
          // a restart wipes /tmp, and the command records the boot it runs on.
          spawn: ({ command, cwd, pidfile, record }) => {
            const argv = shell(
              [
                `cd ${CommandLine.quote(cwd)}`,
                `mkdir -p ${pids}`,
                `(${bootProbe}) > ${pidfile}.boot`,
                ...record,
                `{ ${command}\n}`
              ].join(" && ")
            )
            pidfiles.set(argv, pidfile)
            return argv
          },
          ping: ["true"]
        })
        yield* Effect.addFinalizer(() =>
          finalizeWithin(Effect.ignore(runWith(watched)(shell(`rm -rf ${pids}`))), `${name} ${pids}`)
        )
        // The native metadata operations need GNU or BusyBox tools; another
        // guest, such as macOS behind `[]`, keeps the portable `sh` probes.
        return kernel === "Linux" ? { ...session, files: linuxFileSystem(session, "machine") } : session
      })
  }
}
