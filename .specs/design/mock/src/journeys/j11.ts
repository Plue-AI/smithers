/*
 * J11. Look under the hood (mvp.md §5, P0, advanced; §6.14). Maya's screen:
 * the owner, and the lead. After T9 merges she inspects its run: the monitor
 * shows the flow's graph with each step's state, time and tokens, attempt 1
 * beside attempt 2, the wait for Ben's answer, and a step's input, output and
 * transcript. Every flow edit is a TODO a person merges (§6.12), so Source on
 * the TODO flow's card starts one: T12, which she commits herself. The flow
 * file opens on T12's branch, where she adds a Docs step, and the Flow card
 * shows T12's version as Proposed beside the Active one. Run tries that
 * revision with a test prompt on a scratch input branch, and the monitor
 * draws the new graph live (Appendix B.2 flow.source). Last, from the Review
 * step she opens the review agent and switches its model to a cheaper one,
 * an owner setting that applies at once.
 */
import type { Journey } from "../journey"
import { activity, branch, edit, openFile, present, say, setTodo, showCard, stackOp, type Cell, type FactoryAgent, type FlowStep, type FlowVersion, type State, type Trace } from "../world"
import { FLOW_FILE, flowSource, ORDER_LINE, stepsOf, V1_STEPS, version } from "./j5-data"
import { FIRST, FOLLOW, PHASES, PROPOSE, RECHECK, REVIEW, settle, VERIFY } from "./run"
import { MAYA, RETRY, seedState } from "./seed"

const TODO = RETRY.id
const RUN = "run-retry"
/* T12, the TODO that proposes her flow edit: its branch holds the flow file she edits. */
const FLOW_TODO = "t-docs"
const FLOW_BRANCH = "b-docs"
const FLOW_AGENT = `agent:${FLOW_BRANCH}`
const DRAFT = "d-docs"
const TITLE = "Add a Docs step to the TODO flow"
/* The test run's input: a scratch branch forked from main, where the edited flow does its work. */
const INPUT = "b-try-docs"
const INPUT_NAME = "maya/try-docs"
const TESTER = `agent:${INPUT}`
/* The exact flow revision the test run pins: T12's branch as she left it. */
const REVISION = "T12 · 4d7c2e1"
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

/* The test run of T12's revision on the scratch input branch, as it starts: its first summary isn't written yet, so the phase shows its title alone. */
const TEST_RUN = (seq: number): Trace => ({
  id: TEST, title: `TODO flow · ${REVISION}`, attempt: 1, branch: INPUT, state: "running", steps: EDITED,
  phases: [{
    id: "d-plan", step: "plan", title: "Read 3 files", summary: "", tone: "live",
    cells: [cell("d-preflight", "context", "Preflight chose lib/backoff.ts, retry.ts and the Webhook retries page.", { took: "1 s", tokens: "2.9k", seq })]
  }]
})

const testRun = (state: State): Trace => state.world.traces.find(each => each.id === TEST)!

const setVersion = (state: State, id: string, patch: Partial<FlowVersion>): void => {
  state.world.flowVersions = state.world.flowVersions.map(each => each.id === id ? { ...each, ...patch } : each)
}

const setup = (): State => {
  const state = seedState([MAYA])
  const { world } = state
  /*
   * T8 and T9 merged; T10 waits in review, its machine asleep; T11 holds one of the three machines. The TODO
   * flow is the built-in one, active on main.
   */
  for (const id of ["b-stripe", "b-retry"]) Object.assign(branch(world, id), { machine: "closed", presence: [] })
  setTodo(state, "t-stripe", { state: "merged" })
  setTodo(state, "t-checkout", { state: "in-review", step: undefined, elapsed: undefined, pr: 215 })
  Object.assign(branch(world, "b-checkout"), { machine: "asleep", presence: [] })
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
  world.flowVersions = [version("v1", "v1 · flows/todo/flow.ts · main", "active", stepsOf(V1_STEPS))]
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
      caption: "Attempt 1 sits beside attempt 2: a machine restart interrupted it, and Retry started a new run. Here the run waited 3 minutes for Ben's answer.", spec: "J11.1",
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
      caption: "Every flow edit is a TODO a person merges, so Source starts one as a draft. She names it.", spec: "§6.12",
      target: '[data-mock="flow-source"]', typing: { into: `draft-title:${DRAFT}`, text: TITLE }, hold: 3000,
      pre: state => {
        state.world.drafts.push({ id: DRAFT, title: "", prompt: `Edit ${FLOW_FILE}.`, fixes: false, place: { kind: "append" } })
        showCard(state, MAYA, "draft", DRAFT)
      },
      act: state => { state.world.drafts.find(each => each.id === DRAFT)!.title = TITLE }
    },
    {
      caption: "She commits it herself: T12, at the end of the stack. The flow file opens on T12's branch, in the File card.", spec: "B.2",
      target: '[data-mock="draft-commit"]', hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-file"]' }],
      act: state => {
        const { world } = state
        const draft = world.drafts.find(each => each.id === DRAFT)!
        world.todos.push({ id: FLOW_TODO, ref: "T12", title: TITLE, prompt: draft.prompt, owner: MAYA, branch: FLOW_BRANCH, state: "starting", seq: state.seq })
        world.stack.push(FLOW_TODO)
        world.branches.push({ id: FLOW_BRANCH, name: "todo-flow-docs", item: FLOW_TODO, from: "main", machine: "waking", presence: [], activity: [], terminals: [] })
        draft.committed = FLOW_TODO
        stackOp(state, FLOW_BRANCH, "Placed T12 after T11", MAYA)
        /* The version T12 proposes: v1's steps until her edit lands. */
        world.flowVersions.push(version("v2", "v2 · flows/todo/flow.ts · T12", "proposed", stepsOf(V1_STEPS), FLOW_TODO, MAYA))
        world.files.push({ path: FLOW_FILE, branch: FLOW_BRANCH, lines: flowSource() })
        openFile(state, FLOW_FILE, MAYA, ORDER_LINE)
        present(state, FLOW_BRANCH, MAYA, { kind: "file", path: FLOW_FILE, line: ORDER_LINE })
        showCard(state, MAYA, "flow", "todo", "v2")
        showCard(state, MAYA, "file", FLOW_FILE)
      }
    },
    {
      caption: "She adds a Docs step after Review on T12's branch. The Flow card shows it in T12's version, Proposed beside Active.", spec: "J11.2",
      target: `[data-mock="card-file"] .mvp-editor-line:nth-child(${ORDER_LINE})`, hold: 3400,
      typing: { into: `line:${FLOW_FILE}:${ORDER_LINE}`, after: ORDER, text: '"docs", "propose"],' },
      show: [{ viewer: MAYA, target: '[data-mock="card-flow"]' }],
      /* T12's machine is awake by now, so the file saves to it as she types. */
      pre: state => {
        branch(state.world, FLOW_BRANCH).machine = "awake"
        setTodo(state, FLOW_TODO, { state: "working", step: "plan", elapsed: "0m" })
        present(state, FLOW_BRANCH, FLOW_AGENT, { kind: "step", step: "plan" })
      },
      act: state => {
        edit(state, FLOW_FILE, ORDER_LINE, `${ORDER}"docs", "propose"],`, MAYA)
        activity(state, FLOW_BRANCH, MAYA, "edit", `Edited flow.ts line ${ORDER_LINE}`)
        setVersion(state, "v2", { steps: stepsOf(EDITED, ["docs"], state.seq) })
      }
    },
    {
      caption: "Run on T12's version asks for a test prompt. The form names the flow revision and the scratch input branch.", spec: "J11.3",
      target: '[data-mock="flow-run"]', hold: 3000,
      show: [{ viewer: MAYA, target: `[data-mock="form-${FORM}-prompt"]` }],
      act: state => {
        ;(state.world.forms ??= []).push({
          id: FORM, title: "Run TODO flow", submit: "Run",
          fields: [
            { id: "flow", label: "Flow revision", value: REVISION },
            { id: "branch", label: "Input branch", value: `${INPUT_NAME} · new from main` },
            { id: "prompt", label: "Prompt", value: "", required: true }
          ]
        })
        state.viewers[MAYA]!.focus = showCard(state, MAYA, "form", FORM)
      }
    },
    {
      caption: "She types a test prompt and presses Return. The run starts at once on maya/try-docs, and the monitor draws the new graph live.", spec: "J11.3",
      target: `[data-mock="form-${FORM}-prompt"]`, typing: { into: `form:${FORM}:prompt`, text: PROMPT }, hold: 3400,
      act: state => {
        const { world } = state
        const form = world.forms!.find(each => each.id === FORM)!
        form.fields.find(each => each.id === "prompt")!.value = PROMPT
        Object.assign(form, { receipt: `Started ${REVISION} on ${INPUT_NAME}`, seq: state.seq })
        world.branches.push({ id: INPUT, name: INPUT_NAME, from: "main", machine: "awake", presence: [], activity: [], terminals: [] })
        stackOp(state, INPUT, "Forked from main", MAYA)
        world.traces.push(TEST_RUN(state.seq))
        present(state, INPUT, TESTER, { kind: "step", step: "plan" })
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
        present(state, INPUT, TESTER, { kind: "step", step: "docs" })
      }
    },
    {
      caption: "Restore. The test run's card stays live in the conversation, on maya/try-docs.", spec: "J11.3",
      target: '[data-mock="restore"]', hold: 2400,
      act: state => { state.viewers[MAYA]!.maximized = undefined }
    },
    {
      caption: "In the branch tree, T12's branch holds Maya and its coding agent. The test run's scratch branch sits beside it, under main.", spec: "J11.3",
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
