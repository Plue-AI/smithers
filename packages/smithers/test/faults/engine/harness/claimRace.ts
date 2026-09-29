/**
 * Two control planes reaching for one suspended run at the same instant.
 *
 * The fence being tested is a compare-and-swap in `flows_runs`, so the race has
 * to be real: two operating-system processes, two `SqlControlRuntime`s with
 * different owner identities, one SQLite file. A barrier file holds both
 * racers after they have paid their startup cost, which is what stops the
 * result from being decided by whichever process finished loading first.
 *
 * @since 1.0.0
 */
import { type ChildProcess, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const runner = fileURLToPath(new URL("../fixtures/claimChild.ts", import.meta.url))

/** The `KEY=value` lines a child printed before exiting cleanly. */
type Report = ReadonlyMap<string, string>

const spawnChild = (args: ReadonlyArray<string>): {
  readonly process: ChildProcess
  readonly ready: Promise<void>
  readonly done: Promise<Report>
} => {
  const child = spawn(process.execPath, [runner, ...args], { stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  let announceReady: () => void = () => {}
  let refuseReady: (cause: unknown) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    announceReady = resolve
    refuseReady = reject
  })
  // A child's report counts only once it has exited cleanly, so a racer that
  // printed an outcome and then crashed is a failure rather than a result.
  // `close` rather than `exit`: stdout has drained by then.
  const done = new Promise<Report>((resolve, reject) => {
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const failure = new Error(`claim child exited with ${String(code ?? signal)}\n${out}\n${err}`)
        refuseReady(failure)
        return reject(failure)
      }
      const report = new Map<string, string>()
      for (const match of out.matchAll(/^([A-Z]+)=(.*)$/gm)) report.set(match[1] as string, match[2] as string)
      resolve(report)
    })
  })
  ready.catch(() => {})
  done.catch(() => {})
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    out += chunk
    if (out.includes("READY\n")) announceReady()
  })
  child.stderr?.on("data", (chunk: string) => {
    err += chunk
  })
  return { process: child, ready, done }
}

const field = (report: Report, key: string): string => {
  const value = report.get(key)
  if (value === undefined) throw new Error(`claim child reported no ${key}`)
  return value
}

/**
 * Plans, approves, launches, and parks a run, leaving it suspended and
 * unowned. Returns its id.
 *
 * @since 1.0.0
 * @category constructors
 */
export const suspendedRun = async (filename: string): Promise<string> =>
  field(await spawnChild([filename, "setup", "0", "setup"]).done, "RUN")

/**
 * The run's row as a fresh process reads it back from the shared database.
 *
 * @since 1.0.0
 * @category constructors
 */
export const persistedRun = async (
  filename: string,
  runId: string
): Promise<{ readonly status: string; readonly owner: unknown }> => {
  const report = await spawnChild([filename, "inspect", "0", "inspect", runId]).done
  return { status: field(report, "STATUS"), owner: JSON.parse(field(report, "OWNER")) }
}

/**
 * What one racer got back.
 *
 * @since 1.0.0
 * @category models
 */
export interface ClaimAttempt {
  readonly hostId: string
  /** `won:<receipt tag>` or `lost:<error tag>`. */
  readonly outcome: string
  /** The owner identity the racer presented as its fence after the race. */
  readonly fence: unknown
  /** The fenced write made after the race: `ok:<status>` or `lost:<error tag>`. */
  readonly writeOutcome: string
}

/**
 * Races `hostIds` for `runId` and returns what each one got, including the
 * fenced write each makes afterwards. Both racers are held until both have
 * exited, so neither result is read from a process still running.
 *
 * @since 1.0.0
 * @category constructors
 */
export const raceForClaim = async (
  filename: string,
  runId: string,
  barrier: string,
  hostIds: ReadonlyArray<string>
): Promise<ReadonlyArray<ClaimAttempt>> => {
  const racers = hostIds.map((hostId, index) => ({
    hostId,
    child: spawnChild([filename, hostId, String(200 + index), "resume", runId, barrier])
  }))
  await Promise.all(racers.map((racer) => racer.child.ready))
  writeFileSync(barrier, "go\n")
  const reports = await Promise.all(racers.map((racer) => racer.child.done))
  return racers.map((racer, index) => {
    const report = reports[index] as Report
    return {
      hostId: racer.hostId,
      fence: JSON.parse(field(report, "FENCE")),
      outcome: field(report, "CLAIM"),
      writeOutcome: field(report, "WRITE")
    }
  })
}
