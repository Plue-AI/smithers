/**
 * Runs operator bookkeeping on this machine's own process spawner.
 *
 * The flow's own spawner is capability-checked and confined: a child gets a
 * private HOME, reads nothing outside the checkout, and writes nothing outside
 * it. Operator bookkeeping needs the operator's state, so it runs here
 * instead: the issue claim (gh login, machine-wide throttle in ~/.cache), the
 * issue read (gh login), the account pools (~/.smithers/accounts), the jj
 * workspaces beside the checkout, and the push to GitHub. Code an agent wrote
 * never runs here: the agent runs inside its own Codex or Claude sandbox, and
 * the landing checks run inside `codex sandbox`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { type Duration, Effect, Schedule, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { homedir } from "node:os"

export class HostFailed extends Schema.TaggedError<HostFailed>()("issue-sweep/HostFailed", {
  message: Schema.String
}) {}

/** What one finished process printed, and how it exited. */
export interface Exited {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export interface RunOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
}

/**
 * The workspace a failed `jj -R <workspace> ...` must bring up to date before
 * it is tried again, or `undefined`. Many writers share one repository, so a
 * workspace's last operation can end up beside the repository's head instead
 * of under it; jj then refuses every command there until the workspace is
 * updated. One such refusal used to stop a whole sweep round.
 */
export const staleWorkspace = (args: ReadonlyArray<string>, exited: Exited): string | undefined => {
  if (exited.code === 0 || args[0] !== "-R" || args[1] === undefined) return undefined
  return /seems to be a sibling of the working copy's operation|The working copy is stale/.test(exited.stderr)
    ? args[1]
    : undefined
}

/**
 * Runs `command` with `args` on the host and waits for it. Output streams are
 * read concurrently so a full pipe never deadlocks the child; closing the
 * scope (an interrupt, a timeout) kills the process. A `jj -R` command refused
 * because its workspace fell behind ({@link staleWorkspace}) runs once more
 * after `jj workspace update-stale` there.
 */
export const run = (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
  Effect.flatMap(once(command, args, options), (exited) => {
    const stale = command === "jj" ? staleWorkspace(args, exited) : undefined
    return stale === undefined
      ? Effect.succeed(exited)
      : Effect.andThen(once("jj", ["-R", stale, "workspace", "update-stale"], options), once(command, args, options))
  })

const once = (command: string, args: ReadonlyArray<string>, options: RunOptions) =>
  Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
      stdin: "ignore"
    }))
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return { stdout, stderr, code: Number(code) } satisfies Exited
  })).pipe(
    Effect.catchTag(
      "PlatformError",
      (cause) => Effect.fail(new HostFailed({ message: `${command}: ${cause.message}` }))
    ),
    Effect.provide(NodeServices.layer)
  )

/** The last `lines` lines of `text`, for a failure message. */
export const tail = (text: string, lines = 5) => text.trim().split("\n").slice(-lines).join("\n")

/** Runs `command` and answers its stdout; a non-zero exit is {@link HostFailed}. */
export const output = (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
  Effect.flatMap(run(command, args, options), (exited) =>
    exited.code === 0
      ? Effect.succeed(exited.stdout)
      : Effect.fail(
        new HostFailed({ message: `${command} ${args[0] ?? ""}: exit ${exited.code}: ${tail(exited.stderr)}` })
      ))

/** The checkout every issue workspace branches from. */
export const repository = `${homedir()}/smithers`

/** Where the per-issue jj workspaces live: beside the checkout, never inside it. */
export const workspaces = `${homedir()}/smithers-sweep`

/** The jj workspace of one issue. */
export const workspaceOf = (issue: number) => `${workspaces}/issue-${issue}`

/** The jj workspace name of one issue. */
export const workspaceName = (issue: number) => `sweep-${issue}`

// What git and curl print when the network, not the repository, failed.
const networkOutage =
  /Could not resolve host|Failed to connect to|Connection timed out|Operation timed out|Connection reset|Recv failure|Network is unreachable|Temporary failure in name resolution|SSL_ERROR_SYSCALL|The remote end hung up unexpectedly/

/** Whether a failure's message says the network was down rather than the work being wrong. */
export const isNetworkOutage = (message: string): boolean => networkOutage.test(message)

/**
 * Retries `effect` while it fails because the network is down: 15 s, doubling
 * to 5 min between tries, eight tries (about 20 min). A 75-minute DNS outage
 * on 2026-10-01 failed 109 landings and 9 adoptions of finished agent work
 * as final; a failure for any other reason is not retried.
 */
export const ridingOutages = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
  first: Duration.Input = "15 seconds"
) =>
  Effect.retry(effect, {
    while: (error: E) => isNetworkOutage(error.message),
    schedule: Schedule.min([Schedule.exponential(first), Schedule.spaced("5 minutes")]),
    times: 8
  })
