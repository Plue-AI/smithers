import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { RunSummaryRow } from "@smthrs/gateway/GatewayProjection"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { projectRuntimeCard, runtimeRunKey } from "../state/RuntimeProjection"
import { timeLabel } from "../Timestamps"
import { WorkflowRunCardBody } from "./RunTraceCard"

/*
 * A run's approved deadline on its run card: the gateway row's `deadlineAt`
 * reaches the card payload, and a live run shows when it passes; a settled run
 * shows nothing.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const REPO = "codeplanesmithers/smithers-demo"
const DEADLINE = Date.UTC(2026, 8, 30, 14, 32)

const runCard = (
  overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>
): Extract<Card, { kind: "run-trace" }> => ({
  id: "flow-run-run-1",
  kind: "run-trace",
  title: "deploy — repo",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, runId: "run-1", workflow: "deploy", phase: "running", steps: [], result: null, lastSeq: 1, ...overrides }
})

const render = (card: Extract<Card, { kind: "run-trace" }>): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <WorkflowRunCardBody card={card} onStopRun={() => {}} onRetryRun={() => {}} onRunCommand={() => {}} />
    )
  })
  return host
}

const deadlineNote = (host: HTMLElement) => host.querySelector("[data-testid='flow-run-deadline-run-1']")

describe("run deadline on the run card", () => {
  test("a live run shows when its deadline passes", () => {
    for (const phase of ["running", "waiting-approval"] as const) {
      expect(deadlineNote(render(runCard({ phase, deadlineAt: DEADLINE })))?.textContent)
        .toBe(`Deadline ${timeLabel(DEADLINE)}`)
    }
  })

  test("a deadline on a later day than today names its date", () => {
    const tomorrow = Date.now() + 36 * 3_600_000
    const label = deadlineNote(render(runCard({ phase: "running", deadlineAt: tomorrow })))?.textContent ?? ""
    expect(label).toBe(`Deadline ${timeLabel(tomorrow)}`)
    expect(label).toContain(new Date(tomorrow).toLocaleDateString([], { month: "short", day: "numeric" }))
  })

  test("a settled run, or one approved without a deadline, shows none", () => {
    for (const phase of ["completed", "failed", "cancelled"] as const) {
      expect(deadlineNote(render(runCard({ phase, deadlineAt: DEADLINE })))).toBeNull()
    }
    expect(deadlineNote(render(runCard({ phase: "running" })))).toBeNull()
  })

  test("the gateway row's deadlineAt reaches the card payload", () => {
    const summary = {
      runId: "run-1",
      flowId: "deploy",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      turns: 0,
      calls: 0,
      callsFailed: 0,
      editsAttempted: 0,
      editsSucceeded: 0,
      inputTokens: 0,
      outputTokens: 0,
      verdict: "running",
      diagnosis: "",
      deadlineAt: DEADLINE
    } satisfies RunSummaryRow
    const card = runCard({})
    const projected = projectRuntimeCard(card, [{
      id: runtimeRunKey({ repo: REPO, runId: "run-1" }),
      summary,
      steps: [],
      events: []
    } as never], [])
    expect(projected.kind === "run-trace" && projected.payload.deadlineAt).toBe(DEADLINE)
  })
})
