/*
 * The States reel: every card state a journey may pass too quickly to study,
 * one per step (mvp.md §4.1, §6.3, §6.7, §6.8, M-02, M-18, M-27). Ben's screen,
 * a maintainer; one card renders as Alice, a member, sees it.
 */
import { cite, type Journey, type Step } from "../journey"
import { activity, changed, OUTSIDE, setTodo, showCard, showCardAs, stackOp, toast, type State, type Todo } from "../world"
import { ALICE, BEN, MAYA, RETRY_FILE, seedState, TODO_FLOW } from "./seed"

const EVIDENCE: NonNullable<Todo["evidence"]> = {
  files: 3, added: 31, removed: 12,
  checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "58s" }, { name: "lint", state: "passed", took: "8s" }],
  github: { passed: 5, total: 5 }, review: "No blocking issues."
}

const todos: ReadonlyArray<Todo> = [
  { id: "s-merged", title: "Send one password reset email", owner: MAYA, branch: "s-b-merged", state: "merged", pr: 233, lessons: 2, issue: 231, prompt: "",
    amendments: [{ by: BEN, text: "Keep the v2 subject line." }], evidence: EVIDENCE },
  { id: "s-next", title: "Upgrade the Stripe SDK to v17", owner: MAYA, branch: "s-b-next", state: "in-review", pr: 88, prompt: "", approvedRev: "1b2c3d4",
    evidence: { ...EVIDENCE, rev: "9e8f7a6" } },
  { id: "s-after", title: "Retry failed webhooks with backoff", owner: BEN, branch: "s-b-after", state: "in-review", pr: 214, prompt: "", evidence: EVIDENCE },
  { id: "s-moved", title: "Sign webhook payloads", owner: MAYA, branch: "s-b-ext", state: "needs-you", needs: "moved_off", step: "implement", prompt: "",
    question: { text: "Maya moved this branch off its item with a checkout over SSH." } },
  { id: "s-blocked", title: "Rotate the webhook signing secret", owner: ALICE, branch: "s-b-blocked", state: "in-review", pr: 219, prompt: "", evidence: EVIDENCE, mergeBlock: "1 approving review required on GitHub" },
  { id: "s-redcheck", title: "Retry Slack notifications", owner: MAYA, branch: "s-b-redcheck", state: "in-review", pr: 224, prompt: "",
    evidence: { ...EVIDENCE, rev: "77c01d2", github: { passed: 4, total: 5, failing: "lint (required)" } } },
  { id: "s-stale", title: "Drop the legacy mailer", owner: ALICE, branch: "s-b-stale", state: "in-review", pr: 226, prompt: "", approvedRev: "1b2c3d4",
    evidence: { ...EVIDENCE, rev: "9e8f7a6" } },
  { id: "s-cleared", title: "Move retry limits to config", owner: BEN, branch: "s-b-cleared", state: "in-review", pr: 221, prompt: "", evidence: EVIDENCE, approvalCleared: true },
  { id: "s-conflict", title: "Rename deliver to deliverEvent", owner: BEN, branch: "s-b-conflict", state: "needs-you", needs: "conflict", step: "implement", prompt: "",
    question: { text: "Rebasing onto #88 conflicts in src/webhooks/retry.ts lines 4–9. I can't resolve it safely." } },
  { id: "s-needs", title: "Add an index for webhook lookups", owner: ALICE, branch: "s-b-needs", state: "working", step: "implement", prompt: "",
    question: { text: "Postgres or the read replica for the migration?", answer: { by: BEN, text: "Postgres. The replica is read-only." }, late: { by: ALICE, text: "The replica, it" } } },
  { id: "s-ask", title: "Paginate GET /invoices", owner: MAYA, branch: "s-b-ask", state: "needs-you", needs: "question", step: "verify", prompt: "",
    question: { text: "Keep the page size at 50, or let callers choose up to 200?" } },
  { id: "s-push", title: "Cache exchange rates", owner: BEN, branch: "s-b-push", state: "needs-you", needs: "foreign_push", pushedBy: ALICE, step: "review", pr: 228, prompt: "",
    question: { text: "Alice pushed 4c1e2d9 to smithers/cache-rates on GitHub." } },
  { id: "s-working", title: "Fix the flaky checkout test", owner: ALICE, branch: "s-b-working", state: "working", step: "verify", prompt: "", elapsed: "9m" },
  { id: "s-paused", title: "Split the billing module", owner: MAYA, branch: "s-b-paused", state: "paused", step: "implement", prompt: "" },
  { id: "s-failed", title: "Upgrade Node to 24", owner: BEN, branch: "s-b-failed", state: "failed", step: "verify", prompt: "",
    failure: "pnpm test exited 1: 3 snapshot tests changed",
    steps: TODO_FLOW.map(step => step.id === "verify" ? { ...step, detail: "Run typecheck only." } : { ...step }) },
  { id: "s-queued", title: "Log every webhook retry attempt", owner: MAYA, branch: "s-b-queued", state: "queued", queue: 1,
    prompt: "Log each retry attempt with the event id, attempt number and delay." },
  { id: "s-dropped", title: "Try a second queue for retries", owner: BEN, branch: "s-b-dropped", state: "dropped", prompt: "Superseded by Retry failed webhooks with backoff." },
  { id: "s-via", ref: "T14", title: "Store each webhook attempt", owner: ALICE, branch: "s-b-via", state: "merged", pr: 244, prompt: "", mergedVia: "s-carrier" },
  { id: "s-carrier", ref: "T15", title: "Show webhook attempts in the dashboard", owner: BEN, branch: "s-b-carrier", state: "merged", pr: 245, prompt: "", lessons: 1 }
]

const setup = (): State => {
  const state = seedState([BEN])
  const { world } = state
  world.todos = todos.map(each => structuredClone(each))
  world.stack = todos.map(each => each.id)
  world.mergedSinceLook = 3
  world.syncedAgo = 360
  world.capacity = 4  // three awake or waking branches, and the running wiki refresh holds the fourth (M-06)
  const place = (id: string, name: string, machine: "awake" | "asleep" | "waking" | "waiting" | "closed", item?: string) =>
    world.branches.push({ id, name, from: item ?? "main", machine, presence: [], activity: [], terminals: [], ...(item === undefined ? {} : { item }) })
  place("s-b-merged", "send-one-reset-email", "closed", "s-merged")
  place("s-b-next", "upgrade-stripe", "asleep", "s-next")
  place("s-b-after", "retry-webhooks", "asleep", "s-after")
  place("s-b-blocked", "rotate-signing-secret", "asleep", "s-blocked")
  place("s-b-ask", "paginate-invoices", "asleep", "s-ask")
  place("s-b-push", "cache-rates", "asleep", "s-push")
  place("s-b-redcheck", "retry-slack", "asleep", "s-redcheck")
  place("s-b-stale", "drop-legacy-mailer", "asleep", "s-stale")
  place("s-b-cleared", "retry-limits-config", "asleep", "s-cleared")
  place("s-b-conflict", "rename-deliver", "asleep", "s-conflict")
  place("s-b-needs", "webhook-index", "asleep", "s-needs")
  place("s-b-working", "fix-checkout-race", "awake", "s-working")
  place("s-b-paused", "split-billing", "asleep", "s-paused")
  place("s-b-failed", "node-24", "asleep", "s-failed")
  place("s-b-queued", "log-retries", "waiting", "s-queued")
  place("s-b-dropped", "second-queue", "closed", "s-dropped")
  place("s-b-waking", "retry-limits-config", "waking", "s-cleared")
  world.branches = world.branches.filter(each => each.id.startsWith("s-b-"))
  world.branches.push({ id: "s-b-scratch", name: "ben/retry-experiment", from: "s-b-after", machine: "asleep", terminals: [], presence: [], activity: [] })
  world.branches.push({ id: "s-b-ext", name: "sign-webhooks", item: "s-moved", from: "main", machine: "awake", terminals: [],
    presence: [{ who: `${MAYA}~ssh`, where: { kind: "file", path: RETRY_FILE, line: 2 } }, { who: ALICE, where: { kind: "file", path: RETRY_FILE, line: 10 } }],
    activity: [], movedOff: { by: `${MAYA}~ssh`, item: "s-moved" } })
  world.runs = [
    { id: "r-learn", title: "Learning from #233", state: "done", detail: "2 lessons" },
    { id: "r-wiki", title: "Wiki refresh", state: "running" },
    { id: "r-release", title: "release-notes", state: "failed", detail: "GitHub API rate limited" }
  ]
  world.terminals.push({ id: "s-t-ben", branch: "s-b-after", title: "terminal 2", owner: BEN, running: "pnpm dev", watchers: [ALICE],
    lines: [{ text: "ben@retry-webhooks $ pnpm dev", tone: "dim", seq: 0 }, { text: "api listening on :4000", seq: 0 }] })
  world.files.push({ path: "src/webhooks/deliver.ts", branch: "s-b-after", lines: [{ n: 1, text: "export { deliverEvent } from \"./retry\"" }], gone: { kind: "renamed", by: `${MAYA}~ssh`, to: "src/webhooks/deliver-event.ts" } })
  world.files.push({ path: "src/webhooks/legacy.ts", branch: "s-b-after", lines: [{ n: 1, text: "// legacy mailer" }], gone: { kind: "deleted", by: `${MAYA}~ssh` } })
  world.files.push({ path: "src/config/retry.ts", branch: "s-b-after",
    lines: [{ n: 1, text: "export const RETRY_LIMIT = 5" }, { n: 2, text: "export const RETRY_CAP_MS = 60_000" }, { n: 3, text: "export const RETRY_JITTER = 0.2" }],
    editors: [{ who: ALICE, line: 2 }, { who: BEN, line: 2 }] })
  /* A save from outside while Alice and Ben type in the same file (B.4 file.compare). */
  world.files.push({ path: "src/webhooks/backoff.ts", branch: "s-b-after",
    lines: [{ n: 1, text: "export const backoff = (attempt: number): number =>" }, { n: 2, text: "  Math.min(60_000, 1_000 * 2 ** attempt)" }, { n: 3, text: "export const MAX_ATTEMPTS = 5", by: ALICE, was: "export const MAX_ATTEMPTS = 3", seq: 0 }],
    editors: [{ who: ALICE, line: 3 }, { who: BEN, line: 1 }], outside: { line: 3, text: "export const MAX_ATTEMPTS = 4" } })
  /* An outside burst's diff (B.4 file.restore). */
  world.files.push({ path: "src/webhooks/format.ts", branch: "s-b-after",
    lines: [{ n: 1, text: "export const formatEvent = (event: WebhookEvent) =>", by: OUTSIDE, was: "export const formatEvent = (event:WebhookEvent)=>", seq: 0 }, { n: 2, text: "  `${event.type} ${event.id}`" }] })
  world.members.push({ id: "sam", name: "Sam Kim", login: "sam-k", initials: "SK", lane: 3, role: "member", needsAccess: true })
  world.members.push({ id: "lee", name: "Lee Ross", login: "leeross", initials: "LR", lane: 5, role: "member", suspended: true })
  /* Roles defaulted from GitHub permission when each was added (mvp.md §6.15): maintain made Ben a Maintainer, write made Alice and Lee Members. */
  world.members = world.members.map(each => each.id === BEN ? { ...each, permission: "maintain" as const } : each.id === ALICE || each.id === "lee" ? { ...each, permission: "write" as const } : each)
  world.secrets = [{ name: "STRIPE_TEST_KEY", scope: "all branches" }, { name: "SENTRY_DSN", scope: "main only" }]
  world.flowVersions = [
    { id: "v-prev", label: "flows/todo/flow.ts · previous", state: "active", steps: TODO_FLOW.map(step => ({ ...step })) },
    { id: "v-sync", label: "flows/todo/flow.ts · merged #241", state: "merged-syncing", steps: [...TODO_FLOW.map(step => ({ ...step })), { id: "changelog", title: "Changelog" }] },
    { id: "v-bad", label: "flows/todo/flow.ts · merged #242", state: "merged-failed", steps: TODO_FLOW.map(step => ({ ...step })), error: "flows/todo/flow.ts:8: verify expects a list of commands" }
  ]
  showCard(state, BEN, "home", "acme/api")
  return state
}

const view = (caption: string, act: (state: State) => void, hold = 3000): Step => ({ caption, hold, act })

export const states: Journey = {
  id: "states",
  title: "States",
  spec: "§4.1",
  intro: "Every state a card can be in, one per step. Step with → to study each.",
  viewers: [BEN],
  setup,
  steps: cite(["§4.1", "§4.2", "§6.4", "§4.1", "§4.1", "§4.1", "§4.2", "J10.3", "J10.3", "§4.1", "B.4", "§4.2", "§6.3", "§4.2", "§6.10", "§6.10", "M-05", "§4.1", "§6.3", "§6.7", "M-06", "§6.7", "§6.7", "J7.3", "B.4", "B.4", "B.4", "§6.8", "B.4", "B.4", "M-18", "B.2", "§6.4", "§6.3", "§6.3", "§6.12", "M-30", "§6.7", "§6.15", "§6.15", "§6.1", "J1.2", "§6.1", "§6.4"], [
    view("The stack in every state: waiting for a machine, working, needs you, a conflict to resolve, paused, failed, in review, merged with lessons, dropped. Sync is stale, in gold, with Retry.", () => {}, 4200),
    view("Each row's ⋯ menu reorders: Move up, Move down, Drop. Alt+↑ and Alt+↓ do the same from the keyboard.", state => { showCard(state, BEN, "home", "acme/api", "menu:s-failed") }),
    view("Background runs sit under the stack. A failed run stays, with Retry and Dismiss, until someone acts.", state => { showCard(state, BEN, "home", "acme/api", "") }),
    view("Queued: waiting for a machine, with its place. The prompt can still be edited.", state => { showCard(state, BEN, "todo", "s-queued") }),
    view("Needs you, a question: Answer, right on the card.", state => { showCard(state, BEN, "todo", "s-ask") }),
    view("Answered while Alice was still typing: the first accepted answer settled it. She sees the receipt, and her draft stays behind Send as steer.", state => { showCardAs(state, BEN, "todo", "s-needs", ALICE) }),
    view("Needs you, a conflict the agent can't resolve safely: no answer field, just Resolve, which opens the branch.", state => { showCard(state, BEN, "todo", "s-conflict") }),
    view("Needs you, a push from a laptop: Bring in Alice's commit, or Discard it. Anyone can bring it in; only a maintainer discards.", state => {
      activity(state, "s-b-push", ALICE, "step", "Pushed 4c1e2d9 to smithers/cache-rates", undefined, true)
      showCard(state, BEN, "todo", "s-push")
    }),
    view("Ben discards it. The agent's held push goes ahead, and Alice's commit is kept in the branch history, as its activity says.", state => {
      setTodo(state, "s-push", { state: "in-review", needs: undefined, pushedBy: undefined, question: undefined, step: undefined })
      stackOp(state, "s-b-push", "Discarded Alice's commit 4c1e2d9 · kept in history", BEN)
      showCard(state, BEN, "branch", "s-b-push")
    }),
    view("Paused: someone pressed Stop. Resume queues it again, and it continues from the last finished step.", state => { showCard(state, BEN, "todo", "s-paused") }),
    view("Failed: the step and its reason. Retry queues a new attempt on the flow it started with; the flow changed since, so Retry with the current flow appears.", state => { showCard(state, BEN, "todo", "s-failed") }),
    view("In review, not next: Merge waits for the item before it.", state => { showCard(state, BEN, "todo", "s-after") }),
    view("In review, blocked on GitHub: GitHub's own reason replaces the Merge label.", state => { showCard(state, BEN, "todo", "s-blocked") }),
    view("In review after a rebase: the revision changed, so the earlier approval no longer applies.", state => { showCard(state, BEN, "todo", "s-cleared") }),
    view("A required GitHub check failed on this revision: it is named, it links to its details, and Merge waits.", state => { showCard(state, BEN, "todo", "s-redcheck") }),
    view("Ben approved an earlier revision of the next item. Review & merge names both and asks him to review the new one.", state => { showCard(state, BEN, "confirm", "s-next") }),
    view("A member's view of the next item: no Merge, just who can.", state => { showCardAs(state, BEN, "todo", "s-next", ALICE) }),
    view("Merged: done. Its lessons and its amendment history stay on the card.", state => { showCard(state, BEN, "todo", "s-merged") }),
    view("Merged out of order: T15 merged on GitHub before T14, and its commit carried T14's change. T14 is Merged too.", state => { showCard(state, BEN, "todo", "s-via") }),
    view("A sleeping branch reads from stored state and is dimmed. Reading never wakes it.", state => { showCard(state, BEN, "branch", "s-b-paused") }),
    view("Waiting for a machine: the branch's place in the one queue.", state => { showCard(state, BEN, "branch", "s-b-queued") }),
    view("Waking: a person's action took the next free machine.", state => { showCard(state, BEN, "branch", "s-b-waking") }),
    view("Closed: its item merged, its machine is gone, and the record stays. Fork starts again from here.", state => { showCard(state, BEN, "branch", "s-b-merged") }),
    view("A scratch branch. Add to stack makes its whole change a new TODO, after the item it forked from or at the end.", state => { showCard(state, BEN, "branch", "s-b-scratch", "add") }),
    view("Outside changes: one grouped entry opens the diff. A checkout that moved the branch off its item makes the item Needs you; Return is the decision.", state => {
      changed(state, "s-b-ext", undefined, 3)
      showCard(state, BEN, "branch", "s-b-ext", "ssh")
    }, 3600),
    view("A file deleted while open: Restore.", state => { showCard(state, BEN, "file", "src/webhooks/legacy.ts") }),
    view("A file renamed while open: Follow.", state => { showCard(state, BEN, "file", "src/webhooks/deliver.ts") }),
    view("Two people on the same line: both edits apply as they type, like a shared document, and each flag shows who is there.", state => { showCard(state, BEN, "file", "src/config/retry.ts") }),
    view("A save from outside Smithers lands while Alice and Ben type. Their edits stay; Compare shows the outside version beside the live one.", state => { showCard(state, BEN, "file", "src/webhooks/backoff.ts", "compare") }),
    view("The diff an outside change opens has one action: Restore this file, recorded as Ben's edit.", state => { showCard(state, BEN, "diff", "src/webhooks/format.ts", "outside") }),
    view("Ben's terminal with Alice watching. Only its owner types; others watch.", state => { showCard(state, BEN, "terminal", "s-t-ben") }),
    view("Agents can't merge. When Claude Code tries, the person gets Review & merge in their timeline, bound to what they review.", state => {
      toast(state, BEN, { tone: "attention", title: "Claude Code wants to merge #88", action: "Review & merge" })
    }),
    view("The connection to the install drops: the screen says so once and keeps what it last knew. Nothing is lost.", state => { state.viewers[BEN]!.connection = "reconnecting" }),
    view("GitHub refuses the install's credentials: main says so, in place of the sync age, with Fix.", state => {
      state.viewers[BEN]!.connection = undefined
      state.world.mainHealth = { state: "refused", cause: "GitHub App access revoked" }
      showCard(state, BEN, "home", "acme/api")
    }),
    view("GitHub rate-limits the install: main says when it retries.", state => {
      state.world.mainHealth = { state: "limited", cause: "GitHub rate limit", retryAt: "10:42" }
    }),
    view("Flow versions: one waits for sync, one failed to load, and the previous stays Active. Change proposes a fixing TODO; Source opens its file on that TODO's branch.", state => {
      state.world.mainHealth = undefined
      showCard(state, BEN, "flow", "todo", "v-bad")
    }),
    view("A system flow is read-only: no Source, no Change. Only the TODO, learning and review flows, and the repository's own, can be edited.", state => { showCard(state, BEN, "flow", "merge") }),
    view("There is no sudo on a machine. Needing a system package offers a reviewed change to the machine image, which rebuilds after it merges.", state => {
      state.world.terminals.push({ id: "s-t-img", branch: "s-b-after", title: "terminal 4", owner: BEN, watchers: [], offer: "imagemagick",
        lines: [{ text: "ben@retry-webhooks $ sudo apt install imagemagick", tone: "dim", seq: state.seq }, { text: "sudo: not available on Smithers machines", tone: "fail", seq: state.seq }] })
      showCard(state, BEN, "terminal", "s-t-img")
    }),
    view("Members: roles, someone added without write access on GitHub, and someone who lost it.", state => { showCard(state, BEN, "members", "acme/api") }),
    view("Secrets: names only, write-only values, and where each reaches.", state => { showCard(state, BEN, "secrets", "acme/api") }),
    view("Settings for the owner, with the one line that connects a laptop agent.", state => { showCardAs(state, BEN, "settings", "acme/api", MAYA) }),
    { ...view("Setup: Anthropic rejects the coding key. Its field stays open with Anthropic's reason, and nothing saves until a key validates.", state => {
      Object.assign(state.world.setup, { codingKey: "failed", keyError: "Anthropic rejected this key: invalid x-api-key", source: "mirroring", sourcePct: 62, machine: "waiting" })
      delete state.world.setup.gatewayKey
      showCardAs(state, BEN, "setup", "acme/api", MAYA)
      const screen = state.viewers[BEN]!
      screen.reveal = { id: screen.transcript.at(-1)!.id, seq: state.seq }
    }), spec: "§6.5" },
    { ...view("An address change in Settings that doesn't apply: the reason, Retry, and the old address still in effect.", state => {
      Object.assign(state.world.setup, { codingKey: "saved", gatewayKey: "saved", source: "ready", sourcePct: 100, machine: "ready" })
      delete state.world.setup.keyError
      state.world.setup.addressChange = { from: state.world.setup.addresses[0]!, to: "https://smithers.acme.dev", reason: "smithers.acme.dev doesn't reach this Mac" }
      showCardAs(state, BEN, "settings", "acme/api", MAYA)
      const screen = state.viewers[BEN]!
      screen.reveal = { id: screen.transcript.at(-1)!.id, seq: state.seq }
    }), spec: "§6.1" },
    view("On plain HTTP a browser can't notify, so Settings links to the HTTPS docs. An upgrade waits for smthrs host upgrade on the Mac.", state => {
      state.world.setup.addresses = ["http://maya-mini.local:4000"]
      state.world.setup.upgrade = "1.0.1"
      showCardAs(state, BEN, "settings", "acme/api", MAYA)
    })
  ])
}
