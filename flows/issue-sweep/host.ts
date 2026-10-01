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
import { Effect, Schema, Stream } from "effect"
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
 * Runs `command` with `args` on the host and waits for it. Output streams are
 * read concurrently so a full pipe never deadlocks the child; closing the
 * scope (an interrupt, a timeout) kills the process.
 */
export const run = (command: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
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
