/**
 * Upcoming events from iCalendar feeds, merged into a note's "Upcoming events"
 * section. The flow owns one marked block there: it adds each new event as an
 * unchecked item, keeps every item already in the block exactly as written,
 * and replaces its own failure lines each run. An event whose title already
 * appears elsewhere in the note, or whose date and title are already listed,
 * is not added again.
 */
import { Schema } from "effect"
import { day, get, type Host, readNote, resolveNote, writeNote } from "../note.ts"

export const Payload = {
  /** The note, relative to the workspace root. */
  note: Schema.String,
  /** The iCalendar feed URLs, http or https. */
  feeds: Schema.Array(Schema.String),
  /** How many days ahead of today to include; 14 when absent. */
  days: Schema.optional(Schema.Int),
  /** The IANA time zone whose dates the events are listed in; UTC when absent. */
  timeZone: Schema.optional(Schema.String)
}
export type Payload = Schema.Struct<typeof Payload>["Type"]

export const Receipt = Schema.Struct({
  note: Schema.String,
  added: Schema.Int,
  changed: Schema.Boolean,
  failures: Schema.Array(Schema.String)
})
export type Receipt = typeof Receipt.Type

export const heading = "## Upcoming events"
export const start = "<!-- calendar-events -->"
export const end = "<!-- /calendar-events -->"

export interface Event {
  readonly date: string
  readonly title: string
  readonly location: string
  readonly url: string
}

/** Markdown-inert text: one line, with link, markup and comment brackets escaped. */
const inert = (text: string) => text.replace(/\s+/g, " ").trim().replace(/([\\[\]<>`*_])/g, "\\$1")

const unescape = (value: string) =>
  value.replace(/\\([\\,;nN])/g, (_, char: string) => char === "n" || char === "N" ? " " : char)

const link = (value: string) => {
  try {
    const url = new URL(value.trim())
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")
      : ""
  } catch {
    return ""
  }
}

/** The date an iCalendar DTSTART names, in `timeZone` when it is a UTC instant. */
const startDate = (params: string, value: string, timeZone: string) => {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (match === null) return undefined
  const [, y, m, d, hh, mm, ss, utc] = match
  if (utc === undefined || /;TZID=/i.test(params)) return `${y}-${m}-${d}`
  return day(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))), timeZone)
}

/** Every VEVENT in `text` with a start date and a summary. */
export const parse = (text: string, timeZone: string): Array<Event> => {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n")
  const events: Array<Event> = []
  let fields: Map<string, { params: string; value: string }> | undefined
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      fields = new Map()
      continue
    }
    if (line === "END:VEVENT" && fields !== undefined) {
      const dtstart = fields.get("DTSTART")
      const date = dtstart === undefined ? undefined : startDate(dtstart.params, dtstart.value, timeZone)
      const title = inert(unescape(fields.get("SUMMARY")?.value ?? ""))
      if (date !== undefined && title.length > 0) {
        events.push({
          date,
          title,
          location: inert(unescape(fields.get("LOCATION")?.value ?? "").split(",")[0] ?? ""),
          url: link(fields.get("URL")?.value ?? "")
        })
      }
      fields = undefined
      continue
    }
    if (fields === undefined) continue
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const [name = "", ...params] = line.slice(0, colon).split(";")
    const key = name.toUpperCase()
    if (!fields.has(key)) {
      fields.set(key, { params: params.length === 0 ? "" : `;${params.join(";")}`, value: line.slice(colon + 1) })
    }
  }
  return events
}

export const item = (event: Event) =>
  `- [ ] ${event.date} — ${event.title}${event.location === "" ? "" : ` (${event.location})`}${
    event.url === "" ? "" : ` — [link](${event.url})`
  }`

const failurePrefix = "- failed "
const itemDate = /^- \[.\] (\d{4}-\d{2}-\d{2}) /

/**
 * Merges `events` and today's `failures` into the note's block. Returns the
 * new text and how many events were added.
 */
export const merge = (
  text: string,
  events: ReadonlyArray<Event>,
  failures: ReadonlyArray<{ readonly feed: string; readonly reason: string }>,
  today: string
) => {
  let lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n")
  let open = lines.indexOf(start)
  let close = open === -1 ? -1 : lines.indexOf(end, open + 1)
  if (open === -1 || close === -1) {
    const at = lines.indexOf(heading)
    if (at === -1) {
      lines = [...lines, ...(lines.length === 0 ? [] : [""]), heading, ""]
      open = lines.length
    } else {
      open = at + 1
    }
    lines.splice(open, 0, start, end)
    close = open + 1
  }
  const block = lines.slice(open + 1, close).filter((line) => !line.startsWith(failurePrefix))
  const outside = [...lines.slice(0, open), ...lines.slice(close + 1)].join("\n").toLowerCase()
  const listed = new Set(block.join("\n").toLowerCase().split("\n"))
  const seen = new Set<string>()
  const fresh = events
    .filter((event) => {
      const key = `${event.date} — ${event.title}`.toLowerCase()
      if (seen.has(key) || outside.includes(event.title.toLowerCase())) return false
      seen.add(key)
      return ![...listed].some((line) => line.includes(key))
    })
    .toSorted((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
  const kept = [...block, ...fresh.map(item)].toSorted((a, b) => {
    const left = itemDate.exec(a)?.[1] ?? ""
    const right = itemDate.exec(b)?.[1] ?? ""
    return left.localeCompare(right)
  })
  const failed = failures.map(({ feed, reason }) => `${failurePrefix}${today}: ${inert(feed)} (${reason})`)
  lines.splice(open + 1, close - open - 1, ...kept, ...failed)
  return { text: lines.join("\n") + "\n", added: fresh.length }
}

/** The payload's feeds, window and zone, or why they are refused. */
const validate = (payload: Payload) => {
  const days = payload.days ?? 14
  const timeZone = payload.timeZone ?? "UTC"
  if (payload.feeds.length === 0) return "feeds must name at least one feed"
  if (payload.feeds.some((feed) => link(feed) === "")) return "feeds must be http or https URLs"
  if (!Number.isInteger(days) || days < 0 || days > 366) return "days must be an integer from 0 to 366"
  try {
    day(new Date(0), timeZone)
  } catch {
    return "timeZone must be an IANA time zone"
  }
  return { days, timeZone }
}

/**
 * Fetches every feed and merges the window's events into the note. A refused
 * payload or note is a string failure; a failed feed is written to the note
 * first and then fails the run with its receipt.
 */
export const refresh = async (
  host: Host,
  payload: Payload
): Promise<
  { readonly ok: true; readonly receipt: Receipt } | { readonly ok: false; readonly error: Receipt | string }
> => {
  const options = validate(payload)
  if (typeof options === "string") return { ok: false, error: options }
  const path = await resolveNote(host.root, payload.note)
  if (typeof path !== "string") return { ok: false, error: path.refused }
  const now = host.now()
  const today = day(now, options.timeZone)
  const last = day(new Date(now.getTime() + options.days * 86_400_000), options.timeZone)
  const events: Array<Event> = []
  const failures: Array<{ feed: string; reason: string }> = []
  for (const feed of payload.feeds) {
    const got = await get(host, feed, "text/calendar")
    if (!got.ok) {
      failures.push({ feed, reason: got.reason })
      continue
    }
    if (!got.text.includes("BEGIN:VCALENDAR")) {
      failures.push({ feed, reason: "not an iCalendar feed" })
      continue
    }
    events.push(...parse(got.text, options.timeZone).filter((event) => event.date >= today && event.date <= last))
  }
  const before = await readNote(path)
  const merged = merge(before, events, failures, today)
  const changed = merged.text !== before
  if (changed) await writeNote(path, merged.text)
  const receipt: Receipt = {
    note: payload.note,
    added: merged.added,
    changed,
    failures: failures.map(({ feed, reason }) => `${feed} (${reason})`)
  }
  return failures.length === 0 ? { ok: true, receipt } : { ok: false, error: receipt }
}
