/*
 * J5. Teach the factory (mvp.md §5, P0, everything is a flow). Maya's screen.
 * She tells the app agent a rule; it proposes an edit to the TODO flow, which
 * becomes a TODO like any other. Once merged and loaded it is Active: TODOs
 * started afterwards get the new step, while a running one keeps its version.
 * Later a learning run suggests another change, backed by evidence.
 *
 * The TODO card draws its step strip from world.flow, so world.flow follows
 * the strips on screen: it stays on the old version until a TODO started on
 * the new one appears, and by then the old version's card is out of view.
 */
import type { Journey } from "../journey"
import { activity, branch, dismissToasts, edit, reply, run, say, setTodo, showCard, toast, type FlowVersion, type State, type Todo } from "../world"
import { CHECKOUT, LOGGING, MAYA, seedState } from "./seed"
import {
  VERIFY_EDIT, VERIFY_LINE, FLOW_EVIDENCE, FLOW_FILE, flowSource, LINT_EVIDENCE, NEXT_EVIDENCE, ORDER_EDIT, ORDER_LINE,
  stepsOf, V1_STEPS, V2_STEPS, V3_STEPS, version
} from "./j5-data"

const RULE = "Every TODO must run pnpm test and update the changelog."
const OLD_QUESTION = "Which running TODOs stay on the old version?"
const NEW_TODO = "Add a TODO: log every webhook retry attempt with its delay."
/* The app agent proposes as Maya: "Maya via Smithers". */
const MAYA_VIA_SMITHERS = `${MAYA}~smithers`

const startOn = (state: State, value: Todo, name: string, step: string): void => {
  const { world } = state
  world.todos.push({ ...value, state: "working", step, seq: state.seq })
  world.stack.push(value.id)
  world.branches.push({
    id: value.branch, name, item: value.id, from: "main", machine: "awake", activity: [], terminals: [],
    presence: [{ who: `agent:${value.branch}`, where: { kind: "step", step } }]
  })
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
  world.todos = []
  world.stack = []
  world.branches = []
  world.files = []
  world.mergedSinceLook = 0
  world.flowVersions = [version("v1", "flows/todo/flow.ts · main", "active", stepsOf(V1_STEPS))]
  world.flow = stepsOf(V1_STEPS)
  return state
}

export const j5: Journey = {
  id: "j5",
  title: "Teach the factory",
  spec: "J5",
  intro: "Maya, the owner, wants a new rule for every TODO. She tells the app agent.",
  viewers: [MAYA],
  setup,
  steps: [
    {
      caption: "She types the rule. The app agent opens the TODO flow with the change proposed: pnpm test in Verify, and a new Changelog step.",
      keys: "⌘ K", typing: { into: "composer", text: RULE }, hold: 3200,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        const { world } = state
        say(state, MAYA, RULE)
        startOn(state, { id: "t-flow", title: "Run pnpm test and update the changelog", owner: MAYA, branch: "b-flow", state: "working", prompt: RULE, elapsed: "0m" },
          "todo-flow-changelog", "plan")
        world.files.push({ path: FLOW_FILE, branch: "b-flow", lines: flowSource() })
        edit(state, FLOW_FILE, ORDER_LINE, ORDER_EDIT, MAYA_VIA_SMITHERS)
        edit(state, FLOW_FILE, VERIFY_LINE, VERIFY_EDIT, MAYA_VIA_SMITHERS)
        world.flowVersions.push(version("v2", "flows/todo/flow.ts · todo-flow-changelog", "proposed", stepsOf(V2_STEPS, ["verify", "changelog"], state.seq), "t-flow"))
        reply(state, MAYA, "Proposed as a TODO.")
        showCard(state, MAYA, "flow", "todo", "v2")
      }
    },
    {
      caption: "Here is the edit as a diff of flows/todo/flow.ts. It is already a TODO like any other, working on its own branch.",
      hold: 3000,
      act: state => {
        showCard(state, MAYA, "diff", FLOW_FILE)
        setTodo(state, "t-flow", { step: "implement", elapsed: "1m" })
        branch(state.world, "b-flow").presence = [{ who: "agent:b-flow", where: { kind: "step", step: "implement" } }]
        showCard(state, MAYA, "todo", "t-flow")
        // Meanwhile Alice starts a TODO. The change isn't merged, so it runs on the active version.
        startOn(state, { ...structuredClone(CHECKOUT), elapsed: "0m" }, "fix-checkout-race", "plan")
      }
    },
    {
      caption: "It runs on the current flow and opens PR #89. Its checks pass, and the edited flow loads.",
      hold: 2800,
      act: state => {
        setTodo(state, "t-flow", { state: "in-review", step: undefined, elapsed: undefined, pr: 89, evidence: FLOW_EVIDENCE })
        release(state, "b-flow", "asleep")
        setVersion(state, "v2", { label: "flows/todo/flow.ts · PR #89" })
        setTodo(state, "t-checkout", { step: "implement", elapsed: "4m" })
      }
    },
    {
      caption: "She merges it. Until the install loads it, the Flow card shows Merged · active after sync.",
      target: '[data-mock="evidence-t-flow"] [data-mock="merge-t-flow"]', hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="card-flow"]' }],
      act: state => {
        setTodo(state, "t-flow", { state: "merged" })
        release(state, "b-flow", "closed")
        setVersion(state, "v2", { state: "merged-syncing", label: "flows/todo/flow.ts · main" })
      }
    },
    {
      caption: "She asks which TODOs stay on the old version. Alice's started before the merge, so it keeps its steps, without Changelog.",
      keys: "⌘ K", typing: { into: "composer", text: OLD_QUESTION }, hold: 3200,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        say(state, MAYA, OLD_QUESTION)
        setTodo(state, "t-checkout", { step: "verify", elapsed: "9m" })
        branch(state.world, "b-checkout").presence = [{ who: "agent:b-checkout", where: { kind: "step", step: "verify" } }]
        reply(state, MAYA, "Alice's checkout fix, started before the merge.")
        showCard(state, MAYA, "todo", "t-checkout")
      }
    },
    {
      caption: "The install syncs the merge and loads the new flow. The timeline reports it is active.",
      hold: 2600,
      show: [{ viewer: MAYA, target: '[data-mock="card-flow"]' }],
      act: state => {
        setVersion(state, "v1", { state: "previous" })
        setVersion(state, "v2", { state: "active" })
        toast(state, MAYA, { tone: "ok", title: "TODO flow updated", detail: "#89 is active for new TODOs", action: "Open" })
      }
    },
    {
      caption: "She opens it. The merged version is Active, with its Changelog step.",
      target: '[data-mock="toast-open"]', hold: 2600,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => {
        setVersion(state, "v2", { steps: stepsOf(V2_STEPS, ["changelog"], state.seq) })
        showCard(state, MAYA, "flow", "todo", "v2")
      }
    },
    {
      caption: "She adds a TODO. It starts on the new version, so its steps include Changelog.",
      keys: "⌘ K", typing: { into: "composer", text: NEW_TODO }, hold: 3000,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        say(state, MAYA, NEW_TODO)
        state.world.flow = stepsOf(V2_STEPS, ["changelog"], state.seq)
        startOn(state, { ...structuredClone(LOGGING), queue: undefined, prompt: "Log every webhook retry attempt with its delay.", elapsed: "0m" }, "log-retries", "plan")
        reply(state, MAYA, "Added to the stack.")
        showCard(state, MAYA, "todo", "t-log")
      }
    },
    {
      caption: "Minutes later it reaches the new step, Changelog. Alice's TODO merged on the version it started with.",
      hold: 2800,
      act: state => {
        setTodo(state, "t-log", { step: "changelog", elapsed: "14m" })
        branch(state.world, "b-log").presence = [{ who: "agent:b-log", where: { kind: "step", step: "changelog" } }]
        activity(state, "b-log", "agent:b-log", "step", "Adding an entry to CHANGELOG.md", "run")
        setTodo(state, "t-checkout", { state: "merged", step: undefined, elapsed: undefined, pr: 90, lessons: 2 })
        release(state, "b-checkout", "closed")
      }
    },
    {
      caption: "Later it merges too, and the learning run after #91 suggests a change to the flow.",
      hold: 2800,
      act: state => {
        setTodo(state, "t-log", { state: "merged", step: undefined, elapsed: undefined, pr: 91, lessons: 2 })
        release(state, "b-log", "closed")
        run(state, { id: "learn-91", title: "Learning from #91", state: "done", detail: "1 suggestion" })
        state.world.proposals.push({ id: "p-lint", title: "Add lint to the Verify step", evidence: "3 of the last 5 TODOs failed lint at Review.", refs: [88, 90, 91] })
        toast(state, MAYA, { tone: "attention", title: "Learning suggests a flow change", detail: "Add lint to the Verify step", action: "Open" })
      }
    },
    {
      caption: "The suggestion carries its evidence: 3 of the last 5 TODOs failed lint at Review.",
      target: '[data-mock="toast-open"]', hold: 2800,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => { showCard(state, MAYA, "proposal", "p-lint") }
    },
    {
      caption: "She makes it a TODO. Like her own change, a person has to merge it.",
      target: '[data-mock="proposal-todo-p-lint"]', hold: 2600,
      act: state => {
        startOn(state, { id: "t-lint", title: "Add lint to the Verify step", owner: MAYA, branch: "b-lint", state: "working", prompt: "Run pnpm lint in the TODO flow's Verify step.", elapsed: "0m" },
          "todo-flow-lint", "plan")
        state.world.proposals.find(each => each.id === "p-lint")!.todo = "t-lint"
        state.world.flowVersions.push(version("v3", "flows/todo/flow.ts · todo-flow-lint", "proposed", stepsOf(V3_STEPS), "t-lint"))
        showCard(state, MAYA, "todo", "t-lint")
      }
    },
    {
      caption: "It opens PR #92 with its evidence.",
      hold: 2400,
      act: state => {
        setTodo(state, "t-lint", { state: "in-review", step: undefined, elapsed: undefined, pr: 92, evidence: LINT_EVIDENCE })
        release(state, "b-lint", "asleep")
        setVersion(state, "v3", { label: "flows/todo/flow.ts · PR #92" })
      }
    },
    {
      caption: "She merges it.",
      target: '[data-mock="evidence-t-lint"] [data-mock="merge-t-lint"]', hold: 2200,
      act: state => {
        setTodo(state, "t-lint", { state: "merged" })
        release(state, "b-lint", "closed")
        setVersion(state, "v3", { state: "merged-syncing", label: "flows/todo/flow.ts · main" })
      }
    },
    {
      caption: "Once it loads, Verify runs lint for every new TODO. Later, Maya's next TODO opens PR #93.",
      hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-flow"]' }],
      act: state => {
        setVersion(state, "v2", { state: "previous" })
        setVersion(state, "v3", { state: "active", steps: stepsOf(V3_STEPS, ["verify"], state.seq) })
        state.world.flow = stepsOf(V3_STEPS)
        startOn(state, { id: "t-next", title: "Add an audit log for refunds", owner: MAYA, branch: "b-next", state: "working",
          prompt: "Record every refund in an audit log: who, when, amount and reason." }, "refund-audit-log", "propose")
        setTodo(state, "t-next", { state: "in-review", step: undefined, pr: 93, evidence: NEXT_EVIDENCE })
        release(state, "b-next", "asleep")
        toast(state, MAYA, { tone: "ok", title: "PR #93 is ready for review", detail: "Add an audit log for refunds", action: "Open" })
      }
    },
    {
      caption: "Lint passed at Verify on the first run, so Review had nothing to send back.",
      target: '[data-mock="toast-open"]', hold: 3200,
      pre: state => { dismissToasts(state, MAYA) },
      act: state => { showCard(state, MAYA, "todo", "t-next") }
    }
  ]
}
