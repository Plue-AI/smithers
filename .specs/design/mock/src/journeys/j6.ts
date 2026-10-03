/*
 * J6. Bring your own agent (mvp.md §5, P0, steps 1–3). Ben's screen on the
 * left, Alice's on the right, both on retry-webhooks. Ben runs Claude Code in
 * his own branch terminal: it comes signed in to Smithers as Ben and acts as
 * "Claude Code for Ben". Its file writes reach the shared working copy the way
 * any terminal's do, and its skill calls (wiki, answer) are Ben's acts, named
 * for the tool, in front of everyone on the branch. It keeps the app agent's
 * rules (Appendix B, X): its follow-up TODO is only proposed, and it reaches
 * the stack when Ben presses Commit on a confirmation nobody else sees. Its
 * conversation shows in the branch's shared chat, read-only (M-38).
 */
import { cite, type Journey } from "../journey"
import { activity, ask, branch, changed, edit, file, imported, leave, navigate, openFile, present, pressed, print, read, setTodo, showCard, stackOp, terminal, todo, viewer, type ActorId, type CardKind, type State } from "../world"
import { ALICE, BEN, RETRY_FILE, seedState } from "./seed"

const CLAUDE = `${BEN}~claude`
const AGENT = "agent:b-retry"
const T_BEN = "t-ben"
const BEN_TERMINAL = `terminal:${T_BEN}`
const ASK = "use backoff() for both retry waits, then answer T9's question"
const ANSWER = "Exponential backoff. Both waits now use backoff()."
const FOLLOW_UP = "add that as a follow-up TODO after T9"
/** The follow-up Claude Code proposes. Committing a TODO is a confirmation only Ben can press (Appendix B, history.todo). */
const T12 = { id: "t-giveup", title: "Test giving up after the fifth attempt", prompt: "Add a test that deliver() marks the event failed after the fifth attempt." }
const COMMIT = "commit-t-giveup"
const ORIGIN = "terminal 1"
const REPLY = "Both retry waits now use backoff(), as the wiki says. Tests pass. Answered T9: exponential backoff."

/* While Claude Code runs it owns the session's input line, so its ">" replaces the shell prompt. */
const foreground = (state: State, running: string | undefined, prompt: string | undefined): void => {
  Object.assign(terminal(state.world, T_BEN), { running, prompt })
}

/* Scroll this person's screen to a card, adding it to the conversation first if it is new. */
const look = (state: State, who: ActorId, kind: CardKind, target: string): void => {
  const id = showCard(state, who, kind, target)
  const entry = viewer(state, who).transcript.find(each => each.kind === "card" && each.card.id === id)
  if (entry !== undefined) viewer(state, who).reveal = { id: entry.id, seq: state.seq }
}

const setup = (): State => {
  const state = seedState([BEN, ALICE])
  present(state, "b-retry", ALICE, { kind: "file", path: RETRY_FILE, line: 10 })
  openFile(state, RETRY_FILE, ALICE, 10)
  present(state, "b-retry", BEN, { kind: "branch" })
  navigate(state, BEN, "b-retry")
  navigate(state, ALICE, "b-retry")
  // The branch's conversation: its Branch card, T9 waiting on its question, and the file Alice has open.
  showCard(state, ALICE, "todo", "t-retry")
  showCard(state, ALICE, "file", RETRY_FILE)
  return state
}

export const j6: Journey = {
  id: "j6",
  title: "Bring your own agent",
  spec: "J6",
  intro: "Ben and Alice are on retry-webhooks. T9's coding agent is waiting on a question, and Alice has retry.ts open.",
  viewers: [BEN, ALICE],
  setup,
  steps: cite(["J6.1", "J6.1", "M-38", "J6.2", "J6.2", "J6.3", "J6.2", "§6.13", "B.2", "J6.3", "B.1"], [
    {
      caption: "Ben opens his own terminal on the branch. It runs as Ben, already signed in to Smithers as him.",
      viewer: BEN, target: '[data-mock="new-terminal-b-retry"]', hold: 1800,
      act: state => {
        state.world.terminals.push({ id: T_BEN, branch: "b-retry", title: "terminal 1", owner: BEN, lines: [], watchers: [] })
        branch(state.world, "b-retry").terminals.push(T_BEN)
        showCard(state, BEN, "terminal", T_BEN)
        present(state, "b-retry", BEN, { kind: "terminal", id: T_BEN })
        state.viewers[BEN]!.focus = BEN_TERMINAL
      }
    },
    {
      caption: "He starts Claude Code on his own subscription. The Smithers skill is already installed, and Claude Code for Ben joins the branch.",
      viewer: BEN, typing: { into: `terminal:${T_BEN}`, text: "claude" }, hold: 3000,
      act: state => {
        print(state, T_BEN, [["ben@retry-webhooks $ claude", "dim"], "Claude Code · Smithers skill · signed in as benortiz"])
        foreground(state, "claude", ">")
        present(state, "b-retry", CLAUDE, { kind: "terminal", id: T_BEN })
        look(state, ALICE, "branch", "b-retry")
      }
    },
    {
      caption: "Ben asks in plain words. His prompt joins the branch's chat, read-only, and Claude Code's wiki read shows in the activity.",
      viewer: BEN, typing: { into: `terminal:${T_BEN}`, text: ASK }, hold: 3000,
      act: state => {
        print(state, T_BEN, [`> ${ASK}`, '● smthrs wiki page "Webhook retries"', ["  ⎿  Retries use lib/backoff. Never a fixed sleep.", "dim"]])
        read(state, "b-retry", CLAUDE, ["wiki: Webhook retries"])
        imported(state, "b-retry", BEN, "user", ASK, ORIGIN)
      }
    },
    {
      caption: "Its edits land in the shared working copy. Alice's open file updates in place, in Ben's colour, flagged Claude Code for Ben.",
      hold: 3200,
      reveal: [{ viewer: ALICE, target: '[data-mock="card-file"]' }],
      act: state => {
        // One save from a terminal: it joins the live document as an attributed edit, not as typing (mvp.md J3.2, §6.8).
        edit(state, RETRY_FILE, 8, "    await sleep(backoff(attempt))", CLAUDE)
        edit(state, RETRY_FILE, 14, "  await sleep(backoff(1))", CLAUDE)
        openFile(state, RETRY_FILE, CLAUDE, 14)
        present(state, "b-retry", CLAUDE, { kind: "file", path: RETRY_FILE, line: 14 })
        changed(state, "b-retry", CLAUDE, 1)
        print(state, T_BEN, ["● Update(src/webhooks/retry.ts) · 2 lines"])
        look(state, ALICE, "file", RETRY_FILE)
      }
    },
    {
      caption: "Alice opens the change from the activity. Claude Code's edits are part of T9's change, like anyone's.",
      viewer: ALICE, target: '[data-mock="card-branch"] .mvp-activity-row[data-kind="change"] button', hold: 2600,
      act: state => {
        look(state, ALICE, "diff", RETRY_FILE)
        // A card Alice adds lands below Ben's terminal; his screen stays on the session he is driving.
        look(state, BEN, "terminal", T_BEN)
      }
    },
    {
      caption: "The tests pass. Claude Code answers T9's question for Ben, its reply lands in the shared chat, and T9 leaves Needs you.",
      hold: 3200,
      reveal: [{ viewer: ALICE, target: '[data-mock="card-todo"]' }],
      show: [{ viewer: BEN, target: `[data-mock="imported-${CLAUDE}"]` }],
      act: state => {
        print(state, T_BEN, [
          ["● Bash(pnpm test webhooks) · 14 passed", "ok"],
          "● smthrs todo answer T9 · answered as Claude Code for Ben",
          "● No test covers giving up after attempt 5."
        ])
        activity(state, "b-retry", CLAUDE, "answer", ANSWER)
        const item = todo(state.world, "t-retry")
        item.question = { text: item.question!.text, answer: { by: CLAUDE, text: ANSWER } }
        setTodo(state, "t-retry", { state: "working", step: "verify" })
        const doc = file(state.world, RETRY_FILE)
        doc.editors = (doc.editors ?? []).filter(each => each.who !== CLAUDE)
        present(state, "b-retry", CLAUDE, { kind: "terminal", id: T_BEN })
        imported(state, "b-retry", CLAUDE, "agent", REPLY, ORIGIN)
        look(state, ALICE, "todo", "t-retry")
      }
    },
    {
      caption: "The coding agent continues on the same working copy, Claude Code's edits included. Its checks pass, and T9 moves on to Review.",
      hold: 2600,
      reveal: [{ viewer: ALICE, target: '[data-mock="card-branch"]' }],
      act: state => {
        activity(state, "b-retry", AGENT, "step", "pnpm test webhooks · 14 passed", "ok")
        setTodo(state, "t-retry", { state: "working", step: "review" })
        present(state, "b-retry", AGENT, { kind: "step", step: "review" })
        look(state, ALICE, "branch", "b-retry")
      }
    },
    {
      caption: "Ben asks for a follow-up TODO. An agent can't commit one, so a Commit confirmation appears on Ben's screen alone.",
      viewer: BEN, typing: { into: `terminal:${T_BEN}`, text: FOLLOW_UP }, hold: 3400,
      show: [{ viewer: BEN, target: `[data-mock="act-${COMMIT}"]` }],
      act: state => {
        // The CLI's answer to a command that needs a person (engineering spec §5.2.1): nothing is committed yet.
        print(state, T_BEN, [`> ${FOLLOW_UP}`, "● smthrs todo new · Waiting for Ben to confirm"])
        ask(state, BEN, { id: COMMIT, verb: "Commit", target: T12.title, text: T12.prompt, receipt: "Committed T12 after T9", asker: CLAUDE })
        // The confirmation takes Ben's eye off the session he was driving; Alice's screen and activity stay as they were.
        state.viewers[BEN]!.focus = undefined
      }
    },
    {
      caption: "Ben presses ⏎. Only then is T12 placed after T9, and Alice sees it in the activity: Claude Code for Ben asked.",
      viewer: BEN, target: `[data-mock="act-${COMMIT}"]`, hover: true, keys: "⏎", hold: 3400,
      show: [{ viewer: ALICE, target: '[data-mock="card-branch"] .mvp-activity-row:last-child' }],
      act: state => {
        const { world } = state
        pressed(state, COMMIT)
        world.todos.push({ ...T12, ref: "T12", owner: BEN, branch: "b-giveup", state: "queued", queue: 1 })
        world.stack.splice(world.stack.indexOf("t-retry") + 1, 0, T12.id)
        world.branches.push({ id: "b-giveup", name: "test-retry-give-up", item: T12.id, from: "main", machine: "waiting", waitPosition: 1, presence: [], activity: [], terminals: [] })
        // The machine queue follows the stack, so T11 is now second in line.
        todo(world, "t-log").queue = 2
        branch(world, "b-log").waitPosition = 2
        setTodo(state, T12.id, {})
        stackOp(state, "b-retry", "Placed T12 after T9", CLAUDE)
      }
    },
    {
      caption: "Ben quits Claude Code, and it leaves the branch. What it did stays in the activity, as Claude Code for Ben.",
      viewer: BEN, typing: { into: `terminal:${T_BEN}`, text: "/exit" }, hold: 2800,
      reveal: [{ viewer: BEN, target: '[data-mock="card-terminal"]' }],
      pre: state => { state.viewers[BEN]!.focus = BEN_TERMINAL },
      act: state => {
        foreground(state, undefined, undefined)
        leave(state, "b-retry", CLAUDE)
        look(state, BEN, "terminal", T_BEN)
      }
    },
    {
      caption: "Alice opens the branch tree. T12 sits between T9 and T10, waiting for a machine.",
      viewer: ALICE, target: '[data-mock="crumb-tree"]', hold: 3400,
      act: state => { state.viewers[ALICE]!.tree = true }
    }
  ])
}
