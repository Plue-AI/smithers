/*
 * Ask Smithers: what the app agent itself does (mvp.md §6.5, Appendix A, and
 * Appendix B's A and A✓). Ben asks in plain words. The agent answers, drives
 * his own screen and acts with his authority, as "Smithers for Ben". Reads,
 * wiki writes and his own screen run at once. Committing a TODO and proposing
 * a flow edit wait for his press, and "merge #88" opens his own Review &
 * merge. A slash missing its input opens a form (THE FORM LAW). Work on a
 * machine is the coding agent's, in the agent reel.
 */
import { cite, type Journey, type Step } from "../journey"
import { branch, openFile, present, reply, say, setTodo, showCard, type FlowForm, type State } from "../world"
import { ALICE, BEN, RETRY_FILE, seedState, TODO_FLOW } from "./seed"

const SMITHERS = `${BEN}~smithers`
const CHECKOUT_TEST = "src/checkout/checkout.test.ts"
const ISSUE_TITLE = "Honor Retry-After on webhook 429s"

/** One ⌘K request from Ben: the keys, the typing, then what it does. The agent reel asks the same way. */
export const request = (text: string, caption: string, act: (state: State) => void, extra: Partial<Step> = {}): Step => ({
  caption,
  keys: "⌘ K",
  typing: { into: "composer", text },
  pre: state => { state.viewers[BEN]!.composerOpen = true },
  hold: 2600,
  ...extra,
  act: state => {
    say(state, BEN, text)
    act(state)
  }
})

const issueForm = (state: State): FlowForm => state.world.forms!.find(each => each.id === "f-issue")!

const setup = (): State => {
  const state = seedState([BEN])
  const { world } = state
  world.terminals.push({ id: "t-alice", branch: "b-retry", title: "terminal 1", owner: ALICE, running: "pnpm dev", watchers: [], lines: [] })
  branch(world, "b-retry").terminals.push("t-alice")
  present(state, "b-retry", ALICE, { kind: "file", path: RETRY_FILE, line: 10 })
  openFile(state, RETRY_FILE, ALICE, 10)
  world.files.push({
    path: CHECKOUT_TEST, branch: "b-checkout",
    lines: `import { checkout } from "./checkout"
import { stripe } from "../test/stripe"

test("charges the saved card", async () => {
  const order = await makeOrder({ total: 4200 })
  const result = checkout(order)
  stripe.resolveIntent(order.intent)
  expect(result.status).toBe("paid")
  await result.settled
})`.split("\n").map((text, index) => ({ n: index + 1, text }))
  })
  world.flowVersions = [{ id: "v-active", label: "Built-in · used by every TODO", state: "active", steps: TODO_FLOW.map(step => ({ ...step })) }]
  showCard(state, BEN, "home", "acme/api")
  return state
}

export const askSmithers: Journey = {
  id: "ask",
  title: "Ask Smithers",
  spec: "Appendix A",
  intro: "Ben asks the app agent in plain words. It answers and acts for him as \"Smithers for Ben\"; some acts wait for his yes.",
  viewers: [BEN],
  setup,
  steps: cite(["A", "B.1", "B.1", "B.2", "B.2", "§6.5", "B.2", "B.2", "J2.2", "B.2", "M-05", "J5.1", "B.1"], [
    request("/help", "/help lists every command. Each one also works as a plain request and as a button on its card.", state => {
      showCard(state, BEN, "commands", "all")
    }, { hold: 3400 }),
    request("/issue.new", "A command missing its input opens a form for exactly the missing fields, never a usage line.", state => {
      ;(state.world.forms ??= []).push({
        id: "f-issue", title: "New issue", submit: "Open on GitHub",
        fields: [{ id: "title", label: "Title", value: "", required: true }, { id: "body", label: "Body", value: "", multiline: true }]
      })
      state.viewers[BEN]!.focus = showCard(state, BEN, "form", "f-issue")
    }),
    {
      caption: "He types a title. The body is optional, so the form is ready.",
      target: '[data-mock="form-f-issue-title"]', typing: { into: "form:f-issue:title", text: ISSUE_TITLE }, hold: 1800,
      act: state => { issueForm(state).fields.find(each => each.id === "title")!.value = ISSUE_TITLE }
    },
    {
      caption: "Open on GitHub runs the flow as Ben, and the form becomes its receipt.",
      target: '[data-mock="form-submit-f-issue"]', hold: 2400,
      act: state => {
        Object.assign(issueForm(state), { receipt: "Opened #234 on GitHub", seq: state.seq })
        state.viewers[BEN]!.focus = undefined
      }
    },
    request("who's on retry-webhooks?", "Reads run at once. The Branch card answers: who is on the branch, and where each one is.", state => {
      showCard(state, BEN, "branch", "b-retry")
    }, { hold: 3000 }),
    request("why is the checkout test flaky?", "A question gets a one-line answer, the context it used, and the lines it rests on.", state => {
      reply(state, BEN, "It checks the status before the payment intent settles.", ["checkout.test.ts", "wiki: Payments testing", "T10 run"])
      showCard(state, BEN, "file", CHECKOUT_TEST, "lines:6-8")
    }, { hold: 3000 }),
    request("save that to the wiki", "Wiki writes run at once, since every page keeps its history. The page is r1, by Smithers for Ben.", state => {
      state.world.wiki.push({
        id: "checkout-test-race", title: "Checkout test race", rev: 1, authors: [SMITHERS], seq: state.seq,
        lines: [
          { n: 1, text: "The checkout test checks the status before the payment intent settles." },
          { n: 2, text: "Code: `checkout.test.ts` lines 6–8" }
        ]
      })
      reply(state, BEN, "Saved to the wiki as Checkout test race.")
      showCard(state, BEN, "wiki", "checkout-test-race")
    }, { hold: 3000 }),
    request("make that a TODO", "Committing a TODO needs Ben's yes. The draft is the confirmation: he can edit and place it first.", state => {
      state.world.drafts.push({ id: "d-race", title: "Await the payment intent in the checkout test", prompt: "In checkout.test.ts, await result.settled before asserting the status, so the test no longer races the payment intent.", fixes: false, place: { kind: "append" } })
      showCard(state, BEN, "draft", "d-race")
    }),
    {
      caption: "Commit. T12 joins the end of the stack and waits for a machine.",
      target: '[data-mock="draft-commit"]', hold: 2200,
      act: state => {
        const { world } = state
        world.todos.push({ id: "t-race", ref: "T12", title: "Await the payment intent in the checkout test", prompt: "In checkout.test.ts, await result.settled before asserting the status.", owner: BEN, branch: "b-race", state: "queued", queue: 2 })
        world.stack.push("t-race")
        world.drafts.find(each => each.id === "d-race")!.committed = "t-race"
        setTodo(state, "t-race", {})
        showCard(state, BEN, "todo", "t-race")
      }
    },
    request("merge #88", "Smithers never merges. It opens Ben's own Review & merge, bound to the revision he sees.", state => {
      showCard(state, BEN, "confirm", "t-stripe")
    }),
    {
      caption: "Ben merges. It merges as Ben, never as an agent.",
      target: '[data-mock="confirm-merge-t-stripe"]', hold: 2000,
      act: state => {
        setTodo(state, "t-stripe", { state: "merged" })
        branch(state.world, "b-stripe").machine = "closed"
      }
    },
    request("add lint to how we do TODOs", "A flow edit is proposed as a draft TODO, with the Flow card's proposed version. Its Commit is the confirmation.", state => {
      const { world } = state
      world.drafts.push({ id: "d-lint", title: "Run lint in the TODO flow's Verify step", prompt: "In flows/todo/flow.ts, run pnpm lint after pnpm test in the Verify step.", fixes: false, place: { kind: "append" } })
      world.flowVersions.push({ id: "v-lint", label: "flows/todo/flow.ts · proposed", state: "proposed",
        steps: TODO_FLOW.map(step => step.id === "verify" ? { ...step, title: "Verify", detail: "pnpm test, then pnpm lint" } : { ...step }) })
      showCard(state, BEN, "flow", "todo", "v-lint")
      showCard(state, BEN, "draft", "d-lint")
    }, { hold: 3200 }),
    request("switch to dark mode", "His own screen changes at once. Ben's theme turns dark, and nobody else's does.", state => {
      state.viewers[BEN]!.theme = "dark"
      reply(state, BEN, "Changed Ben's theme to dark.")
    }, { hold: 2800 })
  ])
}
