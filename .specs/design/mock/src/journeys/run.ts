/*
 * Inside a run (Will, 2026-10-02; mvp.md §6.14 Inspect, B.4). Ben's screen.
 * One TODO attempt is one durable run: Plan to Propose, then a wait for merge
 * that a rebase loops back to Verify. The retry TODO's second attempt: its
 * TODO card flags the run, and Inspect maximizes the run's card (one card per
 * thing: a TODO's run has no card of its own in the conversation). Inside,
 * attempt 1 beside it, phases under each step titled by what they recorded,
 * each with the fast model's one-line summary, a thrashing indicator, a wait
 * for a person, Ben's answer, two reviewers, the PR, and the wait for merge
 * going back to Verify when main moves.
 */
import type { Journey } from "../journey"
import { branch, checksPassed, leave, revise, setTodo, showCard, type Cell, type Phase, type State, type Trace } from "../world"
import { ALICE, BEN, RETRY, seedState } from "./seed"

const TODO = RETRY.id
const RUN = "run-retry"
const RUN_CARD = `run:${RUN}`
const FAIL = ["$ pnpm test webhooks", " FAIL  src/webhooks/retry.test.ts", "   ✗ retries a 503 with backoff   5001 ms", "     Error: test timed out after 5000 ms"]
const PASS = ["$ pnpm test webhooks", " PASS  src/webhooks/retry.test.ts", " Tests  14 passed"]

const cell = (id: string, kind: Cell["kind"], explain: string, extra: Partial<Cell> = {}): Cell => ({ id, kind, explain, ...extra })

/* Attempt 1 was interrupted in Implement when its machine restarted and could not resume (§19.1); Retry started attempt 2 as a new run beside it. J11 inspects the same history after T9 merges. */
export const FIRST = (): Trace => ({
  id: "run-retry-1", title: RETRY.title, todo: TODO, attempt: 1, branch: "b-retry", state: "failed",
  phases: [
    {
      id: "p1-read", step: "plan", title: "Read 3 files", summary: "Found a fixed 30 s wait before each retry.", took: 35, tone: "ok",
      cells: [
        cell("c1-preflight", "context", "Preflight chose retry.ts, lib/backoff.ts and the Webhook retries page.", { took: "1 s", tokens: "3.1k" }),
        cell("c1-plan", "think", "Planned: backoff() for each retry, give up after 5 attempts.", { took: "11 s", tokens: "1.3k" })
      ]
    },
    {
      id: "p1-backoff", step: "implement", title: "Edited 1 file", summary: "Interrupted: the machine restarted mid-edit.", took: 20, tone: "fail", indicator: "Interrupted",
      cells: [cell("c1-edit", "edit", "Began switching deliver() to backoff(attempt); the machine restarted mid-edit.", { tone: "fail", took: "6 s", tokens: "1.2k" })]
    }
  ]
})

/** Attempt 2 up to its question, waiting for a person. */
export const PHASES = (): Array<Phase> => [
  {
    id: "p-read", step: "plan", title: "Read 3 files", summary: "Found a fixed 30 s wait before each retry.", took: 40, tone: "ok",
    cells: [
      cell("c-preflight", "context", "Preflight chose retry.ts, lib/backoff.ts, the Webhook retries page and attempt 1.", { took: "1 s", tokens: "3.4k" }),
      cell("c-read-retry", "read", "Read retry.ts: deliver() waits a fixed 30 s before each retry.", { code: "    await sleep(30_000)", took: "4 s", tokens: "2.1k" }),
      cell("c-read-backoff", "read", "Read lib/backoff.ts: backoff(attempt) exists and caps the delay at 60 s.", { took: "3 s", tokens: "0.8k" }),
      cell("c-plan", "think", "Planned: backoff() for each retry, give up after 5 attempts.", { took: "12 s", tokens: "1.4k" })
    ]
  },
  {
    id: "p-backoff", step: "implement", title: "Edited 1 file", summary: "Changed the wait in deliver().", took: 60, tone: "ok",
    cells: [cell("c-edit-deliver", "edit", "Replaced the fixed 30 s wait in deliver() with backoff(attempt).", { code: "-    await sleep(30_000)\n+    await sleep(backoff(attempt))", took: "9 s", tokens: "1.9k" })]
  },
  {
    /*
     * The agent's own test runs while it implements; Verify is the flow's checks after it. The flag is the
     * deterministic rule (§6.14; engineering spec §11.6.4): the same check failed 3 times with no edit in
     * between to a file the failure names. Its copy is the spec's: "Thrashing: <check> failed 3×".
     */
    id: "p-tests", step: "implement", title: "Ran tests · 1 failed ×3", summary: "The retry test times out every time.", took: 240, tone: "thrash",
    indicator: "Thrashing: pnpm test failed 3×",
    cells: [
      cell("c-run-1", "run", "Ran the webhook tests. The retry test timed out.", { tone: "fail", output: FAIL, took: "41 s" }),
      cell("c-run-2", "run", "Ran the same tests again with nothing changed. Same timeout.", { tone: "fail", output: FAIL, took: "44 s" }),
      cell("c-run-3", "run", "Ran them a third time, still unchanged. Same failure.", { tone: "fail", output: FAIL, took: "43 s" })
    ]
  },
  {
    id: "p-ask", step: "implement", title: "Asked a person", summary: "Asked whether to change the delay or raise the timeout.", tone: "wait",
    indicator: "Waiting for a person since 10:42",
    cells: [cell("c-ask", "ask", "Asked: change the delay, or raise the test timeout?", { tone: "wait", quote: RETRY.question!.text })]
  }
]

/** Ben's answer, in his words: the one he gives T9's question in J3. */
export const ANSWER = "Use backoff() from lib/backoff everywhere we sleep before a retry."

/** Answer settles the wait: Ben's words join the question's phase, which keeps how long it waited. A steer never settles it. */
export const settle = (ask: Phase, seq?: number): void => {
  Object.assign(ask, { tone: "ok", indicator: undefined, took: 180, summary: "Ben answered after 3 min." })
  ask.cells = [...ask.cells.map(each => each.id === "c-ask" ? { ...each, took: "3 min" } : each), cell("c-answer", "answer", ANSWER, { who: BEN, seq })]
}

/* After the answer: the agent's edits, the checks, two reviewers and the PR, then the rebase and recheck when T8 merges. J11 shows them once T9 merged. */
export const FOLLOW = (seq?: number): Phase => ({
  id: "p-answer", step: "implement", title: "Edited 2 files", summary: "Following Ben's answer: the second wait was in redeliver().", took: 120, tone: "ok",
  cells: [
    cell("c-edit-redeliver", "edit", "Found the second fixed wait in redeliver(); switched it to backoff(1).", { code: "-  await sleep(30_000)\n+  await sleep(backoff(1))", took: "7 s", tokens: "1.1k", seq }),
    cell("c-test-redeliver", "edit", "Added a test that redeliver() backs off too.", {
      code: '+  it("backs off before a redelivery", async () => {\n+    await redeliver(event)\n+    expect(sleep).toHaveBeenCalledWith(backoff(1))\n+  })', took: "5 s", tokens: "0.7k", seq
    })
  ]
})

export const VERIFY = (seq?: number): Phase => ({
  id: "p-verify", step: "verify", title: "Ran checks · passed", summary: "Typecheck and all 14 webhook tests pass.", took: 50, tone: "ok",
  cells: [
    cell("c-typecheck", "run", "Ran typecheck: no errors.", { tone: "ok", took: "12 s", seq }),
    cell("c-run-ok", "run", "Ran the webhook tests: 14 passed.", { tone: "ok", output: PASS, took: "38 s", seq })
  ]
})

export const REVIEW = (seq?: number): Phase => ({
  id: "p-review", step: "review", title: "Reviewed · 2 reviewers", summary: "No blocking issues found.", took: 180, tone: "ok",
  cells: [
    cell("c-sub-correct", "reviewer", "Correctness reviewer: no blocking issues. Retries stop after the 5th.", { took: "52 s", tokens: "6.2k", seq }),
    cell("c-sub-tests", "reviewer", "Test reviewer: the tests cover backoff and giving up.", { took: "47 s", tokens: "5.8k", seq })
  ]
})

export const PROPOSE = (seq?: number): Phase => ({
  id: "p-propose", step: "propose", title: "Opened PR #214", summary: "Its body carries the prompt, diff and checks.", took: 40, tone: "ok",
  cells: [cell("c-pr", "run", "Opened PR #214 with the prompt, diff and checks.", { tone: "ok", took: "4 s", seq })]
})

/** A rebase is its own phase: main moved, so the run went back to Verify, then reran the checks. */
export const RECHECK = (seq?: number): Array<Phase> => [
  {
    id: "p-rebase", step: "verify", title: "Rebased onto main", summary: "After T8 merged; now c41a9e0.", took: 2, tone: "ok",
    cells: [cell("c-rebase", "rebase", "Rebased onto main as c41a9e0. Same change, so only checks rerun.", { took: "2 s", seq })]
  },
  {
    id: "p-recheck", step: "verify", title: "Ran checks · passed", summary: "All pass on c41a9e0.", took: 50, tone: "ok",
    cells: [cell("c-recheck", "run", "Reran typecheck and the webhook tests on c41a9e0. All pass.", { tone: "ok", output: PASS, took: "48 s", seq })]
  }
]

const trace = (state: State): Trace => state.world.traces.find(each => each.id === RUN)!
const phase = (state: State, id: string): Phase => trace(state).phases.find(each => each.id === id)!

const setup = (): State => {
  const state = seedState([BEN])
  /* Ben's story alone: with nobody else on the branch, its machine sleeps while the run waits for merge. */
  leave(state, "b-retry", ALICE)
  setTodo(state, TODO, { step: "implement", attempts: 2 })
  state.world.traces.push(FIRST(), { id: RUN, title: RETRY.title, todo: TODO, attempt: 2, branch: "b-retry", state: "waiting", phases: PHASES() })
  showCard(state, BEN, "todo", TODO)
  return state
}

export const insideRun: Journey = {
  id: "run",
  title: "Inside a run",
  spec: "§6.14 · B.4",
  intro: "The retry TODO's second attempt. Its card shows where the run is; Inspect opens the whole attempt.",
  viewers: [BEN],
  setup,
  steps: [
    {
      caption: "The TODO card flags what needs a look in its run: the agent is thrashing.", spec: "§6.14",
      target: '[data-mock="card-todo"] .mvp-run-flag', hover: true, hold: 3000,
      act: () => {}
    },
    {
      caption: "Inspect opens the attempt: one durable run from Plan to Propose, then a wait for merge.", spec: "B.5",
      target: `[data-mock="inspect-todo-${TODO}"]`, hold: 3400,
      act: state => { state.viewers[BEN]!.maximized = RUN_CARD }
    },
    {
      caption: "Attempt 1 was interrupted when its machine restarted. A retry is a new attempt beside the old one.", spec: "§4.1",
      target: '[data-mock="node-1-implement"]', hover: true, hold: 3200,
      act: () => {}
    },
    {
      caption: "Every cell explains what the agent did. Here it ran the same tests again, with nothing changed.", spec: "§6.14",
      target: '[data-mock="cell-c-run-2"]', hold: 3000,
      act: state => { state.viewers[BEN]!.selected = "c-run-2" }
    },
    {
      caption: "The third identical failure, nothing changed in between: that is thrashing.", spec: "§6.14",
      target: '[data-mock="cell-c-run-3"]', hold: 3200,
      act: state => { state.viewers[BEN]!.selected = "c-run-3" }
    },
    {
      caption: "Then it stopped to ask. The run waits for a person, says since when, and takes the answer right here.", spec: "B.3",
      target: '[data-mock="cell-c-ask"]', hold: 2800,
      act: state => { state.viewers[BEN]!.selected = "c-ask" }
    },
    {
      caption: "Ben answers from inside the run. Answer settles the wait: his words join the question, and the agent goes on.", spec: "§4.1",
      target: `[data-mock="run-answer-${RUN}"]`, typing: { into: `answer:${TODO}`, text: ANSWER }, hold: 2800,
      act: state => {
        trace(state).state = "running"
        settle(phase(state, "p-ask"), state.seq)
        /* The agent is still at it: no time yet. */
        trace(state).phases.push({ ...FOLLOW(state.seq), tone: "live", took: undefined })
        setTodo(state, TODO, { state: "working", question: { text: RETRY.question!.text, answer: { by: BEN, text: ANSWER } } })
        state.viewers[BEN]!.selected = "c-edit-redeliver"
      }
    },
    {
      caption: "Verify passes. Two reviewers check the change, and each reports in one line.", spec: "B.5",
      hold: 3200,
      act: state => {
        Object.assign(phase(state, "p-answer"), { tone: "ok", took: 120 })
        /* Review is still running: no time yet. */
        trace(state).phases.push(VERIFY(state.seq), { ...REVIEW(state.seq), tone: "live", took: undefined })
        setTodo(state, TODO, { step: "review" })
        state.viewers[BEN]!.selected = "c-sub-tests"
      }
    },
    {
      caption: "Propose opens PR #214, and the run doesn't end: it waits for merge, holding no machine.", spec: "B.5",
      target: '[data-mock="node-2-merge"]', hover: true, hold: 3400,
      act: state => {
        Object.assign(phase(state, "p-review"), { tone: "ok", took: 180 })
        trace(state).phases.push(PROPOSE(state.seq))
        trace(state).state = "held"
        trace(state).held = { since: "10:52" }
        setTodo(state, TODO, {
          state: "in-review", pr: 214, question: undefined, step: undefined,
          evidence: { rev: "8b1e204", files: 2, added: 26, removed: 9, checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "38s" }], github: { passed: 5, total: 5 }, review: "No blocking issues." }
        })
        leave(state, "b-retry", "agent:b-retry")
        branch(state.world, "b-retry").machine = "asleep"
        state.viewers[BEN]!.selected = "c-pr"
      }
    },
    {
      caption: "T8 merges, so main moves. The rebase loops the run back to Verify: checks pass on c41a9e0, and the review stands, since the change is the same.", spec: "§4.2",
      hold: 3800,
      act: state => {
        setTodo(state, "t-stripe", { state: "merged" })
        trace(state).phases.push(...RECHECK(state.seq))
        trace(state).held = { since: "11:06" }
        revise(state, TODO, "c41a9e0", "clean-rebase")
        checksPassed(state, TODO, { typecheck: "11s", test: "37s" })
        state.viewers[BEN]!.selected = "c-recheck"
      }
    },
    {
      caption: "Restore returns to the conversation. The TODO card shows the PR next to merge, its review marked Reviewed 8b1e204 · same change.", spec: "§6.14",
      target: '[data-mock="restore"]', hold: 2600,
      act: state => { state.viewers[BEN]!.maximized = undefined }
    }
  ]
}
