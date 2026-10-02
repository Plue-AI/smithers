/*
 * The mock's world: the objects the MVP spec names (.specs/product/mvp.md §3)
 * and each member's own screen. Journeys mutate a fresh copy step by step, so
 * any step can be rebuilt from scratch and every frame is deterministic.
 */

export type ActorId = string

export interface Member {
  readonly id: ActorId
  readonly name: string
  readonly login: string
  readonly initials: string
  /** Identity colour: one of the app's six lane tokens (--lane-0..5). */
  readonly lane: number
  /** mvp.md M-05: the owner installed it; maintainers merge, manage people and secrets; members do the rest. */
  readonly role: "owner" | "maintainer" | "member"
  /** Added in Smithers but lacking write access on GitHub. */
  needsAccess?: boolean
  /** Had write access and lost it on GitHub. */
  suspended?: boolean
  seq?: number
}

/** mvp.md §4. Merged is done; learning is a receipt on the merged TODO, not a state. */
export type TodoState = "queued" | "starting" | "working" | "needs-you" | "paused" | "in-review" | "merged" | "failed" | "dropped"

export interface Check {
  readonly name: string
  state: "passed" | "failed" | "running"
  readonly took?: string
}

export interface Evidence {
  /** The revision this evidence is for. A rebase makes a new one, and every check reruns on it. */
  rev?: string
  readonly files: number
  readonly added: number
  readonly removed: number
  readonly checks: Array<Check>
  readonly github: { passed: number; total: number; failing?: string }
  readonly review: string
}

export interface Todo {
  readonly id: string
  /** The TODO's reference from the moment it is committed: T12. GitHub's #n stays for issues and PRs. */
  ref?: string
  /** Prompt revisions folded in by Amend; the "+n" chip opens them. */
  amendments?: Array<{ readonly by: ActorId; readonly text: string }>
  /** The approval a rebase cleared: the revision changed, so checks rerun. */
  approvalCleared?: boolean
  /** The revision a person approved; when it differs from the evidence's, the approval is stale. */
  approvedRev?: string
  title: string
  prompt: string
  readonly owner: ActorId
  branch: string
  state: TodoState
  /** Position in the machine queue while Queued. */
  queue?: number
  /** The flow step the coding agent is on while Working. */
  step?: string
  /** The flow version's steps this TODO started with; a merged flow change applies only to TODOs started after it. */
  steps?: Array<FlowStep>
  /** Attempts so far; Retry starts a new one and keeps the earlier ones' evidence. */
  attempts?: number
  question?: {
    readonly text: string
    answer?: { readonly by: ActorId; readonly text: string }
    /** Someone was still typing when another answer settled it: their draft is kept behind Send as steer. */
    late?: { readonly by: ActorId; readonly text: string }
  }
  /*
   * Why it needs a person (engineering contract): its one action follows from
   * the kind. question and approval: Answer. conflict and moved_off: Resolve.
   * foreign_push: Bring in or Discard on the card (Review on the row). force_push: Review. order: Move.
   */
  needs?: "question" | "approval" | "conflict" | "moved_off" | "order" | "foreign_push" | "force_push"
  /** Merged out of order: a later item's PR merged first and carried this one's change in its commit. */
  mergedVia?: string
  /** Who pushed to the PR's branch from outside (foreign_push): Smithers never overwrites a person's commit (mvp.md J10.3). */
  pushedBy?: ActorId
  issue?: number
  /** The stack item this TODO folds into, when it was placed with Amend. */
  amends?: string
  pr?: number
  /** GitHub's own reason Merge is blocked; it replaces the Merge label (mvp.md §6.3). */
  mergeBlock?: string
  evidence?: Evidence
  lessons?: number
  elapsed?: string
  failure?: string
  /** Set when the row changed in the step that is playing. */
  seq?: number
}

export type MachineState = "awake" | "asleep" | "waking" | "waiting" | "closed"

export type Where =
  | { readonly kind: "terminal"; readonly id: string; readonly watching?: boolean }
  | { readonly kind: "file"; readonly path: string; readonly line?: number }
  | { readonly kind: "step"; readonly step: string }
  | { readonly kind: "branch" }

/*
 * Everyone and everything in a workspace (mvp.md §6.8): people, the branch's
 * coding agent, and agents acting for a person ("Ben via Claude Code" in his
 * terminal, "Ben via Smithers" from his chat). Each shows where it is.
 */
export interface Presence {
  readonly who: ActorId
  where: Where
  /** A terminal this person is also watching. */
  watching?: string
}

export interface Activity {
  readonly id: string
  readonly who: ActorId
  readonly kind: "step" | "steer" | "question" | "answer" | "edit" | "change" | "read" | "context"
  readonly text: string
  /** A burst of outside writes, grouped into one entry (mvp.md M-27): how many files. */
  readonly files?: number
  /** read: the files the coding agent read, each opening the File card; context: what its preflight chose (B.3). */
  readonly items?: ReadonlyArray<string>
  readonly tone?: "ok" | "fail" | "run"
  readonly seq: number
  /** It came from GitHub (a review comment, a push); shown with the GitHub mark. */
  readonly github?: boolean
  /** A stack operation someone asked for: "Maya asked · Rebased onto T8". */
  readonly asked?: ActorId
}

/*
 * A branch is the place one stack item is worked (its TODO), or a scratch
 * branch forked for hands-on work. It owns the machine, the people present
 * and the coding agent's activity. The stack itself is the repository's.
 */
export interface Branch {
  readonly id: string
  name: string
  /** Set while an earlier item or main moved and people are present (mvp.md §4.2). */
  rebasePending?: string
  /** Hand-run version control moved the working copy off its item (mvp.md M-27). */
  movedOff?: { readonly by: ActorId; readonly item: string }
  /** The TODO this branch works; absent on a scratch branch. */
  item?: string
  /** The branch it forked from: "main" for a stack item's branch, or another branch's id for a scratch fork (mvp.md B.1 tree). */
  readonly from: string
  machine: MachineState
  waitPosition?: number
  presence: Array<Presence>
  activity: Array<Activity>
  terminals: Array<string>
}

export interface TermLine {
  readonly text: string
  readonly tone?: "prompt" | "ok" | "fail" | "dim"
  readonly seq: number
}

/* A personal session (mvp.md M-18): it runs as its owner; others watch, and type only when the owner allows it. */
export interface Terminal {
  readonly id: string
  readonly branch: string
  readonly title: string
  readonly owner: ActorId
  /** The foreground command, shown wherever the session is listed. */
  running?: string
  lines: Array<TermLine>
  watchers: Array<ActorId>
  /** A system package the session needed (no sudo on machines): offered as a reviewed image change. */
  offer?: string
  /** The owner joined after the machine woke, so their home is machine-local until the next wake (engineering T-MCH-11). */
  temporaryHome?: boolean
}

export interface CodeLine {
  readonly n: number
  text: string
  by?: ActorId
  seq?: number
  /** The text this line had before its latest edit, shown in the diff. */
  was?: string
}

/*
 * A file in a branch's one working copy. The File card co-edits it live with
 * Yjs, like the wiki (mvp.md M-02): keystrokes reach everyone with it open,
 * each person's characters in their colour, with a name flag on the line each
 * editor is on. The live document saves to the machine continuously; agent
 * and terminal writes enter it as attributed edits.
 */
export interface FileDoc {
  readonly path: string
  readonly branch: string
  readonly lines: Array<CodeLine>
  /** Who has the file open for editing, and the line each is on. */
  editors?: Array<{ readonly who: ActorId; line: number }>
  /** The file was deleted or renamed from outside while open. */
  gone?: { readonly kind: "deleted" | "renamed"; readonly by: ActorId; readonly to?: string }
  /** A save from outside Smithers landed while people were typing: the live document keeps their edits, and Compare shows that version beside it (B.4). */
  outside?: { readonly line: number; readonly text: string }
}

/* What GitHub shows for a TODO's pull request: the right-hand window in J10. */
export interface GitHubPr {
  readonly number: number
  readonly todo: string
  readonly title: string
  base: string
  readonly head: string
  state: "open" | "merged" | "closed"
  /** A later stack item's PR is a GitHub draft until the items before it merge: the ref it merges after. */
  draftAfter?: string
  readonly requestedBy: ActorId
  body: Array<string>
  commits: Array<{ readonly by: string; readonly text: string; readonly sha: string }>
  thread: Array<{ readonly who: string; readonly text: string; readonly line?: number; readonly seq: number }>
  approvals: Array<ActorId>
  required: number
  mergedBy?: ActorId
}

export interface Issue {
  readonly number: number
  readonly title: string
  readonly author: ActorId
  readonly body: string
  readonly age: string
  readonly comments: Array<{ readonly who: ActorId; readonly text: string; readonly age: string }>
  open: boolean
  /** The TODO made from it; the issue closes when that TODO merges if the TODO fixes it. */
  todo?: string
}

/* A TODO being written in one member's chat: not on the stack until committed. */
export type Place = { readonly kind: "append" } | { readonly kind: "before"; readonly id: string } | { readonly kind: "amend"; readonly id: string }

export interface Draft {
  readonly id: string
  title: string
  prompt: string
  readonly issue?: number
  fixes: boolean
  place: Place
  /** Set once committed; the card then shows the TODO it became. */
  committed?: string
}

/*
 * A flow invoked without its required input (THE FORM LAW, apps/app/AGENTS.md):
 * a form for exactly the missing fields, its draft in the card. Submit runs the
 * flow as the person who asked, and the card becomes its receipt.
 */
export interface FlowForm {
  readonly id: string
  readonly title: string
  readonly fields: Array<{ readonly id: string; readonly label: string; value: string; readonly required?: boolean; readonly multiline?: boolean }>
  /** The submit button's verb: "Open on GitHub". */
  readonly submit: string
  /** Set once submitted: what the flow did. */
  receipt?: string
  seq?: number
}

/* A run that is not TODO work: learning, wiki refresh, other flows (mvp.md §6.4). */
export interface BackgroundRun {
  readonly id: string
  readonly title: string
  state: "running" | "done" | "failed"
  detail?: string
  readonly seq?: number
}

export interface FlowVersion {
  readonly id: string
  readonly label: string
  state: "active" | "proposed" | "merged-syncing" | "merged-failed" | "previous"
  readonly todo?: string
  readonly steps: ReadonlyArray<FlowStep>
  readonly error?: string
  /** System flows (stack operations, merge, members, settings) are read-only. */
  readonly system?: boolean
}

export interface Setup {
  /** Who can reach the install (mvp.md §6.1): only this Mac until the owner lets the office network in. */
  listen: "mac" | "network"
  /** The addresses people and laptop agents use, set at setup and in Settings. Plain HTTP works, but browser notifications need HTTPS. SSH is the first one's host, port 2222. */
  addresses: Array<string>
  /** This Mac's memory: the machine count derives from it (M-06). */
  readonly memory: string
  github: "todo" | "signed-in" | "app-installed" | "app-failed"
  /** Why the GitHub App failed, named in Settings beside Repair. */
  appError?: string
  /** The one prerequisite check: false when the repository doesn't allow squash merging. */
  squash?: boolean
  /** A newer Smithers the owner can upgrade to, with `smthrs host upgrade` on the Mac. */
  upgrade?: string
  /*
   * Model access (mvp.md §6.5), one key per role: the fast model runs the app
   * agent and timeline summaries, the coding model runs the coding agent, and
   * the AI Gateway key makes typed decisions. Each key validates before it is
   * saved; a failed key keeps its field open with its provider's reason.
   * Without a fast key, the app agent falls back to the coding model.
   */
  fastKey?: "validating" | "saved" | "failed"
  codingKey?: "validating" | "saved" | "failed"
  gatewayKey?: "validating" | "saved" | "failed"
  /** The coding model's provider, chosen on its row. */
  provider: string
  keyError?: string
  /** The folder on the Mac the wiki syncs with both ways, so Obsidian there opens it (mvp.md §6.11). */
  obsidian: string
  repository?: string
  source: "waiting" | "mirroring" | "ready"
  sourcePct?: number
  machine: "waiting" | "building" | "ready"
  machinePct?: number
  /** "about 6 min left": the machine build is honest about minutes, not just a percentage. */
  machineNote?: string
  /** A failed machine build keeps its reason and offers Retry. */
  machineError?: string
}

export interface FlowStep {
  readonly id: string
  readonly title: string
  /** One line on what the step does, shown on the Flow card. */
  readonly detail?: string
  /** Set when the step arrived in the step that is playing. */
  seq?: number
}

export interface World {
  readonly repo: string
  members: Array<Member>
  /*
   * The repository's one stack (mvp.md §3): TODO ids in the order they reach
   * main, next to merge first. Every TODO is one item: one change, one PR.
   */
  stack: Array<string>
  branches: Array<Branch>
  todos: Array<Todo>
  terminals: Array<Terminal>
  files: Array<FileDoc>
  issues: Array<Issue>
  flow: Array<FlowStep>
  capacity: number
  mergedSinceLook: number
  drafts: Array<Draft>
  runs: Array<BackgroundRun>
  flowVersions: Array<FlowVersion>
  /** Seconds since the last GitHub sync; past twice the target it reads stale. */
  syncedAgo: number
  /** main's newest commit as the main row shows it, e.g. "#216 merged · just now". */
  mainHead?: { readonly text: string; readonly seq: number }
  /** GitHub sync health beyond age: refused (credentials) or limited (rate limit), with the cause and when it retries. */
  mainHealth?: { readonly state: "refused" | "limited"; readonly cause: string; readonly retryAt?: string }
  setup: Setup
  /** How many TODOs work at once (history.parallel, owner only, in Settings). */
  parallel: number
  proposals: Array<Proposal>
  reviews: Array<Review>
  acts: Array<Act>
  secrets: Array<{ readonly name: string; scope: "all branches" | "main only" }>
  github: Array<GitHubPr>
  traces: Array<Trace>
  /** Forms open in conversations (THE FORM LAW); absent until a journey opens one. */
  forms?: Array<FlowForm>
  /** The repository's wiki: one Markdown vault (mvp.md §6.11). */
  wiki: Array<WikiPage>
  /** One conversation per branch, plus main's. */
  conversations: Record<string, Array<Entry>>
}

export type CardKind = "act" | "run" | "home" | "todo" | "branch" | "terminal" | "file" | "diff" | "issue" | "draft" | "flow" | "setup" | "settings" | "proposal" | "review" | "confirm" | "commands" | "members" | "secrets" | "later"
  | "form"
  | "wiki"

/*
 * A run, inside (Will, 2026-10-02): what Inspect opens. One TODO attempt is
 * one durable run of the TODO flow (mvp.md B.4): Plan to Propose, then a
 * wait for merge that a rebase loops back to Verify. A cheap model splits
 * each step into phases by what the agent is doing and writes each phase's
 * title; every cell the agent writes carries a plain explanation of what it
 * did. Indicators flag thrashing (the same failure repeated with no new idea),
 * waits and failures. A phase can hold subagents, each with its own summary.
 */
export interface Cell {
  readonly id: string
  /** rebase: main or an earlier item moved, and the run went back to Verify. */
  readonly kind: "context" | "read" | "edit" | "run" | "think" | "ask" | "steer" | "subagent" | "rebase"
  /** What the agent did, in plain words: written for a person, not a log. */
  readonly explain: string
  /** The words as the agent said them (its whole question), shown in the detail pane. */
  readonly quote?: string
  readonly code?: string
  readonly output?: ReadonlyArray<string>
  readonly tone?: "ok" | "fail" | "wait"
  readonly took?: string
  readonly tokens?: string
  readonly who?: ActorId
  readonly seq?: number
}

export interface Phase {
  readonly id: string
  /** The flow step the phase belongs to (plan, implement, verify, review, propose). */
  readonly step: string
  readonly title: string
  readonly summary: string
  /** Seconds spent in the phase; a step's time is its phases' sum. */
  took?: number
  /** thrash: the same failure repeated; wait: blocked on a person; fail: where the attempt stopped. */
  tone?: "thrash" | "wait" | "live" | "ok" | "fail"
  indicator?: string
  cells: Array<Cell>
}

export interface Trace {
  readonly id: string
  readonly title: string
  readonly todo?: string
  /** A TODO's attempts are separate runs of it; Retry starts attempt n + 1 beside the old one. */
  readonly attempt: number
  readonly branch: string
  /** held: proposed, and waiting for rebase, steer and merge signals; it holds no machine. */
  state: "running" | "waiting" | "held" | "merged" | "failed"
  held?: { readonly since: string }
  phases: Array<Phase>
}

/*
 * A✓ (mvp.md Appendix B): asked to start, change or stop work, the app agent
 * posts one confirmation, and only the person who asked can press it. Reads
 * and the asker's own screen changes run at once and never post one.
 */
export interface Act {
  readonly id: string
  /** Who asked: the only person who can press it. */
  readonly by: ActorId
  /** The primary button's verb: "Steer", "Run review", "Stop", "Open terminal", "Save". */
  readonly verb: string
  /** What it acts on, as the card names it: "T9 retry-webhooks", "Payments testing". */
  readonly target: string
  /** The exact words it will send, if any. */
  readonly text?: string
  /** The receipt once pressed: "Steered T9". */
  readonly receipt: string
  state: "asked" | "done" | "cancelled"
  seq?: number
}

/* The review flow's result (/review, mvp.md Appendix A): a verdict and findings anyone can act on. */
export interface Review {
  readonly id: string
  readonly branch: string
  readonly by: ActorId
  readonly verdict: "clean" | "changes"
  readonly findings: ReadonlyArray<{ readonly severity: "blocker" | "fix" | "note"; readonly path: string; readonly line: number; readonly text: string }>
}

/* A learning run's suggested improvement, backed by the team's own runs. */
export interface Proposal {
  readonly id: string
  readonly title: string
  readonly evidence: string
  readonly refs: ReadonlyArray<number>
  todo?: string
}

export interface CardRef {
  readonly id: string
  readonly kind: CardKind
  /** The world object the card projects (a TODO id, branch id, path, …). */
  readonly target: string
  /** Card-local view state that would live in the card payload in the app. */
  view?: string
  /** States reel only: render this card as another member sees it. */
  as?: ActorId
}

/*
 * A notification is a timeline entry, never a floating toast (Will,
 * 2026-10-02): it records what happened, keeps its one action while that
 * still applies, and stays in the history once acknowledged.
 */
export interface Event {
  readonly id: string
  readonly kind: "event"
  tone: "running" | "ok" | "failed" | "attention"
  title: string
  detail?: string
  action?: string
  secondary?: string
  /** Set once the person acted on it or moved on: its action and highlight go away. */
  acked?: boolean
  /** The person hid its notification; the timeline entry keeps its action. */
  hidden?: boolean
  seq: number
}

export type Entry =
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | { readonly id: string; readonly kind: "agent"; readonly text: string; readonly context?: ReadonlyArray<string> }
  | { readonly id: string; readonly kind: "card"; readonly card: CardRef }
  | Event

/*
 * Conversations belong to branches (Will, 2026-10-02): each branch is one
 * conversation, shared by everyone on it, and main's is the team's long one.
 * A person is somewhere in the branch tree (`at`); `transcript` reads that
 * branch's conversation. Scroll position and card views stay per person.
 */
export interface Viewer {
  readonly id: ActorId
  /** The conversation this person is in: "main" or a branch id. */
  at: string
  /** This person's view of each card (a tab, an open menu): never shared. */
  views: Record<string, string>
  /** The entry this person last jumped to; their screen scrolls there. */
  reveal?: { readonly id: string; readonly seq: number }
  /** A window outside the app (J1's Mac terminal), drawn over this screen by the harness. */
  outside?: { readonly title: string; lines: Array<string>; readonly bare?: boolean }
  /** The entries of the conversation this person is in (an accessor over world.conversations). */
  transcript: Array<Entry>
  composerOpen: boolean
  draft: string
  /** The card shown maximized: the same component, larger, with Restore (the embed law). */
  maximized?: string
  /** This person's own theme: the app agent can switch it, and it changes no one else's screen. */
  theme?: "light" | "dark"
  /** The app lost its install: it says so once and keeps showing what it last knew. */
  connection?: "reconnecting"
  /** In a maximized run, the cell selected for detail. */
  selected?: string
  /** The card whose input this person is driving (the control-focus spotlight). */
  focus?: string
  /** The branch tree is open over the crumbs (mvp.md B.1): this person's own popover. */
  tree?: boolean
  /** The one-time browser-notification ask, at this person's first Needs you (mvp.md §6.4). */
  notifyAsk?: "open" | "allowed"
}

export interface State {
  world: World
  viewers: Record<ActorId, Viewer>
  /** Increments once per applied step, so a component can tell what just changed. */
  seq: number
}

/* ── Lookups ─────────────────────────────────────────────── */

/** The author of a change no single session can claim (mvp.md M-27, §16). */
export const OUTSIDE = "outside"

/** The stack service, "the agent in charge of jj" (mvp.md M-32): every fork, place, reorder, rebase and merge is its act. */
export const STACK = "smithers"

export const AGENT = "agent"

/* "ben~smithers" is Ben's app agent acting for him; "ben~claude" is Claude Code in Ben's terminal. */
const VIA_NAMES: Record<string, string> = { smithers: "Smithers", claude: "Claude Code", codex: "Codex", ssh: "SSH" }
export const via = (who: ActorId): { readonly person: ActorId; readonly agent: string } | undefined => {
  const [person, agent] = who.split("~")
  return agent === undefined || person === undefined ? undefined : { person, agent: VIA_NAMES[agent] ?? agent }
}
export const isAgent = (who: ActorId): boolean => who === AGENT || who.startsWith("agent:") || (via(who) !== undefined && !who.endsWith("~ssh"))

/** A TODO's reference; one the journey didn't set explicitly gets a stable number from its place in the world. */
export const refOf = (world: World, todo: Todo): string => todo.ref ?? `T${20 + world.todos.indexOf(todo)}`

export const member = (world: World, who: ActorId): Member | undefined => world.members.find(each => each.id === (via(who)?.person ?? who))

/** Merging is for maintainers and the owner (mvp.md M-05). */
export const canMerge = (world: World, who: ActorId): boolean => {
  const role = member(world, who)?.role
  return role === "owner" || role === "maintainer"
}
export const todo = (world: World, id: string): Todo => must(world.todos.find(each => each.id === id), `todo ${id}`)
export const branch = (world: World, id: string): Branch => must(world.branches.find(each => each.id === id), `branch ${id}`)
export const terminal = (world: World, id: string): Terminal => must(world.terminals.find(each => each.id === id), `terminal ${id}`)
export const file = (world: World, path: string): FileDoc => must(world.files.find(each => each.path === path), `file ${path}`)
export const issue = (world: World, number: number): Issue => must(world.issues.find(each => each.number === number), `issue #${number}`)
export const viewer = (state: State, id: ActorId): Viewer => must(state.viewers[id], `viewer ${id}`)

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`mock world has no ${what}`)
  return value
}

/* ── Mutations journeys use ──────────────────────────────── */

let entryCounter = 0
const nextId = (prefix: string): string => `${prefix}-${++entryCounter}`
export const resetIds = (): void => { entryCounter = 0 }

export const say = (state: State, who: ActorId, text: string): void => {
  const view = viewer(state, who)
  view.transcript.push({ id: nextId("user"), kind: "user", text })
  view.draft = ""
  view.composerOpen = false
}

/** The app agent answers; `context` is what its preflight pulled in for this answer (files, wiki pages, TODOs, runs). */
export const reply = (state: State, who: ActorId, text: string, context?: ReadonlyArray<string>): void => {
  viewer(state, who).transcript.push({ id: nextId("agent"), kind: "agent", text, ...(context === undefined ? {} : { context }) })
}

export const showCardAs = (state: State, who: ActorId, kind: CardKind, target: string, as: ActorId, view?: string): void => {
  const screen = viewer(state, who)
  screen.transcript.push({ id: nextId("card"), kind: "card", card: { id: `${kind}:${target}:${as}`, kind, target, as, ...(view === undefined ? {} : { view }) } })
}

/*
 * Show a card in the conversation this person is in. A conversation holds one
 * card per object: showing it again doesn't add or move it for everyone, it
 * jumps this person's screen to it. `view` is this person's view of the card.
 */
export const showCard = (state: State, who: ActorId, kind: CardKind, target: string, view?: string): string => {
  const screen = viewer(state, who)
  const id = `${kind}:${target}`
  if (view !== undefined) screen.views = { ...screen.views, [id]: view }
  const existing = screen.transcript.find(entry => entry.kind === "card" && entry.card.id === id)
  if (existing !== undefined) {
    screen.reveal = { id: existing.id, seq: state.seq }
    return id
  }
  const entry = nextId("card")
  screen.transcript.push({ id: entry, kind: "card", card: { id, kind, target } })
  /* A card shown to this person is where they now are; others in the conversation keep their own place. */
  screen.reveal = { id: entry, seq: state.seq }
  return id
}

/** Move a person to another branch's conversation in the tree. */
export const navigate = (state: State, who: ActorId, at: string): void => {
  const screen = viewer(state, who)
  state.world.conversations[at] ??= at === "main" ? [] : [{ id: nextId("card"), kind: "card", card: { id: `branch:${at}`, kind: "branch", target: at } }]
  screen.at = at
  screen.reveal = undefined
}

/** Add or update (by title) a notification in a person's timeline. */
export const toast = (state: State, who: ActorId, value: { readonly tone: Event["tone"]; readonly title: string; readonly detail?: string; readonly action?: string; readonly secondary?: string }): void => {
  const screen = viewer(state, who)
  const existing = screen.transcript.find((entry): entry is Event => entry.kind === "event" && entry.title === value.title)
  if (existing !== undefined) {
    Object.assign(existing, { tone: value.tone, detail: value.detail, action: value.action, secondary: value.secondary, acked: false, seq: state.seq })
    return
  }
  screen.transcript.push({ id: nextId("event"), kind: "event", seq: state.seq, ...value })
}

/** Work that was running finished: its entry settles in place (a new title and detail), never left spinning. */
export const settle = (state: State, who: ActorId, running: string, value: { readonly title: string; readonly detail?: string; readonly tone?: Event["tone"] }): void => {
  const entry = viewer(state, who).transcript.find((each): each is Event => each.kind === "event" && each.title === running)
  if (entry === undefined) return
  Object.assign(entry, { title: value.title, tone: value.tone ?? "ok", detail: value.detail, action: undefined, seq: state.seq })
}

/** The person moved on: every notification keeps its place in the history but loses its action and highlight. */
export const dismissToasts = (state: State, who: ActorId): void => {
  for (const entry of viewer(state, who).transcript) if (entry.kind === "event") entry.acked = true
}

export const activity = (state: State, branchId: string, who: ActorId, kind: Activity["kind"], text: string, tone?: Activity["tone"], github?: boolean): void => {
  branch(state.world, branchId).activity.push({ id: nextId("act"), who, kind, text, seq: state.seq, ...(tone === undefined ? {} : { tone }), ...(github ? { github } : {}) })
}

/*
 * One grouped entry for a burst of outside writes, never one per file. It opens the diff. It names who only when
 * theirs was the only session running a command on the branch; otherwise it reads "Changed outside Smithers".
 */
export const changed = (state: State, branchId: string, who: ActorId | undefined, files: number): void => {
  branch(state.world, branchId).activity.push({ id: nextId("act"), who: who ?? OUTSIDE, kind: "change", text: "", files, seq: state.seq })
}

/** The stack service did a stack operation on this branch, on its own or because someone asked. */
export const stackOp = (state: State, branchId: string, text: string, asked?: ActorId): void => {
  branch(state.world, branchId).activity.push({ id: nextId("act"), who: STACK, kind: "step", text, tone: "ok", seq: state.seq, ...(asked === undefined ? {} : { asked }) })
}

/** The coding agent read files (B.3 read, ls, glob, grep): one line, each file opening the File card. */
export const read = (state: State, branchId: string, who: ActorId, paths: ReadonlyArray<string>): void => {
  branch(state.world, branchId).activity.push({ id: nextId("act"), who, kind: "read", text: "", items: paths, seq: state.seq })
}

/** What the coding agent's preflight put in its context (B.3 memory, recall): the Context line. */
export const context = (state: State, branchId: string, who: ActorId, items: ReadonlyArray<string>): void => {
  branch(state.world, branchId).activity.push({ id: nextId("act"), who, kind: "context", text: "", items, seq: state.seq })
}

/* ── A✓ confirmations ────────────────────────────────────── */

/** The app agent posts a confirmation in the asker's conversation; nothing happens until they press it. */
export const ask = (state: State, who: ActorId, act: Omit<Act, "by" | "state" | "seq">): void => {
  state.world.acts.push({ ...act, by: who, state: "asked", seq: state.seq })
  showCard(state, who, "act", act.id)
}

/** The asker pressed it: the card becomes its receipt. */
export const pressed = (state: State, id: string): void => {
  const act = must(state.world.acts.find(each => each.id === id), `act ${id}`)
  act.state = "done"
  act.seq = state.seq
}

export const present = (state: State, branchId: string, who: ActorId, where: Where): void => {
  const target = branch(state.world, branchId)
  const existing = target.presence.find(each => each.who === who)
  if (existing === undefined) target.presence.push({ who, where })
  else existing.where = where
}

export const leave = (state: State, branchId: string, who: ActorId): void => {
  const target = branch(state.world, branchId)
  target.presence = target.presence.filter(each => each.who !== who)
}

export const print = (state: State, terminalId: string, lines: ReadonlyArray<string | [string, TermLine["tone"]]>): void => {
  const target = terminal(state.world, terminalId)
  for (const line of lines) {
    const [text, tone] = typeof line === "string" ? [line, undefined] : line
    target.lines.push({ text, seq: state.seq, ...(tone === undefined ? {} : { tone }) })
  }
}

export const run = (state: State, value: Omit<BackgroundRun, "seq">): void => {
  const existing = state.world.runs.find(each => each.id === value.id)
  if (existing === undefined) state.world.runs.push({ ...value, seq: state.seq })
  else Object.assign(existing, value)
}

/** Put a member (or agent) in a file at a line, as the editor's name flag shows it. */
export const openFile = (state: State, path: string, who: ActorId, line: number): void => {
  const doc = file(state.world, path)
  doc.editors = [...(doc.editors ?? []).filter(each => each.who !== who), { who, line }]
}

export const edit = (state: State, path: string, n: number, text: string, by: ActorId): void => {
  const line = file(state.world, path).lines.find(each => each.n === n)
  if (line === undefined) throw new Error(`no line ${n} in ${path}`)
  line.was = line.was ?? line.text
  line.text = text
  line.by = by
  line.seq = state.seq
}

/** A push or a rebase makes a new revision (mvp.md §4.2): checks rerun on it, and any approval no longer applies. */
export const revise = (state: State, id: string, rev: string): void => {
  const item = todo(state.world, id)
  if (item.evidence === undefined) return
  item.evidence = { ...item.evidence, rev, checks: item.evidence.checks.map(check => ({ name: check.name, state: "running" as const })), github: { passed: 0, total: item.evidence.github.total } }
  if (item.approvedRev !== undefined) item.approvalCleared = true
  item.seq = state.seq
}

/** Every check passed on the current revision. */
export const checksPassed = (state: State, id: string, took: Record<string, string> = {}): void => {
  const item = todo(state.world, id)
  if (item.evidence === undefined) return
  item.evidence = { ...item.evidence, checks: item.evidence.checks.map(check => ({ ...check, state: "passed" as const, ...(took[check.name] === undefined ? {} : { took: took[check.name] }) })), github: { passed: item.evidence.github.total, total: item.evidence.github.total } }
  item.seq = state.seq
}

export const setTodo = (state: State, id: string, patch: Partial<Todo>): void => {
  Object.assign(todo(state.world, id), patch, { seq: state.seq })
}

/* ── Wiki (mvp.md §6.11, J8) ─────────────────────────────── */

/*
 * A wiki page: one Markdown file in the repository's vault, which Obsidian on
 * the install's Mac opens through a folder sync. People and agents co-edit it
 * live, the way the File card co-edits code (M-02). A burst of edits saves as
 * the next revision once it settles, and a plan cites the revision it read.
 */
export interface WikiPage {
  readonly id: string
  readonly title: string
  /** The latest revision: r1 is the page as first written. */
  rev: number
  /** Who wrote the latest revision. */
  authors: Array<ActorId>
  /** The Markdown, one block per entry; `was` and `by` mark what the latest revision changed. */
  readonly lines: Array<CodeLine>
  /** Who is in the page, and the block each is on. */
  editors?: Array<{ readonly who: ActorId; line: number }>
  /** A decision a learning run wrote: its blocks, its author and the change it came from. */
  readonly decision?: { readonly from: number; readonly to: number; readonly by: ActorId; readonly change: number }
  /** Plans that cited the page, with the revision each read (planning records it, §6.11). */
  cited?: Array<{ readonly todo: string; readonly rev: number; readonly seq: number }>
  /** The step that saved the latest revision. */
  seq: number
}

export const wikiPage = (world: World, id: string): WikiPage => must(world.wiki.find(each => each.id === id), `wiki page ${id}`)

/** Put someone in a page on a block, as their margin flag shows it. */
export const wikiOpen = (state: State, id: string, who: ActorId, line: number): void => {
  const page = wikiPage(state.world, id)
  page.editors = [...(page.editors ?? []).filter(each => each.who !== who), { who, line }]
}

/** A live, attributed edit to one block; its first edit since the latest revision keeps the text that revision saved. */
export const wikiEdit = (state: State, id: string, n: number, text: string, by: ActorId): void => {
  const page = wikiPage(state.world, id)
  const line = page.lines.find(each => each.n === n)
  if (line === undefined) throw new Error(`no block ${n} in ${page.title}`)
  if ((line.seq ?? -1) <= page.seq) line.was = line.text
  line.text = text
  line.by = by
  line.seq = state.seq
}

/** The burst settled: it saves as the next revision, by everyone who changed a block in it. */
export const wikiSave = (state: State, id: string): void => {
  const page = wikiPage(state.world, id)
  page.authors = [...new Set(page.lines.flatMap(line => (line.seq ?? -1) > page.seq && line.by !== undefined ? [line.by] : []))]
  page.rev += 1
  page.seq = state.seq
}
