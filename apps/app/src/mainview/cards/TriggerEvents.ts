/*
 * The event a dispatcher waits for, in words.
 *
 * Two vocabularies meet here. A stored trigger carries a five-field cron
 * expression and an optional timezone (`@smthrs/triggers` Schedule); the
 * card states the common shapes in plain English and falls back to the
 * expression itself, never to a guess: a zone the declaration did not name
 * is not printed, because the scheduler's default zone is the store's fact,
 * not this card's. A declared rule carries an `on` key of the factory's
 * event vocabulary (spec 08 §3: `issue.opened`, `issue.labeled:<label>`,
 * `issue.assigned:@<login>`, `issue_comment.created:@<login>`, `change.landed`, `github.push:<branch>`, `schedule:<cron>`, ...); the card
 * says each in words and prints an unknown key as itself.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const pad = (value: number): string => String(value).padStart(2, "0")

const inRange = (field: string, max: number): number | undefined => {
  if (!/^\d+$/.test(field)) return undefined
  const value = Number(field)
  return value <= max ? value : undefined
}

/** `1,3,5` or `1-5` as day names; undefined for anything the shorthand cannot say. */
const dayNames = (field: string): ReadonlyArray<string> | undefined => {
  const range = /^(\d)-(\d)$/.exec(field)
  const numbers = range === null
    ? field.split(",").map((part) => inRange(part, 7))
    : Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
  if (numbers.some((day) => day === undefined || day > 7)) return undefined
  return numbers.map((day) => DAY_NAMES[(day as number) % 7] as string)
}

const withZone = (text: string, timezone: string | undefined): string =>
  timezone === undefined ? text : `${text} ${timezone}`

/**
 * The plain-English event for one trigger's schedule.
 *
 * @param cron the five-field expression as stored
 * @param timezone the declared zone, when the declaration named one
 */
export const describeSchedule = (cron: string, timezone?: string): string => {
  const fields = cron.trim().split(/\s+/)
  const fallback = withZone(`On the schedule ${cron.trim()}`, timezone)
  if (fields.length !== 5) return fallback
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  const anyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*"
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute)
  const everyNHours = /^\*\/(\d+)$/.exec(hour)
  const atMinute = inRange(minute, 59)
  const atHour = inRange(hour, 23)
  if (anyDay && minute === "*" && hour === "*") return "Every minute"
  if (anyDay && everyNMinutes !== null && hour === "*") return `Every ${everyNMinutes[1]} minutes`
  if (anyDay && atMinute !== undefined && hour === "*") {
    return atMinute === 0 ? "Every hour" : `Every hour at ${pad(atMinute)} minutes past`
  }
  if (anyDay && atMinute !== undefined && everyNHours !== null) {
    return atMinute === 0
      ? `Every ${everyNHours[1]} hours`
      : `Every ${everyNHours[1]} hours at ${pad(atMinute)} minutes past`
  }
  if (atMinute === undefined || atHour === undefined) return fallback
  const time = `${pad(atHour)}:${pad(atMinute)}`
  if (dayOfMonth === "*" && month === "*") {
    if (dayOfWeek === "*") return withZone(`Every day at ${time}`, timezone)
    if (dayOfWeek === "1-5") return withZone(`Every weekday at ${time}`, timezone)
    const days = dayNames(dayOfWeek)
    if (days !== undefined) return withZone(`Every ${days.join(", ")} at ${time}`, timezone)
    return fallback
  }
  const day = inRange(dayOfMonth, 31)
  if (day !== undefined && day > 0 && month === "*" && dayOfWeek === "*") {
    return withZone(`Monthly on day ${day} at ${time}`, timezone)
  }
  return fallback
}

/** The fixed keys of the event vocabulary, in words. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  "issue.opened": "On a new issue",
  "issue.closed": "On an issue closed",
  "change.opened": "On a Change opened",
  "change.updated": "On a Change updated",
  "change.landed": "On a Change landed",
  "box.session.ended": "On a box session ended",
  nomination: "On a nomination",
  manual: "Started by hand"
}

/**
 * The plain-English event for one declared rule's `on` key.
 *
 * @param event the key as projected: a fixed key, `issue.labeled:<label>`,
 * `issue.assigned:@<login>`, `issue_comment.created:@<login>`,
 * `github.push:<branch>` or `schedule:<cron>`
 */
export const describeEvent = (event: string): string => {
  const key = event.trim()
  const fixed = EVENT_WORDS[key]
  if (fixed !== undefined) return fixed
  const colon = key.indexOf(":")
  if (colon !== -1) {
    const family = key.slice(0, colon)
    const argument = key.slice(colon + 1).trim()
    if (family === "schedule" && argument !== "") return describeSchedule(argument)
    if (family === "issue.labeled" && argument !== "") return `On an issue labeled ${argument}`
    const login = /^@[A-Za-z0-9][A-Za-z0-9_-]*$/.test(argument) ? argument : undefined
    if (family === "issue.assigned" && login !== undefined) return `On an issue assigned to ${login}`
    if (family === "issue_comment.created" && login !== undefined) return `On a comment mentioning ${login}`
    if (family === "github.push" && argument !== "") return `GitHub push on ${argument}`
  }
  return key
}
