/*
 * J7. Plan and fork (mvp.md §5, P0, jj). Ben's screen; he is a maintainer.
 * He places a new TODO before T10 and amends T9 without making a second one.
 * He forks T9's branch, tries another approach by hand, and adds the scratch
 * branch to the stack after T9. The new TODO takes the whole change since T8,
 * so dropping T9 loses nothing. main moves; the rebase waits while Ben is on
 * the branch (§4.2), and the coding agent resolves the one conflict in place.
 * The stack service, "Smithers", does every fork, place, drop and rebase.
 */
import { cite, type Journey } from "../journey"
import { activity, ask, branch, edit, file, leave, navigate, openFile, present, pressed, print, say, setTodo, showCard, stackOp, todo, type State } from "../world"
import { request } from "./ask"
import { BEN, RETRY_FILE, seedState } from "./seed"
import { FORK_REV, HAND, rebaseOnMain, RESOLVED, t9Activity, t9Source, T9_AGENT } from "./j7-data"

const SCRATCH = "b-retry-after"
const SCRATCH_AGENT = `agent:${SCRATCH}`
const SMITHERS = `${BEN}~smithers`
const T12 = "t-clock"
const T13 = "t-retry-after"
const TERMINAL = "term-ben"
const DROP = "drop-t9"
const CLOCK = { title: "Add a fake clock to the test helpers", prompt: "Add a fake clock to test/helpers, so tests can advance time instead of sleeping." }
const JITTER = { title: "Jitter on each retry delay", prompt: "Add up to 20% random jitter to each retry delay." }
const AFTER = {
  title: "Retry webhooks with backoff and Retry-After",
  prompt: "Retry failed deliveries up to 5 times. Wait as long as Retry-After asks; otherwise back off with jitter."
}

const line = (n: number) => `line:${RETRY_FILE}:${n}`

const setup = (): State => {
  const state = seedState([BEN])
  const { world } = state
  // T9 proposed #214, and Alice's review on GitHub sent it back to work.
  Object.assign(todo(world, "t-retry"), { state: "working", step: "implement", pr: 214, question: undefined, elapsed: "24m" })
  const retry = branch(world, "b-retry")
  retry.presence = [{ who: T9_AGENT, where: { kind: "step", step: "implement" } }]
  retry.activity = t9Activity()
  world.files = [{ path: RETRY_FILE, branch: "b-retry", lines: t9Source() }]
  world.drafts.push({ id: "d-clock", ...CLOCK, fixes: false, place: { kind: "append" } })
  showCard(state, BEN, "home", "acme/api")
  say(state, BEN, "add a TODO: a fake clock for the test helpers")
  showCard(state, BEN, "draft", "d-clock", "place")
  return state
}

export const j7: Journey = {
  id: "j7",
  title: "Plan and fork",
  spec: "J7",
  intro: "Ben, a maintainer, has drafted a TODO in main. Place decides where it joins the stack.",
  viewers: [BEN],
  setup,
  steps: cite(["J7.1", "J7.1", "J7.1", "J7.1", "J7.2", "B.1", "J7.2", "J7.2", "J7.2", "J7.3", "J7.3", "J7.3", "J7.3", "J7.4", "J7.4", "J7.4"], [
    {
      caption: "Alice's checkout fix will need a fake clock, so Ben places his TODO before T10.",
      target: '[data-mock="place-before-t-checkout"]', hold: 2200,
      act: state => {
        state.world.drafts.find(each => each.id === "d-clock")!.place = { kind: "before", id: "t-checkout" }
        showCard(state, BEN, "draft", "d-clock", "")
      }
    },
    {
      caption: "Commit puts it on the stack as T12, between T9 and T10. It waits for a machine.",
      target: '[data-mock="draft-commit"]', hold: 2800,
      show: [{ viewer: BEN, target: `[data-mock="row-${T12}"]` }],
      act: state => {
        const { world } = state
        world.todos.push({ id: T12, ref: "T12", ...CLOCK, owner: BEN, branch: "b-clock", state: "queued", queue: 1 })
        world.stack.splice(world.stack.indexOf("t-checkout"), 0, T12)
        world.branches.push({ id: "b-clock", name: "test-clock", item: T12, from: "main", machine: "waiting", waitPosition: 1, presence: [], activity: [], terminals: [] })
        // The machine queue follows the stack, so T11 is now second in line.
        todo(world, "t-log").queue = 2
        branch(world, "b-log").waitPosition = 2
        world.drafts.find(each => each.id === "d-clock")!.committed = T12
        stackOp(state, "b-clock", "Placed T12 before T10", BEN)
        setTodo(state, T12, {})
      }
    },
    request("T9 should also add jitter to each retry delay", "He asks for a follow-up on T9. The app agent drafts it as Amend T9: no new TODO.", state => {
      state.world.drafts.push({ id: "d-jitter", ...JITTER, fixes: false, place: { kind: "amend", id: "t-retry" } })
      showCard(state, BEN, "draft", "d-jitter")
    }, { hold: 2800 }),
    {
      caption: "Commit folds it into T9's prompt. T9 keeps its branch and PR, and its coding agent picks up the change.",
      target: '[data-mock="draft-commit"]', hold: 3000,
      act: state => {
        state.world.drafts.find(each => each.id === "d-jitter")!.committed = "t-retry"
        setTodo(state, "t-retry", { amendments: [{ by: BEN, text: JITTER.prompt }] })
        stackOp(state, "b-retry", "Amended T9's prompt", BEN)
        activity(state, "b-retry", T9_AGENT, "step", "Adding jitter to each retry delay", "run")
        showCard(state, BEN, "todo", "t-retry")
      }
    },
    {
      caption: "T9's row shows +1. Ben opens its branch: the agent has already added the jitter.",
      target: '[data-mock="row-t-retry"] [data-mock="branch-chip"]', hold: 2800,
      act: state => {
        activity(state, "b-retry", T9_AGENT, "edit", `Added jitter to backoff() · ${FORK_REV}`, "ok")
        navigate(state, BEN, "b-retry")
        present(state, "b-retry", BEN, { kind: "branch" })
      }
    },
    {
      caption: "Fork. The stack service makes a scratch branch from T9's current revision, and Ben moves into it.",
      target: '[data-mock="fork"]', hold: 2600,
      act: state => {
        const { world } = state
        world.branches.push({ id: SCRATCH, name: "ben/retry-after", from: "b-retry", machine: "awake", presence: [{ who: BEN, where: { kind: "branch" } }], activity: [], terminals: [] })
        stackOp(state, SCRATCH, `Forked from T9 at ${FORK_REV}`, BEN)
        // The mock keeps one copy of a path, so from here retry.ts is the fork's: T9's revision as forked.
        const forked = file(world, RETRY_FILE)
        world.files = [...world.files.filter(each => each !== forked), { path: RETRY_FILE, branch: SCRATCH, lines: structuredClone(forked.lines) }]
        leave(state, "b-retry", BEN)
        navigate(state, BEN, SCRATCH)
      }
    },
    {
      caption: "The crumbs and the branch tree show where he is: his own scratch branch, off retry-webhooks.",
      target: '[data-mock="crumb-tree"]', hold: 3200,
      act: state => { state.viewers[BEN]!.tree = true }
    },
    {
      caption: "The fork carries T9's work: retry.ts, as T9's coding agent left it.",
      target: '[data-mock="tab-files"]', hold: 2200,
      pre: state => { state.viewers[BEN]!.tree = false },
      act: state => { showCard(state, BEN, "branch", SCRATCH, "files") }
    },
    {
      caption: "He tries another approach by hand: wait as long as the endpoint's Retry-After asks.",
      target: `[data-mock="file-${RETRY_FILE}"]`, hold: 2800,
      typing: { into: line(HAND.line), after: HAND.after, text: HAND.text, shared: true },
      pre: state => {
        showCard(state, BEN, "file", RETRY_FILE)
        openFile(state, RETRY_FILE, BEN, HAND.line)
        present(state, SCRATCH, BEN, { kind: "file", path: RETRY_FILE, line: HAND.line })
      },
      act: state => {
        edit(state, RETRY_FILE, HAND.line, HAND.after + HAND.text, BEN)
        activity(state, SCRATCH, BEN, "edit", `Edited retry.ts line ${HAND.line}`)
      }
    },
    {
      caption: "In his own terminal on the branch, the webhook tests pass.",
      target: `[data-mock="new-terminal-${SCRATCH}"]`, hold: 2600,
      typing: { into: `terminal:${TERMINAL}`, text: "pnpm test webhooks" },
      pre: state => {
        state.world.terminals.push({ id: TERMINAL, branch: SCRATCH, title: "terminal 1", owner: BEN, lines: [], watchers: [] })
        branch(state.world, SCRATCH).terminals.push(TERMINAL)
        const doc = file(state.world, RETRY_FILE)
        doc.editors = (doc.editors ?? []).filter(each => each.who !== BEN)
        present(state, SCRATCH, BEN, { kind: "terminal", id: TERMINAL })
        showCard(state, BEN, "terminal", TERMINAL)
        state.viewers[BEN]!.focus = `terminal:${TERMINAL}`
      },
      act: state => {
        print(state, TERMINAL, [
          ["ben@ben/retry-after $ pnpm test webhooks", "dim"],
          [" PASS  src/webhooks/retry.test.ts", "ok"],
          ["   ✓ waits as long as Retry-After asks", "ok"],
          [" Tests  15 passed", "ok"]
        ])
      }
    },
    {
      caption: "It beats T9's version. Add to stack turns the branch's work into a TODO.",
      target: '[data-mock="add-to-stack"]', hold: 2000,
      pre: state => { state.viewers[BEN]!.focus = undefined },
      act: state => { showCard(state, BEN, "branch", SCRATCH, "add") }
    },
    {
      caption: "New TODO after T9. T13 takes the whole change since T8, so it includes T9's work.",
      target: '[data-mock="add-after"]', hold: 3200,
      act: state => {
        const { world } = state
        world.todos.push({ id: T13, ref: "T13", ...AFTER, owner: BEN, branch: SCRATCH, state: "working", step: "verify" })
        world.stack.splice(world.stack.indexOf("t-retry") + 1, 0, T13)
        // A stack item's branch hangs off main in the tree, so the scratch branch moves there with its item.
        world.branches = world.branches.map(each => each.id === SCRATCH ? { ...each, from: "main", item: T13 } : each)
        present(state, SCRATCH, SCRATCH_AGENT, { kind: "step", step: "verify" })
        stackOp(state, SCRATCH, "Placed T13 after T9", BEN)
        stackOp(state, "b-checkout", "Rebased onto T13")
        setTodo(state, T13, {})
        showCard(state, BEN, "branch", SCRATCH, "")
      }
    },
    request("drop T9", "T9 is now redundant. Ben asks Smithers to drop it, and it asks him to confirm.", state => {
      showCard(state, BEN, "todo", "t-retry")
      ask(state, BEN, { id: DROP, verb: "Drop", target: "T9 retry-webhooks", receipt: "Dropped T9 · #214 closed" })
    }, { hold: 2800 }),
    {
      caption: "⏎ drops T9 and closes #214. Nothing is lost: T13 already has T9's work.",
      target: `[data-mock="act-${DROP}"]`, hover: true, keys: "⏎", hold: 3200,
      act: state => {
        pressed(state, DROP)
        setTodo(state, "t-retry", { state: "dropped", step: undefined, elapsed: undefined })
        const retry = branch(state.world, "b-retry")
        retry.machine = "closed"
        retry.presence = []
        stackOp(state, "b-retry", "Dropped T9 · closed #214", SMITHERS)
        // T13 now sits on T8. Ben is on its branch, so the rebase waits for him (mvp.md §4.2).
        branch(state.world, SCRATCH).rebasePending = "T8"
      }
    },
    {
      caption: "#88 merges on GitHub, and main moves. Ben is on T13's branch, so its rebase waits for him.",
      hold: 3200,
      act: state => {
        const { world } = state
        setTodo(state, "t-stripe", { state: "merged" })
        branch(world, "b-stripe").machine = "closed"
        world.mainHead = { text: "#88 merged · just now", seq: state.seq }
        branch(world, SCRATCH).rebasePending = "main"
        showCard(state, BEN, "branch", SCRATCH)
      }
    },
    {
      caption: "He presses Rebase now, and one line conflicts. T13's coding agent resolves it and shows what it did.",
      target: `[data-mock="rebase-${SCRATCH}"]`, hold: 3800,
      typing: { into: line(RESOLVED.line), after: RESOLVED.after, text: RESOLVED.text, shared: true },
      pre: state => {
        branch(state.world, SCRATCH).rebasePending = undefined
        rebaseOnMain(file(state.world, RETRY_FILE).lines)
        stackOp(state, SCRATCH, "Rebased onto main · 1 conflict in retry.ts", BEN)
        openFile(state, RETRY_FILE, SCRATCH_AGENT, RESOLVED.line)
        present(state, SCRATCH, SCRATCH_AGENT, { kind: "file", path: RETRY_FILE, line: RESOLVED.line })
        // The conflict is in the open file: Ben's screen goes there to watch the agent resolve it.
        showCard(state, BEN, "file", RETRY_FILE)
      },
      act: state => {
        edit(state, RETRY_FILE, RESOLVED.line, RESOLVED.after + RESOLVED.text, SCRATCH_AGENT)
        activity(state, SCRATCH, SCRATCH_AGENT, "edit", `Resolved retry.ts line ${RESOLVED.line}: kept #88's Stripe.Event and backoff(1)`, "ok")
        const doc = file(state.world, RETRY_FILE)
        doc.editors = (doc.editors ?? []).filter(each => each.who !== SCRATCH_AGENT)
        present(state, SCRATCH, SCRATCH_AGENT, { kind: "step", step: "verify" })
        stackOp(state, "b-checkout", "Rebased onto T13")
        showCard(state, BEN, "diff", RETRY_FILE)
      }
    }
  ])
}
