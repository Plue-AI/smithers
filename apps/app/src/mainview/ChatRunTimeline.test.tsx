import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "./state/AppState"
import { ChatRunTimeline, monitoredRun } from "./ChatRunTimeline"

const run = (id: string, ordinal: number, phase: Extract<Card, { kind: "run-trace" }>["payload"]["phase"] = "running"): Extract<Card, { kind: "run-trace" }> => ({
  id, ordinal, kind: "run-trace", title: id, createdAt: ordinal, status: "active",
  payload: { runId: id, repo: "a/b", workflow: "probe", phase, steps: [], result: null, lastSeq: 2,
    events: [{ sequence: 1, occurredAt: 1000, kind: "control.agent.turn-opened", payload: {} },
      { sequence: 2, occurredAt: 2000, kind: "control.agent.cell-call-started", payload: { flowName: "read", input: { path: "README.md" } } }] }
})

test("a running job stays reachable after a newer job completes", () => {
  const active = run("older", 1)
  expect(monitoredRun([active, run("newer", 2, "completed")])).toBe(active)
})

test("empty journals do not replace a recorded run or invent a strip", () => {
  const recorded = run("recorded", 1, "completed")
  const empty = run("empty", 2); empty.payload.events = []
  expect(monitoredRun([recorded, empty])).toBe(recorded)
  expect(renderToStaticMarkup(<ChatRunTimeline cards={[empty]} onRunCommand={() => {}} />)).toBe("")
})

test("the dock shares source identity and saved cursor with its embedded run", () => {
  const card = run("source-card", 1)
  card.payload.runId = "backend-id"
  card.payload.cursorSeq = 1; card.payload.liveTail = false
  const html = renderToStaticMarkup(<ChatRunTimeline cards={[card]} onRunCommand={() => {}} />)
  expect(html).toContain('aria-label="Run timeline"')
  expect(html).toContain('aria-valuenow="1"')
  expect(html).toContain('data-flow="runs.trace.live"')
  expect(html).toContain('data-flow-args="backend-id"')
  expect(html).toContain('data-phase-band="researching"')
})
