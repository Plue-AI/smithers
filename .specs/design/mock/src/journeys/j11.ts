/*
 * J11. Look under the hood (mvp.md §5, P0, advanced; §6.14). Maya's screen:
 * the owner, and the lead. After T9 merges she inspects its run: the monitor
 * shows the flow's graph with each step's state, time and tokens, attempt 1
 * beside attempt 2, the wait for Ben's answer, and a step's input, output and
 * transcript. From the TODO flow's card, Source opens the flow on a scratch
 * branch, where she adds a Docs step, and Run tries it with a test prompt:
 * the monitor draws the new graph live. Last, from the Review step she opens
 * the review agent and switches its model to a cheaper one, an owner setting
 * that applies at once.
 */
import type { Journey } from "../journey"
import { activity, branch, edit, openFile, present, say, setTodo, showCard, stackOp, type Cell, type FactoryAgent, type FlowStep, type State, type Trace } from "../world"
import { FLOW_FILE, flowSource, ORDER_LINE, stepsOf, V1_STEPS, version } from "./j5-data"
import { FIRST, FOLLOW, PHASES, PROPOSE, RECHECK, REVIEW, settle, VERIFY } from "./run"
import { MAYA, RETRY, seedState } from "./seed"

const TODO = RETRY.id
const RUN = "run-retry"
const SCRATCH = "b-todo-flow"
const CODING = `agent:${SCRATCH}`
const TEST = "run-docs"
const FORM = "f-run-docs"
const PROMPT = "Cap the retry delay at 60 s."
/** Line 7 of the flow file, up to where she types: Docs goes after Review. */
const ORDER = '    order: ["plan", "implement", "verify", "review", '

const cell = (id: string, kind: Cell["kind"], explain: string, extra: Partial<Cell> = {}): Cell => ({ id, kind, explain, ...extra })
const pass = (tests: number): ReadonlyArray<string> => ["$ pnpm test webhooks", " PASS  src/webhooks/retry.test.ts", ` Tests  ${tests} passed`]

/* Her edit names Docs in the order, as J5's Changelog went in. */
const DOCS: FlowStep = { id: "docs", title: "Docs", detail: "Update the docs the change touches." }
const EDITED: ReadonlyArray<FlowStep> = [...V1_STEPS.slice(0, 4), DOCS, ...V1_STEPS.slice(4)]

/* The agents behind the TODO flow's steps: one Markdown file each, all on the top model until the owner changes one. */
const AGENTS = (): Array<FactoryAgent> =>
  ["plan", "implement", "review"].map(step => ({ id: step, steps: [step], instructions: `flows/todo/${step}.md`, model: "Fable 5.1" }))

/*
 * T9's second attempt once merged: the run reel's history up to its question,
 * then Ben's answer, the same checks, reviewers, PR and recheck after T8
 * merged, and Maya's merge. Review keeps what it was given and returned.
 */
const MERGED = (): Trace => {
  const phases = PHASES()
  settle(phases.find(each => each.id === "p-ask")!)
  return {
    id: RUN, title: RETRY.title, todo: TODO, attempt: 2, branch: "b-retry", state: "merged",
    phases: [
      ...phases, FOLLOW(), VERIFY(), REVIEW(), PROPOSE(), ...RECHECK(),
      {
        id: "p-merged", step: "merge", title: "Merged · Maya", summary: "In review 28 min, then merged at 11:20.", took: 1680, tone: "ok",
        cells: [cell("c-merged", "run", "Maya merged PR #214 into main.", { who: MAYA, tone: "ok" })]
      }
    ],
    io: {
      review: {
        input: [["revision", "8b1e204"], ["diff", "+26 −9 · 2 files"], ["checks", "typecheck, test passed"]],
        output: [["verdict", "No blocking issues"], ["findings", "0"]],
        model: "Fable 5.1"
      }
    }
  }
}

/* The test run of her edited flow on the scratch branch, as it starts: its first summary isn't written yet, so the phase shows its title alone. */
const TEST_RUN = (seq: number): Trace => ({
  id: TEST, title: "TODO flow", attempt: 1, branch: SCRATCH, state: "running", steps: EDITED,
  phases: [{
    id: "d-plan", step: "plan", title: "Read 3 files", summary: "", tone: "live",
    cells: [cell("d-preflight", "context", "Preflight chose lib/backoff.ts, retry.ts and the Webhook retries page.", { took: "1 s", tokens: "2.9k", seq })]
  }]
})

const testRun = (state: State): Trace => state.world.traces.find(each => each.id === TEST)!

const setup = (): State => {
  const state = seedState([MAYA])
  const { world } = state
  /* T8 and T9 merged; T10 and T11 hold two of the three machines; the TODO flow is the built-in one, active on main. */
  for (const id of ["b-stripe", "b-retry"]) Object.assign(branch(world, id), { machine: "closed", presence: [] })
  setTodo(state, "t-stripe", { state: "merged" })
  setTodo(state, TODO, {
    state: "merged", step: undefined, question: undefined, elapsed: undefined, pr: 214, attempts: 2, lessons: 2,
    evidence: {
      rev: "c41a9e0", files: 2, added: 26, removed: 9, github: { passed: 5, total: 5 }, review: "No blocking issues.",
      checks: [{ name: "typecheck", state: "passed", took: "11s" }, { name: "test", state: "passed", took: "37s" }]
    }
  })
  setTodo(state, "t-log", { state: "working", step: "plan", queue: undefined, elapsed: "3m" })
  Object.assign(branch(world, "b-log"), { machine: "awake", waitPosition: undefined, presence: [{ who: "agent:b-log", where: { kind: "step", step: "plan" } }] })
  world.traces.push(FIRST(), MERGED())
  world.flow = stepsOf(V1_STEPS)
  world.flowVersions = [version("v1", "flows/todo/flow.ts · main", "active", stepsOf(V1_STEPS))]
  world.agents = AGENTS()
  showCard(state, MAYA, "todo", TODO)
  return state
}

export const j11: Journey = {
  id: "j11",
  title: "Look under the hood",
  spec: "J11",
  intro: "T9 merged after a retry and a wait for Ben. Maya, the owner and the lead, looks under the hood.",
  viewers: [MAYA],
  setup,
  steps: [
    {
      caption: "T9 merged. Maya selects Inspect on its card, and the monitor opens: the flow's graph, each step's state, time and tokens.", spec: "J11.1",
      target: `[data-mock="inspect-todo-${TODO}"]`, hold: 3600,
      act: state => { state.viewers[MAYA]!.maximized = `run:${RUN}` }
    },
    {
      caption: "Attempt 1 sits beside attempt 2: its machine restarted, and Retry started a new run. Here the run waited 3 minutes for Ben's answer.", spec: "J11.1",
      target: '[data-mock="phase-p-ask"]', hold: 3600,
      act: state => { state.viewers[MAYA]!.selected = "c-answer" }
    },
    {
      caption: "She selects the Review step: what it was given, what it returned, and its transcript, one line per reviewer. It took 3 minutes and 12k tokens.", spec: "J11.1",
      target: `[data-mock="node-2-review"]`, hold: 4000,
      act: state => { state.viewers[MAYA]!.selected = `step:${RUN}:review` }
    },
    {
      caption: "Restore returns to the conversation.", spec: "J11.1",
      target: '[data-mock="restore"]', hold: 1800,
      act: state => { Object.assign(state.viewers[MAYA]!, { maximized: undefined, selected: undefined }) }
    },
    {
      caption: "She opens the TODO flow. Each agent's step shows the model it runs on.", spec: "J11.2",
      keys: "⌘ K", typing: { into: "composer", text: "/flow todo" }, hold: 3000,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        say(state, MAYA, "/flow todo")
        showCard(state, MAYA, "flow", "todo")
      }
    },
    {
      caption: "Source forks a scratch branch for her and opens flows/todo/flow.ts on it, in the File card.", spec: "J11.2",
      target: '[data-mock="flow-source"]', hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-file"]' }],
      act: state => {
        state.world.branches.push({ id: SCRATCH, name: "maya/todo-flow", from: "main", machine: "awake", presence: [], activity: [], terminals: [] })
        stackOp(state, SCRATCH, "Forked from main", MAYA)
        state.world.files.push({ path: FLOW_FILE, branch: SCRATCH, lines: flowSource() })
        openFile(state, FLOW_FILE, MAYA, ORDER_LINE)
        present(state, SCRATCH, MAYA, { kind: "file", path: FLOW_FILE, line: ORDER_LINE })
        showCard(state, MAYA, "file", FLOW_FILE)
      }
    },
    {
      caption: "She adds a Docs step after Review. The file saves to the machine as she types.", spec: "J11.2",
      target: `[data-mock="card-file"] .mvp-editor-line:nth-child(${ORDER_LINE})`, hold: 2800,
      typing: { into: `line:${FLOW_FILE}:${ORDER_LINE}`, after: ORDER, text: '"docs", "propose"],' },
      act: state => {
        edit(state, FLOW_FILE, ORDER_LINE, `${ORDER}"docs", "propose"],`, MAYA)
        activity(state, SCRATCH, MAYA, "edit", `Edited flow.ts line ${ORDER_LINE}`)
      }
    },
    {
      caption: "Run asks for the flow's input in a form. It runs her edited flow on her scratch branch.", spec: "J11.3",
      target: '[data-mock="flow-run"]', hold: 2600,
      show: [{ viewer: MAYA, target: `[data-mock="form-${FORM}-prompt"]` }],
      act: state => {
        ;(state.world.forms ??= []).push({ id: FORM, title: "Run TODO flow on maya/todo-flow", fields: [{ id: "prompt", label: "Prompt", value: "", required: true }], submit: "Run" })
        state.viewers[MAYA]!.focus = showCard(state, MAYA, "form", FORM)
      }
    },
    {
      caption: "She types a test prompt and presses Return. Her own Run starts at once, and the monitor draws the new graph live.", spec: "J11.3",
      target: `[data-mock="form-${FORM}-prompt"]`, typing: { into: `form:${FORM}:prompt`, text: PROMPT }, hold: 3400,
      act: state => {
        const form = state.world.forms!.find(each => each.id === FORM)!
        form.fields[0]!.value = PROMPT
        Object.assign(form, { receipt: "Started on maya/todo-flow", seq: state.seq })
        state.world.traces.push(TEST_RUN(state.seq))
        present(state, SCRATCH, CODING, { kind: "step", step: "plan" })
        showCard(state, MAYA, "run", TEST)
        Object.assign(state.viewers[MAYA]!, { focus: undefined, maximized: `run:${TEST}` })
      }
    },
    {
      caption: "Minutes later the run passes Review, and the new Docs node lights up.", spec: "J11.3",
      hold: 3800,
      act: state => {
        const run = testRun(state)
        const plan = run.phases.find(each => each.id === "d-plan")!
        Object.assign(plan, { tone: "ok", took: 35, summary: "backoff() had no upper bound." })
        plan.cells.push(cell("d-plan-think", "think", "Planned: cap backoff() at 60 s and test the cap.", { took: "9 s", tokens: "1.2k" }))
        run.phases.push(
          {
            id: "d-cap", step: "implement", title: "Edited 2 files", summary: "backoff() now stops at 60 s, with a test.", took: 70, tone: "ok",
            cells: [cell("d-edit", "edit", "Capped backoff() at 60 s and added a test for the cap.", { code: "-  return 1_000 * 2 ** attempt\n+  return Math.min(60_000, 1_000 * 2 ** attempt)", took: "8 s", tokens: "1.6k" })]
          },
          {
            id: "d-verify", step: "verify", title: "Ran checks · passed", summary: "Typecheck and 15 webhook tests pass.", took: 45, tone: "ok",
            cells: [cell("d-tests", "run", "Ran typecheck and the webhook tests: 15 passed.", { tone: "ok", output: pass(15), took: "39 s" })]
          },
          {
            id: "d-review", step: "review", title: "Reviewed · 2 reviewers", summary: "No blocking issues found.", took: 150, tone: "ok",
            cells: [
              cell("d-correct", "reviewer", "Correctness reviewer: no blocking issues. The cap holds.", { took: "44 s", tokens: "5.1k" }),
              cell("d-cover", "reviewer", "Test reviewer: the new test covers the 60 s cap.", { took: "39 s", tokens: "4.7k" })
            ]
          },
          {
            id: "d-docs", step: "docs", title: "Read 1 file", summary: "", tone: "live",
            cells: [cell("d-read-docs", "read", "Read docs/webhooks.md: it still says each retry waits 30 s.", { took: "3 s", tokens: "1.4k", seq: state.seq })]
          }
        )
        present(state, SCRATCH, CODING, { kind: "step", step: "docs" })
      }
    },
    {
      caption: "Restore. The run's card stays live in the conversation, on her scratch branch.", spec: "J11.3",
      target: '[data-mock="restore"]', hold: 2400,
      act: state => { state.viewers[MAYA]!.maximized = undefined }
    },
    {
      caption: "The scratch branch sits under main in the branch tree, with Maya and the coding agent on it.", spec: "J11.3",
      target: '[data-mock="crumb-tree"]', hold: 3000,
      act: state => { state.viewers[MAYA]!.tree = true }
    },
    {
      caption: "Back on the Flow card, Review's agent chip opens the Agent card: its instructions file and its model.", spec: "J11.4",
      target: '[data-mock="flow-agent-review"]', hold: 3000,
      pre: state => { state.viewers[MAYA]!.tree = false },
      show: [{ viewer: MAYA, target: '[data-mock="card-agent"]' }],
      act: state => { showCard(state, MAYA, "agent", "review") }
    },
    {
      caption: "The model is the owner's setting. Each option shows its price per million tokens, in and out.", spec: "J11.4",
      target: '[data-mock="agent-model-review"]', hold: 3400,
      show: [{ viewer: MAYA, target: ".mvp-model-menu" }],
      act: state => { showCard(state, MAYA, "agent", "review", "model") }
    },
    {
      caption: "She switches review to Opus 5.5, under half the price. It applies at once, and the card keeps the receipt.", spec: "J11.4",
      target: '[data-mock="model-opus-5-5"]', hold: 3600,
      act: state => {
        const agent = state.world.agents!.find(each => each.id === "review")!
        agent.changed = { from: agent.model, by: MAYA, seq: state.seq }
        agent.model = "Opus 5.5"
        showCard(state, MAYA, "agent", "review", "")
      }
    }
  ]
}
