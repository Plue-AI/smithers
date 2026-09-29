import { expect, test } from "bun:test"
import type { Card } from "./state/AppState"
import { workerToastActions } from "./WorkerToastActions"
import { runsFlows } from "./flows/entries/runs"
import type { CommandActions } from "./flows/entries/Declare"
import { draftFrom, formFieldsFor, partialPayload, missingFields } from "@smthrs/ui/flow-form"
import { nameOf } from "./flows/registry"

const run = (phase: Extract<Card, { kind: "run-trace" }>["payload"]["phase"], waiting?: string): Extract<Card, { kind: "run-trace" }> => ({
  id: "card-run", kind: "run-trace", title: "Review", status: "active", ordinal: 1, createdAt: 1,
  payload: { repo: "owner/repo", workspaceId: "workspace", runId: "run-1", workflow: "review", phase,
    steps: [], result: null, lastSeq: 0, liveTail: true, ...(waiting ? { waiting } : {}) }
})

test("worker controls follow the current state and keep source-card routing", () => {
  const actions = workerToastActions(run("running"))
  expect(actions.map(a => a.label)).toEqual(["Open tab", "Stop", "Steer", "Model", "Thinking"])
  expect(actions.find(a => a.flow === "flow.run.stop")?.args).toBe("card-run")
  expect(actions.find(a => a.flow === "runs.steer")?.args).toBe("sourceCard=card-run run-1")
  expect(workerToastActions(run("completed")).map(a => a.label)).toEqual(["Open tab"])
  expect(workerToastActions(run("failed")).map(a => a.label)).toEqual(["Open tab", "Run again"])
  expect(workerToastActions(run("running", "approval")).map(a => a.label)).toEqual(["Open tab", "Stop", "Answer"])
  expect(workerToastActions(run("running", "signal")).map(a => a.label)).toEqual(["Open tab", "Stop", "Model", "Thinking", "Resume"])
  expect(workerToastActions(run("reconnecting")).at(-1)?.label).toBe("Reconnect")
})

test("steer, model and thinking forms retain the exact worker and ask only for the missing value", () => {
  const entries = runsFlows({} as CommandActions)
  for (const [name, field] of [["runs.steer", "body"], ["runs.seat", "seat"], ["runs.thinking", "thinking"]]) {
    const action = workerToastActions(run("running")).find(a => a.flow === name)!
    const entry = entries.find(e => nameOf(e) === name)!
    const fields = formFieldsFor(entry.input, entry.metadata.form)
    const payload = partialPayload(fields, entry.metadata.form, action.args)
    expect(payload).toEqual({ sourceCard: "card-run", runId: "run-1" })
    expect(missingFields(fields, draftFrom(fields, payload))).toEqual([field!])
  }
})

test("cloud sessions offer only their supported controls", () => {
  const card = { id: "agent", kind: "agent", title: "Agent", status: "active", ordinal: 1, createdAt: 1,
    payload: { cloud: true, displayName: "Agent", repo: "owner/repo", sessionId: "session-1", provider: null,
      workspaceId: null, state: "active", transcript: [] } } satisfies Extract<Card, { kind: "agent" }>
  expect(workerToastActions(card).map(a => a.flow)).toEqual(["tab.card", "agent.session.stop"])
  expect(workerToastActions({ ...card, payload: { ...card.payload, state: "completed" } }).map(a => a.label)).toEqual(["Open tab"])
})

test("every gate is answered: the toast says the run inbox's verb whether or not its card is open", () => {
  const label = (cards: ReadonlyArray<Card>) => workerToastActions(run("running", "approval"), cards).find(a => a.flow === "approvals.open")?.label
  expect(label([])).toBe("Answer")
})
