import { observeRuntimeRun, projectRuntimeCard, runtimeRunKey, type RuntimeRun, type RuntimeRunObservation } from "./RuntimeProjection"
import { expect, spyOn, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { ControllerContext } from "./controller/context"
import { createWorkflowPumpController } from "./controller/workflow-pump"

// Isolate the pump's quiet clock from the app's independent persistence clocks.
// The full Runs/Wave11 cases exercise the real dispatcher, storage and gateway.
test("same-sequence suffix offsets reset the quiet bound until native observation settles", async () => {
  const id = "vibe-card", runId = "vibe-run"
  let card: Extract<Card, { kind: "run-trace" }> = { id, kind: "run-trace", title: "Vibe", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", workspaceId: "83e75ae5-0920-4000-8000-000000000001", gatewayBindingVersion: 1,
      runId, workflow: "coding/vibe", phase: "running", steps: [], result: null, lastSeq: 0 } }
  let now = 0, reads = 0
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  const cursors: Array<unknown> = [], messages: string[] = []
  const marker = { version: 1, executionId: runId, generation: 0 }
  const events = [
    { sequence: 1, occurredAt: 1, kind: "control.engine.projection-started", payload: marker },
    ...Array.from({ length: 5 }, (_, index) => ({ sequence: 1, occurredAt: index + 2,
      kind: "control.agent.turn-opened", payload: { turn: index + 1 } })),
    { sequence: 1, occurredAt: 7, kind: "control.engine.projection-settled", payload: marker }
  ]
  const runPumps = new Map<string, { stopped: boolean }>()
  const scope = { repo: card.payload.repo, workspaceId: card.payload.workspaceId, runId }, key = runtimeRunKey(scope)
  const runtimeRuns = new Map<string, RuntimeRun>()
  const ctx = {
    store: { committedRuntimeRun: (id: string) => runtimeRuns.get(id), committedRuntimeApproval: () => undefined, collections: { cards: { get: () => card, values: () => [card].values() }, runtimeRuns, runtimeApprovals: new Map() },
      dispatch: (event: { type: string; observation?: RuntimeRunObservation; text?: string }) => {
        if (event.type === "gateway.run.observed") {
          runtimeRuns.set(key, observeRuntimeRun(runtimeRuns.get(key), event.observation!, now, reads))
          card = projectRuntimeCard(card, [...runtimeRuns.values()], []) as typeof card
        }
        if (event.type === "message.appended") messages.push(event.text!)
        return { isPersisted: { promise: Promise.resolve() } }
      } },
    gateway: {
      run: async () => ({ status: "ok", cursor: { selector: { _tag: "run-summary", runId }, projection: "run-summary", runId, value: 1, offset: 0 },
        value: { runId, flowId: "coding/vibe", status: "completed", createdAt: 1, updatedAt: 2, turns: 0, calls: 0,
          callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: "Finalization finished", diagnosis: "done" } }),
      runEvents: async (_repo: string, _runId: string, binding: unknown, after: unknown) => {
        expect(binding).toEqual({ workspaceId: card.payload.workspaceId })
        cursors.push(after)
        if (reads > 0) now += 80 // Repeated progress near the 100ms quiet bound.
        const event = events[reads++]
        return { status: "ok", value: event === undefined ? [] : [event] }
      }
    }, runPumps, pumpPokes: new Map(), unref: () => {}, workflowPollMs: 1, services: { workflowQuietMs: 100 }
  } as unknown as ControllerContext
  try {
    await createWorkflowPumpController(ctx, () => 2).pumpWorkflowRun(id)
    expect(reads).toBe(7)
    expect(now).toBe(480)
    expect(card.payload.events).toEqual(events)
    expect(card.payload.phase).toBe("completed")
    expect(card.payload.observationError).toBeUndefined()
    expect(messages).toEqual(["Finalization finished"])
    expect(cursors).toEqual([undefined, ...Array.from({ length: 6 }, (_, offset) => ({
      selector: { _tag: "run-events", runId }, projection: "run-events", runId, value: 1, offset
    }))])
  } finally {
    for (const pump of runPumps.values()) pump.stopped = true
    clock.mockRestore()
  }
})
