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
  /** Their permission on the repository on GitHub. Adding them defaults the role from it (mvp.md §6.15): admin or maintain makes a Maintainer, write a Member. */
  permission?: "admin" | "maintain" | "write"
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
  /** The agent's review is running again on this revision; until it finishes, the last one is only history. */
  readonly reviewing?: boolean
  /** The last revision's review, kept as history while the new revision's runs. */
  readonly previous?: { readonly rev: string; readonly review: string }
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
  /* J5 · teach the factory (mvp.md §6.12) */
  /** The name of the flow version its attempt runs ("v1"), shown beside its steps; set with `steps`. */
  flowVersion?: string
}

export type MachineState = "awake" | "asleep" | "waking" | "waiting" | "closed"

export type Where =
  | { readonly kind: "terminal"; readonly id: string; readonly watching?: boolean }
  | { readonly kind: "file"; readonly path: string; readonly line?: number }
  /** Reading without editing: Smithers answering a question, a reviewer (M-34). */
  | { readonly kind: "reading"; readonly path: string; readonly line?: number }
  | { readonly kind: "step"; readonly step: string }
  | { readonly kind: "branch" }

/*
 * Everyone and everything on a branch (mvp.md §6.8, M-34): people, the
 * branch's coding agent, and agents acting for a person ("Claude Code for Ben"
 * in his terminal, "Smithers for Ben" from his chat). Each shows where it is.
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
  /** The foreground program's own input prompt (Claude Code's ">"), drawn in place of the shell prompt while it runs. */
  prompt?: string
  lines: Array<TermLine>
  watchers: Array<ActorId>
  /** A system package the session needed (no sudo on machines): offered as a reviewed image change. */
  offer?: string
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
  /** Its TODO fixes it, so merging that TODO closes it: the Draft's "Closes #n when merged" box, which the `todo` label also sets (mvp.md J2.6). Unset, the TODO is only related, and the issue stays open. */
  fixes?: boolean
  /** A member labeled it `todo` on GitHub, which committed its title and body as a TODO (mvp.md J2.2). */
  labeled?: { readonly by: ActorId; readonly age: string }
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
  /** Its author, the only person who sees it until Commit (spec §14.5.1). */
  readonly by?: ActorId
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
  /* J5 · learning is a real run (mvp.md §4.1, B.5) */
  /** The merged TODO a learning run learns from. */
  readonly todo?: string
  /** Its place in the machine queue while it waits to start: Queued, not yet working. */
  queue?: number
  /** The wiki pages a finished learning run wrote, by id. */
  lessons?: ReadonlyArray<string>
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
  /* J5 · teach the factory (mvp.md §6.12) */
  /** Who proposed it: "maya~smithers" for the app agent acting for Maya, the stack service for a learning run's suggestion. */
  readonly by?: ActorId
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
   * Model access (mvp.md §6.5; Will, 2026-10-03). The fast model runs the app
   * agent and timeline summaries: Cerebras, through Smithers' own
   * infrastructure, so the install signs in to a Smithers account instead of
   * taking a key. The coding model and the AI Gateway are the team's own keys
   * (BYOK): each validates before it is saved, and a failed key keeps its
   * field open with its provider's reason. Without the Smithers sign-in, the
   * app agent falls back to the coding model.
   */
  smithers?: "connecting" | "connected" | "failed"
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
  /** GitHub's app-manifest flow created the install's App; the owner signs in through it next (mvp.md J1.2). */
  appCreated?: boolean
  /*
   * An address change in Settings that failed to apply (mvp.md §6.1): the
   * address in effect when it was tried, the one the owner set, and why. The
   * old address stays in effect, and Retry tries the new one again. Once
   * another address is in effect, the failed change no longer shows.
   */
  addressChange?: { readonly from: string; readonly to: string; readonly reason: string }
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
  /* J11 · under the hood (mvp.md §6.14) */
  /** The agents behind the TODO flow's steps; absent until a journey shows one. */
  agents?: Array<FactoryAgent>
}

export type CardKind = "act" | "run" | "home" | "todo" | "branch" | "terminal" | "file" | "diff" | "issue" | "draft" | "flow" | "setup" | "settings" | "proposal" | "review" | "confirm" | "commands" | "members" | "secrets" | "later"
  | "form"
  | "wiki"
  | "agent"

/*
 * A run, inside (Will, 2026-10-02): what Inspect opens. One TODO attempt is
 * one durable run of the TODO flow (mvp.md B.4): Plan to Propose, then a
 * wait for merge that a rebase loops back to Verify. Each step splits into
 * phases at deterministic boundaries, each titled from the step and what it
 * recorded ("Ran tests · 1 failed ×3"); the fast model writes a one-line
 * summary under the title and a plain explanation of every cell the agent
 * did. Indicators flag thrashing (the same check failed 3 times with no edit
 * in between to a file the failure names, engineering spec §11.6.4), waits
 * and failures. Review's phase holds its reviewers, each reporting in one line.
 */
export interface Cell {
  readonly id: string
  /**
   * rebase: main or an earlier item moved, and the run went back to Verify. reviewer: one of Review's lenses.
   * answer: a person's answer to the agent's question, which settles the wait; a steer never does.
   */
  readonly kind: "context" | "read" | "edit" | "run" | "think" | "ask" | "answer" | "steer" | "reviewer" | "rebase"
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
  /** thrash: the same check failed 3 times, nothing it names edited in between; wait: blocked on a person; fail: where the attempt stopped. */
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
  /* J11 · under the hood (mvp.md §6.14) */
  /** The steps of the flow version it runs, when it is no TODO's: a test run of an edited flow. */
  readonly steps?: ReadonlyArray<FlowStep>
  /** Each step's typed input and output, and the model its agent ran on, by step id. */
  readonly io?: Readonly<Record<string, StepIO>>
}

/* ── J11 · under the hood (mvp.md §6.14) ─────────────────── */

/** One step as the monitor shows it: what it was given and returned, as typed fields, and the model its agent ran on. */
export interface StepIO {
  readonly input: ReadonlyArray<readonly [string, string]>
  readonly output: ReadonlyArray<readonly [string, string]>
  readonly model?: string
}

/*
 * An agent the factory uses (mvp.md §6.14; Will, 2026-10-02). Its
 * instructions are a Markdown file in the repository, which also holds its
 * tools and permissions; changing it is a TODO like any change. Its model is
 * the owner's setting and applies at once.
 */
export interface FactoryAgent {
  readonly id: string
  /** The TODO flow steps it works. */
  readonly steps: ReadonlyArray<string>
  readonly instructions: string
  model: string
  /** The owner's last change, kept on the Agent card as its receipt. */
  changed?: { readonly from: string; readonly by: ActorId; readonly seq: number }
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
  /** The TODO it would change: everyone sees that TODO read "Needs Ben" until he presses it (product, 2026-10-02). */
  readonly todo?: string
  /** The agent asking for him (ConfirmModel.asked_by): "Claude Code for Ben"; the app agent when unset. */
  readonly asker?: ActorId
  state: "asked" | "done" | "cancelled"
  seq?: number
}

/* The review flow's result (/review, mvp.md Appendix A): a verdict and findings anyone can act on. */
export interface Review {
  readonly id: string
  readonly branch: string
  readonly by: ActorId
  readonly verdict: "clean" | "changes"
  readonly findings: ReadonlyArray<{ readonly severity: "blocker" | "fix" | "note"; readonly path: string; readonly line: number; readonly text: string; acted?: "fix" | "not-useful" }>
  /** The revision it read. */
  readonly rev?: string
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
  /** A prompt in a shared branch conversation carries its author (Astra r2 M1). */
  | { readonly id: string; readonly kind: "user"; readonly text: string; readonly by?: ActorId; readonly origin?: string }
  /** Smithers' answer, and who asked (it reads "Smithers for Ben" to everyone else). */
  | { readonly id: string; readonly kind: "agent"; readonly text: string; readonly context?: ReadonlyArray<string>; readonly for?: ActorId
      /** An external agent's turn (M-38): its author, and where it ran ("terminal 1"). */
      readonly by?: ActorId; readonly origin?: string }
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
export const isAgent = (who: ActorId): boolean => who === AGENT || who === STACK || who.startsWith("agent:") || (via(who) !== undefined && !who.endsWith("~ssh"))

/*
 * Smithers is one participant (M-34): the app agent on the fast model and the
 * stack service are both "Smithers". Acting for a person it is "Smithers for
 * Ben" ("ben~smithers"), never Ben with a badge.
 */
export const isSmithers = (who: ActorId): boolean => who === STACK || who.endsWith("~smithers")
export const forWhom = (who: ActorId): ActorId | undefined => who.endsWith("~smithers") ? who.slice(0, -"~smithers".length) : undefined

/** A TODO's reference; one the journey didn't set explicitly gets a stable number from its place in the world. */
export const refOf = (world: World, item: Todo): string => {
  if (item.ref !== undefined) return item.ref
  const top = Math.max(0, ...world.todos.flatMap(each => each.ref === undefined ? [] : [Number(each.ref.slice(1))]))
  return `T${top + 1 + world.todos.filter(each => each.ref === undefined).indexOf(item)}`
}

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
  view.transcript.push({ id: nextId("user"), kind: "user", text, by: who })
  view.draft = ""
  view.composerOpen = false
}

/*
 * An external agent's conversation in a branch terminal, imported read-only
 * into the branch's shared conversation (M-38, spec §14.5.5): the prompt names
 * the session owner, the turn names the agent participant, and neither has a
 * control to answer, steer, retry or resend.
 */
export const imported = (state: State, branchId: string, by: ActorId, kind: "user" | "agent", text: string, origin: string): void => {
  const conversation = state.world.conversations[branchId] ??= []
  conversation.push(kind === "user"
    ? { id: nextId("user"), kind: "user", text, by, origin }
    : { id: nextId("agent"), kind: "agent", text, by, origin })
}

/** The app agent answers; `context` is what its preflight pulled in for this answer (files, wiki pages, TODOs, runs). */
export const reply = (state: State, who: ActorId, text: string, context?: ReadonlyArray<string>): void => {
  viewer(state, who).transcript.push({ id: nextId("agent"), kind: "agent", text, for: who, ...(context === undefined ? {} : { context }) })
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

/** Who a TODO waits on for a private confirmation, if anyone: the card is the asker's, the wait is everyone's to see. */
export const waitingOn = (world: World, id: string): ActorId | undefined => world.acts.find(each => each.todo === id && each.state === "asked")?.by

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
/*
 * A new revision: every check runs again on it, and when the code changed (a
 * commit, a person's push, a resolved conflict) the review does too; a clean
 * rebase reruns checks only (spec §10.4.1). The old review stays only as
 * history; nothing from the old revision counts for the new one (§4.2, §6.10).
 */
export const revise = (state: State, id: string, rev: string, change: "code" | "clean-rebase" = "code"): void => {
  const item = todo(state.world, id)
  if (item.evidence === undefined) return
  const { previous, ...old } = item.evidence
  /*
   * A clean rebase changes no code: only the checks run again, and the earlier review stands, shown with the
   * revision it read (same patch-id, §10.4.3). New code (a commit, a resolved conflict) is reviewed again, and
   * the earlier review is not shown.
   */
  const clean = change === "clean-rebase"
  item.evidence = {
    ...old, rev, reviewing: !clean || old.reviewing === true,
    checks: old.checks.map(check => ({ name: check.name, state: "running" as const })),
    github: { passed: 0, total: old.github.total },
    ...(!clean || old.reviewing === true || old.rev === undefined ? {} : { previous: { rev: previous?.rev ?? old.rev, review: old.review } })
  }
  if (item.approvedRev !== undefined) item.approvalCleared = true
  item.seq = state.seq
}

/** Every check passed on the current revision. A new review replaces the earlier one; without one, a clean rebase's earlier review stands. */
export const checksPassed = (state: State, id: string, took: Record<string, string> = {}, review?: string): void => {
  const item = todo(state.world, id)
  if (item.evidence === undefined) return
  const { previous, reviewing: _reviewing, ...rest } = item.evidence
  item.evidence = {
    ...rest, review: review ?? rest.review,
    checks: rest.checks.map(check => ({ ...check, state: "passed" as const, ...(took[check.name] === undefined ? {} : { took: took[check.name] }) })),
    github: { passed: rest.github.total, total: rest.github.total },
    ...(review === undefined && previous !== undefined ? { previous } : {})
  }
  item.seq = state.seq
}

/* ── Merge readiness: one rule for every card ───────────── */

/*
 * Whether this TODO can merge now, and if not, the one reason: spec §10.6.2a's
 * MergeReady, whose first failing row gives the reason. The Home row, the
 * TODO card and Review & merge all read it, so no card offers a merge another
 * would refuse. Role is not a row: the authorizer leaves Merge out for a
 * member (canMerge), who sees the same reason. Rows the mock doesn't model
 * (fence, pending work, stale head) are left out; only required GitHub
 * checks block (row 9).
 */
export type MergeReadiness =
  | { readonly state: "ready" }
  | { readonly state: "done" }
  | { readonly state: "waiting" | "blocked"; readonly reason: string; readonly github?: boolean
      /** A failed check: ember, not gold (engineering, G12). Gold is only for a person who must act. */
      readonly failed?: boolean }

export const openItems = (world: World): ReadonlyArray<Todo> =>
  world.stack.map(id => todo(world, id)).filter(each => each.state !== "merged" && each.state !== "dropped")

export const mergeReadiness = (world: World, item: Todo): MergeReadiness => {
  if (item.state === "merged") return { state: "done" }
  const evidence = item.evidence
  /* Row 1, state: in review, with no open wait. */
  if (item.state !== "in-review" || evidence === undefined) {
    return item.state === "needs-you" || item.state === "paused"
      ? { state: "blocked", reason: item.state === "paused" ? "Paused" : "Needs you" }
      : { state: "waiting", reason: "Not in review yet" }
  }
  /* Row 2, order: the first unmerged item. */
  const open = openItems(world)
  const prior = open[open.indexOf(item) - 1]
  if (prior !== undefined) return { state: "waiting", reason: `Merges after ${refOf(world, prior)}` }
  /* Rows 5–6, rechecking: this revision is not accepted until its checks and review finish on the machine. */
  const on = evidence.rev === undefined ? "" : ` on ${evidence.rev}`
  const failed = evidence.checks.find(check => check.state === "failed")?.name
  if (failed !== undefined) return { state: "blocked", reason: `${failed} failed${on}`, failed: true }
  if (evidence.checks.some(check => check.state === "running")) return { state: "waiting", reason: `Checks running${on}` }
  if (evidence.reviewing === true) return { state: "waiting", reason: `Review running${on}` }
  /* Row 9: required GitHub checks, then GitHub's own answer. */
  if (evidence.github.failing !== undefined) return { state: "blocked", reason: `${evidence.github.failing} failed`, github: true, failed: true }
  if (evidence.github.passed < evidence.github.total) return { state: "waiting", reason: "GitHub checks running", github: true }
  if (item.mergeBlock !== undefined) return { state: "blocked", reason: item.mergeBlock, github: true }
  return { state: "ready" }
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
