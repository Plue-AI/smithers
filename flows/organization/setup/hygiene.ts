/**
 * `clean`: keeps an unattended host's disk bounded. The service runs it hourly
 * (`service.ts`); it is safe beside a running host.
 *
 * - Logs: each `<state>/logs/*.log` over `SMITHERS_ORG_LOG_MAX_MB` (default
 *   10) is copied to `.1` (older copies shift up to
 *   `SMITHERS_ORG_LOG_KEEP`, default 3) and truncated in place, so the
 *   writer's open append handle keeps working.
 * - Receipts: with `SMITHERS_ORG_RUNS_KEEP_DAYS` set, run directories under
 *   the wiki's `generatedDir` (`Org/Runs`) untouched for that many days are
 *   removed. Unset (the default), every receipt is kept.
 * - Machines: a failed run's workspace machine otherwise stays until the next
 *   start. The workspace machines of runs the engine database records as
 *   finished are removed, with the host running or not, and so is what the
 *   startup sweep removes (see {@link sweepMachines}).
 */
import { Effect } from "effect"
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync
} from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import * as MicrosandboxSandbox from "../../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import { executionDatabasePath } from "../../../packages/smithers/src/internal/ExecutionDatabasePath.ts"
import * as SetupMicrosandbox from "./microsandbox.ts"
import { logsDir } from "./service.ts"
import { absolute, type Command, type Io, loadOrganization, nonEmpty, stateDirOf, withEnvFile } from "./settings.ts"

const megabyte = 1024 * 1024

/** The hygiene policy, read from the environment over the state directory's `.env`. */
export interface Policy {
  readonly logMaxBytes: number
  readonly logKeep: number
  /** `undefined`: keep every receipt. */
  readonly runsKeepDays: number | undefined
}

const whole = (name: string, value: string | undefined, fallback: number | undefined, min: number) => {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer of at least ${min}`)
  return parsed
}

export const policyOf = (env: Io["env"]): Policy => ({
  logMaxBytes: whole("SMITHERS_ORG_LOG_MAX_MB", env.SMITHERS_ORG_LOG_MAX_MB, 10, 1)! * megabyte,
  logKeep: whole("SMITHERS_ORG_LOG_KEEP", env.SMITHERS_ORG_LOG_KEEP, 3, 1)!,
  runsKeepDays: whole("SMITHERS_ORG_RUNS_KEEP_DAYS", env.SMITHERS_ORG_RUNS_KEEP_DAYS, undefined, 1)
})

/** Rotates every `*.log` in `directory` over `maxBytes`; returns the rotated names. */
export const rotateLogs = (directory: string, maxBytes: number, keep: number): Array<string> => {
  if (!existsSync(directory)) return []
  const rotated: Array<string> = []
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".log")).sort()) {
    const file = join(directory, name)
    const stat = statSync(file)
    if (!stat.isFile() || stat.size <= maxBytes) continue
    rmSync(`${file}.${keep}`, { force: true })
    for (let index = keep - 1; index >= 1; index--) {
      if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`)
    }
    // Copy, then truncate: the writer holds the file open for appending.
    copyFileSync(file, `${file}.1`)
    truncateSync(file, 0)
    rotated.push(name)
  }
  return rotated
}

/** The newest modification time anywhere under `path`. */
const newest = (path: string): number => {
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  return readdirSync(path).reduce((latest, entry) => Math.max(latest, newest(join(path, entry))), stat.mtimeMs)
}

/** Removes run directories under `runs` untouched for `days`; returns their names. */
export const pruneReceipts = (runs: string, days: number, now = Date.now()): Array<string> => {
  if (!existsSync(runs)) return []
  const cutoff = now - days * 86_400_000
  const pruned: Array<string> = []
  for (const name of readdirSync(runs).sort()) {
    const path = join(runs, name)
    if (!statSync(path).isDirectory() || newest(path) >= cutoff) continue
    rmSync(path, { recursive: true, force: true })
    pruned.push(name)
  }
  return pruned
}

const finished = new Set(["completed", "failed", "cancelled"])

/** What {@link sweepMachines} needs; tests replace the engine, the holders, and the SDK. */
export interface SweepOptions {
  readonly sdk: MicrosandboxSandbox.Sdk
  readonly installation: string
  /** Every run the engine database records, by id, with its status. */
  readonly statuses: () => Promise<ReadonlyMap<string, string>>
  /** Whether a holder label names a live host process. */
  readonly isAlive: (holder: string) => boolean
}

/**
 * Removes this installation's machines no run will use again: the workspace
 * of a finished run, whoever holds it, and — as `serve` sweeps at startup —
 * a dead holder's machine unless it is the workspace of an unfinished run.
 * The statuses are read before the machines are listed, so a run that starts
 * or finishes in between is left alone. Returns the removed machines' names.
 */
export const sweepMachines = async (options: SweepOptions): Promise<ReadonlyArray<string>> => {
  const statuses = await options.statuses()
  const reaped = await Effect.runPromise(MicrosandboxSandbox.reap({
    sdk: options.sdk,
    owner: options.installation,
    // Every machine is judged by `retain`, which reads the holder itself.
    isAlive: () => Effect.succeed(false),
    retain: (labels) => {
      const key = labels[Workspace.workspaceLabel]
      const status = key === undefined ? undefined : statuses.get(Actions.executionOfWorkspace(key))
      if (status !== undefined && finished.has(status)) return Effect.succeed(false)
      if (options.isAlive(labels[MicrosandboxSandbox.holderLabel] ?? "")) return Effect.succeed(true)
      return Effect.succeed(status !== undefined)
    }
  }))
  return reaped.map((machine) => machine.name)
}

/** The engine database's runs, read the way `serve` reads them at startup; empty before the first start. */
const engineStatuses = (stateDir: string) => async (): Promise<ReadonlyMap<string, string>> => {
  const file = executionDatabasePath(stateDir)
  if (!existsSync(file)) return new Map()
  const [{ platform }, RunCatalogRead] = await Promise.all([
    import("../../../packages/smithers/src/internal/NodeControlHost.ts"),
    import("@smthrs/engine-store/RunCatalogRead")
  ])
  return Effect.runPromise(
    Effect.gen(function*() {
      const catalog = yield* RunCatalogRead.make()
      const statuses = new Map<string, string>()
      let cursor: string | undefined
      do {
        const page = yield* catalog.listRuns(cursor === undefined ? {} : { cursor })
        for (const run of page.runs) statuses.set(run.runId, run.status)
        cursor = page.cursor ?? undefined
      } while (cursor !== undefined)
      return statuses
    }).pipe(Effect.scoped, Effect.provide(platform.database(file)))
  )
}

export const command: Command = {
  name: "clean",
  usage: "clean [--state-dir <dir>]",
  run: async (argv, io) => {
    const { values } = parseArgs({ args: [...argv], options: { "state-dir": { type: "string" } } })
    const stateDir = absolute(io.cwd, nonEmpty(values["state-dir"]) ?? stateDirOf(io.env))
    const env = withEnvFile(io.env, join(stateDir, ".env"))
    const policy = policyOf(env)
    const stamp = new Date().toISOString()
    for (const name of rotateLogs(logsDir(stateDir), policy.logMaxBytes, policy.logKeep)) {
      io.out(`${stamp} rotated ${name}`)
    }
    if (policy.runsKeepDays !== undefined) {
      const root = nonEmpty(env.SMITHERS_ORG_ROOT)
      if (root === undefined) throw new Error("SMITHERS_ORG_RUNS_KEEP_DAYS is set but SMITHERS_ORG_ROOT is not")
      const organization = await loadOrganization(absolute(io.cwd, root))
      const runs = join(absolute(io.cwd, root), organization.loaded.organization.wiki.generatedDir)
      const pruned = pruneReceipts(runs, policy.runsKeepDays)
      if (pruned.length > 0) io.out(`${stamp} pruned ${pruned.length} receipt(s)`)
    }
    const installationFile = join(stateDir, "installation")
    const install = SetupMicrosandbox.locate()
    if (existsSync(installationFile) && install !== undefined) {
      const sdk = await SetupMicrosandbox.sdkOf(install)
      sdk.setDefaultBackend("local")
      const removed = await sweepMachines({
        sdk,
        installation: readFileSync(installationFile, "utf8").trim(),
        statuses: engineStatuses(stateDir),
        isAlive: (await import("../serve.ts")).holderAlive
      })
      if (removed.length > 0) io.out(`${stamp} removed ${removed.length} machine(s)`)
    }
    return 0
  }
}
