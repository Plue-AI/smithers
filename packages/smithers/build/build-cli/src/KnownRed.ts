/**
 * The known-red list: targets already failing on the trunk, named with an
 * owner and an expiry, so an execution fails only on a target that turned red
 * since, including a different failure of the same target.
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
 *       "expires": "2026-10-09",
 *       "failureDigest": "sha256:253379cf8835d1a7559d89ddee8faa65e06dd0aa69c08f640385716e3cbd9ffd"
 *     }
 *   ]
 * }
 * ```
 *
 * `platforms` is optional and matches `process.platform`; omitted, the entry
 * applies on every platform. `issue` is required: a muted failure is tracked
 * work, so every entry names the issue that will clear it. `expires` is the
 * last day, in UTC, the entry holds. `failureDigest` binds the entry to the
 * complete reviewed diagnostic, normalized by {@link fingerprint}.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import { stripVTControlCharacters } from "node:util"
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
  readonly failureDigest: string
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
  readonly observed: ReadonlyArray<{ readonly label: string; readonly failureDigest: string }>
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
export class KnownRedError extends Data.TaggedError("smithers-build/KnownRedError")<{
  /** `unreadable` when the file could not be read, `invalid` when it is not a valid list. */
  readonly reason: "unreadable" | "invalid"
  readonly message: string
}> {
  constructor(reason: "unreadable" | "invalid", message: string) {
    super({ reason, message })
  }
}

// Preserve filenames and all diagnostic content. Only Smithers mkdtemp roots
// lose their host-specific prefix and six-character random suffix.
const temporaryPath =
  /(?:\/(?:private\/)?tmp\/|\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/T\/|[A-Za-z]:[\\/]Users[\\/][^\\/\s]+[\\/]AppData[\\/]Local[\\/]Temp[\\/])((?:smthrs|flows)-[\w-]+-)[A-Za-z0-9]{6}(?=[\\/\s"')]|$)/g

const normalizeDiagnostic = (error: string): string =>
  stripVTControlCharacters(error).replace(/\r\n/g, "\n")
    .replace(/^\[?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\]?(?=\s)/gm, "<timestamp>")
    .replace(/^\[\d{2}:\d{2}:\d{2}\.\d+\](?= (?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b)/gm, "<timestamp>")
    .replace(/^([ \t]*Start at[ \t]+)\d{2}:\d{2}:\d{2}[ \t]*$/gm, "$1<timestamp>")
    .replace(
      /^[ \t]*Duration[ \t]+\d+(?:\.\d+)?(?:ms|s) \((?:(?:tests|import|transform|setup|worker|environment|collect|prepare) \d+(?:\.\d+)?(?:%|ms|s)(?:, )?)+\)[ \t]*$/gm,
      " Duration <duration>"
    )
    .replace(/^([ \t]*[✓×❯].+) \d+(?:\.\d+)?m?s[ \t]*$/gm, "$1 <duration>")
    .replace(
      /^( +Isolate +\d+ workers spawned · ~)\d+(?:\.\d+)?m?s( startup each \(spawn \+ environment, per file\))$/gm,
      "$1<duration>$2"
    )
    .replace(/^( +at least ~)\d+(?:\.\d+)?m?s( faster with isolate: false .*)$/gm, "$1<duration>$2")
    .replace(temporaryPath, "<tmp>/$1<id>")
    .replace(/<tmp>\/[^\s"')]+/g, (path) => path.replaceAll("\\", "/"))

/**
 * SHA-256 of the complete reviewed failure diagnostic (normalization v1).
 *
 * Normalizes CRLF, ANSI controls, leading UTC ISO log timestamps, and
 * Smithers mkdtemp roots. JSON string values are normalized independently;
 * keys, array order, exit codes, filenames and other numbers remain intact.
 * Failed rows never match by substring, regular-expression or target alone.
 * Listed skipped dependents retain label-based excusal; they have no diagnostic.
 *
 * @category judging
 * @since 1.0.0
 */
export const fingerprint = (error: string): string => {
  let normalized: string
  try {
    // Validate JSON, but keep its original tokens: reserializing the parsed
    // value rounds large numbers and collapses duplicate keys.
    JSON.parse(error)
    normalized = error.replace(
      /"(?:[^"\\]|\\.)*"/g,
      (token: string, offset: number) =>
        /^\s*:/.test(error.slice(offset + token.length))
          ? token
          : JSON.stringify(normalizeDiagnostic(JSON.parse(token) as string))
    )
  } catch {
    normalized = normalizeDiagnostic(error)
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`
}

const day = /^\d{4}-\d{2}-\d{2}$/

const text = (value: unknown, field: string, at: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KnownRedError("invalid", `${at}: "${field}" must be a non-empty string`)
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
    throw new KnownRedError("invalid", `${source}: not JSON (${(cause as Error).message})`)
  }
  const entries = (json as { readonly entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) throw new KnownRedError("invalid", `${source}: "entries" must be an array`)
  const seen = new Set<string>()
  return entries.map((raw: unknown, index): Entry => {
    const at = `${source} entries[${index}]`
    if (typeof raw !== "object" || raw === null) throw new KnownRedError("invalid", `${at}: must be an object`)
    const row = raw as Record<string, unknown>
    const label = text(row.label, "label", at)
    if (!label.startsWith("//")) {
      throw new KnownRedError("invalid", `${at}: "label" must be a target label such as //pkg:test`)
    }
    const expires = text(row.expires, "expires", at)
    if (!day.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      throw new KnownRedError("invalid", `${at}: "expires" must be a YYYY-MM-DD date`)
    }
    let platforms: ReadonlyArray<string> | undefined
    if (row.platforms !== undefined) {
      if (!Array.isArray(row.platforms) || row.platforms.length === 0) {
        throw new KnownRedError("invalid", `${at}: "platforms" must be a non-empty array when present`)
      }
      platforms = row.platforms.map((platform, position) => text(platform, `platforms[${position}]`, at))
    }
    const owner = text(row.owner, "owner", at)
    const reason = text(row.reason, "reason", at)
    const issue = text(row.issue, "issue", at)
    const failureDigest = text(row.failureDigest, "failureDigest", at)
    if (!/^sha256:[a-f0-9]{64}$/.test(failureDigest)) {
      throw new KnownRedError("invalid", `${at}: "failureDigest" must be sha256: followed by 64 lowercase hex digits`)
    }
    const key = `${label} ${platforms === undefined ? "*" : [...platforms].sort().join(",")} ${failureDigest}`
    if (seen.has(key)) throw new KnownRedError("invalid", `${at}: duplicate entry for ${label}`)
    seen.add(key)
    return {
      label,
      ...(platforms === undefined ? {} : { platforms }),
      owner,
      reason,
      issue,
      expires,
      failureDigest
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
    throw new KnownRedError("unreadable", `${path}: cannot read the known-red list (${(cause as Error).message})`)
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
  const active = here.filter((entry) => entry.expires >= context.today)
  const live = new Set(active.map((entry) => entry.label))
  const identities = new Set(active.map((entry) => `${entry.label} ${entry.failureDigest}`))
  const expired = here.filter((entry) => entry.expires < context.today).map((entry) => entry.label)
  const failed = summary.results.filter((row) => row.status === "failed")
  const green = new Set(
    summary.results.filter((row) => row.status === "ran" || row.status === "hit").map((row) => row.label)
  )
  const known: Array<string> = []
  const newlyRed: Array<string> = []
  const observed: Array<{ label: string; failureDigest: string }> = []
  for (const row of failed) {
    const failureDigest = row.error !== undefined && row.error.trim() !== "" ? fingerprint(row.error) : undefined
    if (failureDigest !== undefined) observed.push({ label: row.label, failureDigest })
    const matches = failureDigest !== undefined && identities.has(`${row.label} ${failureDigest}`)
    if (matches) known.push(row.label)
    else newlyRed.push(row.label)
  }
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
      observed,
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
  ...verdict.newlyRed.map((label) => `newly red, no matching failure in ${verdict.source}: ${label}`),
  ...verdict.observed.map(({ label, failureDigest }) => `observed failure: ${label} ${failureDigest}`),
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
