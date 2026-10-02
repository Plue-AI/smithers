/*
 * Inside a run (Will, 2026-10-02; mvp.md §6.14 Inspect, B.4). Ben's screen.
 * One TODO attempt is one durable run: Plan to Propose, then a wait for merge
 * that a rebase loops back to Verify. The retry TODO's second attempt: its
 * TODO card flags the run, and Inspect maximizes the run's card (one card per
 * thing: a TODO's run has no card of its own in the conversation). Inside,
 * attempt 1 beside it, phases a cheap model titled under each step, a
 * thrashing indicator, a wait for a person, Ben's steer, two reviewers, the
 * PR, and the wait for merge going back to Verify when main moves.
 */
import type { Journey } from "../journey"
import { branch, checksPassed, leave, revise, setTodo, showCard, type Cell, type Phase, type State, type Trace } from "../world"
import { ALICE, BEN, RETRY, seedState } from "./seed"

const TODO = RETRY.id
const RUN = "run-retry"
const RUN_CARD = `run:${RUN}`
const STEER = "Use backoff() everywhere we sleep before a retry."
const FAIL = ["$ pnpm test webhooks", " FAIL  src/webhooks/retry.test.ts", "   ✗ retries a 503 with backoff   5001 ms", "     Error: test timed out after 5000 ms"]
const PASS = ["$ pnpm test webhooks", " PASS  src/webhooks/retry.test.ts", " Tests  14 passed"]

const cell = (id: string, kind: Cell["kind"], explain: string, extra: Partial<Cell> = {}): Cell => ({ id, kind, explain, ...extra })

/* Attempt 1 stopped in Implement when its machine restarted; Retry started attempt 2 as a new run beside it. J11 inspects the same history after T9 merges. */
export const FIRST = (): Trace => ({
  id: "run-retry-1", title: RETRY.title, todo: TODO, attempt: 1, branch: "b-retry", state: "failed",
  phases: [
    {
      id: "p1-read", step: "plan", title: "Read the retry path", summary: "Found a fixed 30 s wait before each retry.", took: 35, tone: "ok",
      cells: [
        cell("c1-preflight", "context", "Preflight chose retry.ts, lib/backoff.ts and the Webhook retries page.", { took: "1 s", tokens: "3.1k" }),
        cell("c1-plan", "think", "Planned: backoff() for each retry, give up after 5 attempts.", { took: "11 s", tokens: "1.3k" })
      ]
    },
    {
      id: "p1-backoff", step: "implement", title: "Switch retries to backoff", summary: "Stopped when the machine restarted.", took: 20, tone: "fail", indicator: "Machine restarted",
      cells: [cell("c1-edit", "edit", "Began switching deliver() to backoff(attempt); the machine restarted mid-edit.", { tone: "fail", took: "6 s", tokens: "1.2k" })]
    }
  ]
})

/** Attempt 2 up to its question, waiting for a person. */
export const PHASES = (): Array<Phase> => [
  {
    id: "p-read", step: "plan", title: "Read the retry path", summary: "Found a fixed 30 s wait before each retry.", took: 40, tone: "ok",
    cells: [
      cell("c-preflight", "context", "Preflight chose retry.ts, lib/backoff.ts, the Webhook retries page and attempt 1.", { took: "1 s", tokens: "3.4k" }),
      cell("c-read-retry", "read", "Read retry.ts: deliver() waits a fixed 30 s before each retry.", { code: "    await sleep(30_000)", took: "4 s", tokens: "2.1k" }),
      cell("c-read-backoff", "read", "Read lib/backoff.ts: backoff(attempt) exists and caps the delay at 60 s.", { took: "3 s", tokens: "0.8k" }),
      cell("c-plan", "think", "Planned: backoff() for each retry, give up after 5 attempts.", { took: "12 s", tokens: "1.4k" })
    ]
  },
  {
    id: "p-backoff", step: "implement", title: "Switch retries to backoff", summary: "Changed the wait in deliver().", took: 60, tone: "ok",
    cells: [cell("c-edit-deliver", "edit", "Replaced the fixed 30 s wait in deliver() with backoff(attempt).", { code: "-    await sleep(30_000)\n+    await sleep(backoff(attempt))", took: "9 s", tokens: "1.9k" })]
  },
  {
    /* The agent's own test runs while it implements; Verify is the flow's checks after it. */
    id: "p-tests", step: "implement", title: "Run the webhook tests", summary: "The retry test times out every time.", took: 240, tone: "thrash",
    indicator: "Thrashing: the same test failed 3 times with the same timeout",
    cells: [
      cell("c-run-1", "run", "Ran the webhook tests. The retry test timed out.", { tone: "fail", output: FAIL, took: "41 s" }),
      cell("c-timeout", "edit", "Raised the timeout to 10 s without finding why it's slow.", { code: "-  }, 5_000)\n+  }, 10_000)", took: "6 s", tokens: "0.9k" }),
      cell("c-run-2", "run", "Ran the tests again. Same timeout: a 30 s sleep remains.", { tone: "fail", output: FAIL, took: "44 s" }),
      cell("c-run-3", "run", "Ran them a third time with no change. Same failure.", { tone: "fail", output: FAIL, took: "43 s" })
    ]
  },
  {
    id: "p-ask", step: "implement", title: "Ask a person", summary: "Asked whether to change the delay or raise the timeout.", tone: "wait",
    indicator: "Waiting for a person since 10:42",
    cells: [cell("c-ask", "ask", "Asked: change the delay, or raise the test timeout?", { tone: "wait", quote: RETRY.question!.text })]
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
      caption: "The TODO card flags what needs a look in its run: the agent is thrashing.",
      target: '[data-mock="card-todo"] .mvp-run-flag', hover: true, hold: 3000,
      act: () => {}
    },
    {
      caption: "Inspect opens the attempt: one durable run from Plan to Propose, then a wait for merge.",
      target: `[data-mock="inspect-todo-${TODO}"]`, hold: 3400,
      act: state => { state.viewers[BEN]!.maximized = RUN_CARD }
    },
    {
      caption: "Attempt 1 stopped when its machine restarted. A retry is a new attempt beside the old one.",
      target: '[data-mock="node-1-implement"]', hover: true, hold: 3200,
      act: () => {}
    },
    {
      caption: "Every cell explains what the agent did. This phase repeats one failure with no new idea: that is thrashing.",
      target: '[data-mock="cell-c-run-2"]', hold: 3400,
      act: state => { state.viewers[BEN]!.selected = "c-run-2" }
    },
    {
      caption: "Here it raised a timeout instead of finding the cause.",
      target: '[data-mock="cell-c-timeout"]', hold: 2800,
      act: state => { state.viewers[BEN]!.selected = "c-timeout" }
    },
    {
      caption: "Then it stopped to ask. The run waits for a person, and says since when.",
      target: '[data-mock="cell-c-ask"]', hold: 2800,
      act: state => { state.viewers[BEN]!.selected = "c-ask" }
    },
    {
      caption: "Ben steers from inside the run. A new Implement phase starts, titled from what the agent now does.",
      target: `[data-mock="run-steer-${RUN}"]`, typing: { into: "steer:b-retry", text: STEER }, hold: 2800,
      act: state => {
        trace(state).state = "running"
        Object.assign(phase(state, "p-ask"), { tone: "ok", indicator: undefined, took: 180 })
        trace(state).phases.push({
          id: "p-steer", step: "implement", title: "Use backoff everywhere", summary: "Following Ben's steer: the second wait was in redeliver().", tone: "live",
          cells: [
            cell("c-steer", "steer", STEER, { who: BEN, seq: state.seq }),
            cell("c-edit-redeliver", "edit", "Found the second fixed wait in redeliver(); switched it to backoff(1).", { code: "-  await sleep(30_000)\n+  await sleep(backoff(1))", took: "7 s", tokens: "1.1k", seq: state.seq }),
            cell("c-revert-timeout", "edit", "Restored the 5 s test timeout: the delay was the cause.", { code: "-  }, 10_000)\n+  }, 5_000)", took: "4 s", tokens: "0.4k", seq: state.seq })
          ]
        })
        setTodo(state, TODO, { state: "working", question: undefined })
        state.viewers[BEN]!.selected = "c-edit-redeliver"
      }
    },
    {
      caption: "Verify passes. Two reviewers check the change, and each reports in one line.",
      hold: 3200,
      act: state => {
        Object.assign(phase(state, "p-steer"), { tone: "ok", took: 120 })
        trace(state).phases.push(
          {
            id: "p-verify", step: "verify", title: "Run the checks", summary: "Typecheck and all 14 webhook tests pass.", took: 50, tone: "ok",
            cells: [
              cell("c-typecheck", "run", "Ran typecheck: no errors.", { tone: "ok", took: "12 s", seq: state.seq }),
              cell("c-run-ok", "run", "Ran the webhook tests: 14 passed.", { tone: "ok", output: PASS, took: "38 s", seq: state.seq })
            ]
          },
          {
            id: "p-review", step: "review", title: "Review the change", summary: "Two reviewers checked the change.", tone: "live",
            cells: [
              cell("c-sub-correct", "reviewer", "Correctness reviewer: no blocking issues. Retries stop after the 5th.", { took: "52 s", tokens: "6.2k", seq: state.seq }),
              cell("c-sub-tests", "reviewer", "Test reviewer: the tests cover backoff and giving up.", { took: "47 s", tokens: "5.8k", seq: state.seq })
            ]
          }
        )
        setTodo(state, TODO, { step: "review" })
        state.viewers[BEN]!.selected = "c-sub-tests"
      }
    },
    {
      caption: "Propose opens PR #214, and the run doesn't end: it waits for merge, holding no machine.",
      target: '[data-mock="node-2-merge"]', hover: true, hold: 3400,
      act: state => {
        Object.assign(phase(state, "p-review"), { tone: "ok", took: 180 })
        trace(state).phases.push({
          id: "p-propose", step: "propose", title: "Open the PR", summary: "PR #214 opened with its evidence.", took: 40, tone: "ok",
          cells: [cell("c-pr", "run", "Opened PR #214 with the prompt, diff and checks.", { tone: "ok", took: "4 s", seq: state.seq })]
        })
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
      caption: "T8 merges, so main moves. The rebase loops the run back to Verify, checks pass on the new revision, and it waits again.",
      hold: 3800,
      act: state => {
        setTodo(state, "t-stripe", { state: "merged" })
        trace(state).phases.push({
          id: "p-recheck", step: "verify", title: "Recheck on the new revision", summary: "Rebased onto main after T8 merged; checks pass.", took: 60, tone: "ok",
          cells: [
            cell("c-rebase", "rebase", "main moved when T8 merged. Rebased onto it as c41a9e0.", { took: "2 s", seq: state.seq }),
            cell("c-recheck", "run", "Reran typecheck and the webhook tests on c41a9e0. All pass.", { tone: "ok", output: PASS, took: "48 s", seq: state.seq })
          ]
        })
        trace(state).held = { since: "11:06" }
        revise(state, TODO, "c41a9e0")
        checksPassed(state, TODO, { typecheck: "11s", test: "37s" })
        state.viewers[BEN]!.selected = "c-recheck"
      }
    },
    {
      caption: "Restore returns to the conversation. The TODO card shows the PR, rebased and next to merge.",
      target: '[data-mock="restore"]', hold: 2600,
      act: state => { state.viewers[BEN]!.maximized = undefined }
    }
  ]
}
