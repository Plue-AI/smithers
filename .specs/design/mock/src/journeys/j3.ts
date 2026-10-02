/*
 * J3. Join a branch (mvp.md §5, P0, multiplayer). Ben's screen on the left,
 * Alice's on the right: one branch, one machine, one working copy. Ben runs
 * the failing test in his own terminal while Alice watches; they type in the
 * same file at the same time; Ben steers; the coding agent's edit arrives
 * live, the way a teammate's does.
 */
import { cite, type Journey } from "../journey"
import { activity, branch, changed, edit, file, leave, navigate, openFile, present, print, reply, say, setTodo, showCard, todo, type State } from "../world"
import { ALICE, BEN, MAYA, RETRY_FILE, seedState } from "./seed"

const AGENT = "agent:b-retry"
const MAYA_SSH = `${MAYA}~ssh`
const T_ALICE = "t-alice"
const T_BEN = "t-ben"
const BEN_TERMINAL = `terminal:${T_BEN}`
const STEER = "Use backoff() from lib/backoff everywhere we sleep before a retry."
/* Smithers answering Alice: a participant on the branch while it reads (M-34). */
const SMITHERS_FOR_ALICE = `${ALICE}~smithers`
const QUESTION = "why does redeliver still wait 30 s?"

const line = (n: number) => `line:${RETRY_FILE}:${n}`

export const j3: Journey = {
  id: "j3",
  title: "Join a branch",
  spec: "J3",
  intro: "Ben and Alice on one branch. Alice is in retry.ts; the coding agent is waiting at Verify for an answer.",
  viewers: [BEN, ALICE],
  setup: () => {
    const state = seedState([BEN, ALICE])
    const { world } = state
    world.terminals.push({ id: T_ALICE, branch: "b-retry", title: "terminal 1", owner: ALICE, running: "pnpm dev", watchers: [],
      lines: [{ text: "alice@retry-webhooks $ pnpm dev", tone: "dim", seq: 0 }, { text: "api listening on :4000", seq: 0 }, { text: "POST /webhooks/stripe 503 · retry in 30000 ms", tone: "dim", seq: 0 }] })
    branch(world, "b-retry").terminals.push(T_ALICE)
    present(state, "b-retry", ALICE, { kind: "file", path: RETRY_FILE, line: 10 })
    openFile(state, RETRY_FILE, ALICE, 10)
    present(state, "b-retry", MAYA_SSH, { kind: "file", path: RETRY_FILE, line: 2 })
    showCard(state, BEN, "home", "acme/api")
    // Alice is in the branch's conversation: its Branch card first, then the file she opened.
    navigate(state, ALICE, "b-retry")
    showCard(state, ALICE, "file", RETRY_FILE)
    return state
  },
  steps: cite(["J3.1", "J3.2", "J3.3", "J3.3", "J3.3", "J3.4", "J3.5", "J3.5", "J3.5", "M-34", "J3.6", "B.3", "§4.2", "§4.1", "B.1"], [
    {
      caption: "Ben sees T9 waiting on a person and opens its branch. A branch is one conversation, shared by everyone on it, and Alice is already here.",
      viewer: BEN, target: '[data-mock="row-t-retry"] [data-mock="branch-chip"]', hold: 2600,
      act: (state: State) => {
        navigate(state, BEN, "b-retry")
        present(state, "b-retry", BEN, { kind: "branch" })
      }
    },
    {
      caption: "The Branch card shows everyone on the branch: Alice editing retry.ts at line 10, Maya in it from Cursor over SSH (her saves appear in open cards as attributed changes), the coding agent at Verify, and now Ben.",
      viewer: BEN, target: '[data-mock="where-alice"]', hover: true, hold: 3000,
      act: () => {}
    },
    {
      caption: "Ben opens his own terminal on the same machine. It runs as Ben, with Ben's logins. It joins the shared conversation below Alice, whose screen stays on her file.",
      viewer: BEN, target: '[data-mock="new-terminal-b-retry"]', hold: 1500,
      act: (state: State) => {
        state.world.terminals.push({ id: T_BEN, branch: "b-retry", title: "terminal 2", owner: BEN, lines: [], watchers: [] })
        branch(state.world, "b-retry").terminals.push(T_BEN)
        showCard(state, BEN, "terminal", T_BEN)
        present(state, "b-retry", BEN, { kind: "terminal", id: T_BEN })
        state.viewers[BEN]!.focus = BEN_TERMINAL
      }
    },
    {
      caption: "He runs the failing test.",
      viewer: BEN, typing: { into: `terminal:${T_BEN}`, text: "pnpm test webhooks" }, hold: 2000,
      act: (state: State) => {
        print(state, T_BEN, [
          ["ben@retry-webhooks $ pnpm test webhooks", "dim"],
          [" FAIL  src/webhooks/retry.test.ts", "fail"],
          ["   ✗ retries a 503 with backoff   5001 ms", "fail"],
          ["     Error: test timed out after 5000 ms", "dim"],
          [" Tests  1 failed · 13 passed", "fail"]
        ])
      }
    },
    {
      caption: "Alice sees Ben's session on the branch and jumps to it to watch. Each screen keeps its own place; Ben sees her watching.",
      viewer: ALICE, target: '[data-mock="where-ben"]', hold: 2200,
      show: [{ viewer: ALICE, target: '[data-mock="card-terminal"]' }],
      act: (state: State) => {
        state.world.terminals.find(each => each.id === T_BEN)!.watchers.push(ALICE)
        branch(state.world, "b-retry").presence.find(each => each.who === ALICE)!.watching = T_BEN
        showCard(state, ALICE, "terminal", T_BEN)
      }
    },
    {
      caption: "Maya runs a formatter over SSH. Twelve files change at once: one grouped entry, \"Maya via SSH changed 12 files\", and the open file updates in place, attributed to her.",
      hold: 3000,
      reveal: [{ viewer: BEN, target: '[data-mock="card-branch"]' }, { viewer: ALICE, target: '[data-mock="card-file"]' }],
      act: (state: State) => {
        edit(state, RETRY_FILE, 1, "import { backoff } from '../lib/backoff'", MAYA_SSH)
        edit(state, RETRY_FILE, 2, "import { post, sleep } from '../lib/http'", MAYA_SSH)
        changed(state, "b-retry", MAYA_SSH, 12)
      }
    },
    {
      caption: "Ben opens retry.ts from Alice's row. The file opens where she is, with her name on line 10.",
      viewer: BEN, target: '[data-mock="where-alice"]', hold: 2200,
      pre: (state: State) => { state.viewers[BEN]!.focus = undefined },
      show: [{ viewer: ALICE, target: '[data-mock="card-file"]' }],
      act: (state: State) => {
        showCard(state, BEN, "file", RETRY_FILE)
        openFile(state, RETRY_FILE, BEN, 8)
        present(state, "b-retry", BEN, { kind: "file", path: RETRY_FILE, line: 8 })
      }
    },
    {
      caption: "They type in the same file at once. Each sees the other's characters arrive live, in the author's colour, with a name flag.",
      viewer: BEN,
      typing: [
        { viewer: BEN, into: line(8), after: "    await sleep(", text: "backoff(attempt))", shared: true },
        { viewer: ALICE, into: line(10), after: "  throw new DeliveryFailed(event.id", text: ", { attempts: 5 })", shared: true }
      ],
      reveal: [{ viewer: BEN, target: '[data-mock="card-file"]' }, { viewer: ALICE, target: '[data-mock="card-file"]' }],
      hold: 2600,
      act: (state: State) => {
        edit(state, RETRY_FILE, 8, "    await sleep(backoff(attempt))", BEN)
        edit(state, RETRY_FILE, 10, "  throw new DeliveryFailed(event.id, { attempts: 5 })", ALICE)
        activity(state, "b-retry", BEN, "edit", "Edited retry.ts line 8")
        activity(state, "b-retry", ALICE, "edit", "Edited retry.ts line 10")
      }
    },
    {
      caption: "There is no Save button. Both edits are already on the machine, so Ben's terminal sees them.",
      viewer: BEN, target: '[data-mock="card-terminal"] .mvp-term', typing: { into: `terminal:${T_BEN}`, text: "pnpm test webhooks" }, hold: 2200,
      pre: (state: State) => { state.viewers[BEN]!.focus = BEN_TERMINAL },
      act: (state: State) => {
        print(state, T_BEN, [
          ["ben@retry-webhooks $ pnpm test webhooks", "dim"],
          [" PASS  src/webhooks/retry.test.ts", "ok"],
          [" Tests  14 passed", "ok"]
        ])
      }
    },
    {
      caption: "Alice asks Smithers. It joins the branch like a teammate: in the list, reading retry.ts, its flag on line 14. Both screens see her question and its answer.",
      spec: "M-34",
      viewer: ALICE, keys: "⌘ K", typing: { viewer: ALICE, into: "composer", text: QUESTION }, hold: 3400,
      pre: (state: State) => { state.viewers[ALICE]!.composerOpen = true },
      show: [{ viewer: BEN, target: '[data-mock="card-branch"]' }, { viewer: ALICE, target: '[data-mock="card-file"]' }],
      act: (state: State) => {
        say(state, ALICE, QUESTION)
        present(state, "b-retry", SMITHERS_FOR_ALICE, { kind: "reading", path: RETRY_FILE, line: 14 })
        openFile(state, RETRY_FILE, SMITHERS_FOR_ALICE, 14)
        reply(state, ALICE, "Line 14: redeliver() still sleeps a fixed 30 s. deliver() already uses backoff().", ["retry.ts", "lib/backoff.ts", "T9 prompt"])
      }
    },
    {
      caption: "The agent is asking, so the branch's input answers it. Ben's answer appears in the activity with his avatar, and the agent continues.",
      viewer: BEN, target: '[data-mock="steer-input-b-retry"]', typing: { into: "steer:b-retry", text: STEER }, hold: 2200,
      pre: (state: State) => { state.viewers[BEN]!.focus = undefined },
      show: [{ viewer: BEN, target: '[data-mock="card-branch"]' }],
      act: (state: State) => {
        leave(state, "b-retry", SMITHERS_FOR_ALICE)
        const doc = file(state.world, RETRY_FILE)
        doc.editors = (doc.editors ?? []).filter(each => each.who !== SMITHERS_FOR_ALICE)
        activity(state, "b-retry", BEN, "answer", STEER)
        const item = todo(state.world, "t-retry")
        item.question = { text: item.question!.text, answer: { by: BEN, text: STEER } }
        setTodo(state, "t-retry", { state: "working", step: "implement" })
        activity(state, "b-retry", AGENT, "step", "Maya via SSH changed retry.ts · re-read it before writing")
        present(state, "b-retry", AGENT, { kind: "file", path: RETRY_FILE, line: 14 })
        openFile(state, RETRY_FILE, AGENT, 14)
      }
    },
    {
      caption: "The coding agent edits the same file the way a teammate does: its flag on line 14, its characters arriving live for both of them.",
      viewer: BEN,
      typing: { viewer: BEN, into: line(14), after: "  await sleep(", text: "backoff(1))", shared: true },
      hold: 2400,
      reveal: [{ viewer: BEN, target: '[data-mock="card-file"]' }, { viewer: ALICE, target: '[data-mock="card-file"]' }],
      act: (state: State) => {
        edit(state, RETRY_FILE, 14, "  await sleep(backoff(1))", AGENT)
        activity(state, "b-retry", AGENT, "edit", "Edited retry.ts line 14", "ok")
      }
    },
    {
      caption: "It reruns the checks on the shared working copy, with everyone's edits in it.",
      hold: 2200,
      act: (state: State) => {
        const doc = file(state.world, RETRY_FILE)
        doc.editors = (doc.editors ?? []).filter(each => each.who !== AGENT)
        setTodo(state, "t-retry", { state: "working", step: "verify" })
        present(state, "b-retry", AGENT, { kind: "step", step: "verify" })
        activity(state, "b-retry", AGENT, "step", "pnpm test webhooks · 14 passed", "ok")
      }
    },
    {
      caption: "Nobody merged anything on the branch. Ben, Alice and the agent shared one working copy, and the TODO moves on to Review.",
      hold: 3000,
      act: (state: State) => {
        setTodo(state, "t-retry", { state: "working", step: "review" })
        present(state, "b-retry", AGENT, { kind: "step", step: "review" })
      }
    },
    {
      caption: "Ben goes back up the tree to main, the team's conversation. Alice stays on the branch.",
      viewer: BEN, target: '[data-mock="crumb-main"]', hold: 3000,
      act: (state: State) => {
        navigate(state, BEN, "main")
        branch(state.world, "b-retry").presence = branch(state.world, "b-retry").presence.filter(each => each.who !== BEN)
      }
    }
  ])
}
