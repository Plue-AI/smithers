/**
 * Reading Smithers 0.x state without adopting it.
 *
 * rc.0 never loads, resumes, or migrates a 0.x run database. It does read one:
 * `smthrs doctor` and `smthrs migrate` both have to answer "does this
 * project still hold runs that have not finished?", and the honest way to
 * answer is to open `smithers.db` and look.
 *
 * The read is deliberately a plain `node:sqlite` read-only open rather than
 * `NodeDatabase.layer`. The layer migrates what it opens, and the one thing
 * this module must never do is write to a 0.x database.
 *
 * @since 1.0.0
 */

import { RunState } from "@smthrs/migrate"
import { existsSync } from "node:fs"

/**
 * 0.x run statuses that mean the run is over.
 *
 * `continued` is a 0.x terminal status with no rc.0 counterpart
 * (the release policy); it is terminal for the purpose of this check.
 *
 * @category constants
 * @since 1.0.0
 */
export const terminalStatuses: ReadonlyArray<string> = RunState.terminalStatuses

/**
 * One 0.x run that has not reached a terminal status.
 *
 * @category models
 * @since 1.0.0
 */
export interface Run {
  readonly runId: string
  readonly workflowName: string
  readonly status: string
}

/**
 * What a 0.x database holds.
 *
 * `readable: false` is not "no runs": a locked or corrupt file is a database
 * whose contents are unknown, and a refusal is the only safe answer.
 *
 * @category models
 * @since 1.0.0
 */
export interface Database {
  readonly path: string
  readonly readable: boolean
  readonly runs: ReadonlyArray<Run>
  readonly reason?: string | undefined
}

/**
 * Lists the non-terminal runs in one 0.x database, read-only.
 *
 * A file with no `_smithers_runs` table is a database this project never ran
 * anything through, and reports no runs rather than failing.
 *
 * @category getters
 * @since 1.0.0
 */
export const read = (path: string): Database => {
  if (!existsSync(path)) return { path, readable: true, runs: [] }
  const finding = RunState.readDatabase(
    path,
    path,
    [],
    Date.now(),
    RunState.defaultLiveWindowMs
  )
  return {
    path,
    readable: finding.readable,
    runs: [...finding.live, ...finding.parked]
      .sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0)
      .map(({ runId, workflowName, status }) => ({ runId, workflowName, status })),
    ...(finding.unreadableReason === undefined ? {} : { reason: finding.unreadableReason })
  }
}

/**
 * The refusal `smthrs migrate` prints when a project still holds runs the
 * 1.0 runtime cannot take over.
 *
 * @category constructors
 * @since 1.0.0
 */
export const refusal = (databases: ReadonlyArray<Database>): string | undefined => {
  const unreadable = databases.filter((database) => !database.readable)
  const live = databases.filter((database) => database.runs.length > 0)
  if (unreadable.length === 0 && live.length === 0) return undefined
  const lines: Array<string> = [
    "Refusing to migrate: this project still holds Smithers 0.x run state."
  ]
  for (const database of unreadable) {
    lines.push(`  ${database.path}: unreadable (${database.reason ?? "unknown"})`)
  }
  for (const database of live) {
    lines.push(`  ${database.path}:`)
    for (const run of database.runs) {
      lines.push(`    ${run.runId} ${run.status} (${run.workflowName})`)
    }
  }
  lines.push(
    "Finish, archive, or discard these runs with the 0.x CLI (bunx smthrs@0.35.0 ps), then run this command again."
  )
  lines.push("See https://smithers.sh/migration/1.0#run-data")
  return lines.join("\n")
}
