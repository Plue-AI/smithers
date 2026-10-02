/*
 * The coding agent at work (mvp.md B.3, §3.1). Ben's screen. Everything the
 * coding agent does renders as a teammate's would: what it recalled is the
 * Context line, what it read is a Read line, its edit arrives live in the File
 * card with its flag, its commands run in its own Terminal session, and its
 * question is Needs you. Ben's plain-words requests show the app agent's rules
 * (Appendix B): a flow and a stop run at once; a drop waits for his press (A✓).
 */
import { cite, type Journey } from "../journey"
import {
  activity, ask, branch, context, dismissToasts, edit, file, navigate, openFile, present, pressed, print, read, reply, setTodo,
  showCard, stackOp, toast, todo, type State
} from "../world"
import { request } from "./ask"
import { ALICE, BEN, RETRY_FILE, seedState } from "./seed"

const CODING = "agent:b-retry"
const SMITHERS = `${BEN}~smithers`
const BACKOFF_FILE = "src/lib/backoff.ts"
const T_AGENT = "t-agent"
const STEER = "Please fix retry.ts:14: redeliver() still waits a fixed 30 s before the first retry."
const QUESTION = "deliver() still waits 30 s, so the retry test times out. Use backoff there too, or raise the timeout?"
const ANSWER = "Use backoff there too."

const setup = (): State => {
  const state = seedState([BEN])
  const { world } = state
  // T9 is working at Verify: its test run and its question come later in the reel.
  Object.assign(todo(world, "t-retry"), { state: "working", step: "verify", question: undefined })
  const retry = branch(world, "b-retry")
  retry.activity = retry.activity.filter(each => each.kind !== "question" && each.tone !== "fail")
  present(state, "b-retry", ALICE, { kind: "file", path: RETRY_FILE, line: 10 })
  openFile(state, RETRY_FILE, ALICE, 10)
  showCard(state, BEN, "home", "acme/api")
  return state
}

export const agentAtWork: Journey = {
  id: "agent",
  title: "The coding agent at work",
  spec: "B.3",
  intro: "Ben joins a branch and works with its coding agent. Everything the agent does looks the way a teammate's would.",
  viewers: [BEN],
  setup,
  steps: cite(["B.1", "B.1", "B.2", "B.2", "B.3", "B.3", "B.3", "B.3", "B.3", "B.3", "B.3", "§4.1", "B.2", "B.2", "B.2"], [
    {
      caption: "Ben is in main, the team's conversation. The last crumb opens the branch tree.",
      target: '[data-mock="crumb-tree"]', hold: 2200,
      act: state => { state.viewers[BEN]!.tree = true }
    },
    {
      caption: "He picks retry-webhooks, T9's branch. Now he is in its conversation, with Alice and the coding agent.",
      target: '[data-mock="tree-b-retry"]', hold: 2600,
      act: state => {
        state.viewers[BEN]!.tree = false
        navigate(state, BEN, "b-retry")
        present(state, "b-retry", BEN, { kind: "branch" })
      }
    },
    request("review this branch", "He asks for a review in plain words. Running a flow needs no confirmation, so the review flow runs at once.", state => {
      state.world.reviews.push({
        id: "r-retry", branch: "b-retry", by: SMITHERS, verdict: "changes",
        findings: [
          { severity: "fix", path: RETRY_FILE, line: 14, text: "redeliver() still waits a fixed 30 s before the first retry." },
          { severity: "note", path: "src/webhooks/retry.test.ts", line: 22, text: "No test covers giving up after the 5th attempt." }
        ]
      })
      toast(state, BEN, { tone: "ok", title: "Reviewed retry-webhooks", detail: "2 findings" })
      showCard(state, BEN, "review", "r-retry")
    }, { hold: 3000 }),
    {
      caption: "Ben presses Please fix on the first finding. It becomes his steer in the branch activity.",
      target: '[data-mock="finding-fix-r-retry-0"]', hold: 2600,
      show: [{ viewer: BEN, target: '[data-mock="card-branch"]' }],
      act: state => {
        const review = state.world.reviews.find(each => each.id === "r-retry")!
        review.findings[0]!.acted = "fix"
        activity(state, "b-retry", BEN, "steer", STEER)
        setTodo(state, "t-retry", { state: "working", step: "implement" })
        present(state, "b-retry", CODING, { kind: "step", step: "implement" })
      }
    },
    {
      caption: "The coding agent picks it up. Its Context line counts what it recalled; its Read line names the files it read.",
      hold: 3000,
      reveal: [{ viewer: BEN, target: '[data-mock="card-branch"]' }],
      act: state => {
        context(state, "b-retry", CODING, ["wiki: Webhook retries", "#212", "T9 plan"])
        read(state, "b-retry", CODING, [RETRY_FILE, BACKOFF_FILE])
      }
    },
    {
      caption: "Ben opens the Context line: a wiki page, the issue and T9's plan.",
      target: '[data-mock="card-branch"] [data-kind="context"] .mvp-context-toggle', hold: 2400,
      act: state => {
        const line = branch(state.world, "b-retry").activity.find(each => each.kind === "context")!
        const screen = state.viewers[BEN]!
        screen.views = { ...screen.views, [`context:${line.id}`]: "open" }
      }
    },
    {
      caption: "He opens retry.ts from the Read line. Alice is in it, at line 10.",
      target: `[data-mock="read-${RETRY_FILE}"]`, hold: 2400,
      act: state => { showCard(state, BEN, "file", RETRY_FILE) }
    },
    {
      caption: "The coding agent edits line 14 the way a teammate does: its flag on the line, its characters arriving live.",
      typing: { into: `line:${RETRY_FILE}:14`, after: "  await sleep(", text: "backoff(1))", shared: true }, hold: 2600,
      reveal: [{ viewer: BEN, target: '[data-mock="card-file"]' }],
      pre: state => {
        openFile(state, RETRY_FILE, CODING, 14)
        present(state, "b-retry", CODING, { kind: "file", path: RETRY_FILE, line: 14 })
      },
      act: state => {
        edit(state, RETRY_FILE, 14, "  await sleep(backoff(1))", CODING)
        activity(state, "b-retry", CODING, "edit", "Edited retry.ts line 14", "ok")
      }
    },
    {
      caption: "It opens its own terminal on the branch. The session joins the conversation, and Ben watches it.",
      hold: 2000,
      act: state => {
        const { world } = state
        const doc = file(world, RETRY_FILE)
        doc.editors = (doc.editors ?? []).filter(each => each.who !== CODING)
        world.terminals.push({ id: T_AGENT, branch: "b-retry", title: "terminal 1", owner: CODING, lines: [], watchers: [BEN] })
        branch(world, "b-retry").terminals.push(T_AGENT)
        present(state, "b-retry", CODING, { kind: "terminal", id: T_AGENT })
        branch(world, "b-retry").presence.find(each => each.who === BEN)!.watching = T_AGENT
        showCard(state, BEN, "terminal", T_AGENT)
      }
    },
    {
      caption: "It runs the webhook tests the way a person would. One test still times out.",
      typing: { into: `terminal:${T_AGENT}`, text: "pnpm test webhooks", shared: true }, hold: 2600,
      reveal: [{ viewer: BEN, target: '[data-mock="card-terminal"]' }],
      act: state => {
        print(state, T_AGENT, [
          ["agent@retry-webhooks $ pnpm test webhooks", "dim"],
          [" FAIL  src/webhooks/retry.test.ts", "fail"],
          ["   ✗ retries a 503 with backoff   5001 ms", "fail"],
          ["     Error: test timed out after 5000 ms", "dim"],
          [" Tests  1 failed · 13 passed", "fail"]
        ])
        setTodo(state, "t-retry", { step: "verify" })
        activity(state, "b-retry", CODING, "step", "pnpm test webhooks · 1 failed", "fail")
      }
    },
    {
      caption: "So it asks. A notification offers Answer, and the branch input now reads Answer the coding agent.",
      hold: 3000,
      show: [{ viewer: BEN, target: '[data-mock="card-branch"]' }],
      act: state => {
        setTodo(state, "t-retry", { state: "needs-you", step: "verify", question: { text: QUESTION } })
        activity(state, "b-retry", CODING, "question", QUESTION)
        present(state, "b-retry", CODING, { kind: "step", step: "verify" })
        toast(state, BEN, { tone: "attention", title: "Retry failed webhooks asks", detail: QUESTION, action: "Answer" })
      }
    },
    {
      caption: "Ben answers in the branch input. His answer settles the question, and the agent carries on.",
      target: '[data-mock="steer-input-b-retry"]', typing: { into: "steer:b-retry", text: ANSWER }, hold: 2800,
      show: [{ viewer: BEN, target: '[data-mock="card-branch"]' }],
      act: state => {
        todo(state.world, "t-retry").question = { text: QUESTION, answer: { by: BEN, text: ANSWER } }
        activity(state, "b-retry", BEN, "answer", ANSWER)
        setTodo(state, "t-retry", { state: "working", step: "implement" })
        present(state, "b-retry", CODING, { kind: "step", step: "implement" })
        activity(state, "b-retry", CODING, "step", "Using backoff() in deliver() too", "run")
        dismissToasts(state, BEN)
      }
    },
    request("stop the checkout TODO", "Back in plain words. Stop runs at once: T10 is Paused, and the reply is its receipt.", state => {
      setTodo(state, "t-checkout", { state: "paused" })
      reply(state, BEN, "Stopped T10.")
      showCard(state, BEN, "todo", "t-checkout")
    }, { hold: 3000 }),
    request("drop T11", "Dropping a TODO asks first. The app agent posts exactly what it will do, and only Ben can press it.", state => {
      ask(state, BEN, { id: "drop-t11", verb: "Drop", target: "T11 log-retries", receipt: "Dropped T11" })
    }, { hold: 3000 }),
    {
      caption: "Ben presses ⏎. T11 is Dropped, and its branch records that Smithers for Ben asked.",
      target: '[data-mock="act-drop-t11"]', hover: true, keys: "⏎", hold: 3200,
      act: state => {
        pressed(state, "drop-t11")
        setTodo(state, "t-log", { state: "dropped", queue: undefined })
        const log = branch(state.world, "b-log")
        log.machine = "closed"
        log.waitPosition = undefined
        stackOp(state, "b-log", "Dropped T11", SMITHERS)
      }
    }
  ])
}
