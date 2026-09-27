/**
 * Process-group observation read from Linux `/proc`, with no `ps` binary.
 * @since 1.0.0
 */

import { readdirSync, readFileSync } from "node:fs"
import type * as ProcessCleanup from "./ProcessCleanup.ts"

/**
 * The kernel's own process table, which is the production root.
 * @private
 * @since 1.0.0
 */
export const defaultProcRoot = "/proc"

/**
 * The `/proc` root a platform publishes its process table under, if any.
 * @private
 * @since 1.0.0-rc.1
 */
export const rootFor = (platform: string): string | undefined => platform === "linux" ? defaultProcRoot : undefined

/**
 * `/proc` reports `starttime` in USER_HZ, which Linux fixes at 100 for this
 * interface however the running kernel is configured.
 */
const userHz = 100

/** A pid, as both a directory name and the first field of a stat line. */
const pidName = /^[0-9]+$/

/** `/proc/stat`'s boot instant, in seconds since the epoch. */
const bootLine = /^btime[ \t]+([0-9]+)$/m

/** Fields 3 through 22 inclusive: state, then pgrp third, then starttime. */
const statFieldsAfterComm = 20

/** A read that failed because the file is no longer there. */
const missing = (cause: unknown): boolean => (cause as NodeJS.ErrnoException).code === "ENOENT"

/**
 * One process's group, zombie state and start time, from a `/proc/<pid>/stat`
 * line.
 *
 * `comm` is the second field, it is wrapped in parentheses, and a process may
 * put both spaces and parentheses inside it, so the numeric fields after it are
 * taken from the LAST `)` rather than by splitting the whole line. The first
 * field after that paren is field 3, so field N is at index N - 3.
 *
 * Anything that is not a stat line in that shape answers `undefined` rather
 * than a record built out of whichever fields happened to parse.
 * @private
 * @since 1.0.0
 */
export const parseStat = (
  text: string,
  bootMs: number
): { readonly pgid: number; readonly member: ProcessCleanup.Member } | undefined => {
  const open = text.indexOf("(")
  const close = text.lastIndexOf(")")
  if (open <= 0 || close < open) return undefined
  const head = text.slice(0, open).trim()
  if (!pidName.test(head)) return undefined
  const after = text.slice(close + 1).trim().split(/[ \t]+/)
  if (after.length < statFieldsAfterComm) return undefined
  const pid = Number(head)
  const pgid = Number(after[2])
  const startedTicks = Number(after[19])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(startedTicks)) {
    return undefined
  }
  return {
    pgid,
    // A zombie holds a slot without being a process the caller has to wait for,
    // so the distinction has to survive the read.
    member: { pid, startedAtMs: bootMs + Math.round((startedTicks / userHz) * 1000), zombie: after[0] === "Z" }
  }
}

/**
 * Every member of `pgid`, plus this process's own group, read from `/proc`.
 *
 * Answering `undefined` means the question could not be asked here, which is
 * what a non-Linux host and a `hidepid` mount both produce; the caller keeps
 * its record rather than acting on a table it could not read. A pid that
 * disappears between listing the directory and reading its `stat` is not an
 * unreadable table: it is a process that ended, which is the same end state as
 * never having been in the group, so it is skipped.
 * @private
 * @since 1.0.0
 */
export const snapshot = (root: string) => (pgid: number): ProcessCleanup.Snapshot | undefined => {
  let bootMs: number
  let ownGroup: number
  let names: ReadonlyArray<string>
  try {
    const boot = bootLine.exec(readFileSync(`${root}/stat`, "utf8"))
    if (boot === null) return undefined
    bootMs = Number(boot[1]) * 1000
    if (!Number.isSafeInteger(bootMs)) return undefined
    const self = parseStat(readFileSync(`${root}/self/stat`, "utf8"), bootMs)
    if (self === undefined || self.pgid <= 0) return undefined
    ownGroup = self.pgid
    names = readdirSync(root)
  } catch {
    return undefined
  }
  const members: Array<ProcessCleanup.Member> = []
  for (const name of names) {
    if (!pidName.test(name)) continue
    let text: string
    try {
      text = readFileSync(`${root}/${name}/stat`, "utf8")
    } catch (cause) {
      if (missing(cause)) continue
      return undefined
    }
    const parsed = parseStat(text, bootMs)
    if (parsed === undefined) return undefined
    if (parsed.pgid !== pgid) continue
    members.push(parsed.member)
  }
  return { ownGroup, members }
}

/**
 * This machine's boot instant from `${root}/stat`, in epoch milliseconds, or
 * `undefined` when the table cannot be read here.
 * @private
 * @since 1.0.0
 */
export const bootMs = (root: string): number | undefined => {
  try {
    const boot = bootLine.exec(readFileSync(`${root}/stat`, "utf8"))
    if (boot === null) return undefined
    const ms = Number(boot[1]) * 1000
    return Number.isSafeInteger(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * This process's own process group, read from `/proc/self/stat`, or `null`
 * when the file cannot be read or parsed.
 *
 * The reaper's own-group guard needs this number before it may signal any
 * group. Reading it here instead of from `ps` keeps the guard working on a
 * Linux image that ships no `procps`.
 * @private
 * @since 1.0.0
 */
export const ownGroup = (root: string) => (): number | null => {
  try {
    const self = parseStat(readFileSync(`${root}/self/stat`, "utf8"), 0)
    return self === undefined || self.pgid <= 0 ? null : self.pgid
  } catch {
    return null
  }
}

/**
 * When `pid` started, in epoch milliseconds, read from `/proc/<pid>/stat` and
 * `/proc/stat`'s `btime`.
 *
 * `gone` is the table having no entry for the pid (`ENOENT`). Every other
 * failure is `unavailable`: the question could not be asked, so the caller
 * keeps its record instead of acting on it.
 * @private
 * @since 1.0.0
 */
export const startedAtMs = (root: string) =>
(
  pid: number
):
  | { readonly _tag: "started"; readonly startedAtMs: number }
  | { readonly _tag: "gone" }
  | { readonly _tag: "unavailable" } =>
{
  if (!Number.isSafeInteger(pid) || pid <= 0) return { _tag: "unavailable" }
  const boot = bootMs(root)
  if (boot === undefined) return { _tag: "unavailable" }
  let text: string
  try {
    text = readFileSync(`${root}/${pid}/stat`, "utf8")
  } catch (cause) {
    return missing(cause) ? { _tag: "gone" } : { _tag: "unavailable" }
  }
  const parsed = parseStat(text, boot)
  return parsed === undefined || parsed.member.pid !== pid
    ? { _tag: "unavailable" }
    : { _tag: "started", startedAtMs: parsed.member.startedAtMs }
}
