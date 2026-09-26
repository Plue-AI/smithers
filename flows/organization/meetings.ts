/**
 * The steps of the weekly one-on-ones and of extra time with the owner.
 *
 * `Org/Meetings.md` (the organization's `meetingsFile`) names the series: a
 * weekday, a slot length, the role order, and the owner's inputs (time zone,
 * the first slot's start, the first date). Until all three inputs are set
 * nothing is planned, booked, or scheduled, and every step says so.
 *
 * - The plan (`Meetings.planWeekly`) is written to
 *   `<generatedDir>/meetings/plan.md`; each slot becomes a weekly Google
 *   Calendar event (keyed, so a repeat never duplicates it) when a calendar
 *   is connected (`SMITHERS_ORG_CALENDAR_ID` and the `SMITHERS_GOOGLE_*`
 *   credentials), and is reported `not connected` otherwise; and each role
 *   gets three schedule triggers on the host's scheduler, in the series' time
 *   zone: prepare the day before, open at the slot's start, follow up at its
 *   end.
 * - A role's preparation is its agenda from its receipts, open tasks,
 *   blockers, and decisions needed, written to its private note
 *   `<generatedDir>/meetings/<role>/<date>.md` before the slot.
 * - At the slot's start the agenda is posted in a direct message from the
 *   owner's Slack app under the role's name; the owner's replies in that
 *   thread are answered by the role, and at the slot's end the thread and the
 *   note's Notes section are the meeting's notes. Without Slack the note is
 *   the only channel and the step says `not connected`. A slot with no notes
 *   is recorded as not held.
 * - The follow-up turns the notes into tasks: they are written to the note
 *   and to the role's open task list, which its next preparation reads.
 * - A role may ask the assistant for extra time: the booking is the first
 *   free slot in the owner's working window (weekdays, 09:00 to 17:00 in the
 *   series' zone) clear of the weekly block, earlier bookings, and, when a
 *   calendar is connected, its busy times; it is written to
 *   `<generatedDir>/meetings/bookings.md` and to the calendar when connected.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Action } from "@smthrs/flow"
import { Clock, Effect, Layer, Option, Result, Schema } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import * as CalendarClient from "../../packages/smithers/agent/integrations/src/googlecalendar/CalendarClient.ts"
import { fromKey as eventIdOf } from "../../packages/smithers/agent/integrations/src/googlecalendar/EventId.ts"
import * as SlackClient from "../../packages/smithers/agent/integrations/src/slack/SlackClient.ts"
import * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import * as Config from "../../packages/smithers/agent/organization/src/Config.ts"
import * as Grants from "../../packages/smithers/agent/organization/src/Grants.ts"
import * as Confined from "../../packages/smithers/agent/organization/src/internal/confined.ts"
import * as Meetings from "../../packages/smithers/agent/organization/src/Meetings.ts"
import * as Profile from "../../packages/smithers/agent/organization/src/Profile.ts"
import * as Trigger from "../../packages/smithers/agent/triggers/src/Trigger.ts"
import * as TriggerStore from "../../packages/smithers/agent/triggers/src/TriggerStore.ts"
import * as Links from "./links.ts"
import { Answer, Stage } from "./schema.ts"

const minute = 60_000
const day = 86_400_000

/** One slot of the weekly block. */
export const Slot = Schema.Struct({
  principal: Profile.PrincipalId,
  startLocal: Schema.String,
  endLocal: Schema.String,
  eventKey: Schema.String,
  rrule: Schema.String,
  dtstartLocal: Schema.String
})

/** The weekly series as the meetings page describes it, or why it is not planned. */
export const Plan = Schema.Struct({
  configured: Schema.Boolean,
  /** Why the series is not planned; empty when it is. */
  reason: Schema.String,
  seriesId: Schema.String,
  timezone: Schema.String,
  weekday: Schema.Int,
  slotMinutes: Schema.Int,
  firstDate: Schema.String,
  blockStart: Schema.String,
  blockEnd: Schema.String,
  slots: Schema.Array(Slot)
})
export type Plan = typeof Plan.Type

/** Reads the meetings page and plans the weekly series. Recorded: a replay reads the plan it made. */
export const LoadPlan = Action.make("organization/meetings-load", {
  implementationVersion: "meetings-load/v1",
  payload: {},
  success: Plan,
  nondeterministic: true
})

/** What the calendar step did: every slot's event, `not connected`, or why it failed. */
export const CalendarReport = Schema.Struct({
  status: Schema.Literals(["connected", "not connected", "failed", "not planned"]),
  reason: Schema.String,
  events: Schema.Array(Schema.Struct({
    principal: Schema.String,
    eventId: Schema.String,
    created: Schema.Boolean,
    url: Schema.NullOr(Schema.String)
  }))
})
export type CalendarReport = typeof CalendarReport.Type

/** Writes each slot's weekly event to the connected calendar, or reports that none is connected. */
export const SyncCalendar = Action.make("organization/meetings-calendar", {
  implementationVersion: "meetings-calendar/v1",
  payload: { plan: Plan },
  success: CalendarReport,
  tier: "irreversible",
  idempotencyKey: (payload) =>
    `organization/meetings-calendar:${createHash("sha256").update(JSON.stringify(payload.plan)).digest("hex")}`
})

/** The schedule triggers the plan registered. */
export const ScheduleReport = Schema.Struct({
  status: Schema.Literals(["scheduled", "not planned"]),
  triggers: Schema.Array(
    Schema.Struct({ id: Schema.String, flowId: Schema.String, cron: Schema.String, timezone: Schema.String })
  ),
  disabled: Schema.Array(Schema.String)
})
export type ScheduleReport = typeof ScheduleReport.Type

/** Registers each slot's prepare, open, and follow-up triggers, and disables those of roles no longer in the order. */
export const Schedule = Action.make("organization/meetings-schedule", {
  implementationVersion: "meetings-schedule/v1",
  payload: { plan: Plan },
  success: ScheduleReport,
  tier: "irreversible",
  idempotencyKey: (payload) =>
    `organization/meetings-schedule:${createHash("sha256").update(JSON.stringify(payload.plan)).digest("hex")}`
})

/** Writes the plan page. */
export const WritePlan = Action.make("organization/meetings-write-plan", {
  implementationVersion: "meetings-write-plan/v1",
  payload: { plan: Plan, calendar: CalendarReport, schedule: ScheduleReport },
  success: Schema.Struct({ path: Schema.String })
})

/** One occurrence of a role's slot, or why there is none. */
export const Occurrence = Schema.Struct({
  found: Schema.Boolean,
  reason: Schema.String,
  principal: Profile.PrincipalId,
  /** The run key of this occurrence's steps: `meetings-<role>-<date>`. */
  key: Schema.String,
  localDate: Schema.String,
  startLocal: Schema.String,
  timezone: Schema.String,
  startMs: Schema.Number,
  endMs: Schema.Number,
  /** The role's private note for this occurrence, relative to the organization root. */
  notePath: Schema.String
})
export type Occurrence = typeof Occurrence.Type

/** Finds a role's occurrence around `at` (now when absent): the next one, the one in progress, or the last one that ended. */
export const FindOccurrence = Action.make("organization/meetings-occurrence", {
  implementationVersion: "meetings-occurrence/v1",
  payload: {
    principal: Profile.PrincipalId,
    which: Schema.Literals(["next", "current", "last"]),
    at: Schema.optionalKey(Schema.Number)
  },
  success: Occurrence,
  nondeterministic: true
})

/** The role's preparation task: its agenda from its receipts, open tasks, blockers, and decisions needed. */
export const PrepareTask = Action.make("organization/meetings-prepare-task", {
  implementationVersion: "meetings-prepare-task/v1",
  payload: { revision: Schema.NonEmptyString, occurrence: Occurrence },
  success: Stage,
  error: Authority.DispatchRefused
})

/** Writes the agenda into the role's private note, keeping any notes already there. */
export const WriteAgenda = Action.make("organization/meetings-write-agenda", {
  implementationVersion: "meetings-write-agenda/v1",
  payload: { occurrence: Occurrence, answer: Answer },
  success: Schema.Struct({ path: Schema.String, agenda: Schema.Array(Schema.String) })
})

/** The owner's direct-message channel with the Slack app, or `not connected`. */
export const OpenDirect = Action.make("organization/meetings-open-direct", {
  implementationVersion: "meetings-open-direct/v2",
  payload: { principal: Profile.PrincipalId, occurrence: Occurrence, at: Schema.optionalKey(Schema.Number) },
  success: Schema.Struct({ connected: Schema.Boolean, channel: Schema.String, reason: Schema.String }),
  nondeterministic: true
})

/** The agenda to post: the note's Agenda section. */
export const ReadAgenda = Action.make("organization/meetings-read-agenda", {
  implementationVersion: "meetings-read-agenda/v2",
  payload: { occurrence: Occurrence },
  success: Schema.Struct({ text: Schema.NonEmptyString, persona: Schema.Struct({ username: Schema.NonEmptyString }) }),
  nondeterministic: true
})

/** Records the thread a meeting was opened in, so the owner's replies reach the role and its follow-up. */
export const RecordThread = Action.make("organization/meetings-record-thread", {
  implementationVersion: "meetings-record-thread/v1",
  payload: { occurrence: Occurrence, channel: Schema.String, thread: Schema.String },
  success: Schema.Struct({ recorded: Schema.Boolean })
})

/** The meeting's notes: the Slack thread's messages and the note's Notes section. */
export const CollectNotes = Action.make("organization/meetings-collect", {
  implementationVersion: "meetings-collect/v1",
  payload: { occurrence: Occurrence },
  success: Schema.Struct({
    held: Schema.Boolean,
    sources: Schema.Array(Schema.String),
    transcript: Schema.String
  }),
  nondeterministic: true
})

/** The role's follow-up task: its notes as tasks. */
export const FollowUpTask = Action.make("organization/meetings-follow-up-task", {
  implementationVersion: "meetings-follow-up-task/v1",
  payload: { revision: Schema.NonEmptyString, occurrence: Occurrence, transcript: Schema.String },
  success: Stage,
  error: Authority.DispatchRefused
})

/** One task a follow-up produced. */
export const Task = Schema.Struct({
  title: Schema.String,
  owner: Schema.String,
  due: Schema.optionalKey(Schema.String)
})
export type Task = typeof Task.Type

/** Writes the follow-up's tasks to the note and the role's open task list. */
export const WriteTasks = Action.make("organization/meetings-write-tasks", {
  implementationVersion: "meetings-write-tasks/v1",
  payload: { occurrence: Occurrence, answer: Answer, held: Schema.Boolean },
  success: Schema.Struct({ path: Schema.String, tasks: Schema.Array(Task) })
})

/** The role's answer to the owner in a meeting thread. */
export const ReplyTask = Action.make("organization/meetings-reply-task", {
  implementationVersion: "meetings-reply-task/v1",
  payload: {
    revision: Schema.NonEmptyString,
    key: Schema.String,
    principal: Profile.PrincipalId,
    channel: Schema.String,
    thread: Schema.String,
    text: Schema.String
  },
  success: Schema.Struct({ stage: Stage, persona: Schema.Struct({ username: Schema.NonEmptyString }) }),
  error: Authority.DispatchRefused
})

/** A booking of the owner's time. */
export const Booking = Schema.Struct({
  booked: Schema.Boolean,
  reason: Schema.String,
  key: Schema.String,
  requestedBy: Schema.String,
  purpose: Schema.String,
  startMs: Schema.Number,
  endMs: Schema.Number,
  localDate: Schema.String,
  startLocal: Schema.String,
  timezone: Schema.String,
  bookedBy: Schema.String,
  calendar: Schema.String,
  path: Schema.String
})
export type Booking = typeof Booking.Type

/** Books extra time with the owner for a role, as the assistant. Keyed by the request, so a repeat returns the same booking. */
export const BookTime = Action.make("organization/meetings-book", {
  implementationVersion: "meetings-book/v1",
  payload: {
    key: Schema.String,
    requestedBy: Profile.PrincipalId,
    purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 240 })),
    notBefore: Schema.optionalKey(Schema.Number)
  },
  success: Booking,
  error: Authority.DispatchRefused,
  tier: "irreversible",
  idempotencyKey: (payload) => `organization/meetings-book:${payload.key}`
})

/** How a meetings step ended, as its receipt and its run record it. */
export const MeetingReport = Schema.Struct({
  key: Schema.String,
  status: Schema.Literals([
    "planned",
    "prepared",
    "opened",
    "followed-up",
    "not held",
    "booked",
    "not planned",
    "refused",
    "blocked"
  ]),
  summary: Schema.String,
  principal: Schema.String,
  paths: Schema.Array(Schema.String),
  /** What happened on Slack: `posted`, `not connected`, or why not. */
  slack: Schema.optionalKey(Schema.String),
  /** What happened on the calendar: `connected`, `not connected`, or why not. */
  calendar: Schema.optionalKey(Schema.String),
  receipt: Schema.optionalKey(Schema.String)
})
export type MeetingReport = typeof MeetingReport.Type

/** A meetings run that ended without doing its work; the receipt says why. */
export class MeetingFailed extends Schema.TaggedError<MeetingFailed>()("organization/MeetingFailed", {
  status: Schema.String,
  message: Schema.String
}) {}

/** Ends a meetings run after its receipt: `not planned`, `refused`, and `blocked` fail with {@link MeetingFailed}. */
export const SettleMeeting = Action.make("organization/settle-meeting", {
  implementationVersion: "settle-meeting/v1",
  payload: { report: MeetingReport, receipt: Schema.String },
  success: MeetingReport,
  error: MeetingFailed
})

/** The calendar a host writes meetings to, when one is connected. */
export interface Calendar {
  readonly calendarId: string
  readonly client: CalendarClient.CalendarClient
}

/**
 * The calendar the environment connects: `SMITHERS_ORG_CALENDAR_ID` and a
 * Google token (`SMITHERS_GOOGLE_ACCESS_TOKEN`, or a refresh token with its
 * client), or `undefined`.
 */
export const calendarOf = (environment: Readonly<Record<string, string | undefined>>): Calendar | undefined => {
  const calendarId = environment.SMITHERS_ORG_CALENDAR_ID?.trim() ?? ""
  const token = (environment.SMITHERS_GOOGLE_ACCESS_TOKEN ?? "") !== "" ||
    ((environment.SMITHERS_GOOGLE_REFRESH_TOKEN ?? "") !== "" && (environment.SMITHERS_GOOGLE_CLIENT_ID ?? "") !== "")
  if (calendarId === "" || !token) return undefined
  return { calendarId, client: CalendarClient.make({ allowedCalendars: [calendarId] }, environment) }
}

/** What the host decided at startup that the meetings use. */
export interface Options {
  readonly root: string
  readonly stateDir: string
  readonly generatedDir: string
  /** The meetings page, relative to the root; the series is unplanned without one. */
  readonly meetingsFile: string | undefined
  readonly assistant: string
  /** The owner's Slack user id, when the Slack app is configured. */
  readonly owner: string | undefined
  /** The Slack app's environment (its tokens); only read when `owner` is set. */
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly calendar: Calendar | undefined
  /** Renders an agenda's references as Slack links. */
  readonly links?: Links.Linker | undefined
}

/** The flows the schedule triggers start, and when, relative to a slot. */
export const phases = [
  { name: "prepare", flowId: "organization/meetings-prepare", offsetMinutes: -24 * 60, edge: "start" },
  { name: "open", flowId: "organization/meetings-open", offsetMinutes: 0, edge: "start" },
  { name: "follow-up", flowId: "organization/meetings-follow-up", offsetMinutes: 5, edge: "end" }
] as const

/** A trigger id of this host's meetings: `organization-meetings:<role>:<phase>`. */
export const triggerId = (principal: string, phase: string) => `organization-meetings:${principal}:${phase}`

/**
 * The cron expression, in the series' zone, of a slot's phase: its wall time
 * on its weekday (the day before for a negative day offset). The scheduler
 * keeps wall time across daylight saving.
 */
export const cronOf = (weekday: number, local: string, offsetMinutes: number): string => {
  const total = Number(local.slice(0, 2)) * 60 + Number(local.slice(3, 5)) + offsetMinutes
  const days = Math.floor(total / 1440)
  const within = total - days * 1440
  const iso = ((weekday - 1 + days) % 7 + 7) % 7 + 1
  return `${within % 60} ${Math.floor(within / 60)} * * ${iso % 7}`
}

const emptyPlan = (reason: string): Plan => ({
  configured: false,
  reason,
  seriesId: "",
  timezone: "",
  weekday: 0,
  slotMinutes: 0,
  firstDate: "",
  blockStart: "",
  blockEnd: "",
  slots: []
})

const meetingsDir = (options: Pick<Options, "generatedDir">) => `${options.generatedDir.replace(/\/+$/, "")}/meetings`

/** The key of a role's occurrence: `meetings-<role>-<date>`. */
export const occurrenceKey = (principal: string, localDate: string) => `meetings-${principal}-${localDate}`

/** The markdown sections of a note, by heading. */
export const sections = (text: string): Map<string, string> => {
  const found = new Map<string, string>()
  const parts = text.split(/^## /m)
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n")
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim()
    found.set(heading, newline === -1 ? "" : part.slice(newline + 1).trim())
  }
  return found
}

/** A note with `heading`'s section replaced (or added), every other section kept as it was. */
export const withSection = (text: string, heading: string, body: string): string => {
  const [title = "", ...rest] = text.split(/^## /m)
  const kept = rest.map((part) => `## ${part.trimEnd()}`).filter((part) =>
    !part.startsWith(`## ${heading}\n`) && part !== `## ${heading}`
  )
  const order = ["Agenda", "Notes", "Tasks"]
  const all = [...kept, `## ${heading}\n\n${body.trim()}`]
  all.sort((left, right) => {
    const rank = (part: string) => {
      const name = part.slice(3).split("\n", 1)[0]!.trim()
      const index = order.indexOf(name)
      return index === -1 ? order.length : index
    }
    return rank(left) - rank(right)
  })
  return `${title.trimEnd()}\n\n${all.join("\n\n")}\n`
}

/** The placeholder a new note's Notes section holds; notes that are only this were not taken. */
export const notesPlaceholder = "Write notes here, or reply in the meeting's Slack thread."

const bulleted = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).map((item) => item.trim()).filter((
      item
    ) => item !== "")
    : typeof value === "string"
    ? value.split("\n").map((item) => item.replace(/^\s*[-*]\s*/, "").trim()).filter((item) => item !== "")
    : []

const tasksOf = (value: unknown, principal: string): ReadonlyArray<Task> =>
  (Array.isArray(value) ? value : bulleted(value)).flatMap((item): ReadonlyArray<Task> => {
    if (typeof item === "string") return item.trim() === "" ? [] : [{ title: item.trim(), owner: principal }]
    if (typeof item !== "object" || item === null) return []
    const record = item as Record<string, unknown>
    const title = typeof record["title"] === "string" ? record["title"].trim() : ""
    if (title === "") return []
    return [{
      title,
      owner: typeof record["owner"] === "string" && record["owner"].trim() !== "" ? record["owner"].trim() : principal,
      ...(typeof record["due"] === "string" && record["due"].trim() !== "" ? { due: record["due"].trim() } : {})
    }]
  })

/** A task list line: `- [ ] title (owner, due)`. */
export const taskLine = (task: Task) =>
  `- [ ] ${task.title} (${task.owner}${task.due === undefined ? "" : `, due ${task.due}`})`

interface Threads {
  readonly threads: Record<string, { readonly principal: string; readonly key: string; readonly notePath: string }>
}

const threadsFile = (stateDir: string) => join(stateDir, "meetings.json")

/** The meeting a Slack thread belongs to, from the host's state directory, or `undefined`. */
export const meetingThread = (
  stateDir: string,
  channel: string,
  thread: string
): { readonly principal: string; readonly key: string; readonly notePath: string } | undefined => {
  const file = threadsFile(stateDir)
  if (!existsSync(file)) return undefined
  const state = JSON.parse(readFileSync(file, "utf8")) as Threads
  return state.threads[`${channel}/${thread}`]
}

const recordThread = (stateDir: string, channel: string, thread: string, entry: Threads["threads"][string]) => {
  const file = threadsFile(stateDir)
  const state: Threads = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Threads : { threads: {} }
  const next: Threads = { threads: { ...state.threads, [`${channel}/${thread}`]: entry } }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

const threadOf = (stateDir: string, key: string): { readonly channel: string; readonly thread: string } | undefined => {
  const file = threadsFile(stateDir)
  if (!existsSync(file)) return undefined
  const state = JSON.parse(readFileSync(file, "utf8")) as Threads
  for (const [id, entry] of Object.entries(state.threads)) {
    if (entry.key !== key) continue
    const slash = id.indexOf("/")
    return { channel: id.slice(0, slash), thread: id.slice(slash + 1) }
  }
  return undefined
}

/** The receipts under the generated directory that name `principal`, newest first. */
export const receiptsOf = (root: string, generatedDir: string, principal: string, sinceMs: number) => {
  const directory = join(root, generatedDir)
  if (!existsSync(directory)) return []
  const found: Array<
    {
      readonly key: string
      readonly kind: string
      readonly status: string
      readonly summary: string
      readonly at: number
    }
  > = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "meetings") continue
    for (const kind of ["deliver", "hire", "delegate", "retire", "qualify"]) {
      const file = join(directory, entry.name, `${kind}.json`)
      if (!existsSync(file)) continue
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
          readonly admission?: { readonly at?: number }
          readonly request?: { readonly parent?: string; readonly specialist?: string }
          readonly report?: {
            readonly status?: string
            readonly summary?: string
            readonly principal?: string
            readonly principals?: Record<string, string>
          }
          readonly principal?: string
        }
        const report = parsed.report ?? {}
        const involved = [
          ...Object.values(report.principals ?? {}),
          report.principal,
          parsed.principal,
          parsed.request?.parent,
          parsed.request?.specialist
        ]
        if (!involved.includes(principal)) continue
        const at = parsed.admission?.at ?? statSync(file).mtimeMs
        if (at < sinceMs) continue
        found.push({ key: entry.name, kind, status: report.status ?? "unknown", summary: report.summary ?? "", at })
      } catch {
        continue
      }
    }
  }
  return found.sort((left, right) => right.at - left.at)
}

const flat = (text: string, max = 1_900) => {
  const one = text.replaceAll(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

const localClock = (timezone: string, epochMs: number) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(epochMs))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` }
}

/** The owner's working window extra time is booked in. */
export const bookingWindow = { weekdays: [1, 2, 3, 4, 5], startLocal: "09:00", endLocal: "17:00" } as const

interface BookingEntry {
  readonly key: string
  readonly requestedBy: string
  readonly purpose: string
  readonly startMs: number
  readonly endMs: number
  readonly localDate: string
  readonly startLocal: string
  readonly calendar: string
}

/** Every meetings step, over the trusted registry and the host's options. */
export const layer = (options: Options) => {
  const services = NodeServices.layer
  const write = (relative: string, content: string) =>
    Confined.writeText({ root: options.root, relative, content }).pipe(
      Effect.mapError((refusal) => new Error(`${relative} ${refusal.message}`)),
      Effect.orDie,
      Effect.provide(services)
    )
  const read = (relative: string) => {
    const file = join(options.root, relative)
    return existsSync(file) ? readFileSync(file, "utf8") : undefined
  }
  const plan: Effect.Effect<Plan> = Effect.gen(function*() {
    if (options.meetingsFile === undefined) return emptyPlan("the organization names no meetings page")
    const text = read(options.meetingsFile)
    if (text === undefined) return emptyPlan(`${options.meetingsFile} does not exist`)
    const parsed = yield* Effect.result(Config.parseMeetings(options.meetingsFile, text))
    if (Result.isFailure(parsed)) return emptyPlan(`${options.meetingsFile}: ${parsed.failure.message}`)
    const request = Config.weeklyRequest(parsed.success)
    if (request === undefined) {
      const missing = (["timezone", "start", "firstDate"] as const).filter((name) => parsed.success[name] === null)
      return emptyPlan(`${options.meetingsFile} leaves ${missing.join(", ")} unset`)
    }
    const planned = Meetings.planWeekly(request)
    if (Result.isFailure(planned)) return emptyPlan(`${options.meetingsFile}: ${planned.failure.message}`)
    const weekly = planned.success
    return {
      configured: true,
      reason: "",
      seriesId: weekly.seriesId,
      timezone: weekly.timezone,
      weekday: weekly.weekday,
      slotMinutes: weekly.slotMinutes,
      firstDate: weekly.firstDate,
      blockStart: weekly.blockStart,
      blockEnd: weekly.blockEnd,
      slots: weekly.slots.map((slot) => ({
        principal: slot.principal,
        startLocal: slot.startLocal,
        endLocal: slot.endLocal,
        eventKey: slot.eventKey,
        rrule: slot.rrule,
        dtstartLocal: slot.dtstartLocal
      }))
    }
  })
  const weeklyOf = (current: Plan): Meetings.WeeklyPlan => ({
    ...current,
    slots: current.slots.map((slot) => ({ ...slot, timezone: current.timezone }))
  })
  const occurrencesIn = (current: Plan, fromMs: number, toMs: number) =>
    Result.getOrElse(Meetings.occurrences(weeklyOf(current), fromMs, toMs), () => [])
  const personaOf = (principal: string) =>
    Effect.gen(function*() {
      const registry = yield* Authority.RosterRegistry
      const snapshot = yield* registry.current
      return { username: (snapshot.roster.profiles.get(principal)?.name ?? principal).slice(0, 80) }
    })
  const slack = options.owner === undefined ? undefined : SlackClient.make({}, options.environment)
  // Contact with the owner is checked against a receipt this host mints for
  // the one occasion it read: a scheduled slot, or a thread the owner wrote in.
  const issuer = Grants.makeReceiptIssuer("organization/meetings")
  const contactOwner = (
    principal: string,
    occasion: Omit<Grants.ContactReceipt, "issuedBy" | "principal">,
    nowMs: number
  ) =>
    Effect.gen(function*() {
      const snapshot = yield* (yield* Authority.RosterRegistry).current
      const profile = snapshot.roster.profiles.get(principal)
      if (profile === undefined) {
        return Result.fail(
          new Grants.Denied({ reason: "unknown-principal", message: `${principal} is not on the roster` })
        )
      }
      return Result.flatMap(
        issuer.issue({ ...occasion, principal }),
        (receipt) => Grants.canContactOwner(profile, receipt, { destination: occasion.destination, nowMs })
      )
    })
  const noteOf = (occurrence: Occurrence) => read(occurrence.notePath)
  const booked = (): ReadonlyArray<BookingEntry> => {
    const text = read(`${meetingsDir(options)}/bookings.json`)
    return text === undefined ? [] : (JSON.parse(text) as { readonly bookings: ReadonlyArray<BookingEntry> }).bookings
  }
  return Layer.mergeAll(
    SettleMeeting.toLayer(({ receipt, report }) => {
      const settled = { ...report, receipt }
      return settled.status === "not planned" || settled.status === "refused" || settled.status === "blocked"
        ? Effect.fail(new MeetingFailed({ status: settled.status, message: `${settled.status}: ${settled.summary}` }))
        : Effect.succeed(settled)
    }, { implementationVersion: "settle-meeting/v1" }),
    LoadPlan.toLayer(() => plan, { implementationVersion: "meetings-load/v1" }),
    SyncCalendar.toLayer(({ plan: current }) =>
      Effect.gen(function*() {
        if (!current.configured) return { status: "not planned" as const, reason: current.reason, events: [] }
        const calendar = options.calendar
        if (calendar === undefined) {
          return { status: "not connected" as const, reason: "no calendar is connected", events: [] }
        }
        const first = occurrencesIn(
          current,
          Date.parse(`${current.firstDate}T00:00:00Z`) - day,
          Date.parse(`${current.firstDate}T00:00:00Z`) + 2 * day
        )
        const events: Array<CalendarReport["events"][number]> = []
        for (const slot of current.slots) {
          const occurrence = first.find((each) => each.principal === slot.principal)
          if (occurrence === undefined) continue
          const eventId = eventIdOf(`${current.seriesId}/${slot.principal}`)
          const input = {
            summary: `1:1 · ${slot.principal}`,
            description: `Weekly one-on-one (${current.seriesId}). Private Slack conversation with the role.`,
            start: { dateTime: new Date(occurrence.startMs).toISOString(), timeZone: current.timezone },
            end: { dateTime: new Date(occurrence.endMs).toISOString(), timeZone: current.timezone },
            recurrence: [`RRULE:${slot.rrule}`],
            visibility: "private" as const
          }
          const upserted = yield* calendar.client.insertEvent(calendar.calendarId, input, {
            id: eventId,
            sendUpdates: "none"
          }).pipe(
            Effect.map((event) => ({ event, created: true })),
            Effect.catchIf(
              (error) => error.details?.["status"] === 409,
              () =>
                Effect.map(
                  calendar.client.getEvent(calendar.calendarId, eventId),
                  (event) => ({ event, created: false })
                )
            ),
            Effect.result
          )
          if (Result.isFailure(upserted)) {
            return { status: "failed" as const, reason: upserted.failure.message, events }
          }
          events.push({
            principal: slot.principal,
            eventId,
            created: upserted.success.created,
            url: upserted.success.event.htmlLink ?? null
          })
        }
        return { status: "connected" as const, reason: "", events }
      }), { implementationVersion: "meetings-calendar/v1" }),
    Schedule.toLayer(({ plan: current }) =>
      Effect.gen(function*() {
        if (!current.configured) return { status: "not planned" as const, triggers: [], disabled: [] }
        const store = yield* TriggerStore.TriggerStore
        const triggers: Array<ScheduleReport["triggers"][number]> = []
        for (const slot of current.slots) {
          for (const phase of phases) {
            const local = phase.edge === "start" ? slot.startLocal : slot.endLocal
            const declaration = yield* Trigger.make({
              id: triggerId(slot.principal, phase.name),
              flowId: phase.flowId,
              input: { principal: slot.principal },
              cron: cronOf(current.weekday, local, phase.offsetMinutes),
              timezone: current.timezone,
              overlap: "skip",
              catchUp: "one",
              maxCatchUp: 1,
              enabled: true
            }).pipe(Effect.orDie)
            yield* store.register(declaration).pipe(Effect.orDie)
            triggers.push({
              id: declaration.id,
              flowId: declaration.flowId,
              cron: declaration.cron,
              timezone: current.timezone
            })
          }
        }
        const wanted = new Set(triggers.map((each) => each.id))
        const disabled: Array<string> = []
        for (const listed of yield* store.list().pipe(Effect.orDie)) {
          if (!listed.triggerId.startsWith("organization-meetings:") || wanted.has(listed.triggerId)) continue
          if (Result.isFailure(listed.trigger) || !listed.trigger.success.enabled) continue
          const { lastFiredAt: _last, revision: _revision, ...declaration } = listed.trigger.success
          yield* store.register({ ...declaration, enabled: false }).pipe(Effect.orDie)
          disabled.push(listed.triggerId)
        }
        return { status: "scheduled" as const, triggers, disabled }
      }), { implementationVersion: "meetings-schedule/v1" }),
    WritePlan.toLayer(({ calendar, plan: current, schedule }) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const path = `${meetingsDir(options)}/plan.md`
        const upcoming = current.configured ? occurrencesIn(current, now, now + 7 * day) : []
        const content = current.configured
          ? [
            "# Weekly one-on-ones",
            "",
            `${current.seriesId} · every ${
              ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][current.weekday]
            } ${current.blockStart}–${current.blockEnd} ${current.timezone} · from ${current.firstDate}`,
            "",
            "| Role | Slot | Next | Calendar |",
            "| --- | --- | --- | --- |",
            ...current.slots.map((slot) => {
              const next = upcoming.find((each) => each.principal === slot.principal)
              const event = calendar.events.find((each) => each.principal === slot.principal)
              return `| ${slot.principal} | ${slot.startLocal}–${slot.endLocal} | ${next?.localDate ?? ""} | ${
                event === undefined ? calendar.status : event.url ?? event.eventId
              } |`
            }),
            "",
            `Calendar: ${calendar.status}${
              calendar.reason === "" ? "" : ` (${calendar.reason})`
            }. Schedule: ${schedule.status}, ${schedule.triggers.length} triggers.`,
            ""
          ].join("\n")
          : ["# Weekly one-on-ones", "", `Not planned: ${current.reason}.`, ""].join("\n")
        yield* write(path, content)
        return { path }
      }), { implementationVersion: "meetings-write-plan/v1" }),
    FindOccurrence.toLayer(({ at, principal, which }) =>
      Effect.gen(function*() {
        const now = at ?? (yield* Clock.currentTimeMillis)
        const current = yield* plan
        const none = (reason: string): Occurrence => ({
          found: false,
          reason,
          principal,
          key: occurrenceKey(principal, "none"),
          localDate: "",
          startLocal: "",
          timezone: current.timezone,
          startMs: 0,
          endMs: 0,
          notePath: ""
        })
        if (!current.configured) return none(current.reason)
        const window = which === "next"
          ? [now, now + 8 * day]
          : which === "current"
          ? [now - day, now + day]
          : [now - 8 * day, now + minute]
        const found = occurrencesIn(current, window[0]!, window[1]!).filter((each) => each.principal === principal)
        const chosen = which === "next"
          ? found.find((each) => each.startMs >= now)
          : which === "current"
          ? found.find((each) => each.startMs - 15 * minute <= now && now < each.endMs)
          : found.filter((each) => each.endMs <= now + minute).at(-1)
        if (chosen === undefined) return none(`${principal} has no ${which} slot around ${new Date(now).toISOString()}`)
        return {
          found: true,
          reason: "",
          principal,
          key: occurrenceKey(principal, chosen.localDate),
          localDate: chosen.localDate,
          startLocal: chosen.startLocal,
          timezone: current.timezone,
          startMs: chosen.startMs,
          endMs: chosen.endMs,
          notePath: `${meetingsDir(options)}/${principal}/${chosen.localDate}.md`
        }
      }), { implementationVersion: "meetings-occurrence/v1" }),
    PrepareTask.toLayer(({ occurrence, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const { profile } = yield* registry.resolve(revision, occurrence.principal)
        const at = yield* Clock.currentTimeMillis
        const since = occurrence.startMs - 7 * day
        const receipts = receiptsOf(options.root, options.generatedDir, profile.id, since)
        const blockers = receipts.filter((each) =>
          ["blocked", "failed", "changes-requested", "refused", "revise"].includes(each.status)
        )
        const open = read(`${meetingsDir(options)}/${profile.id}/tasks.md`) ?? ""
        const context = [
          `Receipts since ${new Date(since).toISOString().slice(0, 10)}:`,
          ...(receipts.length === 0
            ? ["none"]
            : receipts.slice(0, 25).map((each) =>
              `- ${each.kind} ${each.key}: ${each.status} — ${flat(each.summary, 300)}`
            )),
          "",
          "Blockers:",
          ...(blockers.length === 0
            ? ["none"]
            : blockers.slice(0, 10).map((each) => `- ${each.key}: ${flat(each.summary, 300)}`)),
          "",
          "Open tasks from earlier one-on-ones:",
          open.trim() === "" ? "none" : open.trim()
        ].join("\n")
        return {
          proceed: true,
          outcome: "blocked" as const,
          reason: "",
          principal: profile.id,
          task: {
            id: `${occurrence.key}/prepare`,
            objective:
              `Prepare your weekly one-on-one with the owner on ${occurrence.localDate} at ${occurrence.startLocal} (${occurrence.timezone}): progress against your objective, evidence, next priorities, blockers, and decisions you need.`,
            inputs: ["Your receipts, blockers, and open tasks, in the context below."],
            acceptance: [
              "Return done with the field `agenda`: a list of short lines, each one item to discuss, citing the receipt it rests on.",
              "Name each decision you need from the owner as its own item, with the options.",
              "Nothing that is not in the context or your memory."
            ],
            evidence: ["The receipts each item rests on."],
            requestedBy: options.assistant
          },
          context: [{
            source: { provider: "organization", id: `meetings/${occurrence.key}` },
            provenance: { retrievedAtMs: at },
            text: context
          }]
        }
      }), { implementationVersion: "meetings-prepare-task/v1" }),
    WriteAgenda.toLayer(({ answer, occurrence }) =>
      Effect.gen(function*() {
        const agenda = answer.valid && answer.result.status === "done"
          ? bulleted(answer.result.fields["agenda"])
          : [`${answer.principal} could not prepare: ${flat(answer.result.summary, 400)}`]
        const existing = noteOf(occurrence) ??
          [
            `# 1:1 · ${occurrence.principal} · ${occurrence.localDate} ${occurrence.startLocal} ${occurrence.timezone}`,
            "",
            "## Notes",
            "",
            notesPlaceholder,
            ""
          ].join("\n")
        yield* write(occurrence.notePath, withSection(existing, "Agenda", agenda.map((item) => `- ${item}`).join("\n")))
        return { path: occurrence.notePath, agenda }
      }), { implementationVersion: "meetings-write-agenda/v1" }),
    OpenDirect.toLayer(({ at, occurrence, principal }) =>
      Effect.gen(function*() {
        if (slack === undefined || options.owner === undefined) {
          return { connected: false, channel: "", reason: "Slack is not connected" }
        }
        const opened = yield* Effect.result(slack.call("conversations.open", { users: options.owner }))
        if (Result.isFailure(opened)) return { connected: false, channel: "", reason: opened.failure.message }
        const channel = (opened.success["channel"] as { readonly id?: unknown } | undefined)?.id
        if (typeof channel !== "string") {
          return { connected: false, channel: "", reason: "Slack opened no direct-message channel" }
        }
        // The owner's direct messages are reached only inside the slot.
        const contact = yield* contactOwner(principal, {
          kind: "one-on-one",
          destination: `slack:${channel}`,
          // `FindOccurrence` opens a slot up to 15 minutes early.
          windowStartMs: occurrence.startMs - 15 * minute,
          windowEndMs: occurrence.endMs
        }, at ?? (yield* Clock.currentTimeMillis))
        return Result.isFailure(contact)
          ? { connected: false, channel: "", reason: contact.failure.message }
          : { connected: true, channel, reason: "" }
      }), { implementationVersion: "meetings-open-direct/v2" }),
    ReadAgenda.toLayer(({ occurrence }) =>
      Effect.gen(function*() {
        const note = noteOf(occurrence)
        const agenda = note === undefined ? "" : sections(note).get("Agenda") ?? ""
        const heading = `1:1 · ${occurrence.localDate} ${occurrence.startLocal} ${occurrence.timezone}`
        return {
          text: (options.links ?? Links.none).slack(
            `${heading}\n${agenda.trim() === "" ? "No agenda was prepared." : agenda.trim()}`.slice(0, 3_000)
          ),
          persona: yield* personaOf(occurrence.principal)
        }
      }), { implementationVersion: "meetings-read-agenda/v2" }),
    RecordThread.toLayer(({ channel, occurrence, thread }) =>
      Effect.sync(() => {
        recordThread(options.stateDir, channel, thread, {
          principal: occurrence.principal,
          key: occurrence.key,
          notePath: occurrence.notePath
        })
        return { recorded: true }
      }), { implementationVersion: "meetings-record-thread/v1" }),
    CollectNotes.toLayer(({ occurrence }) =>
      Effect.gen(function*() {
        const lines: Array<string> = []
        const sources: Array<string> = []
        const note = noteOf(occurrence)
        const written = note === undefined
          ? ""
          : (sections(note).get("Notes") ?? "").replace(notesPlaceholder, "").trim()
        if (written !== "") {
          sources.push(`wiki:${occurrence.notePath}`)
          lines.push(...written.split("\n").map((line) => `Will (note): ${line}`))
        }
        const thread = threadOf(options.stateDir, occurrence.key)
        if (slack !== undefined && thread !== undefined) {
          const replies = yield* Effect.result(
            slack.call("conversations.replies", { channel: thread.channel, ts: thread.thread, limit: 200 })
          )
          if (Result.isSuccess(replies)) {
            const messages = (replies.success["messages"] as ReadonlyArray<Record<string, unknown>> | undefined) ?? []
            const said = messages.slice(1).flatMap((message) => {
              const text = typeof message["text"] === "string" ? message["text"].trim() : ""
              if (text === "") return []
              const who = message["user"] === options.owner ? "Will" : occurrence.principal
              return [`${who}: ${text}`]
            })
            if (said.length > 0) {
              sources.push(`slack:${thread.channel}/${thread.thread}`)
              lines.push(...said)
            }
          }
        }
        const held = lines.some((line) => line.startsWith("Will"))
        return { held, sources, transcript: lines.join("\n").slice(0, 20_000) }
      }), { implementationVersion: "meetings-collect/v1" }),
    FollowUpTask.toLayer(({ occurrence, revision, transcript }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const { profile } = yield* registry.resolve(revision, occurrence.principal)
        const at = yield* Clock.currentTimeMillis
        const agenda = sections(noteOf(occurrence) ?? "").get("Agenda") ?? ""
        return {
          proceed: true,
          outcome: "blocked" as const,
          reason: "",
          principal: profile.id,
          task: {
            id: `${occurrence.key}/follow-up`,
            objective: `Turn your one-on-one with the owner on ${occurrence.localDate} into tasks.`,
            inputs: ["The agenda and what was said, in the context below."],
            acceptance: [
              "Return done with the field `tasks`: a list of `{ title, owner, due }`, one per decision or commitment made; `owner` is a role id, or `personal-assistant` for anything the owner must do.",
              "Only what was decided or committed to; nothing new."
            ],
            evidence: ["The line of the notes each task comes from."],
            requestedBy: options.assistant
          },
          context: [
            {
              source: { provider: "organization", id: `meetings/${occurrence.key}/agenda` },
              provenance: { retrievedAtMs: at },
              text: agenda === "" ? "No agenda." : agenda
            },
            {
              source: { provider: "organization", id: `meetings/${occurrence.key}/notes` },
              provenance: { retrievedAtMs: at },
              text: transcript
            }
          ]
        }
      }), { implementationVersion: "meetings-follow-up-task/v1" }),
    WriteTasks.toLayer(({ answer, held, occurrence }) =>
      Effect.gen(function*() {
        const tasks = held && answer.valid && answer.result.status === "done"
          ? tasksOf(answer.result.fields["tasks"], occurrence.principal)
          : []
        const existing = noteOf(occurrence) ??
          `# 1:1 · ${occurrence.principal} · ${occurrence.localDate} ${occurrence.startLocal} ${occurrence.timezone}\n`
        const body = !held
          ? "Not held: no notes were taken in the wiki or the Slack thread."
          : answer.valid && answer.result.status === "done"
          ? (tasks.length === 0 ? "No tasks." : tasks.map(taskLine).join("\n"))
          : `${answer.principal} could not follow up: ${flat(answer.result.summary, 400)}`
        yield* write(occurrence.notePath, withSection(existing, "Tasks", body))
        if (tasks.length > 0) {
          const listPath = `${meetingsDir(options)}/${occurrence.principal}/tasks.md`
          const list = read(listPath) ?? `# Open tasks · ${occurrence.principal}\n\n`
          const fresh = tasks.map(taskLine).filter((entry) => !list.includes(entry))
          if (fresh.length > 0) {
            yield* write(
              listPath,
              `${list.trimEnd()}\n${fresh.map((entry) => `${entry} · ${occurrence.localDate}`).join("\n")}\n`
            )
          }
        }
        return { path: occurrence.notePath, tasks }
      }), { implementationVersion: "meetings-write-tasks/v1" }),
    ReplyTask.toLayer((payload) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const { profile } = yield* registry.resolve(payload.revision, payload.principal)
        const at = yield* Clock.currentTimeMillis
        // The owner wrote in this thread, which the host recorded for this role.
        const contact = yield* contactOwner(profile.id, {
          kind: "owner-thread",
          destination: `slack:${payload.channel}/${payload.thread}`,
          windowStartMs: at,
          windowEndMs: at + 60_000
        }, at)
        if (Result.isFailure(contact)) {
          return yield* new Authority.DispatchRefused({ reason: "inactive", message: contact.failure.message })
        }
        let transcript = `Will: ${payload.text}`
        if (slack !== undefined) {
          const replies = yield* Effect.result(
            slack.call("conversations.replies", { channel: payload.channel, ts: payload.thread, limit: 200 })
          )
          if (Result.isSuccess(replies)) {
            const messages = (replies.success["messages"] as ReadonlyArray<Record<string, unknown>> | undefined) ?? []
            const said = messages.flatMap((message) => {
              const text = typeof message["text"] === "string" ? message["text"].trim() : ""
              return text === "" ? [] : [`${message["user"] === options.owner ? "Will" : profile.id}: ${text}`]
            })
            if (said.length > 0) transcript = said.join("\n")
          }
        }
        return {
          persona: { username: profile.name.slice(0, 80) },
          stage: {
            proceed: true,
            outcome: "blocked" as const,
            reason: "",
            principal: profile.id,
            task: {
              id: `${payload.key.slice(0, 100)}/reply`,
              objective: "Answer the owner's last message in your weekly one-on-one.",
              inputs: ["The conversation so far, in the context below; the last line is the message to answer."],
              acceptance: [
                "Return done with the field `reply`: your answer, short and direct, as you would say it in the conversation.",
                "Say only what your receipts and memory support."
              ],
              evidence: ["What the answer rests on."],
              requestedBy: "owner" as const,
              conversation: { provider: "slack", container: payload.channel, thread: payload.thread }
            },
            context: [{
              source: { provider: "slack", id: `${payload.channel}/${payload.thread}` },
              provenance: { retrievedAtMs: at },
              text: transcript.slice(-20_000)
            }]
          }
        }
      }), { implementationVersion: "meetings-reply-task/v1" }),
    BookTime.toLayer((payload) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const snapshot = yield* registry.current
        // The requester must be active now; the assistant books.
        yield* registry.resolve(snapshot.revision, payload.requestedBy)
        const current = yield* plan
        const path = `${meetingsDir(options)}/bookings.md`
        const earlier = booked()
        const existing = earlier.find((entry) => entry.key === payload.key)
        const base = {
          key: payload.key,
          requestedBy: payload.requestedBy,
          purpose: payload.purpose,
          timezone: current.timezone,
          bookedBy: options.assistant,
          path
        }
        if (existing !== undefined) return { ...base, ...existing, booked: true, reason: "already booked" }
        const refuse = (reason: string): Booking => ({
          ...base,
          booked: false,
          reason,
          startMs: 0,
          endMs: 0,
          localDate: "",
          startLocal: "",
          calendar: options.calendar === undefined ? "not connected" : "connected"
        })
        if (!current.configured) return refuse(`no time zone to book in: ${current.reason}`)
        const now = yield* Clock.currentTimeMillis
        const after = Math.max(now, payload.notBefore ?? 0)
        const busy: Array<Meetings.Interval> = [
          ...occurrencesIn(current, after - day, after + 15 * day),
          ...earlier.map((entry) => ({ startMs: entry.startMs, endMs: entry.endMs }))
        ]
        let calendarStatus = "not connected"
        if (options.calendar !== undefined) {
          const freeBusy = yield* Effect.result(options.calendar.client.freeBusy({
            timeMin: new Date(after).toISOString(),
            timeMax: new Date(after + 14 * day).toISOString(),
            calendarIds: [options.calendar.calendarId]
          }))
          if (Result.isFailure(freeBusy)) {
            return refuse(`the calendar's busy times could not be read: ${freeBusy.failure.message}`)
          }
          calendarStatus = "connected"
          for (const calendar of freeBusy.success.calendars) busy.push(...calendar.busy)
        }
        const found = Meetings.findSlot({
          busy,
          durationMinutes: payload.minutes,
          timezone: current.timezone,
          window: bookingWindow,
          afterMs: after,
          horizonDays: 14,
          granularityMinutes: 15
        })
        if (Result.isFailure(found)) return refuse(found.failure.message)
        if (Option.isNone(found.success)) return refuse("no free slot in the next two weeks")
        const slot = found.success.value
        if (options.calendar !== undefined) {
          const eventId = eventIdOf(`organization-booking/${payload.key}`)
          const inserted = yield* Effect.result(
            options.calendar.client.insertEvent(options.calendar.calendarId, {
              summary: `${payload.requestedBy}: ${flat(payload.purpose, 120)}`,
              description: `Booked by ${options.assistant} for ${payload.requestedBy}. ${payload.purpose}`,
              start: { dateTime: new Date(slot.startMs).toISOString(), timeZone: current.timezone },
              end: { dateTime: new Date(slot.endMs).toISOString(), timeZone: current.timezone },
              visibility: "private"
            }, { id: eventId, sendUpdates: "none" }).pipe(
              Effect.catchIf(
                (error) => error.details?.["status"] === 409,
                () => options.calendar!.client.getEvent(options.calendar!.calendarId, eventId)
              )
            )
          )
          if (Result.isFailure(inserted)) {
            return refuse(`the calendar event could not be written: ${inserted.failure.message}`)
          }
        }
        const entry: BookingEntry = {
          key: payload.key,
          requestedBy: payload.requestedBy,
          purpose: payload.purpose,
          startMs: slot.startMs,
          endMs: slot.endMs,
          localDate: slot.localDate,
          startLocal: slot.startLocal,
          calendar: calendarStatus
        }
        const all = [...earlier, entry].sort((left, right) => left.startMs - right.startMs)
        yield* write(`${meetingsDir(options)}/bookings.json`, `${JSON.stringify({ bookings: all }, null, 2)}\n`)
        yield* write(
          path,
          [
            "# Extra time",
            "",
            "| When | Minutes | For | Purpose | Calendar |",
            "| --- | --- | --- | --- | --- |",
            ...all.map((each) => {
              const local = localClock(current.timezone, each.startMs)
              return `| ${local.date} ${local.time} | ${
                Math.round((each.endMs - each.startMs) / minute)
              } | ${each.requestedBy} | ${flat(each.purpose, 200).replaceAll("|", "\\|")} | ${each.calendar} |`
            }),
            ""
          ].join("\n")
        )
        return { ...base, ...entry, booked: true, reason: "" }
      }), { implementationVersion: "meetings-book/v1" })
  )
}
