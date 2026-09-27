/**
 * Deterministic scoring of one turn.
 *
 * Every rule is a `Checks` check from `@smthrs/scorers`, so a failure names
 * what was found. Three kinds of text are told apart:
 *
 * - **Will-facing**: the reply when Will wrote, every `owner_message`, and
 *   every `digest_add` item. The suite's voice rules apply: forbidden
 *   openers ("On it."), phrases, jargon, truncation, bare file paths, and
 *   unlinked references.
 * - **Agent-visible**: handoff briefs, questions to other roles, team posts,
 *   notes to requesters, shared wiki pages, and the reply when another role
 *   wrote. The world's private markers must not appear in any of it.
 * - **Everything else** (calendar, email drafts) is checked only by the
 *   case's own expectations.
 *
 * @since 0.1.0
 */
import * as Checks from "../../../packages/smithers/agent/scorers/src/Checks.ts"
import type * as Subject from "./subject.ts"
import type * as Suite from "./suite.ts"
import type * as World from "./world.ts"

type Check = Checks.Check

const text = (value: unknown): string => (typeof value === "string" ? value : "")

/** Will-facing texts of a turn, labelled by where they went. */
export const ownerTexts = (trigger: Suite.Message, turn: Subject.Turn): Array<Checks.Emission> => [
  ...(trigger.from === "owner" && turn.reply !== undefined && turn.reply.trim() !== ""
    ? [{ sink: "reply", text: turn.reply }]
    : []),
  ...turn.actions.filter((action) => action.tool === "owner_message").map((action) => ({
    sink: "owner_message",
    text: text(action.input.text)
  })),
  ...turn.actions.filter((action) => action.tool === "digest_add").map((action) => ({
    sink: "digest_add",
    text: text(action.input.item)
  }))
]

/** Text other agents can read. */
export const agentTexts = (trigger: Suite.Message, turn: Subject.Turn): Array<Checks.Emission> => {
  const out: Array<Checks.Emission> = []
  if (trigger.from !== "owner" && turn.reply !== undefined) {
    out.push({ sink: `reply to ${trigger.from}`, text: turn.reply })
  }
  for (const action of turn.actions) {
    const input = action.input
    switch (action.tool) {
      case "handoff":
        out.push({ sink: `handoff to ${text(input.to)}`, text: `${text(input.brief)} ${text(input.deadline)}` })
        break
      case "ask":
        out.push({ sink: `question to ${text(input.to)}`, text: text(input.question) })
        break
      case "post":
      case "reply_thread":
        out.push({ sink: `post in ${text(input.channel)}`, text: text(input.text) })
        break
      case "request_resolve":
        out.push({ sink: `note on ${text(input.id)}`, text: text(input.note) })
        break
      case "request_owner":
        out.push({ sink: "request to Will", text: `${text(input.title)} ${text(input.need)} ${text(input.why)}` })
        break
      case "wiki_write":
        if (input.private !== true) out.push({ sink: `wiki ${text(input.page)}`, text: text(input.text) })
        break
    }
  }
  return out
}

const prefixed = (sink: string, check: Check): Check => ({ ...check, id: `${sink}: ${check.id}` })

const expectText = (sink: string, value: string, expect: Suite.TextExpect): Array<Check> => {
  const checks: Array<Check> = []
  if (expect.words !== undefined) checks.push(Checks.length(value, expect.words))
  if (expect.include !== undefined) checks.push(Checks.includes(value, expect.include))
  if (expect.exclude !== undefined) checks.push(Checks.excludes(value, expect.exclude))
  if (expect.links !== undefined) checks.push(Checks.requiredLinks(value, expect.links))
  if (expect.questions !== undefined) {
    const count = Checks.questions(value)
    const { max, min } = expect.questions
    const pass = (min === undefined || count >= min) && (max === undefined || count <= max)
    checks.push({ id: "questions", pass, detail: `${count} question(s)` })
  }
  return checks.map((check) => prefixed(sink, check))
}

const voiceChecks = (suite: Suite.Suite, emission: Checks.Emission, allow: ReadonlyArray<string>): Array<Check> => {
  const allowed = new Set(allow.map((term) => term.toLowerCase()))
  const keep = (terms: ReadonlyArray<string>) => terms.filter((term) => !allowed.has(term.toLowerCase()))
  // An allowed term is removed from the text too, so a regex entry that also matches it stays quiet.
  const scrubbed = allow.reduce(
    (text, term) => text.split(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")).join(" "),
    emission.text
  )
  return [
    Checks.opener(emission.text, suite.voice.openers),
    Checks.excludes(scrubbed, keep(suite.voice.forbid), "phrases"),
    Checks.excludes(scrubbed, keep(suite.voice.jargon), "jargon"),
    Checks.truncated(emission.text),
    // A file named as code (`src/sync/merge.ts`) is fine; a path standing in
    // for an answer is not. Digest lines are notes Will skims, not answers.
    ...(emission.sink === "digest_add" ? [] : [Checks.barePaths(emission.text.replace(/`[^`\n]*`/gu, " "))]),
    ...(suite.references.length === 0 ? [] : [Checks.linkedReferences(emission.text, suite.references)])
  ].map((check) => prefixed(emission.sink, check))
}

const minutes = (hhmm: string): number => {
  const [hours, mins] = hhmm.split(":").map(Number)
  return hours! * 60 + mins!
}

const local = (iso: string): { readonly day: string; readonly minute: number; readonly weekday: number } => {
  const day = iso.slice(0, 10)
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
  return { day, minute: minutes(iso.slice(11, 16)), weekday: weekday === 0 ? 7 : weekday }
}

/**
 * A booking is valid when it lasts exactly `minutes`, falls on a booking day
 * inside the booking hours, starts after "now", ends before `before` when
 * given, and overlaps no event already on the calendar (focus time and
 * recurring blocks included).
 */
export const bookingChecks = (
  suite: Suite.Suite,
  world: World.World,
  actions: ReadonlyArray<World.Action>,
  expect: NonNullable<Suite.Expect["booking"]>
): Array<Check> => {
  const creates = actions.filter((action) => action.tool === "calendar_create" || action.tool === "calendar_move")
  if (creates.length === 0) return [{ id: "booking", pass: false, detail: "nothing booked or moved" }]
  return creates.map((action) => {
    const moving = action.tool === "calendar_move" ? text(action.input.id) : undefined
    const start = text(action.input.start)
    const end = text(action.input.end)
    const a = local(start)
    const b = local(end)
    const problems: Array<string> = []
    if (Number.isNaN(a.minute) || Number.isNaN(b.minute)) problems.push(`unreadable times ${start}–${end}`)
    if (a.day !== b.day) problems.push("spans days")
    if (b.minute - a.minute !== expect.minutes) problems.push(`${b.minute - a.minute} min, want ${expect.minutes}`)
    if (!suite.booking.days.includes(a.weekday)) problems.push("not a booking day")
    if (a.minute < minutes(suite.booking.start) || b.minute > minutes(suite.booking.end)) {
      problems.push("outside booking hours")
    }
    if (start.slice(0, 16) <= world.data.now.slice(0, 16)) problems.push("in the past")
    if (expect.before !== undefined && end.slice(0, 16) > expect.before.slice(0, 16)) {
      problems.push(`after ${expect.before}`)
    }
    for (const event of world.data.calendar) {
      if (event.id === moving || event.start.slice(0, 10) !== a.day) continue
      const s = local(event.start).minute
      const e = local(event.end).minute
      if (a.minute < e && s < b.minute) problems.push(`overlaps ${event.id}`)
    }
    return {
      id: "booking",
      pass: problems.length === 0,
      detail: problems.length === 0 ? `${start}–${end}` : problems.join("; ")
    }
  })
}

const callLabel = (call: Suite.CallExpect): string =>
  `${call.tool}${call.where === undefined ? "" : ` ${JSON.stringify(call.where)}`}`

/** Checks one call expectation: the matching count, then what the matching inputs say. */
const callChecks = (actions: ReadonlyArray<World.Action>, call: Suite.CallExpect): Array<Check> => {
  const label = callLabel(call)
  const spec = {
    tool: call.tool,
    ...(call.where === undefined ? {} : { where: call.where }),
    ...(call.min === undefined ? {} : { min: call.min }),
    ...(call.max === undefined ? {} : { max: call.max })
  }
  const checks: Array<Check> = [{ ...Checks.count(actions, spec), id: `calls: ${label}` }]
  const matching = actions.filter((action) =>
    action.tool === call.tool &&
    Object.entries(call.where ?? {}).every(([key, value]) => {
      const actual = String(action.input[key] ?? "").toLowerCase()
      return Array.isArray(value)
        ? value.some((option) => String(option).toLowerCase() === actual)
        : String(value).toLowerCase() === actual
    })
  )
  const joined = matching.map((action) => JSON.stringify(action.input)).join("\n")
  if (matching.length > 0 && call.include !== undefined) {
    checks.push(prefixed(`calls: ${label}`, Checks.includes(joined, call.include)))
  }
  if (matching.length > 0 && call.exclude !== undefined) {
    checks.push(prefixed(`calls: ${label}`, Checks.excludes(joined, call.exclude)))
  }
  return checks
}

/** Scores one turn against its expectations and the suite's rules. */
export const score = (options: {
  readonly suite: Suite.Suite
  readonly world: World.World
  readonly trigger: Suite.Message
  readonly expect: Suite.Expect
  readonly turn: Subject.Turn
}): Array<Check> => {
  const { expect, suite, trigger, turn, world } = options
  if (turn.reply === undefined) {
    return [{ id: "run", pass: false, detail: turn.failure ?? "no reply" }]
  }
  const checks: Array<Check> = []
  const replyExpect = expect.reply ?? {}
  // When another role asked, a note on its request reaches it just like a reply does.
  const notes = (replyExpect.orNote ?? trigger.from !== "owner")
    ? turn.actions.filter((action) => action.tool === "request_resolve").map((action) => text(action.input.note))
    : []
  const reply = turn.reply.trim() !== "" ? turn.reply.trim() : notes.join("\n").trim()
  if (replyExpect.empty === true) {
    // Silence is about the reply itself; closing a request with a note is not a reply here.
    const posted = turn.reply.trim()
    checks.push({
      id: "reply: empty",
      pass: posted === "",
      detail: posted === "" ? "no reply" : `replied: ${posted.slice(0, 80)}`
    })
  } else if (
    replyExpect.empty === false || replyExpect.include !== undefined || replyExpect.links !== undefined ||
    (replyExpect.questions?.min ?? 0) > 0
  ) {
    checks.push({ id: "reply: present", pass: reply !== "", detail: reply === "" ? "no reply" : "replied" })
  }
  checks.push(...expectText("reply", reply, replyExpect))

  const owner = ownerTexts(trigger, turn)
  if (expect.voice !== false) {
    for (const emission of owner) checks.push(...voiceChecks(suite, emission, expect.allow ?? []))
  }
  if (trigger.from !== "owner" && reply !== "") {
    checks.push(
      prefixed("reply", Checks.opener(reply, suite.voice.openers)),
      prefixed("reply", Checks.truncated(reply))
    )
  }

  if (expect.owner !== undefined) {
    const messages = turn.actions.filter((action) => action.tool === "owner_message")
    const bound = expect.owner.count ?? { min: 1 }
    checks.push(Checks.count(turn.actions, { tool: "owner_message", id: "owner messages", ...bound }))
    for (const [index, message] of messages.entries()) {
      const body = text(message.input.text)
      checks.push(
        ...expectText(`owner message ${index + 1}`, body, { ...expect.owner, include: undefined, links: undefined })
      )
      if (expect.owner.urgent === true) {
        checks.push({
          id: `owner message ${index + 1}: urgent`,
          pass: message.input.urgent === true,
          detail: `urgent=${String(message.input.urgent)}`
        })
      }
    }
    if (messages.length > 0) {
      const joined = messages.map((message) => text(message.input.text)).join("\n")
      if (expect.owner.include !== undefined) {
        checks.push(prefixed("owner", Checks.includes(joined, expect.owner.include)))
      }
      if (expect.owner.links !== undefined) {
        checks.push(prefixed("owner", Checks.requiredLinks(joined, expect.owner.links)))
      }
    }
  }

  for (const entry of expect.calls ?? []) {
    if ("anyOf" in entry) {
      const groups = entry.anyOf.map((call) => callChecks(turn.actions, call))
      const passing = groups.find((group) => group.every((check) => check.pass))
      const label = entry.anyOf.map((call) => callLabel(call)).join(" | ")
      checks.push({
        id: `calls: any of ${label}`,
        pass: passing !== undefined,
        detail: passing !== undefined
          ? "one alternative holds"
          : groups.map((group) => group.filter((check) => !check.pass).map((check) => check.detail).join(", ")).join(
            " | "
          )
      })
    } else {
      checks.push(...callChecks(turn.actions, entry))
    }
  }

  if (expect.booking !== undefined) checks.push(...bookingChecks(suite, world, turn.actions, expect.booking))
  if (expect.leakage !== false) checks.push(Checks.leakage(agentTexts(trigger, turn), world.data.private.markers))
  return checks
}
