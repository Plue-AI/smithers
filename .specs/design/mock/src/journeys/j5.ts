/*
 * J5. Teach the factory (mvp.md §5, P0, everything is a flow). Maya's screen.
 * She tells the app agent a rule. It commits nothing: it proposes the TODO
 * flow's next version and drafts a TODO, and her Commit is the confirmation
 * (A✓). The TODO's coding agent makes the edit on its branch; merged and
 * loaded, the version is Active. Every attempt keeps the flow version it
 * started on (todo.steps): T11 starts on v2 with Changelog, while Alice's T10
 * and its retry stay on v1. The merge queues a learning run, a background
 * run whose receipt holds a lesson and a suggestion; Maya makes the
 * suggestion a TODO, it merges, and the next TODO passes lint the first time.
 */
import type { Journey } from "../journey"
import {
  activity, branch, context, dismissToasts, edit, file, leave, navigate, openFile, present, read, reply, run, say, setTodo, showCard,
  stackOp, STACK, toast, todo, type FlowStep, type FlowVersion, type State
} from "../world"
import { MAYA, seedState } from "./seed"
import {
  FLOW_DRAFT, FLOW_EVIDENCE, FLOW_FILE, FLOW_TODO, flowSource, LESSON_PAGE, lessonPage, LINT_EVIDENCE, LINT_SUGGESTION, LINT_TODO, NEXT_EVIDENCE,
  NEXT_TODO, ORDER_AFTER, ORDER_EDIT, ORDER_LINE, ORDER_TYPED, stepsOf, V1_STEPS, V2_STEPS, V3_STEPS, VERIFY_EDIT, VERIFY_LINE, version
} from "./j5-data"

const RULE = "Every TODO must run pnpm test and update the changelog."
const WHICH = "Which TODOs use the new flow?"
/* The app agent proposes for Maya: "Smithers for Maya" (M-34). */
const SMITHERS_FOR_MAYA = `${MAYA}~smithers`
const CODING = "agent:b-flow"
const DRAFT = "d-flow"
/* The learning run after #89. Its one suggestion shares its id, and its receipt card is the run's. */
const LEARNING = "learn-89"
const LEARNING_TITLE = "Learning from #89"

/** The coding agent on a TODO's branch, at a flow step. */
const agentAt = (state: State, branchId: string, step: string): void => {
  const target = branch(state.world, branchId)
  target.machine = "awake"
  target.presence = [{ who: `agent:${branchId}`, where: { kind: "step", step } }]
}

/** An attempt starts: it pins the active version's steps (mvp.md §6.12), so a later flow change never reaches it. */
const start = (state: State, id: string, step: string, name: string, steps: ReadonlyArray<FlowStep>): void => {
  setTodo(state, id, { state: "working", step, queue: undefined, steps: stepsOf(steps), flowVersion: name, elapsed: "0m" })
  agentAt(state, todo(state.world, id).branch, step)
}

const release = (state: State, id: string, machine: "asleep" | "closed"): void => {
  const target = branch(state.world, id)
  target.machine = machine
  target.presence = []
}

const setVersion = (state: State, id: string, patch: Partial<FlowVersion>): void => {
  state.world.flowVersions = state.world.flowVersions.map(each => each.id === id ? { ...each, ...patch } : each)
}

const setup = (): State => {
  const state = seedState([MAYA])
  const { world } = state
  /*
   * T8 and T9 merged earlier. Alice's T10 started on v1 and is working; Maya's T11 is queued and has not started.
   * Two machines (M-06): once T12 holds one, T11, the learning run and T10's retry each wait their turn for one.
   */
  world.capacity = 2
  world.todos = world.todos.filter(each => each.id === "t-checkout" || each.id === "t-log")
  world.stack = ["t-checkout", "t-log"]
  world.branches = world.branches.filter(each => each.id === "b-checkout" || each.id === "b-log")
  Object.assign(todo(world, "t-checkout"), { steps: stepsOf(V1_STEPS), flowVersion: "v1", elapsed: "6m" })
  Object.assign(todo(world, "t-log"), { queue: undefined })
  Object.assign(branch(world, "b-log"), { machine: "asleep", waitPosition: undefined })
  world.files = []
  world.mergedSinceLook = 0
  world.flowVersions = [version("v1", "v1 · flows/todo/flow.ts · main", "active", stepsOf(V1_STEPS))]
  world.flow = stepsOf(V1_STEPS)
  return state
}

export const j5: Journey = {
  id: "j5",
  title: "Teach the factory",
  spec: "J5",
  intro: "Maya, the owner, wants a new rule for every TODO. Alice's T10 is already working on the current TODO flow, v1.",
  viewers: [MAYA],
  setup,
  steps: [
    {
      spec: "J5.2",
      caption: "She types the rule. The app agent commits nothing: it proposes v2 of the TODO flow and drafts a TODO, placed before T10.",
      keys: "⌘ K", typing: { into: "composer", text: RULE }, hold: 3800,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        const { world } = state
        say(state, MAYA, RULE)
        world.flowVersions.push(version("v2", "v2 · flows/todo/flow.ts · proposed", "proposed", stepsOf(V2_STEPS, ["verify", "changelog"], state.seq), undefined, SMITHERS_FOR_MAYA))
        world.drafts.push({ id: DRAFT, ...FLOW_DRAFT, fixes: false, place: { kind: "before", id: "t-checkout" } })
        /* The draft, then the version it proposes, labeled Proposed: a preview, not an edit. */
        showCard(state, MAYA, "draft", DRAFT)
        showCard(state, MAYA, "flow", "todo", "v2")
      }
    },
    {
      spec: "J5.3",
      caption: "She presses Commit, the one-click confirmation. Only now is it a TODO: T12, first in the stack.",
      target: '[data-mock="draft-commit"]', hold: 2800,
      act: state => {
        const { world } = state
        world.todos.push({ ...FLOW_TODO, steps: stepsOf(V1_STEPS), flowVersion: "v1", seq: state.seq })
        world.stack = [FLOW_TODO.id, ...world.stack]
        world.branches.push({ id: "b-flow", name: "todo-flow-changelog", item: FLOW_TODO.id, from: "main", machine: "waking", presence: [], activity: [], terminals: [] })
        world.drafts.find(each => each.id === DRAFT)!.committed = FLOW_TODO.id
        setVersion(state, "v2", { todo: FLOW_TODO.id, label: "v2 · flows/todo/flow.ts · T12" })
        stackOp(state, "b-flow", "Placed T12 before T10", SMITHERS_FOR_MAYA)
        showCard(state, MAYA, "todo", FLOW_TODO.id)
      }
    },
    {
      spec: "§3.1",
      caption: "She opens T12's branch. Its coding agent read the flow file and is editing it.",
      target: '[data-mock="branch-t-flow"]', hold: 2800,
      act: state => {
        navigate(state, MAYA, "b-flow")
        state.world.files.push({ path: FLOW_FILE, branch: "b-flow", lines: flowSource() })
        setTodo(state, FLOW_TODO.id, { state: "working", step: "implement", elapsed: "1m" })
        agentAt(state, "b-flow", "implement")
        present(state, "b-flow", MAYA, { kind: "branch" })
        present(state, "b-flow", CODING, { kind: "file", path: FLOW_FILE, line: ORDER_LINE })
        openFile(state, FLOW_FILE, CODING, ORDER_LINE)
        context(state, "b-flow", CODING, ["T12 prompt", "@smthrs/flow docs"])
        read(state, "b-flow", CODING, [FLOW_FILE])
        activity(state, "b-flow", CODING, "step", "Planned: Changelog before Propose, and the full pnpm test", "ok")
      }
    },
    {
      spec: "B.3",
      caption: "The coding agent makes the edit the way a teammate does: its flag on line 7, its characters arriving live.",
      target: '[data-mock="where-agent:b-flow"]', hold: 3000,
      typing: { into: `line:${FLOW_FILE}:${ORDER_LINE}`, after: ORDER_AFTER, text: ORDER_TYPED, shared: true },
      pre: state => {
        showCard(state, MAYA, "file", FLOW_FILE)
        present(state, "b-flow", MAYA, { kind: "file", path: FLOW_FILE })
      },
      act: state => {
        edit(state, FLOW_FILE, ORDER_LINE, ORDER_EDIT, CODING)
        edit(state, FLOW_FILE, VERIFY_LINE, VERIFY_EDIT, CODING)
        activity(state, "b-flow", CODING, "edit", "Edited flow.ts lines 7–8", "ok")
      }
    },
    {
      spec: "J5.3",
      caption: "Back in main, T12 has opened PR #89. Its checks pass, and the edited flow loads.",
      target: '[data-mock="crumb-main"]', hold: 3000,
      act: state => {
        navigate(state, MAYA, "main")
        leave(state, "b-flow", MAYA)
        file(state.world, FLOW_FILE).editors = []
        setTodo(state, FLOW_TODO.id, { state: "in-review", step: undefined, elapsed: undefined, pr: 89, evidence: FLOW_EVIDENCE })
        release(state, "b-flow", "asleep")
        setTodo(state, "t-checkout", { step: "verify", elapsed: "11m" })
        agentAt(state, "b-checkout", "verify")
      }
    },
    {
      spec: "§6.12",
      caption: "She merges. Until the install loads it, the Flow card reads Merged · active after sync, and a learning run queues.",
      target: '[data-mock="evidence-t-flow"] [data-mock="merge-t-flow"]', hold: 3200,
      act: state => {
        setTodo(state, FLOW_TODO.id, { state: "merged" })
        release(state, "b-flow", "closed")
        setVersion(state, "v2", { state: "merged-syncing", label: "v2 · flows/todo/flow.ts · main" })
        run(state, { id: LEARNING, title: LEARNING_TITLE, state: "running", queue: 1, todo: FLOW_TODO.id })
        toast(state, MAYA, { tone: "running", title: LEARNING_TITLE, detail: "Queued" })
        showCard(state, MAYA, "flow", "todo")
      }
    },
    {
      spec: "J5.3",
      caption: "The install syncs and loads it: v2 is Active for every TODO that starts from now on.",
      hold: 3200,
      act: state => {
        setVersion(state, "v1", { state: "previous" })
        setVersion(state, "v2", { state: "active", steps: stepsOf(V2_STEPS, ["changelog"], state.seq) })
        state.world.flow = stepsOf(V2_STEPS)
        /* T12's machine is free again. T11 waited longest, so it starts, on v2; the learning run stays queued. */
        start(state, "t-log", "plan", "v2", V2_STEPS)
        toast(state, MAYA, { tone: "ok", title: "TODO flow v2 is active", detail: "New TODOs use it" })
        showCard(state, MAYA, "flow", "todo")
      }
    },
    {
      spec: "J5.4",
      caption: "T11 started after, so it runs v2, with Changelog. Alice's T10 started before, so it keeps v1.",
      keys: "⌘ K", typing: { into: "composer", text: WHICH }, hold: 3800,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        say(state, MAYA, WHICH)
        setTodo(state, "t-log", { step: "implement", elapsed: "3m" })
        agentAt(state, "b-log", "implement")
        reply(state, MAYA, "T11 started on v2. T10 started on v1 and keeps it.")
        showCard(state, MAYA, "todo", "t-checkout")
        showCard(state, MAYA, "todo", "t-log")
      }
    },
    {
      spec: "B.4",
      caption: "T10 fails at Review: the model provider timed out. Its card offers Retry, and Retry with the current flow.",
      hold: 3200,
      act: state => {
        setTodo(state, "t-checkout", { state: "failed", step: "review", failure: "Model provider timed out", elapsed: undefined })
        release(state, "b-checkout", "asleep")
        setTodo(state, "t-log", { step: "verify", elapsed: "7m" })
        agentAt(state, "b-log", "verify")
        /* T10's machine is free, so the learning run starts. */
        run(state, { id: LEARNING, title: LEARNING_TITLE, state: "running", queue: undefined })
        toast(state, MAYA, { tone: "running", title: LEARNING_TITLE, detail: "Working" })
        showCard(state, MAYA, "todo", "t-checkout")
      }
    },
    {
      spec: "§4.1",
      caption: "She presses Retry. T10 queues again as attempt 2, waiting for a machine.",
      target: '[data-mock="retry-t-checkout"]', hold: 2600,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => {
        setTodo(state, "t-checkout", { state: "queued", queue: 1, step: undefined, failure: undefined, attempts: 2 })
        showCard(state, MAYA, "todo", "t-checkout")
      }
    },
    {
      spec: "§6.12",
      caption: "Attempt 2 runs v1 again, still without Changelog, while T11 reaches Changelog on v2. A retry keeps its flow.",
      hold: 3400,
      act: state => {
        const { world } = state
        /* The learning run finished and freed its machine: attempt 2 starts, on the version T10 started with. */
        setTodo(state, "t-checkout", { state: "working", queue: undefined, step: "plan", elapsed: "0m" })
        agentAt(state, "b-checkout", "plan")
        setTodo(state, "t-log", { step: "changelog", elapsed: "12m" })
        agentAt(state, "b-log", "changelog")
        activity(state, "b-log", "agent:b-log", "step", "Adding an entry to CHANGELOG.md", "run")
        /* Meanwhile the learning run finishes: one lesson in the wiki, and one suggestion. */
        world.wiki.push(lessonPage(state.seq))
        world.proposals.push({ id: LEARNING, ...LINT_SUGGESTION })
        run(state, { id: LEARNING, title: LEARNING_TITLE, state: "done", detail: "1 lesson · 1 suggestion", lessons: [LESSON_PAGE] })
        setTodo(state, FLOW_TODO.id, { lessons: 1 })
        toast(state, MAYA, { tone: "ok", title: LEARNING_TITLE, detail: "1 lesson · 1 suggestion", action: "Open" })
        showCard(state, MAYA, "todo", "t-checkout")
      }
    },
    {
      spec: "B.5",
      caption: "Meanwhile the learning run finished. Its receipt links the lesson it wrote, and suggests lint in Verify with its evidence.",
      target: '[data-mock="toast-open"]', hold: 3800,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => { showCard(state, MAYA, "proposal", LEARNING) }
    },
    {
      spec: "B.4",
      caption: "She makes it a TODO. The receipt now reads Committed as T13, and a person still merges it.",
      target: `[data-mock="proposal-todo-${LEARNING}"]`, hold: 3000,
      act: state => {
        const { world } = state
        world.todos.push({ ...LINT_TODO, queue: 1, seq: state.seq })
        world.stack.push(LINT_TODO.id)
        world.branches.push({ id: "b-lint", name: "todo-flow-lint", item: LINT_TODO.id, from: "main", machine: "asleep", presence: [], activity: [], terminals: [] })
        world.proposals.find(each => each.id === LEARNING)!.todo = LINT_TODO.id
        world.flowVersions.push(version("v3", "v3 · flows/todo/flow.ts · T13", "proposed", stepsOf(V3_STEPS), LINT_TODO.id, STACK))
        showCard(state, MAYA, "todo", LINT_TODO.id)
      }
    },
    {
      spec: "J5.5",
      caption: "Later, T10 and T11 merge. T13 opens PR #92 and is next to merge.",
      hold: 3000,
      act: state => {
        for (const [id, pr] of [["t-checkout", 90], ["t-log", 91]] as const) {
          setTodo(state, id, { state: "merged", step: undefined, elapsed: undefined, pr, lessons: 1 })
          release(state, todo(state.world, id).branch, "closed")
          run(state, { id: `learn-${pr}`, title: `Learning from #${pr}`, state: "done", detail: "1 lesson", todo: id })
        }
        /* T13 started once a machine freed up, on v2, the active version then. */
        setTodo(state, LINT_TODO.id, { state: "in-review", queue: undefined, pr: 92, evidence: LINT_EVIDENCE, steps: stepsOf(V2_STEPS), flowVersion: "v2" })
        showCard(state, MAYA, "todo", LINT_TODO.id)
      }
    },
    {
      spec: "J5.5",
      caption: "She merges T13. Once the install loads it, v3 is Active, and Verify runs lint.",
      target: '[data-mock="evidence-t-lint"] [data-mock="merge-t-lint"]', hold: 3200,
      act: state => {
        setTodo(state, LINT_TODO.id, { state: "merged" })
        release(state, "b-lint", "closed")
        setVersion(state, "v2", { state: "previous" })
        setVersion(state, "v3", { state: "active", label: "v3 · flows/todo/flow.ts · main", steps: stepsOf(V3_STEPS, ["verify"], state.seq) })
        state.world.flow = stepsOf(V3_STEPS)
        run(state, { id: "learn-92", title: "Learning from #92", state: "running", todo: LINT_TODO.id })
        toast(state, MAYA, { tone: "running", title: "Learning from #92", detail: "Working" })
        showCard(state, MAYA, "flow", "todo", "v3")
      }
    },
    {
      spec: "J5.5",
      caption: "Later she opens her next TODO, T14. It ran v3: lint passed at Verify the first time, so Review sent nothing back.",
      keys: "⌘ K", typing: { into: "composer", text: "/todo T14" }, hold: 3800,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        const { world } = state
        say(state, MAYA, "/todo T14")
        world.todos.push({ ...NEXT_TODO, steps: stepsOf(V3_STEPS), flowVersion: "v3", evidence: NEXT_EVIDENCE, seq: state.seq })
        world.stack.push(NEXT_TODO.id)
        world.branches.push({ id: "b-next", name: "refund-audit-log", item: NEXT_TODO.id, from: "main", machine: "asleep", presence: [], activity: [], terminals: [] })
        showCard(state, MAYA, "todo", NEXT_TODO.id)
      }
    }
  ]
}
