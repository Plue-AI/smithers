/**
 * One daily adoption row per npm package and GitHub repository: the npm
 * download counts for the last day and month, and the repository's stars and
 * forks. A day has at most one row. A row that recorded a failed source is
 * replaced by the next run that day; a complete row is never rewritten.
 */
import { Schema } from "effect"
import { day, get, type Host, readNote, resolveNote, writeNote } from "../note.ts"

export const Payload = {
  /** The note, relative to the workspace root. */
  note: Schema.String,
  npmPackage: Schema.String.check(Schema.isPattern(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/)),
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.+$)[A-Za-z0-9._-]+$/))
}
export type Payload = Schema.Struct<typeof Payload>["Type"]

export const Receipt = Schema.Struct({
  note: Schema.String,
  date: Schema.String,
  row: Schema.String,
  outcome: Schema.Literals(["added", "replaced", "unchanged"]),
  failures: Schema.Array(Schema.String)
})
export type Receipt = typeof Receipt.Type

/** Where the snapshot reads: the npm downloads API and the GitHub REST API. */
export interface TractionHost extends Host {
  readonly npm: string
  readonly github: string
}

export const header = "| date | npm 1d | npm 30d | stars | forks | status |"
const rule = "|---|---|---|---|---|---|"

/** The heading that owns one package and repository's table. */
export const heading = (payload: Payload) => `## npm ${payload.npmPackage} · GitHub ${payload.repository}`

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const json = async (host: TractionHost, url: string) => {
  const got = await get(host, url, "application/json")
  if (!got.ok) return got
  try {
    return { ok: true as const, value: JSON.parse(got.text) as Record<string, unknown> }
  } catch {
    return { ok: false as const, reason: "invalid response" }
  }
}

/** Reads the four numbers; each source that fails is named with a fixed reason. */
export const collect = async (host: TractionHost, payload: Payload) => {
  const failures: Array<string> = []
  const npm = async (period: "last-day" | "last-month", label: string) => {
    const got = await json(host, `${host.npm}/downloads/point/${period}/${payload.npmPackage}`)
    const value = got.ok ? count(got.value.downloads) : undefined
    if (value === undefined) failures.push(`${label} (${got.ok ? "invalid response" : got.reason})`)
    return value
  }
  const npmDay = await npm("last-day", "npm 1d")
  const npmMonth = await npm("last-month", "npm 30d")
  const repo = await json(host, `${host.github}/repos/${payload.repository}`)
  const stars = repo.ok ? count(repo.value.stargazers_count) : undefined
  const forks = repo.ok ? count(repo.value.forks_count) : undefined
  if (stars === undefined || forks === undefined) {
    failures.push(`github (${repo.ok ? "invalid response" : repo.reason})`)
  }
  return { npmDay, npmMonth, stars, forks, failures }
}

export const row = (date: string, snapshot: Awaited<ReturnType<typeof collect>>) => {
  const cell = (value: number | undefined) => value === undefined ? "—" : String(value)
  const status = snapshot.failures.length === 0 ? "ok" : `failed: ${snapshot.failures.join("; ")}`
  return `| ${date} | ${cell(snapshot.npmDay)} | ${cell(snapshot.npmMonth)} | ${cell(snapshot.stars)} | ${
    cell(snapshot.forks)
  } | ${status} |`
}

const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim())

/** Places `line` as `date`'s row in the table under `title`, creating either when absent. */
export const merge = (text: string, title: string, date: string, line: string) => {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n")
  const at = lines.indexOf(title)
  if (at === -1) {
    const lead = lines.length === 0 ? [] : [...lines, ""]
    return { text: [...lead, title, "", header, rule, line].join("\n") + "\n", outcome: "added" as const, row: line }
  }
  let cursor = at + 1
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++
  if (lines[cursor] !== header || lines[cursor + 1] !== rule) {
    lines.splice(at + 1, cursor - at - 1, "", header, rule, line, ...(cursor < lines.length ? [""] : []))
    return { text: lines.join("\n") + "\n", outcome: "added" as const, row: line }
  }
  let end = cursor + 2
  while (end < lines.length && lines[end]!.startsWith("|")) end++
  for (let index = cursor + 2; index < end; index++) {
    const existing = cells(lines[index]!)
    if (existing[0] !== date) continue
    if (existing[5] === "ok" || lines[index] === line) {
      return { text, outcome: "unchanged" as const, row: lines[index]! }
    }
    lines[index] = line
    return { text: lines.join("\n") + "\n", outcome: "replaced" as const, row: line }
  }
  lines.splice(end, 0, line)
  return { text: lines.join("\n") + "\n", outcome: "added" as const, row: line }
}

/**
 * Records today's row. A refused note is a string failure; a failed source is
 * written to the note first and then fails the run with its receipt.
 */
export const snapshot = async (
  host: TractionHost,
  payload: Payload
): Promise<
  { readonly ok: true; readonly receipt: Receipt } | { readonly ok: false; readonly error: Receipt | string }
> => {
  const path = await resolveNote(host.root, payload.note)
  if (typeof path !== "string") return { ok: false, error: path.refused }
  const date = day(host.now(), "UTC")
  const before = await readNote(path)
  const merged = merge(before, heading(payload), date, row(date, await collect(host, payload)))
  if (merged.text !== before) await writeNote(path, merged.text)
  const status = cells(merged.row)[5]!
  const failures = status.startsWith("failed: ") ? status.slice("failed: ".length).split("; ") : []
  const receipt: Receipt = { note: payload.note, date, row: merged.row, outcome: merged.outcome, failures }
  return failures.length === 0 ? { ok: true, receipt } : { ok: false, error: receipt }
}
