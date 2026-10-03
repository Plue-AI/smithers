/*
 * J8. Memory (mvp.md §5, P0). Maya's screen on the left, Alice's on the
 * right, both in main's conversation. Both machines are busy, so when #214
 * merges its learning run queues for one (M-06), and Alice's Slack TODO
 * queues behind it. T10's PR frees a machine; the learning run takes it and
 * writes a wiki page: the decision, its reason and a link to the change.
 * Alice and Maya co-edit the decision live, and it saves as r2. T11's PR
 * frees the next machine, and only then does T12 plan, so its plan cites and
 * follows r2, the page as it is when the plan runs (§6.9, §6.11).
 */
import { cite, type Journey } from "../journey"
import {
  activity, branch, context, navigate, present, read, run, setTodo, showCard, STACK, stackOp, toast, todo, wikiEdit, wikiOpen, wikiPage, wikiSave,
  type Evidence, type State, type Todo, type WikiPage
} from "../world"
import { ALICE, BEN, MAYA, seedState } from "./seed"

const PAGE = "webhook-retries"
const LEARNING = "Learning from #214"
const LEARN = "learn-214"
const SLACK_AGENT = "agent:b-slack"
const DRAFT = "d-slack"
/* The decision up to the cap Alice changes, and the reason Maya rewrites. */
const DECIDED = "Retry failed deliveries with `backoff(attempt)`, at most "
const WHY = "Why: "
const REASON = "endpoints go down for hours; Stripe retries for 3 days."

const block = (n: number) => `wiki:${PAGE}:${n}`

/* Alice's TODO, as the app agent drafted it for her; it is T12 once she commits it. */
const SLACK: Todo = {
  id: "t-slack", ref: "T12", title: "Retry failed Slack notifications", owner: ALICE, branch: "b-slack", state: "queued",
  prompt: "Slack notifications are lost when Slack is down. Retry them the way we retry webhooks."
}

const PR_214: Evidence = {
  rev: "a1f9e33", files: 2, added: 26, removed: 9,
  checks: [{ name: "typecheck", state: "passed", took: "11s" }, { name: "test", state: "passed", took: "47s" }],
  github: { passed: 5, total: 5 }, review: "No blocking issues. Retries stop after the 5th attempt."
}

const PR_96: Evidence = {
  rev: "5c2e7a1", files: 1, added: 9, removed: 4,
  checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "58s" }],
  github: { passed: 5, total: 5 }, review: "The race was an unawaited cart save."
}

/* What the learning run writes after #214: what T9 decided, why, and where it lives in the code. */
const written = (seq: number): WikiPage => ({
  id: PAGE, title: "Webhook retries", rev: 1, authors: [STACK], seq,
  lines: [
    { n: 1, text: `${DECIDED}5 attempts.` },
    { n: 2, text: "Why: a fixed 30 s wait timed out the retry test." },
    { n: 3, text: "Code: `deliver()` and `redeliver()` in `retry.ts`" }
  ],
  decision: { from: 1, to: 2, by: STACK, change: 214 }
})

/* A TODO opened its PR: its idle machine is released for the next in the queue. */
const release = (state: State, id: string, branchId: string, pr: number, evidence?: Evidence): void => {
  setTodo(state, id, { state: "in-review", step: undefined, elapsed: undefined, pr, ...(evidence === undefined ? {} : { evidence }) })
  Object.assign(branch(state.world, branchId), { machine: "asleep", presence: [] })
}

const setup = (): State => {
  const state = seedState([MAYA, ALICE])
  const { world } = state
  /* A 24 GB Mac runs two machines (M-06), and T10 and T11 hold them. */
  world.capacity = 2
  world.setup = { ...world.setup, memory: "24 GB" }
  /* T8 merged yesterday. T9's PR #214 is green and next to merge; nobody is on its branch, so it holds no machine. */
  world.todos = world.todos.filter(each => each.id === "t-retry" || each.id === "t-checkout")
  Object.assign(todo(world, "t-retry"), { state: "in-review", pr: 214, question: undefined, step: undefined, elapsed: undefined, evidence: PR_214 })
  Object.assign(todo(world, "t-checkout"), { step: "verify", elapsed: "18m" })
  world.todos.push(
    { id: "t-limits", ref: "T11", title: "Rate-limit the public API", owner: BEN, branch: "b-limits", state: "working", step: "implement", elapsed: "9m",
      prompt: "Limit /v1 to 100 requests a minute per API key. Return 429 with Retry-After." }
  )
  world.stack = ["t-retry", "t-checkout", "t-limits"]
  const retry = branch(world, "b-retry")
  retry.machine = "asleep"
  retry.presence = []
  branch(world, "b-checkout").presence = [{ who: "agent:b-checkout", where: { kind: "step", step: "verify" } }]
  world.branches = world.branches.filter(each => each.id === "b-retry" || each.id === "b-checkout")
  world.branches.push(
    { id: "b-limits", name: "rate-limit-api", item: "t-limits", from: "main", machine: "awake", activity: [], terminals: [],
      presence: [{ who: "agent:b-limits", where: { kind: "step", step: "implement" } }] }
  )
  /* Alice asked the app agent for her Slack TODO; its draft waits for her Commit. */
  world.drafts.push({ id: DRAFT, title: SLACK.title, prompt: SLACK.prompt, fixes: false, place: { kind: "append" }, by: ALICE })
  world.files = []
  world.mergedSinceLook = 0
  showCard(state, MAYA, "home", world.repo)
  showCard(state, MAYA, "todo", "t-retry")
  showCard(state, ALICE, "draft", DRAFT)
  return state
}

export const j8: Journey = {
  id: "j8",
  title: "Memory",
  spec: "J8",
  intro: "Maya and Alice in main's conversation. T9's PR #214 is next to merge, T10 and T11 hold both machines, and Alice has drafted a Slack TODO.",
  viewers: [MAYA, ALICE],
  setup,
  steps: cite(["M-06", "§4.1", "B.5", "J8.1", "J8.1", "J8.2", "J8.2", "J8.2", "§4.1", "J8.3", "J8.3", "J8.3", "§6.11"], [
    {
      caption: "T9 is green and next to merge. Maya merges #214, and with both machines busy, its learning run queues.",
      viewer: MAYA, target: '[data-mock="evidence-t-retry"] [data-mock="merge-t-retry"]', hold: 2800,
      show: [{ viewer: MAYA, target: `[data-mock="run-${LEARN}"]` }],
      act: state => {
        setTodo(state, "t-retry", { state: "merged" })
        branch(state.world, "b-retry").machine = "closed"
        run(state, { id: LEARN, title: LEARNING, state: "running", queue: 1, todo: "t-retry" })
        toast(state, MAYA, { tone: "running", title: LEARNING, detail: "Queued" })
      }
    },
    {
      caption: "Alice commits her Slack TODO. T12 waits for a machine too, #2, behind the learning run.",
      viewer: ALICE, target: '[data-mock="draft-commit"]', hold: 2800,
      show: [{ viewer: ALICE, target: '[data-mock="row-t-slack"]' }, { viewer: MAYA, target: '[data-mock="row-t-slack"]' }],
      act: state => {
        const { world } = state
        world.todos.push({ ...SLACK, queue: 2, seq: state.seq })
        world.stack.push(SLACK.id)
        world.branches.push({ id: "b-slack", name: "retry-slack-notifications", item: SLACK.id, from: "main", machine: "waiting", waitPosition: 2, presence: [], activity: [], terminals: [] })
        world.drafts.find(each => each.id === DRAFT)!.committed = SLACK.id
        stackOp(state, "b-slack", "Placed T12 after T11", ALICE)
      }
    },
    {
      caption: "T10 opens its PR and releases its machine. The learning run takes it, and T12 moves up to #1.",
      hold: 3000,
      show: [{ viewer: MAYA, target: `[data-mock="run-${LEARN}"]` }, { viewer: ALICE, target: '[data-mock="row-t-slack"]' }],
      act: state => {
        release(state, "t-checkout", "b-checkout", 96, PR_96)
        run(state, { id: LEARN, title: LEARNING, state: "running", queue: undefined })
        toast(state, MAYA, { tone: "running", title: LEARNING, detail: "Working" })
        setTodo(state, SLACK.id, { queue: 1 })
        branch(state.world, "b-slack").waitPosition = 1
      }
    },
    {
      caption: "The learning run writes one wiki page from what T9 decided, and T9's card shows 1 lesson.",
      hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="lessons-t-retry"]' }, { viewer: ALICE, target: '[data-mock="lessons-t-retry"]' }],
      act: state => {
        state.world.wiki.push(written(state.seq))
        setTodo(state, "t-retry", { lessons: 1 })
        run(state, { id: LEARN, title: LEARNING, state: "running", detail: "1 lesson" })
      }
    },
    {
      caption: "The lesson opens the page: the decision, why, and a link to #214. It lands in main's conversation, so Alice sees it too.",
      viewer: MAYA, target: '[data-mock="lessons-t-retry"]', hold: 3200,
      show: [{ viewer: MAYA, target: '[data-mock="wiki-change"]' }, { viewer: ALICE, target: '[data-mock="card-wiki"]' }],
      act: state => { showCard(state, MAYA, "wiki", PAGE) }
    },
    {
      caption: "Alice thinks 5 attempts give up too soon. She clicks into the decision, and her name flag appears on Maya's screen.",
      viewer: ALICE, target: '[data-mock="wiki-line-1"]', hold: 2400,
      act: state => { wikiOpen(state, PAGE, ALICE, 1) }
    },
    {
      caption: "Alice raises the cap to 8 while Maya rewrites the reason. Each sees the other's characters arrive.",
      viewer: MAYA, target: '[data-mock="wiki-line-2"]', hold: 2800,
      pre: state => { wikiOpen(state, PAGE, MAYA, 2) },
      typing: [
        { viewer: ALICE, into: block(1), after: DECIDED, text: "8 attempts.", shared: true },
        { viewer: MAYA, into: block(2), after: WHY, text: REASON, shared: true }
      ],
      act: state => {
        wikiEdit(state, PAGE, 1, `${DECIDED}8 attempts.`, ALICE)
        wikiEdit(state, PAGE, 2, `${WHY}${REASON}`, MAYA)
      }
    },
    {
      caption: "They stop typing, and the page saves as r2, by Alice and Maya. Nobody pressed Save.",
      hold: 2600,
      act: state => {
        wikiSave(state, PAGE)
        wikiPage(state.world, PAGE).editors = []
      }
    },
    {
      caption: "T11 opens its PR and releases the next machine. T12, queued before the edit, takes it and starts.",
      hold: 2800,
      show: [{ viewer: ALICE, target: '[data-mock="row-t-slack"]' }],
      act: state => {
        release(state, "t-limits", "b-limits", 217)
        setTodo(state, SLACK.id, { state: "working", step: "plan", queue: undefined, elapsed: "0m" })
        const slack = branch(state.world, "b-slack")
        slack.machine = "awake"
        slack.waitPosition = undefined
        slack.presence = [{ who: SLACK_AGENT, where: { kind: "step", step: "plan" } }]
        /* Before planning, preflight reads the wiki as it is now. */
        const page = wikiPage(state.world, PAGE)
        context(state, "b-slack", SLACK_AGENT, [`wiki: ${page.title} r${page.rev}`, "slack/notify.ts", "lib/backoff.ts"])
      }
    },
    {
      caption: "Alice opens its branch. The coding agent is at Plan.",
      viewer: ALICE, target: '[data-mock="row-t-slack"] [data-mock="branch-chip"]', hold: 2400,
      act: state => {
        navigate(state, ALICE, "b-slack")
        present(state, "b-slack", ALICE, { kind: "branch" })
      }
    },
    {
      caption: "She opens Context. Preflight gave the agent Webhook retries r2, the revision she and Maya just saved.",
      viewer: ALICE, target: '[data-mock="card-branch"] .mvp-context-toggle', hold: 3000,
      act: state => {
        const preflight = branch(state.world, "b-slack").activity.find(each => each.kind === "context")!
        const screen = state.viewers[ALICE]!
        screen.views = { ...screen.views, [`context:${preflight.id}`]: "open" }
      }
    },
    {
      caption: "The plan cites r2 and follows it: at most 8 attempts, the cap Alice set.",
      hold: 3200,
      show: [{ viewer: ALICE, target: '[data-mock="card-branch"]' }],
      act: state => {
        const page = wikiPage(state.world, PAGE)
        read(state, "b-slack", SLACK_AGENT, ["src/slack/notify.ts", "src/lib/backoff.ts"])
        activity(state, "b-slack", SLACK_AGENT, "step", `Planned: retry with backoff(attempt), at most 8 attempts · ${page.title} r${page.rev}`, "ok")
        page.cited = [...page.cited ?? [], { todo: SLACK.id, rev: page.rev, seq: state.seq }]
        setTodo(state, SLACK.id, { step: "implement", elapsed: "2m" })
        present(state, "b-slack", SLACK_AGENT, { kind: "step", step: "implement" })
      }
    },
    {
      caption: "On Maya's screen, the page records that T12's plan cited r2.",
      viewer: MAYA, target: '[data-mock="wiki-cited-t-slack"]', hover: true, hold: 3000,
      act: () => {}
    }
  ])
}
