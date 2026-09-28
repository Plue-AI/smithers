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
 * message to Will is an `owner_message` action, a test run is a `run_tests`
 * action, a deploy is an `ops_run` action, and so on. Work tools are simulated
 * against the world's fixtures: `repo_read` and `repo_search` read `repo/`,
 * `run_tests` answers from the scripted results under `tests`, `ops_run`
 * answers from the scripted results under `ops`, and `pr_open`, `issue_create`,
 * `issue_comment` and `issue_update` change the turn's copy of the issue list,
 * so a case can assert that the role did the work. A role only gets
 * the tools its grant lists in `world.yaml` (`grants.<role>`, else
 * `grants.default`), so a scenario can never pass by calling a tool the real
 * role would not hold.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
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
  /**
   * Scripted test results for `run_tests`, the most specific match wins: every `match`
   * term must appear in the filter the role passed (an empty `match` is the
   * default). A world without `tests` has no test runner.
   */
  readonly tests?: ReadonlyArray<TestResult> | undefined
  /**
   * Scripted results for `ops_run` (deploy, roll back, restart, rotate...),
   * the most specific match wins: the entry's `action`, when set, must equal the action
   * the role asked for, and every `match` term must appear in its target (an
   * entry with neither is the default). A world without `ops` has no
   * operations workspace.
   */
  readonly ops?: ReadonlyArray<OpsResult> | undefined
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
interface TestResult {
  readonly match: ReadonlyArray<string>
  readonly status: "passed" | "failed"
  readonly passed?: number | undefined
  readonly failed?: number | undefined
  readonly output: string
}
interface OpsResult {
  readonly action?: string | undefined
  readonly match?: ReadonlyArray<string> | undefined
  readonly status: "succeeded" | "failed" | "started"
  readonly output: string
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

/**
 * Every regular file under `dir`. A symlink is skipped, `dir` itself
 * included, so `wiki/` and `repo/` never follow a symlink out of the world.
 */
const walk = (dir: string): Array<string> =>
  existsSync(dir) && lstatSync(dir).isDirectory()
    ? readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      const stat = lstatSync(path)
      return stat.isDirectory() ? walk(path) : stat.isFile() ? [path] : []
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
  request: (world: World, id: string) => template(world, "request", { id }),
  file: (world: World, path: string) => template(world, "file", { path })
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
export interface State {
  counter: number
  readonly drafts: Map<string, Record<string, unknown>>
  readonly events: Array<CalendarEvent>
  /** The turn's copy of the issue list: created, commented and updated issues live here. */
  readonly issues: Array<Issue>
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

const issueView = (world: World, issue: Issue) => ({ ...issue, url: urlOf.issue(world, issue) })

/** The next issue or pull request number: one past the highest in the list. */
const nextNumber = (issues: ReadonlyArray<Issue>): number =>
  issues.reduce((max, issue) => Math.max(max, issue.number), 0) + 1

/** The most specific entry wins (most `match` terms, then an `action`); ties go to the first, so a case's entries beat the world's defaults. */
const mostSpecific = <A>(entries: ReadonlyArray<A> | undefined, matches: (entry: A) => boolean, weight: (entry: A) => number): A | undefined =>
  entries?.reduce<A | undefined>((best, entry) => matches(entry) && (best === undefined || weight(entry) > weight(best)) ? entry : best, undefined)

const testsFor = (world: World, filter: string): TestResult | undefined => {
  const lower = filter.toLowerCase()
  return mostSpecific(world.data.tests, (entry) => entry.match.every((term) => lower.includes(term.toLowerCase())), (entry) => entry.match.length)
}

const opsFor = (world: World, action: string, target: string): OpsResult | undefined => {
  const lower = target.toLowerCase()
  return mostSpecific(
    world.data.ops,
    (entry) =>
      (entry.action === undefined || entry.action.toLowerCase() === action.toLowerCase()) &&
      (entry.match ?? []).every((term) => lower.includes(term.toLowerCase())),
    (entry) => (entry.match ?? []).length * 2 + (entry.action === undefined ? 0 : 1)
  )
}

const strings = (value: unknown): Array<string> | undefined =>
  Array.isArray(value) ? value.map(String) : undefined

/** Whether a role may read a page: team pages, and private pages for the personal assistant alone. */
const readable = (page: Page, role: string): boolean => !page.private || role === "personal-assistant"

const readableSlugs = (world: World, role: string): string =>
  [...world.pages.values()].filter((page) => readable(page, role)).map((page) => page.slug).join(", ")

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
      [...world.pages.values()].filter((page) => readable(page, role))
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
      return page === undefined || !readable(page, role)
        ? { error: `No page "${text(input.page)}". Pages: ${readableSlugs(world, role)}` }
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
      const existing = world.pages.get(slug)
      // A private page is the personal assistant's alone: another role can
      // neither read it nor replace it with a team page.
      if (existing !== undefined && !readable(existing, role)) {
        return { error: `Page "${slug}" is not yours to write. Pages: ${readableSlugs(world, role)}` }
      }
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
    handler: (world, _role, state) => (input) =>
      state.issues.filter((issue) =>
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
    handler: (world, _role, state) => (input) => {
      const issue = state.issues.find((candidate) => candidate.number === Number(input.number))
      return issue === undefined ? { error: "No such issue" } : issueView(world, issue)
    }
  },
  {
    name: "issue_create",
    description:
      "File a new issue in brisk-hq/brisk: title, body, optional labels, assignee (a role id) and priority. Returns its number and url.",
    input: Schema.Struct({
      title: S,
      body: S,
      labels: opt(Schema.Array(S)),
      assignee: opt(S),
      priority: opt(S)
    }),
    writes: true,
    handler: (world, role, state) => (input) => {
      const issue: Issue = {
        number: nextNumber(state.issues),
        kind: "issue",
        title: text(input.title),
        state: "open",
        body: text(input.body),
        author: role,
        opened: world.data.now.slice(0, 10),
        ...(input.labels === undefined ? {} : { labels: strings(input.labels) }),
        ...(input.assignee === undefined ? {} : { assignee: text(input.assignee) }),
        ...(input.priority === undefined ? {} : { priority: text(input.priority) })
      }
      state.issues.push(issue)
      return { number: issue.number, state: "open", url: urlOf.issue(world, issue) }
    }
  },
  {
    name: "issue_comment",
    description: "Comment on an issue or pull request by number. Everyone on the repository can read it.",
    input: Schema.Struct({ number: Schema.Number, text: S }),
    writes: true,
    handler: (world, role, state) => (input) => {
      const index = state.issues.findIndex((candidate) => candidate.number === Number(input.number))
      if (index < 0) return { error: "No such issue" }
      const issue = state.issues[index]!
      const comments = [...(strings(issue.comments) ?? []), `${role}, ${world.data.now.slice(0, 10)}: ${text(input.text)}`]
      state.issues[index] = { ...issue, comments }
      return { commented: true, url: urlOf.issue(world, issue) }
    }
  },
  {
    name: "issue_update",
    description:
      "Change an issue or pull request: state (open or closed), labels, assignee (a role id), priority, or duplicateOf (the number it duplicates, which also closes it). Returns the updated issue.",
    input: Schema.Struct({
      number: Schema.Number,
      state: opt(S),
      labels: opt(Schema.Array(S)),
      assignee: opt(S),
      priority: opt(S),
      duplicateOf: opt(Schema.Number)
    }),
    writes: true,
    handler: (world, _role, state) => (input) => {
      const index = state.issues.findIndex((candidate) => candidate.number === Number(input.number))
      if (index < 0) return { error: "No such issue" }
      const next = input.state === undefined ? undefined : text(input.state)
      if (next !== undefined && next !== "open" && next !== "closed") {
        return { error: `state must be open or closed, not "${next}"` }
      }
      const issue = state.issues[index]!
      const duplicateOf = input.duplicateOf === undefined ? undefined : Number(input.duplicateOf)
      if (duplicateOf !== undefined && !state.issues.some((candidate) => candidate.number === duplicateOf)) {
        return { error: `No issue #${duplicateOf} to mark this a duplicate of` }
      }
      const updated: Issue = {
        ...issue,
        ...(next === undefined && duplicateOf === undefined ? {} : { state: next ?? "closed" }),
        ...(input.labels === undefined ? {} : { labels: strings(input.labels) }),
        ...(input.assignee === undefined ? {} : { assignee: text(input.assignee) }),
        ...(input.priority === undefined ? {} : { priority: text(input.priority) }),
        ...(duplicateOf === undefined ? {} : { duplicateOf })
      }
      state.issues[index] = updated
      return { updated: true, ...issueView(world, updated) }
    }
  },
  {
    name: "pr_open",
    description:
      "Open a pull request in brisk-hq/brisk from work you did: title, description, optional branch and the issue number it closes. Checks start as pending. Returns its number and url.",
    input: Schema.Struct({ title: S, body: S, branch: opt(S), closes: opt(Schema.Number) }),
    writes: true,
    handler: (world, role, state) => (input) => {
      const pull: Issue = {
        number: nextNumber(state.issues),
        kind: "pr",
        title: text(input.title),
        state: "open",
        body: text(input.body),
        author: role,
        opened: world.data.now.slice(0, 10),
        checks: "pending",
        ...(input.branch === undefined ? {} : { branch: text(input.branch) }),
        ...(input.closes === undefined ? {} : { closes: Number(input.closes) })
      }
      state.issues.push(pull)
      return { number: pull.number, state: "open", checks: "pending", url: urlOf.issue(world, pull) }
    }
  },
  {
    name: "repo_read",
    description: "Read one file of the brisk-hq/brisk repository by path (e.g. src/sync/merge.ts).",
    input: Schema.Struct({ path: S }),
    writes: false,
    handler: (world) => (input) => {
      const file = world.repo.find((candidate) => candidate.path === text(input.path))
      return file === undefined
        ? { error: `No file "${text(input.path)}". Files: ${world.repo.map((candidate) => candidate.path).join(", ")}` }
        : { path: file.path, text: file.text, url: urlOf.file(world, file.path) }
    }
  },
  {
    name: "repo_search",
    description: "Search the brisk-hq/brisk repository for a word or phrase. Returns matching lines with path and line number.",
    input: Schema.Struct({ query: S }),
    writes: false,
    handler: (world) => (input) => {
      const query = text(input.query).toLowerCase()
      if (query.trim() === "") return []
      return world.repo.flatMap((file) =>
        file.text.split("\n").flatMap((line, index) =>
          line.toLowerCase().includes(query)
            ? [{ path: file.path, line: index + 1, text: line.trim(), url: urlOf.file(world, file.path) }]
            : []
        )
      ).slice(0, 50)
    }
  },
  {
    name: "run_tests",
    description:
      "Run the repository's tests on the current main branch, optionally only those matching a filter (a file, directory or test name). Returns pass/fail counts and the output.",
    input: Schema.Struct({ filter: opt(S) }),
    writes: false,
    handler: (world) => (input) => {
      const filter = text(input.filter)
      if (world.data.tests === undefined) return { error: "No test runner is set up for this repository yet." }
      const result = testsFor(world, filter)
      return result === undefined
        ? { error: filter === "" ? "No tests ran." : `No tests match "${filter}".` }
        : {
          status: result.status,
          ...(result.passed === undefined ? {} : { passed: result.passed }),
          ...(result.failed === undefined ? {} : { failed: result.failed }),
          output: result.output
        }
    }
  },
  {
    name: "ops_run",
    description:
      "Run an operational command in your operations workspace against production or staging: action is one verb (deploy, rollback, restart, pause, resume, rotate, restore, scale, set) and target names what it acts on (a version, service, job, credential or setting, e.g. \"0.9.6\" or \"indexer\"). Returns whether it succeeded, failed or is still running, and its output.",
    input: Schema.Struct({ action: S, target: S, reason: opt(S) }),
    writes: true,
    handler: (world) => (input) => {
      const action = text(input.action)
      const target = text(input.target)
      if (world.data.ops === undefined) return { error: "No operations workspace is set up for this world." }
      const result = opsFor(world, action, target)
      return result === undefined
        ? { error: `No result is scripted for ${action} "${target}".` }
        : { action, target, status: result.status, output: result.output }
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

/** A turn's mutable state before any tool ran: copies of the calendar and the issue list. */
export const initialState = (world: World, idBase = 0): State => ({
  counter: idBase,
  drafts: new Map(),
  events: world.data.calendar.map((event) => ({ ...event })),
  issues: world.data.issues.map((issue) => ({ ...issue }))
})

/** Runs one tool by name outside the agent loop, e.g. in a test. */
export const call = (world: World, role: string, state: State, tool: string, input: Record<string, unknown>): unknown => {
  const spec = tools.find((candidate) => candidate.name === tool)
  if (spec === undefined) throw new Error(`no tool "${tool}"`)
  return spec.handler(world, role, state)(input)
}

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
  const state = initialState(world, idBase)
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
