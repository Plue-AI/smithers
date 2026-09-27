/**
 * Bounded, explicit-column process probes for real-process tests.
 *
 * Kept on its own subpath because browser test hosts cannot load child_process.
 * @since 1.0.0
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process"

/**
 * Supported POSIX process-table columns.
 * @category models
 * @since 1.0.0
 */
export type Column = "pid" | "ppid" | "pgid" | "stat" | "comm" | "args" | "rss" | "lstart"

/**
 * Explicit columns and an optional single-process selection.
 * @category models
 * @since 1.0.0
 */
export interface Query {
  readonly columns: readonly [Column, ...Array<Column>]
  readonly pid?: number
  readonly timeoutMs?: number
  /** Select a host in transport tests; ordinary callers use the current OS. */
  readonly platform?: NodeJS.Platform
}

/**
 * The process boundary, injectable for buffer and failure regressions.
 * @category models
 * @since 1.0.0
 */
export type Spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnSyncOptionsWithStringEncoding
) => SpawnSyncReturns<string>

/**
 * Queries only the requested columns, with a 64 MiB ceiling for busy hosts.
 * Prefer `comm` for executable names; script-marker containment probes need
 * `args` because an interpreted script's executable name is its interpreter.
 * A missing selected pid returns empty text. Probe failures always throw, so
 * an overflow or permission failure cannot masquerade as successful cleanup.
 * @category getters
 * @since 1.0.0
 */
export const query = (input: Query, spawn: Spawn = spawnSync): string => {
  const { columns, pid, timeoutMs, platform = process.platform } = input
  if (platform === "win32") {
    return queryWindows(input, spawn)
  }
  const result = spawn("ps", [
    ...(pid === undefined ? ["-A"] : ["-p", String(pid)]),
    "-ww",
    "-o",
    columns.map((column) => `${column}=`).join(",")
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
  })
  if (result.error !== undefined) throw result.error
  if (result.status === 0 && result.stdout.trim() !== "") return result.stdout
  if (pid !== undefined && result.status === 1 && result.stdout.trim() === "") return result.stdout
  throw new Error(`ps failed (${result.status}): ${result.stderr}`)
}

/**
 * Windows has no `ps`; query the operating system's process records directly.
 *
 * @category getters
 * @since 1.0.0
 */
export const queryWindows = ({ columns, pid, timeoutMs }: Query, spawn: Spawn = spawnSync): string => {
  if (columns.includes("pgid")) throw new Error("Windows has no POSIX process groups")
  const expressions: Record<Exclude<Column, "pgid">, string> = {
    pid: "[string]$p.ProcessId",
    ppid: "[string]$p.ParentProcessId",
    stat: "'S'",
    comm: "[string]$p.Name",
    args: "([string]$p.CommandLine -replace '[\\r\\n]+', ' ')",
    rss: "[string][math]::Ceiling([double]$p.WorkingSetSize / 1024)",
    lstart: "$p.CreationDate.ToString('ddd MMM dd HH:mm:ss yyyy', [Globalization.CultureInfo]::InvariantCulture)"
  }
  const fields = columns.map((column) => expressions[column as Exclude<Column, "pgid">]).join(", ")
  const filter = pid === undefined ? "" : ` -Filter 'ProcessId = ${pid}'`
  const script =
    `$ErrorActionPreference = 'Stop'; foreach ($p in (Get-CimInstance Win32_Process${filter})) { [Console]::Out.WriteLine((@(${fields}) -join ' ')) }`
  const result = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    env: process.env
  })
  if (result.error !== undefined) throw result.error
  if (result.status === 0 && (result.stdout.trim() !== "" || pid !== undefined)) return result.stdout
  throw new Error(`Windows process query failed (${result.status}): ${result.stderr}`)
}
