/*
 * J5's fixtures: the TODO flow's three versions, the flow file the first edit
 * changes, the TODOs that run on each version, and what the learning run
 * after #89 leaves (mvp.md J5, §6.12, B.5). Refs follow commit order (T12,
 * T13, T14 after the seed's T10 and T11), and PR numbers the order PRs open:
 * T12 #89, T10 #90, T11 #91, T13 #92, T14 #93. The learning run's evidence is
 * the 3 of the last 5 TODOs before #89 that failed lint at Review.
 */
import { STACK, type ActorId, type CodeLine, type Evidence, type FlowStep, type FlowVersion, type Todo, type WikiPage } from "../world"
import { MAYA } from "./seed"

export const FLOW_FILE = "flows/todo/flow.ts"

const PLAN: FlowStep = { id: "plan", title: "Plan", detail: "Read the TODO and the wiki, then write a plan." }
const IMPLEMENT: FlowStep = { id: "implement", title: "Implement", detail: "Edit the branch until the plan is done." }
const REVIEW: FlowStep = { id: "review", title: "Review", detail: "Review the diff and run lint." }
const PROPOSE: FlowStep = { id: "propose", title: "Propose", detail: "Open or update the pull request with its evidence." }
const CHANGELOG: FlowStep = { id: "changelog", title: "Changelog", detail: "Add an entry to CHANGELOG.md." }

const verify = (detail: string): FlowStep => ({ id: "verify", title: "Verify", detail })

/** v1: the version every TODO runs before Maya's change. */
export const V1_STEPS: ReadonlyArray<FlowStep> = [PLAN, IMPLEMENT, verify("Run typecheck and the tests the change touches."), REVIEW, PROPOSE]
/** v2, Maya's rule: the full test suite in Verify, and a Changelog step before Propose. */
export const V2_STEPS: ReadonlyArray<FlowStep> = [PLAN, IMPLEMENT, verify("Run typecheck and pnpm test."), REVIEW, CHANGELOG, PROPOSE]
/** v3, the learning run's suggestion: lint moves into Verify, where the agent can still fix it. */
export const V3_STEPS: ReadonlyArray<FlowStep> = [PLAN, IMPLEMENT, verify("Run typecheck, pnpm test and lint."), REVIEW, CHANGELOG, PROPOSE]

/** Copies, with `seq` set on the steps that arrive or change in the playing step. */
export const stepsOf = (steps: ReadonlyArray<FlowStep>, fresh: ReadonlyArray<string> = [], seq?: number): Array<FlowStep> =>
  steps.map(step => ({ ...step, ...(fresh.includes(step.id) && seq !== undefined ? { seq } : {}) }))

export const version = (id: string, label: string, state: FlowVersion["state"], steps: ReadonlyArray<FlowStep>, todo?: string, by?: ActorId): FlowVersion =>
  ({ id, label, state, steps, ...(todo === undefined ? {} : { todo }), ...(by === undefined ? {} : { by }) })

const code = (text: string): Array<CodeLine> => text.split("\n").map((line, index) => ({ n: index + 1, text: line }))

/** The repository's own copy of the TODO flow, as main has it before the change. */
export const flowSource = (): Array<CodeLine> => code(`import { Flow } from "@smthrs/flow"
import { todo } from "@smthrs/flow/todo"

export default Flow.make("todo", {
  ...todo,
  body: todo.steps({
    order: ["plan", "implement", "verify", "review", "propose"],
    verify: ["pnpm typecheck", "pnpm test --changed"],
    review: ["pnpm lint"]
  })
})`)

export const ORDER_LINE = 7
export const VERIFY_LINE = 8
/** Line 7 up to where the coding agent types: Changelog goes before Propose. */
export const ORDER_AFTER = `    order: ["plan", "implement", "verify", "review", `
export const ORDER_TYPED = `"changelog", "propose"],`
export const ORDER_EDIT = `${ORDER_AFTER}${ORDER_TYPED}`
export const VERIFY_EDIT = `    verify: ["pnpm typecheck", "pnpm test"],`

/** What the app agent drafts from Maya's rule; nothing reaches the stack until she commits it. */
export const FLOW_DRAFT = {
  title: "Run pnpm test and update the changelog",
  prompt: "In flows/todo/flow.ts, run the full pnpm test in Verify and add a Changelog step before Propose."
}

export const FLOW_TODO: Todo = { id: "t-flow", ref: "T12", title: FLOW_DRAFT.title, prompt: FLOW_DRAFT.prompt, owner: MAYA, branch: "b-flow", state: "starting" }

export const LINT_TODO: Todo = {
  id: "t-lint", ref: "T13", title: "Add lint to the Verify step", owner: MAYA, branch: "b-lint", state: "queued",
  prompt: "In flows/todo/flow.ts, run pnpm lint in the Verify step."
}

export const NEXT_TODO: Todo = {
  id: "t-next", ref: "T14", title: "Add an audit log for refunds", owner: MAYA, branch: "b-next", state: "in-review", pr: 93,
  prompt: "Record every refund in an audit log: who, when, amount and reason."
}

/** The learning run's one suggestion; it shares the run's id. */
export const LINT_SUGGESTION = { title: "Add lint to the Verify step", evidence: "3 of the last 5 TODOs failed lint at Review.", refs: [85, 87, 88] } as const

export const LESSON_PAGE = "todo-flow"

/** The lesson the learning run writes after #89: the decision, why, and where it lives. */
export const lessonPage = (seq: number): WikiPage => ({
  id: LESSON_PAGE, title: "TODO flow", rev: 1, authors: [STACK], seq,
  lines: [
    { n: 1, text: "Every TODO runs `pnpm test` and adds a CHANGELOG.md entry." },
    { n: 2, text: "Why: Maya's rule, merged as T12." },
    { n: 3, text: "Flow: `flows/todo/flow.ts`, v2" }
  ],
  decision: { from: 1, to: 2, by: STACK, change: 89 }
})

const passed = (name: string, took: string) => ({ name, state: "passed" as const, took })

export const FLOW_EVIDENCE: Evidence = {
  files: 1, added: 2, removed: 2,
  checks: [passed("typecheck", "9s"), passed("test", "52s"), passed("flow loads", "2s")],
  github: { passed: 5, total: 5 },
  review: "The TODO flow loads with the Changelog step."
}

export const LINT_EVIDENCE: Evidence = {
  files: 1, added: 1, removed: 1,
  checks: [passed("typecheck", "9s"), passed("test", "55s"), passed("lint", "7s"), passed("flow loads", "2s")],
  github: { passed: 5, total: 5 },
  review: "The TODO flow loads, and Verify now runs lint."
}

export const NEXT_EVIDENCE: Evidence = {
  files: 3, added: 41, removed: 12,
  checks: [passed("typecheck", "12s"), passed("test", "1m 03s"), passed("lint", "8s")],
  github: { passed: 5, total: 5 },
  review: "No blocking issues. Lint passed at Verify on the first run."
}
