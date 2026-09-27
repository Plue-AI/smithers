/**
 * Deployment entry point for the hosted build cache.
 *
 * @since 0.1.0
 */

import { type ChildProcess, spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stateSyncVariable } from "../deployment.ts"
import { failureMessage } from "./failure-message.ts"
import { defaultStateDirectory, redactAlchemyState, type RedactAlchemyStateOptions } from "./redact-state.ts"
import {
  openRemoteState,
  type RemoteState,
  remoteStateFromEnvironment,
  type RemoteStateSession
} from "./remote-state.ts"
import { acquireStateOwnership, type StateOwnership } from "./state-ownership.ts"

const infraDirectory = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const alchemyCli = NodePath.join(infraDirectory, "node_modules", "alchemy", "bin", "cli.js")
const terminationSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const
const escalationDelayMs = 10_000

/** How the Alchemy command ended, as the exit code the wrapper reports for it. */
type CommandResult = { readonly exitCode: number }

const signalExitCode = (signal: NodeJS.Signals): number => {
  switch (signal) {
    case "SIGHUP":
      return 129
    case "SIGINT":
      return 130
    case "SIGTERM":
      return 143
    default:
      return 1
  }
}

const terminateProcessTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The command may already have exited between the close check and kill.
    }
  }
}

const processGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    // Only ESRCH establishes that the group is gone. A refused probe must
    // not cancel escalation or allow redaction while descendants may run.
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Substitutions for the process the wrapper drives.
 *
 * Every field defaults to the production deployment. Naming them keeps the
 * wrapper's own guarantees testable without deploying anything: signal
 * forwarding, escalation, and redaction on every exit path.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeployOptions {
  readonly cli?: string | undefined
  readonly cwd?: string | undefined
  /** The Alchemy state directory the wrapper owns for the whole run. */
  readonly stateDirectory?: string | undefined
  readonly redact?: ((options: RedactAlchemyStateOptions) => Promise<number>) | undefined
  readonly escalationDelayMs?: number | undefined
  /** Where the durable copy of the state lives; defaults to the production R2 bucket. */
  readonly remoteState?: (() => Promise<RemoteState>) | undefined
}

/**
 * {@link DeployOptions} with every omission filled in.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedDeployOptions {
  readonly cli: string
  readonly cwd: string
  readonly stateDirectory: string
  readonly redact: (options: RedactAlchemyStateOptions) => Promise<number>
  readonly escalationDelayMs: number
  readonly remoteState: () => Promise<RemoteState>
}

/**
 * Fills every omitted substitution from the production deployment: the pinned
 * Alchemy CLI, this directory, its state directory, real state redaction, and
 * the R2 bucket that holds the durable state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveDeployOptions = (options: DeployOptions): ResolvedDeployOptions => ({
  cli: options.cli ?? alchemyCli,
  cwd: options.cwd ?? infraDirectory,
  stateDirectory: options.stateDirectory ?? defaultStateDirectory,
  redact: options.redact ?? redactAlchemyState,
  escalationDelayMs: options.escalationDelayMs ?? escalationDelayMs,
  remoteState: options.remoteState ?? (() => remoteStateFromEnvironment())
})

const runAlchemy = (
  command: { readonly cli: string; readonly cwd: string },
  args: ReadonlyArray<string>,
  onSpawn: (child: ChildProcess) => void
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      // pnpm forwards the `--` in `pnpm run deploy -- --yes` literally, and
      // Alchemy reads every argument after it as a positional, so drop it.
      const alchemyArgs = args.filter((arg) => arg !== "--")
      child = spawn(process.execPath, [command.cli, "deploy", "alchemy.run.ts", ...alchemyArgs], {
        cwd: command.cwd,
        detached: process.platform !== "win32",
        env: { ...process.env, [stateSyncVariable]: "1" },
        stdio: "inherit"
      })
    } catch (error) {
      reject(error)
      return
    }
    let finished = false
    const finish = (complete: () => void): void => {
      if (finished) return
      finished = true
      complete()
    }
    onSpawn(child)
    child.once("error", (error) => finish(() => reject(error)))
    child.once("close", (code, signal) =>
      finish(() =>
        resolve({
          /* v8 ignore next -- Node reports a code or a signal on close, never neither, so the fallback is unreachable */
          exitCode: signal !== null ? signalExitCode(signal) : code ?? 1
        })
      ))
  })

/**
 * Runs Alchemy against state synced with R2, and always scrubs local state
 * before returning.
 *
 * The local state directory is a working copy. Before Alchemy starts, the
 * wrapper takes the remote lock and pulls the R2 snapshot over it; after
 * redaction it publishes the snapshot back, conditioned on the version it
 * pulled, whether or not Alchemy succeeded, because a failed run can still
 * have created resources that only its state records. A held remote lock, or
 * any failure to reach R2, refuses the run before Alchemy starts. State that
 * failed redaction is never published.
 *
 * The wrapper owns the state directory from before Alchemy starts until
 * redaction has published its last file, so no other deployment or standalone
 * redaction can replace state under either of them; a second deployment of
 * the same state is refused. Termination signals are held while cleanup runs and are forwarded to the
 * complete detached Alchemy process group. After interruption, the group is
 * tracked until it is observed gone, even if its leader exits first. Surviving
 * members receive SIGKILL after a bounded grace period, before redaction and
 * return. Windows waits for the directly signalled child; ordinary command
 * completion does not wait out the grace period.
 *
 * @category commands
 * @since 0.1.0
 */
export const deploy = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
  options: DeployOptions = {}
): Promise<number> => {
  const { cli, cwd, escalationDelayMs: escalationDelay, redact, remoteState, stateDirectory } = resolveDeployOptions(
    options
  )
  const target = { cli, cwd }
  let ownership: StateOwnership
  try {
    // Alchemy creates the state directory on first use; creating it here lets
    // ownership exist before Alchemy writes anything into it.
    await Fs.mkdir(stateDirectory, { recursive: true })
    ownership = await acquireStateOwnership(stateDirectory)
  } catch (error) {
    process.stderr.write(`Alchemy deployment refused: ${failureMessage(error)}\n`)
    return 1
  }
  let remote: RemoteStateSession
  try {
    remote = await openRemoteState(await remoteState(), stateDirectory, {
      host: NodeOs.hostname(),
      pid: process.pid,
      startedAt: new Date().toISOString()
    })
  } catch (error) {
    await ownership.release()
    process.stderr.write(`Alchemy deployment refused: ${failureMessage(error)}\n`)
    return 1
  }
  let activeChild: ChildProcess | undefined
  let requestedSignal: NodeJS.Signals | undefined
  let escalationTimer: ReturnType<typeof setTimeout> | undefined

  const clearEscalation = (): void => {
    if (escalationTimer !== undefined) clearTimeout(escalationTimer)
    escalationTimer = undefined
  }
  const forward = (signal: NodeJS.Signals): void => {
    const child = activeChild
    if (child === undefined) return
    terminateProcessTree(child, signal)
    if (signal !== "SIGKILL") {
      clearEscalation()
      escalationTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), escalationDelay)
    }
  }
  const waitForProcessGroup = async (): Promise<void> => {
    const pid = activeChild?.pid
    if (requestedSignal === undefined || process.platform === "win32" || pid === undefined) return
    while (processGroupExists(pid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
  const handlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of terminationSignals) {
    const handler = (): void => {
      if (requestedSignal === undefined) {
        requestedSignal = signal
        forward(signal)
      } else {
        forward("SIGKILL")
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }

  let command: CommandResult | undefined
  let commandFailure: unknown
  let redactionFailure: unknown
  let publicationFailure: unknown
  try {
    try {
      // The handlers above are installed and the child is spawned in the
      // same synchronous run, so no signal can arrive before `onSpawn`.
      command = await runAlchemy(
        target,
        args,
        (child) => {
          activeChild = child
        }
      )
    } catch (error) {
      commandFailure = error
    }

    // The leader's close event says nothing about surviving descendants.
    // Keep the group handle and referenced escalation deadline until the
    // interrupted group is gone, including for a second termination signal.
    await waitForProcessGroup()
    activeChild = undefined
    clearEscalation()

    try {
      const redactedFiles = await redact({ directory: stateDirectory, ownership })
      process.stdout.write(`Redacted ${redactedFiles} Alchemy Worker state file(s).\n`)
    } catch (error) {
      redactionFailure = error
    }

    if (redactionFailure === undefined) {
      try {
        const published = await remote.push()
        process.stdout.write(`Remote Alchemy state ${published}.\n`)
      } catch (error) {
        publicationFailure = error
      }
    }
  } finally {
    clearEscalation()
    for (const [signal, handler] of handlers) process.off(signal, handler)
    try {
      await remote.release()
    } catch (error) {
      publicationFailure ??= error
    }
    await ownership.release()
  }

  if (commandFailure !== undefined) {
    process.stderr.write(`Alchemy deployment failed: ${failureMessage(commandFailure)}\n`)
  }
  if (redactionFailure !== undefined) {
    process.stderr.write(`Alchemy state redaction failed: ${failureMessage(redactionFailure)}\n`)
  }
  if (publicationFailure !== undefined) {
    process.stderr.write(`Remote Alchemy state was not published: ${failureMessage(publicationFailure)}\n`)
  }
  if (command === undefined || redactionFailure !== undefined || publicationFailure !== undefined) return 1
  if (requestedSignal !== undefined) return signalExitCode(requestedSignal)
  return command.exitCode
}

const invokedPath = process.argv[1]
/* v8 ignore next 3 -- the process entry runs the pinned Alchemy CLI against the operator's own state; the suite drives every wrapper path through `deploy` with substitutes instead */
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await deploy()
}
