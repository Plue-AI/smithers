/*
 * J5's fixtures: the TODO flow's three versions, the flow file the first edit
 * changes, and the TODOs that run on each version (mvp.md J5, §6.12).
 * PR numbers line up with the learning run's evidence: #88, #90 and #91 are
 * the 3 of the last 5 TODOs (#87 to #91) that failed lint at Review.
 */
import type { CodeLine, Evidence, FlowStep, FlowVersion } from "../world"

export const FLOW_FILE = "flows/todo/flow.ts"

const PLAN: FlowStep = { id: "plan", title: "Plan", detail: "Read the TODO and the wiki, then write a plan." }
const IMPLEMENT: FlowStep = { id: "implement", title: "Implement", detail: "Edit the branch until the plan is done." }
const REVIEW: FlowStep = { id: "review", title: "Review", detail: "Review the diff and run lint." }
const PROPOSE: FlowStep = { id: "propose", title: "Propose", detail: "Open or update the pull request with its evidence." }
const CHANGELOG: FlowStep = { id: "changelog", title: "Changelog", detail: "Add an entry to CHANGELOG.md." }

const verify = (detail: string): FlowStep => ({ id: "verify", title: "Verify", detail })

/** The version every TODO runs before Maya's change. */
export const V1_STEPS: ReadonlyArray<FlowStep> = [PLAN, IMPLEMENT, verify("Run typecheck and the tests the change touches."), REVIEW, PROPOSE]
/** Maya's rule: the full test suite in Verify, and a Changelog step before Propose. */
export const V2_STEPS: ReadonlyArray<FlowStep> = [PLAN, IMPLEMENT, verify("Run typecheck and pnpm test."), REVIEW, CHANGELOG, PROPOSE]
/** The learning run's suggestion: lint moves into Verify, where the agent can still fix it. */
export const V3_STEPS: ReadonlyArray<FlowStep> = [PLAN, IMPLEMENT, verify("Run typecheck, pnpm test and lint."), REVIEW, CHANGELOG, PROPOSE]

/** Copies, with `seq` set on the steps that arrive or change in the playing step. */
export const stepsOf = (steps: ReadonlyArray<FlowStep>, fresh: ReadonlyArray<string> = [], seq?: number): Array<FlowStep> =>
  steps.map(step => ({ ...step, ...(fresh.includes(step.id) && seq !== undefined ? { seq } : {}) }))

export const version = (id: string, label: string, state: FlowVersion["state"], steps: ReadonlyArray<FlowStep>, todo?: string): FlowVersion =>
  ({ id, label, state, steps, ...(todo === undefined ? {} : { todo }) })

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
export const ORDER_EDIT = `    order: ["plan", "implement", "verify", "review", "changelog", "propose"],`
export const VERIFY_EDIT = `    verify: ["pnpm typecheck", "pnpm test"],`

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
