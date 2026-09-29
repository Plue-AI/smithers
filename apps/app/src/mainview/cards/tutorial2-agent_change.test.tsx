import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CodingPlanBody } from "./CodingPlanCard"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import type { Card } from "../state/AppState"
const card: Extract<Card, { kind: "run-trace" }> = { id: "plan", kind: "run-trace", title: "Plan", status: "active", createdAt: 0, ordinal: 1,
  payload: { repo: "o/r", runId: "plan", workflow: "tutorial-change", kind: "change-plan", phase: "completed", steps: [], result: null, lastSeq: 0,
    input: { plan: { ...CODING_PLAN, changes: [CODING_PLAN.changes[0]!] } } } }
test("review shows actual plan and keyboard-native start door before any commit strip", () => {
  const html = renderToStaticMarkup(<CodingPlanBody card={card} onRunCommand={() => {}} />)
  expect(html).toContain(CODING_PLAN.base.commitId)
  expect(html).toContain('aria-label="Planned commits"')
  expect(html).toContain('data-flow="agent.change.start"')
  expect(html).toContain('type="button"')
  expect(html).not.toContain('aria-label="Resulting commit"')
})

test("a started plan shows the run it became and a door to it, never a stale Start; a stopped start keeps the door and says why", () => {
  const started = { ...card, status: "acted" as const, payload: { ...card.payload, input: { ...card.payload.input, started: { runId: "run-9", cardId: "flow-run-run-9" } } } }
  const html = renderToStaticMarkup(<CodingPlanBody card={started} onRunCommand={() => {}} />)
  expect(html).not.toContain('data-flow="agent.change.start"')
  expect(html).toContain("Started as run")
  expect(html).toContain("run-9")
  expect(html).toContain('data-flow="card.maximize"')
  expect(html).toContain("Expand run")
  const sent: Array<{ name: string; args?: string }> = []
  const stopped = { ...card, payload: { ...card.payload, error: "HEAD moved; request a new plan." } }
  const withError = renderToStaticMarkup(<CodingPlanBody card={stopped} onRunCommand={(name, args) => sent.push({ name, args })} />)
  expect(withError).toContain('role="alert"')
  expect(withError).toContain('data-failure="CodingStartFailed"')
  expect(withError).toContain('data-fault="infra"')
  /* The stop's own words wait behind a closed Details; the sentence is the product's. */
  expect(withError).toContain("<p>Smithers could not start this change. Not your fault.</p>")
  expect(withError).not.toContain("<p>HEAD moved; request a new plan.</p>")
  expect(withError).toContain("<details><summary>Details</summary><pre tabindex=\"0\">HEAD moved; request a new plan.</pre></details>")
  expect(withError).toContain('data-flow="agent.change.start"')
  /* The plan card never repeats itself as a predicted-changes outline. */
  expect(html).not.toContain('aria-label="Predicted Changes"')
  expect(withError).not.toContain('aria-label="Predicted Changes"')
})

test("the run card shows its goals and receipt without claiming that the plan was verified", () => {
  const sha = "e".repeat(40)
  const run = { ...card, id: "flow-run-run-9", payload: { ...card.payload, kind: "change", runId: "run-9",
    input: { ...card.payload.input, tutorialReceipt: { runId: "run-9", repo: "o/r", base: CODING_PLAN.base.commitId, parent: CODING_PLAN.base.commitId, sha, subject: "Store repository memory", files: ["src/memory.ts"] } } } }
  const html = renderToStaticMarkup(<CodingPlanBody card={run} onRunCommand={() => {}} />)
  expect(html).toContain('aria-label="Goals"')
  expect(html).toContain('data-state="pending"')
  expect(html).not.toContain('data-flow="agent.change.start"')
  expect(html).toContain('aria-label="Resulting commit"')
  expect(html.indexOf('aria-label="Goals"')).toBeLessThan(html.indexOf('aria-label="Resulting commit"'))
})
