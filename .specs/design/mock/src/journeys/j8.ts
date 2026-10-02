/*
 * J8. Memory (mvp.md §5, P0). Maya's screen on the left, Alice's on the
 * right, both in main's conversation. After #214 merges, its learning run
 * writes a wiki page: the decision, its reason and a link to the change.
 * Alice and Maya co-edit the decision live, and it saves as r2. Alice's Slack
 * TODO was queued before the edit; it plans once a machine frees, so its plan
 * cites and follows r2, the page as it is when the plan runs (§6.9, §6.11).
 */
import { cite, type Journey } from "../journey"
import {
  activity, branch, context, navigate, present, read, run, setTodo, settle, showCard, STACK, toast, todo, wikiEdit, wikiOpen, wikiPage, wikiSave,
  type Evidence, type State, type WikiPage
} from "../world"
import { ALICE, BEN, MAYA, seedState } from "./seed"

const PAGE = "webhook-retries"
const LEARNING = "Learning from #214"
const SLACK_AGENT = "agent:b-slack"
/* The decision up to the cap Alice changes, and the reason Maya rewrites. */
const DECIDED = "Retry failed deliveries with `backoff(attempt)`, at most "
const WHY = "Why: "
const REASON = "endpoints go down for hours; Stripe retries for 3 days."

const block = (n: number) => `wiki:${PAGE}:${n}`

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

const setup = (): State => {
  const state = seedState([MAYA, ALICE])
  const { world } = state
  /* A 24 GB Mac runs two machines (M-06). T10 and T11 hold them, so Alice's T12 waits for one. */
  world.capacity = 2
  world.setup = { ...world.setup, memory: "24 GB" }
  /* T8 merged yesterday. T9's PR #214 is green and next to merge; nobody is on its branch, so it holds no machine. */
  world.todos = world.todos.filter(each => each.id === "t-retry" || each.id === "t-checkout")
  Object.assign(todo(world, "t-retry"), { state: "in-review", pr: 214, question: undefined, step: undefined, elapsed: undefined, evidence: PR_214 })
  Object.assign(todo(world, "t-checkout"), { step: "verify", elapsed: "18m" })
  world.todos.push(
    { id: "t-limits", ref: "T11", title: "Rate-limit the public API", owner: BEN, branch: "b-limits", state: "working", step: "implement", elapsed: "9m",
      prompt: "Limit /v1 to 100 requests a minute per API key. Return 429 with Retry-After." },
    { id: "t-slack", ref: "T12", title: "Retry failed Slack notifications", owner: ALICE, branch: "b-slack", state: "queued", queue: 1,
      prompt: "Slack notifications are lost when Slack is down. Retry them the way we retry webhooks." }
  )
  world.stack = ["t-retry", "t-checkout", "t-limits", "t-slack"]
  const retry = branch(world, "b-retry")
  retry.machine = "asleep"
  retry.presence = []
  branch(world, "b-checkout").presence = [{ who: "agent:b-checkout", where: { kind: "step", step: "verify" } }]
  world.branches = world.branches.filter(each => each.id === "b-retry" || each.id === "b-checkout")
  world.branches.push(
    { id: "b-limits", name: "rate-limit-api", item: "t-limits", from: "main", machine: "awake", activity: [], terminals: [],
      presence: [{ who: "agent:b-limits", where: { kind: "step", step: "implement" } }] },
    { id: "b-slack", name: "retry-slack-notifications", item: "t-slack", from: "main", machine: "waiting", waitPosition: 1, presence: [], activity: [], terminals: [] }
  )
  world.files = []
  world.mergedSinceLook = 0
  showCard(state, MAYA, "home", world.repo)
  showCard(state, MAYA, "todo", "t-retry")
  return state
}

export const j8: Journey = {
  id: "j8",
  title: "Memory",
  spec: "J8",
  intro: "Maya and Alice in main's conversation. T9's PR #214 is next to merge, and Alice's Slack TODO waits for a machine.",
  viewers: [MAYA, ALICE],
  setup,
  steps: cite(["J8.1", "J8.1", "J8.1", "J8.1", "J8.2", "J8.2", "J8.2", "§4.1", "J8.3", "J8.3", "J8.3", "§6.11"], [
    {
      caption: "T9 is green and next to merge. Maya merges #214, and a learning run starts in the background.",
      viewer: MAYA, target: '[data-mock="evidence-t-retry"] [data-mock="merge-t-retry"]', hold: 2600,
      act: state => {
        setTodo(state, "t-retry", { state: "merged" })
        branch(state.world, "b-retry").machine = "closed"
        run(state, { id: "learn-214", title: LEARNING, state: "running" })
        toast(state, MAYA, { tone: "running", title: LEARNING })
      }
    },
    {
      caption: "The run settles. It wrote one wiki page from what T9 decided, and the merged TODO shows 1 lesson.",
      hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="lessons-t-retry"]' }, { viewer: ALICE, target: '[data-mock="lessons-t-retry"]' }],
      act: state => {
        state.world.wiki.push(written(state.seq))
        setTodo(state, "t-retry", { lessons: 1 })
        run(state, { id: "learn-214", title: LEARNING, state: "done", detail: "1 lesson" })
        settle(state, MAYA, LEARNING, { title: LEARNING, detail: "Wrote Webhook retries" })
      }
    },
    {
      caption: "The lesson opens the page. It lands in main's conversation, so Alice sees it too.",
      viewer: MAYA, target: '[data-mock="lessons-t-retry"]', hold: 2600,
      act: state => { showCard(state, MAYA, "wiki", PAGE) }
    },
    {
      caption: "The learning run wrote the decision and why, with a link to the change it came from.",
      viewer: MAYA, target: '[data-mock="wiki-change"]', hover: true, hold: 2800,
      act: () => {}
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
      caption: "T10 opens its PR and frees a machine. Alice's T12, queued before the edit, takes it and starts.",
      hold: 2800,
      show: [{ viewer: ALICE, target: '[data-mock="row-t-slack"]' }],
      act: state => {
        setTodo(state, "t-checkout", { state: "in-review", step: undefined, elapsed: undefined, pr: 96, evidence: PR_96 })
        const checkout = branch(state.world, "b-checkout")
        checkout.machine = "asleep"
        checkout.presence = []
        setTodo(state, "t-slack", { state: "working", step: "plan", queue: undefined, elapsed: "0m" })
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
        page.cited = [...page.cited ?? [], { todo: "t-slack", rev: page.rev, seq: state.seq }]
        setTodo(state, "t-slack", { step: "implement", elapsed: "2m" })
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
