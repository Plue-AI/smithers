/**
 * The known-red list: targets already failing on the trunk, named with an
 * owner and an expiry, so an execution fails only on a target that turned red
 * since.
 *
 * A trunk that has been red for weeks gives no signal: every run fails, so a
 * new regression looks exactly like the old ones. Requiring the whole graph
 * green before anything can land stalls every change behind the slowest fix.
 * The list is the middle: a failure it names is still executed and still
 * reported, but it does not fail the command; any other failure does. An entry
 * past its expiry names nothing, so the list cannot become a permanent mute.
 *
 * The file is JSON:
 *
 * ```json
 * {
 *   "entries": [
 *     {
 *       "label": "//packages/example:test",
 *       "platforms": ["win32"],
 *       "owner": "will",
 *       "reason": "path separators in snapshot names",
 *       "issue": "https://github.com/smithersai/smithers/issues/1",
 *       "expires": "2026-10-09"
 *     }
 *   ]
 * }
 * ```
 *
 * `platforms` is optional and matches `process.platform`; omitted, the entry
 * applies on every platform. `issue` is required: a muted failure is tracked
 * work, so every entry names the issue that will clear it. `expires` is the
 * last day, in UTC, the entry holds.
 *
 * @since 1.0.0
 */

import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import type * as Executor from "./Executor.ts"

/**
 * One known-red target.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  readonly label: string
  readonly platforms?: ReadonlyArray<string> | undefined
  readonly owner: string
  readonly reason: string
  readonly issue: string
  readonly expires: string
}

/**
 * What applying the list to one execution found.
 *
 * `known` failed and is named by a live entry; `newlyRed` failed and is not;
 * `expired` names entries on this platform whose expiry has passed; `recovered`
 * names live entries whose target executed green, so the entry can go.
 * `unrun` names unlisted targets skipped because a dependency was red: an
 * entry excuses its own failure, never the consumers it kept from running.
 *
 * @category models
 * @since 1.0.0
 */
export interface Verdict {
  readonly source: string
  readonly known: ReadonlyArray<string>
  readonly newlyRed: ReadonlyArray<string>
  readonly unrun: ReadonlyArray<string>
  readonly expired: ReadonlyArray<string>
  readonly recovered: ReadonlyArray<string>
}

/**
 * An execution summary judged against the list.
 *
 * @category models
 * @since 1.0.0
 */
export interface JudgedSummary extends Executor.Summary {
  readonly knownRed: Verdict
}

/**
 * The file is missing, is not JSON, or an entry is malformed.
 *
 * @category errors
 * @since 1.0.0
 */
export class KnownRedError extends Error {
  override readonly name = "KnownRedError"
}

const day = /^\d{4}-\d{2}-\d{2}$/

const text = (value: unknown, field: string, at: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KnownRedError(`${at}: "${field}" must be a non-empty string`)
  }
  return value
}

/**
 * Parses and validates the list's JSON text.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (source: string, content: string): ReadonlyArray<Entry> => {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (cause) {
    throw new KnownRedError(`${source}: not JSON (${(cause as Error).message})`)
  }
  const entries = (json as { readonly entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) throw new KnownRedError(`${source}: "entries" must be an array`)
  const seen = new Set<string>()
  return entries.map((raw: unknown, index): Entry => {
    const at = `${source} entries[${index}]`
    if (typeof raw !== "object" || raw === null) throw new KnownRedError(`${at}: must be an object`)
    const row = raw as Record<string, unknown>
    const label = text(row.label, "label", at)
    if (!label.startsWith("//")) throw new KnownRedError(`${at}: "label" must be a target label such as //pkg:test`)
    const expires = text(row.expires, "expires", at)
    if (!day.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      throw new KnownRedError(`${at}: "expires" must be a YYYY-MM-DD date`)
    }
    let platforms: ReadonlyArray<string> | undefined
    if (row.platforms !== undefined) {
      if (!Array.isArray(row.platforms) || row.platforms.length === 0) {
        throw new KnownRedError(`${at}: "platforms" must be a non-empty array when present`)
      }
      platforms = row.platforms.map((platform, position) => text(platform, `platforms[${position}]`, at))
    }
    const key = `${label} ${platforms === undefined ? "*" : [...platforms].sort().join(",")}`
    if (seen.has(key)) throw new KnownRedError(`${at}: duplicate entry for ${label}`)
    seen.add(key)
    return {
      label,
      ...(platforms === undefined ? {} : { platforms }),
      owner: text(row.owner, "owner", at),
      reason: text(row.reason, "reason", at),
      issue: text(row.issue, "issue", at),
      expires
    }
  })
}

/**
 * Reads and parses the list at `path`, resolved against `directory`.
 *
 * @category parsing
 * @since 1.0.0
 */
export const read = async (directory: string, path: string): Promise<{
  readonly source: string
  readonly entries: ReadonlyArray<Entry>
}> => {
  const absolute = NodePath.resolve(directory, path)
  let content: string
  try {
    content = await NodeFs.readFile(absolute, "utf8")
  } catch (cause) {
    throw new KnownRedError(`${path}: cannot read the known-red list (${(cause as Error).message})`)
  }
  return { source: path, entries: parse(path, content) }
}

/**
 * Judges one execution against the list.
 *
 * `today` is a `YYYY-MM-DD` UTC date. The summary's `ok` is true when every
 * failure is named by a live entry for `platform` and no unlisted target was
 * skipped for a red dependency.
 *
 * @category judging
 * @since 1.0.0
 */
export const judge = (
  summary: Executor.Summary,
  list: { readonly source: string; readonly entries: ReadonlyArray<Entry> },
  context: { readonly platform: string; readonly today: string }
): JudgedSummary => {
  const here = list.entries.filter((entry) =>
    entry.platforms === undefined || entry.platforms.includes(context.platform)
  )
  const live = new Set(here.filter((entry) => entry.expires >= context.today).map((entry) => entry.label))
  const expired = here.filter((entry) => entry.expires < context.today).map((entry) => entry.label)
  const failed = summary.results.filter((row) => row.status === "failed").map((row) => row.label)
  const green = new Set(
    summary.results.filter((row) => row.status === "ran" || row.status === "hit").map((row) => row.label)
  )
  const known = failed.filter((label) => live.has(label))
  const newlyRed = failed.filter((label) => !live.has(label))
  const unrun = summary.results
    .filter((row) => row.status === "skipped" && row.blockedBy !== undefined && !live.has(row.label))
    .map((row) => row.label)
  return {
    ...summary,
    ok: newlyRed.length === 0 && unrun.length === 0,
    knownRed: {
      source: list.source,
      known,
      newlyRed,
      unrun,
      expired,
      recovered: [...live].filter((label) => green.has(label))
    }
  }
}

/**
 * The lines a person reads about the verdict, one per finding.
 *
 * @category rendering
 * @since 1.0.0
 */
export const describe = (verdict: Verdict): ReadonlyArray<string> => [
  ...verdict.known.map((label) => `known red (${verdict.source}): ${label}`),
  ...verdict.newlyRed.map((label) => `newly red, not in ${verdict.source}: ${label}`),
  ...verdict.unrun.map((label) => `not run, a dependency is red: ${label}`),
  ...verdict.expired.map((label) => `expired entry in ${verdict.source}, no longer excused: ${label}`),
  ...verdict.recovered.map((label) => `green again, remove from ${verdict.source}: ${label}`)
]

/**
 * Today's `YYYY-MM-DD` date in UTC.
 *
 * @category judging
 * @since 1.0.0
 */
export const today = (now: Date = new Date()): string => now.toISOString().slice(0, 10)
