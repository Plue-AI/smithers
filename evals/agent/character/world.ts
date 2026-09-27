/**
 * The simulated workplace a character case runs in.
 *
 * A world is a directory: `world.yaml` (company, people, calendar, inbox, chat,
 * issues, requests, what each role answers when asked, web pages, private
 * notes, and the markers that must never leak), `wiki/*.md` pages with
 * frontmatter, and a small `repo/`. A case patches the world, then the agent
 * reaches it only through the flows {@link sources} binds: the same kind of
 * executable flows a production host binds, answering from the world instead
 * of a provider.
 *
 * Every call is recorded as an {@link Action} in call order. The scorers read
 * the actions, never the agent's code: a handoff is a `handoff` action, a
 * message to Will is an `owner_message` action, and so on. A role only gets
 * the tools its grant lists in `world.yaml` (`grants.<role>`, else
 * `grants.default`), so a scenario can never pass by calling a tool the real
 * role would not hold.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { parse as parseYaml } from "yaml"
import { FlowBinding } from "../../../packages/smithers/agent/harness/src/index.ts"
import { Flow as CoreFlow } from "../../../packages/smithers/flows/core/src/index.ts"

/** One recorded tool call. */
export interface Action {
  readonly tool: string
  readonly input: Record<string, unknown>
  /** What the tool answered. */
  output?: unknown
}

/** A world page: the wiki is read by slug. */
export interface Page {
  readonly slug: string
  readonly title: string
  readonly updated: string
  readonly owner: string
  readonly private: boolean
  readonly text: string
}

/** The loaded world: `data` is `world.yaml` after case patches. */
export interface World {
  readonly dir: string
  readonly data: WorldData
  readonly pages: Map<string, Page>
  readonly repo: ReadonlyArray<{ readonly path: string; readonly text: string }>
}

/** The parts of `world.yaml` the tools read. Everything else is carried through. */
export interface WorldData {
  readonly now: string
  readonly owner: { readonly name: string; readonly timezone: string; readonly [key: string]: unknown }
  readonly grants: Readonly<Record<string, ReadonlyArray<string>>>
  readonly team: ReadonlyArray<{ readonly id: string; readonly name: string; readonly owns: string }>
  readonly calendar: ReadonlyArray<CalendarEvent>
  readonly inbox: ReadonlyArray<Email>
  readonly chat: { readonly channels: ReadonlyArray<Channel>; readonly messages: ReadonlyArray<ChatMessage> }
  readonly issues: ReadonlyArray<Issue>
  readonly requests: ReadonlyArray<Request>
  readonly answers: Readonly<
    Record<string, ReadonlyArray<{ readonly match: ReadonlyArray<string>; readonly text: string }>>
  >
  readonly web: ReadonlyArray<{ readonly url: string; readonly title: string; readonly text: string }>
  readonly notes: Readonly<Record<string, unknown>>
  readonly private: { readonly markers: ReadonlyArray<string> }
  readonly urls: Readonly<Record<string, string>>
  readonly [key: string]: unknown
}

interface CalendarEvent {
  readonly id: string
  readonly start: string
  readonly end: string
  readonly title: string
  readonly private?: boolean
  readonly focus?: boolean
  readonly createdBy?: string
  readonly [key: string]: unknown
}
interface Email {
  readonly id: string
  readonly from: string
  readonly date: string
  readonly subject: string
  readonly body: string
  readonly private?: boolean
}
interface Channel {
  readonly id: string
  readonly name: string
}
interface ChatMessage {
  readonly id: string
  readonly channel: string
  readonly ts: string
  readonly from: string
  readonly text: string
  readonly thread?: string
}
interface Issue {
  readonly number: number
  readonly kind: "issue" | "pr"
  readonly title: string
  readonly state: string
  readonly [key: string]: unknown
}
interface Request {
  readonly id: string
  readonly from: string
  readonly date: string
  readonly title: string
  readonly body: string
}

const frontmatter = (text: string): { readonly meta: Record<string, unknown>; readonly body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  return match === null
    ? { meta: {}, body: text }
    : { meta: (parseYaml(match[1]!) ?? {}) as Record<string, unknown>, body: match[2]! }
}

const walk = (dir: string): Array<string> =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
    : []

/**
 * A case's changes to the world, applied in this order: `set` replaces
 * top-level keys; `remove` drops entries of top-level arrays by their `id` or
 * `number`; `add` appends to top-level arrays (or merges into top-level
 * objects); `pages` adds or replaces wiki pages by slug. Removing before
 * adding lets a case replace one entry (an issue in a new state) by removing
 * and re-adding it, without repeating the whole list.
 */
export interface Patch {
  readonly now?: string | undefined
  readonly set?: Readonly<Record<string, unknown>> | undefined
  readonly add?: Readonly<Record<string, unknown>> | undefined
  readonly remove?: Readonly<Record<string, ReadonlyArray<string | number>>> | undefined
  readonly pages?: ReadonlyArray<Partial<Page> & { readonly slug: string; readonly text: string }> | undefined
}

const merge = (base: unknown, extra: unknown): unknown => {
  if (Array.isArray(base) && Array.isArray(extra)) return [...base, ...extra]
  if (
    typeof base === "object" && base !== null && typeof extra === "object" && extra !== null &&
    !Array.isArray(base) && !Array.isArray(extra)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
      out[key] = key in out ? merge(out[key], value) : value
    }
    return out
  }
  return extra
}

/** Loads a world directory and applies one case's patch. */
export const load = (dir: string, patch: Patch = {}): World => {
  let data = parseYaml(readFileSync(join(dir, "world.yaml"), "utf8")) as Record<string, unknown>
  if (patch.set !== undefined) data = { ...data, ...patch.set }
  if (patch.remove !== undefined) {
    for (const [key, ids] of Object.entries(patch.remove)) {
      const list = data[key]
      if (Array.isArray(list)) {
        data[key] = list.filter((item: Record<string, unknown>) =>
          !ids.some((id) => item.id === id || item.number === id)
        )
      }
    }
  }
  if (patch.add !== undefined) {
    for (const [key, value] of Object.entries(patch.add)) data[key] = merge(data[key], value)
  }
  if (patch.now !== undefined) data.now = patch.now
  const pages = new Map<string, Page>()
  for (const path of walk(join(dir, "wiki")).filter((file) => file.endsWith(".md"))) {
    const { body, meta } = frontmatter(readFileSync(path, "utf8"))
    const slug = relative(join(dir, "wiki"), path).replace(/\.md$/, "")
    pages.set(slug, {
      slug,
      title: String(meta.title ?? slug),
      updated: String(meta.updated ?? ""),
      owner: String(meta.owner ?? ""),
      private: meta.private === true,
      text: body.trim()
    })
  }
  for (const page of patch.pages ?? []) {
    pages.set(page.slug, {
      title: page.slug,
      updated: "",
      owner: "",
      private: false,
      ...page
    })
  }
  const repo = walk(join(dir, "repo")).map((path) => ({
    path: relative(join(dir, "repo"), path),
    text: readFileSync(path, "utf8")
  }))
  return { dir, data: data as unknown as WorldData, pages, repo }
}

const template = (world: World, kind: string, values: Record<string, string | number>): string => {
  let url = world.data.urls[kind] ?? ""
  for (const [key, value] of Object.entries(values)) url = url.replaceAll(`{${key}}`, String(value))
  return url
}

/** The URL a thing in this world is linked by. */
export const urlOf = {
  issue: (world: World, issue: Issue) => template(world, issue.kind === "pr" ? "pull" : "issue", { n: issue.number }),
  page: (world: World, slug: string) => template(world, "wiki", { slug }),
  event: (world: World, id: string) => template(world, "event", { id }),
  email: (world: World, id: string) => template(world, "email", { id }),
  message: (world: World, message: ChatMessage) =>
    message.thread === undefined
      ? template(world, "message", { channel: message.channel, id: message.id })
      : template(world, "thread", { channel: message.channel, thread: message.thread }),
  request: (world: World, id: string) => template(world, "request", { id })
}

// ---------------------------------------------------------------------------
// Tools

// Search terms are words: quotes, operators and punctuation around them are
// ignored, the way a real search box treats them.
const terms = (query: string): Array<string> =>
  query.toLowerCase().split(/[^\p{L}\p{N}_$.#-]+/u).map((term) => term.replace(/^[.#-]+|[.-]+$/gu, ""))
    .filter((term) => term.length > 2 && !["and", "the", "for", "or", "not"].includes(term))

const anyTerm = (haystack: string, query: string | undefined): boolean => {
  if (query === undefined || query.trim() === "") return true
  const text = haystack.toLowerCase()
  const wanted = terms(query)
  return wanted.length === 0 || wanted.some((term) => text.includes(term))
}

const within = (iso: string, from: string | undefined, to: string | undefined): boolean =>
  (from === undefined || iso.slice(0, 16) >= from.slice(0, 16)) &&
  (to === undefined || iso.slice(0, 16) <= to.slice(0, 16))

const sealed = { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" } as const
const acting = { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "irreversible" } as const

type Handler = (input: Record<string, unknown>) => unknown

interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly input: Schema.Top
  readonly writes: boolean
  readonly handler: (world: World, role: string, state: State) => Handler
}

/** What the tools changed during a run, beside the action log. */
interface State {
  counter: number
  readonly drafts: Map<string, Record<string, unknown>>
  readonly events: Array<CalendarEvent>
}

const opt = Schema.optional
const S = Schema.String

const text = (value: unknown): string => (typeof value === "string" ? value : "")

const answerFor = (world: World, to: string, question: string): string | undefined => {
  const entries = world.data.answers[to] ?? []
  const lower = question.toLowerCase()
  return entries.find((entry) => entry.match.every((term) => lower.includes(term.toLowerCase())))?.text
}

const eventView = (world: World, event: CalendarEvent) => ({ ...event, url: urlOf.event(world, event.id) })

/** Every simulated tool. A role sees the subset its grant names. */
export const tools: ReadonlyArray<ToolSpec> = [
  {
    name: "react",
    description:
      "Add an emoji reaction to the message you are answering, e.g. \"eyes\" while you work or \"white_check_mark\" when done.",
    input: Schema.Struct({ emoji: S }),
    writes: true,
    handler: () => () => ({ reacted: true })
  },
  {
    name: "owner_message",
    description:
      "Send Will a direct message now. It notifies him immediately. Use it for things that need him now; batch everything else into the daily digest.",
    input: Schema.Struct({ text: S, urgent: opt(Schema.Boolean) }),
    writes: true,
    handler: (_world, _role, state) => () => ({ sent: true, id: `dm-${++state.counter}` })
  },
  {
    name: "digest_add",
    description: "Queue an item for Will's next daily digest instead of messaging him now.",
    input: Schema.Struct({ item: S }),
    writes: true,
    handler: () => () => ({ queued: true })
  },
  {
    name: "post",
    description:
      "Post a message in a team channel (\"brisk-team\" or \"eng\"), optionally in a thread. Every agent and Will can read it.",
    input: Schema.Struct({ channel: S, text: S, thread: opt(S) }),
    writes: true,
    handler: (_world, _role, state) => () => ({ posted: true, id: `post-${++state.counter}` })
  },
  {
    name: "reply_thread",
    description:
      "Reply in another existing thread (by channel and thread id). Your final answer already replies where the event came from.",
    input: Schema.Struct({ channel: S, thread: S, text: S }),
    writes: true,
    handler: (_world, _role, state) => () => ({ posted: true, id: `post-${++state.counter}` })
  },
  {
    name: "handoff",
    description:
      "Give a piece of work to another role (by role id, e.g. \"engineering\"). The brief is all they get: goal, context and links, constraints, what done looks like, deadline, who to report to.",
    input: Schema.Struct({ to: S, brief: S, deadline: opt(S) }),
    writes: true,
    handler: (world, _role, state) => (input) => {
      const to = text(input.to)
      if (!world.data.team.some((member) => member.id === to)) {
        return { error: `No role "${to}". Roles: ${world.data.team.map((member) => member.id).join(", ")}` }
      }
      return { task: `task-${++state.counter}`, to, state: "requested" }
    }
  },
  {
    name: "ask",
    description:
      "Ask another role a question (by role id). Returns their answer if they have one now; otherwise they reply later in the thread.",
    input: Schema.Struct({ to: S, question: S }),
    writes: true,
    handler: (world) => (input) => {
      const answer = answerFor(world, text(input.to), text(input.question))
      return answer === undefined
        ? { answer: null, note: `${text(input.to)} has not answered yet; they will reply in the thread.` }
        : { answer }
    }
  },
  {
    name: "request_owner",
    description:
      "Ask Will for a decision or resource. It goes to the Personal Assistant, who decides how and when to bring it to him.",
    input: Schema.Struct({ title: S, need: S, why: S }),
    writes: true,
    handler: (_world, _role, state) => () => ({ request: `REQ-${100 + ++state.counter}`, state: "requested" })
  },
  {
    name: "requests_list",
    description: "List the open requests other roles have sent for Will, in full.",
    input: Schema.Struct({}),
    writes: false,
    handler: (world) => () =>
      world.data.requests.map((request) => ({ ...request, url: urlOf.request(world, request.id) }))
  },
  {
    name: "request_read",
    description: "Read one open request in full.",
    input: Schema.Struct({ id: S }),
    writes: false,
    handler: (world) => (input) => {
      const request = world.data.requests.find((candidate) => candidate.id === text(input.id))
      return request === undefined
        ? { error: "No such request" }
        : { ...request, url: urlOf.request(world, request.id) }
    }
  },
  {
    name: "request_resolve",
    description:
      "Close or update a request and tell the requester. outcome: answered | declined | sent-to-will | decided | parked. The note is sent to the requesting role.",
    input: Schema.Struct({ id: S, outcome: S, note: S }),
    writes: true,
    handler: () => () => ({ updated: true })
  },
  {
    name: "calendar_list",
    description:
      "Will's calendar events between two local times (ISO, e.g. 2026-10-05T00:00), with titles and details.",
    input: Schema.Struct({ from: S, to: S }),
    writes: false,
    handler: (world, _role, state) => (input) =>
      state.events.filter((event) =>
        within(event.start, text(input.from), text(input.to)) || within(event.end, text(input.from), text(input.to))
      )
        .map((event) => eventView(world, event))
  },
  {
    name: "calendar_freebusy",
    description: "Busy intervals on Will's calendar between two local times. No titles or details.",
    input: Schema.Struct({ from: S, to: S }),
    writes: false,
    handler: (_world, _role, state) => (input) =>
      state.events.filter((event) => within(event.start, text(input.from), text(input.to)))
        .map((event) => ({ start: event.start, end: event.end, busy: true }))
  },
  {
    name: "calendar_create",
    description: "Create an event on Will's calendar (local times, ISO).",
    input: Schema.Struct({ title: S, start: S, end: S, attendees: opt(Schema.Array(S)), notes: opt(S) }),
    writes: true,
    handler: (world, role, state) => (input) => {
      const id = `ev-new-${++state.counter}`
      state.events.push({
        id,
        start: text(input.start),
        end: text(input.end),
        title: text(input.title),
        createdBy: role
      })
      return { id, url: urlOf.event(world, id) }
    }
  },
  {
    name: "calendar_move",
    description: "Move an event on Will's calendar to a new start and end (local times, ISO).",
    input: Schema.Struct({ id: S, start: S, end: S }),
    writes: true,
    handler: (world, _role, state) => (input) => {
      const index = state.events.findIndex((event) => event.id === text(input.id))
      if (index < 0) return { error: "No such event" }
      state.events[index] = { ...state.events[index]!, start: text(input.start), end: text(input.end) }
      return { moved: true, url: urlOf.event(world, text(input.id)) }
    }
  },
  {
    name: "calendar_cancel",
    description: "Cancel an event on Will's calendar.",
    input: Schema.Struct({ id: S }),
    writes: true,
    handler: () => () => ({ cancelled: true })
  },
  {
    name: "email_search",
    description: "Search Will's inbox. Empty query lists recent mail. Returns id, from, date, subject.",
    input: Schema.Struct({ query: opt(S) }),
    writes: false,
    handler: (world) => (input) =>
      world.data.inbox.filter((mail) =>
        anyTerm(`${mail.from} ${mail.subject} ${mail.body}`, text(input.query) || undefined)
      )
        .map((mail) => ({
          id: mail.id,
          from: mail.from,
          date: mail.date,
          subject: mail.subject,
          url: urlOf.email(world, mail.id)
        }))
  },
  {
    name: "email_read",
    description: "Read one email from Will's inbox.",
    input: Schema.Struct({ id: S }),
    writes: false,
    handler: (world) => (input) => {
      const mail = world.data.inbox.find((candidate) => candidate.id === text(input.id))
      return mail === undefined ? { error: "No such email" } : { ...mail, url: urlOf.email(world, mail.id) }
    }
  },
  {
    name: "email_draft",
    description: "Draft an email from Will's account. Nothing is sent.",
    input: Schema.Struct({ to: S, subject: S, body: S, replyTo: opt(S) }),
    writes: true,
    handler: (world, _role, state) => (input) => {
      const id = `draft-${++state.counter}`
      state.drafts.set(id, input)
      return { draftId: id, url: urlOf.email(world, id) }
    }
  },
  {
    name: "email_send",
    description: "Send a drafted email from Will's account.",
    input: Schema.Struct({ draftId: S }),
    writes: true,
    handler: () => () => ({ sent: true })
  },
  {
    name: "x_draft",
    description: "Draft a post for Will's X account. Nothing is posted.",
    input: Schema.Struct({ text: S }),
    writes: true,
    handler: (_world, _role, state) => () => ({ draftId: `x-${++state.counter}` })
  },
  {
    name: "wiki_search",
    description: "Search the team wiki. Returns page slug, title, last updated and owner.",
    input: Schema.Struct({ query: S }),
    writes: false,
    handler: (world, role) => (input) =>
      [...world.pages.values()].filter((page) => role === "personal-assistant" || !page.private)
        .filter((page) => anyTerm(`${page.slug} ${page.title} ${page.text}`, text(input.query)))
        .map((page) => ({
          page: page.slug,
          title: page.title,
          updated: page.updated,
          owner: page.owner,
          url: urlOf.page(world, page.slug)
        }))
  },
  {
    name: "wiki_read",
    description: "Read a team wiki page by slug.",
    input: Schema.Struct({ page: S }),
    writes: false,
    handler: (world, role) => (input) => {
      const page = world.pages.get(text(input.page))
      return page === undefined || (page.private && role !== "personal-assistant")
        ? { error: `No page "${text(input.page)}". Pages: ${[...world.pages.keys()].join(", ")}` }
        : { ...page, url: urlOf.page(world, page.slug) }
    }
  },
  {
    name: "wiki_write",
    description: "Create or replace a team wiki page. Every agent can read team pages; private: true keeps it to you.",
    input: Schema.Struct({ page: S, text: S, private: opt(Schema.Boolean) }),
    writes: true,
    handler: (world, role) => (input) => {
      const slug = text(input.page)
      world.pages.set(slug, {
        slug,
        title: slug,
        updated: world.data.now.slice(0, 10),
        owner: role,
        private: input.private === true,
        text: text(input.text)
      })
      return { written: true, url: urlOf.page(world, slug) }
    }
  },
  {
    name: "issues_search",
    description:
      "Search issues and pull requests in brisk-hq/brisk. Optional state (open, closed, merged, draft) and kind (issue, pr).",
    input: Schema.Struct({ query: opt(S), state: opt(S), kind: opt(S) }),
    writes: false,
    handler: (world) => (input) =>
      world.data.issues.filter((issue) =>
        anyTerm(`${issue.number} ${issue.title} ${JSON.stringify(issue)}`, text(input.query) || undefined) &&
        (input.state === undefined || issue.state === input.state) &&
        (input.kind === undefined || issue.kind === input.kind)
      ).map((issue) => ({
        number: issue.number,
        kind: issue.kind,
        title: issue.title,
        state: issue.state,
        url: urlOf.issue(world, issue)
      }))
  },
  {
    name: "issue_read",
    description: "Read one issue or pull request by number.",
    input: Schema.Struct({ number: Schema.Number }),
    writes: false,
    handler: (world) => (input) => {
      const issue = world.data.issues.find((candidate) => candidate.number === Number(input.number))
      return issue === undefined ? { error: "No such issue" } : { ...issue, url: urlOf.issue(world, issue) }
    }
  },
  {
    name: "chat_search",
    description: "Search team chat messages.",
    input: Schema.Struct({ query: S }),
    writes: false,
    handler: (world) => (input) =>
      world.data.chat.messages.filter((message) => anyTerm(`${message.from} ${message.text}`, text(input.query)))
        .map((message) => ({ ...message, url: urlOf.message(world, message) }))
  },
  {
    name: "thread_read",
    description: "Read a chat thread by id.",
    input: Schema.Struct({ thread: S }),
    writes: false,
    handler: (world) => (input) =>
      world.data.chat.messages.filter((message) =>
        message.thread === text(input.thread) || message.id === text(input.thread)
      )
        .map((message) => ({ ...message, url: urlOf.message(world, message) }))
  },
  {
    name: "web_fetch",
    description: "Fetch a public web page and return its text.",
    input: Schema.Struct({ url: S }),
    writes: false,
    handler: (world) => (input) =>
      world.data.web.find((page) => page.url === text(input.url)) ?? { error: "Page not found or not reachable" }
  },
  {
    name: "notes_read",
    description: "Read your private notes: Will's commitments and preferences.",
    input: Schema.Struct({}),
    writes: false,
    handler: (world) => () => world.data.notes
  },
  {
    name: "notes_write",
    description: "Add to your private notes.",
    input: Schema.Struct({ text: S }),
    writes: true,
    handler: () => () => ({ saved: true })
  }
]

/** The tool names a role holds in this world. */
export const grantedTo = (world: World, role: string): ReadonlyArray<string> =>
  world.data.grants[role] ?? world.data.grants.default ?? []

/**
 * Binds the role's granted tools as executable flows. Each call appends to
 * `actions` before it answers.
 */
export const sources = (
  world: World,
  role: string,
  actions: Array<Action>,
  /** Ids the tools mint (drafts, events, tasks) start after this, so turns of one conversation never reuse an id. */
  idBase = 0
): Array<FlowBinding.Source> => {
  const granted = new Set(grantedTo(world, role))
  const state: State = {
    counter: idBase,
    drafts: new Map(),
    events: world.data.calendar.map((event) => ({ ...event }))
  }
  const bindings = tools.filter((tool) => granted.has(tool.name)).map((tool) => {
    const flow = CoreFlow.make({
      name: tool.name,
      description: tool.description,
      input: tool.input as Schema.Codec<Record<string, unknown>>,
      output: Schema.Unknown,
      effects: tool.writes ? acting : sealed
    })
    const handle = tool.handler(world, role, state)
    return FlowBinding.make({
      flow,
      handler: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          const action: Action = { tool: tool.name, input }
          actions.push(action)
          action.output = handle(input)
          return action.output
        })
    })
  })
  return [FlowBinding.source("evals/character/world", bindings)]
}

/** Calendar events after a run, for scorers that check a booking against the calendar. */
export const calendarOf = (world: World): ReadonlyArray<CalendarEvent> => world.data.calendar
