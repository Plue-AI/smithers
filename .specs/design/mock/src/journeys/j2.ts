/*
 * J2. Issue to merged PR, the core loop (mvp.md §5, P0). Maya's screen.
 * An issue becomes a TODO, placed first in the stack; the agent asks one
 * question; the PR opens with evidence; Maya merges; learning follows.
 * Meanwhile the second door (J2.2): Alice labels another issue `todo` on
 * GitHub, and it joins the end of the stack, Queued until a machine frees.
 */
import type { Journey } from "../journey"
import { branch, dismissToasts, issue, present, run, settle, setTodo, showCard, stackOp, toast, todo, type State } from "../world"
import { ALICE, BEN, MAYA, seedState } from "./seed"

const PROMPT = "Password reset sends two emails because both the legacy mailer and the v2 template handle password.reset. Remove the legacy handler, keep v2, and add a test that one reset request sends exactly one email."
const EDIT = " Keep the v2 subject line."
const QUESTION = "Two tests assert the legacy mailer's log line. Delete them, or update them to check the v2 email?"
const ANSWER = "Update them to check the v2 email."

/* The second door: an issue Ben opened, which Alice labels `todo` on GitHub. Its title and body as they are then become the TODO. */
const LABELED = { number: 235, title: "Show the currency on invoice totals", body: "Invoice totals print as 42.00 with no currency, so customers outside the US can't tell what they owe. Show the invoice's currency, e.g. EUR 42.00." }

const setup = (): State => {
  const state = seedState([MAYA])
  const { world } = state
  // A quieter morning than J4: the Stripe upgrade already merged, retry work is in review behind it, and nothing waits.
  world.todos = world.todos.filter(each => each.id !== "t-stripe" && each.id !== "t-log")
  world.stack = ["t-retry", "t-checkout"]
  Object.assign(todo(world, "t-retry"), { state: "in-review", pr: 91, question: undefined, step: undefined, elapsed: undefined,
    evidence: { files: 2, added: 24, removed: 9, checks: [{ name: "test", state: "passed", took: "48s" }], github: { passed: 5, total: 5 }, review: "No blocking issues." } })
  branch(world, "b-retry").machine = "asleep"
  branch(world, "b-retry").presence = []
  world.branches = world.branches.filter(each => each.id !== "b-stripe" && each.id !== "b-log")
  // Two machines on this Mac: T10 holds one, so a second TODO at work fills it.
  world.capacity = 2
  world.mergedSinceLook = 1
  world.issues.push({
    number: 231, title: "Password reset emails arrive twice", author: ALICE, age: "2 h ago", open: true,
    body: "Since Friday's deploy every reset request sends two emails. Some people click the first link, which has already expired.",
    comments: [
      { who: BEN, text: "Both the legacy mailer and the v2 template handle password.reset.", age: "1 h ago" },
      { who: ALICE, text: "v2 has been live for everyone since Friday, so the legacy path can go.", age: "40 min ago" }
    ]
  })
  world.issues.push({ ...LABELED, author: BEN, age: "3 h ago", open: true, comments: [] })
  showCard(state, MAYA, "home", "acme/api")
  return state
}

export const j2: Journey = {
  id: "j2",
  title: "Issue to merged PR",
  spec: "J2",
  intro: "Alice opened an issue on GitHub, and Ben and Alice discussed it there. Maya turns it into work.",
  viewers: [MAYA],
  setup,
  steps: [
    {
      caption: "Maya pulls up the issue with ⌘K and #231.",
      spec: "J2.1", keys: "⌘ K", typing: { into: "composer", text: "#231" }, hold: 1800,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        state.viewers[MAYA]!.composerOpen = false
        showCard(state, MAYA, "issue", "231")
      }
    },
    {
      caption: "Make TODO: the app agent drafts the TODO from the discussion, with Closes #231 when merged checked.",
      spec: "J2.2", target: '[data-mock="make-todo-231"]', hold: 2400,
      act: state => {
        state.world.drafts.push({ id: "d-231", title: "Send one password reset email", prompt: PROMPT, issue: 231, fixes: true, place: { kind: "append" } })
        showCard(state, MAYA, "draft", "d-231")
      }
    },
    {
      caption: "Maya edits the prompt.",
      spec: "J2.2", target: '[data-mock="draft-prompt"]', typing: { into: "draft-prompt:d-231", after: PROMPT, text: EDIT }, hold: 1200,
      act: state => { state.world.drafts.find(each => each.id === "d-231")!.prompt = PROMPT + EDIT }
    },
    {
      caption: "Place defaults to Append, the end of the stack. This bug is urgent, so she places it first.",
      spec: "§4.2", target: '[data-mock="draft-place"]', hold: 2000,
      act: state => { showCard(state, MAYA, "draft", "d-231", "place") }
    },
    {
      caption: "Before T9 Retry failed webhooks: it will merge first.",
      spec: "§4.2", target: '[data-mock="place-before-t-retry"]', hold: 1500,
      act: state => {
        state.world.drafts.find(each => each.id === "d-231")!.place = { kind: "before", id: "t-retry" }
        showCard(state, MAYA, "draft", "d-231", "")
      }
    },
    {
      caption: "Commit puts it on the stack as T12. It is Starting: it gets its own branch, a machine wakes, and the coding agent launches.",
      spec: "J2.3", target: '[data-mock="draft-commit"]', hold: 2200,
      act: state => {
        const { world } = state
        const draft = world.drafts.find(each => each.id === "d-231")!
        world.todos.push({ id: "t-reset", ref: "T12", title: "Send one password reset email", prompt: PROMPT + EDIT, owner: MAYA, branch: "b-reset", state: "starting", issue: 231 })
        world.stack = ["t-reset", ...world.stack]
        world.branches.push({ id: "b-reset", name: "send-one-reset-email", item: "t-reset", from: "main", machine: "waking", presence: [], activity: [], terminals: [] })
        draft.committed = "t-reset"
        Object.assign(issue(world, 231), { todo: "t-reset", fixes: draft.fixes })
        stackOp(state, "b-reset", "Placed T12 before T9", MAYA)
        setTodo(state, "t-reset", {})
        showCard(state, MAYA, "todo", "t-reset")
        toast(state, MAYA, { tone: "running", title: "Waking a machine", detail: "send-one-reset-email" })
      }
    },
    {
      caption: "The machine is awake and the agent starts work, first in the stack. Chat stays free throughout.",
      spec: "J2.3", hold: 2400,
      show: [{ viewer: MAYA, target: '[data-mock="card-home"]' }],
      act: state => {
        branch(state.world, "b-reset").machine = "awake"
        branch(state.world, "b-reset").presence = [{ who: "agent:b-reset", where: { kind: "step", step: "implement" } }]
        setTodo(state, "t-reset", { state: "working", step: "implement", elapsed: "2m" })
        settle(state, MAYA, "Waking a machine", { title: "Machine awake", detail: "send-one-reset-email" })
      }
    },
    {
      caption: "Meanwhile, on GitHub, Alice labels issue #235 todo. Its title and body become T13, at the end of the stack.",
      spec: "J2.2", hold: 2600,
      show: [{ viewer: MAYA, target: '[data-mock="row-t-label"]' }],
      act: state => {
        const { world } = state
        world.todos.push({ id: "t-label", ref: "T13", title: LABELED.title, prompt: LABELED.body, owner: ALICE, branch: "b-label", state: "queued", queue: 1, issue: LABELED.number })
        world.stack = [...world.stack, "t-label"]
        world.branches.push({ id: "b-label", name: "show-invoice-currency", item: "t-label", from: "main", machine: "waiting", waitPosition: 1, presence: [], activity: [], terminals: [] })
        Object.assign(issue(world, LABELED.number), { todo: "t-label", fixes: true, labeled: { by: ALICE, age: "just now" } })
        setTodo(state, "t-label", {})
      }
    },
    {
      caption: "Maya opens #235: Alice's label, then Committed as T13. Both machines are busy, so T13 is Queued.",
      spec: "J2.2", keys: "⌘ K", typing: { into: "composer", text: "#235" }, hold: 2600,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        state.viewers[MAYA]!.composerOpen = false
        showCard(state, MAYA, "issue", String(LABELED.number))
      }
    },
    {
      caption: "The agent asks one question. Maya owns the TODO, so it arrives at the bottom of her timeline with Answer; anyone on its branch would get it too.",
      spec: "J2.4", hold: 2200,
      show: [{ viewer: MAYA, target: '[data-mock="card-todo"]' }],
      act: state => {
        setTodo(state, "t-reset", { state: "needs-you", step: "verify", question: { text: QUESTION }, elapsed: "6m" })
        toast(state, MAYA, { tone: "attention", title: "Send one password reset email asks", detail: QUESTION, action: "Answer" })
        state.viewers[MAYA]!.notifyAsk = "open"
      }
    },
    {
      caption: "It is her first Needs you, so Smithers asks once: notify her when this tab is hidden. She allows it. Needs you, In review and Failed will reach her browser.",
      spec: "§6.4", target: '[data-mock="notify-allow"]', hold: 2600,
      act: state => { state.viewers[MAYA]!.notifyAsk = "allowed" }
    },
    {
      caption: "She answers from the timeline. The first accepted answer settles it, and the agent continues.",
      spec: "J2.4", target: '[data-mock="toast-answer"]', typing: { into: "answer:t-reset", text: ANSWER }, hold: 2000,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => {
        const item = todo(state.world, "t-reset")
        item.question = { text: QUESTION, answer: { by: MAYA, text: ANSWER } }
        setTodo(state, "t-reset", { state: "working", step: "verify", elapsed: "7m" })
      }
    },
    {
      caption: "The PR opens with its evidence: the diff, checks run on the machine, GitHub checks and the agent's review.",
      spec: "J2.5", hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="evidence-t-reset"]' }],
      act: state => {
        setTodo(state, "t-reset", {
          state: "in-review", step: undefined, pr: 233, elapsed: undefined,
          evidence: {
            files: 3, added: 31, removed: 58,
            checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "1m 04s" }, { name: "lint", state: "passed", took: "8s" }],
            github: { passed: 5, total: 5 },
            review: "Removes the legacy handler; one request now sends one email. Two tests updated to the v2 email."
          }
        })
        toast(state, MAYA, { tone: "ok", title: "PR #233 is ready for review" })
      }
    },
    {
      caption: "T12's idle machine sleeps while its PR waits for review. That frees a machine, and T13 is Starting.",
      spec: "§6.7", hold: 2600,
      show: [{ viewer: MAYA, target: `[data-mock="made-${LABELED.number}"]` }],
      act: state => {
        branch(state.world, "b-reset").machine = "asleep"
        branch(state.world, "b-reset").presence = []
        const label = branch(state.world, "b-label")
        label.machine = "waking"
        delete label.waitPosition
        delete todo(state.world, "t-label").queue
        setTodo(state, "t-label", { state: "starting" })
      }
    },
    {
      caption: "T12 is next, so Merge is live, and it records Maya's approval of this exact revision. Closes #231 when merged was checked, so #231 closes.",
      spec: "J2.6", target: '[data-mock="merge-t-reset"]', hold: 2600,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => {
        const reported = issue(state.world, 231)
        setTodo(state, "t-reset", { state: "merged" })
        if (reported.fixes === true) reported.open = false
        branch(state.world, "b-reset").machine = "closed"
        branch(state.world, "b-reset").presence = []
        // Minutes later, T13's agent is past launching.
        branch(state.world, "b-label").machine = "awake"
        present(state, "b-label", "agent:b-label", { kind: "step", step: "plan" })
        setTodo(state, "t-label", { state: "working", step: "plan" })
        run(state, { id: "learn-233", title: "Learning from #233", state: "running" })
        toast(state, MAYA, { tone: "ok", title: "Merged #233", ...(reported.open ? {} : { detail: "Closed #231" }) })
      }
    },
    {
      caption: "Done. A learning run follows and leaves 2 lessons on the merged TODO: wiki pages the next TODO will read.",
      spec: "J2.6", hold: 3400,
      act: state => {
        setTodo(state, "t-reset", { lessons: 2 })
        run(state, { id: "learn-233", title: "Learning from #233", state: "done", detail: "2 lessons" })
      }
    }
  ]
}
